"""
Probe: prints every Windows media session (SMTC) twice a second, so you can see which of your music players
show up, what they call themselves, and whether their position keeps moving. Also appended to
tools\nowplaying-probe.log - send that file back if something looks wrong. Ctrl+C to stop.

How to test (QQ Music, NetEase, Kugou, one at a time):
  1. Play a song in the player, run probe_nowplaying.bat.
  2. Note: does the player show up? its [app id]? is title - artist right?
  3. Leave it 10 s: does position change every time? how far is "推算" from the player's own clock?
  4. Pause, resume, drag the progress bar, next song: does PLAYING/PAUSED, position and title follow? how late?
"""
import asyncio
import os
import sys
import time
from datetime import datetime, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

LOG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools", "nowplaying-probe.log")
STATUS = {0: "CLOSED", 1: "OPENED", 2: "CHANGING", 3: "STOPPED", 4: "PLAYING", 5: "PAUSED"}


def hms(ts):
    return time.strftime("%H:%M:%S", time.localtime(ts)) + f".{int(ts % 1 * 1000):03d}"


async def main():
    try:
        from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager as Mgr
    except Exception as e:
        print("winrt 没装好：", e, "\n先运行 scripts\setup_nowplaying.bat")
        return
    mgr = await Mgr.request_async()
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    log = open(LOG, "a", encoding="utf-8")
    print("日志写入", LOG, "（Ctrl+C 退出）\n")
    while True:
        t = time.time()
        try:
            cur = mgr.get_current_session()
            cur_id = cur.source_app_user_model_id if cur else None
            sessions = list(mgr.get_sessions())
            print(f"{hms(t)}  当前会话: {cur_id}   会话数: {len(sessions)}")
            for s in sessions:
                try:
                    app = s.source_app_user_model_id
                    p = await s.try_get_media_properties_async()
                    tl = s.get_timeline_properties()
                    st = STATUS.get(int(s.get_playback_info().playback_status), "?")
                    pos, end, start = tl.position.total_seconds(), tl.end_time.total_seconds(), tl.start_time.total_seconds()
                    lu = tl.last_updated_time
                    ok = lu.year > 2000
                    ago = datetime.now(timezone.utc).timestamp() - lu.timestamp() if ok else None
                    est = pos + ago if ok and st == "PLAYING" else pos
                    print(f"{hms(t)}  [{app}]  {st}  {p.title} - {p.artist}  ({p.album_title})")
                    print(f"              position={pos:.2f}s  end={end - start:.2f}s  last_updated="
                          + (f"{lu.astimezone().strftime('%H:%M:%S.%f')[:-3]} ({ago:.2f}s ago)" if ok else "无效")
                          + f"  推算={est:.2f}s  controls=play:{s.get_playback_info().controls.is_play_enabled}"
                          f" seek:{s.get_playback_info().controls.is_playback_position_enabled}")
                    log.write(f"{t:.3f}\t{app}\t{st}\t{p.title}\t{p.artist}\t{p.album_title}\t{pos:.3f}\t{end - start:.3f}"
                              f"\t{lu.timestamp() if ok else 'invalid'}\n")
                except Exception as e:
                    print(f"{hms(t)}  读取会话出错：{type(e).__name__}: {e}")
            log.flush()
        except Exception as e:
            print(f"{hms(t)}  出错：{type(e).__name__}: {e}")
        await asyncio.sleep(0.5)


try:
    asyncio.run(main())
except KeyboardInterrupt:
    pass
