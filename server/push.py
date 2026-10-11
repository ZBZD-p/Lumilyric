"""Tiny change hub: producers call notify(), the streaming HTTP handlers wake up and send what changed."""
import threading

_cond = threading.Condition()
_ver = {"np": 0, "bass": 0}


def notify(kind="np"):
    with _cond:
        _ver[kind] = _ver.get(kind, 0) + 1
        _cond.notify_all()


def version(kind):
    with _cond:
        return _ver.get(kind, 0)


def total():
    with _cond:
        return sum(_ver.values())


def wait(seen, timeout):
    """Block until something was notified after `seen` (a total() value) or the timeout; returns the new total."""
    with _cond:
        _cond.wait_for(lambda: sum(_ver.values()) != seen, timeout)
        return sum(_ver.values())
