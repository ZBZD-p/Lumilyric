"""QQ 音乐网页跟随——控制桥。

桌面版另开一个 WebView2 窗口装 QQ 的网页播放器。QQ 网页用 Web Audio 播放，没有媒体元素、不进系统媒体
会话，所以系统那套 seek 看不到它；控制只能往那个窗口里注入点击。桌面端启动时用 register() 把这些注入
函数登记进来，nowplaying 把网页当成一个播放器喂进跟随管线，控制这个播放器时就落到这里的回调上：
  seek(pct)            跳到进度的几分之几
  control(action)      播放 / 暂停 / 上一首 / 下一首
  row(action, index)   播放列表的第几首：play 播放 / remove 移出列表 / open 在 QQ 窗口里打开它的页面
  mode(name)           播放模式：list 列表循环 / single 单曲循环 / random 随机播放 / order 顺序循环
桌面端不在时（纯源码 / 浏览器用法）回调为空，控制返回「仅桌面版可用」。"""

_HOOKS = {"seek": None, "control": None, "row": None, "mode": None}
ROW_ACTIONS = ("play", "remove", "open")
MODES = ("list", "single", "random", "order")


def register(seek=None, control=None, row=None, mode=None):
    _HOOKS.update(seek=seek, control=control, row=row, mode=mode)


def available():
    return _HOOKS["seek"] is not None


def _call(name, *args):
    h = _HOOKS[name]
    if not h:
        return {"ok": False, "reason": "仅桌面版可用"}
    try:
        return {"ok": bool(h(*args))}
    except Exception as e:
        return {"ok": False, "reason": f"{type(e).__name__}: {e}"[:200]}


def seek(pct):
    try:
        pct = max(0.0, min(1.0, float(pct)))
    except (TypeError, ValueError):
        return {"ok": False, "reason": "进度不对"}
    return _call("seek", pct)


def control(action):
    if action not in ("play", "pause", "next", "prev"):
        return {"ok": False, "reason": "不认识的操作"}
    return _call("control", action)


def row(action, index):
    if action not in ROW_ACTIONS:
        return {"ok": False, "reason": "不认识的操作"}
    try:
        index = int(index)
    except (TypeError, ValueError):
        return {"ok": False, "reason": "第几首不对"}
    return _call("row", action, index)


def mode(name):
    if name not in MODES:
        return {"ok": False, "reason": "不认识的播放模式"}
    return _call("mode", name)
