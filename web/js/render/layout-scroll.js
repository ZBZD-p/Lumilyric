import { late } from '../core/late.js';
import { assignMode, lineTokenTimes, mode, song } from '../core/lyrics.js';
import { coverGlideNow, fx, karaokeTimes, prof } from '../core/settings.js';
import { glideAt, glideKick } from '../core/glide.js';
import { greedy, joinU, lineTexts, tokens, units } from './view-dom.js';
import { HOLD, SWEEP, canvasMeasurer, clamp01, cubicBezier, drawOnColour, holdGlow, liftWord, rowOffs, setSpriteAlphaMul, spriteCache, sweepActive, sweepPos } from './text-canvas.js';
import { createSongStage } from './song-transition.js';
import { createSeekMotion } from './seek-motion.js';
import { DOTS, introDots } from './intro-dots.js';
import { duetSides } from '../core/core.js';

export {
  bloomTL,
  drawScroll,
  drawScrollOne,
  modeChanged,
  scrollE,
  scrollAnchor,
  setBloomTL,
  songStage,
  useScroll,
};

/* Scrolling lyrics layout (Apple Music style) */
/* ================= scrolling lyrics (Apple Music style) =================
   Every line in one left-aligned column. The current line sits at a fixed height, bright; the others are dim
   and blur with distance. Without the cover panel the column sits in the middle of the frame; 对齐 = 居中 centres
   every row on the column's axis instead of starting them all at one left edge. When the line changes, the column glides up with a soft spring, and lines further
   down follow a little later, which gives the "wave". Everything is a function of the song time, so the
   exported video moves exactly like the page. */
const useScroll = () => fx.layout === 'scroll';
const SPRING_N = 1 - 8 * Math.exp(-7);
const springE = p => p <= 0 ? 0 : p >= 1 ? 1 : (1 - (1 + 7 * p) * Math.exp(-7 * p)) / SPRING_N;   // critically damped spring, ends exactly at 1
const SCROLL = { anchor: 0.36, dur: 0.95, lag: 0.055, maxLag: 0.4, dim: 0.32, fade: 0.6, lead: 0.12 };
/* background vocals (L.bg, core.js): a block of smaller type under the line (over it, when they begin first) that opens
   while the line is the current one and closes when it is not, as in Apple Music. Its size and its column, as shares of
   the line's. How much of it is open is how "current" the line is (lineAct), so what moves is the same thing that
   lights the line. */
const BG_SIZE = 0.58, BG_W = 0.75;
/* how far a line has come in (fin) and gone out (fout) of being the current one, each 0 .. 1, and the share of it that
   is current (the line fades in when it starts and out when the next one starts) */
const linePhase = (items, j, t) => [clamp01((t - items[j].t + SCROLL.lead) / SCROLL.fade),
  j + 1 < items.length ? clamp01((t - items[j + 1].t + SCROLL.lead) / SCROLL.fade) : 0];
const lineAct = (fin, fout) => clamp01(scrollE(fin) - scrollE(fout));
// scrolling easing: starts gently (no jolt), glides, and settles over a long soft tail
const scrollE = cubicBezier(0.36, 0, 0.14, 1);
/* the song's artist, for telling the main voice of a duet from the other (duetSides): the header's (the player's when
   following, the lyrics' own otherwise) */
