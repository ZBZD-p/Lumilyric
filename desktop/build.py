"""
Builds the desktop version: a folder that runs on a PC without Python installed.

    tools\\align-env\\Scripts\\python.exe desktop\\build.py          (or double-click scripts\\build_desktop.bat)

Result: dist\\Lumilyric\\
    Lumilyric.exe      double-click to start (no black window)
    runtime\\              Python 3.11 (the official "embeddable" build) and the libraries, private to this folder
    server\\  web\\         the same code the browser version runs
    desktop\\app.py        opens the window (WebView2, the Edge engine that comes with Windows)
    tools\\                made while it runs: cache, log, window settings
and dist\\Lumilyric.zip, the same thing packed.

Only the base features go in (the page, export, lyrics library and search, follow the player). Not Qt, not
numpy, not PyTorch, not Whisper.

Downloads:
    python-3.11.9-embed-amd64.zip   python.org (checked against PY_SHA256), 11 MB, kept in tools\\build-cache
    the libraries in PACKAGES       PyPI, Tsinghua mirror first
    LDDC                            GitHub; when that fails, the copy already installed in this environment
"""
import hashlib
import importlib.util
import os
import shutil
import struct
import time
import subprocess
import sys
import urllib.request
import zipfile
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(ROOT, "tools", "build-cache")
OUT = os.path.join(ROOT, "dist", "Lumilyric")

PY_VER = "3.11.9"
PY_ZIP = f"python-{PY_VER}-embed-amd64.zip"
PY_URLS = [f"https://www.python.org/ftp/python/{PY_VER}/{PY_ZIP}",
           f"https://registry.npmmirror.com/-/binary/python/{PY_VER}/{PY_ZIP}"]
PY_SHA256 = "009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b"

LDDC_URL = "https://github.com/chenmozhijin/LDDC/archive/refs/tags/v0.9.2.zip"
# what LDDC's lyrics core needs (its own list also has pyside6-essentials: replaced by server/qt_stub), the
# player reader, the loopback capture and the window
PACKAGES = ["httpx[brotli,http2]", "diskcache", "pyaes", "charset-normalizer", "mutagen", "psutil",
            "winrt-runtime", "winrt-Windows.Media.Control", "winrt-Windows.Storage.Streams",
            "winrt-Windows.Foundation", "winrt-Windows.Foundation.Collections",
            "PyAudioWPatch", "pywebview"]
INDEXES = ["https://pypi.tuna.tsinghua.edu.cn/simple", "https://mirrors.aliyun.com/pypi/simple/", "https://pypi.org/simple"]
# installed along but never imported here
UNUSED = ["LDDC/gui", "LDDC/res/resource_rc.py", "bin", "pip", "setuptools", "wheel", "_distutils_hack",
          "webview/lib/android", "webview/platforms/android", "webview/js/lib/polyfill.js.map"]
CSC = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")


def say(*a):
    print(*a, flush=True)


def size_mb(path):
    if os.path.isfile(path):
        return os.path.getsize(path) / 1048576
    return sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(path) for f in fs) / 1048576


# ---------------------------------------------------------------- Python itself
def get_python():
    os.makedirs(CACHE, exist_ok=True)
    z = os.path.join(CACHE, PY_ZIP)
    if not os.path.isfile(z):
        for url in PY_URLS:
            try:
                say("  downloading", url)
                with urllib.request.urlopen(url, timeout=60) as r:
                    data = r.read()
                if hashlib.sha256(data).hexdigest() != PY_SHA256:
                    say("  wrong checksum, not used")
                    continue
                with open(z + ".part", "wb") as f:
                    f.write(data)
                os.replace(z + ".part", z)
                break
            except Exception as e:
                say("  failed:", e)
    if not os.path.isfile(z):
        raise SystemExit("Could not download " + PY_ZIP)
    with open(z, "rb") as f:
        if hashlib.sha256(f.read()).hexdigest() != PY_SHA256:
            raise SystemExit(z + " is damaged: delete it and build again")
    rt = os.path.join(OUT, "runtime")
    with zipfile.ZipFile(z) as zf:
        zf.extractall(rt)
    # the search path of the embedded Python: its own library, the libraries, the server code. Nothing from the
    # PC's own Python, no environment variables.
    with open(os.path.join(rt, "python311._pth"), "w", encoding="ascii", newline="\r\n") as f:
        f.write("python311.zip\n.\nLib\\site-packages\n..\\server\nimport site\n")
    return rt


