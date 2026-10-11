"""
Bridge to LDDC (https://github.com/chenmozhijin/LDDC, GPL-3.0) for server.py:
search QQ Music, Kugou and NetEase Cloud Music and fetch their word-by-word
lyrics as enhanced LRC (<mm:ss.xx> before every word), which index.html reads.

LDDC is installed separately into tools\\align-env by scripts\\setup_lddc.bat; only its
lyrics core is used here, its window never opens. Qt (PySide6, 215 MB) is not needed for that: the small
stand-in in qt_stub/ takes its place (see qt_stub/PySide6/__init__.py).
"""
import importlib.util
import os
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

_STUB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "qt_stub")
if _STUB not in sys.path:
    sys.path.insert(0, _STUB)   # before site-packages: the stand-in wins even when the real PySide6 is installed

_SONGS = {}                     # token -> LDDC SongInfo, so the page only passes short tokens around
_LOCK = threading.Lock()


def available():
    return importlib.util.find_spec("LDDC") is not None


def _names():
    from LDDC.common.models import Source
    return {Source.QM: "QQ音乐", Source.KG: "酷狗", Source.NE: "网易云"}


def search_all(keyword, per_source=8):
    """Search all three platforms at once. Results are interleaved (best of each first)."""
    from LDDC.common.models import SearchType
    from LDDC.core.api.lyrics import search

    names = _names()

    def one(src):
        try:
            return src, list(search(src, keyword, SearchType.SONG))[:per_source], None
        except Exception as e:  # one platform failing must not hide the others
            return src, [], f"{type(e).__name__}: {e}"[:200]

    with ThreadPoolExecutor(len(names)) as ex:
        results = list(ex.map(one, names))

    items, errors = [], {}
    with _LOCK:
        if len(_SONGS) > 2000:
            _SONGS.clear()
        for i in range(per_source):
            for src, songs, err in results:
                if err:
                    errors[names[src]] = err
                if i >= len(songs):
                    continue
                s = songs[i]
                token = uuid.uuid4().hex[:12]
                _SONGS[token] = s
                items.append({
                    "token": token,
                    "source": names[src],
                    "title": s.full_title if hasattr(s, "full_title") else (s.title or ""),
                    "artist": s.str_artist if hasattr(s, "str_artist") else str(s.artist or ""),
                    "album": s.album or "",
                    "duration": (s.duration or 0) / 1000,
                })
    return {"items": items, "errors": errors}


def get_lrc(token):
    """Download one song's lyrics and convert them to enhanced LRC (original + translation)."""
    from LDDC.common.models import LyricsFormat, LyricsType, Source
    from LDDC.core.api.lyrics import get_lyrics, get_lyricslist
    from LDDC.core.converter import convert2

    with _LOCK:
        info = _SONGS.get(token)
    if info is None:
        raise ValueError("搜索结果已过期，请重新搜索")
    try:
        lyrics = get_lyrics(info)
    except Exception:
        if info.source != Source.KG:
            raise
        candidates = get_lyricslist(info)     # Kugou keeps several lyric versions per song
        if not candidates:
            raise
        lyrics = get_lyrics(candidates[0])
    langs = [k for k in ("orig", "ts") if k in lyrics]
    text = convert2(lyrics, langs, LyricsFormat.ENHANCEDLRC)
    verbatim = lyrics.types.get("orig") == LyricsType.VERBATIM
    return {"lrc": text, "verbatim": verbatim, "translation": "ts" in lyrics,
            "source": _names().get(info.source, ""), "title": info.title or ""}
