"""Signed-in features of QQ音乐 / 网易云音乐 / 酷狗音乐: the heart (我喜欢) with its real state, what the account played lately
and what it likes, for the AM layout's list and its star.

None of the three has a public interface for this. Three community projects speak to their services the way their apps
and pages do, each as a small Node.js server (MIT, see their folders):

  qq       yakult-green-tea/qq-music-api     tools/music-api/qq        port 3303
  netease  NeteaseCloudMusicApiEnhanced      tools/music-api/netease   port 3302
  kugou    MakcRe/KuGouMusicApi              tools/music-api/kugou     port 3301

They are started when first needed (node, with localhost-only.js so that they listen on this computer only) and stopped
with the program. Signing in is by a QR code scanned with the phone. What each service gives back to keep the account
signed in (its cookies) is kept in tools/music-api/accounts.bin, encrypted for this Windows user (DPAPI): no other user
of the computer, and no copy of the file elsewhere, can read it. (The QQ one keeps its credential itself, encrypted with
the key in tools/music-api/.qq-secret; what is kept here is only the handle to it.)

These are unofficial: a service may change and break them, and an account may be limited for using them. Nothing here
runs unless an account is signed in, or a QR code is asked for.
"""
import atexit
import base64
import ctypes
import http.cookiejar
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import qqdata

ROOT = os.environ.get("LRC_MUSIC_API_DIR") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools", "music-api")
ACCOUNTS = os.path.join(ROOT, "accounts.bin")
START_WAIT = 40.0                        # seconds a service may take to start (the QQ one compiles itself on start)
TIMEOUT = 15.0

SERVICES = {
    "qq": {"name": "QQ音乐", "dir": "qq", "port": 3303,
           "cmd": ["node", "-r", "../localhost-only.js", "-r", "ts-node/register/transpile-only", "src/app.ts"]},
    "netease": {"name": "网易云音乐", "dir": "netease", "port": 3302, "cmd": ["node", "-r", "../localhost-only.js", "app.js"]},
    "kugou": {"name": "酷狗音乐", "dir": "kugou", "port": 3301, "cmd": ["node", "-r", "../localhost-only.js", "app.js"]},
}


def service_of(app):
    """Which of the three a followed player (its app id) is: "qq" / "netease" / "kugou", or ""."""
    low = (app or "").lower()
    if "qqmusic" in low:
        return "qq"
    if "cloudmusic" in low or "netease" in low:
        return "netease"
    if "kugou" in low:
        return "kugou"
    return ""


# ---------------------------------------------------------------- the accounts file (DPAPI)
class _Blob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi(data, protect):
    """Encrypt (protect) or decrypt bytes for this Windows user. None when it cannot be done."""
    if sys.platform != "win32":
        return None
    crypt = ctypes.windll.crypt32
    kernel = ctypes.windll.kernel32
    buf = ctypes.create_string_buffer(data, len(data))
    src, out = _Blob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), _Blob()
    fn = crypt.CryptProtectData if protect else crypt.CryptUnprotectData
    if not fn(ctypes.byref(src), None, None, None, None, 0x1, ctypes.byref(out)):     # 0x1: no UI
        return None
    try:
        return ctypes.string_at(out.pbData, out.cbData)
    finally:
        kernel.LocalFree(out.pbData)


_LOCK = threading.RLock()
_JARS = {}                               # service -> CookieJar (what it set: device ids, the account's cookies)


def _cookie_rows(jar):
    return [{"name": c.name, "value": c.value, "path": c.path or "/"} for c in jar]


def _load():
    with _LOCK:
        if _JARS:
            return
        for s in SERVICES:
            _JARS[s] = http.cookiejar.CookieJar()
        try:
            raw = open(ACCOUNTS, "rb").read()
        except OSError:
            return
        plain = _dpapi(raw, False)
        if not plain:
            return
        try:
            saved = json.loads(plain.decode("utf-8"))
        except ValueError:
            return
        for s, rows in (saved or {}).items():
            if s in _JARS:
                for r in rows:
                    _JARS[s].set_cookie(_make_cookie(s, r["name"], r["value"], r.get("path", "/")))