const duetArtist = () => song.meta.ar || ((typeof document !== 'undefined' && document.getElementById('songArtist') || {}).textContent || '').split(' · ')[0].trim();
function scrollLayout(M2, W, H){
  const side = duetSides(song, duetArtist());
  const key = song.lines.length + '|' + mode + '|' + W + 'x' + H + '|' + M2._x0 + '|' + side.map(Number).join('');
  // a few layouts per song are kept (the language being left and the one being switched to are both drawn for a moment)
  const mem = M2._slm || (M2._slm = new WeakMap());
  let byKey = mem.get(song);
  if (!byKey) mem.set(song, byKey = new Map());
  const hit = byKey.get(key);
  if (hit) return hit;
  const p0 = prof.on ? performance.now() : 0;
  // a fixed-width column filled left to right (like Apple Music): every line breaks at the same right edge,
  // instead of short lines staying on one row and longer ones being split into two even halves
  const maxW = Math.min(W * (1 - 2 * (M2._x0 || 0.1)), M2.fs * 17), MW = Object.assign(Object.create(M2), { avail: () => maxW });
  // text broken into rows no wider than width, as measured by Mx. rec: gets every width that was measured, each of which
  // was compared with width (fits or not): see span
  const wrapper = (Mx, width, rec) => {
    const MX = Object.assign(Object.create(Mx), { avail: () => width });
    if (rec) MX.w = (t, sub) => { const v = Mx.w(t, sub); rec.push(v); return v; };
    return (text, isSub) => {
      if (!text) return [];
      if (MX.w(text, isSub) <= width) return [text];
      const g = greedy(units(text, isSub, MX), isSub, MX);
      // no lonely last word: pull one word down from the row above when it still fits
      const L = g.length;
      if (L > 1 && g[L - 1].length === 1 && g[L - 2].length > 2){
        const mv = g[L - 2].pop(), last = [{ ...mv, sp: false }, { ...g[L - 1][0], sp: g[L - 1][0].sp || mv.sp }];
        if (MX.w(joinU(last), isSub) <= width) g[L - 1] = last; else g[L - 2].push(mv);
      }
      return g.map(joinU);
    };
  };
  const fs = M2.fs, sfs = M2.sfs, lineH = fs * 1.18, subH = sfs * 1.45, gap = fs * 0.62;
  /* How a line breaks depends on the column's width only through a few comparisons "is this row wider than the
     column?". Of the widths measured (rec), those that fitted give the narrowest column the same breaks come out for
     (lo), those that did not the widest (hi, exclusive). A line's layout is kept with that span and used again for
     any width inside it: the window being dragged moves the column's width by a pixel at a time, and the layout of
     all the lines was worked out anew for each (the result is the same, to the pixel). The rows are laid out for a
     measurer (M2, one type size), so the cache lives on it, and for the language shown. */
  const span = (rec, width) => {
    let lo = 0, hi = Infinity;
    for (const v of rec){ if (v <= width) lo = Math.max(lo, v); else hi = Math.min(hi, v); }
    return [lo, hi];
  };
  const lcSong = M2._lc || (M2._lc = new WeakMap());
  let lcModes = lcSong.get(song);
  if (!lcModes) lcSong.set(song, lcModes = {});
  const lcLines = lcModes[mode] || (lcModes[mode] = []);
  const useCache = !late.noLineCache;
  const rowsOf = (Mx, texts) => {                    // the row's words with their places along it
    let k = 0;
    const rows = texts.map(row => {
      const toks = []; let x = 0;
      for (const tk of tokens(row)){
        const wd = Mx.w(tk.trim() ? tk : ' ', false);
        if (tk.trim()) toks.push({ s: tk, x, w: wd, k: k++ });
        x += wd;
      }
      return { toks, width: x };
    });
    return { rows, k };
  };
  const mainLayout = (L, i) => {
    const { pri, sub } = lineTexts(L);
    let e = lcLines[i];
    if (useCache && e && e.pri === pri && e.sub === sub && maxW >= e.lo && maxW < e.hi) return e;
    const rec = [], wr = wrapper(M2, maxW, rec);
    const { rows, k } = rowsOf(MW, wr(pri, false));
    const subRows = wr(sub, true), subWs = subRows.map(r => MW.w(r, true));
    const [lo, hi] = span(rec, maxW);
    e = { pri, sub, lo, hi, rows, k, subRows, subWs, colW: Math.max(0, ...rows.map(r => r.width), ...subWs),
      h: rows.length * lineH + (subRows.length ? sfs * 0.45 + subRows.length * subH : 0), bg: null };
    return lcLines[i] = e;
  };
  // background vocals (L.bg): smaller type, a narrower column, translation in the usual translation size
  const BM = bgMeasurer(M2, W, H), bgW = maxW * BG_W;
  const bgLayout = (b, e) => {
    const { pri, sub } = lineTexts(b);
    if (!pri) return null;
    let c = e.bg;
    if (!(useCache && c && c.pri === pri && c.sub === sub && bgW >= c.lo && bgW < c.hi)){
      const recP = [], recS = [];
      const { rows, k } = rowsOf(BM, wrapper(BM, bgW, recP)(pri, false));
      const subRows = wrapper(M2, bgW, recS)(sub, true), subWs = subRows.map(r => M2.w(r, true));
      const [lo, hi] = span(recP.concat(recS), bgW), bl = BM.fs * 1.18, padT = fs * 0.15;
      c = e.bg = { pri, sub, lo, hi, rows, k, subRows, subWs, colW: Math.max(0, ...rows.map(r => r.width), ...subWs), bl, padT,
        h: padT + rows.length * bl + (subRows.length ? sfs * 0.45 + subRows.length * subH : 0) };
    }
    const times = lineTokenTimes(b, pri), k = c.k;
    const seg = { t: b.t, end: b.end, times: times && times.length === k ? times : null, we: b.wt && b.wt.length === k ? b.wt[k - 1].e : undefined };
    return { rows: c.rows, subRows: c.subRows, subWs: c.subWs, n: k, kar: k && seg.times ? karaokeTimes(seg, k) : null, lineH: c.bl, padT: c.padT,
      above: !!b.above, h: c.h, colW: c.colW };
  };
  const items = []; let y = 0, colW = 0;
  items.bgs = [];                                  // the lines that have background vocals
  song.lines.forEach((L, i) => {
    const e = mainLayout(L, i), { rows, subRows, subWs, h, k } = e;
    colW = Math.max(colW, e.colW);
    const times = lineTokenTimes(L, e.pri);
    const seg = { t: L.t, end: L.end, times: times && times.length === k ? times : null, we: L.wt && L.wt.length === k ? L.wt[k - 1].e : undefined };
    // word-by-word light only with real word times; otherwise the whole line lights up at once, like Apple Music
    const bg = L.bg ? bgLayout(L.bg, e) : null;
    if (bg){ items.bgs.push(i); colW = Math.max(colW, bg.colW); }
    items.push({ i, y, h, rows, subRows, subWs, n: k, kar: k && seg.times ? karaokeTimes(seg, k) : null, t: L.t, end: L.end, duet: !!side[i], bg });
    y += h + gap;
  });
  // a long intro: the dots stand where the current line does and the lyrics wait one line lower (intro-dots.js)
  if (items.length) items[0].intro = items[0].t >= DOTS.min ? lineH + gap : 0;
  const res = { song, key, items, lineH, subH, colW, maxW };
  if (byKey.size >= 4) byKey.delete(byKey.keys().next().value);
  byKey.set(key, res);
  if (p0) prof.layout += performance.now() - p0;
  return res;
}
/* which line is current at t, and which one the column is already moving to (it starts a moment early) */
function scrollCur(items, t){
  let lo = 0, hi = items.length - 1, cur = -1;
  while (lo <= hi){ const m = (lo + hi) >> 1; if (items[m].t <= t + 0.02){ cur = m; lo = m + 1; } else hi = m - 1; }
  return { cur, curL: cur + 1 < items.length && items[cur + 1].t - SCROLL.lead <= t ? cur + 1 : cur };
}
/* column offset for line j: a sum of eased steps, one per line change, each starting a little later for
   lines further down (the wave). Steps overlap smoothly when lines change quickly. */
