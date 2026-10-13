export {
  createSeekMotion,
};

/* A jump in time (a seek) in the scrolling layout, live only. The column is worked out from the time alone, so by
   itself it would jump with the time. Here every move starts from where the lines are shown at that moment, so
   nothing ever jumps. Two small state machines:

   1. The time the lines are shown at (the pointer on the progress bar)

        free  --press-->  pressed  --pointer moved-->  scrub  --let go, caught up-->  free
                             '--------let go-------------------------------------->  free

        free     the time given.
        pressed  the bar is pressed and the pointer has not moved yet: the lyrics wait (they stay at the time before
                 the press) until it is clear whether this is a click or a drag, a fraction of a second. Let go without
                 moving, it was a click: the next step sees the jump from the time before the press.
        scrub    the bar held and dragged: the shown time chases the bar's, quickly (scrubTau, the time the distance
                 left takes to shrink to 37 %), so the column runs along the song with the pointer, lines going by as
                 in a fast-forward. Let go, it finishes catching up.

   2. How the lines move

        rest   they are at their own places.
        drag   a jump of several lines (a click on the bar, the keyboard, the player jumping): the lyrics on the screen
               are dragged away and those of the new place dragged in right behind them, as at a song change: up and in
               from below going forward, down and in from above going back, one column.
        glide  a jump of a line or two: the lines go from where they are shown to their new places, as a line change
               moves them (the same duration and easing, the lines behind trailing: 拖拽感).

        any  --jump of `near` lines or more-->  drag    what is shown goes out from where it is, the new place comes in
                                                        right behind its last line
        any  --shorter jump-->                  glide   from where the lines are shown
        any  --scrub begins-->                  glide   a quick one, over what the lines still had to go (rest when
                                                        they were at their places)
        drag, glide  --arrived-->               rest
        any  --reset(), another layout-->       rest

      A jump is looked for only while the time is free: the time moved on much more than the clock did, or went back
      (by `jump` seconds or more; less, as a followed player gives when it has caught up with a jump, is none: the
      column moves on with the time, which is already smooth).

   Only one pair moves at a time: the place going out and the one coming in behind it. When anything else happens
   meanwhile, the place still on its way out melts away where it is (`melt`) instead of going on moving, where the
   lines now shown could run into it.

   Pure (no DOM, no clock of its own, no layout of its own): tests/test_seek.js runs it frame by frame. The layout
   comes with every step:
     geo = { key,                    whatever is the same as long as the layout is (another song, another size: another key)
             H, reach, gap,          px: the area's height; how far outside it a line is still drawn; between two lines
             tops(t), cur(t), h(j),  every line's top at time t (at rest); the current line's index; a line's height
             glide: { dur, lag, maxLag } }   seconds: how a line change moves the column */
const SEEK = {
  dur: 0.8, maxLag: 0.3,           // drag: seconds, and at most this much later for the last lines
  near: 3,                         // lines: a jump of fewer than this glides
  quick: { dur: 0.35, lag: 0.3 },  // the glide when the bar is taken hold of: seconds; the share of the usual trailing
  melt: 0.15,                      // seconds
  jump: 0.6,                       // seconds
  scrubTau: 0.06, caught: 0.03,    // seconds; caught: this close to the bar's time, the scrub is over
  slop: 3,                         // px the pointer may move while it is still a click
};