def _save():
    with _LOCK:
        data = json.dumps({s: _cookie_rows(j) for s, j in _JARS.items()}).encode("utf-8")
    enc = _dpapi(data, True)
    if enc is None:
        return                           # (not on Windows: nothing is written in the clear)
    os.makedirs(ROOT, exist_ok=True)
    tmp = ACCOUNTS + ".tmp"
    with open(tmp, "wb") as f:
        f.write(enc)
    os.replace(tmp, ACCOUNTS)


def _make_cookie(svc, name, value, path="/"):
    return http.cookiejar.Cookie(0, name, value, None, False, "127.0.0.1", False, False, path or "/", True, False,
                                 None, False, None, None, {})


# ---------------------------------------------------------------- the services' processes
_PROCS = {}                              # service -> Popen (only those started here)


def installed(svc):
    d = os.path.join(ROOT, SERVICES[svc]["dir"])
    return os.path.isdir(os.path.join(d, "node_modules"))


def _port_open(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.4):
            return True
    except OSError:
        return False


def _qq_secret():
    p = os.path.join(ROOT, ".qq-secret")
    try:
        return open(p, encoding="ascii").read().strip()
    except OSError:
        key = secrets.token_hex(32)
        with open(p, "w", encoding="ascii") as f:
            f.write(key)
        return key


def ensure(svc):
    """Start the service when it is not running. (True, "") or (False, why)."""
    spec = SERVICES[svc]
    if _port_open(spec["port"]):
        return True, ""
    if not installed(svc):
        return False, f"{spec['name']}的接口服务没有安装（tools/music-api/{spec['dir']}）"
    with _LOCK:
        p = _PROCS.get(svc)
        if p is None or p.poll() is not None:
            env = dict(os.environ, PORT=str(spec["port"]), HOST="127.0.0.1")
            if svc == "qq":
                os.makedirs(os.path.join(ROOT, "qq-state"), exist_ok=True)
                env.update(QQ_SESSION_SECRET=_qq_secret(), QQ_AUTH_SESSION_PATH=os.path.join(ROOT, "qq-state", "qq-sessions.json"))
            log = open(os.path.join(ROOT, svc + ".log"), "ab")
            try:
                _PROCS[svc] = subprocess.Popen(spec["cmd"], cwd=os.path.join(ROOT, spec["dir"]), env=env, stdin=subprocess.DEVNULL,
                                               stdout=log, stderr=subprocess.STDOUT,
                                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except OSError as e:
                return False, f"启动不了{spec['name']}的接口服务（要先装 Node.js）：{e}"
    t_end = time.time() + START_WAIT
    while time.time() < t_end:
        if _port_open(spec["port"]):
            return True, ""
        if _PROCS[svc].poll() is not None:
            return False, f"{spec['name']}的接口服务启动后又退出了，见 tools/music-api/{svc}.log"
        time.sleep(0.3)
    return False, f"{spec['name']}的接口服务 {int(START_WAIT)} 秒内没有起来"


def _stop_all():
    for p in list(_PROCS.values()):
        try:
            p.terminate()
        except Exception:
            pass


atexit.register(_stop_all)


# ---------------------------------------------------------------- calling a service
class ApiError(Exception):
    pass


def call(svc, path, params=None, body=None, timeout=TIMEOUT):
    """GET (or POST with a JSON body) to the service, with its cookies; the JSON it answers. Raises ApiError."""
    _load()
    ok, why = ensure(svc)
    if not ok:
        raise ApiError(why)
    q = dict(params or {})
    if svc == "netease":
        q.setdefault("timestamp", int(time.time() * 1000))     # (it caches GETs without one)
    url = f"http://127.0.0.1:{SERVICES[svc]['port']}{path}" + ("?" + urllib.parse.urlencode(q) if q else "")
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET",
                                 headers={"Content-Type": "application/json"} if data is not None else {})
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_JARS[svc]))
    try:
        raw = opener.open(req, timeout=timeout).read()
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            j = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            raise ApiError(f"HTTP {e.code}") from None
        _save()
        return j
    except (urllib.error.URLError, OSError) as e:
        raise ApiError(f"连不上{SERVICES[svc]['name']}的接口服务：{e}") from None
    _save()
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise ApiError("接口服务的回答看不懂") from None


