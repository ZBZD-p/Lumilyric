"""QQ Music's list in the AM layout (server/nowplaying.py _qq_queue / _qq_action), with the disk, the web and the program
itself replaced. Run: python tests/test_qqqueue.py"""
import os
import sys

import tempfile  # noqa: E402
os.environ["LRC_MUSIC_API_DIR"] = tempfile.mkdtemp(prefix="lrc-music-")      # never the real accounts: no service is asked, nothing is hearted
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
import nowplaying as NP  # noqa: E402
import music_apis  # noqa: E402
music_apis.user = lambda svc, fresh=False: None      # (signed out: the QQ heart goes through its command line, stubbed below)
import qqdata  # noqa: E402
import qqcmd  # noqa: E402

fails = []


def check(name, cond, info=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else "  " + str(info)))
    if not cond:
        fails.append(name)


sent = []
qqcmd.play_song = lambda sid, t=0: (sent.append(("play", sid)) or (True, ""))
qqcmd.favorite = lambda mid, on=True: (sent.append(("fav" if on else "unfav", mid)) or (True, ""))
found = {}
qqdata.find_song = lambda title, artist, dur=0: found.get(title)
qqdata.cover_for = lambda title, artist, dur=0: ""          # (the pictures of the history are found on the side: qqdata tests)
qqdata.cache_root = lambda override="": ("E:\\QQMusicCache", "QQ音乐设置", True)
HIST = [  # newest first
    {"artist": "Eminem", "title": "Stan (Explicit)", "dur": 404, "album": "MMLP", "mtime": 5},
    {"artist": "Dido", "title": "Thank You", "dur": 218, "album": "NWTW", "mtime": 4},
    {"artist": "X", "title": "Older", "dur": 100, "album": "", "mtime": 3},
]
qqdata.history = lambda root, limit=40: HIST[:limit]
SONG = lambda i, n, a, mid: {"songid": i, "songmid": mid, "name": n, "singers": [a], "album": "Alb", "albummid": "am" + mid, "interval": 200}
LISTS = {"123456": {"title": "My list", "songs": [SONG(1, "First", "A", "m1"), SONG(2, "Stan", "Eminem", "m2"), SONG(3, "Third", "C", "m3"), SONG(4, "Fourth", "D", "m4")]}}


def playlist(pid):
    if pid not in LISTS:
        raise ValueError("没有这个歌单，或者是私人歌单（只能读公开的）")
    return LISTS[pid]


qqdata.playlist = playlist
M = {"app": "QQMusic.exe", "title": "Stan", "artist": "Eminem/Dido", "album": "MMLP"}

r = NP._qq_queue(M, 404.0, "", "")
titles = [i["title"] for i in r["items"]]
check("history oldest first, the song now last of them and marked", titles == ["Older", "Thank You", "Stan"] and [i["now"] for i in r["items"]] == [False, False, True], titles)
check("the song playing now is not also in the history (a '(Explicit)' of the same song counts)", titles.count("Stan") == 1 and "Stan (Explicit)" not in titles)
check("it says where the history came from", r["qq"]["how"] == "QQ音乐设置" and r["qq"]["found"] and r["qq"]["history"] == 2, r["qq"])
check("no play list asked for: none shown", r["qq"]["list"] == "" and r["qq"]["listErr"] == "")

r = NP._qq_queue(M, 404.0, "https://y.qq.com/n/ryqq/playlist/123456", "")
titles = [i["title"] for i in r["items"]]
check("a play list that has the song now goes on after it", titles == ["Older", "Thank You", "Stan", "Third", "Fourth"], titles)
check("with its covers, and the song now gets its own", r["items"][3]["cover"].endswith("M000amm3.jpg") and r["items"][2]["cover"].endswith("M000amm2.jpg"), [i["cover"] for i in r["items"]])
check("the play list's name and size are given", r["qq"]["listTitle"] == "My list" and r["qq"]["listCount"] == 4 and r["qq"]["list"] == "123456")
check("what the page gets has no song numbers in it", all(not k.startswith("_") and k not in ("songid", "songmid") for i in r["items"] for k in i))
ver1 = r["ver"]
check("the version changes with the list", NP._qq_queue(M, 404.0, "123456", "")["ver"] == ver1 and NP._qq_queue(M, 404.0, "", "")["ver"] != ver1)

M2 = dict(M, title="Not in the list", artist="Nobody")
r = NP._qq_queue(M2, 100.0, "123456", "")
check("a song that is not in the play list: all of the list comes after it", [i["title"] for i in r["items"]][-4:] == ["First", "Stan", "Third", "Fourth"], [i["title"] for i in r["items"]])

r = NP._qq_queue(M, 404.0, "999999", "")
check("a play list that cannot be had is said so, and the rest stays", r["ok"] and r["qq"]["listErr"] and [i["title"] for i in r["items"]] == ["Older", "Thank You", "Stan"], r["qq"])

# a click
NP._qq_queue(M, 404.0, "123456", "")
sent.clear()
found["Older"] = {"songid": 777, "songmid": "mOld"}
res = NP._qq_action(M, "playAt", 0)
check("a history line is looked up and played", res["ok"] and sent == [("play", 777)], (res, sent))
sent.clear()
res = NP._qq_action(M, "playAt", 3)
check("a play list line is played by its own number, without a search", res["ok"] and sent == [("play", 3)], (res, sent))
sent.clear()
res = NP._qq_action(M, "playAt", 2)
check("the song playing now: nothing is sent", res["ok"] and sent == [])
res = NP._qq_action(M, "playAt", 99)
check("a row that is gone", not res["ok"] and "再点一次" in res["reason"])
found.pop("Older")
res = NP._qq_action(M, "playAt", 0)
check("a song QQ Music does not know is said so", not res["ok"] and "没找到" in res["reason"] and sent == [])

# the heart
found["Stan"] = {"songid": 5, "songmid": "mStan"}
res = NP._qq_action(M, "favorite", 1)
check("the heart: the song now is looked up and its mid sent", res["ok"] and sent == [("fav", "mStan")], (res, sent))
sent.clear()
NP._qq_action(M, "unfavorite", 0)
check("and taken out again", sent == [("unfav", "mStan")])
found.pop("Stan")
sent.clear()
res = NP._qq_action(M, "favorite", 1)
check("a song that is not found cannot be hearted, and nothing is sent", not res["ok"] and sent == [])

for a in ("removeAt", "openAt", "mode"):
    check(f"{a} is not offered for QQ Music", not NP._qq_action(M, a, 0)["ok"])

print("\n" + ("all passed" if not fails else f"{len(fails)} failed: {fails}"))
sys.exit(1 if fails else 0)
