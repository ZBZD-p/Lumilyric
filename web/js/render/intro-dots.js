export {
  DOTS,
  introDots,
};

/* The three dots before the first line of a song with a long intro, as in Apple Music (scrolling layout). They stand
   where the current line stands, the lyrics one line lower:

   - they light up one after the other, each in its third of the wait, so all three are lit a moment before the end;
   - all three breathe together, slowly: bigger, a rest, smaller, a rest;
   - at the end they are at their biggest, shrink away in a moment, and the lyrics move up into their place just
     before the first line begins.

   Everything is a function of the song time, so a jump, a pause and the exported video all show the same thing.
   Pure (no DOM, no clock): tests/test_intro_dots.js. */
const DOTS = {
  min: 4,                    // s: a shorter intro has no dots
  out: 0.9, gone: 0.2,       // s before the first line they begin to go; s they take to go
  lead: 0.7,                 // s before the first line the lyrics begin to move up (as the dots have gone)
  full: 1.1,                 // s before they go, the time for lighting up ends (the last one is lit well before that)
  lit: 0.67,                 // the share of its third a dot takes to light up
  dim: 0.19,                 // a dot not lit yet
  in: 0.25,                  // s they take to appear when the song starts
  // one breath: up, at the top, down, at the bottom (what is left of the period). by: how much bigger at the top.
  // The breaths are counted back from the end: the last one reaches the top `last` s before the dots go, and stays
  breath: { period: 4, up: 1.2, top: 0.95, down: 1.15, by: 0.17, last: 1.3 },
  shrink: 0.25,              // how much smaller they are when they have gone
  size: 0.26, pitch: 0.43,   // of the font size: a dot's diameter, from one dot's middle to the next one's
  drop: 0.1,                 // of the font size: how far below the middle of their line they stand
};

const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const smooth = x => x * x * (3 - 2 * x);

/* the dots at song time t, the first line beginning at t1:
   null (none) or { alpha (all three), scale (all three, around the middle one), dots: [the three's own opacity] } */
function introDots(t, t1, C = DOTS){
  const end = t1 - C.out;                                    // they begin to go
  if (!(t1 >= C.min) || t <= 0 || t >= end + C.gone) return null;
  const third = Math.max(0.01, end - C.full) / 3;
  const dots = [0, 1, 2].map(k => C.dim + (1 - C.dim) * (1 - Math.pow(1 - clamp01((t - k * third) / (C.lit * third)), 1.6)));
  const B = C.breath, low = B.period - B.up - B.top - B.down;
  let s = 1;                                                 // 0 = smallest, 1 = biggest
  const v = end - B.last - t;                                // s before the last breath reaches the top
  if (v > 0){
    const u = v % B.period;
    s = u < B.up ? smooth(1 - u / B.up) : u < B.up + low ? 0 : u < B.up + low + B.down ? smooth((u - B.up - low) / B.down) : 1;
  }
  const g = smooth(clamp01((t - end) / C.gone));             // going
  return { alpha: clamp01(t / C.in) * (1 - g), scale: (1 + B.by * s) * (1 - C.shrink * g), dots };
}
