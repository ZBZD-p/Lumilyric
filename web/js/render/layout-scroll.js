import { late } from '../core/late.js';
import { assignMode, lineTokenTimes, mode, song } from '../core/lyrics.js';
import { coverGlideNow, fx, karaokeTimes } from '../core/settings.js';
import { glideAt, glideKick } from '../core/glide.js';
import { greedy, joinU, lineTexts, tokens, units } from './view-dom.js';
import { HOLD, SWEEP, canvasMeasurer, clamp01, cubicBezier, drawOnColour, holdGlow, liftWord, rowOffs, setSpriteAlphaMul, spriteCache, sweepActive, sweepPos } from './text-canvas.js';
import { createSongStage } from './song-transition.js';

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
// scrolling easing: starts gently (no jolt), glides, and settles over a long soft tail
const scrollE = cubicBezier(0.36, 0, 0.14, 1);
function scrollLayout(M2, W, H){
  const key = song.lines.length + '|' + mode + '|' + W + 'x' + H + '|' + M2._x0;
  // a few layouts per song are kept (the language being left and the one being switched to are both drawn for a moment)
  const mem = M2._slm || (M2._slm = new WeakMap());
  let byKey = mem.get(song);
  if (!byKey) mem.set(song, byKey = new Map());
  const hit = byKey.get(key);
  if (hit) return hit;
  // a fixed-width column filled left to right (like Apple Music): every line breaks at the same right edge,
  // instead of short lines staying on one row and longer ones being split into two even halves
  const maxW = Math.min(W * (1 - 2 * (M2._x0 || 0.1)), M2.fs * 17), MW = Object.assign(Object.create(M2), { avail: () => maxW });
  const wrap = (text, isSub) => {
    if (!text) return [];
    if (MW.w(text, isSub) <= maxW) return [text];
    const g = greedy(units(text, isSub, MW), isSub, MW);
    // no lonely last word: pull one word down from the row above when it still fits
    const L = g.length;
    if (L > 1 && g[L - 1].length === 1 && g[L - 2].length > 2){
      const mv = g[L - 2].pop(), last = [{ ...mv, sp: false }, { ...g[L - 1][0], sp: g[L - 1][0].sp || mv.sp }];
      if (MW.w(joinU(last), isSub) <= maxW) g[L - 1] = last; else g[L - 2].push(mv);
    }
    return g.map(joinU);
  };
  const fs = M2.fs, sfs = M2.sfs, lineH = fs * 1.18, subH = sfs * 1.45, gap = fs * 0.62;
  const items = []; let y = 0, colW = 0;
  song.lines.forEach((L, i) => {
    const { pri, sub } = lineTexts(L);
    let k = 0;
    const rows = wrap(pri, false).map(row => {
      const toks = []; let x = 0;
      for (const tk of tokens(row)){
        const wd = MW.w(tk.trim() ? tk : ' ', false);
        if (tk.trim()) toks.push({ s: tk, x, w: wd, k: k++ });
        x += wd;
      }
      return { toks, width: x };
    });
    const subRows = wrap(sub, true), subWs = subRows.map(r => MW.w(r, true));
    colW = Math.max(colW, ...rows.map(r => r.width), ...subWs);
    const h = rows.length * lineH + (subRows.length ? sfs * 0.45 + subRows.length * subH : 0);
    const times = lineTokenTimes(L, pri);
    const seg = { t: L.t, end: L.end, times: times && times.length === k ? times : null, we: L.wt && L.wt.length === k ? L.wt[k - 1].e : undefined };
    // word-by-word light only with real word times; otherwise the whole line lights up at once, like Apple Music
    items.push({ i, y, h, rows, subRows, subWs, n: k, kar: k && seg.times ? karaokeTimes(seg, k) : null, t: L.t, end: L.end });
    y += h + gap;
  });
  const res = { song, key, items, lineH, subH, colW, maxW };
  if (byKey.size >= 4) byKey.delete(byKey.keys().next().value);
  byKey.set(key, res);
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
  return off;
}
function scrollM(M, W, H){
  const M2 = M._scrollM || (M._scrollM = canvasMeasurer(M.ctx, W, H, M.fs * 0.78, true));
  M2._x0 = M._x0;
  if (!M2.sprites) M2.sprites = spriteCache(M2);
  return M2;
}
/* the point of the area the current line grows from: its left end (its middle when centred), at the focus height.
   Where the lyrics "are" for something that has to follow them (the glide when the cover comes or goes, background.js) */
