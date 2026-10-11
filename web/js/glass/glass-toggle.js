import { late } from '../core/late.js';
import { fx } from '../core/settings.js';
import { GLASS_LOOK, glassExtra, glassGL, glassKnob, glassKnobSeq, setGlassKnobSeq } from './glass.js';
import { springStep } from './seg-thumb.js';

export {
  TG_SPRING,
  lensApply,
  lensVeil,
};

/* ================= on / off switches with a liquid-glass knob =================
   The same idea as the language switch (seg-thumb.js), for the small on / off switches (the menu's "跟随播放器",
   the switches of the settings panel). At rest: a pill-shaped knob on a track. Press it and the knob lifts into a
   drop of glass, larger than the track, with a watery bounce; drag it and it follows, stretching with its speed; let
   go and it settles on the nearer side and turns back into the knob. A plain click still just toggles.

   These switches sit on frosted panels, page elements above the GPU glass layer. The lifted knob is drawn by that
   layer all the same and copied above the page (glassKnob and glassOver in glass.js), so it is the same glass as the
   controls outside; what it bends is a small picture of the track under it.
   Without WebGL the browser does the refraction instead: the lifted knob gets a backdrop filter whose displacement
   map is the same rim profile (after Chris Feijoo, "Liquid Glass in the Browser"). That filter samples without
   smoothing, so it is only the fallback. Chromium only; elsewhere the knob is a clear drop without the bending.

   Two springs per switch, stepped only while something moves: pos (0 = off ... 1 = on) and lift (0 = knob, 1 = glass). */
const TG = { w: 44, h: 24, pad: 3, kw: 24, kh: 18, lw: 36, lh: 30 };     // track, rest knob, lifted knob (css px)
const TG_SPRING = { follow: [700, 40], settle: [420, 26], press: [380, 15], release: [320, 22] };

/* the displacement map of a pill w x h: where each pixel of the glass takes its picture from, as red / green */
/* band: how far in from the edge the glass is curved, as a share of its shorter side (the middle is flat) */
function lensMap(w, h, k, band = 0.42){
  const W = Math.round(w * k), H = Math.round(h * k), cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const c = cv.getContext('2d'), im = c.createImageData(W, H), d = im.data;
  const R = H / 2, hx = W / 2, hy = H / 2, bz = Math.min(W, H) * band;
  const prof = x => {                               // sideways travel of a ray through the rounded rim (glass.js, same maths)
    const a = 1 - Math.min(0.999, Math.max(0.001, x)), sl = Math.pow(a, 3) * Math.pow(1 - Math.pow(a, 4), -0.75);
    const t1 = Math.atan(sl), t2 = Math.asin(Math.sin(t1) / 1.5);
    return Math.tan(t1 - t2) * (Math.pow(1 - Math.pow(a, 4), 0.25) + 0.25);
  };
  let max = 0;
  for (let i = 1; i < 400; i++) max = Math.max(max, prof(i / 400));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++){
    const dx = x + 0.5 - hx, dy = y + 0.5 - hy, qx = Math.abs(dx) - (hx - R), qy = Math.abs(dy) - (hy - R);
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0), sdf = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - R;
    let nx = 0, ny = 0;
    if (qx > 0 && qy > 0){ const l = Math.hypot(qx, qy) || 1; nx = qx / l; ny = qy / l; } else if (qx > qy) nx = 1; else ny = 1;
    nx *= Math.sign(dx) || 1; ny *= Math.sign(dy) || 1;
    const t = -sdf / bz, m = sdf < 0 && t < 1 ? prof(t) / max : 0, o = (y * W + x) * 4;
    d[o] = 128 - 127 * nx * m; d[o + 1] = 128 - 127 * ny * m; d[o + 2] = 128; d[o + 3] = 255;
  }
  c.putImageData(im, 0, 0);
  return cv.toDataURL();
}
/* One lens (an SVG filter) per kind of control: tgLens the switches, sgLens the thumbs of the panel's segmented
   switches, gsLens the sliders (style.css names them). Its map is made for the control's lifted size and rim width,
   and kept, so changing a setting or moving to a wider segment only swaps the picture.
   Red, green and blue are bent by slightly different amounts (1.06, 1, 0.94 of the travel), exactly as the glass of
   the GPU layer does (glass.js): the faint coloured fringe along the rim. Each colour is displaced on its own and the
   three are added up again. */