# ---------------------------------------------------------------- signing in
def qr_start(svc, channel=""):
    """A QR code to scan: {key, img (a data: URL)}."""
    if svc == "qq":
        k = call("qq", "/login/qr/key", {"channel": channel or "qq"})
        key = (k.get("data") or {}).get("unikey") or k.get("unikey")
        c = call("qq", "/login/qr/create", {"key": key})
        img = (c.get("data") or {}).get("qrimg") or c.get("qrimg")
    elif svc == "netease":
        k = call("netease", "/login/qr/key")
        key = (k.get("data") or {}).get("unikey")
        c = call("netease", "/login/qr/create", {"key": key, "qrimg": "true"})
        img = (c.get("data") or {}).get("qrimg")
    else:
        k = call("kugou", "/login/qr/key")
        key = (k.get("data") or {}).get("qrcode")
        c = call("kugou", "/login/qr/create", {"key": key, "qrimg": "true"})
        img = (c.get("data") or {}).get("base64")
    if not key or not img:
        raise ApiError("没拿到二维码")
    return {"key": str(key), "img": img}


def qr_check(svc, key):
    """{state: wait | scanned | ok | expired, reason?}. On ok the account is kept (accounts.bin)."""
    if svc == "kugou":
        j = call("kugou", "/login/qr/check", {"key": key})
        st = (j.get("data") or {}).get("status")
        state = {0: "expired", 1: "wait", 2: "scanned", 4: "ok"}.get(st, "wait")
    else:
        j = call(svc, "/login/qr/check", {"key": key})
        code = j.get("code")
        if code in (None, 200) and isinstance(j.get("data"), dict):
            code = j["data"].get("code", code)
        state = {800: "expired", 801: "wait", 802: "scanned", 803: "ok"}.get(code, "wait")
        if svc == "netease" and state == "ok" and j.get("cookie"):
            with _LOCK:                   # (the cookie comes in the answer as well as set on it: both are kept)
                for part in str(j["cookie"]).split(";"):
                    if "=" in part:
                        n, v = part.split("=", 1)
                        n = n.strip()
                        if n and n.upper() not in ("PATH", "EXPIRES", "MAX-AGE", "DOMAIN", "HTTPONLY", "SECURE", "SAMESITE"):
                            _JARS["netease"].set_cookie(_make_cookie("netease", n, v.strip()))
            _save()
        if svc == "qq" and state == "ok" and j.get("cookie"):
            m = re.search(r"qqmusic_session=([^;\s]+)", str(j["cookie"]))
            if m:
                with _LOCK:
                    _JARS["qq"].set_cookie(_make_cookie("qq", "qqmusic_session", m.group(1)))
                _save()
    if state == "ok":
        _USERS.pop(svc, None)
    return {"state": state, "reason": (j.get("message") or j.get("msg") or "") if state == "expired" else ""}


def logout(svc):
    try:
        call(svc, "/logout")
    except ApiError:
        pass
    with _LOCK:
        if svc in _JARS:
            _JARS[svc].clear()
    _USERS.pop(svc, None)
    _LIKED.pop(svc, None)
    for k in [k for k in _LISTS if k[0] == svc]:
        _LISTS.pop(k, None)
    _save()


_USERS = {}                              # service -> (when, {name, id} or None)


def user(svc, fresh=False):
    """The account signed in: {name, id}, or None. (Asked of the service at most once a minute.)"""
    _load()
    if not any(True for _ in _JARS.get(svc, [])):
        return None                       # never signed in here: the service is not even started
    hit = _USERS.get(svc)
    if hit and not fresh and time.time() - hit[0] < 60:
        return hit[1]
    u = None
    try:
        if svc == "qq":
            j = call("qq", "/login/status")
            p = (j.get("data") or {}).get("profile") or {}
            if p:
                u = {"name": p.get("nickname") or p.get("nick") or p.get("name") or "已登录", "id": str(p.get("uin") or p.get("musicid") or "")}
        elif svc == "netease":
            j = call("netease", "/login/status")
            d = j.get("data") or {}
            p, a = d.get("profile") or {}, d.get("account") or {}
            if p or (a and a.get("id")):
                u = {"name": p.get("nickname") or "已登录", "id": str(p.get("userId") or a.get("id") or "")}
        else:
            uid = next((c.value for c in _JARS["kugou"] if c.name == "userid"), "")
            if uid and uid != "0":
                j = call("kugou", "/user/detail")
                d = j.get("data") or {}
                u = {"name": d.get("nickname") or "已登录", "id": uid}
    except ApiError:
        return hit[1] if hit else None    # the service could not be asked: what was known stays
    _USERS[svc] = (time.time(), u)
    return u


