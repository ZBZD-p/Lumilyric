"""QQ音乐 (desktop): the lists behind the AM layout's play list, and finding a song for a click.

The system's media session says only what is playing now; QQ Music's own queue lives in its memory and cannot be read
from outside (see the qqseek project's docs). What can be had:

  history    the lyric files QQ Music keeps (QQMusicLyricNew\\*.qrc: "artist - title - seconds - album", in the clear),
             newest first: what has been played lately. Where the cache is, QQ Music says in its own settings
             (WebkitCachePath.ini); the page can name another place (cache_root).
  playlist   a public play list by its number, from the same web service the player's own pages use (no login).
  search     the same service, to find the song of a history line (title, artist, length) and the number QQ Music's
             command line (qqcmd.py) wants to play it, or its "mid" for the heart.

Nothing here writes to QQ Music or its files, and nothing is sent but the song names searched for. Pure functions
(pick_song, norm, parse_playlist_id, parse_cache_name) are tested in tests/test_qqdata.py.
"""
import json
import os
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
REFERER = "https://y.qq.com/"
SEARCH_CGI = "https://c.y.qq.com/soso/fcgi-bin/client_search_cp"
DISS_CGI = "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg"
TIMEOUT = 8.0
LIST_KEEP = 600.0                       # seconds a play list that was fetched is kept (it is asked for every second or two)
HISTORY_MAX = 40

LYRIC_DIR = "QQMusicLyricNew"
_SUFFIXES = ("_qmRoma", "_qmts", "_qm")
_CACHE_NAME = re.compile(r"^(?P<artist>.+?) - (?P<title>.+?) - (?P<dur>\d+) - (?P<album>.*)$")
_MIXED = re.compile(r"(?<![a-z])(?:live|remix|inst|instrumental|karaoke|cover|acoustic|demo)(?![a-z])|伴奏|现场|翻唱|纯音乐", re.I)   # a version that is not the studio song


# ---------------------------------------------------------------- names
def norm(s):
    """A name as people compare it: no case, spacing, punctuation, nor what is in brackets ("(Explicit)", "- Single")."""
    s = unicodedata.normalize("NFKC", str(s or "")).lower()
    s = re.sub(r"[\(\[【《<].*?[\)\]】》>]", " ", s)
    s = re.sub(r"\s+-\s+.*$", "", s)
    return re.sub(r"[^\w]+", "", s, flags=re.UNICODE).replace("_", "")


def artists_of(s):
    """The set of artist names in "A/B", "A & B", "A、B", "A feat. B" (each normalised). QQ Music's lyric files write the
    "/" between artists as "_" (a "/" cannot be in a file name), so that splits too."""
    parts = re.split(r"[/、,，&;；_]|\s+x\s+|\s+feat\.?\s+|\s+ft\.?\s+", unicodedata.normalize("NFKC", str(s or "")), flags=re.I)
    return {n for n in (norm(p) for p in parts) if n}


def pick_song(songs, title, artist, dur=0):
    """The one of `songs` (dicts: name, singers [names], interval s) that is the song title / artist / dur asks for, or None.
    The title must agree; the artist and the length decide among versions; a live / remix is not taken for the studio one."""
    wt, wa = norm(title), artists_of(artist)
    if not wt:
        return None
    best, best_sc = None, 0
    for s in songs:
        nt = norm(s.get("name"))
        if not nt:
            continue
        sc = 60 if nt == wt else 36 if (wt in nt or nt in wt) and min(len(wt), len(nt)) >= 3 else 0
        if not sc:
            continue
        sa = artists_of(" / ".join(s.get("singers") or []))
        if wa and sa:
            sc += 25 if wa & sa else -30
        elif not wa:
            sc += 8
        d = abs((s.get("interval") or 0) - dur) if dur and s.get("interval") else None
        if d is not None:
            sc += 15 if d <= 2 else 8 if d <= 5 else -25 if d > 15 else 0
        if _MIXED.search(str(s.get("name") or "")) and not _MIXED.search(str(title or "")):
            sc -= 20
        if sc > best_sc:
            best, best_sc = s, sc
    return best if best_sc >= 70 else None


