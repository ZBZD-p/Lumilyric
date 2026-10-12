"""
Album cover search for server.py.

Sources: Apple Music / iTunes Search API (public, no key; up to 1000x1000 artwork) and, when LDDC is
installed, the album search of QQ Music, NetEase Cloud Music and Kugou. Images are downloaded here and
passed to the page, so the browser never has to talk to these sites itself.

Some Apple Music albums have a moving cover (a short looping video). Which ones, and the video itself, come
from the catalogue the Apple Music web player reads (amp-api.music.apple.com), with the token that player
carries in its own script. This is not a public API: it may change or stop working at any time, and then
the search simply shows no moving covers.
"""
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import disk_cache as DC

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"}
IMG_HOSTS = ("mzstatic.com", "gtimg.cn", "music.126.net", "kugou.com", "kgimg.com", "qq.com")


def _get(url, timeout=12, headers=None):
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get("Content-Type", "")


# ---- Apple Music moving covers ----
AM_WEB = "https://music.apple.com"
AM_API = "https://amp-api.music.apple.com"
MOTION_MAX = 80 * 1024 * 1024                      # no moving cover is anywhere near this
_am = {"token": None, "at": 0.0}


def _am_token(fresh=False):
    """the token of the Apple Music web player: it is written into the player's script"""
    if _am["token"] and not fresh and time.time() - _am["at"] < 6 * 3600:
        return _am["token"]
    page = _get(AM_WEB + "/us/browse", 15)[0].decode("utf-8", "replace")
    m = re.search(r'/assets/index[^"\']*\.js', page)
    if not m:
        raise RuntimeError("Apple Music 网页改版了，找不到播放器脚本")
    js = _get(AM_WEB + m.group(0), 40)[0].decode("utf-8", "replace")
    t = re.search(r"eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+", js)
    if not t:
        raise RuntimeError("Apple Music 网页改版了，找不到令牌")
    _am.update(token=t.group(0), at=time.time())
    return _am["token"]


def _am_api(path):
    for fresh in (False, True):                    # the token expires: once more with a new one
        try:
            head = {"Authorization": "Bearer " + _am_token(fresh), "Origin": AM_WEB}
            return json.loads(_get(AM_API + path, 15, head)[0].decode("utf-8"))
        except urllib.error.HTTPError as e:
            if fresh or e.code not in (401, 403):
                raise


def _am_motion(ids, country):
    """{album id: playlist of its moving cover} for those of the albums that have one"""
    out = {}
    ids = [i for i in dict.fromkeys(ids) if i]
    for k in range(0, len(ids), 25):
        d = _am_api(f"/v1/catalog/{country}/albums?ids={','.join(ids[k:k + 25])}&extend=editorialVideo")
        for a in d.get("data", []):
            ev = (a.get("attributes") or {}).get("editorialVideo") or {}
            v = (ev.get("motionSquareVideo1x1") or ev.get("motionDetailSquare") or {}).get("video")
            if v:
                out[str(a.get("id"))] = v
    return out


def _apple_host(url):
    host = urllib.parse.urlparse(url).hostname or ""
    if not (host == "apple.com" or host.endswith(".apple.com")):
        raise ValueError("不支持的视频地址")
    return url


def fetch_motion(album, country):
    """the moving cover of an Apple Music album as one MP4 file (H.264, at most 1080 px), or None when it has none"""
    if not re.fullmatch(r"\d{1,20}", album or "") or not re.fullmatch(r"[a-z]{2}", country or ""):
        raise ValueError("参数不对")
    saved = DC.get_motion(album, country)          # downloaded before: no need to ask Apple again
    if saved:
        return saved
    master_url = _am_motion([album], country).get(album)
    if not master_url:
        return None
    master = _get(_apple_host(master_url), 15)[0].decode("utf-8", "replace").splitlines()
    best = None
    for i, line in enumerate(master[:-1]):
        # H.264 only: every browser plays it (the larger variants are HEVC, which many cannot)
        if not line.startswith("#EXT-X-STREAM-INF") or 'CODECS="avc1' not in line:
            continue
        res, bw = re.search(r"RESOLUTION=(\d+)x(\d+)", line), re.search(r"[,:]BANDWIDTH=(\d+)", line)
        if not res or not bw or int(res.group(2)) > 1080:
            continue
        rank = (int(res.group(2)), -abs(int(bw.group(1)) - 6_500_000))      # the largest picture, at a middling bitrate
        if not best or rank > best[0]:
            best = (rank, master[i + 1].strip())
    if not best:
        return None
    var_url = _apple_host(urllib.parse.urljoin(master_url, best[1]))
    files = []                                     # the header (EXT-X-MAP) and the segments, in order
    for line in _get(var_url, 15)[0].decode("utf-8", "replace").splitlines():
        line = line.strip()
        m = re.match(r'#EXT-X-MAP:.*URI="([^"]+)"', line)
        name = m.group(1) if m else (line if line and not line.startswith("#") else None)
        if line.startswith("#EXT-X-KEY"):
            raise RuntimeError("这个动态封面是加密的，下载不了")
        if name and name not in files:
            files.append(name)
    # usually one file, cut into byte ranges by the playlist: the whole file is the video
    data = b""
    for name in files:
        data += _get(_apple_host(urllib.parse.urljoin(var_url, name)), 60)[0]
        if len(data) > MOTION_MAX:
            raise RuntimeError("动态封面太大了")
    DC.put_motion(album, country, data)
    return data or None


