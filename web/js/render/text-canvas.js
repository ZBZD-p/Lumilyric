import { late } from '../core/late.js';
import { CJK } from '../core/core.js';
import { song } from '../core/lyrics.js';
import { exitSpec, fx, glowGain, glowLayers, karaokeTimes, lyricFont } from '../core/settings.js';
import { chunkText, oneLine, segmentsFor, tokens } from './view-dom.js';

export {
  PRESETS,
  SWEEP,
  buildTimeline,
  canvasMeasurer,
  clamp01,
  cubicBezier,
  drawOnColour,
  drawSeg,
  easeOut,
  layoutSeg,
  liftDur,
  liftE,
  rowOffs,
  setDrawOnColour,
  setSpriteAlphaMul,
  spriteCache,
  sweepActive,
  sweepPos,
};

/* Canvas text: easing, karaoke sweep, measuring, sprites, drawSeg */
/* ================= video export (canvas re-render of the same animation) ================= */
const PRESETS = { '1080': [1920, 1080], 'v1080': [1080, 1920], '2160': [3840, 2160], '720': [1280, 720] };
const easeOut = p => 1 - Math.pow(1 - p, 4);
/* cubic-bezier easing, same maths as CSS */
function cubicBezier(x1, y1, x2, y2){
  const bx = u => ((1 - 3 * x2 + 3 * x1) * u + (3 * x2 - 6 * x1)) * u * u + 3 * x1 * u;
  const by = u => ((1 - 3 * y2 + 3 * y1) * u + (3 * y2 - 6 * y1)) * u * u + 3 * y1 * u;
  const dx = u => (3 * (1 - 3 * x2 + 3 * x1) * u + 2 * (3 * x2 - 6 * x1)) * u + 3 * x1;
  return p => {
    if (p <= 0) return 0; if (p >= 1) return 1;
    let u = p;
    for (let i = 0; i < 6; i++){ const d = dx(u); if (Math.abs(d) < 1e-6) break; u -= (bx(u) - p) / d; }
    if (!(u >= 0 && u <= 1) || Math.abs(bx(u) - p) > 1e-4){       // fall back to bisection
      let a = 0, b = 1; u = p;
      for (let i = 0; i < 30; i++){ if (bx(u) < p) a = u; else b = u; u = (a + b) / 2; }
    }
    return by(u);
  };
}
/* karaoke word lift: a soft ease-in-out that never snaps, lasting at least 0.7 s even for very short words,
   so quick runs of words rise as one smooth wave instead of jumping one by one */
const liftE = cubicBezier(0.35, 0, 0.25, 1);
const liftDur = du => Math.max(0.7, du + 0.3);
/* karaoke sweep: ONE soft bright edge that travels along the whole line (across word boundaries and wrapped
   rows), instead of a separate wipe restarting in every word. Inside word k the edge moves from the word's
   start to just past its end; between words it waits; the path is then smoothed over a short time window so
   the speed changes gently from word to word. offs/ws: each word's start and width along the line (px). */
