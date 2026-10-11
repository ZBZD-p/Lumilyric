"""Scoring of lyric search results (lyrics_match.score_item). Run: python tests/test_lyrics_match.py"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
from lyrics_match import MIN_SCORE, clean_title, score_item  # noqa: E402

fails = []


def check(name, cond, info=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else "  " + str(info)))
    if not cond:
        fails.append(name)


def it(title, artist, dur, source="QQ音乐"):
    return {"title": title, "artist": artist, "duration": dur, "source": source}


check("clean_title", clean_title("七里香 (Live) - 电影《x》插曲") == "七里香", clean_title("七里香 (Live) - 电影《x》插曲"))
right = it("Die For You", "The Weeknd", 259)
wrong = it("After Hours", "The Weeknd", 361)
# the player still reports the previous song's length: the wrong song must not win
s_right, s_wrong = (score_item(x, "Die For You", "The Weeknd", 361.0, "QQ音乐") for x in (right, wrong))
check("stale length: wrong song stays under the threshold", s_wrong < MIN_SCORE, s_wrong)
check("unknown length: right song passes", score_item(right, "Die For You", "The Weeknd", 0, "QQ音乐") >= MIN_SCORE)
check("known length: right song passes with room", score_item(right, "Die For You", "The Weeknd", 259, "QQ音乐") > 90)
check("right beats wrong whenever the length is right", score_item(right, "Die For You", "The Weeknd", 259, "") >
      score_item(wrong, "Die For You", "The Weeknd", 259, ""))
check("live version of the same title scores lower than the studio one by length",
      score_item(it("七里香 (Live)", "周杰伦", 302), "七里香", "周杰伦", 299, "") <
      score_item(it("七里香", "周杰伦", 299), "七里香", "周杰伦", 299, ""))
check("other artist, same title, is weak", score_item(it("七里香", "Xai小爱", 317), "七里香", "周杰伦", 299, "") < MIN_SCORE)
check("title with feat. still matches", score_item(it("Song", "A", 200), "Song (feat. B)", "A", 200, "") >= MIN_SCORE)

print("\n%d failed" % len(fails) if fails else "\nall passed")
sys.exit(1 if fails else 0)