def status():
    """For the settings: each service, whether it is there, and who is signed in."""
    out = {}
    for s, spec in SERVICES.items():
        out[s] = {"name": spec["name"], "installed": installed(s), "running": _port_open(spec["port"]), "user": user(s) if installed(s) else None}
    return out


# ---------------------------------------------------------------- songs
def _songs_in(obj, depth=0):
    """Every list of song-like dicts anywhere in an answer, longest first (the services nest them differently)."""
    found = []
    if depth > 6:
        return found
    if isinstance(obj, list):
        if obj and all(isinstance(x, dict) for x in obj[:5]) and any(
                ("name" in x or "songname" in x or "SongName" in x or "songName" in x or "filename" in x) for x in obj[:5]):
            found.append(obj)
        for x in obj[:3]:
            found += _songs_in(x, depth + 1)
    elif isinstance(obj, dict):
        for v in obj.values():
            found += _songs_in(v, depth + 1)
    return sorted(found, key=len, reverse=True)


def _names(v):
    if isinstance(v, list):
        return [x.get("name") or x.get("author_name") for x in v if isinstance(x, dict) and (x.get("name") or x.get("author_name"))]
    if isinstance(v, str):
        return [p.strip() for p in re.split(r"[、/]", v) if p.strip()]
    return []


def norm_song(svc, s):
    """A song of any of the services as {id, mid, hash, name, singers, album, interval (s), cover}."""
    inner = s.get("songInfo") if isinstance(s.get("songInfo"), dict) else s.get("data") if isinstance(s.get("data"), dict) else None
    if inner and not (s.get("name") or s.get("songname") or s.get("filename")):
        s = inner                         # (a song wrapped in a record: a play history line)
    if svc == "qq":
        al = s.get("album") or {}
        mid = s.get("mid") or s.get("songmid")
        return {"id": s.get("id") or s.get("songid"), "mid": mid, "hash": "", "name": s.get("name") or s.get("songname") or s.get("title") or "",
                "singers": _names(s.get("singer") or s.get("singers")), "album": al.get("name") if isinstance(al, dict) else (s.get("albumname") or ""),
                "interval": int(s.get("interval") or 0), "cover": qqdata.cover_url((al.get("mid") if isinstance(al, dict) else "") or s.get("albummid") or ""),
                "albummid": (al.get("mid") if isinstance(al, dict) else "") or s.get("albummid") or ""}
    if svc == "netease":
        al = s.get("al") or s.get("album") or {}
        return {"id": s.get("id"), "mid": "", "hash": "", "name": s.get("name") or "", "singers": _names(s.get("ar") or s.get("artists")),
                "album": al.get("name") or "", "interval": int((s.get("dt") or s.get("duration") or 0) / 1000), "cover": (al.get("picUrl") or "") + ("?param=150y150" if al.get("picUrl") else "")}
    # kugou: its lists say "artist - title" in one name; search results have them apart
    name, singers = s.get("songname") or s.get("SongName") or s.get("songName") or "", _names(s.get("singers") or s.get("SingerName") or s.get("singername") or s.get("author_name"))
    full = s.get("name") or s.get("filename") or s.get("FileName") or ""
    if not name and " - " in full:
        a, name = full.split(" - ", 1)
        singers = singers or _names(a)
    name = name or full
    img = (s.get("cover") or s.get("Image") or s.get("img") or s.get("album_img") or (s.get("trans_param") or {}).get("union_cover") or "").replace("{size}", "150")
    dur = s.get("timelen") or s.get("Duration") or s.get("duration") or 0
    return {"id": s.get("mixsongid") or s.get("MixSongID") or s.get("audio_id") or 0, "mid": "", "hash": (s.get("hash") or s.get("FileHash") or "").upper(),
            "name": name, "singers": singers, "album": s.get("album_name") or s.get("AlbumName") or s.get("remark") or "",
            "interval": int(dur / 1000 if dur and dur > 10000 else dur), "cover": img, "album_id": s.get("album_id") or s.get("AlbumID") or 0,
            "fileid": s.get("fileid") or 0}


