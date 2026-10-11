import { late } from '../core/late.js';
import { CJK, parseLRC } from '../core/core.js';
import { $, audioFile, lrcName, lrcRawText, lrcSong, parseWhisper, preferAlign, setAlignStats, setLrcName, setLrcRawText, setLrcSong, setPreferAlign, setUploadedId, setWhisperName, setWhisperWords, song, toWordLRC, uploadedId } from '../core/lyrics.js';
import { lyricDelay, setPlaying } from '../core/settings.js';
import { oneLine, render, segCache, setOneLine } from '../render/view-dom.js';
import { fmtDelay, setDelay } from '../export/export.js';

export {
  api,
  autoBusy,
  fmt,
  helper,
  scrubbing,
  setScrubbing,
};

/* Recognition / alignment through the local helper */
/* ================= automatic recognition / alignment through the local helper (start_server.bat) ================= */
let helper = null, autoBusy = false;
async function detectHelper(){
  if (!/^https?:$/.test(location.protocol) || !/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) return;
  try {
    const r = await fetch('/api/status', { cache: 'no-store' });
    if (!r.ok) return;
    helper = await r.json();
    $('autoBtn').hidden = false;
    if (typeof late.followInit === 'function') late.followInit();       // follow.js loads after this file, the fetch finishes later
  } catch(e){}
}
async function api(path, body, headers){
  const r = await fetch(path, { method: 'POST', body, headers });
  const txt = await r.text();
  if (!r.ok){
    let m = txt; try { m = JSON.parse(txt).error || txt; } catch(e){}
    // a feature added after the helper was started: the old helper does not know this address yet
    if (r.status === 404 && m === 'not found') m = '本地程序还是旧版本，关掉 start_server.bat 的黑色窗口再重新打开就好';
    throw new Error(m);
  }
  return txt;
}
function openAuto(){
  setPlaying(false);
  $('autoModal').hidden = false;
  refreshAuto();
  if (!autoBusy){ $('autoMsg').textContent = ''; setAutoBar(0); }
}
/* the two features are optional extras (scripts\setup_whisper.bat, scripts\setup_align.bat): whatever is not installed
   is greyed out here with what to do about it, instead of failing half way */
