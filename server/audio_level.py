"""
Live low-frequency level of whatever the PC is playing, for the page's background pulse while it follows a
player (there is no audio file to analyse then).

Uses WASAPI loopback through PyAudioWPatch (about 100 KB, installed by setup_nowplaying.bat); the arithmetic is
plain Python (array + sum), no numpy. Only a number per 10 ms is computed (the loudness below CUT, ~140 Hz unless the page sets another); no audio is stored or sent anywhere. Capture runs only
while the page asks for it and stops 15 s after the last request.

LRC_NOWPLAYING_MOCK=1 synthesises a 120 BPM kick instead.
"""
import array
import collections
import importlib.util
import math
import os
import sys
import threading
import time

import push

MOCK = bool(os.environ.get("LRC_NOWPLAYING_MOCK"))
RATE = 100                              # values per second
CUT = 140.0                             # Hz: what counts as bass (the page's 低音范围 setting, set_cut)
IDLE_STOP = 15.0
_buf = collections.deque(maxlen=RATE * 6)      # (wall ms, level)
_lock = threading.Lock()
_last_req = 0.0
_thread = None
_reason = ""


def set_cut(hz):
    """What counts as bass: everything below hz. Takes effect at once, also while capturing."""
    global CUT
    CUT = min(300.0, max(40.0, float(hz)))
    return CUT


def available():
    if MOCK:
        return True
    if sys.platform != "win32":
        return False
    try:
        return importlib.util.find_spec("pyaudiowpatch") is not None
    except Exception:
        return False


def _loopback(pa, p):
    w = p.get_host_api_info_by_type(pa.paWASAPI)
    spk = p.get_device_info_by_index(w["defaultOutputDevice"])
    if not spk.get("isLoopbackDevice"):
        for lb in p.get_loopback_device_info_generator():
            if spk["name"] in lb["name"]:
                return lb
        raise RuntimeError("找不到输出设备的回环采集")
    return spk


def level(data, ch, k, a, st):
    """Loudness below the cut-off of one block of float32 frames (interleaved, ch channels), or None when the
    block is shorter than k frames. Channels are mixed, k frames averaged into one value (down to ~1 kHz), then two
    one-pole low-passes with coefficient a; st carries the filter state from block to block."""
    x = array.array("f")
    x.frombytes(data[: len(data) // (4 * ch) * (4 * ch)])
    n = len(x) // ch // k
    if not n:
        return None
    y1, y2, acc, w = st["y1"], st["y2"], 0.0, k * ch
    for i in range(n):
        v = sum(x[i * w:(i + 1) * w]) / w
        y1 = (1 - a) * v + a * y1
        y2 = (1 - a) * y1 + a * y2
        acc += y2 * y2
    st["y1"], st["y2"] = y1, y2
    return math.sqrt(acc / n)


def _capture():
    global _reason
    import pyaudiowpatch as pa
    p = pa.PyAudio()
    stream = None
    try:
        dev = _loopback(pa, p)
        ch, rate = int(dev["maxInputChannels"]), int(dev["defaultSampleRate"])
        k = max(1, rate // 1000)                    # block-average down to ~1 kHz, then two one-pole low-passes
        st = {"y1": 0.0, "y2": 0.0}

        def cb(data, frames, ti, status):
            v = level(data, ch, k, math.exp(-2 * math.pi * CUT / (rate / k)), st)      # CUT may change while capturing
            if v is not None:
                with _lock:
                    _buf.append((int(time.time() * 1000), round(v, 5)))
                push.notify("bass")
            return (None, pa.paContinue)

        stream = p.open(format=pa.paFloat32, channels=ch, rate=rate, input=True, input_device_index=dev["index"],
                        frames_per_buffer=max(64, rate // RATE), stream_callback=cb)
        _reason = ""
        name = dev["name"]
        t_check = time.time()
        while time.time() - _last_req < IDLE_STOP:
            time.sleep(0.2)
            if time.time() - t_check > 2:           # the default output changed (headphones plugged in ...)
                t_check = time.time()
                if _loopback(pa, p)["name"] != name:
                    break
    finally:
        try:
            if stream:
                stream.stop_stream()
                stream.close()
        except Exception:
            pass
        p.terminate()


def _run():
    global _thread, _reason
    try:
        while time.time() - _last_req < IDLE_STOP:
            try:
                _capture()
            except Exception as e:
                _reason = f"{type(e).__name__}: {e}"[:160]
                time.sleep(2)
    finally:
        _thread = None


def samples(since_ms=0):
    """[[wall ms, level], ...] newer than since_ms; starts the capture when needed."""
    global _last_req, _thread
    _last_req = time.time()
    if MOCK:
        now = int(time.time() * 1000)
        t0 = max(int(since_ms) + 1, now - 600)
        out = []
        for t in range(t0 - t0 % 10 + 10, now + 1, 10):
            ph = (t / 1000 * 2) % 1.0                 # 120 BPM
            out.append([t, round(0.02 + 0.3 * math.exp(-ph * 9), 5)])
        return out
    if _thread is None and available():
        _thread = threading.Thread(target=_run, name="audio-level", daemon=True)
        _thread.start()
    with _lock:
        return [[t, v] for t, v in _buf if t > since_ms]


def reason():
    return _reason