# ---------------------------------------------------------------- libraries
def pip(args):
    for index in INDEXES:
        r = subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "--no-warn-script-location",
                            "--timeout", "30", "--retries", "2", "-i", index] + args)
        if r.returncode == 0:
            return True
        say("  that index failed, trying the next one")
    return False


def get_libs(rt):
    sp = os.path.join(rt, "Lib", "site-packages")
    os.makedirs(sp, exist_ok=True)
    if not pip(["--target", sp, "--no-compile"] + PACKAGES):
        raise SystemExit("Could not install the libraries")
    if not pip(["--target", sp, "--no-deps", "--no-compile", "--upgrade", LDDC_URL]):
        spec = importlib.util.find_spec("LDDC")
        if spec is None:
            raise SystemExit("Could not download LDDC, and it is not installed here either (scripts\\setup_lddc.bat)")
        say("  LDDC: using the copy installed in this environment")
        shutil.copytree(os.path.dirname(spec.origin), os.path.join(sp, "LDDC"), dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__"))
    for rel in UNUSED:
        p = os.path.join(sp, rel)
        if os.path.isdir(p):
            shutil.rmtree(p)
        elif os.path.isfile(p):
            os.remove(p)
    for d, dirs, _ in os.walk(sp):
        for name in [x for x in dirs if x == "__pycache__"]:
            shutil.rmtree(os.path.join(d, name))
            dirs.remove(name)


# ---------------------------------------------------------------- our own files
def copy_app():
    skip = shutil.ignore_patterns("__pycache__", "*.pyc")
    for name in ("server", "web"):
        shutil.copytree(os.path.join(ROOT, name), os.path.join(OUT, name), ignore=skip)
    os.makedirs(os.path.join(OUT, "desktop"))
    shutil.copy2(os.path.join(HERE, "app.py"), os.path.join(OUT, "desktop", "app.py"))
    lic = os.path.join(ROOT, "LICENSE")                      # GPL-3.0 asks for its text to travel with the program
    if os.path.isfile(lic):
        shutil.copy2(lic, os.path.join(OUT, "LICENSE.txt"))
    with open(os.path.join(OUT, "LICENSES.txt"), "w", encoding="utf-8", newline="\r\n") as f:
        f.write("This folder contains, unchanged:\n"
                "  Python " + PY_VER + " (python.org), PSF License: runtime\\LICENSE.txt\n"
                "  LDDC (github.com/chenmozhijin/LDDC), GPL-3.0: QQ Music / Kugou / NetEase lyrics search\n"
                "  Archivo, JetBrains Mono and Noto Sans SC fonts, SIL Open Font License 1.1: web\\fonts\\*-OFL.txt\n"
                "  pywebview (BSD-3), pythonnet (MIT), httpx (BSD-3), PyAudioWPatch (MIT), PyWinRT (MIT) and the\n"
                "  libraries they need: each one's licence is in runtime\\Lib\\site-packages\\<name>.dist-info\n"
                "Because LDDC is GPL-3.0, this package as a whole may only be passed on under GPL-3.0, with its source.\n")


# ---------------------------------------------------------------- icon and launcher
def _png(size, px):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    raw = b"".join(b"\0" + bytes(px[y * size * 4:(y + 1) * size * 4]) for y in range(size))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def _draw(size):
    """The icon: a rounded square in the brand blue (#0045CE, a little lighter at the top left and darker at the bottom
    right) with three white lines of lyrics. The middle one is being sung: lit white up to where the singing has got
    and dim after it, with a soft light-blue glow around it. A spark (a four-point star, the "lumi" of the name) shines
    at the top right. Drawn by a small ray-less renderer: every pixel is averaged over 4 x 4 sub-samples, so the edges are
    smooth at every size."""
    ss, px = 4, bytearray(size * size * 4)
    r = 0.22
    bh = 0.085
    WHITE = (255.0, 255.0, 255.0)
    GLOW = (120.0, 196.0, 255.0)                       # light blue, the helper colour
    # (centre y, x0, x1, strength): the top and bottom lines are quiet, the middle one is the sung line
    top = (0.325, 0.25, 0.54, 0.50)
    mid_y, mid_x0, mid_x1 = 0.50, 0.25, 0.76
    low = (0.675, 0.25, 0.54, 0.50)
    lit_x = 0.58                                        # where the singing has got to on the middle line
    spark_x, spark_y, spark_r = 0.735, 0.29, 0.12       # the star, top right, clear of the lines

    def inside_round(x, y, x0, y0, x1, y1, rad):
        cx = min(max(x, x0 + rad), x1 - rad)
        cy = min(max(y, y0 + rad), y1 - rad)
        return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad

    def mix(a, b, k):
        return [a[i] + (b[i] - a[i]) * k for i in range(3)]

    def background(x, y):
        t = min(1.0, max(0.0, (x * 0.55 + y * 0.9) / 1.45))
        if t < 0.35:                                   # #1A6BFF -> #0045CE
            return mix((26, 107, 255), (0, 69, 206), t / 0.35)
        return mix((0, 69, 206), (0, 40, 130), (t - 0.35) / 0.65)       # #0045CE -> #002882

    for j in range(size):
        for i in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sj in range(ss):
                for si in range(ss):
                    x, y = (i + (si + 0.5) / ss) / size, (j + (sj + 0.5) / ss) / size
                    if not inside_round(x, y, 0.04, 0.04, 0.96, 0.96, r):
                        continue
                    c = background(x, y)
                    # a faint sheen at the top left, like light on glass
                    sheen = max(0.0, 1.0 - ((x - 0.22) ** 2 + (y - 0.12) ** 2) ** 0.5 / 0.55)
                    c = mix(c, WHITE, 0.10 * sheen * sheen)
                    # the glow of the sung line
                    gy = (y - mid_y) / 0.13
                    gx = max(0.0, abs(x - 0.50) - 0.16) / 0.20
                    glow = 0.42 * 2.718281828 ** (-(gy * gy + gx * gx))
                    c = mix(c, GLOW, glow)
                    # the quiet lines
                    for ly, x0, x1, al in (top, low):
                        if inside_round(x, y, x0, ly - bh / 2, x1, ly + bh / 2, bh / 2):
                            c = mix(c, WHITE, al)
                    # the sung line: white up to lit_x, dim after it
                    if inside_round(x, y, mid_x0, mid_y - bh / 2, mid_x1, mid_y + bh / 2, bh / 2):
                        c = mix(c, WHITE, 1.0 if x <= lit_x else 0.55)
                    # the spark: a four-point star (an astroid) with its own halo
                    dx, dy = abs(x - spark_x) / spark_r, abs(y - spark_y) / spark_r
                    d2 = (x - spark_x) ** 2 + (y - spark_y) ** 2
                    c = mix(c, WHITE, 0.55 * 2.718281828 ** (-d2 / 0.0035))
                    if dx ** (2.0 / 3.0) + dy ** (2.0 / 3.0) <= 1.0:
                        c = list(WHITE)
                    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]; acc[3] += 1
            n = acc[3]
            o = (j * size + i) * 4
            if n:
                px[o:o + 4] = bytes([int(acc[0] / n), int(acc[1] / n), int(acc[2] / n), int(255 * n / (ss * ss))])
    return _png(size, px)


