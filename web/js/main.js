import { late } from './core/late.js';
import { parseLRC } from './core/core.js';
import { $, alignStats, assignMode, audio, buildWordTiming, isTTML, lrcName, lrcSong, mode, parseTTML, playing, setAlignStats, setAudio, setAudioFile, setBase, setCur, setLrcName, setLrcRawText, setLrcSong, setPreferAlign, setSong, setSource, setUploadedId, setWhisperWords, song, songFromWhisper, source, toWordLRC, whisperName, whisperWords } from './core/lyrics.js';
import { fx, lyricDelay, now, prof, seek, setPlaying, togglePlay, total } from './core/settings.js';
import { render, segCache, updateSweepDOM } from './render/view-dom.js';
import { analyzeBass, drawLiveBg, drawLiveGL, liveBloom, liveGLx } from './background/background.js';
import { extractCover, setCover } from './background/cover-extract.js';
import { useWebGL } from './render/bloom.js';
import { modeChanged, useScroll } from './render/layout-scroll.js';
import { useWordMode } from './render/layout-words.js';
import { useCoverPanel } from './render/frame.js';
import { closeExport, setDelay } from './export/export.js';
import { autoCoverAsk, closeCoverAsk, closeFx, fxSlide, setFps } from './ui/ui-effects.js';
import { closeLib } from './player/library.js';
import { autoBusy, fmt, scrubbing, setScrubbing } from './player/helper.js';
import { followOn } from './player/follow.js';
import { drawGlass } from './glass/glass.js';

export {
  poke,
};

/* Performance meter, main loop, controls, loading files, keyboard */
/* frame-rate meter: frames counted over half a second, plus the slowest frame in that time */
let fpsN = 0, fpsT0 = 0, fpsLast = 0, fpsWorst = 0;
/* where the time of a frame went (profLast: the frame before the one being started; profWorst: the one before the
   slowest interval of this half second): script time in the parts below, the rest of the interval is the browser's own
   (layout of the page, painting, compositing, waiting for the display) */