const EXTRA_HINT = {
  align: '这一项是扩展功能，还没有安装（约 1 GB，另外第一次使用时会下载对齐模型）：运行 scripts 文件夹里的 setup_align.bat，再重新打开 start_server.bat。',
  whisper: '这一项是扩展功能，还没有安装（语音识别程序和模型约 0.6 到 1.7 GB）：运行 scripts 文件夹里的 setup_whisper.bat，再重新打开 start_server.bat。',
  ffmpeg: '还缺音频转换组件：运行 setup_whisper.bat 或 setup_align.bat。',
};
/* the packed desktop version carries the base features only and has no scripts folder */
const EXTRA_HINT_DESKTOP = '这一项是扩展功能，桌面版暂时没有带（体积 1 GB 以上）。需要时请用完整版：项目文件夹里的 start_server.bat。';
const extraHint = k => helper && helper.desktop ? EXTRA_HINT_DESKTOP : EXTRA_HINT[k];
function refreshAuto(){
  const canRec = !!(helper && helper.whisper), canAlign = !!(helper && helper.align);
  $('autoEnv').textContent = helper ? (canRec ? `识别：${helper.whisperModel || '无模型'} · ${helper.device || '—'}` : '识别：未安装') +
    (canAlign ? ' · 对齐：已安装' : ' · 对齐：未安装') : '';
  $('autoAudio').textContent = audioFile ? audioFile.name : '还没有载入音频';
  const hasLrc = !!(lrcSong && lrcRawText);
  $('autoModeAlign').disabled = !(hasLrc && canAlign);
  $('autoModeRec').disabled = !canRec;
  $('autoAlignNote').textContent = !canAlign ? extraHint("align") : hasLrc
    ? `当前歌词：${lrcName || '已载入'}，共 ${lrcSong.lines.length} 句。` + (lrcIsZh()
        ? '中文歌，用中文模型逐字对齐。'
        : '英文歌，用英文模型逐词对齐（第一次使用会自动下载约 360 MB 的模型）。')
    : '先点「载入歌词 .lrc」才能用这一项。';
  $('autoRecNote').hidden = canRec;
  $('autoRecNote').textContent = canRec ? '' : extraHint("whisper");
  $('autoRefine').disabled = !(canAlign && canRec);
  if (!canAlign) $('autoRefine').checked = false;
  if (preferAlign && hasLrc && canAlign){ $('autoModeAlign').checked = true; setPreferAlign(false); }
  else if (!document.querySelector('input[name=autoMode]:checked') || $('autoModeAlign').disabled && $('autoModeAlign').checked || $('autoModeRec').disabled && $('autoModeRec').checked)
    (!$('autoModeAlign').disabled ? $('autoModeAlign') : !$('autoModeRec').disabled ? $('autoModeRec') : $('autoModeAlign')).checked = true;
  const chosen = document.querySelector('input[name=autoMode]:checked');
  const usable = chosen && !chosen.disabled && !(helper && helper.ffmpeg === false);
  $('autoGo').disabled = autoBusy || !audioFile || !usable;
  if (helper && helper.ffmpeg === false && (canRec || canAlign) && !autoBusy) $('autoMsg').textContent = extraHint("ffmpeg");
}
function lrcIsZh(){
  const L = lrcSong ? lrcSong.lines : [];
  return L.filter(l => CJK.test(l.en || l.zh)).length * 2 >= L.length;
}
const unitOf = r => r.lang === 'en' ? '个词' : '个字';
function setAutoBar(v, busy){ const f = $('autoBar'); f.classList.toggle('busy', !!busy); f.style.width = busy ? '' : (v * 100) + '%'; }
async function ensureUploaded(say){
  if (uploadedId) return uploadedId;
  say('正在把音频交给本地程序…');
  const txt = await api('/api/upload', audioFile, { 'X-Filename': encodeURIComponent(audioFile.name) });
  setUploadedId(JSON.parse(txt).id);
  return uploadedId;
}
/* move every [mm:ss.xx] and <mm:ss.xx> tag of an LRC by d seconds */
function shiftLRC(text, d){
  if (!d) return text;
  const f = (m, s) => { const v = Math.max(0, +m * 60 + parseFloat(s) + d), mm = Math.floor(v / 60); return String(mm).padStart(2, '0') + ':' + (v - mm * 60).toFixed(2).padStart(5, '0'); };
  return text.replace(/\[(\d+):(\d+(?:\.\d+)?)\]/g, (_, m, s) => '[' + f(m, s) + ']')
             .replace(/<(\d+):(\d+(?:\.\d+)?)>/g, (_, m, s) => '<' + f(m, s) + '>');
}
function loadAlignedLRC(text, name, stats){
  const hadDelay = lyricDelay;
  if (lyricDelay) setDelay(0);             // aligned times already match the audio
  const parsed = parseLRC(text);
  setWhisperWords(null); setAlignStats(null);
  setLrcSong(parsed); setLrcRawText(text); setLrcName(name);
  late.applySource('lrc');
  $('wordLrcBtn').hidden = false;
  $('status').textContent = `逐字对齐完成：${stats.aligned} / ${stats.total} ${unitOf(stats)}` + (stats.moved ? `，修正 ${stats.moved} 处句首` : '') + (hadDelay ? `，原来的偏移 ${fmtDelay(hadDelay)}s 已经算进时间里并归零` : '') + '。点“导出逐词 LRC”可以保存';
}
async function runAuto(){
  if (autoBusy || !audioFile) return;
  autoBusy = true; refreshAuto();
  const t0 = performance.now();
  let stage = '';
  const say = m => { stage = m; $('autoMsg').textContent = m; };
  const secs = () => Math.round((performance.now() - t0) / 1000);
  const timer = setInterval(() => { $('autoMsg').textContent = `${stage} 已用 ${secs()} 秒`; }, 500);
  setAutoBar(0, true);
  try {
    const id = await ensureUploaded(say);
    const base = audioFile.name.replace(/\.[^.]+$/, '');
    if ($('autoModeAlign').checked){
      say('正在逐字对齐（第一次要先加载模型，稍慢）…');
      // the aligner looks for each line near its LRC time, so the current offset is baked into the times it gets
      const res = JSON.parse(await api('/api/align', JSON.stringify({ id, lrc: shiftLRC(lrcRawText, lyricDelay) }), { 'Content-Type': 'application/json' }));
      loadAlignedLRC(res.lrc, (lrcName || base) + ' 逐字', res);
      say(`完成：${res.aligned} / ${res.total} ${unitOf(res)}已对齐，用时 ${secs()} 秒`);
    } else {
      say('正在识别歌词…');
      const json = await api('/api/transcribe', JSON.stringify({ id, lang: $('autoLang').value }), { 'Content-Type': 'application/json' });
      const ww = parseWhisper(json);
      if (!ww.length) throw new Error('没有识别出歌词');
      setWhisperWords(ww); setWhisperName(base);
      setLrcSong(null); setLrcRawText('');
      late.applySource('whisper');
      const n = song.lines.length;
      if ($('autoRefine').checked){
        say('识别完成，正在逐字对齐…');
        const res = JSON.parse(await api('/api/align', JSON.stringify({ id, lrc: toWordLRC(song), lang: $('autoLang').value }), { 'Content-Type': 'application/json' }));
        loadAlignedLRC(res.lrc, base + ' 识别', res);
        say(`完成：识别出 ${n} 句，${res.aligned} / ${res.total} ${unitOf(res)}已对齐，用时 ${secs()} 秒`);
      } else {
        say(`完成：识别出 ${n} 句，用时 ${secs()} 秒`);
      }
    }
    setAutoBar(1);
  } catch (e){
    setAutoBar(0);
    say('出错了：' + (e.message || e));
  } finally {
    clearInterval(timer);
    $('autoMsg').textContent = stage;
    autoBusy = false; refreshAuto();
  }
}
$('autoBtn').onclick = openAuto;
$('autoGo').onclick = runAuto;
$('autoClose').onclick = () => { if (!autoBusy) $('autoModal').hidden = true; };
$('autoModal').addEventListener('click', e => { if (e.target === $('autoModal') && !autoBusy) $('autoModal').hidden = true; });
$('audioFile').addEventListener('change', () => setTimeout(refreshAuto, 0));
detectHelper();

$('oneLine').onchange = e => setOneLine(e.target.checked);
$('oneLine').checked = oneLine;
let rz;
addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { segCache.clear(); render(true); }, 150); });
document.fonts && document.fonts.ready.then(() => { segCache.clear(); render(true); });

const fmt = s => { s = Math.max(0, s | 0); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
let scrubbing = false;

function setScrubbing(v){ return scrubbing = v; }   // other modules cannot assign to an imported binding

/* names that modules loaded before this one call or read (core/late.js) */
Object.assign(late, { fmt, api });
Object.defineProperties(late, {
  helper: { get: () => helper, enumerable: true },
});