def find(svc, title, artist, dur=0):
    """The song on that service, or None (its search, the same matching as qqdata)."""
    if svc == "qq":
        s = qqdata.find_song(title, artist, dur)
        return s and {"id": s.get("songid"), "mid": s.get("songmid"), "hash": "", "name": title, "singers": [], "album": "", "interval": int(dur or 0), "cover": qqdata.cover_url(s.get("albummid") or "")}
    q = f"{title} {artist}".strip()
    try:
        if svc == "netease":
            j = call("netease", "/cloudsearch", {"keywords": q, "limit": 10})
            songs = [norm_song("netease", x) for x in ((j.get("result") or {}).get("songs") or [])]
        else:
            j = call("kugou", "/search", {"keywords": q, "pagesize": 10})
            songs = [norm_song("kugou", x) for x in ((j.get("data") or {}).get("lists") or [])]
    except ApiError:
        return None
    return qqdata.pick_song(songs, title, artist, dur)


_LIKED = {}                              # service -> (when, set of ids / mids / hashes the account likes)


def _kugou_fav_list():
    j = call("kugou", "/user/playlist", {"pagesize": 50})
    lists = ((j.get("data") or {}).get("info")) or []
    for p in lists:
        if p.get("name") == "我喜欢" or str(p.get("listid")) == "2":
            return p
    return lists[0] if lists else None


_LISTS = {}                              # (service, which, limit) -> (when, songs): the lists are asked for every few seconds
LIST_KEEP = 60.0


def _kept(key, fn):
    hit = _LISTS.get(key)
    if hit and time.time() - hit[0] < LIST_KEEP:
        return hit[1]
    v = fn()
    _LISTS[key] = (time.time(), v)
    return v


def liked_songs(svc, limit=200):
    """The songs the account likes (normalised), newest first as the service gives them. (Kept for a minute.)"""
    return _kept((svc, "liked", limit), lambda: _liked_songs(svc, limit))


def _liked_songs(svc, limit):
    if svc == "qq":
        j = call("qq", "/user/liked-songs", {"offset": 0, "limit": min(100, limit)})
    elif svc == "netease":
        u = user("netease")
        ids = (call("netease", "/likelist", {"uid": u["id"]}).get("ids") or [])[:limit] if u else []
        j = call("netease", "/song/detail", {"ids": ",".join(map(str, ids))}) if ids else {}
        return [norm_song("netease", x) for x in (j.get("songs") or [])]
    else:
        fav = _kugou_fav_list()
        if not fav:
            return []
        j = call("kugou", "/playlist/track/all", {"id": fav.get("global_collection_id"), "pagesize": min(300, limit)})
    lists = _songs_in(j)
    return [norm_song(svc, x) for x in (lists[0] if lists else [])]


def recent_songs(svc, limit=50):
    """What the account played lately (newest first). QQ has none to give: its lyric cache is used instead (qqdata)."""
    return _kept((svc, "recent", limit), lambda: _recent_songs(svc, limit))


def _recent_songs(svc, limit):
    if svc == "netease":
        j = call("netease", "/record/recent/song", {"limit": limit})
        return [norm_song("netease", (x.get("data") or x)) for x in ((j.get("data") or {}).get("list") or [])]
    if svc == "kugou":
        j = call("kugou", "/user/history")
        lists = _songs_in(j)
        return [norm_song("kugou", x) for x in (lists[0] if lists else [])][:limit]
    return []


def _liked_set(svc, fresh=False):
    hit = _LIKED.get(svc)
    if hit and not fresh and time.time() - hit[0] < 120:
        return hit[1]
    songs = liked_songs(svc, 1000)
    keys = {str(x.get("id")) for x in songs if x.get("id")} | {x["hash"] for x in songs if x.get("hash")} | {x["mid"] for x in songs if x.get("mid")}
    _LIKED[svc] = (time.time(), keys)
    return keys


def is_liked(svc, song):
    """Whether the account likes the song: True / False, or None when it cannot be told (not signed in, no answer)."""
    if not song or not user(svc):
        return None
    try:
        if svc == "qq" and song.get("mid"):
            j = call("qq", "/user/subscription-status", {"type": "song", "ids": song["mid"]})
            items = (j.get("data") or {}).get("items") or j.get("items") or []
            st = next((i.get("status") for i in items if i.get("id") == song["mid"]), None)
            return True if st == "subscribed" else False if st == "not-subscribed" else None
        keys = _liked_set(svc)
        return (str(song.get("id")) in keys) or (bool(song.get("hash")) and song["hash"] in keys)
    except ApiError:
        return None