const SWEEP = { edge: 0.45, smooth: 0.09 };          // edge width (em), smoothing half-window (s)
function sweepRaw(kar, offs, ws, E, t){
  const st = kar.st;
  let lo = 0, hi = st.length - 1, k = -1;
  while (lo <= hi){ const m = (lo + hi) >> 1; if (st[m] <= t){ k = m; lo = m + 1; } else hi = m - 1; }
  if (k < 0) return offs[0] - E;
  const q = clamp01((t - st[k]) / kar.du[k]);
  const c = offs[k] + (ws[k] + E / 2) * q;
  // never move backwards (next word may start inside the previous word's soft tail)
  return k > 0 ? Math.max(c, offs[k - 1] + ws[k - 1] + E / 2) : c;
}
const SW_W = [1, 2, 3, 2, 1];
function sweepPos(kar, offs, ws, E, t){
  if (!kar || !offs.length) return 1e9;
  const h = SWEEP.smooth;
  let c = 0;
  for (let i = 0; i < 5; i++) c += SW_W[i] * sweepRaw(kar, offs, ws, E, t + (i - 2) * h / 2);
  return c / 9;
}
function sweepActive(kar, t){
  if (!kar) return false;
  const n = kar.st.length - 1;
  return t > kar.st[0] - SWEEP.smooth - 0.05 && t < kar.st[n] + kar.du[n] + SWEEP.smooth + 0.05;
}
/* word offsets along a laid-out line: rows are joined end to end */
function rowOffs(rows){
  if (rows._sw) return rows._sw;
  const offs = [], ws = []; let base = 0;
  for (const r of rows){ for (const tk of r.toks){ offs[tk.k] = base + tk.x; ws[tk.k] = tk.w; } base += r.width; }
  return rows._sw = { offs, ws };
}
const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;

/* derived: fsOverride comes from another measurer's size (already scaled by the 字号 setting), so it is not scaled again */
function canvasMeasurer(ctx, W, H, fsOverride, derived){
  const base = fsOverride ? fsOverride : Math.min(W * 0.075, H * 0.09);
  const fs = Math.round(derived ? base : base * fx.font.main.s);
  const sfs = Math.round(fs * 0.42 * fx.font.sub.s);
  const hasLS = 'letterSpacing' in ctx;
  const cache = new Map();
  const M = { ctx };
  function setFont(text, isSub){
    const ctx = M.ctx;
    const zh = CJK.test(text);
    const f = lyricFont(isSub, zh);
    ctx.font = `${f.w} ${isSub ? sfs : fs}px ${f.family}`;
    if (hasLS) ctx.letterSpacing = (isSub ? 0.06 * sfs : zh ? 0.02 * fs : -0.02 * fs) + 'px';
  }
  function w(text, isSub){
    const key = (isSub ? 's|' : 'p|') + text;
    if (cache.has(key)) return cache.get(key);
    setFont(text, isSub);
    const v = M.ctx.measureText(text).width;
    cache.set(key, v); return v;
  }
  return Object.assign(M, { fs, sfs, setFont, w, avail: () => W * 0.86, blurOK: 'filter' in ctx });
}

function buildTimeline(M){
  const cache = new Map(), segs = [];
  const first = song.lines[0];
  if (song.meta.ti && first && first.t > 0.6)
    segs.push({ pri: song.meta.ti, sub: song.meta.ar || '', t: 0, end: first.t, title: true });
  song.lines.forEach((_, i) => segs.push(...segmentsFor(i, M, cache)));
  return segs;
}

const layoutCache = new WeakMap();
function layoutSeg(seg, M){
  if (layoutCache.has(seg)) return layoutCache.get(seg);
  const priRows = oneLine ? [seg.pri] : chunkText(seg.pri, false, 1, M);
  const subRows = seg.sub ? (oneLine ? [seg.sub] : chunkText(seg.sub, true, 1, M)) : [];
  let k = 0;
  const rows = priRows.map(row => {
    const toks = []; let x = 0;
    for (const tk of tokens(row)){
      const wd = M.w(tk.trim() ? tk : ' ', false) * (tk.trim() ? 1 : 1);
      if (tk.trim()) toks.push({ s: tk, x, w: wd, k: k++ });
      x += wd;
    }
    return { toks, width: x, text: row };
  });
  const L = { rows, subRows: subRows.map(t => ({ t, width: M.w(t, true) })), n: k };
  layoutCache.set(seg, L);
  return L;
}

