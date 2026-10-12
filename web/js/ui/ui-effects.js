import { late } from '../core/late.js';
import { $, lrcName, lrcSong, setCur, song } from '../core/lyrics.js';
import { ANIMS, FX_DEFAULT, assignFx, exitSpec, findIdx, fx, glowCss, glowGain, lt, lyricDelay, now, scrollAlignKey, seek, setPlaying } from '../core/settings.js';
import { render, segCache, segmentsFor } from '../render/view-dom.js';
import { cubicBezier } from '../render/text-canvas.js';
import { GRAIN, bassBuild, bassBusy, bassEnv, coverBmp, coverLabel, coverURL, curPalette, followBassOn, liveGLVer, setBgDirty, setLiveGLLast, setLiveGLVer } from '../background/background.js';
import { coverSide, imageSide, setCover, setCoverVideo } from '../background/cover-extract.js';
import { useWebGL } from '../render/bloom.js';
import { WORD_ANIMS } from '../render/layout-words.js';
import { layoutChange, setCoverPanelDirty } from '../render/frame.js';

export {
  applyFx,
  autoCoverAsk,
  closeCoverAsk,
  closeFx,
  coverImgURL,
  fxSlide,
  saveFx,
  setCoverAskPick,
  showCoverAsk,
  setFps,
};

