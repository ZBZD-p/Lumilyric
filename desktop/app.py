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


def remove_title_bar(hwnd, full=FULL):
    """Keep the normal window (resize borders, shadow, snapping, animations) but give the title bar's space to
    the page: the client area starts at the very top. Left, right and bottom borders stay Windows' own; the top
    edge has none any more, so the top few pixels are answered as "resize" by hand.

    WinForms (the window is one of its Forms) does not know: when it restores the window from maximised or
    minimised it works the size out from the page area plus a title bar, and the window would grow by one title
    bar each time. That one size, asked for outside a drag by the user, is put back to the real one.

    `full`: this window's own full-screen flag (each window has one)."""
    st = {"size": None, "moving": False}

    def proc(h, msg, wp, lp):
        if full["on"]:
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


def dress_window(win, full=FULL):
    """The app's icon, a dark border and no title bar (the page draws its own strip and buttons). On "shown"."""
    try:
        from System import Action
        from System.Drawing import Icon
        form = win.native

        def dress():
            ico = os.path.join(HERE, "app.ico")
            if os.path.isfile(ico):
                form.Icon = Icon(ico)
            hwnd = int(form.Handle.ToInt64())
            dark = ctypes.c_int(1)               # dark window border, to go with the page
            ctypes.windll.dwmapi.DwmSetWindowAttribute(ctypes.c_void_p(hwnd), 20, ctypes.byref(dark), 4)
            remove_title_bar(hwnd, full)
        form.Invoke(Action(dress))
    except Exception as e:
        print("window icon / title bar:", e)


def allow_drag(win):
    """Lets the page mark a strip as "drags the window" (CSS app-region). Only counts for pages loaded after it."""
    try:
        from System import Action

        def go():
            win.native.browser.webview.CoreWebView2.Settings.IsNonClientRegionSupportEnabled = True
        win.native.Invoke(Action(go))
    except Exception as e:
        print("drag region:", e)


# ---------------------------------------------------------------- QQ 音乐网页跟随 (desktop only)
# A second WebView2 window holds QQ Music's web player. The user picks and plays songs in it; a reader thread
# scrapes what is playing into the server's qqweb module (which the page polls), and control from the page is
# carried out by injecting clicks on that window. QQ web plays through Web Audio (no media element, no system
# media session), so it is invisible to the normal "follow" path — this is how the page can follow it instead.
QQ_URL = "https://y.qq.com/"

# read the current song, position and play state off the player bar.
# The time text only has whole seconds: read at an arbitrary moment, "00:29" may really be 29.9 s, and anchoring
# the position to the moment of reading pulled the bar back by up to a second on every read. So a small watcher in
# the page (every 40 ms) keeps its own anchor: the moment the second changes is exactly N.0 s; the moment the play
# button flips (paused / resumed between two ticks) freezes or restarts the position where it then is. The reader
# takes that anchor (__lmw.pos as of __lmw.at), which only moves when something happens.
QQ_READ_JS = r"""
(function(){
  if (!window.__lmw){
    var w = window.__lmw = {sec: null, pos: 0, at: 0, playing: false};
    setInterval(function(){
      var el = document.querySelector('.player_music__time'), b = document.querySelector('.btn_big_play');
      if (!el) return;
      var p = el.textContent.trim().split('/')[0].trim().split(':');
      if (p.length !== 2) return;
      var s = (+p[0])*60 + (+p[1]), now = Date.now();
      var pl = !!b && b.textContent.trim() === '暂停';
      var guess = w.playing ? w.pos + (now - w.at) / 1000 : w.pos;
      if (s !== w.sec){
        w.sec = s; w.pos = s; w.at = now;          // a natural tick lands on s.0 (a seek or a new song: to the second)
      } else if (pl !== w.playing){
        w.pos = Math.min(s + 0.999, Math.max(s, guess)); w.at = now;     // paused / resumed between two ticks
      }
      w.playing = pl;
    }, 40);
  }
  var info = document.querySelector('.player_music__info');
  var links = info ? info.querySelectorAll('a') : [];
  var title = links.length ? links[0].textContent.trim() : null;
  var ar = info ? info.querySelector('a.playlist__author') : null;
  var artist = ar ? ar.textContent.trim() : null;
  var timeEl = document.querySelector('.player_music__time');
  var btn = document.querySelector('.btn_big_play');
  function sec(t){ if(!t) return null; var p=t.split(':'); return p.length===2 ? (+p[0])*60+(+p[1]) : null; }
  var cur = null, dur = null;
  if (timeEl){ var m=timeEl.textContent.trim().split('/'); cur=sec((m[0]||'').trim()); dur=sec((m[1]||'').trim()); }
  var label = btn ? btn.textContent.trim() : null;   // "暂停" while playing, "播放" while paused
  var w = window.__lmw;
  // the album and its picture, shown beside the song list. Right after a song change the picture may still be the
  // last song's: it is only taken when its album id is the album link's (coverOk)
  var pic = document.querySelector('.song_info__pic'), alb = document.querySelector('.song_info__album a');
  var cover = pic ? (pic.currentSrc || pic.src || '') : '';
  var am = alb && /albumDetail\/([0-9A-Za-z]+)/.exec(alb.href || ''), cm = /M000([0-9A-Za-z]+)(?:_\d+)?\.jpg/.exec(cover);
  return JSON.stringify({title:title, artist:artist, cur:cur, dur:dur,
                         wsec: w.sec, wpos: w.pos, wat: w.at, now: Date.now(),
                         playing: label==='暂停', label:label,
                         album: alb ? alb.textContent.trim() : '', cover: cover,
                         coverOk: !!(am && cm && am[1] === cm[1])});
})()
"""


