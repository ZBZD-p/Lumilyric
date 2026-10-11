import { late } from '../core/late.js';
import { $, mode, song } from '../core/lyrics.js';
import { exitTotal, fx, lt, lyricDelay, now } from '../core/settings.js';
import { oneLine } from './view-dom.js';
import { buildTimeline, canvasMeasurer, clamp01, drawSeg, easeOut, setDrawOnColour, setSpriteAlphaMul } from './text-canvas.js';
import { coverHi, coverURL, drawFlowBg, exportDith, exportProf, flowPalette } from '../background/background.js';
import { bloomOpts, exportBloomGL, useWebGL } from './bloom.js';
import { bloomTL, drawScroll, drawScrollOne, scrollE, setBloomTL, songStage, useScroll } from './layout-scroll.js';
import { drawWords, useWordMode } from './layout-words.js';

export {
  drawFrame,
  fitText,
  layoutChange,
  setCoverPanelDirty,
  useCoverPanel,
};

/* Cover panel and the frame composer (drawFrame) */
/* ================= cover panel (Apple Music style) =================
   Landscape: the cover with title and artist on the left, the lyrics on the right half.
   Portrait: a small cover with title and artist across the top, the lyrics below. */
const useCoverPanel = () => !!fx.cover;
/* The area the live picture is laid out in. With the cover panel it is the whole window, exactly like an exported
   frame (cover and lyrics sit where they will in the video; the controls float over it and hide while playing).
   Without it, the stage between the header and the controls, as the web view has always done. */
const liveRect = () => useCoverPanel() ? { left: 0, top: 0, width: innerWidth, height: innerHeight - sheetHeight() } : $('stage').getBoundingClientRect();
/* narrow (portrait) windows: the settings card comes up from the bottom and would cover the line being sung, so while
   it is open the picture is laid out in the part of the window above it */
