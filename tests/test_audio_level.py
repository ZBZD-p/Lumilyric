"""The bass level without numpy (server/audio_level.py: level) against the numpy version it replaced.
Run: tools\align-env\Scripts\python.exe tests\test_audio_level.py"""
import math
import os
import random
import struct
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
os.environ["LRC_NOWPLAYING_MOCK"] = "1"
import audio_level as A  # noqa: E402

fails = 0


def check(name, ok, extra=""):
    global fails
    fails += 0 if ok else 1
    print(("ok   " if ok else "FAIL ") + name + ("   " + extra if extra else ""))


def old_level(np, data, ch, k, a, st):
    """What audio_level.py did with numpy, word for word."""
    x = np.frombuffer(data, dtype=np.float32)
    if ch > 1:
        x = x[: len(x) // ch * ch].reshape(-1, ch).mean(axis=1)
    n = len(x) // k
    if not n:
        return None
    d = x[: n * k].reshape(n, k).mean(axis=1)
    y1, y2, acc = st["y1"], st["y2"], 0.0
    for v in d.tolist():
        y1 = (1 - a) * v + a * y1
        y2 = (1 - a) * y1 + a * y2
        acc += y2 * y2
    st["y1"], st["y2"] = y1, y2
    return math.sqrt(acc / n)


def signal(rate, ch, frames, t0, rnd):
    out = []
    for i in range(frames):
        t = (t0 + i) / rate
        kick = math.sin(2 * math.pi * 60 * t) * math.exp(-((t * 2) % 1.0) * 9) * 0.6      # 120 BPM, 60 Hz
        for c in range(ch):
            out.append(kick + 0.2 * math.sin(2 * math.pi * 3000 * t + c) + rnd.uniform(-0.05, 0.05))
    return struct.pack("<%df" % len(out), *out)


# 1. a 60 Hz tone gets through, a 3 kHz tone does not
for hz, want in ((60, "loud"), (3000, "quiet")):
    rate, ch = 48000, 2
    k = rate // 1000
    a = math.exp(-2 * math.pi * 140 / (rate / k))
    st, v = {"y1": 0.0, "y2": 0.0}, 0
    for b in range(30):
        fr = [0.5 * math.sin(2 * math.pi * hz * (b * 480 + i) / rate) for i in range(480) for _ in range(ch)]
        v = A.level(struct.pack("<%df" % len(fr), *fr), ch, k, a, st)
    check(f"{hz} Hz tone is {want}", (v > 0.2) if want == "loud" else (v < 0.01), f"level {v:.4f}")

# 2. short and ragged blocks
st = {"y1": 0.0, "y2": 0.0}
check("a block shorter than k frames gives None", A.level(b"\0" * 4 * 2 * 10, 2, 48, 0.4, st) is None)
check("a block cut in the middle of a frame is accepted", A.level(b"\0" * (4 * 2 * 480 + 3), 2, 48, 0.4, st) == 0.0)

# 3. same numbers as the numpy version, block after block (state carried along)
try:
    import numpy as np
except ImportError:
    np = None
if np is None:
    print("skip the comparison with numpy (numpy is not installed)")
else:
    for rate, ch, frames in ((48000, 2, 480), (44100, 2, 441), (48000, 1, 480), (96000, 6, 1000), (48000, 2, 500)):
        k = max(1, rate // 1000)
        a = math.exp(-2 * math.pi * 140 / (rate / k))
        s1, s2 = {"y1": 0.0, "y2": 0.0}, {"y1": 0.0, "y2": 0.0}
        rnd, worst, peak = random.Random(rate + ch), 0.0, 0.0
        for b in range(200):
            data = signal(rate, ch, frames, b * frames, rnd)
            v1, v2 = A.level(data, ch, k, a, s1), old_level(np, data, ch, k, a, s2)
            worst, peak = max(worst, abs(v1 - v2)), max(peak, v2)
        check(f"{rate} Hz {ch} ch {frames} frames: same as numpy", worst < 2e-6 and peak > 0.05, f"largest difference {worst:.1e}, peak {peak:.3f}")

# 4. fast enough: one second of 48 kHz stereo must take a small part of a second
rate, ch = 48000, 2
k = rate // 1000
a = math.exp(-2 * math.pi * 140 / (rate / k))
data = signal(rate, ch, 480, 0, random.Random(1))
st = {"y1": 0.0, "y2": 0.0}
t0 = time.perf_counter()
for _ in range(1000):                       # 10 s of audio
    A.level(data, ch, k, a, st)
per_sec = (time.perf_counter() - t0) / 10
check("cost per second of audio is under 2 % of a core", per_sec < 0.02, f"{per_sec * 1000:.1f} ms")

print("\n%d problems" % fails if fails else "\nall passed")
sys.exit(1 if fails else 0)
