"""Song-change handling of track_state.PlayerState, with a fake clock. Run: python tests/test_track_state.py"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server"))
from track_state import PlayerState  # noqa: E402

fails = []


def check(name, cond, info=""):
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else "  " + str(info)))
    if not cond:
        fails.append(name)


def raw(tid, pos0, lu, dur=200.0, playing=True, timeline=True):
    return {"tid": tid, "pos0": pos0, "lu": lu, "dur": dur, "playing": playing, "timeline": timeline, "read_at": lu}


def play(st, t0, t1, tid, start_pos, dur=200.0, step=0.25):
    """The player reports truthfully from start_pos at t0."""
    t = t0
    while t <= t1 + 1e-9:
        st.update(raw(tid, start_pos, t0, dur), t)
        t += step


# 1. QQ behaviour: new title at t=100, timeline stamped fresh but still the old end position for 1.5 s
st = PlayerState()
play(st, 0, 99.75, "A", 0.0, 230.0)                 # song A plays from t=0
now = 100.0
for k in range(6):                                  # t = 100 .. 101.25: title is B, position still A's end
    t = now + k * 0.25
    st.update(raw("B", 228.0, t, 230.0), t)
    check(f"stale at +{k * 0.25:.2f}s: not settled", not st.settled)
    check(f"stale at +{k * 0.25:.2f}s: position is the time since the change",
          abs(st.position(t) - k * 0.25) < 0.01, st.position(t))
t = 101.5
st.update(raw("B", 0.3, t, 200.0), t)               # the timeline catches up
check("settles when the position becomes plausible", st.settled)
check("then the real position is used", abs(st.position(t + 1) - 1.3) < 0.01, st.position(t + 1))

# 2. cut mid-song (A was at 80 s)
st = PlayerState()
play(st, 0, 80, "A", 0.0, 230.0)
t = 80.5
st.update(raw("B", 80.0, 80.3, 230.0), t)
check("mid-song cut: not settled, position ~0", (not st.settled) and st.position(t) < 0.6, st.position(t))
check("mid-song cut: length equal to the previous one is hidden", st.duration(t) == 0.0)
t = 82.0
st.update(raw("B", 0.5, 81.8, 200.0), t)
check("mid-song cut: settles", st.settled and abs(st.position(t) - 0.7) < 0.01, st.position(t))
check("mid-song cut: the new length is shown", st.duration(t) == 200.0)

# 3. cut very early (A at 0.8 s): the stale number is itself plausible, error stays small
st = PlayerState()
play(st, 0, 0.8, "A", 0.0, 230.0)
t = 1.0
st.update(raw("B", 0.8, 0.9, 230.0), t)
check("early cut: error under 1.5 s", st.position(t) < 1.5, st.position(t))

# 4. first sight in the middle of a song: believed at once
st = PlayerState()
st.update(raw("A", 120.0, 500.0, 230.0), 500.2)
check("first sight: settled", st.settled)
check("first sight: real position", abs(st.position(500.2) - 120.2) < 0.01, st.position(500.2))

# 5. paused at the change
st = PlayerState()
play(st, 0, 50, "A", 0.0, 230.0)
st.update(raw("B", 49.0, 50.5, 230.0, playing=False), 50.6)
check("paused change: position 0 until settled", (not st.settled) and st.position(50.6) == 0.0)

# 6. a player that never corrects itself: trusted after SETTLE_MAX
st = PlayerState()
play(st, 0, 50, "A", 0.0, 230.0)
for k in range(40):
    t = 50.5 + k * 0.25
    st.update(raw("B", 150.0, 50.5, 230.0), t)
check("never-corrected player is trusted after 6 s", st.settled)

# 7. no timeline (Kugou): own clock from the change, pause-aware, calibrate
st = PlayerState()
st.update(raw("A", 0.0, None, 0.0, timeline=False), 0.0)
st.update(raw("B", 0.0, None, 0.0, timeline=False), 10.0)
check("no timeline: settled, starts at 0", st.settled and st.position(10.0) < 0.01)
st.update(raw("B", 0.0, None, 0.0, timeline=False), 15.0)
check("no timeline: counts", abs(st.position(15.0) - 5.0) < 0.01, st.position(15.0))
st.update(raw("B", 0.0, None, 0.0, playing=False, timeline=False), 16.0)
check("no timeline: pause holds", abs(st.position(20.0) - 6.0) < 0.01, st.position(20.0))
st.update(raw("B", 0.0, None, 0.0, timeline=False), 20.0)
st.update(raw("B", 0.0, None, 0.0, timeline=False), 22.0)
check("no timeline: resume continues", abs(st.position(22.0) - 8.0) < 0.01, st.position(22.0))
check("no timeline: calibrate", st.calibrate("B", 100.0, 22.0) and abs(st.position(23.0) - 101.0) < 0.01)
check("no timeline: calibrate for another song is refused", not st.calibrate("A", 5.0, 23.0))

# 8. the same song again right after (replay): same id, nothing to settle
st = PlayerState()
play(st, 0, 30, "A", 0.0, 230.0)
st.update(raw("A", 0.0, 31.0, 230.0), 31.0)
check("replay: position follows the player", abs(st.position(32.0) - 1.0) < 0.01, st.position(32.0))

# 9. pause and resume, as QQ Music was recorded doing it (2026-10-10; times in seconds, positions in the song):
#    while playing it restamps its position about three times a second; when it is paused or resumed the STATUS
#    changes at once but the position stamp is the old one for a while:
#      12.05  status PAUSE, position still "150.72 as of 0.25 s ago"       (really at about 150.95)
#      13.78  position restamped: 150.95
#      94.00  status PLAY, position still "150.95 as of 13.78"             (80 s old: the length of the pause)
#      95.06  position restamped: 152.01
def r9(pos0, lu, playing, at):
    d = raw("Q", pos0, lu, 230.0, playing)
    d["read_at"] = at
    return d


st = PlayerState()
st.update(r9(150.40, 11.48, True, 11.50), 11.50)
st.update(r9(150.72, 11.80, True, 11.82), 11.82)
check("playing: position runs on from the last stamp", abs(st.position(12.00) - 150.92) < 0.01, st.position(12.00))
st.update(r9(150.72, 11.80, False, 12.05), 12.05)          # paused; the stamp is 0.25 s old
check("pause: stops where it was showing, not back at the old stamp", abs(st.position(12.05) - 150.97) < 0.02, st.position(12.05))
check("pause: holds", abs(st.position(13.50) - 150.97) < 0.02, st.position(13.50))
st.update(r9(150.95, 13.78, False, 13.80), 13.80)          # the player's own paused position arrives
check("pause: then the player's own figure", abs(st.position(13.80) - 150.95) < 0.001, st.position(13.80))
check("pause: correction is tiny", abs(150.97 - 150.95) < 0.05)
st.update(r9(150.95, 13.78, True, 94.00), 94.00)           # resumed; the stamp is from before the pause
check("resume: does not jump ahead by the length of the pause", abs(st.position(94.00) - 150.95) < 0.01, st.position(94.00))
check("resume: counts from the moment it resumed", abs(st.position(94.80) - 151.75) < 0.01, st.position(94.80))
st.update(r9(152.01, 95.06, True, 95.08), 95.08)           # first fresh stamp after resuming
check("resume: the fresh stamp agrees with what was shown", abs(st.position(95.08) - 152.03) < 0.01 and abs((150.95 + 95.08 - 94.00) - 152.03) < 0.05, st.position(95.08))
st.update(r9(153.00, 96.05, True, 96.06), 96.06)
check("playing again: back to the player's stamps", abs(st.position(96.50) - 153.45) < 0.01, st.position(96.50))

# 9b. paused when first seen, then played: same rule
st = PlayerState()
st.update(r9(40.0, 5.0, False, 100.0), 100.0)
check("first seen paused: the stamp", abs(st.position(120.0) - 40.0) < 0.001, st.position(120.0))
st.update(r9(40.0, 5.0, True, 130.0), 130.0)
check("first seen paused, then played: from 40, not 40 + 125", abs(st.position(131.0) - 41.0) < 0.01, st.position(131.0))

# 9c. already playing when first seen (no resume watched): the stamp is trusted, as before
st = PlayerState()
st.update(r9(60.0, 200.0, True, 203.0), 203.0)
check("first seen playing: stamp plus its age", abs(st.position(204.0) - 64.0) < 0.01, st.position(204.0))

# 9d. the pause comes together with a fresh stamp: that figure is used at once
st = PlayerState()
st.update(r9(10.0, 300.0, True, 300.0), 300.0)
st.update(r9(12.5, 302.5, False, 302.55), 302.55)
check("pause with its own stamp: exact", abs(st.position(303.0) - 12.5) < 0.001, st.position(303.0))

# 9e. a new song while paused, then play: nothing of the old song's pause is left
st = PlayerState()
st.update(r9(10.0, 400.0, True, 400.0), 400.0)
st.update(r9(11.0, 401.0, False, 401.3), 401.3)
d = raw("NEXT", 0.0, 410.0, 180.0, True); d["read_at"] = 410.0
st.update(d, 410.0)
check("new song after a pause: starts from its own beginning", st.position(411.0) < 1.6, st.position(411.0))

print("\n%d failed" % len(fails) if fails else "\nall passed")
sys.exit(1 if fails else 0)