# The QQ window has no title bar either (dress_window): the same strip and dots as the main window (style.css .deskbar
# / .dk, desktop.js) are drawn into the QQ page. The top 24 px drag the window, double-click maximises; the dots are
# full screen / minimise / maximise / close. The full-window player page has empty background in its top 20 px, so
# the strip just lies over it like the main window's; other pages (the home page's links are right at the top) are
# pushed down below it, onto a dark strip. Checked on every read, so it is back after QQ re-renders or navigates.
QQ_CHROME_JS = r"""
(function(){
  if (!document.body || document.getElementById('lmDesk')) return;
  var css = document.createElement('style');
  css.id = 'lmDeskCss';
  css.textContent =
    '#lmDesk{position:fixed;left:0;right:0;top:0;height:24px;z-index:2147483647;display:flex;justify-content:flex-end;align-items:center;-webkit-app-region:drag;app-region:drag;margin:0;padding:0}' +
    'html.lm-shift{padding-top:24px!important}' +
    'html.lm-shift #lmDesk{background:#141414}' +
    '#lmDesk .lmdk{display:flex;height:24px;padding:0 7px 0 6px;-webkit-app-region:no-drag;app-region:no-drag}' +
    '#lmDesk button{all:unset;width:20px;height:24px;display:grid;place-items:center;cursor:default}' +
    '#lmDesk i{width:12px;height:12px;border-radius:50%;display:grid;place-items:center;background:rgba(255,255,255,.26);box-shadow:0 0 0 .5px rgba(0,0,0,.3);transition:background .18s,transform .18s cubic-bezier(.16,1,.3,1);font-style:normal}' +
    '#lmDesk svg{width:8px;height:8px;fill:none;stroke:rgba(0,0,0,.72);stroke-width:1.3;stroke-linecap:round;opacity:0;transition:opacity .18s}' +
    '#lmDesk .lmdk:hover i{background:rgba(255,255,255,.82)}' +
    '#lmDesk .lmdk:hover svg{opacity:1}' +
    '#lmDesk button:hover i{background:#fff;transform:scale(1.18)}' +
    '#lmDesk button[data-a=x]:hover i{background:#ff5f57}' +
    '#lmDesk button:active i{transform:scale(.94)}' +
    'html.lm-full #lmDesk{-webkit-app-region:no-drag;app-region:no-drag;pointer-events:none;background:none}' +
    'html.lm-full #lmDesk .lmdk{pointer-events:auto}' +
    'html.lm-full #lmDesk button[data-a=min],html.lm-full #lmDesk button[data-a=max]{display:none}' +
    'html.lm-popup #lmDesk button[data-a=full]{display:none}';
  (document.head || document.documentElement).appendChild(css);
  var bar = document.createElement('div');
  bar.id = 'lmDesk';
  bar.innerHTML = '<div class="lmdk">' +
    '<button data-a="full" title="全屏（F11，Esc 退出）"><i><svg viewBox="0 0 8 8"><path d="M4.6 1.6h1.8v1.8M3.4 6.4H1.6V4.6"/></svg></i></button>' +
    '<button data-a="min" title="最小化"><i><svg viewBox="0 0 8 8"><path d="M1.5 4h5"/></svg></i></button>' +
    '<button data-a="max" title="最大化 / 还原"><i><svg viewBox="0 0 8 8"><rect x="1.6" y="1.6" width="4.8" height="4.8" rx=".6"/></svg></i></button>' +
    '<button data-a="x" title="关闭"><i><svg viewBox="0 0 8 8"><path d="M2 2l4 4M6 2l-4 4"/></svg></i></button>' +
    '</div>';
  document.documentElement.appendChild(bar);      // outside <body>: QQ's own rendering does not touch it
  var full = false, busy = false;
  function api(){ return window.pywebview && window.pywebview.api; }
  function toggleFull(){
    var a = api(); if (!a || busy) return;
    busy = true;
    Promise.resolve(a.win_fullscreen()).then(function(on){ full = !!on; document.documentElement.classList.toggle('lm-full', full); })
      .catch(function(){}).then(function(){ busy = false; });
  }
  // the player's own window (QQPlayer) is no pywebview window: its dots ask it through postMessage, and it has no
  // full screen
  if (window.__lmPopup) document.documentElement.classList.add('lm-popup');
  bar.addEventListener('click', function(e){
    var b = e.target.closest && e.target.closest('button');
    if (!b) return;
    var k = b.getAttribute('data-a');
    if (window.__lmPopup){ if (window.chrome && chrome.webview) chrome.webview.postMessage('lm:' + k); return; }
    var a = api(); if (!a) return;
    if (k === 'min') a.win_minimize(); else if (k === 'max') a.win_maximize(); else if (k === 'x') a.win_close(); else if (k === 'full') toggleFull();
  });
  addEventListener('keydown', function(e){
    if (window.__lmPopup) return;
    if (e.key === 'F11' || (e.key === 'Escape' && full)){ e.preventDefault(); toggleFull(); }
  });
  function shift(){ document.documentElement.classList.toggle('lm-shift', !document.querySelector('.mod_player')); }
  shift(); setInterval(shift, 500);
})();
"""