def make_icon(path):
    sizes = [16, 24, 32, 48, 64, 256]
    pngs = [_draw(s) for s in sizes]
    head = struct.pack("<HHH", 0, 1, len(sizes))
    off, entries = 6 + 16 * len(sizes), b""
    for s, p in zip(sizes, pngs):
        entries += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(p), off)
        off += len(p)
    with open(path, "wb") as f:
        f.write(head + entries + b"".join(pngs))


def make_launcher(icon):
    exe = os.path.join(OUT, "Lumilyric.exe")
    if not os.path.isfile(CSC):
        raise SystemExit("csc.exe (part of Windows' .NET Framework 4) was not found at " + CSC)
    r = subprocess.run([CSC, "/nologo", "/target:winexe", "/platform:x64", "/codepage:65001", "/optimize+", "/win32icon:" + icon,
                        "/r:System.Windows.Forms.dll", "/out:" + exe, os.path.join(HERE, "launcher.cs")])
    if r.returncode != 0 or not os.path.isfile(exe):
        raise SystemExit("Could not compile the launcher")


# ---------------------------------------------------------------- check and pack
def self_test(rt):
    """The built folder's own Python, started with a clean environment, must import everything it will use."""
    code = ("import sys, os; os.environ['LRC_PORT']='0'\n"
            "import lddc_bridge, nowplaying, audio_level, cover_search, lyrics_match, disk_cache, push\n"
            "import PySide6; assert 'qt_stub' in PySide6.__file__\n"
            "from LDDC.core.api.lyrics import search, get_lyrics; from LDDC.core.converter import convert2\n"
            "import winrt.windows.media.control, pyaudiowpatch, webview, clr\n"
            "assert nowplaying.available() and audio_level.available() and lddc_bridge.available()\n"
            "bad = [m for m in sys.modules if m.split('.')[0] in ('numpy', 'torch', 'shiboken6')]\n"
            "assert not bad, bad\n"
            "top = os.path.dirname(os.path.dirname(sys.executable)).lower()\n"
            "win = os.environ['WINDIR'].lower()          # pythonnet adds the .NET Framework folder\n"
            "assert all(p.lower().startswith((top, win)) for p in sys.path if p), sys.path\n"
            "print('self test ok: Python', sys.version.split()[0])\n")
    env = {k: v for k, v in os.environ.items() if not k.upper().startswith(("PYTHON", "VIRTUAL_ENV", "LRC_"))}
    r = subprocess.run([os.path.join(rt, "python.exe"), "-c", code], cwd=OUT, env=env)
    if r.returncode != 0:
        raise SystemExit("The built folder failed its self test")