/* ---- pre-rendered text sprites: blur is baked once per word instead of every frame ---- */
/* every sprite is drawn this much fainter (1 = as asked): lets a whole pass of text fade, see layout-scroll.js */
let spriteAlphaMul = 1;
function spriteCache(M){
  const bs = M.fs / 72;
  const LEVELS = [0, 1, 2, 3.5, 5.5, 8, 11, 15, 20, 26].map(v => v * bs);
  // glow: each word's halos are blurred once and cached. Blur is linear, so adding the halos of all words
  // gives the same bloom as blurring the whole text layer, at a fraction of the cost per frame
  const glowOn = fx.glow.on && M.blurOK && !late.useWebGL();
  const GL = glowOn ? glowLayers() : [];
  const pad = Math.ceil(LEVELS[LEVELS.length - 1] * 2.2) + 4;
  const map = new Map();                 // key -> sprite, in insertion (LRU) order
  let bytes = 0;
  const BUDGET = 320 * 1024 * 1024;
  const mk = (w, h) => typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  function get(text, isSub, li, layer = 0){
    const fsz = isSub ? M.sfs : M.fs;
    // glow layers: the entry blur only matters while it is comparable to the halo itself
    let bl = LEVELS[li];
    if (layer){
      const sg = GL[layer - 1].sigma * fsz;
      if (LEVELS[li] < sg * 0.35) li = 0;
      bl = Math.hypot(LEVELS[li], sg);
    }
    const key = (isSub ? 's' : 'p') + li + '/' + layer + '|' + text;
    let sp = map.get(key);
    if (sp){ map.delete(key); map.set(key, sp); return sp; }
    const tw = M.w(text, isSub);
    const pd = layer ? Math.ceil(bl * 3) + 4 : pad;
    // wide halos are rendered small and scaled up when drawn: a blur hides the lower resolution
    const sc = layer ? Math.min(1, Math.max(0.125, 6 / Math.max(bl, 0.01))) : 1;
    const fw = tw + pd * 2, fh = fsz * 1.7 + pd * 2;
    const w = Math.max(1, Math.ceil(fw * sc)), h = Math.max(1, Math.ceil(fh * sc));
    const t1 = mk(w, h), x = t1.getContext('2d');
    const saved = M.ctx; M.ctx = x; M.setFont(text, isSub); M.ctx = saved;   // reuse the measurer's font settings
    x.textBaseline = 'middle'; x.textAlign = 'left';
    x.fillStyle = layer ? `rgb(${GL[layer - 1].rgb.join(',')})` : '#fff';
    let c = t1;
    if (sc !== 1){
      x.setTransform(sc, 0, 0, sc, 0, 0);
      x.fillText(text, pd, fh / 2);
      if (bl > 0.25 && M.blurOK){
        c = mk(w, h); const y = c.getContext('2d');
        y.filter = `blur(${(bl * sc).toFixed(2)}px)`;
        y.drawImage(t1, 0, 0);
      }
    } else {
      if (bl > 0.25 && M.blurOK) x.filter = `blur(${bl.toFixed(2)}px)`;
      x.fillText(text, pd, fh / 2);
    }
    sp = { c, w, h, ox: pd, oy: fh / 2, dw: fw, dh: fh };
    map.set(key, sp); bytes += w * h * 4;
    while (bytes > BUDGET && map.size > 1){
      const [k0, s0] = map.entries().next().value;
      map.delete(k0); bytes -= s0.w * s0.h * 4;
    }
    return sp;
  }
  // draw text centred-left at (x, y) with an arbitrary blur, cross-fading two baked levels
  function draw(ctx, text, isSub, x, y, alpha, blur){
    if (!M.blurOK) blur = 0;
    let i = 0;
    while (i < LEVELS.length - 2 && LEVELS[i + 1] < blur) i++;
    const lo = LEVELS[i], hi = LEVELS[i + 1];
    const f = blur <= lo ? 0 : blur >= hi ? 1 : (blur - lo) / (hi - lo);
    // outer halos first, the sharp text last; the caller composites with 'lighter' so light adds up
    const put = (sp, a) => {                       // 'lighter' adds up, so a > 1 is drawn in several passes
      while (a > 0.002){ ctx.globalAlpha = Math.min(1, a) * spriteAlphaMul; ctx.drawImage(sp.c, x - sp.ox, y - sp.oy, sp.dw, sp.dh); a -= 1; }
    };
    const gg = GL.length ? glowGain(alpha) : 0;              // dim text: less or no glow (threshold)
    for (let L = gg > 0.004 ? GL.length : 0; L >= 0; L--){
      const la = L ? GL[L - 1].alpha * 1.25 * gg : 1;
      if (f < 0.999) put(get(text, isSub, i, L), alpha * la * (1 - f));
      if (f > 0.001) put(get(text, isSub, i + 1, L), alpha * la * f);
    }
  }
  // karaoke: text (and, with glow, its halos) lit up to edge x1 (relative to the text start), fading out
  // over a soft edge of width fe through a real gradient mask; the edge is the same as the CSS gradient's
  let S = null, Sx = null;
  function masked(ctx, sp, x, y, a, e0, e1){
    const w = Math.ceil(sp.dw) + 2, h = Math.ceil(sp.dh) + 2;
    if (!S || S.width < w || S.height < h){ S = mk(Math.max(w, S ? S.width : 0), Math.max(h, S ? S.height : 0)); Sx = S.getContext('2d'); }
    Sx.globalCompositeOperation = 'copy'; Sx.globalAlpha = 1;
    Sx.drawImage(sp.c, 0, 0, sp.dw, sp.dh);
    Sx.globalCompositeOperation = 'destination-in';
    const g = Sx.createLinearGradient(sp.ox + e0, 0, sp.ox + Math.max(e1, e0 + 0.5), 0);
    for (const [o, v] of MASK_STOPS) g.addColorStop(o, `rgba(0,0,0,${v})`);
    Sx.fillStyle = g; Sx.fillRect(0, 0, w, h);
    while (a > 0.002){ ctx.globalAlpha = Math.min(1, a) * spriteAlphaMul; ctx.drawImage(S, 0, 0, sp.dw, sp.dh, x - sp.ox, y - sp.oy, sp.dw, sp.dh); a -= 1; }
  }
  function drawLit(ctx, text, isSub, x, y, alpha, x1, fe, glow, lum, blur = 0){
    if (x1 + fe / 2 <= -2 && x1 !== Infinity && !glow) return;
    const tw = M.w(text, isSub), fsz = isSub ? M.sfs : M.fs;
    const full = x1 - fe / 2 >= tw + 1;
    const gg = glow && GL.length ? glowGain(lum ?? alpha) : 0;
    // blur (scrolling column): cross-fade two baked blur levels, exactly like draw(), so a line sharpens gradually
    if (!M.blurOK) blur = 0;
    let bi = 0;
    while (bi < LEVELS.length - 2 && LEVELS[bi + 1] < blur) bi++;
    const blo = LEVELS[bi], bhi = LEVELS[bi + 1];
    const bf = blur <= blo ? 0 : blur >= bhi ? 1 : (blur - blo) / (bhi - blo);
    const lv = bf < 0.001 ? [[bi, 1]] : bf > 0.999 ? [[bi + 1, 1]] : [[bi, 1 - bf], [bi + 1, bf]];
    for (let L = gg > 0.004 ? GL.length : 0; L >= 0; L--){
      for (const [lev, wt] of lv){
        const sp = get(text, isSub, lev, L), la = wt * alpha * (L ? GL[L - 1].alpha * 1.25 * gg : 1);
        if (full){
          let a = la;
          while (a > 0.002){ ctx.globalAlpha = Math.min(1, a) * spriteAlphaMul; ctx.drawImage(sp.c, x - sp.ox, y - sp.oy, sp.dw, sp.dh); a -= 1; }
          continue;
        }
        // halos get a wider, softer edge so the light leads the sweep instead of being cut
        const f = (L ? fe + 2 * GL[L - 1].sigma * fsz : fe) + LEVELS[lev] * 2;
        masked(ctx, sp, x, y, la, x1 - f / 2, x1 + f / 2);
      }
    }
  }
  return { draw, drawLit };
}