# The QQ window's own volume (the main window's volume slider, js/ui/am.js). Added before any of QQ's scripts run
# (AddScriptToExecuteOnDocumentCreated): whatever way the page sends sound out, it first goes through one gain of ours.
#   Web Audio: a connection to the speakers (the context's destination) is made to our gain node instead, and the
#              gain node goes to the speakers. Disconnecting from the speakers likewise.
#   <audio> / <video> without Web Audio: their volume is the page's own times ours; the page reads back its own.
# __lmSetVol(v) sets it (0..1); the reader calls it on every read, so a new page or a new audio context gets it too.
QQ_VOLUME_JS = r"""
(function(){
  if (window.__lmVol) return;
  var V = window.__lmVol = {gain: 1, ctx: [], els: []};
  var AN = window.AudioNode, ADN = window.AudioDestinationNode, OAC = window.OfflineAudioContext;
  if (AN && ADN){
    var connect = AN.prototype.connect, disconnect = AN.prototype.disconnect;
    var gainOf = function(ctx){
      if (!ctx.__lmGain){
        var g = ctx.createGain();
        g.gain.value = V.gain;
        connect.call(g, ctx.destination);
        ctx.__lmGain = g; V.ctx.push(ctx);
      }
      return ctx.__lmGain;
    };
    var ours = function(node, target){
      return target instanceof ADN && !(OAC && node.context instanceof OAC) && node !== node.context.__lmGain;
    };
    AN.prototype.connect = function(target){
      if (ours(this, target)){
        var a = Array.prototype.slice.call(arguments); a[0] = gainOf(this.context);
        connect.apply(this, a);
        return target;                                   // connect() hands back what it was given
      }
      return connect.apply(this, arguments);
    };
    AN.prototype.disconnect = function(target){
      if (ours(this, target) && this.context.__lmGain){
        var a = Array.prototype.slice.call(arguments); a[0] = this.context.__lmGain;
        try { return disconnect.apply(this, a); } catch (e){ return; }
      }
      return disconnect.apply(this, arguments);
    };
  }
  var HM = window.HTMLMediaElement, vd = HM && Object.getOwnPropertyDescriptor(HM.prototype, 'volume');
  var track = function(el){
    if (el.__lmWant == null) el.__lmWant = vd.get.call(el);
    if (V.els.indexOf(el) < 0) V.els.push(el);
  };
  var apply = function(el){
    if (el.__lmGraph) return;                            // fed into Web Audio: the gain node turns it down
    try { vd.set.call(el, Math.max(0, Math.min(1, (el.__lmWant == null ? 1 : el.__lmWant) * V.gain))); } catch (e){}
  };
  if (vd){
    Object.defineProperty(HM.prototype, 'volume', {configurable: true, enumerable: vd.enumerable,
      get: function(){ return this.__lmWant != null ? this.__lmWant : vd.get.call(this); },
      set: function(v){ this.__lmWant = v; track(this); apply(this); }});
    var play = HM.prototype.play;
    HM.prototype.play = function(){ track(this); apply(this); return play.apply(this, arguments); };
    var AC = window.AudioContext || window.webkitAudioContext;
    if (AC && AC.prototype.createMediaElementSource){
      var cmes = AC.prototype.createMediaElementSource;
      AC.prototype.createMediaElementSource = function(el){
        if (el){ el.__lmGraph = true; try { vd.set.call(el, el.__lmWant == null ? vd.get.call(el) : el.__lmWant); } catch (e){} }
        return cmes.apply(this, arguments);
      };
    }
  }
  window.__lmSetVol = function(v){
    v = Math.max(0, Math.min(1, +v || 0));
    if (Math.abs(v - V.gain) < 1e-4) return;
    V.gain = v;
    V.ctx.forEach(function(c){ try { c.__lmGain.gain.setTargetAtTime(v, c.currentTime, 0.03); } catch (e){ c.__lmGain.gain.value = v; } });
    V.els.forEach(apply);
  };
})();
"""


