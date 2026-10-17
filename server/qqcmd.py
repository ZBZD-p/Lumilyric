"""QQ音乐 (desktop) control through the player's own command line.

The system media session lets us read what QQ Music plays but not move it: it does not accept "jump to a position"
and has no volume. Its client has command line switches for that, though (the same ones its installer's shortcuts
use): `QQMusic.exe /seekto <seconds>` and `/volumeto <0-100>`. Started while QQ Music runs, that process hands the
request to the running one over its single-instance channel and exits at once (a few ms, no window), so every command
here is one short-lived process: ask rarely (the page sends once a slider is let go), and only while QQ Music is the
player being followed (started without a running one, the exe would open QQ Music).

Found out by the qqseek project (G:\\workspace\\qqmusic-seek); only the two switches are taken from it.
`/seekto` also starts a paused player.
"""
import os
import re
import subprocess
import sys
import time

EXE_NAME = "QQMusic.exe"
TIMEOUT = 5.0                          # the forwarding process normally exits in milliseconds
_RETRY = 30.0                          # seconds before looking again for an exe that was not found

_exe = None                            # the path found (cached)
_missed_at = 0.0


def _from_registry():
    try:
        import winreg
    except ImportError:
        return None
    keys = [(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Tencent\QQMusic"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Tencent\QQMusic"),
            (winreg.HKEY_CURRENT_USER, r"Software\Tencent\QQMusic")]
    for hive, sub in keys:
        try:
            with winreg.OpenKey(hive, sub) as k:
                folder = winreg.QueryValueEx(k, "Install")[0]
        except OSError:
            continue
        p = os.path.join(folder or "", EXE_NAME)
        if folder and os.path.isfile(p):
            return p
    return None


def _from_common_paths():
    env = os.environ.get
    for base in (r"C:\QQMusic", os.path.join(env("ProgramFiles(x86)", r"C:\Program Files (x86)"), "QQMusic"),
                 os.path.join(env("ProgramFiles", r"C:\Program Files"), "QQMusic"),
                 os.path.join(env("LOCALAPPDATA", ""), "QQMusic"), os.path.join(env("APPDATA", ""), "QQMusic")):
        p = os.path.join(base, EXE_NAME)
        if base and os.path.isfile(p):
            return p
    return None


def find_exe():
    """Path of QQMusic.exe, or None. QQSEEK_EXE names it when it sits somewhere unusual. Looked up once; one that was
    not found is looked for again only every half minute (this is called with every read of the media session)."""
    global _exe, _missed_at
    if _exe and os.path.isfile(_exe):
        return _exe
    if _missed_at and time.time() - _missed_at < _RETRY:
        return None
    given = os.environ.get("QQSEEK_EXE")
    _exe = given if given and os.path.isfile(given) else (_from_registry() or _from_common_paths())
    _missed_at = 0.0 if _exe else time.time()
    return _exe


def _run(switch, value):
    exe = find_exe()
    if not exe:
        return False, "找不到 QQMusic.exe（可以用环境变量 QQSEEK_EXE 指定）"
    try:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
        subprocess.run([exe, switch, str(value)], creationflags=flags, timeout=TIMEOUT, check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"[:200]
    return True, ""


def seek(seconds):
    """Jump to a place (whole seconds: the unit QQ Music was found to take)."""
    return _run("/seekto", max(0, int(round(float(seconds)))))


def volume(percent):
    """Set the volume, 0-100."""
    return _run("/volumeto", max(0, min(100, int(round(float(percent))))))


def play_song(songid, songtype=0):
    """Play the song with this number (`/playbysongid`: one song; a list of them would only play the first)."""
    return _run("/playbysongid", f"cmd_count==1&&id_0=={int(songid)}&&songtype_0=={int(songtype)}")


def favorite(songmid, on=True):
    """Put the song (its "mid", twelve letters and digits) in 我喜欢, or take it out: the player's own heart. Needs the
    player to be signed in; whether it took cannot be read back from here."""
    mid = str(songmid or "")
    if not re.fullmatch(r"[0-9A-Za-z]{8,20}", mid):
        return False, "歌曲编号不对"
    return _run("/favor" if on else "/unfavor", mid)

