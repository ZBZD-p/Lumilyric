import { late } from './late.js';
import { glideAt, glideKick } from './glide.js';
import { $, assignPlaying, audio, base, playing, setBase, setStartPerf, song, startPerf } from './lyrics.js';

export {
  ANIMS,
  COVER_GLIDE,
  coverGlideNow,
  FX_DEFAULT,
  assignFx,
  exitSpec,
  exitTotal,
  findIdx,
  fx,
  glowCss,
  glowGain,
  glowLayers,
  hexRGB,
  FONT_STACK_EN,
  FONT_STACK_ZH,
  fontName,
  lyricFont,
  scrollAlignKey,
  karaokeTimes,
  lt,
  lyricDelay,
  now,
  seek,
  setLyricDelay,
  setPlaying,
  togglePlay,
  total,
  dragSize,
  prof,
  windowResizing,
};

/* Where the time of a frame goes, for the performance panel (fx.showFps; main.js): the parts add into this while it is on
   and the main loop reads and clears it each frame. ms. layout: lines laid out anew; bake: text sprites drawn;
   build: the lyric canvas, type and timeline made anew (a window size or type size change); anchor / draw: the
   lyrics' place worked out and drawn (layout and bake happen inside them); bloom: the GPU bloom pass. */
const prof = { on: false, build: 0, anchor: 0, draw: 0, layout: 0, bake: 0, bloom: 0 };

/* The window is being resized: its size changed within the last RESIZE_SETTLE ms. Dragging an edge sends a new size at
   every pixel, and everything sized to the window was built anew for each of them (the lyric canvas with its type, the
   text sprites baked for that type: 50 ms a frame with a whole song). What is built for a size is kept while the type size
   stays the same, and while the edge is being dragged the type size itself moves in coarse steps (dragSize), so that
   most frames only lay the lines out again; at rest it is the exact size again. */
const RESIZE_SETTLE = 160, DRAG_STEP = Math.log(1.08);
let rzW = -1, rzH = -1, rzAt = -1e9;
function windowResizing(){
  const w = innerWidth, h = innerHeight, ms = performance.now();
  if (w !== rzW || h !== rzH){ if (rzW >= 0) rzAt = ms; rzW = w; rzH = h; }
  return ms - rzAt < RESIZE_SETTLE;
}
/* a type size (px) as it is used while the window is dragged: on a grid 8 % apart, which the eye hardly sees (4 % at
   most), so a run of sizes shares the sprites baked for the first */
function dragSize(v){
  return v > 1 && windowResizing() ? Math.round(Math.exp(Math.round(Math.log(v) / DRAG_STEP) * DRAG_STEP)) : v;
}

/* Effect settings (fx), exit presets, karaoke timing, glow */
/* effect settings, shared by live playback and video export */
const ALIGNS = /^(left|center|right)$/;
const FX_DEFAULT = { am: false, amLyrics: true, langSwitch: true, ui: 'glass', render: 'webgl', layout: 'scroll', scrollDrag: 2, scrollBlur: 1, scrollAlign: 'center', scrollAlignCover: 'left', wordAnim: 'pop', showFps: false, perfLite: false, perfPos: 'tc', perfSize: 1, cover: true, anim: 'pop', exit: 'float', exitDur: 0.75, font: { main: { zh: '', en: '', bold: true, s: 1 }, sub: { zh: '', en: '', bold: false, s: 1 } }, bg: { mode: 'flow', speed: 1, dim: 0.3, sat: 1.5, colors: 5, grain: 0, style: 'cover', pulse: 0.5, pulseMode: 'breath', pulseHz: 140, pulseGate: 0, coverLive: false, coverLiveGlide: 0.12 }, glow: { on: true, style: 'soft', strength: 0.2, radius: 0.3, color: '#ffffff', thresh: 0.5, hold: 1, holdFrom: 0.5, float: 1 } };
const ANIMS = ['pop', 'karaoke', 'fade', 'rise'];
/* exit presets. line: the whole line leaves at once; otherwise the words leave one after another.
   dy in em (negative = up), sc = scale change, blur in px at 72 px type */