function sheetHeight(){
  const m = $('fxModal');
  if (m.hidden || m.classList.contains('closing') || m.classList.contains('prewarm') || !matchMedia('(max-width:760px)').matches) return 0;
  return Math.min(innerHeight * 0.6, m.offsetHeight + 20);
}
function coverLayout(W, H){
  if (W >= H * 1.05){
    const s = Math.min(W * 0.3, H * 0.52), tfs = s * 0.075, afs = s * 0.062, gap = s * 0.075;
    const bh = s + gap + tfs * 1.35 + afs * 1.4, x = W * 0.25 - s / 2, y = (H - bh) / 2;
    return { s, x, y, r: s * 0.035, tx: x, ty: y + s + gap, tfs, afs, tw: s, region: { x: W * 0.46, y: 0, w: W * 0.52, h: H } };
  }
  const s = Math.min(W * 0.2, H * 0.11), x = W * 0.07, y = H * 0.045, tfs = s * 0.22, afs = s * 0.18;
  const ry = y + s + H * 0.025;
  return { s, x, y, r: s * 0.06, tx: x + s + s * 0.22, ty: y + s / 2 - (tfs * 1.35 + afs * 1.4) / 2, tfs, afs, tw: W - (x + s + s * 0.22) - x, region: { x: 0, y: ry, w: W, h: H - ry, portrait: true } };
}
const coverTitle = () => song.meta.ti || ($('songTitle') && $('songTitle').textContent) || '';
const coverArtist = () => [song.meta.ar, song.meta.al].filter(Boolean).join(' · ');
function fitText(ctx, text, maxW){
  if (!text || ctx.measureText(text).width <= maxW) return text;
  let a = 0, b = text.length;
  while (a < b){ const m = (a + b + 1) >> 1; if (ctx.measureText(text.slice(0, m) + '…').width <= maxW) a = m; else b = m - 1; }
  return text.slice(0, a) + '…';
}
function drawCoverPanel(ctx, W, H){
  const L = coverLayout(W, H);
  ctx.save();
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; if ('filter' in ctx) ctx.filter = 'none';
  ctx.beginPath(); ctx.roundRect(L.x, L.y, L.s, L.s, L.r);
  ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = L.s * 0.12; ctx.shadowOffsetY = L.s * 0.04;
  ctx.fillStyle = '#222'; ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.clip();
  if (coverHi){
    const k = Math.max(L.s / coverHi.width, L.s / coverHi.height), w = coverHi.width * k, h = coverHi.height * k;   // cover-fit
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(coverHi, L.x + (L.s - w) / 2, L.y + (L.s - h) / 2, w, h);
  } else {                                     // no cover yet: a soft gradient of the palette
    const P = flowPalette, g = ctx.createLinearGradient(L.x, L.y, L.x + L.s, L.y + L.s);
    g.addColorStop(0, `rgb(${P[0].join(',')})`); g.addColorStop(1, `rgb(${(P[2] || P[1] || P[0]).join(',')})`);
    ctx.fillStyle = g; ctx.fillRect(L.x, L.y, L.s, L.s);
    ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.font = `${Math.round(L.s * 0.32)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('♪', L.x + L.s / 2, L.y + L.s / 2);
  }
  ctx.restore();
  ctx.save();
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.globalAlpha = 1;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.font = `700 ${Math.round(L.tfs)}px "Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif`;
  ctx.fillStyle = '#fff'; ctx.fillText(fitText(ctx, coverTitle(), L.tw), L.tx, L.ty);
  ctx.font = `400 ${Math.round(L.afs)}px "Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif`;
  ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillText(fitText(ctx, coverArtist(), L.tw), L.tx, L.ty + L.tfs * 1.35);
  ctx.restore();
}
/* the live page shows the same panel as HTML (kept out of the glow), laid out with the same numbers */
let coverPanelDirty = true, coverPanelKey = '', coverShownBg = '', coverShownText = '';
const COVER_FADE = 1.2;                                  // seconds the cover picture melts into the next one
/* the previous picture stays on a layer above and fades out, so the new cover comes up underneath (also: a first
   cover replaces the gradient, a title / artist fades in) */
function coverBlend(art, bg){
  let old = art.querySelector('.covold');
  if (!old){ old = document.createElement('div'); old.className = 'covold'; art.appendChild(old); }
  if (coverShownBg && coverShownBg !== bg){
    old.style.transition = 'none';
    old.style.backgroundImage = coverShownBg;
    old.style.opacity = '1';
    void old.offsetWidth;                                // apply the start state before the transition
    old.style.transition = `opacity ${COVER_FADE}s ease`;
    old.style.opacity = '0';
  }
  art.style.backgroundImage = bg;
  coverShownBg = bg;
}
function updateCoverPanel(){
  const el = $('coverPanel');
  document.body.classList.toggle('cover-on', useCoverPanel());      // style.css: the header's own title steps aside in portrait
  if (!useCoverPanel()){ if (!el.hidden) el.hidden = true; coverPanelKey = ''; return; }
  const r = liveRect();
  const key = [r.left, r.top, r.width, r.height, coverTitle(), coverArtist(), coverURL].join('|');
  if (!coverPanelDirty && key === coverPanelKey) return;
  coverPanelDirty = false; coverPanelKey = key;
  const L = coverLayout(r.width, r.height);
  el.hidden = false;
  Object.assign(el.style, { left: r.left + L.x + 'px', top: r.top + L.y + 'px' });
  const art = $('covArt');
  Object.assign(art.style, { width: L.s + 'px', height: L.s + 'px' });
  art.style.setProperty('--cr', L.r + 'px'); art.style.setProperty('--cs', L.s + 'px');
  if (coverURL) coverBlend(art, `url("${coverURL}")`);
  else { const P = flowPalette; coverBlend(art, `linear-gradient(135deg, rgb(${P[0].join(',')}), rgb(${(P[2] || P[1] || P[0]).join(',')}))`); }
  const ti = $('covTi'), ar = $('covAr');
  const txt = coverTitle() + '|' + coverArtist();
  ti.textContent = coverTitle(); ar.textContent = coverArtist();
  if (txt !== coverShownText){                          // the words come in softly with the picture
    if (coverShownText) for (const e of [ti, ar]){
      e.style.transition = 'none'; e.style.opacity = '0'; void e.offsetWidth;
      e.style.transition = `opacity ${COVER_FADE / 2}s ease`; e.style.opacity = '1';
    }
    coverShownText = txt;
  }
  for (const [e, fs, dy] of [[ti, L.tfs, 0], [ar, L.afs, L.tfs * 1.35]]){
    Object.assign(e.style, { position: 'absolute', left: (L.tx - L.x) + 'px', top: (L.ty - L.y + dy) + 'px', width: L.tw + 'px', fontSize: fs + 'px', lineHeight: '1.2' });
  }
}
/* a measurer and timeline for the lyrics area next to the cover (narrower, so lines wrap for it) */
function regionM(M, rw, rh, portrait){
  const key = rw + 'x' + rh + fx.layout + !!portrait + fx.font.main.s + fx.font.sub.s;
  if (!M._reg || M._reg.key !== key){
    // the scrolling column wraps itself, so it keeps the full type size; one centred line is sized to the area
    // portrait: the page's CSS size (5.4 % of the width, at most 72 px) is small for a tall window; the export's size for
    // that frame (7.5 % of the width) is what the exported video has, so the page shows the same
    const ms = fx.font.main.s;      // the 字号 setting scales these size rules as it scales the base size
    const fs = useScroll() ? (portrait ? Math.max(M.fs, Math.round(Math.min(rw * 0.075, rh * 0.075) * ms)) : M.fs) : Math.min(M.fs, Math.round(Math.min(rw * 0.075, rh * 0.09) * ms));
    const Mr = canvasMeasurer(M.ctx, rw, rh, fs, true);
    if (M._probe){ Mr.sprites = M.sprites; Mr._probe = true; }
    Mr._x0 = portrait ? 0.07 : 0.04;        // left margin of the scrolling column: lines up with the cover
    M._reg = { key, Mr };
  }
  const Mr = M._reg.Mr, tkey = [song.lines.length, mode, oneLine].join('|');
  if (Mr._segSong !== song || Mr._segKey !== tkey){ Mr._segs = buildTimeline(Mr); Mr._segSong = song; Mr._segKey = tkey; }
  return Mr;
}
/* ================= changing the layout (单句 / 滚动歌词 / 逐词), live only =================
   A strict sequence, like a song change: the layout being left goes out in its own way, then the new one comes in
   in its own way. Only one of the two is drawn at a time.
     out   scrolling: the column, frozen at the moment of the change, is dragged up off the screen (as when the song
                      changes), lines further down trailing a little
           one line:  the current line leaves with the chosen exit (离场), in 0.7 s at most
           one word:  the word fades, rising a little
     in    scrolling: the column is dragged in from below
           one line:  the current line plays its entry (入场) from its start, caught up with the song in under a second
           one word:  the word fades in from a little below
   While it lasts, drawFrame draws as if fx.layout were the layout of the phase. Exported video never sees it. */
const LAYOUT_TR = { scrollOut: 0.45, scrollOutLag: 0.15, scrollIn: 0.8, scrollInLag: 0.3, lag: 0.04, wordOut: 0.3, wordIn: 0.35, singleIn: 0.9, singleOut: 0.7 };
let layoutTr = null;                                 // { from, to, at (ms), t (lyric time then), outDur, inDur }
const layoutInDur = l => l === 'scroll' ? LAYOUT_TR.scrollIn + LAYOUT_TR.scrollInLag : l === 'word' ? LAYOUT_TR.wordIn : LAYOUT_TR.singleIn;
const layoutOutDur = l => l === 'scroll' ? LAYOUT_TR.scrollOut + LAYOUT_TR.scrollOutLag : l === 'word' ? LAYOUT_TR.wordOut : Math.min(exitTotal(), LAYOUT_TR.singleOut);
/* called when the layout setting changes, with what it was */
function layoutChange(from, to){
  if (from === to) return;
  const cur = layoutTrStep();
  if (cur && cur.phase === 'out'){                   // still leaving: carry on, only the destination changes
    if (to === layoutTr.from){ layoutTr = null; return; }
    layoutTr.to = to; layoutTr.inDur = layoutInDur(to); return;
  }
  if (typeof songStage !== 'undefined' && songStage.phase !== 'show'){ layoutTr = null; return; }     // a song change is under way
  layoutTr = { from, to, at: performance.now(), t: lt(now()), outDur: layoutOutDur(from), inDur: layoutInDur(to) };
}
/* which phase the change is in now: { layout, phase: 'out' | 'in', el: seconds into the phase, t }, or null */
function layoutTrStep(){
  if (!layoutTr) return null;
  const el = (performance.now() - layoutTr.at) / 1000, T = layoutTr;
  if (el < T.outDur) return { layout: T.from, phase: 'out', el, t: T.t };
  if (el < T.outDur + T.inDur) return { layout: T.to, phase: 'in', el: el - T.outDur, t: T.t };
  layoutTr = null;
  return null;
}
function drawFrame(ctx, W, H, M, segs, t, transparent, noBloom, noCover){
  const tr = typeof late.exporting !== 'undefined' && late.exporting ? null : layoutTrStep();
  if (!tr) return drawFrameL(ctx, W, H, M, segs, t, transparent, noBloom, noCover, null);
  const keep = fx.layout;
  fx.layout = tr.layout;                             // everything below reads the layout from the setting
  try { drawFrameL(ctx, W, H, M, segs, tr.phase === 'out' ? tr.t : t, transparent, noBloom, noCover, tr); } finally { fx.layout = keep; }
  return null;                                       // still moving
}
function drawFrameL(ctx, W, H, M, segs, t, transparent, noBloom, noCover, tr){
  if (useCoverPanel()){
    // background + cover on the frame, then the lyrics drawn inside the area beside it
    const L = coverLayout(W, H), R = L.region, Mr = regionM(M, Math.round(R.w), Math.round(R.h), R.portrait);
    return drawFrameIn(ctx, W, H, M, Mr, Mr._segs, t, transparent, noBloom, noCover ? null : R, R, tr);
  }
  return drawFrameIn(ctx, W, H, M, M, segs, t, transparent, noBloom, null, null, tr);
}
function drawFrameIn(ctx, W, H, M0, M, segs, t, transparent, noBloom, coverR, R, tr){
  ctx.globalAlpha = 1; if (M.blurOK) ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  const flow = !transparent && fx.bg.mode === 'flow';
  setDrawOnColour(flow);
  if (transparent) ctx.clearRect(0, 0, W, H);
  else if (flow && ctx.canvas){ const p0 = exportProf ? performance.now() : 0; drawFlowBg(ctx, W, H, t + lyricDelay); if (exportProf) exportProf.bg += performance.now() - p0; }      // background follows the audio time
  else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
  if (coverR && ctx.canvas) drawCoverPanel(ctx, W, H);
  // WebGL renderer with glow: text goes to its own layer, the GPU adds the bloom, the result is laid on top
  const BG = !noBloom && fx.glow.on && useWebGL() && ctx.canvas ? exportBloomGL() : null;
  let tc = ctx;
  let finishText = () => {
    if (!BG) return;
    const p0 = exportProf ? performance.now() : 0;
    BG.render(bloomTL, Object.assign(bloomOpts(M), { dith: exportDith }));
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(BG.canvas, 0, 0);
    ctx.restore();
    setDrawOnColour(flow);
    if (exportProf) exportProf.bloom += performance.now() - p0;
  };
  if (BG){
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    if (!bloomTL || bloomTL.width !== cw || bloomTL.height !== ch) setBloomTL(Object.assign(document.createElement('canvas'), { width: cw, height: ch }));
    tc = bloomTL.getContext('2d');
    tc.setTransform(1, 0, 0, 1, 0, 0); tc.globalAlpha = 1; tc.globalCompositeOperation = 'source-over';
    tc.clearRect(0, 0, cw, ch);
    tc.setTransform(ctx.getTransform());
    setDrawOnColour(false);
  }
  if (R){                                             // lyrics beside the cover: work inside that area
    tc.save(); tc.translate(Math.round(R.x), Math.round(R.y));
    const fin = finishText;
    finishText = () => { tc.restore(); fin(); };
    W = Math.round(R.w); H = Math.round(R.h);
  }
  if (tr && useWordMode()){                           // layout change: the word fades out rising / in from below
    const out = tr.phase === 'out', e = easeOut(clamp01(tr.el / (out ? LAYOUT_TR.wordOut : LAYOUT_TR.wordIn)));
    tc.save(); tc.translate(0, (out ? -0.12 * e : 0.16 * (1 - e)) * M.fs);
    setSpriteAlphaMul(out ? 1 - e : e);
    try { drawWords(tc, W, H, M, t); } finally { setSpriteAlphaMul(1); tc.restore(); }
    finishText();
    return null;
  }
  if (tr && useScroll()){                             // layout change: the column is dragged away / in, like a song change
    const out = tr.phase === 'out', C = LAYOUT_TR, dur = out ? C.scrollOut : C.scrollIn, mx = out ? C.scrollOutLag : C.scrollInLag;
    const D = H + M.fs * 4, pr = (j, f) => scrollE(clamp01((tr.el - Math.min(mx, Math.max(0, j - f) * C.lag)) / dur));
    drawScrollOne(tc, W, H, M, t, (j, f) => out ? -D * pr(j, f) : D * (1 - pr(j, f)));
    finishText();
    return null;
  }
  if (tr){                                            // layout change: the line leaves with its exit / plays its entry
    let lo = 0, hi = segs.length - 1, idx = -1;
    while (lo <= hi){ const m = (lo + hi) >> 1; if (segs[m].t <= t + 0.02){ idx = m; lo = m + 1; } else hi = m - 1; }
    const s = idx >= 0 ? segs[idx] : null;
    if (s && !s.blank){
      if (tr.phase === 'out') drawSeg(tc, W, H, M, s, t, tr.el * exitTotal() / Math.min(exitTotal(), LAYOUT_TR.singleOut));    // a long exit (时长) is played faster, not waited for
      // from the start of the line: at least at the song's pace, and level with the song when the phase ends
      else drawSeg(tc, W, H, M, s, Math.min(t, s.t + Math.max(tr.el, (t - s.t) * tr.el / LAYOUT_TR.singleIn)), null);
    }
    finishText();
    return null;
  }
  if (useWordMode()){                                 // 逐词: one word at a time
    const k = drawWords(tc, W, H, M, t);
    finishText();
    return flow || k == null ? null : k;
  }
  if (useScroll()){                                   // Apple Music style scrolling column
    const k = drawScroll(tc, W, H, M, t);
    finishText();
    return flow || k == null ? null : k;
  }
  let lo = 0, hi = segs.length - 1, idx = -1;
  while (lo <= hi){ const m = (lo + hi) >> 1; if (segs[m].t <= t + 0.02){ idx = m; lo = m + 1; } else hi = m - 1; }
  if (idx < 0){ finishText(); return flow ? null : 'empty'; }
  const cur = segs[idx];
  const since = t - cur.t;
  let exiting = false;
  if (idx > 0 && since < exitTotal() && !segs[idx - 1].blank){ drawSeg(tc, W, H, M, segs[idx - 1], t, since); exiting = true; }
  const k = drawSeg(tc, W, H, M, cur, t, null);
  finishText();
  return flow || exiting || k == null ? null : idx + ':' + k;      // a moving background: no frame repeats
}

function setCoverPanelDirty(v){ return coverPanelDirty = v; }   // other modules cannot assign to an imported binding

/* names that modules loaded before this one call or read (core/late.js) */
Object.assign(late, { updateCoverPanel, useCoverPanel, layoutTrStep, liveRect, drawFrame, setCoverPanelDirty });