function createSeekMotion(ease, cfg = SEEK){
  const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
  let prev = null;                 // the last step { t: the time shown, goal: the time given, ms, key }
  let press = null;                // the bar pressed { t: the time to wait at, x, moved }
  let scrubT = null;               // scrub: the time shown
  /* drag:  { kind, at, s: 1 forward / -1 back, D: px the column is dragged, t, rest, o0, id }
            t, rest, o0, id: the place going out: its time, its lines' tops at rest and how far from them they were
            when it began, its column's number
     glide: { kind, at, off0: how far from its place every line was when it began, c, up, quick, byRest } */
  let motion = null;
  let ghosts = [];                 // places melting away { t, off, at, id }
  let ids = 0, liveId = 0;         // a number per column of lines, to follow a line from frame to frame (the tests)

  /* (drag) how far along a line is, by its place in the one column the two places make: pos in screens from the
     leading edge (the top going forward, the bottom going back). A line further back starts a little later, never
     earlier than one in front of it, so the column only stretches as it is dragged: the places stay one after the
     other. */
  const dragged = (m, pos, ms) =>
    ease(clamp01(((ms - m.at) / 1000 - Math.min(cfg.maxLag, Math.max(0, pos) * cfg.maxLag / 2)) / cfg.dur));
  const lead = (s, y, H) => s > 0 ? y / H : (H - y) / H;
  const pace = geo => motion.quick
    ? { dur: cfg.quick.dur, lag: geo.glide.lag * cfg.quick.lag, maxLag: geo.glide.maxLag * cfg.quick.lag } : geo.glide;
  /* how far the lines shown at time t are from their own places now (px, one per line); null: at rest */
  function liveOff(ms, geo, t){
    const m = motion;
    if (!m) return null;
    if (m.kind === 'drag') return geo.tops(t).map(y => m.s * m.D * (1 - dragged(m, lead(m.s, y + m.s * m.D, geo.H), ms)));
    const p = pace(geo);
    return m.off0.map((o, j) => {
      const lag = Math.max(0, Math.min(p.maxLag, (m.up ? j - m.c : m.c - j) * p.lag));      // the lines behind follow later
      return o * (1 - ease(clamp01(((ms - m.at) / 1000 - lag) / p.dur)));
    });
  }
  /* (drag) the same for the place going out */
  const outOff = (ms, H) => motion.rest.map((y, j) =>
    motion.o0[j] - motion.s * motion.D * dragged(motion, lead(motion.s, y + motion.o0[j], H), ms));
  function melt(ms, geo){
    if (motion && motion.kind === 'drag') ghosts.push({ t: motion.t, off: outOff(ms, geo.H), at: ms, id: motion.id });
  }
  const still = () => { motion = null; ghosts = []; };

  function jump(ms, geo, tFrom, tTo){
    const cFrom = Math.max(0, geo.cur(tFrom)), c = Math.max(0, geo.cur(tTo));
    const rest = geo.tops(tFrom), off = liveOff(ms, geo, tFrom) || rest.map(() => 0), now = geo.tops(tTo);
    const byRest = !!motion && (motion.kind === 'drag' || motion.byRest);
    melt(ms, geo);
    if (Math.abs(c - cFrom) >= cfg.near){
      // the new place comes in right behind the last line of what goes out, as it is shown now (a place only half in
      // yet reaches further than one screen): never over it
      const s = tTo > tFrom ? 1 : -1, drawn = (y, j) => y + geo.h(j) > -geo.reach && y < geo.H + geo.reach;
      let outEnd = -Infinity, inEnd = -Infinity;             // how far each reaches towards the other
      rest.forEach((y, j) => { if (drawn(y, j)) outEnd = Math.max(outEnd, s > 0 ? y + off[j] + geo.h(j) : -(y + off[j])); });
      now.forEach((y, j) => { if (drawn(y, j)) inEnd = Math.max(inEnd, s > 0 ? -y : y + geo.h(j)); });
      const D = isFinite(outEnd) && isFinite(inEnd) ? Math.max(geo.H, outEnd + inEnd + geo.gap) : geo.H;
      motion = { kind: 'drag', at: ms, s, D, t: tFrom, rest, o0: off, id: liveId };
      liveId = ++ids;
      return;
    }
    // up: the current line is shown lower than its place, so the column goes up
    motion = { kind: 'glide', at: ms, c, up: rest[c] + off[c] > now[c], quick: false, byRest,
      off0: now.map((y, j) => rest[j] + off[j] - y) };
  }
  /* the bar is taken hold of: the lines keep close to the pointer, so what they still had to go is done quickly */
  function grab(ms, geo, t){
    const m = motion, off = liveOff(ms, geo, t);
    melt(ms, geo);
    motion = m && { kind: 'glide', at: ms, off0: off, c: Math.max(0, geo.cur(t)), up: m.kind === 'drag' ? m.s > 0 : m.up,
      quick: true, byRest: m.kind === 'drag' || m.byRest };
  }

  const seek = {
    /* rest | pressed | scrub | drag | glide */
    get state(){ return scrubT != null || (press && press.moved) ? 'scrub' : press ? 'pressed' : motion ? motion.kind : 'rest'; },
    /* the progress bar: pressed at x, the pointer at x, let go */
    press(x){ press = { t: prev ? prev.t : null, x, moved: false }; },
    pointer(x){ if (press && !press.moved && Math.abs(x - press.x) > cfg.slop) press.moved = true; },
    release(){ press = null; },
    /* something else moves or replaces the column (a song change, a language change) */
    reset(){ still(); prev = null; scrubT = null; if (press) press.t = null; },
    /* once per frame with the song time t. calm: no moves wanted (prefers-reduced-motion). Returns what to draw:
         t       the time to draw the lines at
         live    how far every line is from its own place (px), or null
         byRest  the lines that take part are those on the screen at rest (a column being dragged); otherwise those
                 that are on the screen where they are now
         outs    places on their way out: { t, off, alpha, melting } (at most one of them moving; the others stay
                 where they were and melt away)
         busy    something is moving, or the bar is held */
    step(ms, t, geo, calm = false){
      if (prev && prev.key !== geo.key){ still(); prev = null; }
      const wall = prev ? (ms - prev.ms) / 1000 : 0;
      let shown = t;
      if ((press && press.moved) || scrubT != null){
        if (scrubT == null){
          scrubT = prev ? prev.t : t;
          if (calm) still(); else grab(ms, geo, scrubT);
        }
        // let go while the song plays on: the shown time goes on with it, or it would stay behind for good (chasing
        // a time that moves, the distance left never gets below what the song plays in scrubTau)
        const played = prev ? t - prev.goal : 0;
        if (!press && played > 0 && played <= wall * 1.25 + cfg.jump) scrubT += played;
        scrubT += (t - scrubT) * (1 - Math.exp(-wall / cfg.scrubTau));
        shown = scrubT;
        if (!press && Math.abs(t - scrubT) < cfg.caught){ scrubT = null; shown = t; }
      } else if (press){
        if (press.t == null) press.t = t;
        shown = press.t;
      } else if (prev && (t > prev.t + wall * 1.25 + cfg.jump || t < prev.t - cfg.jump)){
        if (calm) still(); else jump(ms, geo, prev.t, t);
      }
      prev = { t: shown, goal: t, ms, key: geo.key };
      if (motion){
        const p = motion.kind === 'drag' ? { dur: cfg.dur, maxLag: cfg.maxLag } : pace(geo);
        if ((ms - motion.at) / 1000 >= p.dur + p.maxLag) motion = null;
      }
      ghosts = ghosts.filter(g => (ms - g.at) / 1000 < cfg.melt);
      const outs = ghosts.map(g => ({ t: g.t, id: g.id, off: g.off, alpha: 1 - (ms - g.at) / 1000 / cfg.melt, melting: true }));
      if (motion && motion.kind === 'drag') outs.push({ t: motion.t, id: motion.id, off: outOff(ms, geo.H), alpha: 1, melting: false });
      return { t: shown, state: seek.state, live: liveOff(ms, geo, shown), id: liveId,
        byRest: !!motion && (motion.kind === 'drag' || motion.byRest), outs,
        busy: !!motion || outs.length > 0 || !!press || scrubT != null };
    },
  };
  return seek;
}