const EXITS = {
  float:    { line: true,  dy: -0.55, sc: -0.06, blur: 10 },
  fade:     { line: true,  dy: 0,     sc: 0,     blur: 0 },
  sink:     { line: true,  dy: 0.45,  sc: 0,     blur: 4 },
  zoom:     { line: true,  dy: 0,     sc: 0.16,  blur: 14 },
  wordUp:   { line: false, dy: -0.6,  sc: -0.1,  blur: 8 },
  wordDown: { line: false, dy: 0.7,   sc: 0,     blur: 3, easeIn: true }
};
function exitSpec(){
  const X = EXITS[fx.exit] || EXITS.float, D = fx.exitDur;
  return { ...X, D, S: X.line ? 0 : Math.min(0.6, D * 0.6) };     // S = how long the word-by-word cascade takes
}
const exitTotal = () => { const X = exitSpec(); return X.D + X.S; };
let fx = JSON.parse(JSON.stringify(FX_DEFAULT));
/* the lyrics' font: the page's own stacks, with the font picked in the settings put first. `isSub`: the translation line
   (its own choice); `zh`: the text has Chinese / Japanese characters (the Chinese font, otherwise the English one). Used
   by the canvas (text-canvas.js) and written out as CSS variables for the web view (ui-effects.js). */