# the player page's list (beside it in QQ's page): every song, the one playing marked (songlist__item--playing), and
# the play mode (its mode button's class: btn_big_style_list / single / random / order). The list shows no album and
# no picture; QQ keeps the same list with both in localStorage (playSongData), matched here by the song's id.
QQ_QUEUE_JS = r"""
(function(){
  var store = {};
  try { var d = JSON.parse(localStorage.getItem('playSongData') || 'null'); ((d && d.value || d || {}).songList || []).forEach(function(s){ store[s.mid] = s; }); } catch (e){}
  var items = [].slice.call(document.querySelectorAll('.songlist__item')).map(function(it){
    var a = it.querySelector('.songlist__songname_txt a'), t = it.querySelector('.songlist__time');
    var ar = [].slice.call(it.querySelectorAll('.songlist__artist a')).map(function(x){ return x.textContent.trim(); });
    var p = (t ? t.textContent.trim() : '').split(':');
    var mid = a ? (a.href || '').split('/').pop().split('?')[0] : '', s = store[mid] || {}, al = s.album || {};
    var pic = al.pmid || al.mid || '';
    return {title: a ? (a.title || a.textContent).trim() : '', artist: ar.join(' / '), album: (al.name || al.title || '').trim(),
            cover: pic ? 'https://y.qq.com/music/photo_new/T002R150x150M000' + pic + '.jpg' : '',
            dur: p.length === 2 ? (+p[0]) * 60 + (+p[1]) : 0,
            now: it.classList.contains('songlist__item--playing'), vip: !!it.querySelector('.songlist__icon_vip')};
  });
  var mb = document.querySelector('[class*="btn_big_style"]'), m = mb && /btn_big_style_(\w+)/.exec(mb.className);
  return JSON.stringify({items: items, mode: m ? m[1] : ''});
})()
"""


def _qq_row_js(action, i):
    """The i-th song of the list: play it (its own 播放 button; the one playing only goes on, if paused), take it out
    of the list (its 删除), or give its page's address (open: shown in the QQ window)."""
    return r"""
(function(a, i){
  var it = document.querySelectorAll('.songlist__item')[i]; if (!it) return false;
  if (a === 'play'){
    if (it.classList.contains('songlist__item--playing')){
      var b = document.querySelector('.btn_big_play'); if (b && b.textContent.trim() === '播放') b.click();
      return true;
    }
    var p = it.querySelector('.list_menu__play'); if (!p) return false;
    p.click(); return true;
  }
  if (a === 'remove'){ var d = it.querySelector('.songlist__delete'); if (!d) return false; d.click(); return true; }
  if (a === 'open'){ var l = it.querySelector('.songlist__songname_txt a'); return l ? l.href : false; }
  return false;
})(%s, %d)
""" % (json.dumps(action), int(i))


QQ_MODE_JS = r"""(function(){ var b = document.querySelector('[class*="btn_big_style"]'), m = b && /btn_big_style_(\w+)/.exec(b.className); return m ? m[1] : ''; })()"""
QQ_MODE_CLICK_JS = r"""(function(){ var b = document.querySelector('[class*="btn_big_style"]'); if (!b) return false; b.click(); return true; })()"""


def _qq_cover_bytes(url):
    """QQ's album picture at 800 px (the page shows 300; QQ has 500 and 800 too, not 1000): (bytes, mime) or None."""
    import re
    import urllib.request
    tries = [re.sub(r"R\d+x\d+M", "R800x800M", url), re.sub(r"R\d+x\d+M", "R500x500M", url), url]
    for u in dict.fromkeys(tries):
        try:
            req = urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0", "Referer": "https://y.qq.com/"})
            with urllib.request.urlopen(req, timeout=4) as r:
                data = r.read()
                if len(data) > 1000:
                    return data, (r.headers.get_content_type() or "image/jpeg")
        except Exception:
            continue
    return None


