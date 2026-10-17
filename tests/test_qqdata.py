"""QQ Music desktop lists (server/qqdata.py): names, matching a song, the cache folder. Run: python tests/test_qqdata.py"""
import os
import sys
import tempfile

CACHE = tempfile.mkdtemp(prefix="lrc-qqcov-")
os.environ["LRC_CACHE_DIR"] = CACHE                 # (the pictures found are kept in a file there)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
import qqdata as Q  # noqa: E402
import time  # noqa: E402

fails = []


def check(name, cond, info=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else "  " + str(info)))
    if not cond:
        fails.append(name)


song = lambda name, singers, sec, mid="m": {"name": name, "singers": singers, "interval": sec, "songid": 1, "songmid": mid}

check("names compare without case, spacing, brackets and punctuation", Q.norm("Stan (Explicit)") == Q.norm(" STAN ") == "stan" and Q.norm("Dawn FM - Single") == "dawnfm")
check("Chinese names stay", Q.norm("七楼（Live）") == "七楼")
check("artists are split", Q.artists_of("Eminem/Dido") == {"eminem", "dido"} and Q.artists_of("A & B feat. C") == {"a", "b", "c"})
check("QQ Music writes the '/' between artists as '_' in its file names", Q.artists_of("Martin Garrix_Troye Sivan") == {"martingarrix", "troyesivan"})

res = [song("Stan (Live)", ["Eminem", "Elton John"], 380, "live"), song("Stan (Explicit)", ["Eminem", "Dido"], 404, "ex"), song("Stan", ["Eminem"], 404, "plain"), song("Stand By Me", ["Ben E. King"], 180, "x")]
p = Q.pick_song(res, "Stan", "Eminem/Dido", 404)
check("the studio song with both artists is taken over the live one", p and p["songmid"] == "ex", p)
check("the length tells versions apart", Q.pick_song([song("Stan", ["Eminem"], 380, "a"), song("Stan", ["Eminem"], 404, "b")], "Stan", "Eminem", 404)["songmid"] == "b")
check("another artist's song of the same name is not it", Q.pick_song([song("Stan", ["Someone Else"], 404)], "Stan", "Eminem", 404) is None)
check("a song that is not there gives None, not the nearest", Q.pick_song(res, "Lose Yourself", "Eminem", 326) is None)
check("a live version is taken when the player says live", Q.pick_song([song("七楼 (Live)", ["陈粒"], 267, "l"), song("七楼", ["陈粒"], 189, "s")], "七楼 (Live)", "陈粒", 267)["songmid"] == "l")
check("no title, no song", Q.pick_song(res, "", "Eminem", 100) is None)
check("a file name's artists match the service's", Q.pick_song([song("Telescope", ["Tim Legend", "Transviolet"], 175, "t")], "Telescope", "Tim Legend_Transviolet", 175)["songmid"] == "t")
check("a title with the artist unknown still matches by length", Q.pick_song([song("Stan", ["Eminem"], 404, "k")], "Stan", "", 404)["songmid"] == "k")

for t, want in [("8058033089", "8058033089"), ("https://y.qq.com/n/ryqq/playlist/8058033089", "8058033089"), ("https://i.y.qq.com/n2/m/share/details/taoge.html?id=7256912512&x=1", "7256912512"),
                ("https://y.qq.com/?disstid=123456789", "123456789"), ("abc", ""), ("12", ""), ("", "")]:
    check(f"play list number from {t!r}", Q.parse_playlist_id(t) == want, Q.parse_playlist_id(t))

c = Q.parse_cache_name("Eminem - Stan (Explicit) - 404 - The Marshall Mathers LP (Explicit)_qm.qrc")
check("a lyric file name", c == {"artist": "Eminem", "title": "Stan (Explicit)", "dur": 404, "album": "The Marshall Mathers LP (Explicit)"}, c)
check("its other forms are the same song", Q.parse_cache_name("A - T - 10 - B_qmts.qrc")["title"] == "T" and Q.parse_cache_name("A - T - 10 - B_qmRoma.qrc")["album"] == "B")
check("a file that is no lyric is not one", Q.parse_cache_name("lyricinfo.dat") is None and Q.parse_cache_name("LyricInfo.crc") is None and Q.parse_cache_name("nothing here.qrc") is None)

# the cache folder: named by hand, by QQ Music's settings, or the default; moving it in QQ Music is followed
tmp = tempfile.mkdtemp(prefix="lrc-qqdata-")
os.environ["APPDATA"] = os.path.join(tmp, "Roaming")
dd = Q.data_dir()
os.makedirs(dd)
moved = os.path.join(tmp, "E", "QQMusicCache")
os.makedirs(os.path.join(moved, Q.LYRIC_DIR))
for n, mt in [("A - Old - 100 - X_qm.qrc", 1000), ("B - New - 200 - Y_qm.qrc", 3000), ("B - New - 200 - Y_qmts.qrc", 3500), ("C - Mid - 300 - Z_qm.qrc", 2000), ("lyricinfo.dat", 4000)]:
    f = os.path.join(moved, Q.LYRIC_DIR, n)
    open(f, "w").close()
    os.utime(f, (mt, mt))