def parse_playlist_id(text):
    """A play list's number from what was pasted: the number itself, or a link (…/playlist/8058033089, …?id=…, disstid=…)."""
    t = str(text or "").strip()
    if re.fullmatch(r"\d{4,}", t):
        return t
    m = re.search(r"(?:playlist/|[?&#](?:id|disstid|dissid)=)(\d{4,})", t)
    return m.group(1) if m else ""


def parse_cache_name(name):
    """{artist, title, dur (s), album} from a lyric file's name ("A - T - 195 - Album_qm.qrc"), or None."""
    if not name.lower().endswith(".qrc"):
        return None
    stem = name[:-4]
    for suf in _SUFFIXES:
        if stem.endswith(suf):
            stem = stem[: -len(suf)]
            break
    m = _CACHE_NAME.match(stem)
    if not m:
        return None
    return {"artist": m.group("artist").strip(), "title": m.group("title").strip(), "dur": int(m.group("dur")), "album": m.group("album").strip()}


# ---------------------------------------------------------------- where QQ Music keeps its cache, and what is in it
def data_dir():
    return os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "Tencent", "QQMusic")


def _read_ini_path():
    """The cache folder QQ Music was told to use: WebkitCachePath.ini (Path=E:\\QQMusicCache\\WebkitCache) names a folder
    inside it. None when there is no such file."""
    p = os.path.join(data_dir(), "WebkitCachePath.ini")
    try:
        raw = open(p, "rb").read()
    except OSError:
        return None
    for enc in ("utf-8-sig", "utf-16", "gbk"):
        try:
            text = raw.decode(enc)
        except UnicodeDecodeError:
            continue
        m = re.search(r"^\s*Path\s*=\s*(.+?)\s*$", text, re.M)
        if m:
            return os.path.dirname(m.group(1).strip().rstrip("\\/"))
    return None


def cache_root(override=""):
    """(folder holding QQMusicLyricNew, how it was found, whether it has the lyric files): the one the page names, else the
    one QQ Music's settings name, else QQ Music's default. The ini is read every time, so moving the cache in QQ Music
    is followed."""
    cands = []
    ov = str(override or "").strip().strip('"')
    if ov:
        cands.append((ov, "手动指定"))
    ini = _read_ini_path()
    if ini:
        cands.append((ini, "QQ音乐设置"))
    cands.append((os.path.join(data_dir(), "QQMusicCache"), "默认位置"))
    for path, how in cands:
        if os.path.basename(path.rstrip("\\/")).lower() == LYRIC_DIR.lower():
            path = os.path.dirname(path.rstrip("\\/"))              # the lyric folder itself was named
        if os.path.isdir(os.path.join(path, LYRIC_DIR)):
            return path, how, True
        if how == "手动指定":
            return path, how, False                                # said by the user: no quiet fallback to another place
    path, how = cands[1] if ini else cands[-1]
    return path, how, False


_HIST = {"key": None, "rows": []}


def history(root, limit=HISTORY_MAX):
    """The songs QQ Music has kept lyrics for, newest first: [{artist, title, dur, album, mtime}], at most `limit`."""
    d = os.path.join(root, LYRIC_DIR)
    try:
        st = os.stat(d)
    except OSError:
        return []
    key = (d, st.st_mtime_ns)
    if _HIST["key"] != key:
        seen = {}
        try:
            with os.scandir(d) as it:
                for e in it:
                    r = parse_cache_name(e.name)
                    if not r:
                        continue
                    try:
                        mt = e.stat().st_mtime
                    except OSError:
                        continue
                    k = (r["artist"], r["title"], r["dur"])
                    if k not in seen or mt > seen[k]["mtime"]:
                        seen[k] = {**r, "mtime": mt}
        except OSError:
            return []
        _HIST["key"], _HIST["rows"] = key, sorted(seen.values(), key=lambda x: -x["mtime"])
    return _HIST["rows"][:limit]


# ---------------------------------------------------------------- the web service
def _get(url, params, timeout=TIMEOUT):
    req = urllib.request.Request(url + "?" + urllib.parse.urlencode(params), headers={"User-Agent": UA, "Referer": REFERER})
    raw = urllib.request.urlopen(req, timeout=timeout).read().decode("utf-8", "replace").strip()
    if not raw.startswith("{"):
        i, j = raw.find("{"), raw.rfind("}")
        raw = raw[i:j + 1] if 0 <= i < j else ""
    return json.loads(raw)


