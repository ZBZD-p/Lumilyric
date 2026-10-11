"""LDDC's lyrics core on the PySide6 stand-in (server/qt_stub). No network.
Run: tools\align-env\Scripts\python.exe tests\test_qt_stub.py"""
import importlib.util
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
fails = 0


def check(name, ok, extra=""):
    global fails
    fails += 0 if ok else 1
    print(("ok   " if ok else "FAIL ") + name + ("   " + extra if extra else ""))


# WinRT first: with the real Qt this order crashed the process
if importlib.util.find_spec("winrt") is not None:
    import winrt.windows.media.control  # noqa: F401

import lddc_bridge as LD  # noqa: E402
import PySide6  # noqa: E402
from PySide6.QtCore import QObject, Signal  # noqa: E402

check("the stand-in is the PySide6 that gets imported", "qt_stub" in (PySide6.__file__ or ""), PySide6.__file__ or "")


class Box(QObject):
    changed = Signal(int)


a, b, got = Box(), Box(), []
a.changed.connect(got.append)
a.changed.emit(3)
b.changed.emit(4)                           # another object: its own listeners
check("a signal reaches its own listeners only", got == [3], str(got))
a.changed.disconnect(got.append)
a.changed.emit(5)
check("disconnect works", got == [3], str(got))

if not LD.available():
    print("skip the LDDC part (LDDC is not installed)")
else:
    from LDDC.common.models import LyricsFormat, Source
    from LDDC.core.api.lyrics import get_lyrics, get_lyricslist, search  # noqa: F401
    from LDDC.core.converter import convert2  # noqa: F401
    from LDDC.core.parser.qrc import qrc2data  # noqa: F401
    from LDDC.core.parser.krc import krc2mdata  # noqa: F401
    from LDDC.core.decryptor import krc_decrypt, qrc_decrypt  # noqa: F401
    check("search, download, decrypt and convert import", True)
    check("source names are plain text", str(Source.QM) != "" and LyricsFormat.ENHANCEDLRC is not None)
    real = sorted(m for m in sys.modules if m.startswith("shiboken6") or (m.startswith("PySide6") and "qt_stub" not in (getattr(sys.modules[m], "__file__", "") or "")))
    check("nothing of the real Qt was loaded", not real, ", ".join(real))

print("\n%d problems" % fails if fails else "\nall passed")
sys.exit(1 if fails else 0)
