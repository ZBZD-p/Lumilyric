import { late } from '../core/late.js';
import { fx } from '../core/settings.js';
import { GLASS_DRAWER, GLASS_LOOK, glassExtra, glassGL, glassKnobSeq, setGlassKnobSeq } from './glass.js';

export {
  springStep,
};

/* ================= the sliding thumb of a segmented switch (English / 中文 / 双语) =================
   Like the switches of Apple's Liquid Glass: at rest the chosen segment has a plain white pill behind it. Press
   the switch and the pill lifts into a drop of glass, a little larger than the switch, with a watery bounce; it
   follows the finger, stretching in the direction it moves and getting flatter the faster it goes; let go and it
   settles on the nearest segment, bounces once and turns back into the pill.

   Everything is three springs stepped every frame while something moves (nothing runs at rest):
     pos   where the thumb's centre is            (follows the pointer, or the chosen segment)
     wid   how wide it is                          (the width of the segment under it)
     lift  0 = white pill ... 1 = lifted glass     (springy: it overshoots, that is the bounce)
   The glass itself is drawn by the GPU layer (glass.js, glassExtra); with the plain interface there is no glass and
   the pill only grows a little, stretches and slides.

   The words under the glass are bent by it too. The page's own text cannot be refracted (it is not in any picture
   the GPU has), so while the thumb is lifted the labels are copied once to a small canvas (white, as text under the
   glass is), the page's labels fade out, and the GPU layer shows the copy instead: plain and dimmed outside the
   glass, refracted through it inside. When the thumb comes down the page's labels fade back in.

   The switches of the settings panel (opts.lens) lie on a card above the GPU layer. Their glass is drawn by that layer
   all the same and copied above the card (over: true, see glassOver in glass.js), so it is the very same glass.
   Without WebGL the lifted thumb is a page element with the browser's backdrop filter instead (the lens of
   glass-toggle.js), laid over the labels: it bends them too, but without smoothing, so the words get jagged.
   Those switches may also wrap onto several rows: the thumb moves in both directions (posY) and stays on the row
   under the finger. */