let profLast = null, profWorst = null;
let gpuStr;
function gpuName(){                       // the graphics card, as the browser reports it (shortened)
  if (gpuStr !== undefined) return gpuStr;
  gpuStr = '';
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    let s = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
    if (/^ANGLE \(/.test(s)){                // "ANGLE (vendor, card (0x...) Direct3D11 ..., D3D11)" -> "card"
      const parts = s.replace(/^ANGLE \(/, '').replace(/\)$/, '').split(', ');
      s = (parts[1] || parts[0]).replace(/\s*\(0x[0-9a-f]+\)/ig, '').replace(/\s*Direct3D.*$/i, '');
    }
    gpuStr = s ? s.replace(/\s+/g, ' ').trim().slice(0, 48) : '';
    const lose = gl && gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext();
  } catch(e){}
  return gpuStr;
}
function fpsTick(){
  const el = $('fps');
  if (!fx.showFps){ if (!el.hidden) el.hidden = true; return; }
  const t = performance.now();
  if (fpsLast && t - fpsLast > fpsWorst){ fpsWorst = t - fpsLast; profWorst = profLast; }
  fpsLast = t; fpsN++;
  if (!fpsT0) fpsT0 = t;
  if (t - fpsT0 >= 500){
    const fps = fpsN * 1000 / (t - fpsT0);
    el.hidden = false;
    el.className = 'fps' + (fps < 30 ? ' bad' : fps < 50 ? ' slow' : '');
    const canvasView = document.body.classList.contains('webgl') && liveGLx;
    const dpr = devicePixelRatio || 1;
    const [rw, rh] = canvasView ? [liveGLx.tl.width, liveGLx.tl.height] : [Math.round(innerWidth * dpr), Math.round(innerHeight * dpr)];
    const bg = $('bgFlow'), bgOn = fx.bg.mode === 'flow' && bg.width > 2;
    const how = useWebGL() && liveBloom ? 'WebGL' : canvasView ? '画布' : '网页';
    const extra = [useScroll() ? '滚动歌词' : '', useWordMode() ? '逐词' : '', useCoverPanel() ? '封面' : '', fx.glow.on ? '辉光' : ''].filter(Boolean).join(' · ');
    // the slowest frame: how much of it was this page's script, and where that went
    let where = '';
    if (profWorst){
      const p = profWorst, parts = [['重建', p.build], ['排版', p.layout], ['烘焙', p.bake], ['绘制', Math.max(0, p.anchor + p.draw - p.layout - p.bake)],
        ['辉光', p.bloom], ['背景', p.bg], ['玻璃', p.glass], ['页面', p.dom]].filter(x => x[1] >= 0.5);
      where = `\n  脚本 ${p.total.toFixed(0)} ms（${parts.map(x => x[0] + ' ' + x[1].toFixed(0)).join(' · ') || '各项都不到 1 ms'}）· 其余 ${Math.max(0, fpsWorst - p.total).toFixed(0)} ms 是浏览器自己（布局、合成、等显示）`;
    }
    // 精简显示 (fx.perfLite): the frame rate and the slowest frame, and where it went; nothing else
    el.innerHTML = `<b>${Math.round(fps)}</b> FPS · 最慢一帧 ${fpsWorst.toFixed(0)} ms` + where + (fx.perfLite ? '' : '\n' +
      `${how}渲染${extra ? ' · ' + extra : ''}\n` +
      `歌词 ${rw}×${rh}（窗口 ${innerWidth}×${innerHeight} × ${+dpr.toFixed(2)}）` +
      (bgOn ? `\n背景 ${bg.width}×${bg.height}${bg.width < Math.round(innerWidth * dpr) - 1 ? '（放大铺满窗口）' : ''}` : '') +
      (gpuName() ? `\n${gpuName()}` : ''));
    fpsN = 0; fpsT0 = t; fpsWorst = 0; profWorst = null;
  }
}
function tick(){
  fpsTick();
  const profOn = prof.on = fx.showFps;
  let m0 = 0, m1 = 0, m2 = 0, m3 = 0;
  if (profOn){ prof.build = prof.anchor = prof.draw = prof.layout = prof.bake = prof.bloom = 0; m0 = performance.now(); }
  drawLiveBg();
  if (profOn) m1 = performance.now();
  drawLiveGL();
  if (profOn) m2 = performance.now();
  fxSlide();                // the settings card moves here, so the glass drawn next is under it in the same frame
  drawGlass();
  if (profOn) m3 = performance.now();
  const t = now(), T = total();
  if (!audio && !followOn && playing && t >= T){ setBase(T); setPlaying(false); }
  render(false);
  updateSweepDOM();
  if (!scrubbing){
    const v = T ? t / T * 1000 : 0;
    $('seek').value = v; $('seek').style.setProperty('--p', v / 10 + '%');
  }
  $('time').textContent = fmt(t) + ' / ' + fmt(T);
  $('timeL').textContent = fmt(t); $('timeR').textContent = '-' + fmt(Math.max(0, T - t));      // AM 布局: gone by, and still to come, under the two ends of the bar
  if (profOn){
    const m4 = performance.now();
    profLast = { total: m4 - m0, bg: m1 - m0, glass: m3 - m2, dom: m4 - m3, build: prof.build, anchor: prof.anchor, draw: prof.draw, layout: prof.layout, bake: prof.bake, bloom: prof.bloom };
  }
  requestAnimationFrame(tick);
}

/* controls */
$('play').onclick = togglePlay;
$('seek').addEventListener('input', e => { setScrubbing(true); e.target.style.setProperty('--p', e.target.value / 10 + '%'); seek(e.target.value / 1000 * total()); });
$('seek').addEventListener('change', () => setScrubbing(false));

