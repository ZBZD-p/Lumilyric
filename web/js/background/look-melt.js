export {
  createLookMelt,
};

/* The background's look (a 32 x 32 cover picture and a palette) melting into the next song's. The look being shown is
   always the interpolation between "where it was when the last target arrived" and the target, so a new target that
   arrives half way carries on from what is on screen instead of jumping, and the same target twice changes nothing.
   Pure (no GL, no DOM, no clock of its own): tests/test_look_melt.js checks it. */
function createLookMelt(ms = 1800){
  let from = null, to = null, t0 = 0;
  const ease = p => p * p * (3 - 2 * p);
  const same = (a, b) => {
    if (a.pix.length !== b.pix.length || a.pal.length !== b.pal.length || (a.st || 0) !== (b.st || 0)) return false;
    for (let i = 0; i < a.pix.length; i++) if (a.pix[i] !== b.pix[i]) return false;
    for (let i = 0; i < a.pal.length; i++) for (let k = 0; k < 3; k++) if (a.pal[i][k] !== b.pal[i][k]) return false;
    return true;
  };
  const mix = (A, B, k) => {
    const pix = new Uint8ClampedArray(B.pix.length);
    for (let i = 0; i < pix.length; i++) pix[i] = A.pix[i] + (B.pix[i] - A.pix[i]) * k;
    const n = Math.min(A.pal.length, B.pal.length);
    const a = A.st || 0, b = B.st || 0;                         // st: 0 = light pools, 1 = the cover itself (the style switch melts like a new song)
    return { pix, pal: B.pal.slice(0, n).map((c, i) => c.map((v, j) => A.pal[i][j] + (v - A.pal[i][j]) * k)), st: a + (b - a) * k };
  };
  return {
    /* a target look {pix, pal}: it is shown at once the first time, later ones are melted into from what is shown */
    set(look, now){
      if (to && same(to, look)) return false;
      from = to ? this.at(now) : look;
      to = look; t0 = now;
      return true;
    },
    /* the look to show at time `now`; returns the very same object once the melt is over (cheap identity check) */
    at(now){
      if (!to) return null;
      const p = (now - t0) / ms;
      return p >= 1 || from === to ? to : mix(from, to, ease(Math.max(0, p)));
    },
    busy(now){ return !!to && (now - t0) / ms < 1 && from !== to; },
  };
}