def set_liked(svc, song, on):
    """Put the song in the account's 我喜欢, or take it out. (ok, state as read back or None, why)."""
    if not user(svc):
        return False, None, f"先在设置里登录{SERVICES[svc]['name']}"
    try:
        if svc == "qq":
            if not song.get("id") or not song.get("mid"):
                return False, None, "这首歌在 QQ 音乐的曲库里找不到"
            j = call("qq", "/user/song/like", body={"song": {"id": int(song["id"]), "mid": song["mid"], "type": 0}, "liked": bool(on)})
            if j.get("code") == 200:
                v = (j.get("data") or {}).get("liked", j.get("liked"))
                return True, bool(on if v is None else v), ""
            return False, None, j.get("message") or "QQ 音乐没有确认"
        if svc == "netease":
            j = call("netease", "/like", {"id": song["id"], "like": "true" if on else "false"})
            if j.get("code") != 200:
                return False, None, j.get("message") or j.get("msg") or f"网易云回答 {j.get('code')}"
        else:
            fav = _kugou_fav_list()
            if not fav:
                return False, None, "没找到酷狗的「我喜欢」歌单"
            if on:
                data = f"{song.get('name', '')}|{song.get('hash', '')}|{song.get('album_id') or 0}|{song.get('id') or 0}"
                j = call("kugou", "/playlist/tracks/add", {"listid": fav.get("listid"), "data": data})
            else:
                tracks = liked_songs("kugou", 1000)
                fid = next((t.get("fileid") for t in tracks if t.get("hash") and t["hash"] == song.get("hash")), None)
                if not fid:
                    _LIKED.pop("kugou", None)
                    return True, False, ""
                j = call("kugou", "/playlist/tracks/del", {"listid": fav.get("listid"), "fileids": fid})
            if j.get("status") not in (1, None) and j.get("error_code") not in (0, None):
                return False, None, j.get("error_msg") or f"酷狗回答 {j.get('error_code')}"
        _LIKED.pop(svc, None)
        for k in [k for k in _LISTS if k[0] == svc and k[1] == "liked"]:
            _LISTS.pop(k, None)
        now = is_liked(svc, song)                           # read back: what the service says now
        return True, now if now is not None else bool(on), ""
    except ApiError as e:
        return False, None, str(e)


# ---------------------------------------------------------------- playing a QQ Music song in Lumilyric itself
# A song's file is fetched here, from the address QQ Music gives (which runs out after a while and never reaches the page),
# into memory, and handed to the page while it comes in (stream: the page's player asks for byte ranges, as from any web
# server, and gets them as soon as they are here; it starts playing after the first second of the file instead of after
# the whole of it). The last few songs stay in memory (SONG_KEEP, at most SONG_BYTES): the one playing, the next one
# (fetched ahead by the page) and the one before (going back is at once). Nothing is written to disk.
# Quality: what the page asks for (QUALITY_ORDER), the best of it this account may have, down to the 30-second preview.
QUALITY_ORDER = {"standard": ("128", "m4a"), "high": ("320", "128", "m4a"), "lossless": ("flac", "320", "128", "m4a")}
AUDIO_MAX = 200 * 1024 * 1024
SONG_KEEP = 4
SONG_BYTES = 400 * 1024 * 1024
CHUNK = 64 * 1024
_MID = re.compile(r"^[0-9A-Za-z]{8,20}$")


def qq_audio_url(mid, pref="high"):
    """(url, quality, preview) of a QQ Music song, or raises ApiError with the reason it cannot be had."""
    if not _MID.match(str(mid or "")):
        raise ApiError("歌曲编号不对")
    why = ""
    for q in QUALITY_ORDER.get(pref, QUALITY_ORDER["high"]) + ("preview",):
        j = call("qq", f"/getMusicPlay/{mid}", {"preview": "1"} if q == "preview" else {"quality": q})
        pu = (j.get("data") or {}).get("playUrl") or {}
        e = pu.get(mid) or (next(iter(pu.values())) if pu else {}) or {}
        url = str(e.get("url") or "")
        if url.startswith("http"):
            return url, q, q == "preview" or bool(e.get("preview"))
        hint = ((e.get("restriction") or {}).get("hint") or {}).get("message") or e.get("error") or j.get("message") or ""
        why = why or (hint if isinstance(hint, str) else "")
    raise ApiError("QQ 音乐没有给这首歌的播放地址" + ("（" + why + "）" if why else "") + ("" if user("qq") else "；登录 QQ 音乐后能放的歌更多"))


