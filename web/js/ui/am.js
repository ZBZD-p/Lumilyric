import { late } from '../core/late.js';
import { $, audio } from '../core/lyrics.js';
import { fx } from '../core/settings.js';

/* ================= AM 布局: the buttons around the picture =================
   The layout itself is coverLayout (render/frame.js) and body.am (style.css). Apple Music's full-screen player has
   more buttons than this player has things to do; they are all there so that the picture is complete. Those with
   something to do here do it:
     the cross (top left)        leaves the AM layout
     the volume (top right)      sets the volume of the audio file that is loaded, the speaker mutes it
     文A (bottom right)          switches the lyrics between both languages and English: the header's switch is hidden
     the speech bubble beside it shows or hides the lyrics: hidden, the cover and its controls glide to the middle
                                 (amHideNow, render/frame.js)
     the list (right of it)      shows the player's play list in the lyrics' place (QQ 网页跟随), a click plays a song
     shuffle / repeat (beside    QQ's play mode (QQ 网页跟随)
       the play button)
   The rest (.amph: AirPlay; the favourite star) only hold their place, and say so. */
$('amX').onclick = () => {
  const c = $('fxAM');
  if (c.checked){ c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); }
};
$('amLang').onclick = () => {
  const order = ['both', 'en'], on = document.querySelector('.seg button[data-mode][aria-pressed="true"]');
  const next = order[(order.indexOf(on ? on.dataset.mode : 'both') + 1) % order.length];
  const b = document.querySelector(`.seg button[data-mode="${next}"]`);
  if (b) b.click();
};
$('amLyr').onclick = () => {
  if (qOpen) return qShow(false);                 // the list was in the lyrics' place: they come back
  fx.amLyrics = fx.amLyrics === false; late.saveFx(); late.applyFx();
};

/* the play list (QQ 网页跟随: the QQ player page's list, read by desktop/app.py), in the place of the lyrics, after
   Apple Music's full-screen player (macOS 26). Its two wide buttons and the shuffle / repeat beside the play button set
   QQ's play mode (its four: list → single → random → order). The song playing is the big cover, not a row; those
   played are 历史记录 above, scrolled out of view. A click on a row plays it; its ⋯ also takes it out of the list or
   shows its page in the QQ window. Other players give the system what plays, not what comes next: the list says so.
   Read every 1.5 s while open, every 4 s otherwise (the play mode, for the shuffle / repeat buttons). */
let qOpen = false, qT = 0, qKey = '', qNow = null, qMode = '', qMenuI = -1, qMenuBtn = null;
const qEsc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const qApp = () => (late.F && late.F.app) || '';
const qFollow = () => typeof late.followOn !== 'undefined' && late.followOn;
function qShow(on){
  qOpen = on;
  const b = document.body;
  qMenuClose();
  b.classList.add('am-qx'); clearTimeout(qShow.t); qShow.t = setTimeout(() => b.classList.remove('am-qx'), 450);      // the lyrics fade, only now
  if (on && fx.amLyrics === false){ fx.amLyrics = true; late.saveFx(); late.applyFx(); }   // lyrics hidden: the cover goes back left first
  b.classList.toggle('am-queue', on);
  $('amQ').setAttribute('aria-hidden', String(!on));
  $('amQueue').setAttribute('aria-pressed', String(on));
  $('amLyr').setAttribute('aria-pressed', String(!on && fx.amLyrics !== false));
  clearInterval(qT); qT = 0;
  if (on){ qKey = ''; qNow = null; qLoad(); qT = setInterval(qLoad, 1500); }
}
function qEmpty(text){
  qKey = ''; qMenuClose();
  $('amQHist').hidden = true; $('amQHistList').innerHTML = ''; $('amQList').innerHTML = ''; $('amQSrc').textContent = '';
  $('amQEmpty').textContent = text; $('amQEmpty').hidden = false;
}
/* QQ's mode on the buttons: shuffle = random; repeat = all (list, and random, which also goes round), one (single),
   off (order) */