def add_early_script(win, js):
    """Runs `js` in every page this window loads, before the page's own scripts. Pages loaded after this only."""
    try:
        from System import Action

        def go():
            win.native.browser.webview.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(js)
        win.native.Invoke(Action(go))
        return True
    except Exception as e:
        print("early script:", e)
        return False


def _qq_seek_js(pct):
    return (r"""
(function(){
  var bars=[].slice.call(document.querySelectorAll('.player_progress')).filter(function(b){return b.className.indexOf('player_voice')<0;});
  var bar=bars[0]; if(!bar) return false;
  var r=bar.getBoundingClientRect(), cx=r.left+r.width*%.4f, cy=r.top+r.height/2;
  ['mousedown','mouseup','click'].forEach(function(t){bar.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,button:0}));});
  return true;
})()
""" % float(pct))


def _qq_ctrl_js(action):
    if action in ("play", "pause"):
        want_playing = "true" if action == "play" else "false"
        return (r"""
(function(){
  var b=document.querySelector('.btn_big_play'); if(!b) return false;
  var playing = b.textContent.trim()==='暂停';
  if (playing !== %s) b.click();   // only click when the state actually needs to flip
  return true;
})()
""" % want_playing)
    sel = ".btn_big_next" if action == "next" else ".btn_big_prev"
    return "(function(){var b=document.querySelector('%s'); if(!b) return false; b.click(); return true;})()" % sel


def _qq_where(uri):
    """Where a new-window request from a QQ page goes: 'popup' (QQ's player, opened as an empty window first),
    'here' (another QQ page: shown in the QQ window), 'out' (anything else: the browser)."""
    low = uri.lower()
    if not low.startswith(("http:", "https:")) or "/player" in low:
        return "popup"
    host = low.split("/")[2] if low.count("/") >= 2 else ""
    return "here" if host == "qq.com" or host.endswith(".qq.com") else "out"


def _qq_new_windows():
    """In a browser QQ's 播放 opens the player in a tab of its own (window.open of an empty page, then the player's
    address), and the page the user was browsing stays. pywebview has no tabs: it handed the request to Windows (which
    asked which app opens "about:" links), and QQ then put the player in place of the page, with no way back. Now, in
    the QQ window, that request gets a real new window (QQPlayer): the opener keeps its link to it, as in a browser,
    so QQ's own "the player is open: add to it" works. Other QQ pages asked for in a new window are shown in the QQ
    window; other sites go to the browser as before. (pywebview's handler is on its class; the main window keeps it.)"""
    from webview.platforms import edgechromium as EC
    orig = EC.EdgeChrome.on_new_window_request
    if getattr(orig, "_lumilyric", False):
        return

    def handler(self, sender, args):
        if QQ_WIN.win is not None and self.pywebview_window is QQ_WIN.win:
            return QQ_WIN.new_window(sender, args)
        return orig(self, sender, args)
    handler._lumilyric = True
    EC.EdgeChrome.on_new_window_request = handler


