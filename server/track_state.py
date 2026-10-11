"""
What one desktop player is playing, and how far it is: the part of "follow the player" that has to be right.

Players do not change everything at once when the song changes: the title comes first, the length and the
position follow a moment later (and the cover later still). Right after a change the numbers are still the
previous song's. One rule covers all of it:

    A song is SETTLED once the player's position is plausible for a song that started when we saw the change
    (not further along than the time since the change, plus a little slack), or after SETTLE_MAX seconds.
    Until then the position is "the time since the change" and the length is unknown if it equals the
    previous song's.

Pausing and resuming have the same kind of lag (recorded from QQ Music, see tests/test_track_state.py, part 9):
the STATUS changes at once, the position stamp ("P seconds, as of time T") is refreshed about a second later.
    - Resumed: the stamp is still the one from before the pause, so "P + time since T" would be ahead by the whole
      length of the pause. The position counts from the moment the resume was seen instead, until a fresh stamp.
    - Paused: the stamp can be a third of a second old, so "P" would be behind what was just on screen. The
      position stops where it was showing, until the player stamps its own paused position.

Pure Python, no WinRT and no threads: server/nowplaying.py feeds it raw reads, tests/test_track_state.py checks it.
"""

SETTLE_MAX = 6.0          # seconds after a change when the player's numbers are trusted whatever they say
POS_SLACK = 1.5           # a position this much beyond the time since the change is still plausible


class Track:
    """One song on one player, from the moment it was first seen."""

    def __init__(self, tid, now, changed, prev_dur):
        self.tid = tid
        self.seen = now
        self.changed = changed            # we watched it start (False: it was already playing when we first looked)
        self.prev_dur = prev_dur          # the previous song's length, to recognise a length that is not updated yet
        self.settled = not changed
        # self-timed clock for players that give no position at all (Kugou)
        self.soft_pos = 0.0
        self.soft_t = now
        self.soft_playing = None
        # pause / resume seen on this song (players with a timeline)
        self.play_since = None            # when it was seen to resume: an older stamp must not count the pause as playing
        self.pause_pos = None             # where it was showing when it was seen to pause ...
        self.pause_lu = None              # ... valid for as long as the stamp is still this one


class PlayerState:
    """Feed raw reads with update(); ask position(), duration(), settled at any time."""

    def __init__(self):
        self.track = None
        self.raw = None                   # the latest raw read

    # -- input
    def update(self, raw, now):
        """raw: {tid, playing, pos0, lu, dur, timeline}; pos0 is the position as of lu (None: unknown)."""
        t = self.track
        if t is None or t.tid != raw["tid"]:
            prev_dur = self.raw["dur"] if (t is not None and self.raw) else None
            t = self.track = Track(raw["tid"], now, changed=t is not None, prev_dur=prev_dur)
        elif self.raw is not None and raw["timeline"] and self.raw["timeline"]:
            was = self.raw["playing"]
            if raw["playing"] and not was:
                t.play_since, t.pause_pos = now, None
            elif was and not raw["playing"]:
                t.pause_pos, t.pause_lu = self._reported(now), self.raw["lu"]     # from the read before: what was showing
        self.raw = raw
        if not raw["timeline"]:
            # no timeline to be stale: count from the change, pause-aware (calibrate() can set it)
            if t.soft_playing:
                t.soft_pos += now - t.soft_t
            t.soft_t, t.soft_playing = now, raw["playing"]
            t.settled = True
            return
        if not t.settled:
            elapsed = now - t.seen
            if self._reported(now) <= elapsed + POS_SLACK or elapsed > SETTLE_MAX:
                t.settled = True

    def calibrate(self, tid, position, now):
        t = self.track
        if t is None or t.tid != tid:
            return False
        t.soft_pos, t.soft_t = max(0.0, float(position)), now
        return True

    # -- output
    def _reported(self, now):
        """The player's own position at `now`, as it reports it."""
        r, t = self.raw, self.track
        pos = r["pos0"]
        if r["playing"]:
            ref = r["lu"] if r["lu"] is not None else r.get("read_at", now)
            if t is not None and t.play_since is not None:
                ref = max(ref, t.play_since)          # a stamp from before the pause: only the time since resuming counts
            pos += max(0.0, now - ref)
        elif t is not None and t.pause_pos is not None and r["lu"] == t.pause_lu:
            pos = t.pause_pos                         # paused, and the player has not stamped its paused position yet
        return pos

    @property
    def settled(self):
        return bool(self.track and self.track.settled)

    def duration(self, now):
        r, t = self.raw, self.track
        if r is None:
            return 0.0
        if not t.settled and t.prev_dur and abs(r["dur"] - t.prev_dur) < 0.5:
            return 0.0                    # still the previous song's length
        return r["dur"]

    def position(self, now):
        r, t = self.raw, self.track
        if r is None:
            return 0.0
        if not r["timeline"]:
            pos = t.soft_pos + ((now - t.soft_t) if t.soft_playing else 0.0)
        elif t.settled:
            pos = self._reported(now)
        else:
            pos = max(0.0, now - t.seen) if r["playing"] else 0.0
        d = self.duration(now)
        if d > 0:
            pos = min(pos, d)
        return max(0.0, pos)