class Song:
    """One song's file coming in: what has arrived (buf), its full length once known (total), whether it is all here
    (done) or broke off (err). read() waits for bytes that are not here yet."""

    def __init__(self, key, quality, preview, ctype):
        self.key, self.quality, self.preview, self.ctype = key, quality, preview, ctype
        self.buf = bytearray()
        self.total = None
        self.done = False
        self.err = ""
        self.cond = threading.Condition()
        self.used = time.time()

    def _fill(self, url):
        req = urllib.request.Request(url, headers={"User-Agent": qqdata.UA, "Referer": "https://y.qq.com/"})
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                n = r.headers.get("Content-Length")
                with self.cond:
                    self.total = int(n) if n and n.isdigit() else None
                    ct = r.headers.get("Content-Type")
                    if ct and ct.startswith("audio") and self.quality != "flac":      # (its FLAC comes as "audio/x-ogg")
                        self.ctype = ct
                    self.cond.notify_all()
                while True:
                    part = r.read(CHUNK)
                    if not part:
                        break
                    with self.cond:
                        self.buf += part
                        if len(self.buf) > AUDIO_MAX:
                            raise OSError("文件太大")
                        self.cond.notify_all()
        except (urllib.error.URLError, OSError, ValueError) as e:
            with self.cond:
                self.err = f"下载这首歌失败：{e}"
        with self.cond:
            if self.total is None or len(self.buf) < self.total:
                self.total = len(self.buf)        # (a length not given, or a file cut short: what came is all there is)
            self.done = True
            self.cond.notify_all()

    def size(self, wait=20.0):
        """The full length, once the source has said it (or the whole file is here)."""
        t_end = time.time() + wait
        with self.cond:
            while self.total is None and not self.done and time.time() < t_end:
                self.cond.wait(0.5)
            return self.total if self.total is not None else len(self.buf)

    def read(self, pos, n, wait=30.0):
        """Up to n bytes from pos, waiting for them to come in; b"" at the end, or when they did not come."""
        t_end = time.time() + wait
        with self.cond:
            self.used = time.time()
            while len(self.buf) <= pos and not self.done and time.time() < t_end:
                self.cond.wait(0.5)
            return bytes(self.buf[pos:pos + n])


_SONGS = {}                              # "mid|pref" -> Song, oldest first


def qq_song(mid, pref="high"):
    """The song's file, coming in or here already (it is started when it is not). Raises ApiError when there is none."""
    pref = pref if pref in QUALITY_ORDER else "high"
    key = f"{mid}|{pref}"
    with _LOCK:
        hit = _SONGS.pop(key, None)
        if hit and not hit.err:
            _SONGS[key] = hit                 # (to the end: the newest)
            hit.used = time.time()
            return hit
    url, q, preview = qq_audio_url(mid, pref)
    song = Song(key, q, preview, "audio/flac" if q == "flac" else "audio/mp4" if q == "m4a" else "audio/mpeg")
    threading.Thread(target=song._fill, args=(url,), daemon=True).start()
    with _LOCK:
        _SONGS[key] = song
        while len(_SONGS) > SONG_KEEP or (len(_SONGS) > 1 and sum(len(x.buf) for x in _SONGS.values()) > SONG_BYTES):
            _SONGS.pop(next(iter(_SONGS)))        # the oldest goes (a page still reading it keeps it until it is done)
    return song


def qq_liked_rows(limit=200):
    """The account's 我喜欢 as the list in the AM layout plays it: [{title, artist, album, dur, cover, mid, id}]."""
    if not user("qq"):
        raise ApiError("先在设置的「音乐账号」里登录 QQ 音乐")
    return [{"title": s["name"], "artist": " / ".join(s["singers"]), "album": s["album"], "dur": s["interval"], "cover": s["cover"],
             "mid": s["mid"], "id": s["id"], "big": qqdata.cover_url(s.get("albummid") or "", 800)}
            for s in liked_songs("qq", limit) if s.get("mid")]


# ---------------------------------------------------------------- the QQ account's play lists, and search, to play here
def _qq_row(name, singers, album, interval, mid, sid, albummid):
    return {"title": name, "artist": " / ".join(singers), "album": album, "dur": int(interval or 0), "cover": qqdata.cover_url(albummid or ""),
            "big": qqdata.cover_url(albummid or "", 800), "mid": mid, "id": sid}