/* Effects panel, cover search */
/* ---- effects panel ---- */
let fxBakedKey = '';
function saveFx(){ try { localStorage.setItem('lrc-fx', JSON.stringify(fx)); } catch(e){} }
function applyFx(){
  document.querySelectorAll('#fxUi button').forEach(b => b.setAttribute('aria-pressed', b.dataset.ui === (fx.ui || 'flat')));
  if (typeof late.applyGlass === 'function') late.applyGlass();
  document.documentElement.style.setProperty('--glow-shadow', glowCss());
  document.documentElement.style.setProperty('--glow-shadow-sub', glowCss(glowGain(0.55)));   // translation line is 55% white
  document.body.dataset.anim = fx.anim;
  document.querySelectorAll('#fxRender button').forEach(b => b.setAttribute('aria-pressed', b.dataset.r === fx.render));
  document.querySelectorAll('#fxLayout button').forEach(b => b.setAttribute('aria-pressed', b.dataset.l === fx.layout));
  $('fxLayoutNote').hidden = fx.layout === 'single';
  $('fxLayoutNote').textContent = fx.layout === 'word' ? '逐词：一次只显示一个词，英文按单词，中文用浏览器自带的分词拆成词语（标点跟着前一个词）。有逐字时间就按演唱时间切换，没有就按句子时长平均分配；双语模式下翻译整句显示在下方。'
    : '滚动歌词有自己的滚动动画；当前句会按逐字时间点亮（没有逐字时间就整句点亮）。';
  $('fxDragRow').hidden = $('fxBlurRow').hidden = $('fxAlignRow').hidden = fx.layout !== 'scroll';
  document.querySelectorAll('#fxAlign button').forEach(b => b.setAttribute('aria-pressed', b.dataset.al === fx[scrollAlignKey()]));
  $('fxWordAnimRow').hidden = fx.layout !== 'word';
  $('fxAnimRow').hidden = $('fxExitRow').hidden = $('fxExitDurRow').hidden = fx.layout !== 'single';      // entry / exit: one line at a time only
  document.querySelectorAll('#fxWordAnim button').forEach(b => b.setAttribute('aria-pressed', b.dataset.wa === (fx.wordAnim || 'pop')));
  { const v = Math.round((fx.scrollDrag ?? 1) * 100), e = $('fxDrag'); e.value = v; e.style.setProperty('--p', v / 3 + '%'); $('fxDragV').textContent = v ? v + '%' : '无'; }
  { const v = Math.round((fx.scrollBlur ?? 1) * 100), e = $('fxBlur'); e.value = v; e.style.setProperty('--p', v / 3 + '%'); $('fxBlurV').textContent = v ? v + '%' : '无'; }
  $('fxFps').checked = !!fx.showFps;
  $('fxLangShow').checked = fx.langSwitch !== false;
  document.body.classList.toggle('no-lang-switch', fx.langSwitch === false);       // style.css hides the header's switch
  $('fxLangRow').hidden = fx.langSwitch !== false;                                 // ... and it moves into this card
  { const el = $('fps'); el.dataset.pos = fx.perfPos || 'tc'; el.style.setProperty('--ps', fx.perfSize || 1); }
  document.querySelectorAll('#fxPerfPos button').forEach(b => b.setAttribute('aria-pressed', b.dataset.p === (fx.perfPos || 'tc')));
  $('fxPerfSize').value = Math.round((fx.perfSize || 1) * 100); $('fxPerfSizeV').textContent = Math.round((fx.perfSize || 1) * 100) + '%';
  $('fxPerfSize').style.setProperty('--p', (($('fxPerfSize').value - 70) / 130 * 100) + '%');
  $('fxPerfLite').checked = !!fx.perfLite;
  $('fxPerfLiteRow').hidden = $('fxPerfPosRow').hidden = $('fxPerfSizeRow').hidden = !fx.showFps;
  $('fxCover').checked = !!fx.cover; setCoverPanelDirty(true);
  $('fxAM').checked = !!fx.am && !!fx.cover;
  $('amLyr').setAttribute('aria-pressed', String(fx.amLyrics !== false && !document.body.classList.contains('am-queue')));      // AM 布局: the lyrics button (js/ui/am.js); off while the play list stands in their place
  if (!fx.showFps) $('fps').hidden = true;
  $('fxRenderNote').textContent = fx.render === 'webgl'
    ? '显卡泛光（线性光、逐级缩放叠加）。网页上看到的和导出的视频是同一个画面。'
    : '网页文字 + 文字阴影辉光，最省资源。想要更真实的泛光，换成 WebGL。';
  // The lyric canvas keeps its text sprites; only what is baked into them needs new ones: the renderer, and the glow
  // when it is not the GPU's bloom. Any other setting is read when a frame is drawn, so a redraw is enough. (Rebuilding
  // on every change made dragging any slider cost 10 ms and more a frame.)
  // (the font is baked into the text sprites as well)
  { const k = JSON.stringify([fx.render, useWebGL() ? 0 : fx.glow, fx.font]); if (k !== fxBakedKey){ fxBakedKey = k; setLiveGLVer(liveGLVer + 1); } else setLiveGLLast(''); }
  const bg = fx.bg;
  $('fxBgSec').classList.toggle('flow', bg.mode === 'flow');
  $('fxBgSec').classList.toggle('blobs', bg.style === 'blobs');
  document.querySelectorAll('#fxBg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.bg === bg.mode && (bg.mode !== 'flow' || b.dataset.style === (bg.style || 'cover'))));
  $('fxBgCoverLive').checked = !!bg.coverLive;
  { const g = isFinite(+bg.coverLiveGlide) ? Math.min(1, Math.max(0, +bg.coverLiveGlide)) : 0.12;
    $('fxBgCoverGlide').value = g; $('fxBgCoverGlideV').textContent = g > 0.005 ? g.toFixed(2) + ' s' : '立刻';
    $('fxBgCoverGlideRow').hidden = !bg.coverLive; }
  $('fxBgSpeed').value = Math.round(bg.speed * 100); $('fxBgSpeedV').textContent = bg.speed.toFixed(2) + '×';
  $('fxBgDim').value = Math.round(bg.dim * 100); $('fxBgDimV').textContent = Math.round(bg.dim * 100) + '%';
  document.querySelectorAll('#fxBgPulseMode button').forEach(b => b.setAttribute('aria-pressed', b.dataset.pm === (bg.pulseMode || 'breath')));
  $('fxBgPulse').value = Math.round(bg.pulse * 100); $('fxBgPulseV').textContent = Math.round(bg.pulse * 100) + '%';
  { const hz = Math.min(300, Math.max(40, +bg.pulseHz || 140)), g = Math.min(0.9, Math.max(0, +bg.pulseGate || 0));
    $('fxBgPulseHz').value = hz; $('fxBgPulseHzV').textContent = hz + ' Hz 以下';
    $('fxBgPulseGate').value = Math.round(g * 100); $('fxBgPulseGateV').textContent = g > 0 ? Math.round(g * 100) + '%' : '关'; }
  $('fxBgPulseNote').textContent = bassBusy ? '正在分析音频的低音…' : followBassOn() ? '跟随播放器：背景跟着电脑正在播放的声音动' : bassEnv ? '' : '载入音频后，背景会跟着低音动起来';
  $('fxBgPulseNote').hidden = !$('fxBgPulseNote').textContent;
  $('fxBgColors').value = bg.colors; $('fxBgColorsV').textContent = bg.colors + ' 种';
  $('fxBgGrain').value = (bg.grain * 100).toFixed(1); $('fxBgGrainV').textContent = (bg.grain * 100).toFixed(1).replace(/\.0$/, '') + '%';
  document.documentElement.style.setProperty('--grain', String(bg.grain));
  $('bgGrain').style.backgroundSize = (128 / (devicePixelRatio || 1)) + 'px';     // one grain dot per screen pixel
  ['fxBgSpeed', 'fxBgDim', 'fxBgColors', 'fxBgGrain', 'fxBgPulse', 'fxBgPulseHz', 'fxBgPulseGate', 'fxBgCoverGlide'].forEach(id => { const el = $(id); el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min) * 100) + '%'); });
  if (coverURL) $('fxCoverImg').src = coverURL; else $('fxCoverImg').removeAttribute('src');
  $('fxCoverName').textContent = coverBmp ? coverLabel : '还没有封面，先用默认配色';
  $('fxPal').innerHTML = curPalette().map(c => `<i style="background:rgb(${c.join(',')})"></i>`).join('');
  if (!$('bgGrain').style.backgroundImage) $('bgGrain').style.backgroundImage = `url(${GRAIN.toDataURL()})`;
  setBgDirty(true);
  const X = exitSpec(), R = document.documentElement.style;
  R.setProperty('--xd', X.D + 's'); R.setProperty('--xs', X.S + 's');
  R.setProperty('--xdy', X.dy + 'em'); R.setProperty('--xsc', String(1 + X.sc)); R.setProperty('--xbl', (X.blur / 72).toFixed(3) + 'em');
  R.setProperty('--xease', X.easeIn ? 'cubic-bezier(.32,0,.67,0)' : 'var(--ease)');
  document.querySelectorAll('#fxExit button').forEach(b => b.setAttribute('aria-pressed', b.dataset.exit === fx.exit));
  $('fxExitDur').value = Math.round(fx.exitDur * 100);
  $('fxExitDurV').textContent = fx.exitDur.toFixed(2) + ' s';
  $('fxExitDur').style.setProperty('--p', ((fx.exitDur * 100 - 20) / 180 * 100) + '%');
  document.querySelectorAll('#fxAnim button').forEach(b => b.setAttribute('aria-pressed', b.dataset.anim === fx.anim));
  const g = fx.glow;
  $('fxGlowOn').checked = g.on;
  $('fxGlowSec').classList.toggle('off', !g.on);
  $('fxGlowStrength').value = Math.round(g.strength * 100);
  $('fxGlowStrengthV').textContent = Math.round(g.strength * 100) + '%';
  $('fxGlowRadius').value = Math.round(g.radius * 100);
  $('fxGlowRadiusV').textContent = g.radius.toFixed(2) + ' em';
  $('fxGlowThresh').value = Math.round((g.thresh || 0) * 100);
  $('fxGlowThreshV').textContent = (g.thresh || 0) > 0 ? '亮度 ' + Math.round(g.thresh * 100) + '%' : '全部发光';
  $('fxGlowHold').value = Math.round(g.hold * 100);
  $('fxGlowHoldV').textContent = g.hold > 0 ? Math.round(g.hold * 100) + '%' : '关';
  $('fxGlowHoldFrom').value = g.holdFrom;
  $('fxGlowHoldFromV').textContent = g.holdFrom.toFixed(1) + ' s';
  $('fxGlowColor').value = g.color;
  document.querySelectorAll('#fxGlowStyle button').forEach(b => b.setAttribute('aria-pressed', b.dataset.style === (g.style || 'soft')));
  document.querySelectorAll('#fxGlowSwatches .sw').forEach(b => b.setAttribute('aria-pressed', b.dataset.c === g.color));
  ['fxGlowStrength', 'fxGlowRadius', 'fxGlowThresh', 'fxGlowHold', 'fxGlowHoldFrom'].forEach(id => { const el = $(id); el.style.setProperty('--p', ((el.value - el.min) / (el.max - el.min) * 100) + '%'); });
}
function setFx(patch){ Object.assign(fx.glow, patch); saveFx(); applyFx(); }
function setAnim(v){ if (!ANIMS.includes(v) || v === fx.anim) return; fx.anim = v; saveFx(); applyFx(); setCur(null); render(true); }
document.querySelectorAll('#fxAnim button').forEach(b => b.onclick = () => setAnim(b.dataset.anim));
document.querySelectorAll('#fxLayout button').forEach(b => b.onclick = () => { const was = fx.layout; fx.layout = b.dataset.l; layoutChange(was, fx.layout); saveFx(); applyFx(); setCur(null); render(true); });
const setFps = v => { fx.showFps = v; late.setFpsT0(0); late.setFpsN(0); late.setFpsLast(0); saveFx(); applyFx(); };
$('fxFps').onchange = e => setFps(e.target.checked);
$('fxPerfLite').onchange = e => { fx.perfLite = e.target.checked; late.setFpsT0(0); late.setFpsN(0); late.setFpsLast(0); saveFx(); applyFx(); };      // the panel is written again at once
document.querySelectorAll('#fxPerfPos button').forEach(b => b.onclick = () => { fx.perfPos = b.dataset.p; saveFx(); applyFx(); });
$('fxPerfSize').oninput = e => { fx.perfSize = e.target.value / 100; saveFx(); applyFx(); };
$('fxWordAnim').append(...Object.entries(WORD_ANIMS).map(([k, A]) => { const b = document.createElement('button'); b.dataset.wa = k; b.textContent = A.name; b.onclick = () => { fx.wordAnim = k; saveFx(); applyFx(); }; return b; }));
$('fxDrag').oninput = e => { fx.scrollDrag = e.target.value / 100; saveFx(); applyFx(); };
document.querySelectorAll('#fxAlign button').forEach(b => b.onclick = () => { fx[scrollAlignKey()] = b.dataset.al; saveFx(); applyFx(); setCur(null); render(true); });
$('fxBlur').oninput = e => { fx.scrollBlur = e.target.value / 100; saveFx(); applyFx(); };
$('fxLangShow').onchange = e => { fx.langSwitch = e.target.checked; saveFx(); applyFx(); };
$('fxCover').onchange = e => { fx.cover = e.target.checked; saveFx(); applyFx(); setCur(null); render(true); };
/* AM 布局 on or off. It needs the cover: switched on with it. The change is played in two parts.
   The bar at the bottom of the window is not turned into the AM layout's controls: it drops out of the window (on),
   or comes up from below it (off), as the piece of glass it is (style.css body.am-barout / am-barin0 / am-barin; the
   glass is drawn from where the bar is, so it goes along).
   Everything else is one movement (a view transition, where the browser has them): the browser takes a picture of
   the page as it is, the page is set out the new way in one go, and what both layouts have travels from its old
   place to its new one, changing size on the way: the cover, the title and the artist (body.vt-am names them). The
   rest melts from the one picture into the other. What only the AM layout has then comes up by itself (amIn,
   amBarIn): its progress line grows from its left end, the buttons one after another. */