const FONT_STACK_ZH = '"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif';
const FONT_STACK_EN = 'Archivo,"Noto Sans SC","Helvetica Neue",Arial,sans-serif';
const fontName = n => '"' + String(n).replace(/["\\]/g, '') + '",';
function lyricFont(isSub, zh){
  const F = isSub ? fx.font.sub : fx.font.main, pick = zh ? F.zh : F.en;
  return {
    w: isSub ? (F.bold ? 700 : 400) : F.bold ? (zh ? 900 : 800) : 400,       // 加粗 on = the page's own heavy weight for the lyrics
    family: (pick ? fontName(pick) : '') + (isSub || zh ? FONT_STACK_ZH : FONT_STACK_EN),
  };
}
/* 对齐 of the scrolling column. Two settings, one for each state of 显示封面, because their natural places differ:
   on its own the column is in the middle of the frame and its rows are centred (scrollAlign), beside the cover the
   rows start at one left edge (scrollAlignCover). The 对齐 switch shows and sets the one in use. */
const scrollAlignKey = () => fx.cover ? 'scrollAlignCover' : 'scrollAlign';
/* 显示封面 switched: the lyrics wait a moment while the cover gets going (wait, s), then glide to their new place as if
   it pulled them along (w: how stiff the glide is, see core/glide.js; there in about a second).
   coverGlideNow: how far that change is along at ms (live page). to: 1 = cover, 0 = none; u: how much of the change
   is still to come, from -1 (just switched on) or 1 (just switched off) to 0 (arrived). ONE glide for everything that
   follows the cover (where the lyrics are, background.js; how their rows are aligned, layout-scroll.js): both are
   worked out from u alone, so they cannot get out of step however quickly the switch is clicked. */
const COVER_GLIDE = { wait: 0.2, w: 6.5 };
let coverSeen = null, coverG = null;
function coverGlideNow(ms){
  const to = fx.cover ? 1 : 0;
  if (coverSeen !== null && coverSeen !== to) coverG = glideKick(coverG, coverSeen - to, ms, COVER_GLIDE.wait, COVER_GLIDE.w, 0.0005);
  coverSeen = to;
  const g = glideAt(coverG, ms);
  if (!g) coverG = null;
  return { to, u: g ? g.x : 0, moving: !!g };
}
/* karaoke: when each word starts lighting up and how long the sweep takes (shared by page and export).
   hold: how long the last word of the line is really sung (seg.we = where it ends, from the lyrics' own word times),
   0 when that is not known; a long one gets a little more glow (holdGlow, text-canvas.js). */
function karaokeTimes(seg, n){
  const st = [], du = [];
  if (seg.times && seg.times.length === n){
    for (let k = 0; k < n; k++){
      const nx = k + 1 < n ? seg.times[k + 1] : seg.end;
      st.push(seg.times[k]);
      du.push(Math.min(k + 1 < n ? 1.2 : 1.0, Math.max(0.15, nx - seg.times[k])));
    }
  } else {
    const dur = Math.max(0.3, seg.end - seg.t), d = dur * 0.85 / Math.max(1, n);
    for (let k = 0; k < n; k++){ st.push(seg.t + 0.1 + k * d); du.push(Math.max(0.15, Math.min(1.2, d))); }
  }
  return { st, du, hold: seg.we != null && seg.times && seg.times.length === n ? Math.max(0, seg.we - seg.times[n - 1]) : 0 };
}
/* (fx.render is not read back: the lyrics are always drawn with WebGL. Only a computer without WebGL gets 'dom', the
   page's own text, and that is found out anew each time: drawLiveGL, background.js) */
try { const sv = JSON.parse(localStorage.getItem('lrc-fx') || 'null'); if (sv && sv.glow) fx.glow = { ...fx.glow, ...sv.glow }; fx.glow.strength = isFinite(fx.glow.strength) ? Math.min(1, Math.max(0.05, +fx.glow.strength)) : 0.2; fx.glow.hold = isFinite(fx.glow.hold) ? Math.min(3, Math.max(0, +fx.glow.hold)) : 1; fx.glow.holdFrom = isFinite(fx.glow.holdFrom) ? Math.min(3, Math.max(0.2, +fx.glow.holdFrom)) : 0.5; try { if (!localStorage.getItem('lrc-hold05')){ if (fx.glow.holdFrom === 0.8) fx.glow.holdFrom = 0.5; localStorage.setItem('lrc-hold05', '1'); } } catch(e){} /* 触发时长 is 0.5 s now: a saved 0.8 was only the old default, moved once (a value chosen afterwards stays) */ fx.glow.float = isFinite(fx.glow.float) ? Math.min(2, Math.max(0, +fx.glow.float)) : 1;if (sv && ANIMS.includes(sv.anim)) fx.anim = sv.anim; if (sv && EXITS[sv.exit]) fx.exit = sv.exit; if (sv && typeof sv.showFps === 'boolean') fx.showFps = sv.showFps; if (sv && typeof sv.perfLite === 'boolean') fx.perfLite = sv.perfLite; if (sv && (sv.ui === 'glass' || sv.ui === 'flat')) fx.ui = sv.ui; if (sv && /^(tl|tc|tr|bl|bc|br)$/.test(sv.perfPos)) fx.perfPos = sv.perfPos; if (sv && isFinite(sv.perfSize)) fx.perfSize = Math.min(2, Math.max(0.7, +sv.perfSize)); if (sv && /^(scroll|single|word)$/.test(sv.layout)) fx.layout = sv.layout; if (sv && typeof sv.cover === 'boolean') fx.cover = sv.cover; if (sv && typeof sv.am === 'boolean') fx.am = sv.am; if (sv && typeof sv.amLyrics === 'boolean') fx.amLyrics = sv.amLyrics; if (sv && typeof sv.langSwitch === 'boolean') fx.langSwitch = sv.langSwitch; if (sv && /^(pop|punch|slide|rise|zoom|flip|type|fade)$/.test(sv.wordAnim)) fx.wordAnim = sv.wordAnim; if (sv && isFinite(sv.scrollDrag)) fx.scrollDrag = Math.min(3, Math.max(0, +sv.scrollDrag)); if (sv && ALIGNS.test(sv.scrollAlignCover)){ fx.scrollAlignCover = sv.scrollAlignCover; if (ALIGNS.test(sv.scrollAlign)) fx.scrollAlign = sv.scrollAlign; } else if (sv && sv.scrollAlign === 'center') fx.scrollAlignCover = 'center';      /* saved when there was one 对齐 for both: 居中 was a choice and is kept for both; 靠左 was only the default, so the new defaults apply */ if (sv && isFinite(sv.scrollBlur)) fx.scrollBlur = Math.min(3, Math.max(0, +sv.scrollBlur)); if (sv && sv.bg) fx.bg = { ...fx.bg, ...sv.bg }; if (sv && isFinite(sv.exitDur)) fx.exitDur = Math.min(2, Math.max(0.2, +sv.exitDur));
  if (sv && sv.font) for (const g of ['main', 'sub']){
    const s = sv.font[g], d = fx.font[g];
    if (!s) continue;
    if (typeof s.zh === 'string') d.zh = s.zh.slice(0, 80);
    if (typeof s.en === 'string') d.en = s.en.slice(0, 80);
    if (typeof s.bold === 'boolean') d.bold = s.bold;
    else if (isFinite(s.w) && +s.w > 0) d.bold = +s.w >= 600;        // saved by the earlier weight slider
    if (isFinite(s.s)) d.s = Math.min(2, Math.max(0.5, +s.s));
  }
} catch(e){}
const hexRGB = h => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
/* Bloom: several gaussian halos from tight to wide (like a camera/film bloom).
   Inner halos are close to white, outer ones carry the colour and fade out slowly.
   s = sigma per layer (multiplied by the "范围" setting, in em), w = brightness, white = how much the layer is tinted toward white */
const GLOW_STYLES = {
  // s = blur size of each bloom level (em, scaled by 范围), w = brightness, white = how far the colour is pushed to white
  soft:  { s: [0.06, 0.22, 0.7],  w: [0.55, 0.45, 0.35], white: [0.7, 0.35, 0.1] },
  neon:  { s: [0.04, 0.14, 0.45], w: [0.9, 0.6, 0.35],   white: [0.2, 0, 0] },
  dream: { s: [0.12, 0.45, 1.3],  w: [0.35, 0.45, 0.5],  white: [0.6, 0.35, 0.15] }
};
function glowLayers(){
  const g = fx.glow, st = GLOW_STYLES[g.style] || GLOW_STYLES.soft, c = hexRGB(g.color);
  const k = g.radius / 0.25, q = g.strength / 0.8;
  return st.s.map((sv, i) => ({ sigma: sv * k, alpha: st.w[i] * q,
    rgb: c.map(v => Math.round(v + (255 - v) * st.white[i])) }));
}
/* live page: text-shadow, three levels, each at most twice (a filter on the line measured about 2x slower,
   and the old version stacked up to 8 shadows per glyph). CSS blur radius = 2 sigma; inner levels first. */
/* glow threshold: only text at least this bright gives off light (brightness 0..1; white = 1, dim lines ~0.3).
   Soft: the glow fades in over the 0.3 above the threshold. 0 = everything glows, as before. */
function glowGain(lum){
  const T = fx.glow.thresh || 0;
  if (T <= 0) return 1;
  const hi = Math.min(1, T + 0.3), lo = Math.min(T, hi - 0.05);
  const x = Math.min(1, Math.max(0, (lum - lo) / (hi - lo)));
  return x * x * (3 - 2 * x);
}
function glowCss(gain = 1){
  if (!fx.glow.on || gain <= 0.01) return 'none';
  const out = [];
  for (const L of glowLayers()){
    const a0 = L.alpha * 1.25 * gain, n = Math.min(2, Math.max(1, Math.ceil(a0 - 1e-6))), a = Math.min(1, a0 / n);
    for (let i = 0; i < n; i++) out.push(`0 0 ${(2 * L.sigma).toFixed(3)}em rgba(${L.rgb.join(',')},${a.toFixed(3)})`);
  }
  return out.join(', ');
}
let lyricDelay = 0;                       // seconds; positive = lyrics later, negative = earlier
try { lyricDelay = parseFloat(localStorage.getItem('lrc-delay')) || 0; } catch(e){}
const lt = t => t - lyricDelay;           // audio time -> lyric time

function now(){
  if (typeof late.followOn !== 'undefined' && late.followOn) return late.followNow();
  if (audio) return audio.currentTime;
  return playing ? base + (performance.now() - startPerf) / 1000 : base;
}
function total(){
  if (typeof late.followOn !== 'undefined' && late.followOn) return late.followTotal();
  return audio && isFinite(audio.duration) ? audio.duration : song.length; }

function setPlaying(p){
  // following: the player decides. The page itself calls this in many places (lyrics loaded, a dialog opened ...)
  // and none of them may touch the desktop player; only the user's own play / pause does (togglePlay)
  if (p === playing || (typeof late.followOn !== 'undefined' && late.followOn)) return;
  if (audio){ p ? audio.play().catch(() => {}) : audio.pause(); }
  else if (p){ if (base >= total()) setBase(0); setStartPerf(performance.now()); }
  else setBase(now());
  assignPlaying(p);
  $('icon').innerHTML = p ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4.5v15l13-7.5z"/>';
  $('play').setAttribute('aria-label', p ? '暂停' : '播放');
  late.poke();
}
/* the play button and the space bar: the user's own play / pause. Following: the desktop player is asked, and the
   button changes when the player says it did. */
function togglePlay(){
  if (typeof late.followOn !== 'undefined' && late.followOn) late.followControl(playing ? 'pause' : 'play');
  else setPlaying(!playing);
}
function seek(t){
  if (typeof late.followOn !== 'undefined' && late.followOn){ late.followSeek(t); return; }
  t = Math.max(0, Math.min(total(), t));
  if (audio) audio.currentTime = t; else { setBase(t); setStartPerf(performance.now()); }
  late.render(true);
}

function findIdx(t){
  const L = song.lines; let lo = 0, hi = L.length - 1, ans = -1;
  while (lo <= hi){ const m = (lo + hi) >> 1; if (L[m].t <= t + 0.02){ ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

function setLyricDelay(v){ return lyricDelay = v; }   // other modules cannot assign to an imported binding

function assignFx(v){ return fx = v; }   // other modules cannot assign to an imported binding

/* names that modules loaded before this one call or read (core/late.js) */
Object.defineProperties(late, {
  lyricDelay: { get: () => lyricDelay, enumerable: true },
});
