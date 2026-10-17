import { late } from '../core/late.js';
import { CJK } from '../core/core.js';
import { song } from '../core/lyrics.js';
import { exitSpec, fx, glowGain, glowLayers, karaokeTimes, lyricFont, prof } from '../core/settings.js';
import { chunkText, oneLine, segmentsFor, tokens } from './view-dom.js';

export {
  PRESETS,
  SWEEP,
  buildTimeline,
  lazyTimeline,
  canvasMeasurer,
  clamp01,
  cubicBezier,
  drawOnColour,
  drawSeg,
  easeOut,
  HOLD,
  FLOAT,
  floatLetter,
  holdFloat,
  holdGlow,
  layoutSeg,
  letterLift,
  liftSplit,
  liftWord,
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
/* A word sung slowly lifts letter by letter: when it is written with separate letters (English, numbers ...) each
   letter starts to rise when the sweep reaches it, so the word rises like a wave along with the light instead of all
   at once when its first letter is sung. A word that is over quickly rises whole, as do scripts whose letters join or
   stack (Arabic, Indic, combining marks); Chinese and Japanese are a token per character already. */
const LIFT_SPLIT = /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}\p{P}\p{S}]{2,}$/u;
const LIFT_SLOW = 0.5;                        // s: the sweep takes at least this long to cross the word
const liftSplit = (s, du) => du >= LIFT_SLOW && LIFT_SPLIT.test(s);
/* The last word of a line, held long: its glow swells a little while it is sung and settles again afterwards. The
   light comes with the sweep: only the part of the word that is lit already has it. Only
   with the lyrics' own word times (kar.hold, karaokeTimes), and only when 辉光 is on. from..full: how long the word
   must last for none .. all of it (s); gain: the most light added (not much: the word is white already); blur: how
   wide the extra light is (px at 72 px type); fade: how long it takes to settle (s). 长音增亮 (fx.glow.hold) scales
   the gain: 1 = as given here, 0 = none. 触发时长 (fx.glow.holdFrom) moves from, and full along with it. */
const HOLD = { from: 0.5, full: 1.5, gain: 0.3, blur: 10, fade: 0.8 };
const smooth01 = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
const holdStrength = kar => kar && kar.hold && fx.glow.on ? HOLD.gain * (fx.glow.hold ?? 1) * clamp01((kar.hold - (fx.glow.holdFrom ?? HOLD.from)) / (HOLD.full - HOLD.from)) : 0;
function holdGlow(kar, k, t){                 // the extra light on word k at t: 0 .. HOLD.gain * fx.glow.hold
  if (k !== kar.st.length - 1) return 0;
  const s = holdStrength(kar), el = t - kar.st[k];
  return s && el > 0 ? s * smooth01(el / kar.hold) * (1 - smooth01((el - kar.hold) / HOLD.fade)) : 0;
}
/* 悬浮: the last word of a line, held long. As the sweep reaches each letter, that letter floats up a little and grows a
   little, and comes down again, each in its turn: a swell that runs along the word with the light, every letter back where
   it was when its own turn is over (it does not stay up). How much, by how long the word is held (as for the light,
   HOLD.from .. full), times 长音悬浮 (fx.glow.float): 0 = none.
   rise: how high a letter goes, of the type size; scale: the most it grows; dur: s from the light reaching the letter to
   it being down again; peak: how far into that it is highest (the share of dur). */
const FLOAT = { rise: 0.1, scale: 0.12, dur: 1.2, peak: 0.35 };
function holdFloat(kar, k){                     // 0 .. fx.glow.float: how floating word k is (only the last word, only when held long)
  if (!kar || !kar.hold || k !== kar.st.length - 1 || !fx.glow.on) return 0;      // (it is among the glow's settings: off with it)
  return (fx.glow.float ?? 1) * clamp01((kar.hold - (fx.glow.holdFrom ?? HOLD.from)) / (HOLD.full - HOLD.from));
}
/* one letter's swell: 0 before its turn, 1 at the top (peak), 0 again once it is down; p: how far through its turn */
const floatPulse = p => p <= 0 || p >= 1 ? 0 : p < FLOAT.peak ? smooth01(p / FLOAT.peak) : 1 - smooth01((p - FLOAT.peak) / (1 - FLOAT.peak));
/* a letter (or a word in one piece: the mean of its letters) at time t: how much higher it stands (of the type size)
   and how much larger it is drawn, over the place it has on the line. hf: holdFloat; ts: when the light reaches each
   of the letters it stands for */