function scrollOff(items, j, t, anchor, curL){
  const L = SCROLL.lead;
  let off = anchor - items[0].y;
  const from = Math.max(1, curL - 6), to = curL;
  if (from > 1) off = anchor - items[from - 1].y;
  for (let k = from; k <= to; k++){
    const dr = fx.scrollDrag ?? 1;                  // 拖拽感: how far behind the lines below trail
    const lag = Math.max(0, Math.min(SCROLL.maxLag * dr, (j - k + 1) * SCROLL.lag * dr));   // lines below follow later
    const p = (t - items[k].t + L - lag) / SCROLL.dur;
    if (p <= 0) continue;
    off += (items[k - 1].y - items[k].y) * scrollE(p);
  }
  return off + introRoom(items, j, t) + bgRoom(items, j, t);
}
/* the room the background vocals of the lines before line j have opened (px the column is lower by): only the line that
   is current, and the one that has just stopped being, have any. Part of the offset, so everything that is worked
   out from where lines stand (seeks, a language change, the dots) agrees with what is drawn. */
function bgRoom(items, j, t){
  let room = 0;
  for (const k of items.bgs){
    if (k >= j) break;
    const [fin, fout] = linePhase(items, k, t);
    if (fin > 0 && fout < 1) room += lineAct(fin, fout) * items[k].bg.h;
  }
  return room;
}
/* the room kept for the dots of a long intro (px the column is lower by): given up as the dots go, a step like the one
   of a line change, the lines below trailing the same way */
