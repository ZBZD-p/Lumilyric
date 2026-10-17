"""The music accounts (server/music_apis.py) and what the followed player's star and list do with them
(server/nowplaying.py), with the three services replaced: nothing is started, nothing is asked of the web.
Run: python tests/test_music_apis.py"""
import os
import sys
import tempfile

os.environ["LRC_MUSIC_API_DIR"] = tempfile.mkdtemp(prefix="lrc-music-")          # no accounts file of the real one
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
import music_apis as A  # noqa: E402
import nowplaying as NP  # noqa: E402

fails = []


def check(name, cond, info=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else "  " + str(info)))
    if not cond:
        fails.append(name)


check("players map to their services", [A.service_of(x) for x in ("QQMusic.exe", "cloudmusic.exe", "kugou", "Spotify.exe", "")] == ["qq", "netease", "kugou", "", ""])
check("the QQ web window is not QQ Music's account (it has none here)", A.service_of("qqweb.web") == "")

# songs as each service writes them
q = A.norm_song("qq", {"id": 102068226, "mid": "004DHzIW41tmSi", "name": "七楼", "singer": [{"name": "陈粒"}], "album": {"name": "如也", "mid": "ALB"}, "interval": 189})
check("a QQ song", q["id"] == 102068226 and q["mid"] == "004DHzIW41tmSi" and q["singers"] == ["陈粒"] and q["album"] == "如也" and q["interval"] == 189 and q["cover"].endswith("M000ALB.jpg"), q)
n = A.norm_song("netease", {"id": 17572422, "name": "Stan", "ar": [{"name": "Eminem"}, {"name": "Dido"}], "al": {"name": "MMLP", "picUrl": "http://p3/x.jpg"}, "dt": 404066})
check("a NetEase song (its length in ms)", n["id"] == 17572422 and n["singers"] == ["Eminem", "Dido"] and n["interval"] == 404 and n["cover"].startswith("http://p3/x.jpg?param=150"), n)
nr = A.norm_song("netease", {"playTime": 1, "data": {"id": 5, "name": "In Record", "ar": [{"name": "X"}], "al": {}, "dt": 1000}})
check("a NetEase play record (the song inside it)", nr["id"] == 5 and nr["name"] == "In Record", nr)
k1 = A.norm_song("kugou", {"SongName": "Stan", "SingerName": "Eminem、Dido", "Duration": 405, "FileHash": "a4a9", "AlbumID": "530084", "MixSongID": "27617886", "Image": "http://imge/{size}/x.jpg"})
check("a KuGou search result", k1["name"] == "Stan" and k1["singers"] == ["Eminem", "Dido"] and k1["hash"] == "A4A9" and k1["interval"] == 405 and k1["cover"] == "http://imge/150/x.jpg", k1)
k2 = A.norm_song("kugou", {"name": "Eminem、Dido - Stan", "hash": "a4a9", "timelen": 405000, "fileid": 77, "album_id": 1, "mixsongid": 2})
check("a KuGou list line: 'artist - title' in one name, length in ms", k2["name"] == "Stan" and k2["singers"] == ["Eminem", "Dido"] and k2["interval"] == 405 and k2["fileid"] == 77, k2)
nested = {"code": 200, "data": {"info": {"x": 1}, "songlist": [{"mid": "a", "name": "A"}, {"mid": "b", "name": "B"}]}}
check("the longest list of songs is found wherever the answer puts it", A._songs_in(nested)[0] == nested["data"]["songlist"])

# the accounts file: kept encrypted for this Windows user, read back the same
A._JARS.clear()
A._load()
A._JARS["netease"].set_cookie(A._make_cookie("netease", "MUSIC_U", "secret-value"))
A._save()
raw = open(A.ACCOUNTS, "rb").read()
check("the accounts file holds no cookie in the clear", b"secret-value" not in raw and b"MUSIC_U" not in raw)
A._JARS.clear()
A._load()
check("and gives it back", any(c.name == "MUSIC_U" and c.value == "secret-value" for c in A._JARS["netease"]))
A._JARS["netease"].clear()
A._save()
check("an account never signed in is not asked for (its service is not even started)", A.user("kugou") is None)

# the star and the list, through stubbed services
users = {"netease": {"name": "我", "id": "1"}}
liked = {"netease": {17572422}}
A.user = lambda svc, fresh=False: users.get(svc)
A.find = lambda svc, title, artist, dur=0: {"id": 17572422, "name": title, "singers": ["Eminem"], "album": "", "interval": 404, "cover": "", "hash": "", "mid": ""} if title == "Stan" else None
A.is_liked = lambda svc, song: (song["id"] in liked.get(svc, set())) if users.get(svc) else None
sets = []


def set_liked(svc, song, on):
    sets.append((svc, song["id"], on))
    (liked.setdefault(svc, set()).add if on else liked.setdefault(svc, set()).discard)(song["id"])
    return True, on, ""


A.set_liked = set_liked
A.recent_songs = lambda svc, limit=50: [A.norm_song("netease", {"id": 9, "name": "Older", "ar": [{"name": "Y"}], "al": {}, "dt": 1000}),
                                         A.norm_song("netease", {"id": 17572422, "name": "Stan", "ar": [{"name": "Eminem"}], "al": {}, "dt": 404000})]
A.liked_songs = lambda svc, limit=200: [A.norm_song("netease", {"id": 17572422, "name": "Stan", "ar": [{"name": "Eminem"}], "al": {}, "dt": 404000}),
                                        A.norm_song("netease", {"id": 11, "name": "Loved", "ar": [{"name": "Z"}], "al": {}, "dt": 1000})]
M = {"app": "cloudmusic.exe", "title": "Stan", "artist": "Eminem", "album": "MMLP", "tid": "t1"}
r = NP._acct_queue(M, 404, "netease")
titles = [i["title"] for i in r["items"]]
check("NetEase list: played lately (without the song now), the song now, then the liked ones (without it)", titles == ["Older", "Stan", "Loved"] and [i["now"] for i in r["items"]] == [False, True, False], titles)
check("it says whose account it is", r["acct"]["signedIn"] and r["acct"]["user"] == "我" and r["acct"]["name"] == "网易云音乐", r["acct"])
res = NP._acct_like(M, "netease", False)
check("the star takes it out, and says what the service says now", res["ok"] and res["liked"] is False and sets[-1] == ("netease", 17572422, False), res)
res = NP._acct_like(M, "netease", True)
check("and puts it back", res["ok"] and res["liked"] is True)
res = NP._acct_like(dict(M, title="Nowhere", tid="t2"), "netease", True)
check("a song the service does not have cannot be hearted", not res["ok"] and "没找到" in res["reason"])
res = NP._acct_like(dict(M, app="kugou", tid="t3"), "kugou", True)
check("an account not signed in says so", not res["ok"] and "登录" in res["reason"] and res["liked"] is None)
r = NP._acct_queue(dict(M, app="kugou"), 404, "kugou")
check("not signed in: the list is the song now only, and says how to sign in", [i["now"] for i in r["items"]] == [True] and r["acct"]["signedIn"] is False)

print("\n" + ("all passed" if not fails else f"{len(fails)} failed: {fails}"))
sys.exit(1 if fails else 0)
