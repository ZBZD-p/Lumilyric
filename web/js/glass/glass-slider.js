import { fx } from '../core/settings.js';
import { glassExtra, glassGL, glassKnob, glassKnobSeq, setGlassKnobSeq } from './glass.js';
import { springStep } from './seg-thumb.js';
import { TG_SPRING, lensApply, lensVeil } from './glass-toggle.js';

/* ================= sliders with a liquid-glass knob (the settings panel) =================
   The same idea as the on / off switches (glass-toggle.js), for <input type="range">. At rest: a thick rounded track,
   filled up to a white pill-shaped knob. Press it and the knob lifts into a drop of clear glass, larger than the
   track, with a watery bounce; drag it and it follows, stretching with its speed, the track and its fill bent inside
   it; let go and it turns back into the pill. The glass is drawn by the GPU layer and copied above the page, like
   the knob of a switch (see glass-toggle.js; without WebGL, the browser's lens there).

   The input itself stays: invisible, on top, taking the mouse, the keyboard and the value. What is seen (track, fill,
   knob) is drawn under it from its value, so everything the page does with the input goes on working. Its own thumb is
   as wide as the knob at rest, which makes the two travel the same distance.

   Two springs per slider, stepped only while something moves: pos (0 ... 1 along the track) and lift (0 = pill,
   1 = glass). */
const GS = { h: 24, kw: 26, kh: 16, lw: 38, lh: 26 };            // row height, knob at rest, knob lifted (css px)
function glassSlider(input){
  const wrap = document.createElement('span'), track = document.createElement('i'), fill = document.createElement('i'), knob = document.createElement('b');
  wrap.className = 'gs'; track.className = 'gst'; fill.className = 'gsf'; knob.className = 'tgk gsk';
  input.replaceWith(wrap); track.appendChild(fill); wrap.append(track, knob, input);
  const frac = () => { const a = +input.min || 0, b = input.max === '' ? 100 : +input.max; return b > a ? Math.max(0, Math.min(1, (+input.value - a) / (b - a))) : 0; };
  const pos = { x: frac(), v: 0 }, lift = { x: 0, v: 0 };
  let down = false, raf = 0, last = 0;
  const glassOn = () => fx.ui === 'glass';
  /* the track and its fill as a picture for the GPU glass (device pixels, a margin around the row); cur: the lifted knob */
  const UM = 16, uid = 'gs' + (setGlassKnobSeq(glassKnobSeq + 1)) + '-';
  let cur = null, und = null, undKey = '', undVer = 0;
  function under(dpr){
    const r = wrap.getBoundingClientRect(), W = wrap.clientWidth, fillTo = Math.round(cur.fill * 4) / 4, key = [r.left, r.top, W, dpr, fillTo].join(',');
    if (und && key === undKey) return und;
    undKey = key;
    const cv = (und && und.canvas) || document.createElement('canvas'), w = Math.round((W + 2 * UM) * dpr), h = Math.round((GS.h + 2 * UM) * dpr);
    if (cv.width !== w || cv.height !== h){ cv.width = w; cv.height = h; }
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W + 2 * UM, GS.h + 2 * UM);
    c.save(); c.beginPath(); c.roundRect(UM, UM + GS.h / 2 - 3, W, 6, 3); c.clip();                 // the track (style.css .gst): 6 px, rounded
    c.fillStyle = 'rgba(255,255,255,.16)'; c.fillRect(UM, UM, W, GS.h);
    c.fillStyle = '#fff'; c.fillRect(UM, UM, fillTo, GS.h);
    c.restore();
    return und = { canvas: cv, rect: [Math.round((r.left - UM) * dpr), Math.round((r.top - UM) * dpr), w, h], ver: uid + (++undVer) };
  }
  glassExtra.push(dpr => cur ? glassKnob(cur, under(dpr), dpr) : null);
  function draw(){
    const W = wrap.clientWidth;
    if (!W) return;                                               // the panel is not shown
    const travel = W - GS.kw, L = lift.x, Lc = Math.max(0, Math.min(1, L)), p = Math.max(-0.03, Math.min(1.03, pos.x));
    const glass = glassOn(), stretch = Math.min(0.3, Math.abs(pos.v) * travel / 900) * (0.35 + 0.65 * Lc);
    const gw = glass ? GS.lw : GS.kw * 1.08, gh = glass ? GS.lh : GS.kh * 1.12;
    const w = (GS.kw + (gw - GS.kw) * L) * (1 + stretch), h = Math.max(6, (GS.kh + (gh - GS.kh) * L) * (1 - stretch * 0.4));
    const cx = GS.kw / 2 + p * travel;
    knob.style.width = w + 'px'; knob.style.height = h + 'px';
    knob.style.transform = `translate(${cx - w / 2}px,${GS.h / 2 - h / 2}px)`;
    const gpu = glass && !!glassGL, lens = glass && !gpu;            // the GPU layer draws the lifted knob; without it, the browser's lens
    knob.style.backgroundColor = `rgba(255,255,255,${lens ? 1 - Lc * (1 - lensVeil()) : 1})`;      // a white knob; clear when lifted
    knob.style.opacity = gpu ? 1 - Lc : '';                         // ... or melting away as the glass comes up
    knob.classList.toggle('lifted', lens && Lc > 0.02);
    if (lens && Lc > 0.02) lensApply('gsLens', w, h, GS.lw, GS.lh, Lc);
    if (gpu && Lc > 0.01){ const r = wrap.getBoundingClientRect(); cur = { x: r.left + cx - w / 2, y: r.top + GS.h / 2 - h / 2, w, h, a: Lc, fill: Math.max(0, Math.min(W, cx)) }; } else cur = null;
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, cx / W)).toFixed(4)})`;
  }
  function frame(t){
    raf = 0;
    let dt = Math.min(0.05, (t - last) / 1000); last = t;
    const target = frac(), P = down ? TG_SPRING.follow : TG_SPRING.settle, Lp = down ? TG_SPRING.press : TG_SPRING.release;
    for (; dt > 0; dt -= 0.004){
      const h = Math.min(0.004, dt);
      springStep(pos, target, P[0], P[1], h);
      springStep(lift, down ? 1 : 0, Lp[0], Lp[1], h);
    }
    if (!down && Math.abs(pos.x - target) < 0.002 && Math.abs(pos.v) < 0.02 && Math.abs(lift.x) < 0.004 && Math.abs(lift.v) < 0.05){
      pos.x = target; pos.v = 0; lift.x = 0; lift.v = 0; draw();
      return;
    }
    draw();
    raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf){ last = performance.now(); raf = requestAnimationFrame(frame); } };
  const up = () => { if (!down) return; down = false; removeEventListener('pointerup', up, true); removeEventListener('pointercancel', up, true); kick(); };
  input.addEventListener('pointerdown', e => {
    if (e.button !== 0 || input.disabled) return;
    down = true; kick();
    addEventListener('pointerup', up, true); addEventListener('pointercancel', up, true);    // let go anywhere
  });
  input.addEventListener('input', kick);
  // the page also sets .value from code (the settings shown, restore defaults): that fires no event
  const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  Object.defineProperty(input, 'value', { get(){ return d.get.call(this); }, set(v){ d.set.call(this, v); kick(); }, configurable: true });
  new ResizeObserver(() => { if (!raf){ pos.x = frac(); draw(); } }).observe(wrap);            // shown, or the panel changed width
  draw();
}
if (typeof document !== 'undefined') document.querySelectorAll('#fxModal input[type=range]').forEach(glassSlider);
