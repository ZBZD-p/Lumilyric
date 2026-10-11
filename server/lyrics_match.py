"""
Pick the right lyrics for a song a player is on: search QQ Music / Kugou / NetEase through LDDC, score the
results against what the player reports (title, artist, length), download the best few, return the best.
Scoring is pure (score_item), so it can be tested without the network.
"""
import re
import unicodedata

MIN_SCORE = 40

_BRACKETS = re.compile(r"[\(（\[【《<].*?[\)）\]】》>]")
_SUFFIX = re.compile(r"\s+[-–—]\s+.*$")
_FEAT = re.compile(r"\s*[\(（]?\s*(feat\.?|ft\.?|with)\s.*$", re.I)


def clean_title(t):
    """'Song (Live) - 电影《x》插曲' -> 'Song'."""
    t = _BRACKETS.sub(" ", t or "")
    t = _SUFFIX.sub("", t)
    t = _FEAT.sub("", t)
    return re.sub(r"\s+", " ", t).strip()


def norm(s):
    s = unicodedata.normalize("NFKC", s or "").lower()
    return "".join(c for c in s if c.isalnum())


def _artists(s):
    parts = re.split(r"[/、,，&;；]|\s+x\s+|\s+feat\.?\s+", unicodedata.normalize("NFKC", s or "").lower())
    return {norm(p) for p in parts if norm(p)}


def score_item(item, title, artist, duration, src_pref):
    """Higher is better. duration <= 0: the player's length is unknown, it is not scored on."""
    sc = 0.0
    if duration > 0 and item.get("duration"):
        d = abs(item["duration"] - duration)
        sc += 50 if d <= 2 else 25 if d <= 5 else -40 if d > 15 else 0
    want, got = norm(title), norm(item.get("title"))
    want_clean = norm(clean_title(title))
    if got and (got == want or got == want_clean):
        sc += 30
    elif got and want_clean and (want_clean in got or got in want_clean):
        sc += 15
    elif got and want_clean:
        sc -= 60                                    # same artist, different song: never a match on its own
    a, b = _artists(artist), _artists(item.get("artist"))
    if a and b and (a & b or any(x in y or y in x for x in a for y in b)):
        sc += 20
    if src_pref and item.get("source") == src_pref:
        sc += 10
    return sc


def find(title, artist, duration, src_pref=""):
    """{lrc, source, title, verbatim, score, album} or {lrc: None, reason}. `duration` 0 = unknown."""
    import lddc_bridge as LD
    if not LD.available():
        return {"lrc": None, "reason": "还没有安装 LDDC，先运行 scripts\\setup_lddc.bat"}
    kw = f"{clean_title(title)} {artist}".strip()
    res = LD.search_all(kw)
    items = res["items"]
    if not items and artist:
        items = LD.search_all(clean_title(title))["items"]
    if not items and res["errors"]:
        return {"lrc": None, "reason": "搜索歌词失败：" + "；".join(f"{k} {v}" for k, v in res["errors"].items())}
    best, top = None, []
    for dur in ([duration, 0] if duration else [0]):        # second pass: the length may be what is wrong
        ranked = sorted(((score_item(i, title, artist, dur, src_pref), i) for i in items), key=lambda x: -x[0])[:3]
        top = top or [(round(sc), i["source"], i["title"], i["artist"]) for sc, i in ranked]
        for sc, it in ranked:
            try:
                got = LD.get_lrc(it["token"])
            except Exception:
                continue
            total = sc + (15 if got["verbatim"] else 0)
            if best is None or total > best["score"]:
                best = {"lrc": got["lrc"], "source": got["source"] or it["source"], "title": got["title"] or it["title"],
                        "verbatim": got["verbatim"], "score": total, "album": it.get("album") or ""}
        if best and best["score"] >= MIN_SCORE:
            break
    if best is None or best["score"] < MIN_SCORE:
        print(f"no lyrics matched '{kw}' ({duration:.0f}s); best candidates: {top}; failed sources: {res['errors']}")
        return {"lrc": None, "reason": "没有找到匹配的歌词" + (f"（搜到 {len(items)} 个结果，没有够像的）" if items else "（没有搜到结果）")}
    return best
