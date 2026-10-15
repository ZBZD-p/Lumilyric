"""QQ Music's command line (server/qqcmd.py) and what nowplaying.control does with it, against a stand-in program that
writes down its arguments. Nothing is sent to a real QQ Music. Run: python tests/test_qqcmd.py"""
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "server"))

tmp = tempfile.mkdtemp(prefix="lrc-qqcmd-test-")
log = os.path.join(tmp, "calls.txt")
exe = os.path.join(tmp, "QQMusic.exe.bat")
with open(exe, "w") as f:
    f.write(f"@echo %1 %2 >> \"{log}\"\r\n")      # (a space before >>: "0>>" would be a redirect of handle 0)
os.environ["QQSEEK_EXE"] = exe

import qqcmd  # noqa: E402
qqcmd._from_registry = qqcmd._from_common_paths = lambda: None      # never reach a real QQ Music installed here
import nowplaying as NP  # noqa: E402

fails = []


def check(name, cond, info=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else "  " + str(info)))
    if not cond:
        fails.append(name)


def calls():
    try:
        with open(log) as f:
            return [x.strip() for x in f.read().splitlines() if x.strip()]
    except OSError:
        return []


check("the exe named by QQSEEK_EXE is the one used", qqcmd.find_exe() == exe, qqcmd.find_exe())

ok, why = qqcmd.seek(61.6)
check("seek: whole seconds, rounded", ok and calls() == ["/seekto 62"], calls())
ok, why = qqcmd.seek(-5)
check("seek: never below 0", ok and calls()[-1] == "/seekto 0", calls())
ok, why = qqcmd.volume(55.4)
check("volume: whole percent", ok and calls()[-1] == "/volumeto 55", calls())
qqcmd.volume(150)
qqcmd.volume(-3)
check("volume: kept within 0-100", calls()[-2:] == ["/volumeto 100", "/volumeto 0"], calls())

check("QQ Music program is told from the web player", NP.is_qq_desktop("QQMusic.exe") and not NP.is_qq_desktop(NP.EXT_APP)
      and not NP.is_qq_desktop("cloudmusic.exe") and not NP.is_qq_desktop(""))

qqcmd._exe = None
os.environ["QQSEEK_EXE"] = os.path.join(tmp, "nothing.exe")
qqcmd._missed_at = 0.0
ok, why = qqcmd.seek(10)
check("no exe: reported, not raised", ok is False and "QQMusic.exe" in why, (ok, why))

before = len(calls())
res = NP._qq_command("QQMusic.exe", "volume", "abc")
check("a value that is no number is refused", res["ok"] is False and len(calls()) == before, res)
os.environ["QQSEEK_EXE"] = exe
qqcmd._missed_at = 0.0
res = NP._qq_command("QQMusic.exe", "volume", 30)
check("control volume goes to the command line", res["ok"] is True and calls()[-1] == "/volumeto 30", (res, calls()))
res = NP._qq_command("QQMusic.exe", "seek", 90)
time.sleep(0.2)
check("control seek goes to the command line", res["ok"] is True and calls()[-1] == "/seekto 90", (res, calls()))

print("\n" + ("all passed" if not fails else f"{len(fails)} failed: {fails}"))
sys.exit(1 if fails else 0)
