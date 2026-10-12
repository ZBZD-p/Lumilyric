"""
Local helper server for index.html: speech recognition (whisper.cpp) and character-level
alignment (wav2vec2) straight from the page.

Start it with start_server.bat. It listens on 127.0.0.1 only and opens the page in your browser.

API (JSON):
  GET  /api/status                         what is available
  POST /api/upload      raw audio body     -> {id}            (header X-Filename, URL-encoded)
  POST /api/transcribe  {id, lang}         -> whisper.cpp JSON
  POST /api/align       {id, lrc, window, lang?}  -> {lrc, aligned, total, moved, seconds, lang}
  GET  /api/nowplaying/stream?app=  the same, pushed (SSE): event "np" = snapshot, event "bass" = {samples}
  GET  /api/nowplaying?app=   what the desktop player is playing: {ok, app, appName, title, artist, album,
                              duration, position, playing, at, trackId, sessions[]}  (needs setup_nowplaying.bat)
  GET  /api/nowplaying/bass?since=ms  low-frequency level of the system sound {ok, rate, now, samples: [[ms, level]]}
  GET  /api/nowplaying/bass/cut?hz=   what counts as low for that level (40-300 Hz, 140 unless set)
  GET  /api/nowplaying/cover?track=   the player's cover image bytes (404 when none)
  POST /api/nowplaying/lyrics {trackId}    -> {lrc, source, title, verbatim, score} or {lrc: null, reason}
  POST /api/nowplaying/cover/save?track=&side=  raw image body: keep the sharp cover chosen for this song
  POST /api/nowplaying/calibrate {app, trackId, position}  -> {ok}  (players that give no position: Kugou)
  POST /api/nowplaying/control {action: play|pause|next|prev|seek|playAt|removeAt|openAt|mode, position?, app?}
                              -> {ok, reason?}   (QQ 网页跟随 only: playAt / removeAt / openAt, position = the list
                              index; mode, position = list | single | random | order)
  GET  /api/nowplaying/queue?app=     the play list {ok, mode, items: [{title, artist, album, cover, dur, now, vip}]}
                                      (QQ 网页跟随 only)
"""
import faulthandler, json, os, re, shutil, subprocess, sys, threading, time, traceback, uuid, zipfile
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs, unquote, urlparse

HERE = os.path.dirname(os.path.abspath(__file__))     # server/
ROOT = os.path.dirname(HERE)                         # the project folder
WEB = os.path.join(ROOT, "web")                      # the page: index.html, style.css, js/
TMP = os.path.join(ROOT, "tools", "server-tmp")
faulthandler.enable()                            # a native crash leaves a traceback instead of a silent exit
PORT = int(os.environ.get("LRC_PORT", "8765"))
MOCK = os.environ.get("LRC_SERVER_MOCK")          # testing only: fake recognition / alignment
JOB = threading.Lock()                            # one heavy job at a time

sys.path.insert(0, HERE)
import align_lrc as AL                            # noqa: E402
import lddc_bridge as LD                          # noqa: E402
import cover_search as CS                         # noqa: E402
import nowplaying as NP                           # noqa: E402
import audio_level as AUD                         # noqa: E402
import push as PUSH                               # noqa: E402

MODELS = [("ggml-large-v3-q5_0.bin", "large.v3"), ("ggml-large-v3.bin", "large.v3"),
          ("ggml-large-v2-q5_0.bin", "large.v2"), ("ggml-large-v3-turbo-q5_0.bin", "large.v3.turbo")]
BUILDS = [("whisper-cuda", "whisper-cublas-12.4.0-bin-x64.zip", "GPU (CUDA)"),
          ("whisper", "whisper-blas-bin-x64.zip", "CPU")]


