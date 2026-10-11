/* ================= eased wheel scrolling =================
   A notch of the mouse wheel moves a panel in one short step. Here the wheel only sets where the panel should end
   up; every frame it then travels a fixed share of what is left, so it starts at once, slows down as it arrives,
   and several notches in a row run together into one motion. Frame-rate independent (the share is per time, not per
   frame).

   Left to the browser: touchpads and touch (they already scroll in many small steps with their own momentum),
   Ctrl + wheel, sideways scrolling, and anything that cannot scroll. Dragging the bar or using the keyboard while a
   glide is running simply takes over. */
const SCROLL_TAU = 0.11;                  // seconds for the distance left to shrink to 37 %: larger = lazier
const scrollGlide = new WeakMap();        // element -> { target, pos, raf, last }
/* where an eased scroll is after dt seconds: pos moves towards target */
function glideStep(pos, target, dt, tau){ return target + (pos - target) * Math.exp(-dt / tau); }
function scrollHost(el, dy){
  for (; el && el !== document.documentElement; el = el.parentElement){
    if (el.scrollHeight <= el.clientHeight + 1) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll') continue;
    if (dy < 0 ? el.scrollTop > 0 : el.scrollTop < el.scrollHeight - el.clientHeight - 1) return el;
  }
  return null;
}
if (typeof document !== 'undefined') addEventListener('wheel', e => {
  if (e.ctrlKey || e.defaultPrevented || !e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  // a touchpad sends many small pixel steps; a wheel sends lines, or pixel steps of a notch (100 or 120) or more
  if (e.deltaMode === 0 && Math.abs(e.deltaY) < 50) return;
  if (e.target.closest && e.target.closest('input[type=range], textarea')) return;
  const el = scrollHost(e.target, e.deltaY);
  if (!el) return;
  e.preventDefault();
  const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaMode === 2 ? e.deltaY * el.clientHeight * 0.9 : e.deltaY;
  let g = scrollGlide.get(el);
  if (!g){ g = { target: el.scrollTop, pos: el.scrollTop, raf: 0, last: 0 }; scrollGlide.set(el, g); }
  if (!g.raf){ g.target = g.pos = el.scrollTop; }
  g.target = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, g.target + dy));
  if (g.raf) return;
  g.last = performance.now();
  const frame = t => {
    g.raf = 0;
    if (Math.abs(el.scrollTop - g.pos) > 2) return;              // moved by something else (the bar, the keyboard): theirs now
    const dt = Math.min(0.05, (t - g.last) / 1000); g.last = t;
    g.pos = glideStep(g.pos, g.target, dt, SCROLL_TAU);
    if (Math.abs(g.target - g.pos) < 0.5) g.pos = g.target;
    el.scrollTop = g.pos;
    g.pos = Math.abs(el.scrollTop - g.pos) < 1.5 ? g.pos : el.scrollTop;   // keep the fraction the browser rounded away
    if (g.pos !== g.target) g.raf = requestAnimationFrame(frame);
  };
  g.raf = requestAnimationFrame(frame);
}, { passive: false });