function introRoom(items, j, t){
  const room = items[0].intro, since = t - items[0].t + DOTS.lead;
  if (!room || since > SCROLL.dur + SCROLL.maxLag * 3) return 0;
  const dr = fx.scrollDrag ?? 1;
  return room * (1 - scrollE((since - Math.min(SCROLL.maxLag * dr, (j + 1) * SCROLL.lag * dr)) / SCROLL.dur));
}
/* the measurer (and sprites) of the background vocals' type, kept on the line's own */
function bgMeasurer(M2, W, H){
  const B = M2._bgM || (M2._bgM = canvasMeasurer(M2.ctx, W, H, Math.round(M2.fs * BG_SIZE), true));
  if (!B.sprites) B.sprites = spriteCache(B);
  return B;
}
function scrollM(M, W, H){
  const M2 = M._scrollM || (M._scrollM = canvasMeasurer(M.ctx, W, H, M.fs * 0.78, true));
  M2._x0 = M._x0; M2._anc = M._anc;
  if (!M2.sprites) M2.sprites = spriteCache(M2);
  return M2;
}
/* the point of the area the current line grows from: its left end (its middle when centred), at the focus height.
   Where the lyrics "are" for something that has to follow them (the glide when the cover comes or goes, background.js) */
function scrollAnchor(M, W, H){
  const M2 = scrollM(M, W, H), S = scrollLayout(M2, W, H);
  const x0 = M2._x0 != null ? W * M2._x0 : (W - S.colW) / 2;
  return { x: x0 + (M2._x0 != null ? S.maxW : S.colW) * scrollAlignNow(), y: H * (M2._anc || SCROLL.anchor) };
}
/* 对齐: where the rows sit in the column: 0 = every row starts at its left edge, 0.5 = every row is centred on its
   axis, 1 = every row ends at its right edge. There is one setting for the column on its own (centred unless chosen
   otherwise) and one for the column beside the cover (left), see scrollAlignKey in settings.js.
   On the live page the rows never jump (an export always has the setting itself):
   - the cover comes or goes: the alignment is mixed from the two settings by how far that change is along
     (coverGlideNow, settings.js), the very glide that moves the lyrics, so rows and column move as one;
   - 对齐 itself is switched: the rows glide to the new place from where they are (core/glide.js), and carry on from
     there when it is switched again before they have arrived. */
const ALIGN = { left: 0, center: 0.5, right: 1 }, ALIGN_W = 8;       // ALIGN_W: stiffness of the glide when 对齐 itself is switched (there in about 0.8 s)
let alignSeen = null, alignTr = null, alignMoving = false;           // the two settings last seen [alone, beside the cover]; the glide after 对齐 was switched; is anything of it under way
function scrollAlignNow(){
  const aNo = ALIGN[fx.scrollAlign] ?? ALIGN.center, aCov = ALIGN[fx.scrollAlignCover] ?? ALIGN.left;
  if (late.exporting) return fx.cover ? aCov : aNo;
  const ms = performance.now(), cg = coverGlideNow(ms), c = cg.to + cg.u;       // c: 0 = no cover ... 1 = cover
  if (alignSeen && (alignSeen[0] !== aNo || alignSeen[1] !== aCov))
    alignTr = glideKick(alignTr, (alignSeen[0] - aNo) * (1 - c) + (alignSeen[1] - aCov) * c, ms, 0, ALIGN_W, 0.001);
  alignSeen = [aNo, aCov];
  const g = glideAt(alignTr, ms);
  if (!g) alignTr = null;
  alignMoving = !!g || cg.moving;
  return aNo + (aCov - aNo) * c + (g ? g.x : 0);
}
/* shiftFn(j, firstVisible) -> extra vertical offset of line j in px (song changes); omitted = 0.
   fade (a language change, see drawScroll): { dy(j) extra offset, alpha for the text, same(j) + priSame: lines whose
   main text is the same in both languages get priSame as its opacity instead } */
