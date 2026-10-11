"""
Album cover search for server.py.

Sources: Apple Music / iTunes Search API (public, no key; up to 1000x1000 artwork) and, when LDDC is
installed, the album search of QQ Music, NetEase Cloud Music and Kugou. Images are downloaded here and
passed to the page, so the browser never has to talk to these sites itself.
"""
import json
import re
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"}
IMG_HOSTS = ("mzstatic.com", "gtimg.cn", "music.126.net", "kugou.com", "kgimg.com", "qq.com")


def _get(url, timeout=12):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), r.headers.get("Content-Type", "")


def _itunes(q, country):
    url = "https://itunes.apple.com/search?" + urllib.parse.urlencode(
        {"term": q, "entity": "song", "limit": 25, "country": country})
    data = json.loads(_get(url)[0].decode("utf-8"))
    out = []
    for r in data.get("results", []):
        art = r.get("artworkUrl100")
        if not art:
            continue
        out.append({"key": f"am{r.get('collectionId')}", "source": "Apple Music",
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
