import { late } from '../core/late.js';
import { CHARWISE } from '../core/core.js';
import { lineTokenTimes, mode, song } from '../core/lyrics.js';
import { fx } from '../core/settings.js';
import { lineTexts, tokens, zhSeg } from './view-dom.js';
import { canvasMeasurer, clamp01, drawOnColour, easeOut, spriteCache } from './text-canvas.js';
import { scrollE } from './layout-scroll.js';

export {
  WORD_ANIMS,
  drawWords,
  useWordMode,
};

/* Word-by-word layout and its animation presets */
/* ================= 逐词 layout: one word at a time =================
   English: every word. Chinese / Japanese: words found by the browser's word segmenter (Intl.Segmenter),
   punctuation staying with the word before it. Times: the word times when the lyrics have them (a Chinese word
   starts with its first character), otherwise the line is shared out by word length. */
const useWordMode = () => fx.layout === 'word';
const WORDM = { inDur: 0.3, outDur: 0.2, hold: 1.0, fade: 0.45 };
const backOut = p => { const c = 1.9; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };
/* 逐词动画 presets. inn(e) / out(e): e = eased progress 0..1 -> { a, sc, blur (at 72px), dy, dx (em), sy } */
const WORD_ANIMS = {
  pop:   { name: '弹出', inn: e => ({ a: e, sc: 0.86 + 0.14 * e, blur: 10 * (1 - e), dy: 0.18 * (1 - e) }),
                         out: e => ({ a: 1 - e, sc: 1 + 0.08 * e, blur: 6 * e, dy: -0.12 * e }) },
  punch: { name: '重击', inDur: 0.34, inEase: backOut, inn: e => ({ a: Math.min(1, e * 2), sc: 0.55 + 0.45 * e, blur: 6 * Math.max(0, 1 - e * 2) }),
                         out: e => ({ a: 1 - e, sc: 1 - 0.15 * e, blur: 4 * e }) },
  slide: { name: '横滑', inn: e => ({ a: e, dx: 0.9 * (1 - e), blur: 8 * (1 - e) }),
                         out: e => ({ a: 1 - e, dx: -0.9 * e, blur: 8 * e }) },
  rise:  { name: '上升', inn: e => ({ a: e, dy: 0.7 * (1 - e), blur: 6 * (1 - e) }),
                         out: e => ({ a: 1 - e, dy: -0.7 * e, blur: 6 * e }) },
  zoom:  { name: '冲出', inDur: 0.35, inn: e => ({ a: e, sc: 1.9 - 0.9 * e, blur: 16 * (1 - e) }),
                         out: e => ({ a: 1 - e, sc: 1 - 0.35 * e, blur: 8 * e }) },
  flip:  { name: '翻转', inn: e => ({ a: Math.min(1, e * 1.5), sy: e, dy: 0.25 * (1 - e) }),
                         out: e => ({ a: 1 - e, sy: 1 - e, dy: -0.25 * e }) },
  type:  { name: '打字', typing: true, inn: e => ({ a: 1 }), out: e => ({ a: 1 - e }) },
  fade:  { name: '淡入淡出', inDur: 0.4, outDur: 0.3, inn: e => ({ a: e }), out: e => ({ a: 1 - e }) }
};
function lineWords(L, pri){
  const toks = tokens(pri).filter(x => x.trim());
  if (!toks.length) return [];
  const tt = lineTokenTimes(L, pri);
  const direct = tt && L.wt && L.wt.length === toks.length;
  // group tokens into words
  let groups;
  if (CHARWISE.test(pri)){
    groups = []; let k = 0;
    const segs = zhSeg ? [...zhSeg.segment(pri)] : Array.from(pri).map(c => ({ segment: c, isWordLike: /\p{L}|\p{N}/u.test(c) }));
    for (const sg of segs){
      const n = Array.from(sg.segment).filter(c => c.trim()).length;
      if (!n) continue;
      if (!sg.isWordLike && groups.length){ groups[groups.length - 1].n += n; groups[groups.length - 1].s += sg.segment.trim(); }
      else groups.push({ s: sg.segment.trim(), k0: k, n });
      k += n;
    }
  } else groups = toks.map((s, k) => ({ s, k0: k, n: 1 }));
  // times
  const lineEnd = L.end ?? (L.t + 4);
  let starts;
  if (tt) starts = groups.map(g => tt[g.k0]);
  else {
    const span = Math.min(Math.max(0.3, lineEnd - L.t) * 0.9, groups.length * 0.55);
    const w = groups.map(g => 0.6 + g.s.length * 0.12), tot = w.reduce((a, b) => a + b, 0);
    let acc = 0; starts = w.map(x => { const s = L.t + span * acc / tot; acc += x; return s; });
  }
  const lastEnd = direct ? L.wt[L.wt.length - 1].e : Math.min(lineEnd, starts[starts.length - 1] + 1.2);
  return groups.map((g, i) => ({ s: g.s, t: starts[i], e: i + 1 < groups.length ? starts[i + 1] : Math.max(lastEnd, starts[i] + 0.3) }));
}
function wordList(){
  const key = [song.lines.length, mode].join('|');
  if (wordList.c && wordList.c.song === song && wordList.c.key === key) return wordList.c.words;
  const words = [];
  song.lines.forEach((L, i) => {
    const { pri, sub } = lineTexts(L);
    if (!pri) return;
    for (const w of lineWords(L, pri)) words.push({ ...w, line: i, sub });
  });
  words.sort((a, b) => a.t - b.t);
  wordList.c = { song, key, words };
  return words;
}
function drawWords(ctx, W, H, M, t){
  const M3 = M._wordM || (M._wordM = canvasMeasurer(M.ctx, W, H, M.fs * 1.6, true));
  if (!M3.sprites && !M._probe) M3.sprites = spriteCache(M3);
  const SP = M._probe ? M.sprites : M3.sprites;
  const words = wordList();
  if (!words.length) return 'empty';
  let lo = 0, hi = words.length - 1, cur = -1;
  while (lo <= hi){ const m = (lo + hi) >> 1; if (words[m].t <= t + 0.01){ cur = m; lo = m + 1; } else hi = m - 1; }
  if (cur < 0) return 'w-';
  const fs = M3.fs, bs = fs / 72, cx = W / 2, cy = H * 0.47;
  let moving = false;
  ctx.save();
  ctx.globalCompositeOperation = drawOnColour ? 'source-over' : 'lighter';
  const A = WORD_ANIMS[fx.wordAnim] || WORD_ANIMS.pop, inDur = A.inDur || WORDM.inDur, outDur = A.outDur || WORDM.outDur;
  const put = (w, st, mul, text) => {
    const a = (st.a ?? 1) * mul;
    if (a <= 0.003) return;
    const tw = M3.w(w.s, false), fit = Math.min(1, W * 0.86 / Math.max(1, tw)), k = (st.sc ?? 1) * fit, sy = Math.max(0.02, st.sy ?? 1);
    ctx.save(); ctx.translate(cx + (st.dx || 0) * fs, cy + (st.dy || 0) * fs); ctx.scale(k, k * sy);
    SP.draw(ctx, text ?? w.s, false, -tw / 2, 0, a, (st.blur || 0) * bs / k);
    ctx.restore();
  };
  // the word before leaves while the new one comes in
  const w = words[cur], el = t - w.t;
  if (cur > 0 && el < outDur){
    const pw = words[cur - 1], e = easeOut(el / outDur);
    const vis = 1 - scrollE(clamp01((w.t - pw.e - WORDM.hold) / WORDM.fade));   // it may have faded already in a pause
    if (vis > 0) put(pw, A.out(e), vis);
    moving = true;
  }
  // the current word comes in, then stays until the next word (fading out in long pauses)
  const idle = clamp01((t - w.e - WORDM.hold) / WORDM.fade), vis = 1 - scrollE(idle);
  if (idle > 0 && idle < 1) moving = true;
  if (A.typing){
    // 打字: the letters appear one after another over the first part of the word's time
    const chars = Array.from(w.s), dur = Math.min(Math.max(0.12, (w.e - w.t) * 0.7), 0.06 * chars.length + 0.1);
    const n = Math.min(chars.length, Math.floor(el / dur * chars.length) + 1);
    if (n < chars.length) moving = true;
    put(w, A.inn(1), vis, chars.slice(0, n).join(''));
  } else {
    const p = clamp01(el / inDur), e = (A.inEase || scrollE)(p);
    if (p < 1) moving = true;
    put(w, A.inn(e), vis);
  }
  // translation of the line (bilingual mode), small and dim under the word
  if (w.sub){
    const ls = words.findIndex(x => x.line === w.line), lt0 = words[ls].t;
    const sa = 0.55 * scrollE(clamp01((t - lt0) / 0.4)) * (1 - scrollE(idle));
    if (sa > 0.003){
      const sw = M3.w(w.sub, true), fit = Math.min(1, W * 0.86 / Math.max(1, sw));
      ctx.save(); ctx.translate(cx, cy + fs * 0.95); ctx.scale(fit, fit);
      SP.draw(ctx, w.sub, true, -sw / 2, 0, sa, 0);
      ctx.restore();
    }
    if (t - lt0 < 0.4) moving = true;
  }
  ctx.restore();
  return moving ? null : 'w' + cur + ':' + (idle >= 1 ? 'x' : 'v');
}

/* names that modules loaded before this one call or read (core/late.js) */
Object.assign(late, { useWordMode });