function drawScrollOne(ctx, W, H, M, t, shiftFn, fade){
  const M2 = scrollM(M, W, H);
  const SP = M._probe ? M.sprites : M2.sprites, S = scrollLayout(M2, W, H), items = S.items;
  if (!items.length) return 'empty';
  const BM = bgMeasurer(M2, W, H), SPB = M._probe ? M.sprites : BM.sprites;      // the type of the background vocals
  const fs = M2.fs, sfs = M2.sfs, bs = fs / 72, anchor = H * (M2._anc || SCROLL.anchor);
  // beside the cover the column starts at the area's left margin and is as wide as a row may be; on its own it is
  // centred in the frame and as wide as its widest row. al: where the rows sit in it (对齐, scrollAlignNow)
  const al = scrollAlignNow(), x0 = M2._x0 != null ? W * M2._x0 : (W - S.colW) / 2, span = M2._x0 != null ? S.maxW : S.colW;
  // a duet's other voice (it.duet, duetSides) stands on the other side, as in Apple Music: the alignment mirrored
  // (left ⇄ right; centred stays centred)
  const alOf = it => it.duet ? 1 - al : al;
  const pxOf = it => x0 + span * alOf(it);                 // the point a line grows from
  const rowXOf = (it, w) => x0 + (span - w) * alOf(it);
  // which line is current; the column starts moving a moment before the next line begins, so the line arrives as it is sung
  const L = SCROLL.lead, { cur, curL } = scrollCur(items, t);
  const offFor = j => scrollOff(items, j, t, anchor, curL);
  let moving = alignMoving, lit = 0;
  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();       // the column ends at the edge of its area (under the cover, above the controls)
  ctx.globalCompositeOperation = drawOnColour ? 'source-over' : 'lighter';
  // the lines that are on the screen, whatever its height (a tall or high-resolution frame shows many more lines above
  // and below the current one than a wide one), with a little extra for the lines that glide in
  const base = Math.max(cur, 0), reach = fs * 2, atRest = j => items[j].y + offFor(j);
  let first = base, last = base;
  while (first > 0 && base - first < 40 && atRest(first - 1) + items[first - 1].h > -reach) first--;
  while (last < items.length - 1 && last - base < 40 && atRest(last + 1) < H + reach) last++;
  first = Math.max(0, Math.min(first, cur - 4)); last = Math.min(items.length - 1, Math.max(last, base + 8));
  // a language change: also the lines that are on the screen where they are being moved from or to. A line whose
  // place in the new language is outside the area is still in sight when the change begins, and glides out
  if (fade){
    while (first > 0 && base - first < 60 && atRest(first - 1) + fade.dy(first - 1) + items[first - 1].h > -reach) first--;
    while (last < items.length - 1 && last - base < 60 && atRest(last + 1) + fade.dy(last + 1) < H + reach) last++;
  }
  for (let j = first; j <= last; j++){
    const it = items[j], dyj = shiftFn ? shiftFn(j, first) : fade ? fade.dy(j) : 0, off = offFor(j), top = it.y + off + dyj;
    const aPri = fade ? (fade.same(j) ? fade.priSame : fade.alpha) : 1, aSub = fade ? fade.alpha : 1;
    // while the column is dragged, only the lines that are on screen when it rests take part: lines below the screen
    // must not be carried into view as it moves, and the lines above must not be dragged down into it
    if (shiftFn && (it.y + off > H + fs * 2 || it.y + off + it.h < -fs * 2)) continue;
    const bgH = it.bg ? it.bg.h : 0;
    if (top > H + fs * 2 || top + it.h + bgH < -fs * 2) continue;
    // how "current" this line is (fades in when it starts, out when the next one starts)
    const [fin, fout] = linePhase(items, j, t), act = lineAct(fin, fout);
    // each row melts away towards the edges of the area (by where the row itself is, so a line of two rows is not cut in
    // half by the edge); a row is gone before its middle reaches the edge. The current line never fades.
    const edge = y => Math.min(clamp01((y - fs * 0.15) / (fs * 2)), clamp01((H - fs * 0.15 - y) / (fs * 2.6)));
    if ((fin > 0 && fin < 1) || (fout > 0 && fout < 1)) moving = true;
    // distance from the focus position, from where the line actually is right now: blur changes smoothly as the
    // column glides, instead of jumping by a whole step the moment the current line changes
    const dist = Math.abs(top - dyj - anchor) / (S.lineH + fs * 0.62);
    const blur = (1 - act) * Math.min(4, dist) * 1.6 * bs * (fx.scrollBlur ?? 1);    // 模糊: 0 = every line sharp
    const scale = 0.94 + 0.06 * act;
    const base = SCROLL.dim + (1 - SCROLL.dim) * act;           // whole-line brightness when there are no word times
    ctx.save();
    const px = pxOf(it), rowX = w => rowXOf(it, w);
    ctx.translate(px, top); ctx.scale(scale, scale); ctx.translate(-px, -top);
    // one block of words (the line's rows, or its background vocals): rows laid out, kar its word times, Mx / SPx its type
    // and sprites, fsx its size, lh the row height, ry the middle of the first row, mul how much of it is shown
    const words = (rows, kar, Mx, SPx, fsx, lh, ry, mul) => {
      const SWo = kar ? rowOffs(rows) : null, SE = SWEEP.edge * fsx, bsx = fsx / 72;
      const swc = kar && act > 0 ? sweepPos(kar, SWo.offs, SWo.ws, SE, t) : 0;
      if (kar && act > 0 && sweepActive(kar, t)) moving = true;
      for (const row of rows){
        const ea = Math.max(act, edge(fade ? ry : ry - dyj)) * mul;      // a language change: by where the row is now, so that it melts away as it reaches the edge
        setSpriteAlphaMul(aPri * ea);
        if (aPri * ea <= 0){ ry += lh; continue; }
        const rx = rowX(row.width);
        for (const tk of row.toks){
          const x = rx + tk.x;
          if (kar && act > 0){
            // karaoke inside the current line: dim base, bright sweep word by word
            const q = clamp01((t - kar.st[tk.k]) / kar.du[tk.k]);
            if (q > 0 && q < 1) moving = true;
            const ex = swc - SWo.offs[tk.k];
            if (ex - SE / 2 >= tk.w) lit++;
            const hg = holdGlow(kar, tk.k, t) * act;
            if (hg > 0) moving = true;
            const parts = [];                            // the letters of a word that lifts letter by letter
            if (liftWord(tk, Mx, kar, t, SE, (l, s, dx, w) => {
              const yy = ry - 0.05 * fsx * l * act, xs = x + dx, e = ex - dx;       // e: the sweep edge, relative to this piece
              if (hg > 0) SPx.drawLit(ctx, s, false, xs, yy, hg, e - SE / 2 >= w + 1 ? Infinity : e, SE, true, hg, HOLD.blur * bsx + blur);      // a long last word: a little more light around it, as far as the sweep has come
              if (s !== tk.s) return parts.push({ s, dx, dy: yy - ry, w });
              SPx.drawLit(ctx, s, false, xs, yy, SCROLL.dim, Infinity, 0, false, undefined, blur);
              if (e + SE / 2 > 0) SPx.drawLit(ctx, s, false, xs, yy, act * (drawOnColour ? 1 : 1 - SCROLL.dim), e - SE / 2 >= w + 1 ? Infinity : e, SE, true, SCROLL.dim + (1 - SCROLL.dim) * act, blur);
            }, blur > 0.3)) moving = true;      // still blurred as the line comes in: in one piece
            if (parts.length) SPx.drawLitGroup(ctx, parts, x, ry, SCROLL.dim, ex + SE / 2 > 0 ? act * (drawOnColour ? 1 : 1 - SCROLL.dim) : 0, ex, SE, SCROLL.dim + (1 - SCROLL.dim) * act, blur, tk.w);
          } else {
            SPx.draw(ctx, tk.s, false, x, ry, kar ? SCROLL.dim : base, blur);
          }
        }
        ry += lh;
      }
      return ry;
    };
    // background vocals over the line push it down as they open (the block is at the line's top); under it they come
    // out below its translation, and the lines below are pushed down by the same amount (bgRoom)
    const bg = it.bg, mt = top + (bg && bg.above ? act * bg.h : 0);
    words(it.rows, it.kar, M2, SP, fs, S.lineH, mt + S.lineH / 2, 1);
    if (it.subRows.length){
      let ry = mt + it.rows.length * S.lineH + S.lineH / 2;
      ry += sfs * 0.45 - S.lineH / 2 + S.subH / 2;
      const subA = 0.24 + 0.36 * act;
      it.subRows.forEach((r, n) => { setSpriteAlphaMul(aSub * Math.max(act, edge(fade ? ry : ry - dyj))); SP.draw(ctx, r, true, rowX(it.subWs[n]), ry, subA, blur); ry += S.subH; });
    }
    if (bg && act > 0){
      // the rows of the block come apart as it opens (act = how far), and it is as faint as it is closed
      const yb = bg.above ? top : top + it.h + bg.padT, u = act;
      words(bg.rows, bg.kar, BM, SPB, BM.fs, bg.lineH * u, yb + u * bg.lineH / 2, u);
      let ry = yb + u * (bg.rows.length * bg.lineH + sfs * 0.45 + S.subH / 2);
      const subA = 0.24 + 0.36 * act;
      bg.subRows.forEach((r, n) => { setSpriteAlphaMul(aSub * u * Math.max(act, edge(fade ? ry : ry - dyj))); SP.draw(ctx, r, true, rowX(bg.subWs[n]), ry, subA, blur); ry += S.subH * u; });
    }
    setSpriteAlphaMul(1);
    ctx.restore();
  }
  // the dots of a long intro, in the room kept above the first line: they go with the column (and with whatever moves it)
  const dots = items[0].intro && first === 0 ? introDots(t, items[0].t) : null;
  if (dots && dots.alpha > 0 && ctx.arc){
    const dy = shiftFn ? shiftFn(0, first) : fade ? fade.dy(0) : 0, a = dots.alpha * (fade ? fade.alpha : 1);
    const r = fs * DOTS.size / 2, pitch = fs * DOTS.pitch, w = pitch * 2 + r * 2;
    const cx = x0 + (span - w) * al + w / 2, cy = items[0].y + offFor(0) + dy - items[0].intro + S.lineH / 2 + fs * DOTS.drop;
    ctx.translate(cx, cy); ctx.scale(dots.scale, dots.scale);
    dots.dots.forEach((lum, k) => {
      // (their glow is the GPU's bloom, like the text's)
      ctx.globalAlpha = lum * a; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc((k - 1) * pitch, 0, r, 0, Math.PI * 2); ctx.fill();
    });
  }
  ctx.restore();
  // still moving while any step of the column is under way
  if (curL >= 0){
    for (let k = Math.max(1, curL - 1); k <= curL; k++) if (t - items[k].t + L < SCROLL.dur + SCROLL.maxLag * Math.max(1, fx.scrollDrag ?? 1)) moving = true;
  }
  if (items[0].intro && t - items[0].t + DOTS.lead > 0 && t - items[0].t + DOTS.lead < SCROLL.dur + SCROLL.maxLag * Math.max(1, fx.scrollDrag ?? 1)) moving = true;
  // (the dots change with every moment of the song, and stand still when it does)
  return moving ? null : 'sc' + curL + ':' + lit + (dots ? ':' + t.toFixed(3) : '');
}