const AM_BAR = { out: 300, up: 650 };                   // ms: the bar's drop before anything else moves; how long its way up is watched
let amSwitching = 0;
function setAM(on){
  const body = document.body, calm = matchMedia('(prefers-reduced-motion:reduce)').matches, my = ++amSwitching;
  const go = () => {
    body.classList.remove('am-barout');
    if (!on && !calm) body.classList.add('am-barin0');   // the bar starts below the window ...
    fx.am = on;
    if (fx.am) fx.cover = true;
    saveFx(); applyFx(); setCur(null); render(true);
    if (typeof late.updateCoverPanel === 'function') late.updateCoverPanel();      // the new places now, not a frame later
    if (!on && !calm) requestAnimationFrame(() => requestAnimationFrame(() => {     // ... and comes up
      body.classList.add('am-barin'); body.classList.remove('am-barin0');
      setTimeout(() => { if (my === amSwitching) body.classList.remove('am-barin'); }, AM_BAR.up);
    }));
  };
  const move = () => {
    if (my !== amSwitching) return;
    if (typeof document.startViewTransition !== 'function' || calm) return go();
    body.classList.add('vt-am');
    let tr;
    try { tr = document.startViewTransition(go); } catch (err){ body.classList.remove('vt-am'); return go(); }
    // a transition the browser gives up on (the window is not being drawn, say) has still set the layout: nothing to report
    tr.ready.catch(() => {}); tr.updateCallbackDone.catch(() => {});
    tr.finished.catch(() => {}).then(() => body.classList.remove('vt-am'));
  };
  body.classList.remove('am-barin', 'am-barin0');
  if (on && !calm && !body.classList.contains('am')){ body.classList.add('am-barout'); setTimeout(move, AM_BAR.out); }
  else move();
}
$('fxAM').onchange = e => {           // close the settings drawer first, so it is not left covering the layout switch
  const on = e.target.checked;
  if (!$('fxModal').hidden && !$('fxModal').classList.contains('closing')){
    closeFx();
    setTimeout(() => setAM(on), FX_OUT);
  } else setAM(on);
};
document.querySelectorAll('#fxRender button').forEach(b => b.onclick = () => { fx.render = b.dataset.r; saveFx(); applyFx(); setCur(null); render(true); });
document.querySelectorAll('#fxExit button').forEach(b => b.onclick = () => { fx.exit = b.dataset.exit; saveFx(); applyFx(); });
$('fxExitDur').oninput = e => { fx.exitDur = e.target.value / 100; saveFx(); applyFx(); };
document.querySelectorAll('#fxBg button').forEach(b => b.onclick = () => { fx.bg.mode = b.dataset.bg; if (b.dataset.style) fx.bg.style = b.dataset.style; saveFx(); applyFx(); });
$('fxBgSpeed').oninput = e => { fx.bg.speed = e.target.value / 100; saveFx(); applyFx(); };
$('fxBgDim').oninput = e => { fx.bg.dim = e.target.value / 100; saveFx(); applyFx(); };
document.querySelectorAll('#fxBgPulseMode button').forEach(b => b.onclick = () => { fx.bg.pulseMode = b.dataset.pm; saveFx(); applyFx(); });
$('fxBgCoverLive').onchange = e => { fx.bg.coverLive = e.target.checked; saveFx(); applyFx(); };
$('fxBgCoverGlide').oninput = e => { fx.bg.coverLiveGlide = +e.target.value; saveFx(); applyFx(); };
$('fxBgPulse').oninput = e => { fx.bg.pulse = e.target.value / 100; saveFx(); applyFx(); };
let pulseHzT = 0;                                       // 低音范围: the song's pulse is worked out again, the helper told (a moment after the last change)
$('fxBgPulseHz').oninput = e => {
  fx.bg.pulseHz = +e.target.value; saveFx(); applyFx();
  clearTimeout(pulseHzT); pulseHzT = setTimeout(() => { bassBuild(); if (typeof late.followBassCut === 'function') late.followBassCut(); }, 250);
};
$('fxBgPulseGate').oninput = e => { fx.bg.pulseGate = e.target.value / 100; saveFx(); applyFx(); };
$('fxBgColors').oninput = e => { fx.bg.colors = +e.target.value; saveFx(); applyFx(); };
$('fxBgGrain').oninput = e => { fx.bg.grain = e.target.value / 100; saveFx(); applyFx(); };
/* cover search through the local helper (it downloads the images, so there are no cross-site problems) */
let coverSeq = 0;
const coverImgURL = u => '/api/cover/img?u=' + encodeURIComponent(u);
function openCoverSearch(){
  $('coverModal').hidden = false;
  const m = (lrcSong || song).meta || {};
  if (!$('coverQ').value) $('coverQ').value = [m.ti, m.ar].filter(Boolean).join(' ').replace(/^示例 · /, '');
  $('coverQ').focus(); $('coverQ').select();
  if (!late.helper){ $('coverMsg').textContent = '搜封面要用本地程序：双击项目文件夹里的 start_server.bat 打开页面。也可以点「选图片」用自己的图。'; return; }
  if ($('coverQ').value.trim() && !$('coverRes').children.length) coverSearch();
  else if (!$('coverRes').children.length) $('coverMsg').textContent = '输入歌名或专辑名和歌手，按回车搜索';
}
async function coverSearch(){
  const q = $('coverQ').value.trim();
  if (!q || !late.helper) return;
  const seq = ++coverSeq;
  $('coverRes').textContent = '';
  $('coverMsg').textContent = '正在搜索…';
  try {
    const res = JSON.parse(await late.api('/api/cover/search', JSON.stringify({ q }), { 'Content-Type': 'application/json' }));
    if (seq !== coverSeq) return 0;
    const failed = Object.keys(res.errors || {});
    $('coverMsg').textContent = (res.items.length ? `找到 ${res.items.length} 个封面，点一个使用` : '没有找到，换个关键词试试（专辑名通常更准）')
      + (failed.length ? `（${failed.join('、')} 这次没连上）` : '')
      + (late.helper.lddc ? '' : ' · 装了 LDDC 后还能搜 QQ音乐、网易云、酷狗');
    for (const it of res.items){
      const b = document.createElement('button'); b.className = 'coveritem';
      const img = document.createElement('img'); img.loading = 'lazy'; img.alt = ''; img.src = coverImgURL(it.thumb);
      img.onerror = () => b.remove();
      const t = document.createElement('b'); t.textContent = it.title || '（无标题）';
      const a = document.createElement('span'); a.textContent = [it.source, it.artist].filter(Boolean).join(' · ');
      b.append(img, t, a);
      if (it.motion){ const m = document.createElement('i'); m.className = 'covmotion'; m.textContent = '动态'; b.appendChild(m); }      // Apple Music: this album's cover moves
      b.title = `${it.title} — ${it.artist}（${it.source}）` + (it.motion ? ' · 有动态封面，点了会下载那段视频' : '');
      b.onclick = () => coverPick(it);
      $('coverRes').appendChild(b);
    }
    return res.items.length ? res.items : 0;
  } catch (err){
    if (seq === coverSeq) $('coverMsg').textContent = '搜索失败：' + (err.message || err);
    return 0;
  }
}
/* after lyrics are loaded: search covers once in the background; if something turns up, ask whether to pick one */
let coverAskSeq = 0, coverAskPick = null;       // coverAskPick: a ready-made candidate (follow mode) instead of opening the search
async function autoCoverAsk(){
  coverAskPick = null;
  if (!late.helper || !lrcSong) return;
  const m = lrcSong.meta || {};
  const q = ([m.ti, m.ar].filter(Boolean).join(' ') || lrcName.replace(/[_\-–—]+/g, ' ')).replace(/^示例 · /, '').trim();
  if (!q) return;
  const my = ++coverAskSeq;
  $('coverQ').value = q;
  const items = await coverSearch();
  if (my !== coverAskSeq || !items || !$('coverModal').hidden || !$('exportModal').hidden) return;
  showCoverAsk(items[0].thumb, `按「${q}」搜到 ${items.length} 个封面，要加载封面吗？`);
}
/* the question itself. It must not sit over the lyrics for a whole song when nobody is at the computer: the seconds
   left count down on "不用了", and at zero that is the answer. */
