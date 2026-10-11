"""
Stand-in for PySide6 (Qt, 215 MB), so LDDC's lyrics core runs without it.

LDDC is a Qt desktop program, but searching QQ Music / Kugou / NetEase and decoding their lyrics only touches a
handful of QtCore names (signals for its settings, a logging hook, a translate function); none of them has
anything to do with the lyrics. QtCore.py here gives those names as plain Python. lddc_bridge.py puts this folder
in front of sys.path, so it is used whether the real PySide6 is installed or not. LDDC's own window cannot run on
it, and is never opened from here.

tests/test_qt_stub.py checks that LDDC's lyrics core imports and converts on it.
"""