/* song change (follow mode): the phases are driven by song-transition.js and follow.js; this only draws what the
   stage says. The export draws every frame from the song time alone and ignores it. */
const songStage = createSongStage(scrollE);
/* language change (English / 中文 / 双语), live only: for a moment both are drawn. Every line glides from where it is in
   the old language to where it is in the new one (the spacing changes when translations come or go), the old words
   fade out and the new ones in; a line whose main text is the same in both just stays, only its translation fades. */
const MODE_FADE = 0.6;                                      // seconds
let modeFade = null;                                        // { from: the language being left, at: ms }
function modeChanged(from){ if (from !== mode) modeFade = { from, at: performance.now() }; }
function drawModeFade(ctx, W, H, M, t){
  const p = (performance.now() - modeFade.at) / 1000 / MODE_FADE;
  if (p >= 1 || songStage.phase !== 'show'){ modeFade = null; return false; }
  const e = scrollE(p), a = p * p * (3 - 2 * p), now = mode, old = modeFade.from;
  const M2 = scrollM(M, W, H), anchor = H * (M2._anc || SCROLL.anchor);
  const lay = m => { assignMode(m); try { return scrollLayout(M2, W, H).items; } finally { assignMode(now); } };
  const iOld = lay(old), iNew = lay(now);
  if (!iNew.length || iOld.length !== iNew.length){ modeFade = null; return false; }
  const cO = scrollCur(iOld, t).curL, cN = scrollCur(iNew, t).curL;
  const topO = j => iOld[j].y + scrollOff(iOld, j, t, anchor, cO), topN = j => iNew[j].y + scrollOff(iNew, j, t, anchor, cN);
  const text = it => it.rows.map(r => r.toks.map(k => k.s).join(' ')).join('\n');
  const same = j => text(iOld[j]) === text(iNew[j]);
  assignMode(old);
  try { drawScrollOne(ctx, W, H, M, t, null, { dy: j => (topN(j) - topO(j)) * e, alpha: 1 - a, same, priSame: 0 }); } finally { assignMode(now); }
  drawScrollOne(ctx, W, H, M, t, null, { dy: j => (topO(j) - topN(j)) * (1 - e), alpha: a, same, priSame: 1 });
  return true;
}
/* a jump in time (a seek), live only: how the lines get from where they are shown to the new place is worked out in
   seek-motion.js (the states, and what moves when, are described there); this hands it the layout and draws what it
   says. */