class QQPlayer:
    """QQ's player page, in a window of its own: a WinForms form with a WebView2 control of the same browser (same
    profile, so the same login), handed to QQ as the new window it asked for. Not a pywebview window (pywebview
    navigates a new window at once, and a window given to a page must not have been navigated yet), so it has its
    own small pieces: the dark border and no title bar (remove_title_bar), the dots strip (QQ_CHROME_JS, its buttons
    answered through postMessage), the volume (QQ_VOLUME_JS) and running scripts (ev)."""
    def __init__(self):
        self.form = self.core = None
        self.alive = False
        self.full = {"on": False}

    def create(self, sender, args):
        """Inside the NewWindowRequested event (UI thread): make the window, give its browser to the page."""
        import System.Windows.Forms as WinForms
        from System.Drawing import Color, Icon, Size
        from Microsoft.Web.WebView2.WinForms import WebView2
        deferral = args.GetDeferral()
        form = WinForms.Form()
        form.Text = "QQ 音乐 · 播放器"
        form.Size = Size(1100, 720)
        form.MinimumSize = Size(760, 520)
        form.BackColor = Color.FromArgb(255, 20, 20, 20)
        form.StartPosition = WinForms.FormStartPosition.WindowsDefaultLocation
        ico = os.path.join(HERE, "app.ico")
        if os.path.isfile(ico):
            form.Icon = Icon(ico)
        ctrl = WebView2()
        ctrl.Dock = WinForms.DockStyle.Fill
        ctrl.DefaultBackgroundColor = Color.FromArgb(255, 20, 20, 20)
        form.Controls.Add(ctrl)

        def ready(s, e):
            try:
                core = ctrl.CoreWebView2
                core.Settings.IsNonClientRegionSupportEnabled = True       # the strip drags the window
                core.AddScriptToExecuteOnDocumentCreatedAsync("window.__lmPopup = true;")
                core.AddScriptToExecuteOnDocumentCreatedAsync(QQ_VOLUME_JS)
                core.WebMessageReceived += self._message
                core.NewWindowRequested += lambda s2, a2: QQ_WIN.new_window(s2, a2, from_player=True)
                self.core = core
                args.set_NewWindow(core)
                args.set_Handled(True)
            except Exception as ex:
                print("qq player window:", ex)
            finally:
                deferral.Complete()

        def closed(s, e):
            self.alive = False
            self.form = self.core = None

        ctrl.CoreWebView2InitializationCompleted += ready
        form.FormClosed += closed
        self.form, self.alive = form, True
        form.Show()
        try:
            hwnd = int(form.Handle.ToInt64())
            dark = ctypes.c_int(1)
            ctypes.windll.dwmapi.DwmSetWindowAttribute(ctypes.c_void_p(hwnd), 20, ctypes.byref(dark), 4)
            remove_title_bar(hwnd, self.full)
        except Exception as ex:
            print("qq player title bar:", ex)
        ctrl.EnsureCoreWebView2Async(sender.Environment)

    def _message(self, s, e):
        """The dots of the strip (QQ_CHROME_JS): 'lm:min' / 'lm:max' / 'lm:x'. Runs on the UI thread."""
        import System.Windows.Forms as WinForms
        try:
            m = str(e.TryGetWebMessageAsString())
        except Exception:
            return
        f = self.form
        if f is None:
            return
        if m == "lm:min":
            f.WindowState = WinForms.FormWindowState.Minimized
        elif m == "lm:max":
            f.WindowState = (WinForms.FormWindowState.Normal if f.WindowState == WinForms.FormWindowState.Maximized
                             else WinForms.FormWindowState.Maximized)
        elif m == "lm:x":
            f.Close()

    def ev(self, js, timeout=3.0):
        """Run js in the player page, from any thread but the UI one; the value it gives (as pywebview's evaluate_js)."""
        from System import Action
        f, core = self.form, self.core
        if f is None or core is None or not self.alive:
            raise RuntimeError("QQ 播放器窗口没有打开")
        box = {}

        def start():
            box["t"] = core.ExecuteScriptAsync(js)
        f.Invoke(Action(start))
        t = box.get("t")
        if t is None or not t.Wait(int(timeout * 1000)):
            raise RuntimeError("QQ 播放器窗口没有回应")
        res = t.Result
        return json.loads(str(res)) if res else None

    def front(self):
        from System import Action
        f = self.form
        if f is not None and self.alive:
            try:
                f.Invoke(Action(lambda: (f.Show(), f.Activate())))
            except Exception:
                pass

    def close(self):
        from System import Action
        f = self.form
        if f is not None and self.alive:
            try:
                f.Invoke(Action(f.Close))
            except Exception:
                pass