function scrollAnchor(M, W, H){
  const M2 = scrollM(M, W, H), S = scrollLayout(M2, W, H);
  const x0 = M2._x0 != null ? W * M2._x0 : (W - S.colW) / 2;
  return { x: x0 + (M2._x0 != null ? S.maxW : S.colW) * scrollAlignNow(), y: H * SCROLL.anchor };
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
  const fs = M2.fs, sfs = M2.sfs, bs = fs / 72, anchor = H * SCROLL.anchor;
  // beside the cover the column starts at the area's left margin and is as wide as a row may be; on its own it is
  // centred in the frame and as wide as its widest row. al: where the rows sit in it (对齐, scrollAlignNow)
  const al = scrollAlignNow(), x0 = M2._x0 != null ? W * M2._x0 : (W - S.colW) / 2, span = M2._x0 != null ? S.maxW : S.colW;
  const px = x0 + span * al;                               // px: the point a line grows from
  const rowX = w => x0 + (span - w) * al;
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
  for (let j = first; j <= last; j++){
    const it = items[j], dyj = shiftFn ? shiftFn(j, first) : fade ? fade.dy(j) : 0, off = offFor(j), top = it.y + off + dyj;
    const aPri = fade ? (fade.same(j) ? fade.priSame : fade.alpha) : 1, aSub = fade ? fade.alpha : 1;
    // while the column is dragged, only the lines that are on screen when it rests take part: lines below the screen
    // must not be carried into view as it moves, and the lines above must not be dragged down into it
    if (shiftFn && (it.y + off > H + fs * 2 || it.y + off + it.h < -fs * 2)) continue;
    if (top > H + fs * 2 || top + it.h < -fs * 2) continue;
    // how "current" this line is (fades in when it starts, out when the next one starts)
    const fin = clamp01((t - it.t + L) / SCROLL.fade), fout = j + 1 < items.length ? clamp01((t - items[j + 1].t + L) / SCROLL.fade) : 0;
    const act = clamp01(scrollE(fin) - scrollE(fout));
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
    ctx.translate(px, top); ctx.scale(scale, scale); ctx.translate(-px, -top);
    let ry = top + S.lineH / 2;
    const SWo = it.kar ? rowOffs(it.rows) : null, SE = SWEEP.edge * fs;
    const swc = it.kar && act > 0 ? sweepPos(it.kar, SWo.offs, SWo.ws, SE, t) : 0;
    if (it.kar && act > 0 && sweepActive(it.kar, t)) moving = true;
    for (const row of it.rows){
      const ea = Math.max(act, edge(ry - dyj));
      setSpriteAlphaMul(aPri * ea);
      if (aPri * ea <= 0){ ry += S.lineH; continue; }
      const rx = rowX(row.width);
      for (const tk of row.toks){
        const x = rx + tk.x;
        if (it.kar && act > 0){
          // karaoke inside the current line: dim base, bright sweep word by word
          const q = clamp01((t - it.kar.st[tk.k]) / it.kar.du[tk.k]);
          if (q > 0 && q < 1) moving = true;
          const ex = swc - SWo.offs[tk.k];
          if (ex - SE / 2 >= tk.w) lit++;
          const hg = holdGlow(it.kar, tk.k, t) * act;
          if (hg > 0) moving = true;
          if (liftWord(tk, M2, it.kar, t, SE, (l, s, dx, w) => {
            const yy = ry - 0.05 * fs * l * act, xs = x + dx, e = ex - dx;       // e: the sweep edge, relative to this piece
            if (hg > 0) SP.draw(ctx, s, false, xs, yy, hg, HOLD.blur * bs + blur);      // a long last word: a little more light around it
            SP.drawLit(ctx, s, false, xs, yy, SCROLL.dim, Infinity, 0, false, undefined, blur);
            if (e + SE / 2 > 0) SP.drawLit(ctx, s, false, xs, yy, act * (drawOnColour ? 1 : 1 - SCROLL.dim), e - SE / 2 >= w + 1 ? Infinity : e, SE, true, SCROLL.dim + (1 - SCROLL.dim) * act, blur);
          }, blur > 0.3)) moving = true;      // still blurred as the line comes in: in one piece
        } else {
          SP.draw(ctx, tk.s, false, x, ry, it.kar ? SCROLL.dim : base, blur);
        }
      }
      ry += S.lineH;
    }
    if (it.subRows.length){
      ry = top + it.rows.length * S.lineH + S.lineH / 2;
      ry += sfs * 0.45 - S.lineH / 2 + S.subH / 2;
      const subA = 0.24 + 0.36 * act;
      it.subRows.forEach((r, n) => { setSpriteAlphaMul(aSub * Math.max(act, edge(ry - dyj))); SP.draw(ctx, r, true, rowX(it.subWs[n]), ry, subA, blur); ry += S.subH; });
    }
    setSpriteAlphaMul(1);
    ctx.restore();
  }
  ctx.restore();
  // still moving while any step of the column is under way
  if (curL >= 0){
    for (let k = Math.max(1, curL - 1); k <= curL; k++) if (t - items[k].t + L < SCROLL.dur + SCROLL.maxLag * Math.max(1, fx.scrollDrag ?? 1)) moving = true;
  }
  return moving ? null : 'sc' + curL + ':' + lit;
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
  const M2 = scrollM(M, W, H), anchor = H * SCROLL.anchor;
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
function drawScroll(ctx, W, H, M, t){
  if (typeof late.exporting !== 'undefined' && late.exporting) return drawScrollOne(ctx, W, H, M, t);
  if (modeFade && drawModeFade(ctx, W, H, M, t)) return null;      // still moving
  const D = H + M.fs * 4;
  const r = songStage.step(performance.now(), t);
  if (!r.draw) return 'empty';                           // lyrics locked and gone, waiting for the next song's
  const k = drawScrollOne(ctx, W, H, M, r.draw === 'out' ? r.t : t, r.shift ? (j, f) => r.shift(j, f, D) : null);
  return r.busy ? null : k;
}

let bloomTL = null;                                         // the text layer that feeds the bloom (export)

function setBloomTL(v){ return bloomTL = v; }   // other modules cannot assign to an imported binding

/* names that modules loaded before this one call or read (core/late.js) */
Object.assign(late, { useScroll });