# ---------------------------------------------------------------- whisper.cpp
def whisper_cli(unpack=False):
    for folder, zipname, device in BUILDS:
        exe = os.path.join(ROOT, "tools", folder, "whisper-cli.exe")
        if os.path.isfile(exe):
            return exe, device
        z = next((p for p in (os.path.join(ROOT, zipname), os.path.join(ROOT, "tools", zipname)) if os.path.isfile(p)),
                 os.path.join(ROOT, zipname))
        if unpack and os.path.isfile(z):
            tmp = os.path.join(ROOT, "tools", "whisper-tmp")
            shutil.rmtree(tmp, ignore_errors=True)
            with zipfile.ZipFile(z) as zf:
                zf.extractall(tmp)
            shutil.move(os.path.join(tmp, "Release"), os.path.join(ROOT, "tools", folder))
            shutil.rmtree(tmp, ignore_errors=True)
            return exe, device
        if os.path.isfile(z):
            return z, device                      # available, unpacked on first use
    return None, None


def whisper_model_path():
    """(full path, DTW preset) of the best model: models/ first, the project folder as before."""
    for name, preset in MODELS:
        for folder in (os.path.join(ROOT, "models"), ROOT):
            p = os.path.join(folder, name)
            if os.path.isfile(p):
                return p, preset
    return None, None


def whisper_model():
    p, preset = whisper_model_path()
    return (os.path.basename(p) if p else None), preset


def transcribe(wav, lang):
    exe, device = whisper_cli(unpack=True)
    model_path, preset = whisper_model_path()
    model = os.path.basename(model_path) if model_path else None
    if not exe or not model:
        raise RuntimeError("找不到 whisper.cpp 程序或模型文件（模型放在 models 文件夹里）")
    base = os.path.splitext(wav)[0] + ".whisper"
    cmd = [exe, "-m", model_path, "-f", wav, "-l", lang or "auto",
           "-t", str(os.cpu_count() or 4), "-nfa", "--dtw", preset, "-ml", "1", "-sow", "-ojf", "-of", base]
    print("whisper.cpp:", model, device)
    r = subprocess.run(cmd, cwd=os.path.dirname(exe), capture_output=True)
    err = (r.stderr or b"").decode("utf-8", "replace")
    if (r.returncode != 0 or not os.path.isfile(base + ".json")) and device != "CPU" and \
            re.search(r"out of memory|cudaMalloc failed|failed to allocate", err, re.I):
        # the graphics card is busy (video editor, browser, games ...): do it on the CPU instead, slower but it works
        print("GPU memory is full (another program is using it), retrying on the CPU - this takes a few minutes ...")
        r = subprocess.run(cmd + ["-ng"], cwd=os.path.dirname(exe), capture_output=True)
        err = (r.stderr or b"").decode("utf-8", "replace")
    if r.returncode != 0 or not os.path.isfile(base + ".json"):
        tail = err[-600:]
        if re.search(r"out of memory|cudaMalloc failed|failed to allocate", err, re.I):
            raise RuntimeError("显存不够：显卡被别的程序占用了（剪辑软件、浏览器等），关掉一些再试。" + tail[-200:])
        raise RuntimeError("识别失败：" + tail)
    with open(base + ".json", "rb") as f:
        return f.read()


# ---------------------------------------------------------------- audio
def ffmpeg_ok():
    try:
        import imageio_ffmpeg  # noqa: F401
        return True
    except Exception:
        return bool(shutil.which("ffmpeg"))