const seekMotion = createSeekMotion(scrollE);
function seekGeo(M2, W, H){
  const items = scrollLayout(M2, W, H).items, anchor = H * (M2._anc || SCROLL.anchor), dr = fx.scrollDrag ?? 1;
  return { key: items, H, reach: M2.fs * 2, gap: M2.fs * 0.62, h: j => items[j].h + (items[j].bg ? items[j].bg.h : 0),
    cur: t => scrollCur(items, t).curL,
    tops: t => { const c = scrollCur(items, t).curL; return items.map((it, j) => it.y + scrollOff(items, j, t, anchor, c)); },
    glide: { dur: SCROLL.dur, lag: SCROLL.lag * dr, maxLag: SCROLL.maxLag * dr } };
}
/* the progress bar: pressed, moved, let go (on the window: the pointer may leave the bar while it is held) */
if (typeof document !== 'undefined'){
  const bar = document.getElementById('seek');
  if (bar){
    bar.addEventListener('pointerdown', e => seekMotion.press(e.clientX));
    addEventListener('pointermove', e => seekMotion.pointer(e.clientX));
    addEventListener('pointerup', () => seekMotion.release()); addEventListener('pointercancel', () => seekMotion.release());
  }
}
function drawScroll(ctx, W, H, M, t){
  if (typeof late.exporting !== 'undefined' && late.exporting) return drawScrollOne(ctx, W, H, M, t);
  if (modeFade && drawModeFade(ctx, W, H, M, t)){ seekMotion.reset(); return null; }      // still moving
  const D = H + M.fs * 4;
  const r = songStage.step(performance.now(), t);
  if (!r.draw){ seekMotion.reset(); return 'empty'; }    // lyrics locked and gone, waiting for the next song's
  if (r.shift || r.draw === 'out'){                      // a song change moves the column itself
    seekMotion.reset();
    const k = drawScrollOne(ctx, W, H, M, r.draw === 'out' ? r.t : t, r.shift ? (j, f) => r.shift(j, f, D) : null);
    return r.busy ? null : k;
  }
  const geo = seekGeo(scrollM(M, W, H), W, H);
  if (!geo.key.length){ seekMotion.reset(); const k = drawScrollOne(ctx, W, H, M, t); return r.busy ? null : k; }
  const sk = seekMotion.step(performance.now(), t, geo, matchMedia('(prefers-reduced-motion:reduce)').matches);
  for (const x of sk.outs){                              // earlier places, on their way out (or melting away)
    const sh = j => x.off[j];
    drawScrollOne(ctx, W, H, M, x.t, sh, x.melting ? { dy: sh, alpha: Math.max(0, x.alpha), same: () => false, priSame: 0 } : undefined);
  }
  const L = sk.live, k = L && sk.byRest ? drawScrollOne(ctx, W, H, M, sk.t, j => L[j])
    : drawScrollOne(ctx, W, H, M, sk.t, null, L ? { dy: j => L[j], alpha: 1, same: () => true, priSame: 1 } : undefined);
  return r.busy || sk.busy ? null : k;
}

let bloomTL = null;                                         // the text layer that feeds the bloom (export)

function setBloomTL(v){ return bloomTL = v; }   // other modules cannot assign to an imported binding

/* names that modules loaded before this one call or read (core/late.js) */
Object.assign(late, { useScroll });