function qModeShow(mode){
  qMode = mode;
  const rep = mode === 'single' ? 'one' : mode === 'order' ? 'off' : 'all';
  for (const b of [$('amQShuf'), $('amShuffle')]) b.setAttribute('aria-pressed', String(mode === 'random'));
  for (const b of [$('amQRep'), $('amRepeat')]){ b.dataset.rep = rep; b.setAttribute('aria-pressed', String(!!mode && rep !== 'off')); }
  $('amQRepTxt').textContent = rep === 'one' ? '单曲循环' : rep === 'off' ? '不循环' : '列表循环';
}
const qRow = (x, i) => `<li class="amqi" data-i="${i}" title="播放「${qEsc(x.title)}」">` +
  (x.cover ? `<img src="${qEsc(x.cover)}" alt="" loading="lazy" decoding="async">` : '<span class="ph"></span>') +
  `<span><span class="t">${qEsc(x.title)}</span><span class="a">${qEsc([x.artist, x.album].filter(Boolean).join(' — '))}</span></span>` +
  `<button class="x" aria-label="更多" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></svg></button></li>`;
async function qLoad(){
  if (!document.body.classList.contains('am')) return;
  if (!qFollow()){
    qModeShow('');
    return qOpen && qEmpty('现在没有在跟随播放器。打开「⋯ → 测试功能 → QQ 网页跟随」后，这里会列出 QQ 播放器里的歌，点一首就放那一首。');
  }
  let r;
  try { r = await (await fetch('/api/nowplaying/queue?app=' + encodeURIComponent(qApp()), { cache: 'no-store' })).json(); }
  catch (e){ return qOpen && qEmpty('读取播放列表失败：' + (e.message || e)); }
  qModeShow(r.ok && r.mode || '');
  if (!qOpen) return;
  if (!r.ok) return qEmpty(r.reason || '这个播放器没有播放列表');
  if (!r.items.length) return qEmpty('QQ 播放器里还没有歌。');
  if (String(r.ver) === qKey) return;
  qKey = String(r.ver); qMenuClose();
  const now = r.items.findIndex(x => x.now);
  const past = now > 0 ? r.items.slice(0, now) : [], next = now >= 0 ? r.items.slice(now + 1) : r.items;
  $('amQHist').hidden = !past.length;
  $('amQHistList').innerHTML = past.map(qRow).join('');
  $('amQList').innerHTML = next.map((x, k) => qRow(x, (now >= 0 ? now + 1 : 0) + k)).join('');
  $('amQSrc').textContent = `来自 QQ 音乐 · 共 ${r.items.length} 首`;
  $('amQEmpty').textContent = next.length ? '' : '后面没有歌了。';
  $('amQEmpty').hidden = !!next.length;
  if (now !== qNow){                               // 继续播放 at the top; the history is above it, out of view
    const sc = $('amQScroll');
    sc.scrollTo({ top: Math.max(0, $('amQNext').offsetTop - sc.offsetTop), behavior: qNow === null ? 'auto' : 'smooth' });
  }
  qNow = now;
}
function qAct(action, position){
  if (!qApp()) return Promise.resolve();
  return fetch('/api/nowplaying/control', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, position, app: qApp() }) })
    .then(r => r.json())
    .then(r => { if (!r.ok) $('status').textContent = ({ playAt: '没有放成这一首', removeAt: '没有移出列表', openAt: '没有打开', mode: '没有切换成' }[action] || '没有成功') + (r.reason ? '：' + r.reason : ''); })
    .catch(() => {})
    .then(() => setTimeout(() => { qKey = ''; qLoad(); }, 450));
}
function qModeSet(target){
  if (!qMode){ $('status').textContent = '只有「QQ 网页跟随」时能切换随机和循环'; return; }
  qModeShow(target);                               // shown at once; the player's own answer follows
  qAct('mode', target);
}
const qShuffle = () => qModeSet(qMode === 'random' ? 'list' : 'random');
const qRepeat = () => qModeSet(qMode === 'single' ? 'order' : qMode === 'order' ? 'list' : 'single');
$('amQShuf').onclick = $('amShuffle').onclick = qShuffle;
$('amQRep').onclick = $('amRepeat').onclick = qRepeat;
/* a row's ⋯: a small menu beside it (播放 / 从播放列表中移除 / 在 QQ 窗口中打开) */
function qMenuOpen(row, btn){
  if (qMenuBtn === btn) return qMenuClose();
  qMenuClose();
  const m = $('amQMenu'), q = $('amQ').getBoundingClientRect(), b = btn.getBoundingClientRect();
  qMenuI = +row.dataset.i; qMenuBtn = btn; btn.setAttribute('aria-expanded', 'true');
  m.hidden = false;
  const mh = m.offsetHeight, mw = m.offsetWidth;
  const top = b.bottom + mh + 8 > innerHeight ? b.top - q.top - mh - 4 : b.bottom - q.top + 4;
  Object.assign(m.style, { top: top + 'px', left: Math.max(0, b.right - q.left - mw) + 'px' });
  m.querySelector('button').focus({ preventScroll: true });
}
function qMenuClose(){
  $('amQMenu').hidden = true;
  if (qMenuBtn) qMenuBtn.setAttribute('aria-expanded', 'false');
  qMenuBtn = null;
}
$('amQMenu').onclick = e => {
  const b = e.target.closest('button');
  if (!b) return;
  const i = qMenuI;
  qMenuClose();
  qAct({ play: 'playAt', remove: 'removeAt', open: 'openAt' }[b.dataset.a], i);
};
$('amQScroll').onclick = e => {
  const row = e.target.closest('.amqi');
  if (!row) return;
  const x = e.target.closest('.x');
  if (x) return qMenuOpen(row, x);
  qAct('playAt', +row.dataset.i);
};
$('amQScroll').addEventListener('scroll', () => { if (qMenuBtn) qMenuClose(); }, { passive: true });
document.addEventListener('pointerdown', e => { if (qMenuBtn && !e.target.closest('#amQMenu, .amqi .x')) qMenuClose(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && qMenuBtn) qMenuClose(); });
$('amQueue').onclick = () => qShow(!qOpen);
setInterval(() => { if (!qOpen) qLoad(); }, 4000);   // the shuffle / repeat buttons show QQ's mode
$('amStar').addEventListener('click', () => $('amStar').setAttribute('aria-pressed', String($('amStar').getAttribute('aria-pressed') !== 'true')));      // favourite: on / off to look at
document.querySelectorAll('.amph').forEach(b => b.onclick = () => { $('status').textContent = `「${b.getAttribute('aria-label')}」还没有功能，先占个位置`; });

