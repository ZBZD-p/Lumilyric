"""
The desktop version: the same local server and the same page as start_server.bat, in a window of its own
instead of a browser tab and a black console.

The window is WebView2, the Edge engine that comes with Windows 10 / 11: the page (WebGL background, canvas
lyrics, video export) runs in it exactly as it does in Edge. It has no title bar: the page fills the whole
window and draws its own minimise / maximise / close buttons (web/js/ui/desktop.js); the top strip of the page
drags the window (CSS app-region), the edges resize it as usual. Without WebView2 on the PC the page opens in Edge's
"app" window, and without Edge in the default browser.

Started by Lumilyric.exe (built by desktop\\build.py) with the Python in runtime\\. For development it also
runs from the project folder:  tools\\align-env\\Scripts\\python.exe desktop\\app.py  (needs pip install pywebview).

Written while it runs, all in tools\\: desktop.log (what the black window used to show), window.json (size and
place of the window), webview\\ (the page's saved settings).
"""
import ctypes
import json
import os
import socket
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "tools")
TITLE = "Lumilyric"
APP_ID = "Lumilyric.Desktop"
PORTS = range(8765, 8776)           # the first free one; 8765 unless start_server.bat is running too
WEBVIEW2_KEYS = [(0x80000002, r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"),
                 (0x80000002, r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"),
                 (0x80000001, r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}")]

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32


def message(text, error=False):
    user32.MessageBoxW(None, text, TITLE, 0x10 if error else 0x40)


def already_running():
    """True when another copy is open: its window is brought to the front instead of starting a second one."""
    kernel32.CreateMutexW(None, False, APP_ID)
    if kernel32.GetLastError() != 183:          # ERROR_ALREADY_EXISTS
        return False
    hwnd = user32.FindWindowW(None, TITLE)
    if hwnd:
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9)          # SW_RESTORE
        user32.SetForegroundWindow(hwnd)
    return True


def open_log():
    """pythonw.exe has no console: everything printed goes to tools\\desktop.log (the last run only)."""
    os.makedirs(DATA, exist_ok=True)
    f = open(os.path.join(DATA, "desktop.log"), "w", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = f
    return f


def free_port():
    for p in PORTS:
        s = socket.socket()
        try:
            s.bind(("127.0.0.1", p))
            return p
        except OSError:
            continue
        finally:
            s.close()
    return None


def start_server(port):
    os.environ["LRC_PORT"] = str(port)
    os.environ.setdefault("HF_HOME", os.path.join(DATA, "hf-cache"))
    sys.path.insert(0, os.path.join(ROOT, "server"))
    import server                                # the same module start_server.bat runs
    threading.Thread(target=server.main, name="server", daemon=True).start()
    for _ in range(150):                         # up to 15 s
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close()
            return True
        except OSError:
            time.sleep(0.1)
    return False


def webview2_version():
    import winreg
    for hive, key in WEBVIEW2_KEYS:
        try:
            with winreg.OpenKey(hive, key) as k:
                v = winreg.QueryValueEx(k, "pv")[0]
            if v and v != "0.0.0.0":
                return v
        except OSError:
            pass
    return None


# ---------------------------------------------------------------- window without a title bar
WM_NCCALCSIZE, WM_NCHITTEST, GWLP_WNDPROC = 0x0083, 0x0084, -4
WM_WINDOWPOSCHANGING, WM_WINDOWPOSCHANGED, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE = 0x0046, 0x0047, 0x0231, 0x0232
HTTOP, HTTOPLEFT, HTTOPRIGHT = 12, 13, 14
LRESULT = ctypes.c_ssize_t
WNDPROC = ctypes.WINFUNCTYPE(LRESULT, ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t)
user32.CallWindowProcW.restype = LRESULT
user32.CallWindowProcW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t]
user32.SetWindowLongPtrW.restype = ctypes.c_void_p
user32.SetWindowLongPtrW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
user32.IsZoomed.argtypes = [ctypes.c_void_p]
user32.IsIconic.argtypes = [ctypes.c_void_p]
user32.GetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int]
user32.GetWindowRect.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
user32.SetWindowPos.argtypes = [ctypes.c_void_p, ctypes.c_void_p] + [ctypes.c_int] * 4 + [ctypes.c_uint]
_keep = []                                       # the callback must outlive the window
FULL = {"on": False}                             # full screen: the window is plain then, nothing below applies


class RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class WINDOWPOS(ctypes.Structure):
    _fields_ = [("hwnd", ctypes.c_void_p), ("after", ctypes.c_void_p), ("x", ctypes.c_int), ("y", ctypes.c_int),
                ("cx", ctypes.c_int), ("cy", ctypes.c_int), ("flags", ctypes.c_uint)]


def _title_height(hwnd):
    """Height of the title bar (with the top border) this window would have: what was given to the page."""
    r = RECT()
    style, ex = user32.GetWindowLongW(hwnd, -16) & 0xffffffff, user32.GetWindowLongW(hwnd, -20) & 0xffffffff
    try:
        user32.AdjustWindowRectExForDpi(ctypes.byref(r), style, False, ex, user32.GetDpiForWindow(ctypes.c_void_p(hwnd)))
    except Exception:
        user32.AdjustWindowRectEx(ctypes.byref(r), style, False, ex)
    return -r.top


def _frame(hwnd):
    """Thickness of the resize border, in this window's pixels."""
    try:
        dpi = user32.GetDpiForWindow(ctypes.c_void_p(hwnd))
        return user32.GetSystemMetricsForDpi(33, dpi) + user32.GetSystemMetricsForDpi(92, dpi)
    except Exception:
        return user32.GetSystemMetrics(33) + user32.GetSystemMetrics(92)


def remove_title_bar(hwnd):
    """Keep the normal window (resize borders, shadow, snapping, animations) but give the title bar's space to
    the page: the client area starts at the very top. Left, right and bottom borders stay Windows' own; the top
    edge has none any more, so the top few pixels are answered as "resize" by hand.

    WinForms (the window is one of its Forms) does not know: when it restores the window from maximised or
    minimised it works the size out from the page area plus a title bar, and the window would grow by one title
    bar each time. That one size, asked for outside a drag by the user, is put back to the real one."""
    st = {"size": None, "moving": False}

    def proc(h, msg, wp, lp):
        if FULL["on"]:
            return user32.CallWindowProcW(old, h, msg, wp, lp)
        if msg == WM_ENTERSIZEMOVE or msg == WM_EXITSIZEMOVE:
            st["moving"] = msg == WM_ENTERSIZEMOVE
        elif msg == WM_WINDOWPOSCHANGING and st["size"] and not st["moving"]:
            p = ctypes.cast(lp, ctypes.POINTER(WINDOWPOS)).contents
            if not p.flags & 0x0001 and not user32.IsZoomed(h) and not user32.IsIconic(h)                     and (p.cx, p.cy) == (st["size"][0], st["size"][1] + _title_height(h)):
                p.cy = st["size"][1]
        elif msg == WM_WINDOWPOSCHANGED:
            res = user32.CallWindowProcW(old, h, msg, wp, lp)
            if not user32.IsZoomed(h) and not user32.IsIconic(h):
                wr = RECT()
                user32.GetWindowRect(h, ctypes.byref(wr))
                st["size"] = (wr.right - wr.left, wr.bottom - wr.top)
            return res
        if msg == WM_NCCALCSIZE and wp:
            r = ctypes.cast(lp, ctypes.POINTER(RECT)).contents           # the proposed window rectangle
            top = r.top
            res = user32.CallWindowProcW(old, h, msg, wp, lp)            # takes the borders and the title bar off
            # maximised: Windows pushes the window past the screen edge by one border, keep that off the top
            r.top = top + (_frame(h) if user32.IsZoomed(h) else 0)
            return res
        if msg == WM_NCHITTEST and not user32.IsZoomed(h):
            x, y = ctypes.c_short(lp & 0xffff).value, ctypes.c_short((lp >> 16) & 0xffff).value
            wr = RECT()
            user32.GetWindowRect(h, ctypes.byref(wr))
            b = _frame(h)
            if wr.top <= y < wr.top + b:
                return HTTOPLEFT if x < wr.left + 2 * b else HTTOPRIGHT if x >= wr.right - 2 * b else HTTOP
        return user32.CallWindowProcW(old, h, msg, wp, lp)

    cb = WNDPROC(proc)
    _keep.append(cb)
    old = user32.SetWindowLongPtrW(hwnd, GWLP_WNDPROC, ctypes.cast(cb, ctypes.c_void_p))
    user32.SetWindowPos(hwnd, None, 0, 0, 0, 0, 0x0020 | 0x0001 | 0x0002 | 0x0004 | 0x0010)   # frame changed, nothing else


class WindowApi:
    """What the page's own window buttons call (window.pywebview.api.*)."""
    def __init__(self):
        self._win = None
        self._was_max = False

    def win_minimize(self):
        self._win.minimize()

    def win_maximize(self):
        if str(self._win.native.WindowState) == "Maximized":
            self._win.restore()
        else:
            self._win.maximize()

    def win_close(self):
        self._win.destroy()

    def win_fullscreen(self):
        """Toggle real full screen (over the taskbar, no border). Returns the new state."""
        from System import Action
        form = self._win.native
        hwnd = int(form.Handle.ToInt64())
        on = not FULL["on"]
        if on:
            # from a maximised window: back to its normal size first, so that is what full screen returns to
            self._was_max = bool(user32.IsZoomed(hwnd))
            if self._was_max:
                self._win.restore()
            FULL["on"] = True
            self._win.toggle_fullscreen()
        else:
            self._win.toggle_fullscreen()

            def back():                          # pywebview squares the corners and hides the border, and leaves them so
                FULL["on"] = False
                for attr, val in ((33, 0), (34, 0xFFFFFFFF)):
                    v = ctypes.c_uint(val)
                    ctypes.windll.dwmapi.DwmSetWindowAttribute(ctypes.c_void_p(hwnd), attr, ctypes.byref(v), 4)
                user32.SetWindowPos(hwnd, None, 0, 0, 0, 0, 0x0020 | 0x0001 | 0x0002 | 0x0004 | 0x0010)
            form.Invoke(Action(back))
            if self._was_max:
                self._win.maximize()
        return on


# ---------------------------------------------------------------- window
def load_geometry():
    try:
        with open(os.path.join(DATA, "window.json"), encoding="utf-8") as f:
            g = json.load(f)
        w, h = int(g["width"]), int(g["height"])
        x, y = int(g["x"]), int(g["y"])
        sw, sh = user32.GetSystemMetrics(78), user32.GetSystemMetrics(79)      # all screens together
        sx, sy = user32.GetSystemMetrics(76), user32.GetSystemMetrics(77)
        if w < 640 or h < 400 or x + w < sx + 100 or y < sy - 10 or x > sx + sw - 100 or y > sy + sh - 100:
            return {}                            # off screen (a monitor was unplugged): start centred
        return {"width": w, "height": h, "x": x, "y": y, "maximized": bool(g.get("maximized"))}
    except Exception:
        return {}


def save_geometry(g):
    try:
        with open(os.path.join(DATA, "window.json"), "w", encoding="utf-8") as f:
            json.dump(g, f)
    except Exception as e:
        print("window.json not saved:", e)


def unblock_dotnet():
    """A zip that came through a browser or a chat app carries the "from the internet" mark, and Explorer copies it
    onto every file it unpacks. The .NET Framework refuses to load a marked assembly, so pythonnet fails with
    "Failed to resolve Python.Runtime.Loader.Initialize" and there is no window. The mark is a side stream of the
    file; deleting it is what "Unblock" in the file's properties does."""
    site = os.path.join(os.path.dirname(sys.executable), "Lib", "site-packages")
    for pkg in ("pythonnet", "clr_loader", "webview"):
        for folder, _, names in os.walk(os.path.join(site, pkg)):
            for n in names:
                if n.lower().endswith(".dll"):
                    try:
                        os.remove(os.path.join(folder, n) + ":Zone.Identifier")
                        print("unblocked", n)
                    except OSError:
                        pass                     # not marked (the usual case), or the folder is read-only


def run_window(url):
    unblock_dotnet()
    import webview
    geo = load_geometry()
    maximized = geo.pop("maximized", False)
    webview.settings["ALLOW_DOWNLOADS"] = True                 # "save lyrics" / "save video" when there is no file picker
    api = WindowApi()
    # starts on an empty black page: the drag-region setting below only counts for pages loaded after it
    win = webview.create_window(TITLE, html="<body style='background:#000'></body>", js_api=api,
                                width=geo.get("width", 1320), height=geo.get("height", 820),
                                x=geo.get("x"), y=geo.get("y"), min_size=(420, 560), maximized=maximized,
                                background_color="#000000", text_select=False)
    api._win = win
    last = dict(geo)
    state = {"started": False}

    def on_shown():
        try:
            from System import Action
            from System.Drawing import Icon
            form = win.native

            def dress():
                ico = os.path.join(HERE, "app.ico")
                if os.path.isfile(ico):
                    form.Icon = Icon(ico)
                hwnd = int(form.Handle.ToInt64())
                dark = ctypes.c_int(1)           # dark window border, to go with the page
                ctypes.windll.dwmapi.DwmSetWindowAttribute(ctypes.c_void_p(hwnd), 20, ctypes.byref(dark), 4)
                remove_title_bar(hwnd)
            form.Invoke(Action(dress))
        except Exception as e:
            print("window icon / title bar:", e)

    def on_loaded():
        if state["started"]:
            return
        state["started"] = True
        try:
            from System import Action

            def allow_drag():                    # lets the page mark its top strip as "drags the window"
                win.native.browser.webview.CoreWebView2.Settings.IsNonClientRegionSupportEnabled = True
            win.native.Invoke(Action(allow_drag))
        except Exception as e:
            print("drag region:", e)
        win.load_url(url)

    def remember(*_):
        # the size while not maximized is the one worth keeping
        try:
            form = win.native
            state = str(form.WindowState)
            if state == "Normal":
                last.update(width=int(win.width), height=int(win.height), x=int(win.x), y=int(win.y))
            last["maximized"] = state == "Maximized"
        except Exception:
            pass

    def on_closing():
        remember()
        if last.get("width"):
            save_geometry(last)

    win.events.shown += on_shown
    win.events.loaded += on_loaded
    win.events.resized += remember
    win.events.moved += remember
    win.events.closing += on_closing
    webview.start(gui="edgechromium", private_mode=False, storage_path=os.path.join(DATA, "webview"))


def run_browser(url):
    """No WebView2: Edge's app window (same engine, no address bar), else the default browser. Neither tells us
    when its window is closed (Edge hands the window to another process and returns), so a small box stays open
    and closing that ends the player."""
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
        edge = os.path.join(base or "", "Microsoft", "Edge", "Application", "msedge.exe")
        if base and os.path.isfile(edge):
            print("no WebView2: using", edge)
            subprocess.Popen([edge, "--app=" + url])
            break
    else:
        import webbrowser
        print("no WebView2, no Edge: default browser")
        webbrowser.open(url)
    message("页面已在浏览器里打开。\n\n用完后点「确定」关闭 Lumilyric。")


def main():
    if already_running():
        return
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)      # taskbar: our own button and icon
    except Exception:
        pass
    log = open_log()
    print(time.strftime("%Y-%m-%d %H:%M:%S"), "Python", sys.version.split()[0], sys.executable)
    port = free_port()
    if port is None:
        return message("端口 8765 到 8775 都被占用了，无法启动。", True)
    try:
        ok = start_server(port)
    except Exception:
        import traceback
        traceback.print_exc()
        ok = False
    if not ok:
        return message("本地服务没有启动成功。\n\n详情见 " + log.name, True)
    url = f"http://127.0.0.1:{port}/"
    wv = webview2_version()
    print("WebView2:", wv or "not installed")
    try:
        if not wv:
            raise RuntimeError("WebView2 is not installed")
        run_window(url)
    except Exception:
        import traceback
        traceback.print_exc()
        run_browser(url)
    print(time.strftime("%H:%M:%S"), "window closed")
    log.flush()
    os._exit(0)                                   # also ends the server and the player-reading threads


if __name__ == "__main__":
    main()