def _song(s):
    singers = s.get("singer") or []
    return {
        "songid": s.get("songid") or s.get("id"),
        "songmid": s.get("songmid") or s.get("mid"),
        "name": s.get("songname") or s.get("name") or "",
        "singers": [x.get("name") for x in singers if isinstance(x, dict) and x.get("name")],
        "album": s.get("albumname") or "",
        "albummid": s.get("albummid") or "",
        "interval": s.get("interval") or 0,
    }


COVER_SIDE = 150                         # px: a row of the list shows it at 36 (72 on a sharp screen); the service has 150, 300, 500, 800
                                         # (10, 31, 72, 154 KB for one picture)


def cover_url(albummid, side=COVER_SIDE):
    return f"https://y.gtimg.cn/music/photo_new/T002R{side}x{side}M000{albummid}.jpg" if albummid else ""


SEARCH_FALLBACK = None                   # set by music_apis: a search as the signed-in account, for when this one is refused


def search(keyword, num=10):
    """Songs by a search, anonymously (the web service QQ Music's pages use). It turns a caller away now and then (an
    HTTP 500 for a while, after many searches): then the signed-in account's search is used, when there is one."""
    try:
        j = _get(SEARCH_CGI, {"p": 1, "n": num, "w": keyword, "format": "json"})
        return [_song(s) for s in (((j.get("data") or {}).get("song") or {}).get("list")) or []]
    except Exception:
        if SEARCH_FALLBACK is None:
            raise
        return SEARCH_FALLBACK(keyword, num)


_LISTS = {}                              # number -> (when fetched, {title, songs})
_LOCK = threading.Lock()


def playlist(disstid):
    """{title, songs: [song]} of a public play list; raises when it cannot be had (no such list, a private one, no network)."""
    with _LOCK:
        hit = _LISTS.get(disstid)
    if hit and time.time() - hit[0] < LIST_KEEP:
        return hit[1]
    j = _get(DISS_CGI, {"type": 1, "json": 1, "utf8": 1, "onlysong": 0, "disstid": disstid, "format": "json", "g_tk": 5381,
                        "loginUin": 0, "hostUin": 0, "inCharset": "utf8", "outCharset": "utf-8", "notice": 0,
                        "platform": "yqq.json", "needNewCode": 0})
    cd = (j.get("cdlist") or [None])[0]
    if j.get("code") != 0 or not cd:
        raise ValueError("没有这个歌单，或者是私人歌单（只能读公开的）")
    res = {"title": cd.get("dissname") or "", "songs": [_song(s) for s in cd.get("songlist") or []]}
    with _LOCK:
        _LISTS[disstid] = (time.time(), res)
    return res


_FOUND = {}                              # "title|artist|dur" -> (when, song or None)


def find_song(title, artist, dur=0):
    """The song QQ Music knows by this name, or None. A song already looked for on the side (the pictures of the history
    lines, below) is not searched for again: a click on it is at once. (Otherwise asked once per song for a minute: a
    miss as well.)"""
    known = known_song(title, artist, dur)
    if known:
        return known
    key = f"{norm(title)}|{norm(artist)}|{int(dur or 0)}"
    with _LOCK:
        hit = _FOUND.get(key)
    if hit and time.time() - hit[0] < 60:
        return hit[1]
    song = None
    for q in dict.fromkeys([f"{title} {artist}".replace("_", " ").strip(), str(title or "").replace("_", " ")]):
        try:
            song = pick_song(search(q), title, artist, dur)
        except Exception:
            song = None
        if song:
            break
    with _LOCK:
        if len(_FOUND) > 300:
            _FOUND.clear()
        _FOUND[key] = (time.time(), song)
    return song


# ---------------------------------------------------------------- covers of the history lines
# A lyric file gives the album's name but not its picture. The picture is found once per song, on the side (a search each,
# a few a second at most), kept in memory and in a small file, and shown as it comes: the list asks for what is known and
# gets the rest a moment later.
_COVERS = {}                             # "title|artist|dur" -> {albummid, songid, songmid} ({} = looked for, none found)
_COVER_Q = []                            # songs (title, artist, dur) still to look for
_COVER_TRIED = set()                     # keys put in the line this time the program runs
_COVER_BUSY = {"n": 0, "loaded": False}      # n: searchers running
COVER_WORKERS = 3                        # a search takes a second or two: a few at a time, not a burst
COVER_PAUSE = 0.25                       # seconds between two searches
COVER_FILE_MAX = 3000


