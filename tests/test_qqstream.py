"""A QQ Music song's file coming in while it is played (server/music_apis.py Song, qq_song), against a stand-in source on
this computer that sends a made-up file slowly. Nothing is asked of QQ Music. Run: python tests/test_qqstream.py"""
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ["LRC_MUSIC_API_DIR"] = tempfile.mkdtemp(prefix="lrc-qqstream-")          # never the real music accounts
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
import music_apis as A  # noqa: E402

fails = []


def check(name, cond, info=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else "  " + str(info)))
    if not cond:
        fails.append(name)


DATA = bytes(range(256)) * 2048                        # 512 KB
PAUSE = 0.05                                           # between pieces of 64 KB: the whole file takes about 0.4 s
fetched = []


class Source(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        fetched.append(self.path)
        body = DATA[:100_000] if self.path.startswith("/short") else DATA
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(DATA)))      # /short: says more than it sends (a download cut off)
        self.end_headers()
        for i in range(0, len(body), 65536):
            self.wfile.write(body[i:i + 65536])
            self.wfile.flush()
            time.sleep(PAUSE)


srv = ThreadingHTTPServer(("127.0.0.1", 0), Source)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_port}"

# one song: its first bytes can be read long before the whole of it is here, and all of it comes out the same
s = A.Song("x|high", "320", False, "audio/mpeg")
t0 = time.time()
threading.Thread(target=s._fill, args=(base + "/song",), daemon=True).start()
check("its length is known as soon as the source says it", s.size() == len(DATA), s.total)
first = s.read(0, 4096)
t_first = time.time() - t0
check("the first bytes come before the rest", first == DATA[:4096] and t_first < 0.3 and not s.done, (t_first, s.done))
tail = s.read(len(DATA) - 1000, 1000)
check("a later range waits for its bytes, then has them", tail == DATA[-1000:], len(tail))
out, pos = bytearray(), 0
while True:
    part = s.read(pos, 65536)
    if not part:
        break
    out += part
    pos += len(part)
check("all of it, in order", bytes(out) == DATA and s.done and not s.err, (len(out), s.err))

# a download cut off: what came is all there is, and it is told
c = A.Song("y|high", "320", False, "audio/mpeg")
c._fill(base + "/short")
check("cut short: its length becomes what came", c.done and c.total == 100_000 and c.size() == 100_000, (c.total, c.err))
check("reading past it ends instead of waiting", c.read(200_000, 10, wait=1) == b"")

# the songs kept: the same one again is not fetched again; the oldest go beyond SONG_KEEP; another quality is another file
A._SONGS.clear()
urls = {}
A.qq_audio_url = lambda mid, pref="high": (urls.setdefault((mid, pref), f"{base}/{mid}/{pref}"), {"standard": "128", "high": "320", "lossless": "flac"}[pref], False)
fetched.clear()
a1 = A.qq_song("songA0001", "high")
a2 = A.qq_song("songA0001", "high")
check("asked again: the same file, not fetched again", a1 is a2)
check("its type follows the quality", A.qq_song("songA0001", "lossless").ctype == "audio/flac" and a1.ctype == "audio/mpeg")
for k in range(A.SONG_KEEP + 1):
    A.qq_song(f"songB000{k}", "high")
check("only the last SONG_KEEP stay", len(A._SONGS) == A.SONG_KEEP and "songA0001|high" not in A._SONGS, list(A._SONGS))
prev = list(A._SONGS)[0]
A.qq_song(prev.split("|")[0], "high")
check("one asked for again becomes the newest (going back to the one before keeps it)", list(A._SONGS)[-1] == prev)
check("an unknown quality is the high one", A.qq_song("songB0004", "weird").key == "songB0004|high")
bad = A.Song("songC0001|high", "320", False, "audio/mpeg")
bad.err = "下载这首歌失败"
A._SONGS["songC0001|high"] = bad
check("one that broke off is fetched again", A.qq_song("songC0001", "high") is not bad)
check("a song number that is no song number is refused before anything is asked", A._MID.match("../../x") is None)

time.sleep(1)
srv.shutdown()
print("\n" + ("all passed" if not fails else f"{len(fails)} failed: {fails}"))
sys.exit(1 if fails else 0)