function setMode(m){
  const was = mode;
  assignMode(m);
  if (typeof modeChanged === 'function') modeChanged(was);   // scrolling lyrics glide and fade to the new language
  try { localStorage.setItem('lrc-mode', m); } catch(e){}
  document.querySelectorAll('.seg button[data-mode]').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === m));
  $('amLang').setAttribute('aria-pressed', String(m === 'both'));      // AM 布局: 文A is lit while the translation shows (style.css .ampill)
  render(true);
}
document.querySelectorAll('.seg button[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));

async function readText(file){
  const buf = await file.arrayBuffer();
  let txt = new TextDecoder('utf-8').decode(buf);
  if (txt.includes(String.fromCharCode(0xFFFD))) { try { txt = new TextDecoder('gbk').decode(buf); } catch(e){} }
  return txt.replace(/^﻿/, '');
}
async function loadLRC(file){
  const text = await readText(file);
  const name = file.name.replace(/\.[^.]+$/, '');
  if (isTTML(file.name, text)) return loadTTMLText(text, name);
  loadLRCText(text, name);
}
function loadLRCText(text, name, note){
  const parsed = parseLRC(text);
  if (!parsed.lines.length){ $('status').textContent = '没有在这个文件里找到带时间标签的歌词行，请确认是 .lrc 格式。'; return false; }
  setWhisperWords(null); setAlignStats(null);
  setLrcSong(parsed); setLrcName(name);
  setLrcRawText(text);
  const wordLevel = parsed.lines.some(l => l.wt);
  setPreferAlign(!wordLevel);                // a line-level LRC: the auto panel defaults to aligning it
  applySource('lrc');
  if (note) $('status').textContent += ' · ' + note;
  if (!followOn) setTimeout(autoCoverAsk, 0);
  return true;
}
function loadTTMLText(text, name, note){
  let parsed;
  try { parsed = parseTTML(text); } catch (e){ $('status').textContent = '读不了这个 TTML 文件：' + e.message; return false; }
  if (!parsed.lines.length){ $('status').textContent = '这个 TTML 文件里没有歌词行。'; return false; }
  setWhisperWords(null); setAlignStats(null);
  setLrcSong(parsed); setLrcName(name);
  setLrcRawText(toWordLRC(parsed));          // the local helper aligns LRC text, so keep an LRC copy
  setPreferAlign(false);                     // already word-by-word
  applySource('lrc');
  const n = parsed.lines.filter(l => l.wt).length;
  $('status').textContent = `已载入逐词歌词 ${parsed.lines.length} 行（${n} 行带逐字时间）` + (note ? ' · ' + note : '') + (audio ? '' : ' · 载入音频后可以对照播放');
  if (!followOn) setTimeout(autoCoverAsk, 0);
  return true;
}

/* switch what drives the lyrics: the LRC text, or the Whisper transcript alone */
function applySource(src){
  if (src === 'whisper' && !whisperWords) src = 'lrc';
  setSource(src);
  segCache.clear(); setCur(null);
  if (src === 'whisper'){
    const base = lrcSong || song;
    setSong(songFromWhisper(whisperWords, (lrcSong && lrcSong.meta.ti) || whisperName || 'Whisper 识别歌词'));
    if (lrcSong) { song.meta.ar = lrcSong.meta.ar; song.meta.al = lrcSong.meta.al; }
    const words = song.lines.reduce((a, L) => a + L.wt.length, 0);
    $('status').textContent = `仅用 Whisper 识别结果：${words} 个词，自动分成 ${song.lines.length} 行（按停顿和标点断句，没有中文翻译）`;
  } else {
    if (lrcSong){
      setSong(lrcSong);
      song.lines.forEach(L => { if (L.t0 != null) L.t = L.t0; });
      setAlignStats(whisperWords ? buildWordTiming(song, whisperWords) : null);
      if (!whisperWords) song.lines.forEach((L, i) => L.end = song.lines[i + 1] ? song.lines[i + 1].t : L.t + 4);
    }
    const hasZh = song.lines.some(l => l.zh), hasEn = song.lines.some(l => l.en);
    $('status').textContent = lrcSong ? `已载入 ${song.lines.length} 行歌词` + (hasZh && hasEn ? '（含中文翻译）' : '') + (audio ? '' : ' · 无音频时按时间轴播放') : $('status').textContent;
    if (whisperWords && alignStats) showAlignStatus();
    else if (song.lines.some(l => l.wt)) $('status').textContent += ' · 已读取逐词时间';
  }
  $('songTitle').textContent = song.meta.ti || lrcName || whisperName;
  $('songArtist').textContent = [song.meta.ar, song.meta.al].filter(Boolean).join(' · ') || ' ';
  $('wordLrcBtn').hidden = !song.lines.some(l => l.wt);
  $('srcSeg').hidden = !whisperWords;
  document.querySelectorAll('#srcSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.src === source));
  setPlaying(false); seek(0);
}

function showAlignStatus(){
  const { matched, total } = alignStats;
  const pct = total ? Math.round(matched / total * 100) : 0;
  $('status').textContent = `逐词对齐完成：${matched} / ${total} 个词直接匹配到 Whisper 时间（${pct}%），其余按前后均值补齐`;
}

async function saveTextFile(name, ext, text){
  let dl = null;
  try { dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch(e){}
  if (dl){
    // the artifact viewer only saves common extensions, so .lrc goes out as .lrc.txt
    const filename = `${name}.${ext}.txt`;
    try { await dl.save({ filename, data: text }); $('status').textContent = `已保存 ${filename}，把后缀 .txt 去掉即可当作 .${ext} 使用`; }
    catch (e){ $('status').textContent = e.code === 'declined' ? '已取消保存。' : '无法在这里保存文件（' + (e.code || 'error') + '）。'; }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = `${name}.${ext}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  $('status').textContent = `已开始下载 ${name}.${ext}`;
}
$('wordLrcBtn').onclick = () => {
  const base = (song.meta.ti || '歌词').replace(/[\\/:*?"<>|]+/g, ' ').trim();
  saveTextFile(base + (source === 'whisper' ? ' Whisper 逐词' : ' 逐词'), 'lrc', toWordLRC(song));
};
function loadAudio(file){
  setAudioFile(file); setUploadedId(null);
  if (audio){ audio.pause(); URL.revokeObjectURL(audio.src); }
  const wasPlaying = playing; setPlaying(false);
  setAudio(new Audio(URL.createObjectURL(file)));
  audio.addEventListener('ended', () => setPlaying(false));
  audio.addEventListener('loadedmetadata', () => { $('status').textContent = '音频已载入：' + file.name; });
  extractCover(file).then(b => b && setCover(b, '音频里的封面')).catch(() => {});
  analyzeBass(file);
  setBase(0); seek(0);
  if (wasPlaying) setPlaying(true);
}
$('lrcFile').onchange = e => e.target.files[0] && loadLRC(e.target.files[0]);
$('audioFile').onchange = e => e.target.files[0] && loadAudio(e.target.files[0]);
document.querySelectorAll('#srcSeg button').forEach(b => b.onclick = () => {
  if (b.dataset.src === 'lrc' && !lrcSong){ $('status').textContent = '还没有载入 LRC 歌词，先点“载入歌词 .lrc”。'; return; }
  applySource(b.dataset.src);
});

/* drag & drop */
let dragDepth = 0;
addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
addEventListener('dragleave', () => { if (--dragDepth <= 0){ dragDepth = 0; document.body.classList.remove('dragging'); } });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  for (const f of e.dataTransfer.files){
    if (/\.(lrc|txt|ttml|xml)$/i.test(f.name)) loadLRC(f);
    else if (f.type.startsWith('audio/')) loadAudio(f);
  }
});

/* keyboard */
addEventListener('keydown', e => {
  if (!$('coverAsk').hidden){ if (e.code === 'Escape') closeCoverAsk(); return; }
  if (!$('coverModal').hidden){ if (e.code === 'Escape') $('coverModal').hidden = true; return; }
  if (!$('exportModal').hidden){ if (e.code === 'Escape') closeExport(); return; }
  if (!$('fxModal').hidden){
    if (e.code === 'Escape'){ closeFx(); return; }
    // inside the drawer, keys belong to its controls (sliders, buttons); elsewhere the usual shortcuts still work
    if ($('fxModal').contains(document.activeElement) && document.activeElement !== document.body &&
        (e.code === 'Space' || e.code === 'Enter' || e.code.startsWith('Arrow'))){
      if (e.code === 'Space' && document.activeElement.type === 'range'){ e.preventDefault(); togglePlay(); }
      return;
    }
  }
  if (!$('autoModal').hidden){ if (e.code === 'Escape' && !autoBusy) $('autoModal').hidden = true; return; }
  if (!$('libModal').hidden){ if (e.code === 'Escape') closeLib(); return; }
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  if (e.code === 'Space'){ e.preventDefault(); togglePlay(); }
  else if (e.code === 'KeyF' && !e.ctrlKey && !e.metaKey && !e.altKey){ e.preventDefault(); setFps(!fx.showFps); }
  else if (e.code === 'BracketLeft'){ e.preventDefault(); setDelay(lyricDelay - (e.shiftKey ? 0.01 : 0.05)); }
  else if (e.code === 'BracketRight'){ e.preventDefault(); setDelay(lyricDelay + (e.shiftKey ? 0.01 : 0.05)); }
  else if (e.code === 'ArrowRight'){ e.preventDefault(); seek(now() + 5); }
  else if (e.code === 'ArrowLeft'){ e.preventDefault(); seek(now() - 5); }
});

/* hide controls while playing and idle. Not while the pointer rests on one of them (a button about to be pressed
   again must not fade away under it), nor while the menu is open; a click counts as a sign of life like a movement. */
let idleT;
const overControl = () => !!document.querySelector('button:hover, input:hover, select:hover, label:hover, .menu:hover, .tbar:hover, .seg:hover, .amvol:hover, .ampill:hover');
function poke(){
  document.body.classList.remove('idle');
  clearTimeout(idleT);
  if (playing) idleT = setTimeout(() => { if (document.body.classList.contains('menu-open') || overControl()) return poke(); document.body.classList.add('idle'); }, 2600);
}
['mousemove', 'mousedown', 'touchstart', 'keydown'].forEach(ev => addEventListener(ev, poke, { passive: true }));

setMode(mode);
requestAnimationFrame(tick);

function setFpsT0(v){ return fpsT0 = v; }   // other modules cannot assign to an imported binding

function setFpsN(v){ return fpsN = v; }   // other modules cannot assign to an imported binding

function setFpsLast(v){ return fpsLast = v; }   // other modules cannot assign to an imported binding

/* names that modules loaded before this one call or read (core/late.js) */
Object.assign(late, { poke, loadLRCText, loadTTMLText, applySource, setFpsT0, setFpsN, setFpsLast });