const SEG_SPRING = {
  follow: [700, 40],        // stiffness, damping of pos while it is held
  settle: [380, 24],        // ... after it is let go (bounces once)
  width: [420, 30],
  press: [380, 15],         // lift going up: clearly under-damped
  release: [320, 22],
};
function springStep(s, target, k, c, dt){
  s.v += (-k * (s.x - target) - c * s.v) * dt;
  s.x += s.v * dt;
}
/* the shape of the thumb from the springs: {w, h} for a segment g = {w, h} inside a switch segH tall */
function thumbShape(g, segH, lift, speed, glass){
  const L = lift, Lc = Math.max(0, Math.min(1, L));
  const stretch = Math.min(0.3, Math.abs(speed) / 2500) * (0.35 + 0.65 * Lc);
  const grow = glass ? segH * 1.5 / g.h - 1 : 0.1;                  // lifted glass is taller than the switch itself
  return { w: g.w * (1 + (glass ? 0.24 : 0.04) * L) * (1 + stretch), h: Math.max(4, g.h * (1 + grow * L) * (1 - stretch * 0.45)) };
}
function segThumb(seg, opts = {}){
  const btns = [...seg.querySelectorAll('button')];
  if (btns.length < 2) return;
  const thumb = document.createElement('i');
  thumb.className = 'segthumb'; thumb.setAttribute('aria-hidden', 'true');
  seg.prepend(thumb); seg.classList.add('thumbed');
  const pos = { x: 0, v: 0 }, posY = { x: 0, v: 0 }, wid = { x: 0, v: 0 }, lift = { x: 0, v: 0 };
  let down = false, px = 0, py = 0, grab = 0, raf = 0, last = 0, cur = null;
  /* the labels as a picture for the glass: white text where the page has it, device pixels, a margin around the switch */
  const OV_M = 28;
  let ovl = null, ovlKey = '', ovlVer = 0;
  const uid = 'seg' + (setGlassKnobSeq(glassKnobSeq + 1)) + '-';         // the GPU layer keeps the last picture it was given, by this name: it must differ per switch
  function labels(dpr){
    const s = seg.getBoundingClientRect();
    const key = [s.left, s.top, s.width, s.height, dpr, btns.map(b => b.textContent).join('|')].join(',');
    if (ovl && key === ovlKey) return ovl;
    ovlKey = key;
    const cv = (ovl && ovl.canvas) || document.createElement('canvas');
    const w = Math.round((s.width + 2 * OV_M) * dpr), h = Math.round((s.height + 2 * OV_M) * dpr);
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    for (const b of btns){
      const r = b.getBoundingClientRect(), st = getComputedStyle(b);
      c.font = `${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
      const m = c.measureText(b.textContent.trim());              // centred on the glyph box, as the page lays it out
      const y = r.top - s.top + OV_M + r.height / 2 + (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2;
      c.fillText(b.textContent.trim(), r.left - s.left + OV_M + r.width / 2, y);
    }
    return ovl = { canvas: cv, rect: [Math.round((s.left - OV_M) * dpr), Math.round((s.top - OV_M) * dpr), w, h], ver: uid + (++ovlVer) };
  }
  const pressed = () => btns.find(b => b.getAttribute('aria-pressed') === 'true') || btns[0];
  // layout sizes, not what is on screen: the settings card is scaled while it slides in, and the thumb is scaled with it
  const geo = b => ({ cx: b.offsetLeft + seg.clientLeft + b.offsetWidth / 2, cy: b.offsetTop + seg.clientTop + b.offsetHeight / 2, w: b.offsetWidth, h: b.offsetHeight });
  const shown = () => { const v = btns.filter(b => b.offsetWidth > 0); return v.length ? v : btns; };
  const nearest = (x, y) => shown().reduce((a, b) => { const A = geo(a), B = geo(b); return Math.hypot(B.cx - x, (B.cy - y) * 3) < Math.hypot(A.cx - x, (A.cy - y) * 3) ? b : a; });   // the row first
  const row = y => { const all = shown(), cy = geo(all.reduce((a, b) => Math.abs(geo(b).cy - y) < Math.abs(geo(a).cy - y) ? b : a)).cy; return all.filter(b => Math.abs(geo(b).cy - cy) < 3); };
  const clampX = (x, y) => { const R = row(y); return Math.max(geo(R[0]).cx, Math.min(geo(R[R.length - 1]).cx, x)); };
  const glassOn = () => fx.ui === 'glass' && !!glassGL;
  const lensOn = () => !!opts.lens && fx.ui === 'glass' && !glassGL;
  function draw(){
    const s = seg.getBoundingClientRect(), near = nearest(pos.x, posY.x), g = geo(near), glass = glassOn(), lens = lensOn();
    const Lc = Math.max(0, Math.min(1, lift.x));
    const segH = opts.lens ? g.h + 2 * (seg.clientLeft + parseFloat(getComputedStyle(seg).paddingLeft)) : s.height;   // one row of the panel's switch: the same lift as the language switch
    const { w, h } = thumbShape({ w: wid.x, h: g.h }, segH, lift.x, Math.hypot(pos.v, posY.v), glass || lens);
    const left = pos.x - w / 2, top = posY.x - h / 2;
    thumb.style.width = w + 'px'; thumb.style.height = h + 'px';
    thumb.style.transform = `translate(${left - seg.clientLeft}px,${top - seg.clientTop}px)`;
    thumb.style.opacity = glass ? 1 - Lc : 1;                     // the pill melts away as the glass comes up
    cur = glass && Lc > 0.01 ? { x: s.left + left, y: s.top + top, w, h, a: Lc } : null;
    if (opts.lens){                                               // the browser's lens: clear, over the labels, bending them
      const up = lens && Lc > 0.02;
      thumb.style.backgroundColor = lens ? `rgba(255,255,255,${(0.88 * (1 - Lc) + (up ? Lc * late.lensVeil() : 0)).toFixed(3)})` : '';      // (the lens is in glass-toggle.js, loaded after this file: only asked for once lifted)
      thumb.classList.toggle('lifted', up); thumb.style.zIndex = up ? 2 : '';
      if (up){ const n = thumbShape({ w: wid.x, h: g.h }, segH, 1, 0, true); late.lensApply('sgLens', w, h, n.w, n.h, Lc, true); }       // bends like the language switch's thumb (glassExtra below)
    }
    const ink = lens ? Math.round(255 * Lc) : 0;                   // black on the pill, white under clear glass
    for (const b of btns){
      b.style.color = b === near ? `rgb(${ink},${ink},${ink})` : 'var(--dim)';
      b.style.opacity = glass ? 1 - Lc : 1;                       // lifted: the GPU layer shows the words (see the top)
    }
  }
  function rest(){                                                 // exactly on the chosen segment, nothing inline left
    const g = geo(pressed());
    pos.x = g.cx; pos.v = 0; posY.x = g.cy; posY.v = 0; wid.x = g.w; wid.v = 0; lift.x = 0; lift.v = 0;
    draw();
    for (const b of btns){ b.style.color = ''; b.style.opacity = ''; }
    cur = null;
  }
  function frame(t){
    raf = 0;
    let dt = Math.min(0.05, (t - last) / 1000); last = t;
    const hold = down ? nearest(clampX(px - grab, py), py) : pressed();
    const tx = down ? clampX(px - grab, py) : geo(hold).cx, ty = geo(hold).cy;
    const tw = geo(hold).w;
    const P = down ? SEG_SPRING.follow : SEG_SPRING.settle, Lp = down ? SEG_SPRING.press : SEG_SPRING.release;
    for (; dt > 0; dt -= 0.004){                                   // small steps: stiff springs stay stable at any frame rate
      const h = Math.min(0.004, dt);
      springStep(pos, tx, P[0], P[1], h);
      springStep(posY, ty, P[0], P[1], h);
      springStep(wid, tw, SEG_SPRING.width[0], SEG_SPRING.width[1], h);
      springStep(lift, down ? 1 : 0, Lp[0], Lp[1], h);
    }
    const still = !down && Math.abs(pos.x - tx) < 0.3 && Math.abs(pos.v) < 4 && Math.abs(posY.x - ty) < 0.3 && Math.abs(posY.v) < 4 && Math.abs(wid.x - tw) < 0.3 && Math.abs(lift.x) < 0.004 && Math.abs(lift.v) < 0.05;
    if (still) return rest();
    draw();
    raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf){ last = performance.now(); raf = requestAnimationFrame(frame); } };

  seg.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const s = seg.getBoundingClientRect();
    px = e.clientX - s.left; py = e.clientY - s.top;
    // grabbed by the thumb: it keeps its place under the finger; pressed elsewhere: it flows over to the finger
    grab = Math.abs(px - pos.x) <= wid.x / 2 && Math.abs(py - posY.x) <= geo(pressed()).h / 2 ? px - pos.x : 0;
    down = true;
    try { seg.setPointerCapture(e.pointerId); } catch(err){}
    kick();
  });
  seg.addEventListener('pointermove', e => { if (down){ const s = seg.getBoundingClientRect(); px = e.clientX - s.left; py = e.clientY - s.top; kick(); } });
  const up = e => {
    if (!down) return;
    down = false;
    const b = nearest(clampX(px - grab, py), py);
    if (e.type === 'pointerup' && b !== pressed()) b.click();     // chooses it (the page's own handler)
    kick();
  };
  seg.addEventListener('pointerup', up); seg.addEventListener('pointercancel', up);
  // the mouse click that follows a press is ours already; keyboard and script "clicks" (detail 0) go through
  seg.addEventListener('click', e => { if (e.detail > 0){ e.stopPropagation(); e.preventDefault(); } }, true);
  // chosen some other way (keyboard, saved setting): slide there
  new MutationObserver(kick).observe(seg, { attributes: true, attributeFilter: ['aria-pressed'], subtree: true });
  new ResizeObserver(() => { if (!raf && !down) rest(); }).observe(seg);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!raf && !down) rest(); });
  glassExtra.push(dpr => {
    if (!cur) return null;
    const w = cur.w * dpr, h = cur.h * dpr, bezel = Math.min(w, h) * 0.5;      // the rim reaches the middle: the whole drop bends
    const disp = bezel * 1.7 * GLASS_LOOK.refr;                         // as strong as the other glass
    const o = labels(dpr);
    const over = !!opts.lens;                                                  // on the settings card: shown above it
    return [{ blit: true, ovl: o, a: cur.a * 0.55, frost: 0, over },           // the words outside the glass, dimmed like the page's
            { x: cur.x * dpr, y: cur.y * dpr, w, h, r: h / 2, bezel, disp, a: cur.a, look: [0.9, 0.6, 1], frost: over ? GLASS_DRAWER.frost : 0, ovl: o, over }];
  });
  rest();
}
if (typeof document !== 'undefined'){
  document.querySelectorAll('.seg[data-thumb]').forEach(s => segThumb(s));
  document.querySelectorAll('#fxModal .seg').forEach(s => segThumb(s, { lens: true }));      // the settings card
}
