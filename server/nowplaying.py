"""
"Follow the player": what the desktop music players (QQ Music, NetEase, Kugou ...) are playing right now.

Reads the Windows system media session (SMTC, the same data the volume flyout shows) through PyWinRT,
nothing is injected into or read from the player itself. System events wake a background reader (and it
re-reads every 250 ms anyway); HTTP handlers only look at the state it keeps.

  track_state.py   when the player's numbers can be trusted (song change handling), pure and tested
  lyrics_match.py  finding the right lyrics, scoring is pure and tested
  this file        talking to Windows, the registry of players, snapshots, control, the mock

Installed separately by scripts\\setup_nowplaying.bat. Without it (or off Windows) available() is False
and every function returns an empty result, so server.py always starts.

LRC_NOWPLAYING_MOCK=1 replaces the system with one fake player (a new song every 40 s) for testing the page.
LRC_NOWPLAYING_MOCK_STALE=1 additionally makes it behave like QQ Music: for 2 s after a change it still reports
the previous song's end position, with a fresh timestamp.
"""
import asyncio
import hashlib
import importlib.util
import json
import os
import sys
import threading
import time

import push
import lyrics_match as LM
import disk_cache as DC
import qqweb
import qqcmd
import qqdata
import music_apis
from track_state import PlayerState

# QQ 网页跟随: the embedded QQ web player (desktop only) is fed in as if it were a player, so lyrics, position,
# cover and the draggable progress bar all reuse the normal follow path. Its control goes to injected clicks.
EXT_APP = "qqweb.web"

MOCK = bool(os.environ.get("LRC_NOWPLAYING_MOCK"))
MOCK_STALE = bool(os.environ.get("LRC_NOWPLAYING_MOCK_STALE"))
POLL = 0.25
MOCK_SONG = 40.0                      # seconds per fake song
COVER_WATCH = 20.0                    # seconds after a song change to keep re-reading the thumbnail
COVER_STALE = 3.0                     # an image equal to the previous song's is held back this long
LYRICS_WAIT = 3.0                     # at most this long for a song to settle before its lyrics are searched

# app id (lower-case substring of source_app_user_model_id) -> name shown on the page, and the LDDC source it matches.
KNOWN_APPS = [
    ("cloudmusic", "网易云音乐", "网易云"),
    ("netease", "网易云音乐", "网易云"),
    ("qqmusic", "QQ音乐", "QQ音乐"),
    ("kugou", "酷狗音乐", "酷狗"),
    ("kuwo", "酷我音乐", ""),
    ("spotify", "Spotify", ""),
    ("applemusic", "Apple Music", ""),
]
# Browsers are not followed: a video or a page with sound in a tab is a "media session" too, and would take the
# lyrics away from the music player. (Lower-case substrings of the app id; Firefox registers under a number.)
BROWSERS = ("chrome", "msedge", "microsoftedge", "firefox", "308046b0af4a39cb", "opera", "brave", "vivaldi", "browser",
            "360se", "sogouexplorer", "iexplore", "maxthon", "yandex")

_LOCK = threading.Lock()
_PLAYERS = {}                         # app id -> PlayerState
_META = {}                            # app id -> {app, appName, title, artist, album, playing, tid}
_ORDER = []                           # app ids in the order the system lists them
_CUR = ""                             # app id of the system's "current" session
_OBJS = {}                            # app id -> WinRT session object (for control)
_COVERS = {}                          # trackId -> (bytes, mime)
_COVER_VER = {}                       # trackId -> bumps each time its cover image changes
_CV = {}                              # app id -> cover watch of the current song
_LYR_CACHE = {}
_LYR_LOCKS = {}
_SIG = None                           # signature of the last state, to push only on a change
_LOOP = None
_STARTED = False
_REASON = ""
_mock = {"elapsed": 0.0, "playing": True, "t": time.time(), "n": 0, "change_at": 0.0}
_EXT = None                           # latest raw snapshot of the embedded QQ web player, or None


def feed_external(raw):
    """The desktop QQ-web reader pushes the current song here; the reader loop merges it in like a real player.
    A real change (song, play state, a new position anchor) is also applied and pushed to the page at once, so a
    pause does not wait for the reader loop's next round."""
    global _EXT
    with _LOCK:
        old = _EXT
        _EXT = dict(raw) if raw else None
        changed = bool(raw) and (old is None or any(old.get(k) != raw.get(k) for k in ("tid", "playing", "pos0", "lu", "dur")))
        known = bool(raw) and raw["app"] in _ORDER
    if changed and known:
        _feed(dict(raw), time.time())
        _changed()


def clear_external():
    global _EXT
    with _LOCK:
        _EXT = None