const glassLenses = {}, lensMaps = {};
function glassLens(id){
  if (glassLenses[id]) return glassLenses[id];
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true'); svg.style.position = 'absolute';
  svg.innerHTML = '<filter id="' + id + '" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">' +
    '<feImage x="0" y="0" preserveAspectRatio="none" result="m"/>' +
    [['r', '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0'], ['g', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0'], ['b', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0']].map(([c, m]) =>
      '<feDisplacementMap in="SourceGraphic" in2="m" xChannelSelector="R" yChannelSelector="G" result="d' + c + '"/>' +
      '<feColorMatrix in="d' + c + '" type="matrix" values="' + m + '  0 0 0 1 0" result="' + c + '"/>').join('') +
    '<feComposite in="r" in2="g" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="rg"/>' +
    '<feComposite in="rg" in2="b" operator="arithmetic" k1="0" k2="1" k3="1" k4="0"/></filter>';
  document.body.appendChild(svg);
  const img = svg.querySelector('feImage'), dms = [...svg.querySelectorAll('feDisplacementMap')], DISP = [1.06, 1, 0.94];
  let cur = '';
  return glassLenses[id] = {
    map(w0, h0, band){ const k = w0 + 'x' + h0 + '@' + band; if (k !== cur){ cur = k; img.setAttribute('href', lensMaps[k] || (lensMaps[k] = lensMap(w0, h0, 3, band))); } },
    size(w, h){ img.setAttribute('width', w.toFixed(2)); img.setAttribute('height', h.toFixed(2)); },
    strength(px){ dms.forEach((d, i) => d.setAttribute('scale', (2 * px * DISP[i]).toFixed(2))); },
  };
}
/* The glass the browser draws has the same fixed look as the glass of the GPU layer (GLASS_LOOK, glass.js):
   bezel (px) = how far in the rim is curved (never more than half the drop), refr = how far the rim bends the picture,
   clear below 1 = a faint white veil. Its frost, rim light and shadow are in style.css (--lg-blur, --lg-rim, --lg-shadow).
   A lifted drop w x h (now), w0 x h0 (its size at rest in the air, which the map is made for), lift Lc 0..1.
   Returns the opacity of the veil. */
const LENS_LOOK = GLASS_LOOK;
function lensApply(id, w, h, w0, h0, Lc, whole){
  // whole: the rim reaches the middle, the whole drop bends (the thumb of a segmented switch, as on the GPU layer)
  const G = whole ? { bezel: 1e9, refr: LENS_LOOK.refr * 1.7 / 1.6 } : LENS_LOOK, short = Math.min(w0, h0);
  const band = Math.round(Math.max(0.06, Math.min(0.5, G.bezel / short)) * 100) / 100;
  const L = glassLens(id);
  L.map(Math.round(w0 / 8) * 8, Math.round(h0 / 2) * 2, band); L.size(w, h);
  L.strength(band * Math.min(w, h) * 1.6 * G.refr * Lc);
  return lensVeil();
}
const lensVeil = () => (1 - LENS_LOOK.clear) * 0.35;
/* track: the pill the knob runs in. press: the element that takes the mouse (the hidden checkbox, or the whole menu
   row). isOn(): the state now. flip(): change it, the way a click on the control would. */