/* returns a key when the frame is static (identical to the next one with the same key), else null */
const easeIn = p => p * p * p;
const MASK_STOPS = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1].map(o => [o, (1 - o * o * (3 - 2 * o)).toFixed(4)]);
let drawOnColour = false;                 // set by drawFrame: true when text sits on the flowing background
function drawSeg(ctx, W, H, M, seg, t, exitT){
  if (seg.blank) return 'blank';
  const SP = M.sprites || (M.sprites = spriteCache(M));
  const lay = layoutSeg(seg, M);
  const fs = M.fs, sfs = M.sfs, bs = fs / 72;           // blur scales with type size
  const lineH = fs * 1.15, subH = sfs * 1.45, gap = sfs * 0.7;
  const totalH = lay.rows.length * lineH + (lay.subRows.length ? gap + lay.subRows.length * subH : 0);
  let y = H / 2 - totalH / 2;
  const dur = seg.title ? 1.2 : Math.max(0.3, seg.end - seg.t);
  const el = t - seg.t;
  const spread = Math.min(dur * 0.7, lay.n * 0.24);
  const step = lay.n > 1 ? spread / (lay.n - 1) : 0;

  // exit: exitT = seconds since this line started leaving (null while it is the current line)
  const X = exitSpec(), xe = p => X.easeIn ? easeIn(p) : easeOut(p);
  const xing = exitT != null;
  const exAll = xing ? xe(clamp01(exitT / (X.D + X.S))) : 0;
  const ex = X.line ? exAll : 0;                           // whole-line part
  const exA = 1 - ex, exBlur = X.blur * ex * bs;
  const scale = (seg.title ? 0.7 : 1) * (1 + X.sc * ex);
  const wordEx = k => (!xing || X.line) ? 0 : xe(clamp01((exitT - (lay.n > 1 ? X.S * k / (lay.n - 1) : 0)) / X.D));
  let moving = xing, shown = 0;
  ctx.save();
  // white light on black (or transparent): overlaps add up cleanly. On a coloured background adding light would tint
  // the text, so it is painted normally there.
  ctx.globalCompositeOperation = drawOnColour ? 'source-over' : 'lighter';
  ctx.translate(W / 2, H / 2 + X.dy * fs * ex);
  ctx.scale(scale, scale);
  ctx.translate(-W / 2, -H / 2);
  const put = (text, cx, cy, sc, a, blur, w) => {
    if (Math.abs(sc - 1) < 5e-4) return SP.draw(ctx, text, false, cx - w / 2, cy, a, blur);
    ctx.save(); ctx.translate(cx, cy); ctx.scale(sc, sc);
    SP.draw(ctx, text, false, -w / 2, 0, a, blur);
    ctx.restore();
  };

  const anim = seg.title && fx.anim === 'karaoke' ? 'fade' : fx.anim;
  const kar = anim === 'karaoke' ? karaokeTimes(seg, lay.n) : null;
  const lineE = kar ? easeOut(clamp01(el / 0.45)) : 1;
  if (kar && lineE < 1) moving = true;
  if (kar && sweepActive(kar, t)) moving = true;
  const SWo = kar ? rowOffs(lay.rows) : null, SE = SWEEP.edge * fs;
  const swc = kar ? sweepPos(kar, SWo.offs, SWo.ws, SE, t) : 0;
  let lit = 0;
  for (const row of lay.rows){
    const cy = y + lineH / 2, x0 = W / 2 - row.width / 2;
    for (const tk of row.toks){
      const w = wordEx(tk.k), wA = 1 - w, wBlur = X.blur * w * bs, wDy = X.dy * fs * w, wSc = 1 + X.sc * w;
      const cx = x0 + tk.x + tk.w / 2;
      if (kar){
        const a = lineE * exA * wA;
        if (a <= 0.003) continue;
        const q = clamp01((t - kar.st[tk.k]) / kar.du[tk.k]);
        if (q > 0 && q < 1) moving = true;
        if (t > kar.st[tk.k] && t < kar.st[tk.k] + liftDur(kar.du[tk.k])) moving = true;
        const ex = swc - SWo.offs[tk.k];             // sweep edge, relative to this word
        if (ex - SE / 2 >= tk.w) lit++;
        const yy = cy + 0.2 * fs * (1 - lineE) - 0.05 * fs * liftE((t - kar.st[tk.k]) / liftDur(kar.du[tk.k])) + wDy;
        shown++;
        if (xing && ex - SE / 2 >= tk.w && (exBlur + wBlur > 0.3 || wSc !== 1)){ put(tk.s, cx, yy, wSc, a, exBlur + wBlur, tk.w); continue; }
        const x = x0 + tk.x;
        // dim base (no glow) + bright part swept in from the left (same edge as the CSS gradient)
        SP.drawLit(ctx, tk.s, false, x, yy, a * 0.3, Infinity, 0, false);
        if (ex + SE / 2 > 0) SP.drawLit(ctx, tk.s, false, x, yy, a * (drawOnColour ? 1 : 0.7), ex - SE / 2 >= tk.w + 1 ? Infinity : ex, SE, true, a);
        continue;
      }
      const p = clamp01((seg.times ? t - seg.times[tk.k] : el - tk.k * step) / 0.9);
      if (p <= 0) continue;
      shown++;
      if (p < 1) moving = true;
      const e = easeOut(p), e6 = easeOut(clamp01(p / 0.6)), e7 = easeOut(clamp01(p / 0.7));
      const a = (anim === 'fade' ? e7 : e6) * exA * wA;
      if (a <= 0.003) continue;
      const blur = (anim === 'fade' ? 4 * (1 - e7) : anim === 'rise' ? 0 : 12 * (1 - e6)) * bs + exBlur + wBlur;
      const dy = anim === 'rise' ? 0.5 * fs * (1 - e) : anim === 'pop' ? 0.42 * fs * (1 - e) : 0;
      const sc = anim === 'pop' ? 0.86 + 0.14 * e : 1;
      put(tk.s, cx, cy + dy + wDy, sc * wSc, a, blur, tk.w);
    }
    y += lineH;
  }
  let subOn = 0;
  if (lay.subRows.length){
    y += gap;
    const delay = seg.times ? 0.15 : Math.min(spread * 0.5, 0.5) + 0.1;
    const pe = clamp01((el - delay) / 1);
    const e = easeOut(pe);
    if (pe > 0 && pe < 1) moving = true;
    subOn = pe >= 1 ? 2 : pe > 0 ? 1 : 0;
    const sx = X.line ? 0 : exAll;                         // word-by-word exits: the translation leaves as one piece
    const a = 0.55 * e * exA * (1 - sx);
    if (a > 0.003){
      const b = 6 * (1 - e) * bs + exBlur + X.blur * sx * bs;
      for (const r of lay.subRows){
        SP.draw(ctx, r.t, true, W / 2 - r.width / 2, y + subH / 2 + 0.6 * sfs * (1 - e) + X.dy * fs * sx, a, b);
        y += subH;
      }
    }
  }
  ctx.restore();
  return moving ? null : shown + ':' + lit + ':' + subOn;
}

function setSpriteAlphaMul(v){ return spriteAlphaMul = v; }   // other modules cannot assign to an imported binding

function setDrawOnColour(v){ return drawOnColour = v; }   // other modules cannot assign to an imported binding

/* names that modules loaded before this one call or read (core/late.js) */
Object.assign(late, { liftDur, SWEEP, sweepPos });