_EXT_QUEUE = {"items": [], "mode": "", "ver": 0}      # the embedded QQ web player's play list, as its page shows it


def set_external_queue(items, mode=""):
    """The desktop reader: the QQ web player's list [{title, artist, album, cover, dur, now, vip}] and its play mode
    (list / single / random / order). Only kept when it changed."""
    with _LOCK:
        if items != _EXT_QUEUE["items"] or mode != _EXT_QUEUE["mode"]:
            _EXT_QUEUE["items"], _EXT_QUEUE["mode"] = list(items), mode
            _EXT_QUEUE["ver"] += 1


_QQ_SNAP = {}                         # app id -> the rows of QQ Music's list as last shown (with song numbers), for a click on row i


def _qq_queue(m, dur, list_id, cache):
    """QQ Music (the program) does not give its play queue to anyone, so the list is made of what can be had: what was
    played lately (the lyric files it keeps), the song playing now, and the songs of a public play list the user named
    (after the song playing now when it is one of them). qqdata.py."""
    root, how, found = qqdata.cache_root(cache)
    nt, na = qqdata.norm(m["title"]), qqdata.artists_of(m["artist"])

    def is_cur(title, artist):
        sa = qqdata.artists_of(artist)
        return qqdata.norm(title) == nt and (not na or not sa or bool(na & sa))
    hist = [h for h in qqdata.history(root, qqdata.HISTORY_MAX) if not is_cur(h["title"], h["artist"])]
    hist.reverse()                                       # oldest first: the newest stands next to the song playing now
    row = lambda title, artist, album, sec, **kw: dict({"title": title, "artist": artist, "album": album, "dur": int(sec or 0), "cover": "", "now": False, "vip": False}, **kw)
    rows = [row(h["title"], h["artist"], h["album"], h["dur"], cover=qqdata.cover_for(h["title"], h["artist"], h["dur"]),      # (a picture comes a moment later, on the next ask)
                _find=(h["title"], h["artist"], h["dur"])) for h in hist]
    cur = row(m["title"], m["artist"], m["album"], round(dur), now=True, _find=(m["title"], m["artist"], dur))
    rows.append(cur)
    qqdata.cover_for(m["title"], m["artist"], dur)       # (its numbers are looked up now, for the heart: a click on the star is then at once)
    pid = qqdata.parse_playlist_id(list_id) if list_id != "liked" else ""
    title, err, count = "", "", 0
    if list_id == "liked":
        pid = "liked"
        if not music_apis.user("qq"):
            err = "先在设置里登录 QQ 音乐，才能显示「我喜欢」"
        else:
            try:
                songs = music_apis.liked_songs("qq", 200)
                title, count = "我喜欢", len(songs)
                for s in songs:
                    rows.append(row(s["name"], " / ".join(s["singers"]), s["album"], s["interval"], cover=s["cover"], _songid=s["id"], _songmid=s["mid"]))
            except music_apis.ApiError as e:
                err = str(e)
    elif pid:
        try:
            pl = qqdata.playlist(pid)
            title, songs = pl["title"], pl["songs"]
            count = len(songs)
            at = next((i for i, s in enumerate(songs) if is_cur(s["name"], " / ".join(s["singers"]))), -1)
            if at >= 0:
                cur["cover"] = qqdata.cover_url(songs[at]["albummid"])
            for s in (songs[at + 1:] if at >= 0 else songs):
                rows.append(row(s["name"], " / ".join(s["singers"]), s["album"], s["interval"], cover=qqdata.cover_url(s["albummid"]),
                                _songid=s["songid"], _songmid=s["songmid"]))
        except Exception as e:
            err = str(e) or "读歌单失败"
    with _LOCK:
        _QQ_SNAP[m["app"]] = rows
    items = [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]
    info = {"root": root, "how": how, "found": found, "history": len(hist), "list": pid, "listTitle": title, "listCount": count, "listErr": err}
    ver = hashlib.sha1(json.dumps([items, info], ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:12]
    return {"ok": True, "app": m["app"], "ver": ver, "mode": "", "items": items, "qq": info}


def _qq_action(m, action, position):
    """A click in QQ Music's list, or its heart: through the player's own command line (qqcmd.py)."""
    if action in ("removeAt", "openAt", "mode"):
        return {"ok": False, "reason": "QQ 音乐桌面版没法这样操作（这里的列表是最近播放和你选的歌单，不是它的播放队列）"}
    if action in ("favorite", "unfavorite"):
        if music_apis.user("qq"):
            return _acct_like(m, "qq", action == "favorite")       # signed in: the account's own heart, read back
        with _LOCK:
            st = _PLAYERS.get(m["app"])
        dur = st.duration(time.time()) if st else 0
        song = qqdata.find_song(m["title"], m["artist"], dur)
        if not song or not song.get("songmid"):
            return {"ok": False, "reason": "在 QQ 音乐的曲库里没找到这首歌，没法收藏"}
        ok, why = qqcmd.favorite(song["songmid"], action == "favorite")
        return {"ok": ok, "reason": why, "liked": None}
    try:
        i = int(position)
    except (TypeError, ValueError):
        return {"ok": False, "reason": "没有给出是哪一首"}
    with _LOCK:
        rows = _QQ_SNAP.get(m["app"]) or []
    if not 0 <= i < len(rows):
        return {"ok": False, "reason": "列表已经变了，再点一次"}
    r = rows[i]
    if r.get("now"):
        return {"ok": True, "reason": ""}
    sid = r.get("_songid")
    if not sid:
        song = qqdata.find_song(*r["_find"])
        sid = song and song.get("songid")
    if not sid:
        return {"ok": False, "reason": "在 QQ 音乐的曲库里没找到这首歌"}
    ok, why = qqcmd.play_song(sid)
    return {"ok": ok, "reason": why}


def _acct_song(m, svc):
    """The song the player is on, as the account's service knows it (or None). Kept per song: it is asked for often."""
    with _LOCK:
        st = _PLAYERS.get(m["app"])
        dur = st.duration(time.time()) if st else 0
        hit = _ACCT_SONG.get((svc, m["tid"]))
    if hit is not None:
        return hit or None
    song = music_apis.find(svc, m["title"], m["artist"], dur)
    with _LOCK:
        if len(_ACCT_SONG) > 200:
            _ACCT_SONG.clear()
        _ACCT_SONG[(svc, m["tid"])] = song or {}
    return song


_ACCT_SONG = {}


def _acct_like(m, svc, on):
    """The star: the song in the account's 我喜欢 (or out of it), and what the service says it is now."""
    if not music_apis.user(svc):
        return {"ok": False, "reason": f"先在设置里登录{music_apis.SERVICES[svc]['name']}", "liked": None}
    song = _acct_song(m, svc)
    if not song:
        return {"ok": False, "reason": f"在{music_apis.SERVICES[svc]['name']}的曲库里没找到这首歌", "liked": None}
    ok, liked, why = music_apis.set_liked(svc, song, on)
    return {"ok": ok, "reason": why, "liked": liked}


def liked_now(app=""):
    """{svc, known, liked, signedIn}: whether the account likes the song the player is on (for the star)."""
    with _LOCK:
        m, _ = _pick(app)
    if not m:
        return {"ok": False, "known": False}
    svc = music_apis.service_of(m["app"]) if m["app"] != EXT_APP else ""
    if not svc or not music_apis.user(svc):
        return {"ok": True, "svc": svc, "known": False, "signedIn": False}
    song = _acct_song(m, svc)
    v = music_apis.is_liked(svc, song) if song else None
    return {"ok": True, "svc": svc, "known": v is not None, "liked": bool(v), "signedIn": True, "trackId": m["tid"]}


def _acct_queue(m, dur, svc):
    """NetEase / KuGou: what the account played lately, the song now, and what it likes. Shown only: those programs
    cannot be told to play a song."""
    name = music_apis.SERVICES[svc]["name"]
    u = music_apis.user(svc)
    nt, na = qqdata.norm(m["title"]), qqdata.artists_of(m["artist"])

    def is_cur(title, singers):
        sa = qqdata.artists_of(" / ".join(singers))
        return qqdata.norm(title) == nt and (not na or not sa or bool(na & sa))
    row = lambda s, **kw: dict({"title": s["name"], "artist": " / ".join(s["singers"]), "album": s["album"], "dur": int(s["interval"] or 0),
                                "cover": s["cover"], "now": False, "vip": False}, **kw)
    rows, err, hist_n, liked_n = [], "", 0, 0
    if u:
        try:
            recent = [s for s in music_apis.recent_songs(svc, 40) if not is_cur(s["name"], s["singers"])]
            hist_n = len(recent)
            rows += [row(s) for s in reversed(recent)]
        except music_apis.ApiError as e:
            err = str(e)
    rows.append({"title": m["title"], "artist": m["artist"], "album": m["album"], "dur": int(dur or 0), "cover": "", "now": True, "vip": False})
    if u:
        try:
            liked = music_apis.liked_songs(svc, 200)
            liked_n = len(liked)
            rows += [row(s) for s in liked if not is_cur(s["name"], s["singers"])]
        except music_apis.ApiError as e:
            err = err or str(e)
    info = {"svc": svc, "name": name, "user": (u or {}).get("name", ""), "signedIn": bool(u), "history": hist_n, "liked": liked_n, "err": err}
    ver = hashlib.sha1(json.dumps([rows, info], ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:12]
    return {"ok": True, "app": m["app"], "ver": ver, "mode": "", "items": rows, "acct": info}


def queue(app="", list_id="", cache=""):
    """The play list of the player followed, for the AM layout's list. The QQ web window has one to give; QQ Music itself
    gets a made one (_qq_queue); the system's media session (every other player) tells what plays, not what comes next."""
    _refresh()                            # (the reader runs once anything has been asked)
    with _LOCK:
        m, _ = _pick(app)
        if not m:
            return {"ok": False, "reason": "没有在跟随播放器"}
        if m["app"] == EXT_APP:
            return {"ok": True, "app": EXT_APP, "ver": _EXT_QUEUE["ver"], "mode": _EXT_QUEUE["mode"],
                    "items": list(_EXT_QUEUE["items"])}
        svc = music_apis.service_of(m["app"])
        if svc in ("netease", "kugou"):
            m = dict(m)
            st = _PLAYERS.get(m["app"])
            dur = st.duration(time.time()) if st else 0
            acct = True
        else:
            acct = False
        if not acct and not (is_qq_desktop(m["app"]) and qqcmd.find_exe()):
            return {"ok": False, "reason": f"{m['appName'] or '这个播放器'}没有把播放列表交给系统，只有「QQ 网页跟随」和 QQ 音乐能显示列表"}
        if not acct:
            m = dict(m)
            st = _PLAYERS.get(m["app"])
            dur = st.duration(time.time()) if st else 0
    if acct:
        return _acct_queue(m, dur, svc)
    return _qq_queue(m, dur, list_id, cache)         # (outside the lock: it reads the disk and may ask the web)


def has_cover(tid):
    with _LOCK:
        return tid in _COVERS


def set_external_cover(tid, data, mime):
    """The embedded QQ web player's picture of song `tid` (read off its page, fetched at 800 px by the desktop app):
    served as the player's own cover, like a system thumbnail."""
    with _LOCK:
        if len(_COVERS) > 20 and tid not in _COVERS:
            _COVERS.pop(next(iter(_COVERS)))
        _COVERS[tid] = (data, mime)
        _COVER_VER[tid] = _COVER_VER.get(tid, 0) + 1
    push.notify("np")                     # a picture that came after the song: the page sees the new coverVer


def available():
    if MOCK:
        return True
    if sys.platform != "win32":
        return False
    try:
        return importlib.util.find_spec("winrt.windows.media.control") is not None
    except Exception:
        return False


def app_info(app):
    if (app or "") == EXT_APP:
        return "QQ音乐", "QQ音乐"                   # shown as QQ Music; lyrics searched on QQ, same as the desktop QQ Music
    low = (app or "").lower()
    for key, name, src in KNOWN_APPS:
        if key in low:
            return name, src
    return (app or ""), ""


def is_qq_desktop(app):
    """The QQ Music program itself (not the embedded web player): moved through its command line, see qqcmd.py."""
    return (app or "") != EXT_APP and "qqmusic" in (app or "").lower()


def is_browser(app):
    low = (app or "").lower()
    return any(b in low for b in BROWSERS)


def is_music_app(app):
    if (app or "") == EXT_APP:
        return True
    low = (app or "").lower()
    return any(key in low for key, _, _ in KNOWN_APPS)


def track_id(app, title, artist, album):
    return hashlib.sha1(f"{app}|{title}|{artist}|{album}".encode("utf-8", "replace")).hexdigest()[:12]


def _feed(raw, now):
    """Hand one raw read to its player's state; push when something the page shows changed."""
    app = raw["app"]
    with _LOCK:
        st = _PLAYERS.get(app)
        if st is None:
            st = _PLAYERS[app] = PlayerState()
        st.update(raw, now)
        _META[app] = {k: raw[k] for k in ("app", "appName", "title", "artist", "album", "playing")}
        _META[app]["tid"] = raw["tid"]


def _signature():
    """Changes only when the page needs to hear about it (a position that merely moves on does not count)."""
    out = []
    with _LOCK:
        for app in _ORDER:
            st, r = _PLAYERS.get(app), _PLAYERS.get(app) and _PLAYERS[app].raw
            if not r:
                continue
            drift = 0
            if r["timeline"]:                 # pos - last_updated stays constant while a song plays normally
                drift = round((r["pos0"] - r["lu"]) * 2) if r["playing"] and r["lu"] else round(r["pos0"] * 2)
            out.append((app, r["tid"], r["playing"], st.settled, round(st.duration(time.time())), r["timeline"], drift))
        out.append(_CUR)
    return tuple(out)


def _changed():
    global _SIG
    sig = _signature()
    if sig != _SIG:
        _SIG = sig
        push.notify("np")


# ---------------------------------------------------------------- mock
def _mock_tick():
    t = time.time()
    if _mock["playing"]:
        _mock["elapsed"] += t - _mock["t"]
    _mock["t"] = t


def _mock_update():
    """One fake player, read like a real one."""
    global _CUR
    _mock_tick()
    now = time.time()
    n, pos = divmod(_mock["elapsed"], MOCK_SONG)
    n = int(n)
    if n != _mock["n"]:
        _mock["n"], _mock["change_at"] = n, now
    title, artist, album, app = f"测试歌曲 {n + 1}", "模拟歌手", "模拟专辑", "mock-player.exe"
    lu = now
    if MOCK_STALE and n > 0 and now - _mock["change_at"] < 2.0:
        pos = MOCK_SONG - 1.0                  # the previous song's end, stamped as fresh
    raw = {"app": app, "appName": "模拟播放器", "title": title, "artist": artist, "album": album,
           "dur": MOCK_SONG, "pos0": pos, "lu": lu, "read_at": now, "playing": _mock["playing"],
           "tid": track_id(app, title, artist, album), "timeline": True, "canSeek": True}
    _feed(raw, now)
    with _LOCK:
        _ORDER[:] = [app]
        _CUR = app


# ---------------------------------------------------------------- WinRT reader
def _valid_time(dt):
    try:
        return dt.year > 2000
    except Exception:
        return False


async def _read_cover(props):
    from winrt.windows.storage.streams import DataReader
    ref = props.thumbnail
    if ref is None:
        return None
    stream = await ref.open_read_async()
    size = int(stream.size)
    if size <= 0 or size > 8 * 1024 * 1024:
        return None
    reader = DataReader(stream)
    await reader.load_async(size)
    buf = bytearray(size)
    reader.read_bytes(buf)
    return bytes(buf), (stream.content_type or "image/jpeg")


async def _watch_cover(app, tid, props, now):
    """Players change the title first and the thumbnail later: keep reading for a while after a change, and do
    not believe an image identical to the previous song's until COVER_STALE has passed."""
    cv = _CV.get(app)
    if not cv or cv["tid"] != tid:
        cv = _CV[app] = {"tid": tid, "since": now, "prev": cv["hash"] if cv else None, "hash": None, "last": 0.0}
    if now - cv["since"] >= COVER_WATCH or now - cv["last"] < 0.4:
        return
    cv["last"] = now
    try:
        c = await asyncio.wait_for(_read_cover(props), 3)
    except Exception:
        c = None
    if not c:
        return
    h = hashlib.sha1(c[0]).hexdigest()
    if h == cv["hash"] or (h == cv["prev"] and now - cv["since"] < COVER_STALE):
        return
    cv["hash"] = h
    with _LOCK:
        if len(_COVERS) > 20:
            _COVERS.pop(next(iter(_COVERS)))
        _COVERS[tid] = c
        _COVER_VER[tid] = _COVER_VER.get(tid, 0) + 1


async def _read_session(s):
    app = s.source_app_user_model_id or ""
    props = await asyncio.wait_for(s.try_get_media_properties_async(), 3)
    tl = s.get_timeline_properties()
    title, artist, album = props.title or "", props.artist or "", props.album_title or ""
    dur = max(0.0, (tl.end_time - tl.start_time).total_seconds())
    lu = tl.last_updated_time
    lu_ts = lu.timestamp() if _valid_time(lu) else None
    now = time.time()
    tid = track_id(app, title, artist, album)
    await _watch_cover(app, tid, props, now)
    pb = s.get_playback_info()
    try:
        can_seek = bool(pb.controls.is_playback_position_enabled)      # the player accepts "jump to a position"
    except Exception:
        can_seek = False
    if not can_seek and is_qq_desktop(app) and qqcmd.find_exe():
        can_seek = True                                    # it does not say so, but its command line does (qqcmd.py)
    return {"app": app, "appName": app_info(app)[0], "title": title, "artist": artist, "album": album,
            "dur": dur, "pos0": tl.position.total_seconds(), "lu": lu_ts, "read_at": now,
            "playing": int(pb.playback_status) == 4,       # 4 PLAYING, 5 PAUSED
            "tid": tid, "timeline": dur > 0 or lu_ts is not None, "canSeek": can_seek}


def _subscribe(mgr, wake, loop, subs):
    """Wake the reader the moment the system reports a change, instead of waiting for the next tick. Handlers run
    on a WinRT thread, so they only set an event. Failures are harmless: the 250 ms read still works.

    Called every cycle, so it must be idempotent: the objects get_sessions() returns are new Python wrappers every
    time (identity says nothing), a session is identified by its app id and subscribed once, and again only after
    it has been gone. A failed subscription is not retried either: retrying every cycle piled up handlers
    until the process ran out of memory."""
    def ping(*_):
        loop.call_soon_threadsafe(wake.set)
    if "mgr" not in subs:
        subs["mgr"] = True
        try:
            mgr.add_sessions_changed(ping)
            mgr.add_current_session_changed(ping)
        except Exception as e:
            print("nowplaying: session list events unavailable, reading only:", e)
    try:
        sessions = list(mgr.get_sessions())
    except Exception:
        return
    present = set()
    for s in sessions:
        key = s.source_app_user_model_id
        present.add(key)
        if key in subs:
            continue
        subs[key] = s                     # also keeps the session (and so its handlers) alive
        try:
            s.add_playback_info_changed(ping)
            s.add_media_properties_changed(ping)
            s.add_timeline_properties_changed(ping)
        except Exception as e:
            print(f"nowplaying: events of {key} unavailable, reading only:", e)
    for key in [k for k in subs if k != "mgr" and k not in present]:
        del subs[key]                     # gone: subscribe again when it comes back


async def _poll():
    global _CUR, _REASON
    from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager as Mgr
    mgr = None
    wake = asyncio.Event()
    loop = asyncio.get_running_loop()
    subs = {}
    while True:
        try:
            if mgr is None:
                mgr = await Mgr.request_async()
                subs.clear()
            _subscribe(mgr, wake, loop, subs)
            wake.clear()
            order, objs = [], {}
            cur = mgr.get_current_session()
            for s in mgr.get_sessions():
                try:
                    raw = await _read_session(s)
                except Exception as e:                    # one broken session must not hide the others
                    _REASON = f"{type(e).__name__}: {e}"[:200]
                    continue
                _feed(raw, raw["read_at"])
                order.append(raw["app"])
                objs[raw["app"]] = s
            with _LOCK:
                ext = dict(_EXT) if _EXT else None
            if ext:                                       # the embedded QQ web player, kept alive each cycle
                _feed(ext, time.time())
                order.append(ext["app"])
                objs[ext["app"]] = "EXTERNAL"
            with _LOCK:
                _ORDER[:] = order
                _CUR = (cur.source_app_user_model_id or "") if cur else ""
                _OBJS.clear()
                _OBJS.update(objs)
            _changed()
        except Exception as e:
            mgr = None
            _REASON = f"{type(e).__name__}: {e}"[:200]
            print("nowplaying:", _REASON)
            await asyncio.sleep(2)
        try:                                              # next read: on the first event, or after POLL at the latest
            await asyncio.wait_for(wake.wait(), POLL)
        except asyncio.TimeoutError:
            pass
        await asyncio.sleep(0.01)                         # let a burst of events settle into one read


def _thread():
    global _LOOP
    _LOOP = asyncio.new_event_loop()
    asyncio.set_event_loop(_LOOP)
    try:
        _LOOP.run_until_complete(_poll())
    except Exception as e:
        print("nowplaying stopped:", e)


def start():
    """Start the background reader once (does nothing when unavailable or in mock mode)."""
    global _STARTED
    if _STARTED or MOCK or not available():
        return
    _STARTED = True
    # (the real Qt had to be loaded before WinRT or the process crashed; LDDC now runs on qt_stub, no Qt at all)
    threading.Thread(target=_thread, name="nowplaying", daemon=True).start()


# ---------------------------------------------------------------- snapshot
def _refresh():
    if MOCK:
        _mock_update()
        _changed()
    else:
        start()


def _pick(app):
    """Which player to show: the one asked for, else the one that is playing, else the system's current one.
    Browsers are left out altogether (BROWSERS), and a music player (KNOWN_APPS) comes before any other program,
    even a paused one before a video player that is playing; another program is followed when no music player is
    open, or when it is asked for by name (the page's 跟随哪个播放器)."""
    metas = [_META[a] for a in _ORDER if a in _META and not is_browser(a)]
    if app:
        for m in metas:
            if m["app"] == app:
                return m, metas
    if not metas:
        return None, metas
    order = {m["app"]: i for i, m in enumerate(metas)}
    # the embedded QQ web player, when open, is what the user turned on to follow: prefer it over other players
    best = min(metas, key=lambda m: (m["app"] != EXT_APP, not is_music_app(m["app"]), not m["playing"],
                                     m["app"] != _CUR, order[m["app"]]))
    return best, metas


def snapshot(app=""):
    if not available():
        return {"ok": False, "reason": "还没有安装播放器同步组件，先运行 scripts\\setup_nowplaying.bat"}
    _refresh()
    now = time.time()
    with _LOCK:
        m, metas = _pick(app)
        if not m:
            return {"ok": False, "reason": _REASON or "没有检测到正在播放的音乐播放器（先在播放器里放一首歌；浏览器里播放的不跟随）"}
        st = _PLAYERS[m["app"]]
        return {"ok": True, "app": m["app"], "appName": m["appName"], "title": m["title"], "artist": m["artist"],
                "album": m["album"], "duration": round(st.duration(now), 2), "position": round(st.position(now), 3),
                "playing": m["playing"], "at": int(now * 1000), "trackId": m["tid"], "settled": st.settled,
                "timeline": st.raw["timeline"], "canSeek": bool(st.raw.get("canSeek")),
                "coverVer": _COVER_VER.get(m["tid"], 0),
                "sessions": [{"app": x["app"], "appName": x["appName"], "title": x["title"], "playing": x["playing"]}
                             for x in metas]}


def _meta_of(tid):
    with _LOCK:
        for m in _META.values():
            if m.get("tid") == tid:
                return dict(m)
    return None


def cover(tid):
    """The picture for a song: the sharp one chosen earlier (disk cache) if there is one, else the player's own."""
    if MOCK:
        return None
    m = _meta_of(tid)
    if m:
        hit = DC.get_cover(DC.song_key(m["title"], m["artist"], m["album"]))
        if hit:
            return hit[0], hit[1]
    with _LOCK:
        return _COVERS.get(tid)


def save_cover(tid, data, mime, side):
    """The page found a sharper cover for this song and uses it: keep it for next time."""
    m = _meta_of(tid)
    if not m:
        return False
    return DC.put_cover(DC.song_key(m["title"], m["artist"], m["album"]), data, mime, side, f"{m['title']} - {m['artist']}")


def calibrate(app, tid, position):
    """Set the self-timed clock of a player that gives no position (the page's progress bar was dragged)."""
    with _LOCK:
        st = _PLAYERS.get(app)
        ok = bool(st and st.calibrate(tid, position, time.time()))
    if not ok:
        return {"ok": False, "reason": "已经切歌了"}
    push.notify("np")
    return {"ok": True}


# ---------------------------------------------------------------- lyrics
def _mock_lrc(title):
    def tag(sec, br):
        return f"{br[0]}{int(sec) // 60:02d}:{sec % 60:05.2f}{br[1]}"
    words = ["这是", "一首", "用来", "测试", "的", "歌"]
    lines = [f"[ti:{title}]", "[ar:模拟歌手]"]
    for i in range(6):
        t = 2 + i * 6
        lines.append(tag(t, "[]") + "".join(tag(t + k * 0.5, "<>") + w for k, w in enumerate(words)))
    return "\n".join(lines) + "\n"


def pick_lyrics(tid):
    """Lyrics for the song `tid` that a player is on: {lrc, source, title, verbatim, score, album} or {lrc: None, reason}."""
    def current():
        with _LOCK:
            for app, st in _PLAYERS.items():
                if st.track and st.track.tid == tid and st.raw:
                    m = _META.get(app, {})
                    return app, st, m
        return None, None, None

    if MOCK:
        _mock_update()
    app, st, m = current()
    if st is None:
        return {"lrc": None, "reason": "找不到这首歌的信息（已经切歌了？）"}
    if MOCK:
        return {"lrc": _mock_lrc(m["title"]), "source": "模拟", "title": m["title"], "verbatim": True, "score": 100,
                "album": m["album"]}
    key = DC.song_key(m["title"], m["artist"], m["album"])
    with _LOCK:
        if tid in _LYR_CACHE:
            return _LYR_CACHE[tid]
    saved = DC.get_lyrics(key)
    if saved:                                              # found on an earlier day: no search, no waiting
        with _LOCK:
            _LYR_CACHE[tid] = saved
        return saved
    with _LOCK:
        lock = _LYR_LOCKS.setdefault(tid, threading.Lock())
    with lock:
        # the length is only believed once the song has settled (see track_state.py); do not wait for ever
        t0 = time.time()
        while time.time() - t0 < LYRICS_WAIT:
            app, st, m = current()
            if st is None:
                return {"lrc": None, "reason": "已经切歌了"}
            if st.settled:
                break
            time.sleep(0.1)
        app, st, m = current()
        if st is None:
            return {"lrc": None, "reason": "已经切歌了"}
        with _LOCK:
            duration = st.duration(time.time())
        title, artist = m["title"], m["artist"]
        if not title.strip() or (duration and duration < 30):
            return {"lrc": None, "reason": "这不像一首歌（没有标题或太短），不找歌词"}
        res = LM.find(title, artist, duration, app_info(app)[1])
        if res.get("lrc"):                                # only a hit is remembered: a flaky source must not stick
            with _LOCK:
                _LYR_CACHE[tid] = res
            DC.put_lyrics(key, res)
        return res


# ---------------------------------------------------------------- control (optional)
async def _control(s_obj, action, position):
    if action == "play":
        return await s_obj.try_play_async()
    if action == "pause":
        return await s_obj.try_pause_async()
    if action == "next":
        return await s_obj.try_skip_next_async()
    if action == "prev":
        return await s_obj.try_skip_previous_async()
    if action == "seek":
        return await s_obj.try_change_playback_position_async(int(float(position) * 10_000_000))
    raise ValueError("unknown action")


def _keep_paused(app):
    """`/seekto` starts a paused player: a seek asked while paused puts it back to pause once it has started."""
    for _ in range(14):
        time.sleep(0.15)
        with _LOCK:
            st, obj = _PLAYERS.get(app), _OBJS.get(app)
            on = bool(st and st.raw and st.raw.get("playing"))
        if on and obj is not None and _LOOP is not None:
            try:
                asyncio.run_coroutine_threadsafe(_control(obj, "pause", None), _LOOP).result(3)
            except Exception:
                pass
            return


def _qq_command(app, action, position):
    """seek / volume of the QQ Music program, through its command line."""
    try:
        v = float(position)
    except (TypeError, ValueError):
        return {"ok": False, "reason": "没有给出数值"}
    if action == "volume":
        ok, why = qqcmd.volume(v)
        return {"ok": ok, "reason": why}
    with _LOCK:
        st = _PLAYERS.get(app)
        was_playing = bool(st and st.raw and st.raw.get("playing"))
    ok, why = qqcmd.seek(v)
    if ok and not was_playing:
        threading.Thread(target=_keep_paused, args=(app,), daemon=True).start()
    return {"ok": ok, "reason": why}


def control(action, position=None, app=""):
    if action not in ("play", "pause", "next", "prev", "seek", "volume", "playAt", "removeAt", "openAt", "mode", "favorite", "unfavorite"):
        return {"ok": False, "reason": "不认识的操作"}
    if MOCK:
        if action == "volume":
            return {"ok": False, "reason": "模拟播放器没有音量"}
        _mock_tick()
        n = int(_mock["elapsed"] // MOCK_SONG)
        if action == "play":
            _mock["playing"] = True
        elif action == "pause":
            _mock["playing"] = False
        elif action == "next":
            _mock["elapsed"] = (n + 1) * MOCK_SONG
        elif action == "prev":
            _mock["elapsed"] = max(0, n - 1) * MOCK_SONG
        else:
            _mock["elapsed"] = n * MOCK_SONG + max(0.0, min(MOCK_SONG, float(position or 0)))
        _mock_update()
        _changed()
        return {"ok": True}
    if not available() or _LOOP is None:
        return {"ok": False, "reason": "播放器同步没有启动"}
    with _LOCK:
        m, _ = _pick(app)
        obj = _OBJS.get(m["app"]) if m else None
        dur = _PLAYERS[m["app"]].raw.get("dur") if m and m["app"] in _PLAYERS else 0
    if obj is None:
        return {"ok": False, "reason": "没有可控制的播放器"}
    if obj == "EXTERNAL":                                  # the embedded QQ web player: inject clicks, not WinRT
        if action in ("playAt", "removeAt", "openAt"):        # a song of its list (position: which one)
            return qqweb.row(action[:-2], position)
        if action == "mode":                                   # its play mode (position: list / single / random / order)
            return qqweb.mode(position)
        if action == "seek":
            if not dur:
                return {"ok": False, "reason": "时长未知"}
            return qqweb.seek(float(position) / float(dur))
        return qqweb.control(action)
    if is_qq_desktop(m["app"]) and action in ("seek", "volume"):
        return _qq_command(m["app"], action, position)
    if is_qq_desktop(m["app"]) and action in ("playAt", "removeAt", "openAt", "mode", "favorite", "unfavorite"):
        return _qq_action(m, action, position)
    svc = music_apis.service_of(m["app"])
    if svc in ("netease", "kugou") and action in ("favorite", "unfavorite"):
        return _acct_like(m, svc, action == "favorite")
    if svc in ("netease", "kugou") and action in ("playAt", "removeAt", "openAt", "mode"):
        return {"ok": False, "reason": f"{music_apis.SERVICES[svc]['name']}桌面版没法从这里点歌（它没有给外部用的接口）"}
    if action == "volume":                                  # only QQ Music can be asked for one
        return {"ok": False, "reason": "这个播放器不支持调音量"}
    try:
        ok = asyncio.run_coroutine_threadsafe(_control(obj, action, position), _LOOP).result(4)
    except Exception as e:
        return {"ok": False, "reason": f"{type(e).__name__}: {e}"[:200]}
    return {"ok": bool(ok), "reason": "" if ok else "这个播放器不支持这个操作"}