def to_wav(src, dst):
    """Convert any audio to 16 kHz mono WAV (whisper.cpp and the aligner both read this)."""
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        exe = "ffmpeg"
    subprocess.run([exe, "-v", "error", "-y", "-i", src, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", dst],
                   check=True)


def wav_path(job_id):
    if not job_id or not all(c.isalnum() for c in job_id):
        raise ValueError("bad id")
    p = os.path.join(TMP, job_id + ".wav")
    if not os.path.isfile(p):
        raise ValueError("音频已过期，请重新开始")
    return p


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "LyricsHelper/1.0"

    def log_message(self, fmt, *args):
        req = args[0] if args else ""
        if "/api/" in req and "/api/nowplaying " not in req and "/api/nowplaying?" not in req and "/api/nowplaying/bass" not in req                 and "/api/nowplaying/stream" not in req and "/api/nowplaying/queue" not in req:     # the poll fires ~7 times a second
            sys.stdout.write("%s  %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def stream(self, app):
        """Server-Sent Events: `np` = the nowplaying snapshot (when something changed, and every 2 s as a heartbeat),
        `bass` = new live low-frequency samples. The page extrapolates the position itself, so nothing needs asking."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        w = self.wfile

        def ev(name, obj):
            w.write(f"event: {name}\ndata: {json.dumps(obj, ensure_ascii=False)}\n\n".encode("utf-8"))
            w.flush()
        try:
            w.write(b"retry: 1000\n\n")
            ok = AUD.available()
            ev("bass", {"ok": ok, "rate": AUD.RATE, "reason": "" if ok else "没有安装声音采集组件，运行 scripts\\setup_nowplaying.bat 后重启"})
            np_seen, since, last = -1, 0, 0.0
            while True:
                v, nv, now = PUSH.total(), PUSH.version("np"), time.time()
                if nv != np_seen or now - last >= 2:
                    try:
                        snap = NP.snapshot(app)
                    except Exception as e:                 # never let one bad snapshot end the stream
                        snap = {"ok": False, "reason": f"{type(e).__name__}: {e}"[:160]}
                    ev("np", snap)
                    last, np_seen = now, nv
                if ok:
                    smp = AUD.samples(since)                  # also keeps the capture running while someone listens
                    if smp:
                        since = smp[-1][0]
                        ev("bass", {"ok": True, "samples": smp})
                PUSH.wait(v, 0.02 if AUD.MOCK else 1.0)
                time.sleep(0.012)                             # coalesce bursts of 10 ms blocks
        except (BrokenPipeError, ConnectionError, OSError):
            return

    # -- static files
    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path == "/api/status":
            exe, device = whisper_cli()
            model, _ = whisper_model()
            try:
                import torch  # noqa: F401
                align_ok = True
            except Exception:
                align_ok = bool(MOCK)
            return self.send(200, {"ok": True, "whisper": bool(exe and model) or bool(MOCK),
                                   "whisperModel": model, "device": device, "align": align_ok, "mock": bool(MOCK),
                                   "ffmpeg": ffmpeg_ok() or bool(MOCK),
                                   "whisperExe": bool(exe), "whisperHasModel": bool(model),
                                   "lddc": LD.available(), "nowplaying": NP.available(), "loopback": AUD.available(),
                                   # the packed desktop version (desktop\build.py): no scripts\ folder to point at
                                   "desktop": os.path.isdir(os.path.join(ROOT, "runtime"))})
        if path == "/api/nowplaying":                  # what the desktop player is playing (never a 500)
            try:
                app = (parse_qs(urlparse(self.path).query).get("app") or [""])[0]
                return self.send(200, NP.snapshot(app))
            except Exception as e:
                return self.send(200, {"ok": False, "reason": f"{type(e).__name__}: {e}"[:200]})
        if path == "/api/nowplaying/stream":           # server push (SSE): song state when it changes, bass level as it arrives
            return self.stream((parse_qs(urlparse(self.path).query).get("app") or [""])[0])
        if path == "/api/nowplaying/queue":            # the followed player's play list (QQ 网页跟随 only), for the AM layout
            try:
                return self.send(200, NP.queue((parse_qs(urlparse(self.path).query).get("app") or [""])[0]))
            except Exception as e:
                return self.send(200, {"ok": False, "reason": f"{type(e).__name__}: {e}"[:200]})
        if path == "/api/nowplaying/bass":             # live low-frequency level of the system sound, for the pulse
            if not AUD.available():
                return self.send(200, {"ok": False, "reason": "没有安装声音采集组件，运行 scripts\\setup_nowplaying.bat 后重启"})
            since = int((parse_qs(urlparse(self.path).query).get("since") or ["0"])[0] or 0)
            return self.send(200, {"ok": True, "rate": AUD.RATE, "now": int(time.time() * 1000),
                                   "samples": AUD.samples(since), "reason": AUD.reason()})
        if path == "/api/nowplaying/bass/cut":         # the page's 低音范围 setting: what counts as bass, in Hz
            try:
                return self.send(200, {"ok": True, "hz": AUD.set_cut((parse_qs(urlparse(self.path).query).get("hz") or ["140"])[0])})
            except ValueError:
                return self.send(400, {"error": "hz"})
        if path == "/api/nowplaying/cover":
            c = NP.cover((parse_qs(urlparse(self.path).query).get("track") or [""])[0])
            return self.send(200, c[0], c[1]) if c else self.send(404, {"error": "no cover"})
        if path == "/api/cover/img":                   # album cover, fetched here so the page has no cross-site issues
            try:
                url = (parse_qs(urlparse(self.path).query).get("u") or [""])[0]
                data, ctype = CS.fetch_image(url)
                return self.send(200, data, ctype)
            except Exception as e:
                return self.send(502, {"error": str(e)})
        if path == "/api/cover/motion":                # the moving cover of an Apple Music album, as an MP4 file
            try:
                q = parse_qs(urlparse(self.path).query)
                data = CS.fetch_motion((q.get("id") or [""])[0], (q.get("cc") or [""])[0])
                return self.send(200, data, "video/mp4") if data else self.send(404, {"error": "这张专辑没有动态封面"})
            except Exception as e:
                return self.send(502, {"error": str(e)})
        # the page and its files, from web/ only
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        full = os.path.normpath(os.path.join(WEB, rel))
        if not full.startswith(WEB + os.sep) or not os.path.isfile(full):
            return self.send(404, {"error": "not found"})
        ctype = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
                 ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml",
                 ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2"}.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        with open(full, "rb") as f:
            self.send(200, f.read(), ctype)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/nowplaying/cover/save":       # raw image body: the sharp cover the page chose for a song
                q = parse_qs(urlparse(self.path).query)
                data = self.body()
                side = int((q.get("side") or ["0"])[0] or 0)
                ok = NP.save_cover((q.get("track") or [""])[0], data, self.headers.get("Content-Type") or "image/jpeg", side)
                return self.send(200, {"ok": bool(ok)})

            if path == "/api/upload":
                os.makedirs(TMP, exist_ok=True)
                name = unquote(self.headers.get("X-Filename") or "audio")
                ext = os.path.splitext(name)[1].lower()[:8] or ".bin"
                job = uuid.uuid4().hex[:12]
                src = os.path.join(TMP, job + "-src" + ext)
                with open(src, "wb") as f:
                    f.write(self.body())
                if not ffmpeg_ok():
                    os.remove(src)
                    return self.send(400, {"error": "还没有安装音频转换组件，先运行 scripts 文件夹里的 setup_whisper.bat 或 setup_align.bat"})
                to_wav(src, os.path.join(TMP, job + ".wav"))
                os.remove(src)
                print("audio received:", name)
                return self.send(200, {"id": job})

            req = json.loads(self.body() or b"{}")
            if path == "/api/transcribe":
                wav = wav_path(req.get("id"))
                with JOB:
                    t0 = time.time()
                    if MOCK:
                        with open(os.environ["LRC_MOCK_WHISPER"], "rb") as f:
                            data = f.read()
                    else:
                        data = transcribe(wav, req.get("lang") or "auto")
                    print(f"recognised in {time.time() - t0:.0f} s")
                return self.send(200, data)

            if path == "/api/align":
                wav = wav_path(req.get("id"))
                lrc = req.get("lrc") or ""
                with JOB:
                    if MOCK:
                        meta, lines = AL.parse_lrc(lrc)
                        for L in lines:
                            n = len(AL.tokens(L["en"] or L["zh"]))
                            L["wt"] = [(L["t"] + 0.25 * k, L["t"] + 0.25 * k + 0.2) for k in range(n)]
                        out, st = AL.word_lrc_text(meta, lines), {"aligned": sum(len(L["wt"]) for L in lines), "total": sum(len(L["wt"]) for L in lines), "moved": 0, "seconds": 0, "lang": AL.detect_lang(lines) if lines else "zh"}
                    else:
                        audio = AL.load_audio(wav)
                        out, st = AL.align_lrc_text(audio, lrc, float(req.get("window") or 3.0), lang=req.get("lang") or "auto")
                    print(f"aligned {st['aligned']}/{st['total']} {'characters' if st['lang'] == 'zh' else 'words'} in {st['seconds']} s")
                return self.send(200, {"lrc": out, **st})

            if path == "/api/lyrics/search":           # QQ Music / Kugou / NetEase through LDDC
                if not LD.available():
                    return self.send(400, {"error": "还没有安装 LDDC，先运行 scripts 文件夹里的 setup_lddc.bat"})
                q = (req.get("q") or "").strip()
                if not q:
                    return self.send(400, {"error": "empty"})
                res = LD.search_all(q)
                print(f"lyrics search '{q}': {len(res['items'])} results" + (f", failed: {', '.join(res['errors'])}" if res["errors"] else ""))
                return self.send(200, res)

            if path == "/api/cover/search":
                q = (req.get("q") or "").strip()
                if not q:
                    return self.send(400, {"error": "empty"})
                res = CS.search_covers(q)
                print(f"cover search '{q}': {len(res['items'])} results" + (f", failed: {', '.join(res['errors'])}" if res["errors"] else ""))
                return self.send(200, res)

            if path == "/api/lyrics/get":
                res = LD.get_lrc(req.get("token"))
                print(f"lyrics from {res['source']}: {res['title']} ({'word-by-word' if res['verbatim'] else 'line-by-line'})")
                return self.send(200, res)

            if path == "/api/nowplaying/lyrics":
                res = NP.pick_lyrics(str(req.get("trackId") or ""))
                print("player lyrics:", f"{res['source']} {res['title']} score {res['score']:.0f}" if res.get("lrc") else res.get("reason"))
                return self.send(200, res)

            if path == "/api/nowplaying/calibrate":
                return self.send(200, NP.calibrate(req.get("app") or "", str(req.get("trackId") or ""), req.get("position") or 0))

            if path == "/api/nowplaying/control":
                return self.send(200, NP.control(req.get("action"), req.get("position"), req.get("app") or ""))

            return self.send(404, {"error": "not found"})
        except Exception as e:
            traceback.print_exc()
            return self.send(500, {"error": str(e)})


def main():
    shutil.rmtree(TMP, ignore_errors=True)           # old uploads from previous runs
    os.makedirs(TMP, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    exe, device = whisper_cli()
    model, _ = whisper_model()
    print(f"Lyrics helper running at http://127.0.0.1:{PORT}/   (close this window to stop)")
    try:
        import torch  # noqa: F401
        align_ok = True
    except Exception:
        align_ok = False
    print("  recognition: " + (f"{model} on {device}" if (exe and model) else "not installed (optional: run scripts\setup_whisper.bat)"))
    print("  alignment:   " + ("wav2vec2, Chinese or English model picked from the lyrics (loaded on first use)" if align_ok
                               else "not installed (optional: run scripts\setup_align.bat)"))
    print("  lyrics:      " + ("LDDC (QQ Music / Kugou / NetEase)" if LD.available() else "LDDC not installed (run scripts\\setup_lddc.bat to search QQ Music / Kugou / NetEase)"))
    if NP.available():
        NP.start()
        print("  player sync: on (" + ("mock" if NP.MOCK else "SMTC") + ")")
    else:
        print("  player sync: not installed (run scripts\\setup_nowplaying.bat)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