def pack():
    z = OUT + ".zip"
    if os.path.isfile(z):
        os.remove(z)
    with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for d, dirs, files in os.walk(OUT):
            dirs[:] = [x for x in dirs if x != "__pycache__" and not (d == OUT and x == "tools")]
            for f in files:
                p = os.path.join(d, f)
                zf.write(p, os.path.join("Lumilyric", os.path.relpath(p, OUT)))
    return z


def main():
    if sys.version_info[:2] != (3, 11) or sys.platform != "win32":
        raise SystemExit("Build with the project's Python 3.11 on Windows: tools\\align-env\\Scripts\\python.exe desktop\\build.py")
    if os.path.isdir(OUT):
        say("Removing the previous build (its tools\\ folder, the cache and settings, is kept) ...")
        for attempt in range(8):                 # a window just closed lets go of its files a few seconds later
            try:
                for name in os.listdir(OUT):
                    p = os.path.join(OUT, name)
                    if name == "tools":
                        continue
                    shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
                break
            except PermissionError:
                time.sleep(1)
        else:
            raise SystemExit("dist\\Lumilyric is in use: close the desktop version (wait a few seconds) and build again")
    os.makedirs(OUT, exist_ok=True)
    say("[1/5] Python", PY_VER)
    rt = get_python()
    say("[2/5] Libraries")
    get_libs(rt)
    say("[3/5] The player itself")
    copy_app()
    say("[4/5] Icon and Lumilyric.exe")
    icon = os.path.join(OUT, "desktop", "app.ico")
    make_icon(icon)
    make_launcher(icon)
    say("[5/5] Self test and zip")
    self_test(rt)
    for d, dirs, _ in os.walk(OUT):                 # the self test compiled a few files
        for name in [x for x in dirs if x == "__pycache__"]:
            shutil.rmtree(os.path.join(d, name))
            dirs.remove(name)
    z = pack()
    say("")
    say("Done.")
    names = [n for n in sorted(os.listdir(OUT)) if n != "tools"]         # tools\: cache and settings of earlier runs
    for name in names:
        say("  %-18s %6.1f MB" % (name, size_mb(os.path.join(OUT, name))))
    say("  %-18s %6.1f MB" % ("folder in all", sum(size_mb(os.path.join(OUT, n)) for n in names)))
    say("  %-18s %6.1f MB" % ("Lumilyric.zip", size_mb(z)))
    say("Start it with dist\\Lumilyric\\Lumilyric.exe")


if __name__ == "__main__":
    main()