def _itunes(q, country):
    url = "https://itunes.apple.com/search?" + urllib.parse.urlencode(
        {"term": q, "entity": "song", "limit": 25, "country": country})
    data = json.loads(_get(url)[0].decode("utf-8"))
    out = []
    for r in data.get("results", []):
        art = r.get("artworkUrl100")
        if not art:
            continue
        out.append({"key": f"am{r.get('collectionId')}", "source": "Apple Music", "am": [str(r.get("collectionId") or ""), country],
                    "title": r.get("collectionName") or r.get("trackName") or "",
                    "artist": r.get("artistName") or "",
                    "thumb": art.replace("100x100bb", "300x300bb"),
                    "full": art.replace("100x100bb", "1000x1000bb")})
    return out


def _bigger(url, source):
    if source == "QQ音乐":
        return url.replace("R180x180", "R800x800").replace("R300x300", "R800x800").replace("R150x150", "R800x800")
    if source == "网易云":
        return url.split("?")[0] + "?param=800y800"
    if source == "酷狗":                      # the size sits in the path (/stdmusic/240/...): 1000 is served too
        return re.sub(r"/stdmusic/\d+/", "/stdmusic/1000/", url.replace("{size}", "1000"))
    return url


def _thumb(url, source):
    if source == "QQ音乐":
        return _bigger(url, source).replace("R800x800", "R300x300")
    if source == "网易云":
        return _bigger(url, source).replace("800y800", "300y300")
    if source == "酷狗":
        return re.sub(r"/stdmusic/\d+/", "/stdmusic/240/", url.replace("{size}", "240"))
    return url


def _lddc_albums(q):
    import lddc_bridge as LD
    if not LD.available():
        return []
    from LDDC.common.models import SearchType
    from LDDC.core.api.lyrics import search
    names = LD._names()

    def one(src):
        try:
            return src, list(search(src, q, SearchType.ALBUM))[:8]
        except Exception:
            return src, []

    out = []
    with ThreadPoolExecutor(len(names)) as ex:
        for src, albums in ex.map(one, names):
            for a in albums:
                img = getattr(a, "imgurl", None)
                if not img:
                    continue
                if img.startswith("//"):
                    img = "https:" + img
                name = names[src]
                out.append({"key": f"{src.name}{a.id}", "source": name, "title": a.title or "",
                            "artist": getattr(a, "author", "") or "",
                            "thumb": _thumb(img, name),
                            "full": _bigger(img, name)})
    return out


def search_covers(q):
    jobs = {"cn": lambda: _itunes(q, "cn"), "us": lambda: _itunes(q, "us"), "lddc": lambda: _lddc_albums(q)}
    res, errors = {}, {}
    with ThreadPoolExecutor(len(jobs)) as ex:
        futs = {k: ex.submit(f) for k, f in jobs.items()}
        for k, f in futs.items():
            try:
                res[k] = f.result()
            except Exception as e:
                res[k] = []
                errors[k] = f"{type(e).__name__}: {e}"[:160]
    seen, items = set(), []
    # interleave: platform albums and Apple Music, the most relevant of each first
    lists = [res.get("lddc", []), res.get("cn", []) + res.get("us", [])]
    for i in range(max(len(x) for x in lists) if lists else 0):
        for L in lists:
            if i < len(L) and L[i]["key"] not in seen:
                seen.add(L[i]["key"])
                items.append(L[i])
    # which of the Apple Music albums have a moving cover (asked in one go per country; no harm if it fails)
    for cc in ("cn", "us"):
        albums = [it["am"][0] for it in res.get(cc, [])]
        try:
            moving = _am_motion(albums, cc) if albums else {}
        except Exception as e:
            print(f"moving covers ({cc}): {type(e).__name__}: {e}"[:200])
            moving = {}
        for it in res.get(cc, []):
            if it["am"][0] in moving:
                it["motion"] = True
    if errors.get("cn") and errors.get("us"):
        errors = {"Apple Music": errors["cn"], **{k: v for k, v in errors.items() if k not in ("cn", "us")}}
    else:
        errors.pop("cn", None); errors.pop("us", None)
    return {"items": items[:40], "errors": errors}


def fetch_image(url):
    host = urllib.parse.urlparse(url).hostname or ""
    if not any(host == h or host.endswith("." + h) for h in IMG_HOSTS):
        raise ValueError("不支持的图片地址")
    data, ctype = _get(url, timeout=20)
    if not ctype.startswith("image/"):
        ctype = "image/jpeg"
    return data, ctype
