"""The few QtCore names LDDC's lyrics core imports, as plain Python."""
import enum


class _Bound:
    def __init__(self):
        self._slots = []

    def connect(self, fn, *a, **k):
        self._slots.append(fn)

    def disconnect(self, fn=None):
        self._slots = [s for s in self._slots if fn is not None and s != fn]

    def emit(self, *args):
        for s in list(self._slots):
            s(*args)


class Signal:
    def __init__(self, *types, **kw):
        self._name = None

    def __set_name__(self, owner, name):
        self._name = "_sig_" + name

    def __get__(self, obj, owner=None):
        if obj is None:
            return self
        b = obj.__dict__.get(self._name)
        if b is None:
            b = obj.__dict__[self._name] = _Bound()
        return b


def Slot(*a, **k):
    return lambda fn: fn


class QObject:
    def __init__(self, parent=None):
        pass

    def tr(self, s, *a):
        return s


class QCoreApplication:
    @staticmethod
    def translate(context, text, *a):
        return text

    @staticmethod
    def instance():
        return None


class QtMsgType(enum.Enum):
    QtDebugMsg = 0
    QtWarningMsg = 1
    QtCriticalMsg = 2
    QtFatalMsg = 3
    QtInfoMsg = 4


class QMessageLogContext:
    file = function = category = None
    line = 0


class QLoggingCategory:
    @staticmethod
    def setFilterRules(rules):
        pass


def qInstallMessageHandler(handler):
    return None