function floatLetter(hf, t, ts){
  let u = 0;
  for (const t0 of ts) u += floatPulse((t - t0) / FLOAT.dur);
  u = Math.min(2, hf * u / ts.length);
  return { up: FLOAT.rise * u, sc: 1 + FLOAT.scale * u };
}
/* when a letter starts to rise and for how long: it lies from x0 to x1 in its word; the sweep crosses span (the word
   and half the soft edge, see sweepRaw) in the word's time. The first letter starts with the word, as before. */
const letterLift = (st, du, x0, x1, span) => [st + du * x0 / span, liftDur(du * (x1 - x0) / span)];
function letterEdges(tk, M){                 // where each letter of the word starts (px from the word's start); the last entry is its end
  if (tk.lx !== undefined) return tk.lx;
  if (!LIFT_SPLIT.test(tk.s)) return tk.lx = null;
  const lx = []; let pre = '';
  tk.cs = Array.from(tk.s);
  // the width up to and with the letter, less the letter alone: the kerning with the letter before stays in
  for (const c of tk.cs){ pre += c; lx.push(Math.min(tk.w, Math.max(lx.length ? lx[lx.length - 1] : 0, M.w(pre, false) - M.w(c, false)))); }
  lx[0] = 0; lx.push(tk.w);
  return tk.lx = lx;
}
/* draws one karaoke word, lifted. paint(l, s, dx, w) draws the text s, w wide, dx to the right of the word's start,
   raised by l (0 = on the line ... 1 = fully up): the whole word, or, for a word that lifts letter by letter, each of
   its letters in turn. A letter is a picture of its own (its own sprite, with its own blur and glow) put where it
   stands in the word, so nothing is ever cut; such a word is drawn that way the whole time, not only while it rises,
   so that it does not change in the least when the lift begins or ends. Letters set close lie over each other
   ("yy"), and dim text painted twice is brighter there: the letters of a word are therefore put together first and
   dimmed as one (drawLitGroup). whole: keep the word in one piece this time (while it is blurred: the blurs of
   letters lying over each other do not add up to the blur of the word).
   Returns true while anything is still rising. */
function liftWord(tk, M, kar, t, SE, paint, whole){
  const st = kar.st[tk.k], du = kar.du[tk.k], lx = !whole && du >= LIFT_SLOW ? letterEdges(tk, M) : null;
  if (!lx){
    const p = (t - st) / liftDur(du);
    // kept in one piece (a word that would be split, while it is blurred: a line on its way out), it still floats as its
    // letters do: ts, when the light reaches each of them
    const le = whole && du >= LIFT_SLOW ? letterEdges(tk, M) : null, span = tk.w + SE / 2;
    const ts = le ? le.slice(0, -1).map((x, i) => letterLift(st, du, x, le[i + 1], span)[0]) : [st];
    paint(liftE(p), tk.s, 0, tk.w, 0, ts);
    return p > 0 && p < 1;
  }
  const cs = tk.cs, span = tk.w + SE / 2;
  let moving = false;
  for (let i = 0; i < cs.length; i++){
    const [t0, d] = letterLift(st, du, lx[i], lx[i + 1], span), p = (t - t0) / d;
    if (p > 0 && p < 1) moving = true;
    paint(liftE(p), cs[i], lx[i], M.w(cs[i], false), i, [t0]);
  }
  return moving;
}
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

/* the timeline of M, built when something first reads it: only the one-line layout does (the scrolling column never
   reads it, and it took 10 ms and more to build for a whole song) */
