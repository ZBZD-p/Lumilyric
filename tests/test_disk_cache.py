"""Disk cache of lyrics and covers (server/disk_cache.py). Run: python tests/test_disk_cache.py"""
import os
import sys
import tempfile
import time

tmp = tempfile.mkdtemp(prefix="lrc-cache-test-")
os.environ["LRC_CACHE_DIR"] = tmp
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
import disk_cache as DC  # noqa: E402

fails = []


def check(name, cond, info=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else "  " + str(info)))
    if not cond:
        fails.append(name)


JPEG = b"\xff\xd8\xff\xe0" + b"x" * 5000
PNG = b"\x89PNG\r\n\x1a\n" + b"y" * 3000

k1 = DC.song_key("Blinding Lights", "The Weeknd", "After Hours")
check("the key ignores case, spacing and punctuation", k1 == DC.song_key("  blinding  LIGHTS ", "the weeknd", "After-Hours"))
check("another song, another key", k1 != DC.song_key("Save Your Tears", "The Weeknd", "After Hours"))
check("a song without a title has no key", DC.song_key("", "x") is None and DC.song_key("!!!", "x") is None)

check("nothing cached yet", DC.get_lyrics(k1) is None and DC.get_cover(k1) is None)
res = {"lrc": "[00:01.00]hello\n", "source": "QQ音乐", "title": "Blinding Lights", "verbatim": True, "score": 100, "album": "After Hours"}
check("lyrics are stored", DC.put_lyrics(k1, res))
got = DC.get_lyrics(k1)
check("lyrics come back whole", got and got["lrc"] == res["lrc"] and got["source"] == "QQ音乐" and got["album"] == "After Hours" and got["verbatim"] is True, got)
check("a miss is never stored", not DC.put_lyrics(k1 + "x", {"lrc": None, "reason": "none"}) and DC.get_lyrics(k1 + "x") is None)

check("a cover is stored", DC.put_cover(k1, JPEG, "image/jpeg", 800, "QQ"))
c = DC.get_cover(k1)
check("the cover comes back byte for byte with its size", c and c[0] == JPEG and c[1] == "image/jpeg" and c[2] == 800)
check("something that is not an image is refused", not DC.put_cover(k1 + "t", b"<html>no</html>", "text/html", 0))
check("an oversized image is refused", not DC.put_cover(k1 + "b", b"\xff\xd8" + b"0" * (9 * 1024 * 1024)))

# a damaged file is ignored and removed, not trusted
lp = os.path.join(tmp, "lyrics", k1 + ".json")
with open(lp, "wb") as f:
    f.write(b"{ not json")
check("damaged lyrics are ignored", DC.get_lyrics(k1) is None and not os.path.exists(lp))
cp = os.path.join(tmp, "covers", k1 + ".img")
with open(cp, "ab") as f:
    f.write(b"junk")                                   # length no longer matches the metadata
check("a damaged cover is ignored", DC.get_cover(k1) is None)

# size cap: the least recently used go first, covers as a pair
for i in range(6):
    DC.put_cover("song%d" % i, PNG, "image/png", 300)
    time.sleep(0.02)
DC.get_cover("song0")                                   # used again: now the newest
total_before = DC.prune(10 ** 9)
left = DC.prune(2 * (len(PNG) + 120))                   # room for about two covers
check("the cache shrinks under the cap", left <= 2 * (len(PNG) + 120) + 200, left)
check("the one used last survives", DC.get_cover("song0") is not None)
check("the oldest was dropped", DC.get_cover("song1") is None)
check("no half covers are left behind", all(
    os.path.exists(os.path.join(tmp, "covers", n[:-4] + ".json")) == os.path.exists(os.path.join(tmp, "covers", n[:-4] + ".img"))
    for n in os.listdir(os.path.join(tmp, "covers")) if n.endswith(".img")))

# leftovers of a crash are cleaned
with open(os.path.join(tmp, "lyrics", "zzz.json.tmp"), "wb") as f:
    f.write(b"partial")
DC.prune(10 ** 9)
check("a half-written file is removed", not os.path.exists(os.path.join(tmp, "lyrics", "zzz.json.tmp")))

print("\n%d failed" % len(fails) if fails else "\nall passed")
sys.exit(1 if fails else 0)