/* the volume of the loaded audio file, and of the QQ web-player window (QQ 网页跟随, desktop only: desktop/app.py
   puts a gain of ours in front of that page's sound), and of the QQ Music program when that is the player followed
   (told once the slider is let go: its command line starts a program for each). Another player followed keeps its
   own volume. */
let vol = 1, before = 1;
try { const v = parseFloat(localStorage.getItem('lrc-am-vol')); if (isFinite(v)) vol = Math.max(0, Math.min(1, v)); } catch (e){}
function qqVol(){
  const api = window.pywebview && window.pywebview.api;
  if (api && api.qq_volume) Promise.resolve(api.qq_volume(vol)).catch(() => {});
}
function qqMusicVol(){
  if (!qFollow() || !/qqmusic/i.test(qApp())) return;      // the QQ Music program, not the web player (qqweb.web)
  fetch('/api/nowplaying/control', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'volume', position: Math.round(vol * 100), app: qApp() }) })
    .then(r => r.json())
    .then(r => { if (!r.ok) $('status').textContent = '没有调成 QQ音乐 的音量' + (r.reason ? '：' + r.reason : ''); })
    .catch(() => {});
}
function showVol(){
  const el = $('amVol');
  el.value = Math.round(vol * 100); el.style.setProperty('--p', vol * 100 + '%');
  $('amMute').classList.toggle('off', vol === 0);
  if (audio && audio.volume !== vol) audio.volume = vol;
  qqVol();
}
addEventListener('pywebviewready', qqVol);       // the desktop window's api comes a moment after the page
$('amVol').oninput = e => { vol = e.target.value / 100; try { localStorage.setItem('lrc-am-vol', vol); } catch (err){} showVol(); };
$('amVol').onchange = qqMusicVol;                  // let go (or a key press): not on every step of the drag
$('amMute').onclick = () => { if (vol > 0){ before = vol; vol = 0; } else vol = before || 1; showVol(); qqMusicVol(); };
showVol();
setInterval(() => { if (audio && audio.volume !== vol) audio.volume = vol; }, 1000);      // an audio file loaded later takes the volume too