function glassToggle(track, press, isOn, flip){
  const knob = document.createElement('b');
  knob.className = 'tgk'; track.classList.add('tg'); track.appendChild(knob);
  const pos = { x: isOn() ? 1 : 0, v: 0 }, lift = { x: 0, v: 0 };
  let down = false, dragging = false, startX = 0, startPos = 0, want = pos.x, raf = 0, last = 0;
  const travel = TG.w - 2 * TG.pad - TG.kw;
  const glassOn = () => fx.ui === 'glass';
  /* the track as a picture for the GPU glass (device pixels, a margin around it); cur: the lifted knob, in the window */
  const UM = 16, uid = 'tg' + (setGlassKnobSeq(glassKnobSeq + 1)) + '-';
  let cur = null, trackCol = '', und = null, undKey = '', undVer = 0;
  function under(dpr){
    const t = track.getBoundingClientRect(), key = [t.left, t.top, dpr, trackCol].join(',');
    if (und && key === undKey) return und;
    undKey = key;
    const cv = (und && und.canvas) || document.createElement('canvas'), w = Math.round((TG.w + 2 * UM) * dpr), h = Math.round((TG.h + 2 * UM) * dpr);
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.fillStyle = trackCol;
    c.beginPath(); c.roundRect(UM, UM, TG.w, TG.h, TG.h / 2); c.fill();
    return und = { canvas: cv, rect: [Math.round((t.left - UM) * dpr), Math.round((t.top - UM) * dpr), w, h], ver: uid + (++undVer) };
  }
  glassExtra.push(dpr => cur ? glassKnob(cur, under(dpr), dpr) : null);
  function draw(){
    const L = lift.x, Lc = Math.max(0, Math.min(1, L)), p = Math.max(-0.08, Math.min(1.08, pos.x)), pc = Math.max(0, Math.min(1, p));
    const glass = glassOn(), speed = Math.abs(pos.v) * travel;
    const stretch = Math.min(0.3, speed / 900) * (0.35 + 0.65 * Lc);
    const gw = glass ? TG.lw : TG.kw * 1.08, gh = glass ? TG.lh : TG.kh * 1.08;
    const w = (TG.kw + (gw - TG.kw) * L) * (1 + stretch), h = Math.max(6, (TG.kh + (gh - TG.kh) * L) * (1 - stretch * 0.4));
    const cx = TG.pad + TG.kw / 2 + p * travel;
    knob.style.width = w + 'px'; knob.style.height = h + 'px';
    knob.style.transform = `translate(${cx - w / 2}px,${TG.h / 2 - h / 2}px)`;
    const gpu = glass && !!glassGL, lens = glass && !gpu;            // the GPU layer draws the lifted knob; without it, the browser's lens
    knob.style.backgroundColor = `rgba(255,255,255,${lens ? 1 - Lc * (1 - lensVeil()) : 1})`;      // a white knob; clear when lifted
    knob.style.opacity = gpu ? 1 - Lc : '';                         // ... or melting away as the glass comes up
    knob.classList.toggle('lifted', lens && Lc > 0.02);
    if (lens && Lc > 0.02) lensApply('tgLens', w, h, TG.lw, TG.lh, Lc);
    if (gpu && Lc > 0.01){ const t = track.getBoundingClientRect(); cur = { x: t.left + cx - w / 2, y: t.top + TG.h / 2 - h / 2, w, h, a: Lc }; } else cur = null;
    // the track: faint white when off, green when on (Apple's switch green for dark interfaces), blended on the way
    const mix = (a, b) => Math.round(a + (b - a) * pc);
    track.style.backgroundColor = trackCol = `rgba(${mix(255, 48)},${mix(255, 209)},${mix(255, 88)},${(0.2 + 0.8 * pc).toFixed(3)})`;
  }
  function frame(t){
    raf = 0;
    let dt = Math.min(0.05, (t - last) / 1000); last = t;
    const target = down && dragging ? want : isOn() ? 1 : 0;
    const P = down ? TG_SPRING.follow : TG_SPRING.settle, Lp = down ? TG_SPRING.press : TG_SPRING.release;
    for (; dt > 0; dt -= 0.004){
      const h = Math.min(0.004, dt);
      springStep(pos, target, P[0], P[1], h);
      springStep(lift, down ? 1 : 0, Lp[0], Lp[1], h);
    }
    if (!down && Math.abs(pos.x - target) < 0.003 && Math.abs(pos.v) < 0.03 && Math.abs(lift.x) < 0.004 && Math.abs(lift.v) < 0.05){
      pos.x = target; pos.v = 0; lift.x = 0; lift.v = 0; draw();
      return;
    }
    draw();
    raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf){ last = performance.now(); raf = requestAnimationFrame(frame); } };

  press.addEventListener('pointerdown', e => {
    if (e.button !== 0 || press.disabled) return;
    down = true; dragging = false; startX = e.clientX; startPos = pos.x; want = pos.x;
    try { press.setPointerCapture(e.pointerId); } catch(err){}
    kick();
  });
  press.addEventListener('pointermove', e => {
    if (!down) return;
    const dx = e.clientX - startX;
    if (!dragging && Math.abs(dx) > 3) dragging = true;
    if (dragging){ want = Math.max(0, Math.min(1, startPos + dx / travel)); kick(); }
  });
  const up = e => {
    if (!down) return;
    down = false;
    // dragged: the side it was left on; not dragged: a click, the other side
    if (e.type === 'pointerup' && (dragging ? (want > 0.5) !== isOn() : true)) flip();
    kick();
  };
  press.addEventListener('pointerup', up); press.addEventListener('pointercancel', up);
  // the mouse click that follows a press is handled above; keyboard and script "clicks" (detail 0) go through
  press.addEventListener('click', e => { if (e.detail > 0){ e.stopPropagation(); e.preventDefault(); } }, true);
  return { sync: kick, draw };
}
if (typeof document !== 'undefined'){
  // settings panel: <label class="switch"><input type="checkbox"><span></span></label>
  document.querySelectorAll('.switch').forEach(lab => {
    const input = lab.querySelector('input'), track = lab.querySelector('span');
    if (!input || !track) return;
    const t = glassToggle(track, input, () => input.checked, () => input.click());
    input.addEventListener('change', t.sync);
    // the page also sets .checked from code (restore defaults, loading the saved settings): that fires no event
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    Object.defineProperty(input, 'checked', { get(){ return d.get.call(this); }, set(v){ d.set.call(this, v); t.sync(); }, configurable: true });
    t.draw();
  });
  // menu rows: <button class="mi" aria-pressed><i class="msw"></i></button>
  document.querySelectorAll('.mi .msw').forEach(track => {
    const btn = track.closest('.mi');
    const t = glassToggle(track, btn, () => btn.getAttribute('aria-pressed') === 'true', () => btn.click());
    new MutationObserver(t.sync).observe(btn, { attributes: true, attributeFilter: ['aria-pressed'] });
    t.draw();
  });
}

/* names that modules loaded before this one call or read (core/late.js) */
Object.assign(late, { lensVeil, lensApply });