function lazyTimeline(M){
  let segs = null;
  const get = () => segs || (segs = buildTimeline(M));
  return new Proxy([], { get: (_, k) => get()[k], has: (_, k) => k in get() });
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
    const p0 = prof.on ? performance.now() : 0;
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
    if (p0) prof.bake += performance.now() - p0;
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
  function drawLit(ctx, text, isSub, x, y, alpha, x1, fe, glow, lum, blur = 0, halosOnly = false){
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
    for (let L = gg > 0.004 ? GL.length : 0; L >= (halosOnly ? 1 : 0); L--){
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
  /* A karaoke word drawn letter by letter (liftWord). parts: its letters, each { s, dx, dy, w }: the text, where it
     stands from the word's start (x, y) and how wide it is. The letters are whole pictures and lie over each other
     where they are set close; painted one by one, dim text would be twice as bright there. So they are first put
     together at full strength on a canvas of their own, where painting twice changes nothing, and that is painted
     as one: dim (base), then the part the sweep has reached (lit; x1, fe: the edge, as in drawLit, from the word's
     start; w: the word's width). The halos are light and do add up: letter by letter, as before. */
  let G = null, Gx = null;
  function drawLitGroup(ctx, parts, x, y, base, lit, x1, fe, lum, blur, w){
    if (!M.blurOK) blur = 0;
    if (lit > 0 && GL.length) for (const p of parts){
      const e = x1 - p.dx, k = p.sc || 1;
      if (k !== 1){ const cx = x + p.dx + p.w / 2, cy = y + p.dy; ctx.save(); ctx.translate(cx, cy); ctx.scale(k, k); ctx.translate(-cx, -cy); }
      drawLit(ctx, p.s, false, x + p.dx, y + p.dy, lit, e - fe / 2 >= p.w + 1 ? Infinity : e, fe, true, lum, blur, true);
      if (k !== 1) ctx.restore();
    }
    let bi = 0;
    while (bi < LEVELS.length - 2 && LEVELS[bi + 1] < blur) bi++;
    const blo = LEVELS[bi], bhi = LEVELS[bi + 1];
    const bf = blur <= blo ? 0 : blur >= bhi ? 1 : (blur - blo) / (bhi - blo);
    const lv = bf < 0.001 ? [[bi, 1]] : bf > 0.999 ? [[bi + 1, 1]] : [[bi, 1 - bf], [bi + 1, bf]];
    // the part of a pixel the word is off by goes into the group, which is then put down on whole pixels: the letters
    // are resampled once, as when they were painted straight onto the frame
    const m = ctx.getTransform(), plain = m.a === 1 && m.d === 1 && !m.b && !m.c;
    const sx = plain ? x + m.e - Math.floor(x + m.e) : 0, sy = plain ? y + m.f - Math.floor(y + m.f) : 0;
    const full = x1 - fe / 2 >= w + 1;
    const floats = parts.some(p => p.sc && p.sc !== 1);      // letters that float and grow need room above and around
    for (const [lev, wt] of lv){
      const s0 = get(parts[0].s, false, lev, 0), PX = s0.ox + 2 + (floats ? Math.ceil(M.fs * 0.12) : 0), PY = s0.oy + Math.ceil(M.fs * (floats ? 0.26 : 0.06)) + 2;
      const gw = Math.ceil(w + 2 * PX) + 2, gh = Math.ceil(s0.dh + M.fs * (floats ? 0.52 : 0.12)) + 6;
      if (!G || G.width < gw || G.height < gh){ G = mk(Math.max(gw, G ? G.width : 0), Math.max(gh, G ? G.height : 0)); Gx = G.getContext('2d'); }
      // all of it, not only the part in use: put down between two pixels or scaled, the edge of that part takes in a
      // little of what lies just outside it, and what an earlier, wider word left there showed as a thin white line
      Gx.globalCompositeOperation = 'source-over'; Gx.globalAlpha = 1; Gx.clearRect(0, 0, G.width, G.height);
      for (const p of parts){
        const sp = get(p.s, false, lev, 0), k = p.sc || 1;
        if (k === 1){ Gx.drawImage(sp.c, PX + sx + p.dx - sp.ox, PY + sy + p.dy - sp.oy, sp.dw, sp.dh); continue; }
        const cx = PX + sx + p.dx + p.w / 2, cy = PY + sy + p.dy;      // a floating letter grows about its middle
        Gx.save(); Gx.translate(cx, cy); Gx.scale(k, k); Gx.translate(-cx, -cy);
        Gx.drawImage(sp.c, PX + sx + p.dx - sp.ox, PY + sy + p.dy - sp.oy, sp.dw, sp.dh);
        Gx.restore();
      }
      const out = a => { if (a > 0.002){ ctx.globalAlpha = Math.min(1, a) * spriteAlphaMul; ctx.drawImage(G, 0, 0, gw, gh, x - sx - PX, y - sy - PY, gw, gh); } };
      out(base * wt);
      if (lit <= 0) continue;
      if (!full){
        const f = fe + LEVELS[lev] * 2, e0 = x1 - f / 2, e1 = x1 + f / 2;
        Gx.globalCompositeOperation = 'destination-in';
        const g = Gx.createLinearGradient(PX + sx + e0, 0, PX + sx + Math.max(e1, e0 + 0.5), 0);
        for (const [o, v] of MASK_STOPS) g.addColorStop(o, `rgba(0,0,0,${v})`);
        Gx.fillStyle = g; Gx.fillRect(0, 0, gw, gh);
      }
      out(lit * wt);
    }
  }
  return { draw, drawLit, drawLitGroup };
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
        const ex = swc - SWo.offs[tk.k];             // sweep edge, relative to this word
        if (ex - SE / 2 >= tk.w) lit++;
        shown++;
        const x = x0 + tk.x, y0 = cy + 0.2 * fs * (1 - lineE) + wDy, hg = holdGlow(kar, tk.k, t), hf = holdFloat(kar, tk.k) * (1 - w);      // (w: how far the word is on its way out)
        if (hg > 0) moving = true;
        if (hf > 0 && t > kar.st[tk.k] && t < kar.st[tk.k] + kar.hold + FLOAT.dur) moving = true;      // the swell runs along the word
        const leaving = xing && (exBlur + wBlur > 0.3 || wSc !== 1);      // blurred or scaled on its way out: in one piece
        const parts = [];                              // the letters of a word that lifts letter by letter
        if (liftWord(tk, M, kar, t, SE, (l, s, dx, w, i, ts) => {
          const fl = hf > 0 ? floatLetter(hf, t, ts) : null;      // a long last word floats letter by letter: higher, a little larger, and down again
          const yy = y0 - 0.05 * fs * l - (fl ? fl.up * fs : 0), xs = x + dx, e = ex - dx;       // e: the sweep edge, relative to this piece
          const grown = fl && fl.sc !== 1 ? fl.sc : 1, lx = xs + w / 2;
          if (grown !== 1){ ctx.save(); ctx.translate(lx, yy); ctx.scale(grown, grown); ctx.translate(-lx, -yy); }
          if (hg > 0) SP.drawLit(ctx, s, false, xs, yy, a * hg, e - SE / 2 >= w + 1 ? Infinity : e, SE, true, a * hg, HOLD.blur * bs + exBlur + wBlur);      // a long last word: a little more light around it, as far as the sweep has come
          if (s !== tk.s){ if (grown !== 1) ctx.restore(); return parts.push({ s, dx, dy: yy - y0, w, sc: grown }); }
          if (leaving && ex - SE / 2 >= tk.w){ if (grown !== 1) ctx.restore(); return put(s, cx, yy, wSc, a, exBlur + wBlur, w); }
          // dim base (no glow) + bright part swept in from the left (same edge as the CSS gradient)
          SP.drawLit(ctx, s, false, xs, yy, a * 0.3, Infinity, 0, false);
          if (e + SE / 2 > 0) SP.drawLit(ctx, s, false, xs, yy, a * (drawOnColour ? 1 : 0.7), e - SE / 2 >= w + 1 ? Infinity : e, SE, true, a);
          if (grown !== 1) ctx.restore();
        }, leaving)) moving = true;
        if (parts.length) SP.drawLitGroup(ctx, parts, x, y0, a * 0.3, ex + SE / 2 > 0 ? a * (drawOnColour ? 1 : 0.7) : 0, ex, SE, a, 0, tk.w);
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
Object.assign(late, { liftDur, liftSplit, letterLift, HOLD, holdStrength, SWEEP, sweepPos });
