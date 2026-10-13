import { late } from '../core/late.js';
import { $, audio, audioFile, lrcSong, parseTTML } from '../core/lyrics.js';
import { amllPick } from './amll-match.js';

export {
  amllLookup,
  closeLib,
};

/* Lyrics library: AMLL TTML DB and LDDC */
/* ================= lyrics library: AMLL TTML DB (community word-by-word lyrics on GitHub) ================= */
const AMLL_BASES = [
  'https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main/',
  'https://cdn.jsdelivr.net/gh/amll-dev/amll-ttml-db@main/',       // mirrors, for networks where GitHub is slow or blocked
  'https://fastly.jsdelivr.net/gh/amll-dev/amll-ttml-db@main/'
];
let amllBase = 0, amllIndex = null, amllLoading = null, amllDownAt = 0;      // amllDownAt: when the library last could not be reached
async function amllFetch(path){
  let lastErr;
  for (let k = 0; k < AMLL_BASES.length; k++){
    const i = (amllBase + k) % AMLL_BASES.length;
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await fetch(AMLL_BASES[i] + path, { signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const t = await r.text();
      amllBase = i;                        // remember the source that works
      return t;
    } catch (e){ lastErr = e; } finally { clearTimeout(to); }
  }
  throw lastErr || new Error('network');
}
const libNorm = s => (s || '').normalize('NFKC').toLowerCase().replace(/[\s·・,，.。'’"“”()（）\[\]【】\-–—_!！?？&/:：~～]+/g, '');
function loadAmllIndex(){
  if (amllIndex) return Promise.resolve(amllIndex);
  if (amllLoading) return amllLoading;
  amllLoading = amllFetch('metadata/raw-lyrics-index.jsonl').then(text => {
    const byKey = new Map();
    for (const line of text.split('\n')){
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch(e){ continue; }
      const m = Object.fromEntries(o.metadata || []);
      const name = (m.musicName || [])[0];
      if (!name || !o.rawLyricFile) continue;
      const artists = m.artists || [], album = (m.album || [])[0] || '';
      const e = { name, artists, album, file: o.rawLyricFile, author: (m.ttmlAuthorGithubLogin || [])[0] || '',
        hay: libNorm([...(m.musicName || []), ...artists, ...(m.album || [])].join('|')) };
      byKey.set(libNorm(name) + '|' + libNorm(artists.join('/')), e);      // later submissions replace earlier ones
    }
    amllIndex = [...byKey.values()]; amllDownAt = 0;
    return amllIndex;
  }).catch(e => { amllDownAt = Date.now(); throw e; }).finally(() => { amllLoading = null; });
  return amllLoading;
}
/* The library asked on its own, while following a player (follow.js): the song's lyrics when the library has the song,
   otherwise null at once or after at most a few seconds, so that the other source (LDDC) is not kept waiting. A
   library that cannot be reached is not asked again for a while. Gives a lookup result like the helper's
   (`ttml`: the text is TTML, not LRC), and never fails. */
const AMLL_AUTO = { indexWait: 5000, fileWait: 7000, retry: 5 * 60 * 1000, overrun: 8, keep: 12 };
const amllFiles = new Map();                        // file -> TTML text of the songs fetched lately
const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
async function amllLookup(title, artist, album, duration){
  try {
    if (!amllIndex){
      if (Date.now() - amllDownAt < AMLL_AUTO.retry) return null;
      await within(loadAmllIndex(), AMLL_AUTO.indexWait);
    }
    const e = amllPick(amllIndex, title, artist, album);
    if (!e) return null;
    let text = amllFiles.get(e.file);
    if (text === undefined){
      text = await within(amllFetch('raw-lyrics/' + e.file), AMLL_AUTO.fileWait);
      amllFiles.set(e.file, text);
      if (amllFiles.size > AMLL_AUTO.keep) amllFiles.delete(amllFiles.keys().next().value);
    }
    // lyrics that go on after the song has ended are those of a longer version
    const p = parseTTML(text);
    if (!p.lines.length || (duration > 0 && p.length > duration + AMLL_AUTO.overrun)) return null;
    return { lrc: text, ttml: true, source: 'AMLL TTML DB', title: e.name, verbatim: p.lines.some(l => l.wt), score: 100, album: e.album };
  } catch (err){ return null; }
}
function libSearch(q){
  const terms = q.trim().split(/\s+/).map(libNorm).filter(Boolean);
  if (!terms.length || !amllIndex) return [];
  const all = terms.join(''), res = [];
  for (const e of amllIndex){
    if (!terms.every(t => e.hay.includes(t))) continue;
    const n = libNorm(e.name);
    let sc = 0;
    if (n === all) sc += 100; else if (terms.some(t => n === t)) sc += 80;
    else if (n.startsWith(terms[0])) sc += 50; else if (terms.some(t => n.includes(t))) sc += 30;
    if (terms.some(t => e.artists.some(a => libNorm(a) === t))) sc += 20;
    res.push([sc, e]);
  }
  return res.sort((a, b) => b[0] - a[0]).slice(0, 60).map(x => x[1]);
}
/* second source: QQ Music / Kugou / NetEase through LDDC in the local helper (scripts/setup_lddc.bat) */
let libSrc = 'lddc', lddcRes = [], lddcFor = '', lddcSeq = 0, lddcBusy = false;
try { libSrc = localStorage.getItem('lrc-libsrc') || 'lddc'; } catch(e){}
const LIB_NOTES = {
  amll: '歌词由 <a href="https://github.com/amll-dev/amll-ttml-db" target="_blank" rel="noopener">AMLL TTML DB</a> 的贡献者手工制作，精度很高，伴唱也有，但收录的歌有限。载入后对照音频听一下，版本不同（现场、剪辑版）时可以用「偏移」微调。',
  lddc: '通过 <a href="https://github.com/chenmozhijin/LDDC" target="_blank" rel="noopener">LDDC</a> 搜索三个平台，热门歌大多有逐字歌词。<b>●</b> 表示时长和你载入的音频相差不到 3 秒，多半是同一个版本。歌词版权归各平台，仅供个人使用。'
};
function setLibSrc(v){
  libSrc = v;
  try { localStorage.setItem('lrc-libsrc', v); } catch(e){}
  document.querySelectorAll('#libSrc button').forEach(b => b.setAttribute('aria-pressed', b.dataset.src === v));
  $('libNote').innerHTML = LIB_NOTES[v];
  libRender();
  if (v === 'amll' && !amllIndex) openLib();
  if (v === 'lddc' && $('libQ').value.trim() && lddcFor !== $('libQ').value.trim()) lddcSearch();
}
document.querySelectorAll('#libSrc button').forEach(b => b.onclick = () => setLibSrc(b.dataset.src));
const audioDur = () => audio && isFinite(audio.duration) ? audio.duration : 0;
async function lddcSearch(){
  const q = $('libQ').value.trim();
  if (!q || !late.helper || !late.helper.lddc) return libRender();
  const seq = ++lddcSeq;
  lddcBusy = true; $('libRes').textContent = '';
  $('libMsg').textContent = '正在搜索 QQ音乐、酷狗、网易云…';
  try {
    const res = JSON.parse(await late.api('/api/lyrics/search', JSON.stringify({ q }), { 'Content-Type': 'application/json' }));
    if (seq !== lddcSeq) return;
    let items = res.items || [];
    const d = audioDur();
    if (d) items.forEach(x => x.match = x.duration > 0 && Math.abs(x.duration - d) <= 3);
    items = items.filter(x => x.match).concat(items.filter(x => !x.match));      // same-length versions first
    lddcRes = items; lddcFor = q;
    const failed = Object.keys(res.errors || {});
    lddcBusy = false; libRender();
    if (failed.length) $('libMsg').textContent += `（${failed.join('、')} 这次没连上）`;
  } catch (err){
    if (seq !== lddcSeq) return;
    lddcBusy = false;
    $('libMsg').textContent = '搜索失败：' + (err.message || err);
  }
}
function libItem(title, sub, tag, match, onclick){
  const b = document.createElement('button');
  b.className = 'libitem' + (match ? ' match' : ''); b.setAttribute('role', 'listitem');
  const t = document.createElement('b'); t.textContent = title;
  const au = document.createElement('i'); au.textContent = tag;
  const a = document.createElement('span'); a.textContent = sub;
  b.append(t, au, a);
  b.onclick = onclick;
  $('libRes').appendChild(b);
}
function libRender(){
  const q = $('libQ').value, list = $('libRes');
  list.textContent = '';
  if (libSrc === 'lddc'){
    if (!late.helper){ $('libMsg').textContent = '这个来源要用本地程序：双击项目文件夹里的 start_server.bat，它会打开能用的页面。'; return; }
    if (!late.helper.lddc){ $('libMsg').textContent = '还没安装 LDDC：双击项目里 scripts 文件夹中的 setup_lddc.bat 装一次（约 10 MB），装好后重开 start_server.bat。'; return; }
    if (lddcBusy) return;
    if (!q.trim()){ $('libMsg').textContent = '输入歌名（加上歌手更准），按回车搜索'; return; }
    if (lddcFor !== q.trim()){ $('libMsg').textContent = '按回车搜索'; return; }
    $('libMsg').textContent = lddcRes.length ? `找到 ${lddcRes.length} 个结果，点一个载入` : '三个平台都没搜到，换个关键词试试。';
    for (const e of lddcRes)
      libItem(e.title, [e.artist, e.album].filter(Boolean).join(' · '), e.source + (e.duration ? ' · ' + late.fmt(e.duration) : ''), e.match, () => lddcLoad(e));
    return;
  }
  if (!amllIndex) return;
  if (!q.trim()){ $('libMsg').textContent = `共 ${amllIndex.length} 首歌，输入歌名或歌手搜索`; return; }
  const hits = libSearch(q);
  $('libMsg').textContent = hits.length ? `找到 ${hits.length}${hits.length === 60 ? '+' : ''} 首，点一首载入`
    : '没找到。可以只输歌名，或换成原文歌名再试（歌词库里多用原文歌名）。';
  for (const e of hits){
    const b = document.createElement('button');
    b.className = 'libitem'; b.setAttribute('role', 'listitem');
    const t = document.createElement('b'); t.textContent = e.name;
    const au = document.createElement('i'); au.textContent = e.author ? '@' + e.author : '';
    const a = document.createElement('span'); a.textContent = [e.artists.join(' / '), e.album].filter(Boolean).join(' · ');
    b.append(t, au, a);
    b.onclick = () => libLoad(e);
    list.appendChild(b);
  }
}
async function lddcLoad(e){
  $('libMsg').textContent = `正在从${e.source}下载《${e.title}》的歌词…`;
  try {
    const res = JSON.parse(await late.api('/api/lyrics/get', JSON.stringify({ token: e.token }), { 'Content-Type': 'application/json' }));
    const note = `来自${res.source}` + (res.verbatim ? '（逐字）' : '（这个版本只有逐行时间，可以用「自动识别」逐字对齐）');
    if (late.loadLRCText(res.lrc, `${e.title} - ${e.artist}`, note)) closeLib();
    else $('libMsg').textContent = $('status').textContent;
  } catch (err){
    $('libMsg').textContent = '下载失败：' + (err.message || err) + '。可以换一个结果试试。';
  }
}
async function libLoad(e){
  $('libMsg').textContent = `正在下载《${e.name}》的歌词…`;
  try {
    const text = await amllFetch('raw-lyrics/' + e.file);
    const ok = late.loadTTMLText(text, `${e.name} - ${e.artists.join(' / ')}`, '来自 AMLL TTML DB' + (e.author ? ' · 制作 @' + e.author : ''));
    if (ok) closeLib(); else $('libMsg').textContent = $('status').textContent;
  } catch (err){
    $('libMsg').textContent = '下载失败：' + (err.message || err) + '。检查一下网络再点一次。';
  }
}
async function openLib(){
  $('libModal').hidden = false;
  if (!$('libQ').value){
    const guess = lrcSong && lrcSong.meta.ti ? lrcSong.meta.ti
      : audioFile ? audioFile.name.replace(/\.[^.]+$/, '').replace(/\s*\(\d+\)$/, '') : '';
    if (guess && !/^[A-Z0-9]{12,}$/i.test(guess)) $('libQ').value = guess;      // skip file names that are just IDs
  }
  $('libQ').focus(); $('libQ').select();
  document.querySelectorAll('#libSrc button').forEach(b => b.setAttribute('aria-pressed', b.dataset.src === libSrc));
  $('libNote').innerHTML = LIB_NOTES[libSrc];
  if (libSrc === 'lddc'){
    if ($('libQ').value.trim() && lddcFor !== $('libQ').value.trim()) lddcSearch(); else libRender();
    return;
  }
  if (!amllIndex){
    $('libMsg').textContent = '正在下载歌词库目录（约 1.6 MB，只在第一次打开时下载）…';
    try { await loadAmllIndex(); }
    catch (err){
      const local = location.protocol === 'file:' || /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
      $('libMsg').textContent = '连不上歌词库（GitHub 和镜像都没连上）。检查网络后关掉再打开试试。'
        + (local ? '' : ' 如果是在线预览页面不能联网，请用本地的 index.html。');
      return;
    }
  }
  libRender();
}
const closeLib = () => { $('libModal').hidden = true; };
let libT;
$('libQ').addEventListener('input', () => { clearTimeout(libT); libT = setTimeout(libRender, 120); });
$('libQ').addEventListener('keydown', e => {
  const first = $('libRes').querySelector('.libitem');
  if (e.key === 'Enter' && libSrc === 'lddc' && lddcFor !== $('libQ').value.trim()){ e.preventDefault(); lddcSearch(); return; }
  if (e.key === 'Enter' && first) first.click();
  if (e.key === 'ArrowDown' && first){ e.preventDefault(); first.focus(); }
});
$('libRes').addEventListener('keydown', e => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const el = e.key === 'ArrowDown' ? document.activeElement.nextElementSibling : document.activeElement.previousElementSibling;
  if (el) el.focus(); else if (e.key === 'ArrowUp') $('libQ').focus();
});
$('libBtn').onclick = openLib;
$('libClose').onclick = closeLib;
$('libModal').addEventListener('click', e => { if (e.target === $('libModal')) closeLib(); });