def _cover_file():
    try:
        import disk_cache as DC
        return os.path.join(DC.ROOT, "qq_covers.json")
    except Exception:
        return ""


def _cover_key(title, artist, dur):
    return f"{norm(title)}|{norm(artist)}|{int(dur or 0)}"


def _cover_load():
    if _COVER_BUSY["loaded"]:
        return
    _COVER_BUSY["loaded"] = True
    p = _cover_file()
    try:
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict):
            for k, v in d.items():
                if isinstance(v, dict):
                    _COVERS[str(k)] = {x: v[x] for x in ("albummid", "songid", "songmid") if v.get(x)}
                elif v:
                    _COVERS[str(k)] = {"albummid": str(v)}      # (the file of an earlier version: the picture only)
    except (OSError, ValueError):
        pass


def _cover_save():
    p = _cover_file()
    if not p:
        return
    items = [(k, v) for k, v in list(_COVERS.items()) if v][-COVER_FILE_MAX:]      # (a song that had none is asked again the next time the program starts)
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(dict(items), f, ensure_ascii=False)
        os.replace(tmp, p)
    except OSError:
        pass


def resolve_cover(title, artist, dur):
    """Find one song now (a search or two): its album mid for the picture, and its numbers for playing and for the
    heart, all remembered. The album mid, or "" when there is none; None when the web did not answer."""
    key = _cover_key(title, artist, dur)
    rec = {}
    for q in dict.fromkeys([f"{title} {artist}".replace("_", " ").strip(), str(title or "").replace("_", " ")]):
        try:
            song = pick_song(search(q), title, artist, dur)
        except Exception:
            return None                  # no network, a blocked answer: not remembered, asked again later
        if song:
            rec = {x: song[x] for x in ("albummid", "songid", "songmid") if song.get(x)}
            break
    with _LOCK:
        if not rec and (_COVERS.get(key) or {}).get("albummid"):
            rec = _COVERS[key]            # looked for again and not found now: the picture it had stays
        _COVERS[key] = rec
    return rec.get("albummid", "")


def known_song(title, artist, dur=0):
    """What the side search has found of a song (its numbers: songid, songmid, albummid), or None when it has not (yet)."""
    _cover_load()
    with _LOCK:
        rec = _COVERS.get(_cover_key(title, artist, dur))
    return {"name": title, "singers": [], "album": "", "interval": int(dur or 0), **rec} if rec and rec.get("songid") else None


def _cover_worker():
    try:
        while True:
            with _LOCK:
                if not _COVER_Q:
                    return
                title, artist, dur = _COVER_Q.pop(0)
            if resolve_cover(title, artist, dur) is None:
                time.sleep(5)            # the web is not answering: not a burst of tries
            else:
                _cover_save()
            time.sleep(COVER_PAUSE)
    finally:
        with _LOCK:
            _COVER_BUSY["n"] -= 1


def cover_for(title, artist, dur):
    """The picture (an address) of a song known by name, "" while it is not known (yet, or at all). A song not looked for
    yet is put in the line, to be looked for on the side (so is one only its picture is known of, from the file of an
    earlier version: its numbers are wanted too, once)."""
    _cover_load()
    key = _cover_key(title, artist, dur)
    with _LOCK:
        rec = _COVERS.get(key)
        if rec is None or ("albummid" in rec and "songid" not in rec and key not in _COVER_TRIED):
            _COVER_TRIED.add(key)
            if not any(_cover_key(*q) == key for q in _COVER_Q) and len(_COVER_Q) < 200:
                _COVER_Q.append((title, artist, dur))
            if _COVER_BUSY["n"] < min(COVER_WORKERS, len(_COVER_Q)):
                _COVER_BUSY["n"] += 1
                threading.Thread(target=_cover_worker, daemon=True).start()
            if rec is None:
                return ""
    return cover_url((rec or {}).get("albummid", ""))