class QQWindow:
    """Opens / drives the QQ web player window. One instance, created lazily when the page asks."""
    def __init__(self):
        self.win = None
        self.alive = False
        self._last, self._last_lu = None, 0.0
        self.volume = 1.0                        # the main window's volume slider (0..1), applied on every read
        self._ctid, self._cdone, self._cfirst = None, True, 0.0   # the song whose cover is fetched (or being fetched)
        self._fed = None                         # the song nowplaying has been told about
        self.player = QQPlayer()                 # QQ's player page, in its own window once a song is played

    def new_window(self, sender, args, from_player=False):
        """A QQ page asks for a new window (UI thread): see _qq_new_windows."""
        uri = str(args.get_Uri())
        where = _qq_where(uri)
        if where == "popup" and not from_player:
            # a second player while one is open: the new one is the one QQ now drives, the old one goes
            old = self.player if self.player.alive else None
            self.player = QQPlayer()
            self.player.create(sender, args)
            if old is not None:
                old.close()
            return
        args.set_Handled(True)
        if where == "out" or not uri.lower().startswith(("http:", "https:")):
            if uri.lower().startswith(("http:", "https:")):
                import webbrowser
                webbrowser.open(uri)
            return
        # another QQ page: shown in the QQ window (also when the player asks for it), which comes to the front
        w = self.win
        if w is not None and self.alive:
            threading.Thread(target=lambda: (w.load_url(uri), w.show()), daemon=True).start()

    def _cover(self, tid, url):
        """Fetch the song's picture from QQ, hand it to nowplaying as the player's own cover. A new song waits for it a
        moment (_loop), so the page's first ask for the cover already finds it."""
        def go():
            got = _qq_cover_bytes(url)
            if got:
                import nowplaying as NP
                NP.set_external_cover(tid, *got)
            ev.set()
        ev = threading.Event()
        threading.Thread(target=go, name="qq-cover", daemon=True).start()
        return ev

    def set_volume(self, v):
        try:
            self.volume = max(0.0, min(1.0, float(v)))
        except (TypeError, ValueError):
            return False
        return True                              # the reader applies it on its next read (within 0.15 s)

    def open(self):
        import webview
        if self.win is not None:
            try:
                self.win.show()
                return True
            except Exception:
                self.win = None
        try:
            _qq_new_windows()
        except Exception as e:
            print("qq new-window handler:", e)
        full = {"on": False}                     # its own full-screen flag (the main window has another)
        api = WindowControls(full)
        # starts on an empty page: the drag-strip setting only counts for pages loaded after it (as the main window)
        win = self.win = webview.create_window("QQ 音乐", html="<body style='background:#141414'></body>", js_api=api,
                                               width=1180, height=760, min_size=(760, 520),
                                               background_color="#141414")
        api._win = win
        started = {"v": False}

        def on_loaded():
            if started["v"]:
                return
            started["v"] = True
            allow_drag(win)
            add_early_script(win, QQ_VOLUME_JS)
            # adding the script is asynchronous: give it a moment, so QQ's first page already has it
            threading.Timer(0.3, lambda: win.load_url(QQ_URL)).start()

        win.events.shown += lambda: dress_window(win, full)
        win.events.loaded += on_loaded
        self.alive = True
        self.win.events.closed += self._on_closed
        try:
            import qqweb as QQ
            QQ.register(seek=self._seek, control=self._control, row=self._row, mode=self._mode)
        except Exception as e:
            print("qqweb register:", e)
        threading.Thread(target=self._loop, name="qq-reader", daemon=True).start()
        return True

    def close(self):
        self.player.close()
        if self.win is not None:
            try:
                self.win.destroy()
            except Exception:
                pass

    def is_open(self):
        return self.alive

    def _on_closed(self):
        self.alive = False
        self.win = None
        self.player.close()                      # QQ 网页跟随 is off: its player goes too
        try:
            import nowplaying as NP
            NP.clear_external()
        except Exception:
            pass

    def _browse(self, js):
        w = self.win
        if w is None or not self.alive:
            raise RuntimeError("QQ 窗口未打开")
        return w.evaluate_js(js)

    def _ev(self, js):
        """The page that plays: the player's own window when QQ has opened one, else the QQ window itself."""
        if self.player.alive and self.player.core is not None:
            return self.player.ev(js)
        return self._browse(js)

    def _seek(self, pct):
        return bool(self._ev(_qq_seek_js(pct)))

    def _control(self, action):
        return bool(self._ev(_qq_ctrl_js(action)))

    def _row(self, action, i):
        got = self._ev(_qq_row_js(action, i))
        self._qn = 0                             # read the list again at once: it has changed
        if action == "open":
            w = self.win
            if not got or w is None:
                return False
            threading.Thread(target=lambda: (w.load_url(str(got)), w.show()), daemon=True).start()
            return True
        return bool(got)

    def _mode(self, name):
        """QQ's mode button goes round list -> single -> random -> order: pressed until it shows the one asked for."""
        for _ in range(5):
            if self._ev(QQ_MODE_JS) == name:
                self._qn = 0
                return True
            if not self._ev(QQ_MODE_CLICK_JS):
                return False
            time.sleep(0.12)
        return self._ev(QQ_MODE_JS) == name

    def _loop(self):
        import nowplaying as NP
        n = 0
        self._qn = 0
        while self.alive:
            n += 1
            try:
                if n % 7 == 0 and self.player.alive:
                    self._browse(QQ_CHROME_JS)                 # the QQ window keeps its strip while the player plays
            except Exception:
                pass
            self._qn -= 1
            if self._qn <= 0:                                  # the play list, about once a second
                self._qn = 6
                try:
                    q = json.loads(self._ev(QQ_QUEUE_JS) or "{}")
                    NP.set_external_queue(q.get("items") or [], q.get("mode") or "")
                except Exception:
                    pass
            try:
                vol = "window.__lmSetVol && window.__lmSetVol(%.3f);\n" % self.volume
                raw = self._ev(vol + QQ_CHROME_JS + QQ_READ_JS)
                d = json.loads(raw) if raw else {}
                title = (d.get("title") or "").strip()
                if title:
                    artist = (d.get("artist") or "").strip()
                    now = time.time()
                    playing = bool(d.get("playing"))
                    pos0, lu = float(d.get("cur") or 0), now
                    wat, page_now = d.get("wat") or 0, d.get("now") or 0
                    if d.get("wsec") is not None and wat and page_now:
                        pos0, lu = float(d.get("wpos") or 0), now - (page_now - wat) / 1000.0
                        key = (title, wat, playing)
                        if self._last == key:
                            lu = self._last_lu                       # the same anchor: keep the same stamp
                        self._last, self._last_lu = key, lu
                    tid = NP.track_id(NP.EXT_APP, title, artist, "")
                    if tid != self._ctid:                            # a new song
                        self._ctid, self._cdone, self._cfirst = tid, False, now
                    if not self._cdone and d.get("coverOk") and d.get("cover"):
                        self._cdone = True
                        ev = self._cover(tid, d["cover"])
                        if self._fed != tid:
                            ev.wait(1.2)                             # the song comes with its cover (usually 0.1-0.3 s)
                    elif not self._cdone and self._fed != tid and now - self._cfirst < 0.6:
                        time.sleep(0.15)                             # the page still shows the last song's picture:
                        continue                                     # hold the new song back a moment for its own
                    NP.feed_external({"app": NP.EXT_APP, "appName": "QQ音乐",
                                      "title": title, "artist": artist, "album": d.get("album") or "",
                                      "dur": float(d.get("dur") or 0), "pos0": pos0,
                                      "lu": lu, "read_at": now, "playing": playing,
                                      "tid": tid, "timeline": True, "canSeek": True})
                    self._fed = tid
                else:
                    NP.clear_external()
            except Exception:
                if not self.alive:
                    break
            time.sleep(0.15)