const COVER_ASK_SECS = 10;
let coverAskT = 0;
function showCoverAsk(thumb, msg){
  const im = $('coverAskImg'); im.style.visibility = ''; im.onerror = () => { im.style.visibility = 'hidden'; };
  im.src = coverImgURL(thumb);
  $('coverAskMsg').textContent = msg;
  $('coverAsk').hidden = false;
  $('coverAskYes').focus();
  let left = COVER_ASK_SECS;
  const tick = () => { if (left <= 0) return closeCoverAsk(); $('coverAskSecs').textContent = left--; };
  clearInterval(coverAskT); tick(); coverAskT = setInterval(tick, 1000);
}
const closeCoverAsk = () => { clearInterval(coverAskT); $('coverAsk').hidden = true; coverAskPick = null; };
$('coverAskNo').onclick = closeCoverAsk;
$('coverAskYes').onclick = () => { const it = coverAskPick; coverAskPick = null; closeCoverAsk(); if (it) coverPick(it, true); else openCoverSearch(); };
$('coverAsk').addEventListener('click', e => { if (e.target === $('coverAsk')) closeCoverAsk(); });
async function coverPick(it, onlyIfSharper){
  if (it.motion && it.am && !onlyIfSharper){            // a moving cover (Apple Music): the video; the picture if that fails
    $('coverMsg').textContent = '正在下载动态封面（十几 MB，要等几秒）…';
    try {
      const r = await fetch(`/api/cover/motion?id=${encodeURIComponent(it.am[0])}&cc=${encodeURIComponent(it.am[1])}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (!await setCoverVideo(await r.blob(), `${it.title} · ${it.source}（动态）`)) throw new Error('视频读不了');
      if (fx.bg.mode !== 'flow'){ fx.bg.mode = 'flow'; saveFx(); applyFx(); }
      $('coverModal').hidden = true;
      return;
    } catch (err){ $('status').textContent = '动态封面没下载成（' + (err.message || err) + '），用了静态的那张'; }
  }
  $('coverMsg').textContent = '正在下载大图…';
  try {
    const r = await fetch(coverImgURL(it.full));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    if (onlyIfSharper){                                   // a suggestion: never swap a cover for a blurrier one
      const side = await imageSide(blob);
      if (side <= coverSide){
        $('status').textContent = `没有替换封面：搜到的那张只有 ${side} 像素，不比现在的（${coverSide} 像素）清晰`;
        return;
      }
    }
    if (!await setCover(blob, `${it.title} · ${it.source}`)) throw new Error('图片读不了');
    if (it._tid && typeof late.followSaveCover === 'function' && late.followOn && late.F.trackId === it._tid) late.followSaveCover(blob, it._tid, coverSide);
    if (fx.bg.mode !== 'flow'){ fx.bg.mode = 'flow'; saveFx(); applyFx(); }
    $('coverModal').hidden = true;
  } catch (err){ $('coverMsg').textContent = '下载失败：' + (err.message || err) + '，换一个试试'; }
}
$('coverSearchBtn').onclick = openCoverSearch;
$('coverClose').onclick = () => { $('coverModal').hidden = true; };
$('coverModal').addEventListener('click', e => { if (e.target === $('coverModal')) $('coverModal').hidden = true; });
$('coverQ').addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); coverSearch(); } });
$('coverFile').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const video = /^video\//.test(f.type) || /\.(mp4|m4v|mov|webm)$/i.test(f.name);       // a moving cover
  if (!await (video ? setCoverVideo(f, f.name) : setCover(f, f.name))) $('status').textContent = video ? '这个视频读不了，换成 MP4（H.264）或 WebM 试试' : '这张图片读不了，换一张试试';
  else if (fx.bg.mode !== 'flow'){ fx.bg.mode = 'flow'; saveFx(); applyFx(); }
  e.target.value = '';
};
$('fxGlowOn').onchange = e => setFx({ on: e.target.checked });
$('fxGlowStrength').oninput = e => setFx({ strength: e.target.value / 100 });
$('fxGlowRadius').oninput = e => setFx({ radius: e.target.value / 100 });
$('fxGlowThresh').oninput = e => setFx({ thresh: e.target.value / 100 });
$('fxGlowHold').oninput = e => setFx({ hold: e.target.value / 100 });
$('fxGlowHoldFrom').oninput = e => setFx({ holdFrom: +e.target.value });
$('fxGlowColor').oninput = e => setFx({ color: e.target.value });
document.querySelectorAll('#fxGlowStyle button').forEach(b => b.onclick = () => setFx({ style: b.dataset.style, on: true }));
document.querySelectorAll('#fxGlowSwatches .sw').forEach(b => b.onclick = () => setFx({ color: b.dataset.c, on: true }));
$('fxReset').onclick = () => { assignFx(JSON.parse(JSON.stringify(FX_DEFAULT))); saveFx(); applyFx(); if (typeof late.applyFontFx === 'function') late.applyFontFx(); segCache.clear(); setCur(null); render(true); };
function relayout(){ segCache.clear(); render(true); }
const openFx = () => {
  if (!$('fxModal').hidden && !$('fxModal').classList.contains('closing') && !$('fxModal').classList.contains('prewarm')) return closeFx();
  clearTimeout(fxCloseT); $('fxModal').classList.remove('closing', 'prewarm');
  $('fxModal').hidden = false; document.body.classList.add('fx-open');
  fxSlideTo(0, FX_SLIDE_IN);
  setTimeout(relayout, 520);                       // lines re-fit the narrower stage once the drawer has slid in
  document.querySelector('#fxAnim button[aria-pressed="true"]').focus({ preventScroll: true });   // it is still off screen: do not scroll to it
};
let fxCloseT = 0;
/* The first time the drawer is shown the browser has to lay out and paint all its sliders, which cost a visible
   stutter (two frames of 50 and 23 ms) right at the start of the slide. So it is shown once, all but invisible, while
   nothing is happening; the first real opening then slides like every later one. */
function prewarmFx(){
  const m = $('fxModal');
  if (!m.hidden) return;
  m.classList.add('prewarm'); m.hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
    if (m.classList.contains('prewarm')){ m.hidden = true; m.classList.remove('prewarm'); }
  })));
}
setTimeout(() => (window.requestIdleCallback || setTimeout)(prewarmFx), 1500);
const FX_OUT = 320;                                // ms the drawer takes to slide away
/* The card's slide is driven from the frame loop (fxSlide, called by tick before drawGlass), not by a CSS animation.
   The glass under the card is drawn by script from where the card is; a CSS animation runs on the browser's
   compositor, which keeps moving the card on frames the script misses, so the card and its glass came apart by a
   frame's travel (tens of pixels at this speed) and showed as two cards. Moved here, both land in the same frame.
   The card pops out of the window's edge, a little small at first, with a slight spring; and slips back into it. */
const FX_SLIDE_IN = { dur: 600, ease: cubicBezier(.22, 1.12, .36, 1), sc: 0.08 }, FX_SLIDE_OUT = { dur: FX_OUT, ease: cubicBezier(.5, 0, .9, .4), sc: 0.04 };
let fxSl = null, fxK = 1;                          // fxK: how far out the card is (1 = outside the window, 0 = in place)
function fxSlideTo(k1, A){ fxSl = { k0: fxK, k1, t0: performance.now(), A }; fxSlide(); }
function fxSlide(){
  if (!fxSl) return;
  const S = fxSl, p = (performance.now() - S.t0) / S.A.dur;
  fxK = p >= 1 ? S.k1 : S.k0 + (S.k1 - S.k0) * S.A.ease(p);
  if (p >= 1) fxSl = null;
  const axis = matchMedia('(max-width:760px)').matches ? 'Y' : 'X';       // narrow windows: a sheet from the bottom
  $('fxModal').querySelector('.panel').style.transform = fxK === 0 ? '' : `translate${axis}(calc((100% + 30px) * ${fxK.toFixed(4)})) scale(${(1 - S.A.sc * Math.max(0, fxK)).toFixed(4)})`;
}
const closeFx = () => {
  if ($('fxModal').hidden || $('fxModal').classList.contains('closing')) return;
  // slides out first, the controls widen back at the same pace, then it is really hidden
  $('fxModal').classList.add('closing'); document.body.classList.remove('fx-open');
  fxSlideTo(1, FX_SLIDE_OUT);
  fxCloseT = setTimeout(() => { $('fxModal').hidden = true; $('fxModal').classList.remove('closing'); fxSl = null; fxK = 1; }, FX_OUT);
  setTimeout(relayout, 520);
  $('fxBtn').focus();
};
/* replay the current line from its start so an animation preset can be judged */
function replayLine(){
  const t = lt(now());
  let i = findIdx(t);
  if (i < 0) i = 0;
  const segs = segmentsFor(i);
  let g = segs[0];
  segs.forEach(x => { if (!x.blank && x.t <= t + 0.02) g = x; });
  seek(Math.max(0, g.t + lyricDelay - 0.4));
  setPlaying(true);
}
$('fxReplay').onclick = replayLine;
$('fxX').onclick = closeFx;
$('fxBtn').onclick = openFx;
$('fxClose').onclick = closeFx;
$('fxModal').addEventListener('click', e => { if (e.target === $('fxModal')) closeFx(); });
applyFx();

function setCoverAskPick(v){ return coverAskPick = v; }   // other modules cannot assign to an imported binding

/* names that modules loaded before this one call or read (core/late.js) */
Object.assign(late, { applyFx, saveFx });