def qq_playlists():
    """The account's play lists, its own first (我喜欢 among them) then those it keeps: [{id, dirid, name, count, cover, own, liked}]."""
    if not user("qq"):
        raise ApiError("先在设置的「音乐账号」里登录 QQ 音乐")
    j = call("qq", "/user/playlist")
    out = []
    for p in j.get("playlist") or []:
        own = "dirName" in p or "dirId" in p
        pid = p.get("tid") or p.get("dissid") or p.get("disstid") or p.get("id")
        if not pid:
            continue
        out.append({"id": str(pid), "dirid": p.get("dirId") or p.get("dirid") or 0, "name": p.get("dirName") or p.get("name") or p.get("title") or "歌单",
                    "count": p.get("songNum") or p.get("songnum") or p.get("song_cnt") or 0,
                    "cover": p.get("picUrl") or p.get("logo") or p.get("albumPicUrl") or "", "own": own, "liked": (p.get("dirId") or 0) == 201})
    return out


def qq_playlist_rows(pid, dirid=0, own=False):
    """The songs of a play list, as rows to play: 我喜欢 (dirid 201), one of the account's own (it may be private), or any
    public one by its number (no sign-in needed for that)."""
    if int(dirid or 0) == 201:
        return qq_liked_rows()
    if own:
        if not user("qq"):
            raise ApiError("先在设置的「音乐账号」里登录 QQ 音乐")
        j = call("qq", "/user/playlist-detail", {"tid": pid, **({"dirid": dirid} if dirid else {})})
        lists = _songs_in(j)
        songs = [norm_song("qq", x) for x in (lists[0] if lists else [])]
        return [_qq_row(s["name"], s["singers"], s["album"], s["interval"], s["mid"], s["id"], s.get("albummid")) for s in songs if s.get("mid")]
    try:
        pl = qqdata.playlist(str(pid))
    except Exception as e:
        raise ApiError(str(e) or "读不到这个歌单") from None
    return [_qq_row(s["name"], s["singers"], s["album"], s["interval"], s["songmid"], s["songid"], s["albummid"]) for s in pl["songs"] if s.get("songmid")]


def _qq_session_search(q, num=10):
    """A search as the signed-in account (QQ Music answers that one far more readily than the anonymous one), in qqdata's
    shape. Raises when there is no account or no answer."""
    if not user("qq"):
        raise ApiError("没有登录 QQ 音乐")
    j = call("qq", "/search", {"keyword": str(q)[:60], "type": "song", "limit": min(20, num)})
    if j.get("code") != 200:
        raise ApiError(j.get("message") or f"QQ 音乐搜索回答 {j.get('code')}")
    out = []
    for x in j.get("items") or []:
        s = norm_song("qq", x)
        if s.get("mid"):
            out.append({"songid": s["id"], "songmid": s["mid"], "name": s["name"], "singers": s["singers"], "album": s["album"],
                        "albummid": s.get("albummid") or "", "interval": s["interval"]})
    return out


qqdata.SEARCH_FALLBACK = _qq_session_search      # (the anonymous search turns some people away for a while: then this)


def qq_playlist_title(pid):
    """A public play list's name ("" when it cannot be had)."""
    try:
        return qqdata.playlist(str(pid)).get("title") or ""
    except Exception:
        return ""


def qq_search_rows(q, num=30):
    """Songs found by a search: as the signed-in account when there is one, else anonymously (as QQ Music's pages do)."""
    q = str(q or "").strip()[:60]
    if not q:
        return []
    songs, err = None, ""
    if user("qq"):
        try:
            songs = _qq_session_search(q, 20)
        except ApiError as e:
            err = str(e)
    if songs is None:
        try:
            songs = qqdata.search(q, num)
        except Exception as e:
            raise ApiError(f"搜索失败：{err or e}") from None
    return [_qq_row(s["name"], s["singers"], s["album"], s["interval"], s["songmid"], s["songid"], s["albummid"]) for s in songs if s.get("songmid")]


def qq_query_is_list(q):
    """A play list's number or link pasted in the search box, or ""."""
    t = str(q or "").strip()
    if re.fullmatch(r"\d{7,}", t) or re.search(r"playlist/\d|[?&#](id|disstid|dissid)=\d", t):
        return qqdata.parse_playlist_id(t)
    return ""