QQ_WIN = QQWindow()


class WindowControls:
    """What a page's own window buttons call (window.pywebview.api.*): the main window's, and the QQ window's dots.
    `full`: that window's own full-screen flag."""
    def __init__(self, full=None):
        self._win = None
        self._was_max = False
        self._full = FULL if full is None else full

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
        on = not self._full["on"]
        if on:
            # from a maximised window: back to its normal size first, so that is what full screen returns to
            self._was_max = bool(user32.IsZoomed(hwnd))
            if self._was_max:
                self._win.restore()
            self._full["on"] = True
            self._win.toggle_fullscreen()
        else:
            self._win.toggle_fullscreen()

            def back():                          # pywebview squares the corners and hides the border, and leaves them so
                self._full["on"] = False
                for attr, val in ((33, 0), (34, 0xFFFFFFFF)):
                    v = ctypes.c_uint(val)
                    ctypes.windll.dwmapi.DwmSetWindowAttribute(ctypes.c_void_p(hwnd), attr, ctypes.byref(v), 4)
                user32.SetWindowPos(hwnd, None, 0, 0, 0, 0, 0x0020 | 0x0001 | 0x0002 | 0x0004 | 0x0010)
            form.Invoke(Action(back))
            if self._was_max:
                self._win.maximize()
        return on


class WindowApi(WindowControls):
    """The main window's: its buttons, and opening / closing the QQ web-player window (QQ 网页跟随)."""
    def qq_open(self):
        return QQ_WIN.open()

    def qq_close(self):
        QQ_WIN.close()
        return True

    def qq_is_open(self):
        return QQ_WIN.is_open()

    def qq_volume(self, v):
        return QQ_WIN.set_volume(v)


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
        dress_window(win)

    def on_loaded():
        if state["started"]:
            return
        state["started"] = True
        allow_drag(win)                          # lets the page mark its top strip as "drags the window"
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

    def on_closed():
        # the QQ windows (QQ 网页跟随) belong to this one: they close with it. pywebview only returns from start()
        # once every window is gone, so left open they kept the program (and the music) running
        try:
            QQ_WIN.close()
        except Exception as e:
            print("closing the QQ windows:", e)
        threading.Timer(2.0, lambda: os._exit(0)).start()      # should one of them not close, the program ends anyway

    win.events.shown += on_shown
    win.events.loaded += on_loaded
    win.events.resized += remember
    win.events.moved += remember
    win.events.closing += on_closing
    win.events.closed += on_closed
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
