export {
  glideAt,
  glideKick,
};

/* ================= a glide that can be interrupted =================
   Something has been given a new place and should not jump there: it is drawn its old distance away (x) and that
   distance falls to nothing like a critically damped spring: off gently, quick in the middle, a long soft landing,
   never past the mark. Unlike an eased curve over a fixed time it has a speed, so when the place changes again while
   it is still under way (a switch clicked several times quickly) it carries on from where it is, at the speed it has,
   towards the new place: no jump, no stop and start.

   A glide is { x0, v0, at, wait, w }: the distance and speed it started with, when (ms), how long it stays put
   before it sets off (s, "the thing that pulls it moves first"), and how stiff it is (1/s; it is as good as there
   after about 6.5 / w seconds). */
const GLIDE_DONE = 0.02;                     // nearer than this (and slow): it has arrived
/* where it is at ms: { x: distance left, v: speed }, or null when it has arrived (or there is no glide) */
function glideAt(g, ms){
  if (!g) return null;
  const t = Math.max(0, (ms - g.at) / 1000 - g.wait), e = Math.exp(-g.w * t), c = g.v0 + g.w * g.x0;
  const x = (g.x0 + c * t) * e, v = (g.v0 - g.w * c * t) * e;
  return Math.abs(x) < GLIDE_DONE * g.unit && Math.abs(v) < GLIDE_DONE * g.unit * g.w ? null : { x, v };
}
/* the place moved by dx (old place minus new place) at ms: the glide that carries on from there. g: the glide under
   way, or null. A glide still waiting keeps what is left of its wait; one already moving does not wait again.
   unit: the size of one visible step of x (1 for pixels), for deciding when it has arrived. */
function glideKick(g, dx, ms, wait, w, unit = 1){
  const now = glideAt(g, ms), el = g ? (ms - g.at) / 1000 : 0;
  return { x0: (now ? now.x : 0) + dx, v0: now ? now.v : 0, at: ms, wait: !now ? wait : Math.max(0, g.wait - el), w, unit };
}
