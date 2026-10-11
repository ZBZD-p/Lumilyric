"""
Disk cache for the "follow the player" feature: the lyrics found for a song and the sharp cover chosen for it, so
the second time a song plays they are there at once, without searching or downloading anything.

Lives in tools\\cache (not part of the repository; delete the folder to clear it). Keyed by the song itself
(title, artist, album, normalised), not by the player. Size is capped (LRC_CACHE_MB, default 300): the files that
were used longest ago go first. Safe against a crash half way (files are written aside and renamed) and against
damaged files (they are ignored and removed).
"""
import hashlib
import json
import os
import threading
import time
import unicodedata

ROOT = os.environ.get("LRC_CACHE_DIR") or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools", "cache")
MAX_BYTES = int(float(os.environ.get("LRC_CACHE_MB", "300")) * 1024 * 1024)
MAX_IMAGE = 8 * 1024 * 1024
_LOCK = threading.Lock()
_puts = 0


def _norm(s):
    s = unicodedata.normalize("NFKC", s or "").lower()
    return "".join(c for c in s if c.isalnum())


def song_key(title, artist, album=""):
    """Same song -> same key, whatever the case, spacing or punctuation. None when there is nothing to key on."""
    if not _norm(title):
        return None
    raw = "|".join(_norm(x) for x in (title, artist, album))
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:24]


def _dir(kind):
    d = os.path.join(ROOT, kind)
    os.makedirs(d, exist_ok=True)
    return d


def _write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def _touch(path):
    try:
        os.utime(path, None)               # "used now": the oldest-used files are the ones pruned
    except OSError:
        pass


def _drop(*paths):
    for p in paths:
        try:
            os.remove(p)
        except OSError:
            pass


def _is_image(data):
    return data[:2] == b"\xff\xd8" or data[:8] == b"\x89PNG\r\n\x1a\n" or data[:4] == b"RIFF" or data[:6] in (b"GIF87a", b"GIF89a")


# ---------------------------------------------------------------- lyrics
def get_lyrics(key):
    if not key:
        return None
    p = os.path.join(_dir("lyrics"), key + ".json")
    with _LOCK:
        try:
            with open(p, "rb") as f:
                d = json.loads(f.read().decode("utf-8"))
            if not isinstance(d, dict) or not d.get("lrc"):
                raise ValueError("no lyrics in it")
        except FileNotFoundError:
            return None
        except Exception:
            _drop(p)
            return None
        _touch(p)
        return d


def put_lyrics(key, res):
    """res: the lookup result (only a hit, with its lrc, is worth keeping)."""
    if not key or not res or not res.get("lrc"):
        return False
    d = {k: res.get(k) for k in ("lrc", "source", "title", "verbatim", "score", "album")}
    d["saved"] = int(time.time())
    with _LOCK:
        _write(os.path.join(_dir("lyrics"), key + ".json"), json.dumps(d, ensure_ascii=False).encode("utf-8"))
    _after_put()
    return True


# ---------------------------------------------------------------- covers
def get_cover(key):
    """(bytes, mime, side) or None."""
    if not key:
        return None
    base = os.path.join(_dir("covers"), key)
    with _LOCK:
        try:
            with open(base + ".json", "rb") as f:
                meta = json.loads(f.read().decode("utf-8"))
            with open(base + ".img", "rb") as f:
                data = f.read()
            if not _is_image(data) or len(data) != meta.get("bytes"):
                raise ValueError("damaged")
        except FileNotFoundError:
            return None
        except Exception:
            _drop(base + ".json", base + ".img")
            return None
        _touch(base + ".json")
        _touch(base + ".img")
        return data, meta.get("mime") or "image/jpeg", int(meta.get("side") or 0)


def put_cover(key, data, mime="image/jpeg", side=0, label=""):
    if not key or not data or len(data) > MAX_IMAGE or not _is_image(data):
        return False
    base = os.path.join(_dir("covers"), key)
    meta = {"mime": mime if str(mime).startswith("image/") else "image/jpeg", "side": int(side or 0),
            "bytes": len(data), "label": str(label)[:120], "saved": int(time.time())}
    with _LOCK:
        _write(base + ".img", data)
        _write(base + ".json", json.dumps(meta, ensure_ascii=False).encode("utf-8"))
    _after_put()
    return True


# ---------------------------------------------------------------- size
def _after_put():
    global _puts
    _puts += 1
    if _puts % 25 == 1:
        prune()


def prune(max_bytes=None):
    """Delete the least recently used files until the cache fits. Returns the bytes left."""
    limit = MAX_BYTES if max_bytes is None else max_bytes
    files = []
    with _LOCK:
        for kind in ("lyrics", "covers"):
            d = os.path.join(ROOT, kind)
            if not os.path.isdir(d):
                continue
            for name in os.listdir(d):
                p = os.path.join(d, name)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                if name.endswith(".tmp"):          # left by a crash
                    _drop(p)
                    continue
                files.append((st.st_mtime, st.st_size, p))
        total = sum(f[1] for f in files)
        for mtime, size, p in sorted(files):
            if total <= limit:
                break
            # a cover is a pair: drop both halves together
            stem = os.path.splitext(p)[0]
            for q in ([stem + ".json", stem + ".img"] if p.endswith((".img", ".json")) and os.sep + "covers" + os.sep in p else [p]):
                try:
                    s2 = os.path.getsize(q)
                except OSError:
                    continue
                _drop(q)
                total -= s2
    return total