r0 = Q.cache_root()
check("no settings and no cache: nothing found", r0[2] is False and r0[1] == "默认位置", r0)
with open(os.path.join(dd, "WebkitCachePath.ini"), "w", encoding="utf-8") as f:
    f.write("[WebkitCache]\nPath=" + os.path.join(moved, "WebkitCache") + "\n")
r1 = Q.cache_root()
check("QQ Music's own setting is followed", r1 == (moved, "QQ音乐设置", True), r1)
other = os.path.join(tmp, "backup")
os.makedirs(os.path.join(other, Q.LYRIC_DIR))
r2 = Q.cache_root(other)
check("a place named by hand wins", r2 == (other, "手动指定", True), r2)
r3 = Q.cache_root(os.path.join(other, Q.LYRIC_DIR))
check("the lyric folder itself may be named", r3 == (other, "手动指定", True), r3)
r4 = Q.cache_root(os.path.join(tmp, "nowhere"))
check("a place named by hand that is not there is said so, not quietly replaced", r4[1] == "手动指定" and r4[2] is False, r4)
h = Q.history(moved)
check("history: newest first, one line per song, no stray files", [x["title"] for x in h] == ["New", "Mid", "Old"], [x["title"] for x in h])
check("history of nowhere is empty", Q.history(os.path.join(tmp, "nowhere")) == [])
check("a limit", len(Q.history(moved, 2)) == 2)

# the pictures of the history lines: found once, on the side, kept
searched = []


def fake_search(q, num=10):
    searched.append(q)
    if "Nowhere" in q:
        return []
    if "Offline" in q:
        raise OSError("no network")
    return [{"songid": 1, "songmid": "m", "name": "Stan", "singers": ["Eminem"], "album": "MMLP", "albummid": "ALB123", "interval": 404}]


Q.search = fake_search
Q.COVER_PAUSE = 0.01
check("the picture of a song is its album's", Q.resolve_cover("Stan", "Eminem", 404) == "ALB123" and Q.cover_url("ALB123").endswith("M000ALB123.jpg"))
check("a song that is not found is remembered as having none", Q.resolve_cover("Nowhere", "X", 100) == "" and Q._COVERS[Q._cover_key("Nowhere", "X", 100)] == {})
check("no network is not remembered (it is asked again later)", Q.resolve_cover("Offline", "Y", 100) is None and Q._cover_key("Offline", "Y", 100) not in Q._COVERS)
Q._COVERS.clear()
searched.clear()
first = Q.cover_for("Stan", "Eminem", 404)
time.sleep(0.6)
check("a picture not known yet is '' at first and looked for on the side", first == "" and Q.cover_for("Stan", "Eminem", 404).endswith("M000ALB123.jpg"), searched)
n = len(searched)
Q.cover_for("Stan", "Eminem", 404)
check("and asked for only once", len(searched) == n)
import json as _json
saved = _json.load(open(os.path.join(CACHE, "qq_covers.json"), encoding="utf-8"))
check("it is kept in a file, for the next time", saved.get(Q._cover_key("Stan", "Eminem", 404)) == {"albummid": "ALB123", "songid": 1, "songmid": "m"}, saved)
Q._COVERS.clear()
Q._COVER_BUSY["loaded"] = False
check("and read from it", Q.cover_for("Stan", "Eminem", 404).endswith("M000ALB123.jpg") and len(searched) == n)
# what the side search found is what a click on the song uses: no search then
n2 = len(searched)
kn = Q.known_song("Stan", "Eminem", 404)
check("a song that was found is known by its numbers", kn and kn["songid"] == 1 and kn["songmid"] == "m" and kn["albummid"] == "ALB123", kn)
check("find_song takes it from there without a search", Q.find_song("Stan", "Eminem", 404)["songid"] == 1 and len(searched) == n2)
check("one that was not found, or not looked for, is not known", Q.known_song("Nowhere", "X", 100) is None and Q.known_song("Never Asked", "Z", 5) is None)
with open(os.path.join(CACHE, "qq_covers.json"), "w", encoding="utf-8") as f:
    _json.dump({Q._cover_key("Old", "Format", 10): "OLDALB"}, f)
Q._COVERS.clear(); Q._COVER_BUSY["loaded"] = False
check("the file of an earlier version (the picture only) is still read", Q.cover_for("Old", "Format", 10).endswith("M000OLDALB.jpg") and Q.known_song("Old", "Format", 10) is None)
time.sleep(0.6)
check("looked for again and not found, it keeps its picture", Q._COVERS[Q._cover_key("Old", "Format", 10)].get("albummid") == "OLDALB", Q._COVERS.get(Q._cover_key("Old", "Format", 10)))

print("\n" + ("all passed" if not fails else f"{len(fails)} failed: {fails}"))
sys.exit(1 if fails else 0)
