"""The event subscription must be idempotent (a bug here once exhausted the process's memory). Run: python tests/test_subscribe.py"""
import os
import sys

os.environ.pop("LRC_NOWPLAYING_MOCK", None)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
import nowplaying as NP  # noqa: E402

fails = []


def check(name, cond, info=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else "  " + str(info)))
    if not cond:
        fails.append(name)


class Loop:
    def call_soon_threadsafe(self, fn): fn()


class Wake:
    n = 0
    def set(self): Wake.n += 1


class Session:
    """Like WinRT: every get_sessions() call hands out a NEW wrapper for the same session."""
    handlers = {}                           # app -> number of handlers registered on the real session
    def __init__(self, app): self.source_app_user_model_id = app
    def _add(self, ev, fn): Session.handlers[self.source_app_user_model_id] = Session.handlers.get(self.source_app_user_model_id, 0) + 1
    def add_playback_info_changed(self, fn): self._add("p", fn)
    def add_media_properties_changed(self, fn): self._add("m", fn)
    def add_timeline_properties_changed(self, fn): self._add("t", fn)


class Mgr:
    apps = ["QQMusic.exe", "kugou"]
    calls = 0
    def add_sessions_changed(self, fn): Mgr.calls += 1
    def add_current_session_changed(self, fn): Mgr.calls += 1
    def get_sessions(self): return [Session(a) for a in Mgr.apps]


mgr, subs = Mgr(), {}
for _ in range(500):                        # 500 read cycles
    NP._subscribe(mgr, None, Loop(), subs)
check("manager events registered once", Mgr.calls == 2, Mgr.calls)
check("each session has exactly 3 handlers after 500 cycles", set(Session.handlers.values()) == {3}, Session.handlers)

Mgr.apps = ["QQMusic.exe"]                  # kugou closes
NP._subscribe(mgr, None, Loop(), subs)
Mgr.apps = ["QQMusic.exe", "kugou"]         # and comes back: subscribed again, once
for _ in range(50):
    NP._subscribe(mgr, None, Loop(), subs)
check("a session that came back is subscribed again (once)", Session.handlers["kugou"] == 6 and Session.handlers["QQMusic.exe"] == 3, Session.handlers)


class Broken(Mgr):
    calls2 = 0
    def add_sessions_changed(self, fn): Broken.calls2 += 1; raise MemoryError("bad allocation")


b, subs2 = Broken(), {}
for _ in range(100):
    NP._subscribe(b, None, Loop(), subs2)
check("a failing subscription is not retried every cycle", Broken.calls2 == 1, Broken.calls2)

print("\n%d failed" % len(fails) if fails else "\nall passed")
sys.exit(1 if fails else 0)
