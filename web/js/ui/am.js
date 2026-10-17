import { late } from '../core/late.js';
import { $, audio } from '../core/lyrics.js';
import { fx } from '../core/settings.js';
import { acctChanged } from './accounts.js';
import { onlineList, onlineNow, onlinePlay } from '../player/online.js';

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
  if (late.noLyrics && late.noLyrics()){ $('status').textContent = '这首歌没有歌词，封面放在中间'; return; }      // nothing to show (follow.js)
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
const qQQD = () => qFollow() && /qqmusic/i.test(qApp());          // QQ Music, the program (not the web window, qqweb.web)
const qSvc = () => !qFollow() ? '' : /qqmusic/i.test(qApp()) ? 'qq' : /cloudmusic|netease/i.test(qApp()) ? 'netease' : /kugou/i.test(qApp()) ? 'kugou' : '';      // its account service (music_apis.py)
const lsGet = k => { try { return localStorage.getItem(k) || ''; } catch (e){ return ''; } };
const lsSet = (k, v) => { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e){} };
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
const qRow = (x, i) => `<li class="amqi${qPend && qPend.title === x.title ? ' pending' : ''}" data-i="${i}" title="播放「${qEsc(x.title)}」">` +
  (x.cover ? `<img src="${qEsc(x.cover)}" alt="" loading="lazy" decoding="async">` : '<span class="ph"></span>') +
  `<span><span class="t">${qEsc(x.title)}</span><span class="a">${qEsc([x.artist, x.album].filter(Boolean).join(' — '))}</span></span>` +
  `<button class="x" aria-label="更多" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18.5" cy="12" r="1.7"/></svg></button></li>`;
async function qLoad(){
  if (!document.body.classList.contains('am')) return;
  if (!qFollow()){
    qModeShow(''); qqSet(null);
    return qOpen && qOnlineLoad();
  }
  $('amQ').classList.remove('onl'); $('amQOn').hidden = true;
  let r;
  const more = qQQD() ? '&list=' + encodeURIComponent(lsGet('lrc-qq-list')) + '&cache=' + encodeURIComponent(lsGet('lrc-qq-cache')) : '';
  try { r = await (await fetch('/api/nowplaying/queue?app=' + encodeURIComponent(qApp()) + more, { cache: 'no-store' })).json(); }
  catch (e){ return qOpen && qEmpty('读取播放列表失败：' + (e.message || e)); }
  qModeShow(r.ok && r.mode || '');
  qqSet(r.ok && r.qq || null);
  if (!qOpen) return;
  if (!r.ok) return qEmpty(r.reason || '这个播放器没有播放列表');
  if (!r.items.length && !r.qq) return qEmpty('QQ 播放器里还没有歌。');
  if (String(r.ver) === qKey) return;
  qKey = String(r.ver); qMenuClose();
  const now = r.items.findIndex(x => x.now);
  const past = now > 0 ? r.items.slice(0, now) : [], next = now >= 0 ? r.items.slice(now + 1) : r.items;
  $('amQHist').hidden = !past.length;      // (QQ Music: what was played lately)
  $('amQHistList').innerHTML = past.map(qRow).join('');
  $('amQList').innerHTML = next.map((x, k) => qRow(x, (now >= 0 ? now + 1 : 0) + k)).join('');
  const ac = r.acct;      // NetEase / KuGou: the account's lists (shown only: those programs cannot be told to play a song)
  $('amQSrc').textContent = ac ? (ac.signedIn ? `「我喜欢」· 来自你的${ac.name}账号（${ac.user}）` + (ac.err ? ' · ' + ac.err : '') : `在设置的「音乐账号」里登录${ac.name}，这里就会列出你最近听的和喜欢的歌`)
    : r.qq ? (r.qq.listTitle ? `歌单「${r.qq.listTitle}」· 共 ${r.qq.listCount} 首` : '最近播放的来自 QQ 音乐的缓存') : `来自 QQ 音乐 · 共 ${r.items.length} 首`;
  $('amQEmpty').textContent = next.length ? '' : ac ? (ac.signedIn ? '「我喜欢」里还没有歌。' : '') : r.qq ? '在上面粘贴一个 QQ 音乐歌单的链接，或点「我喜欢」，这里就会列出歌，点一首就播。' : '后面没有歌了。';
  $('amQEmpty').hidden = !!next.length;
  if (now !== qNow){                               // 继续播放 at the top; the history is above it, out of view
    const sc = $('amQScroll');
    sc.scrollTo({ top: Math.max(0, $('amQNext').offsetTop - sc.offsetTop), behavior: qNow === null ? 'auto' : 'smooth' });
  }
  qNow = now;
}
/* not following a player: the QQ account's 我喜欢 (设置 → 音乐账号), played here (player/online.js); the song playing is
   the big cover, the rest of the list comes after it, the songs before it are above, as for a player's list */
let qOnline = null;      // the songs shown, while not following
/* where they come from: { kind: 'liked' } | { kind: 'list', id, dirid, own, name } | { kind: 'search', q }; kept */
let qOnSrc = (() => { try { return JSON.parse(lsGet('lrc-qq-on-src')) || { kind: 'liked' }; } catch (e){ return { kind: 'liked' }; } })();
let qOnLists = null, qOnListsAt = 0;
const qOnGet = async url => { try { return await (await fetch(url, { cache: 'no-store' })).json(); } catch (e){ return { ok: false, reason: '本地程序没有运行' }; } };
function qOnSrcSet(src){ qOnSrc = src; lsSet('lrc-qq-on-src', JSON.stringify(src)); qKey = ''; qOnChips(); qLoad(); }
/* the account's play lists as chips (read at most once a minute), and the search's, when there is one */
async function qOnChipsLoad(){
  if (qOnLists && performance.now() - qOnListsAt < 60000) return;
  const r = await qOnGet('/api/music/qq/playlists');
  qOnLists = r.ok ? r.lists : []; qOnListsAt = performance.now();
  qOnChips();
}
function qOnChips(){
  const el = $('amQOnLists'), s = qOnSrc;
  const chips = (qOnLists || []).map(p => ({ src: p.liked ? { kind: 'liked' } : { kind: 'list', id: p.id, dirid: p.dirid, own: p.own, name: p.name }, label: p.name, n: p.count }));
  if (!chips.some(c => c.src.kind === 'liked')) chips.unshift({ src: { kind: 'liked' }, label: '我喜欢' });
  if (s.kind === 'search') chips.unshift({ src: s, label: '搜索：' + s.q });
  if (s.kind === 'list' && !chips.some(c => c.src.kind === 'list' && c.src.id === s.id)) chips.unshift({ src: s, label: s.name || '歌单 ' + s.id });
  const same = (a, b) => a.kind === b.kind && (a.kind === 'liked' || (a.kind === 'search' ? a.q === b.q : a.id === b.id));
  el.innerHTML = chips.map((c, i) => `<button class="amqchip" type="button" data-i="${i}" aria-pressed="${same(c.src, s)}">${qEsc(c.label)}${c.n ? `<small>${c.n}</small>` : ''}</button>`).join('');
  el.onclick = e => { const b = e.target.closest('.amqchip'); if (b) qOnSrcSet(chips[+b.dataset.i].src); };
}
$('amQOnForm').onsubmit = e => {
  e.preventDefault();
  const q = $('amQOnQ').value.trim();
  if (q) qOnSrcSet({ kind: 'search', q });
};
async function qOnlineLoad(){
  $('amQ').classList.add('onl'); $('amQOn').hidden = false;
  qOnChipsLoad();
  const s = qOnSrc;
  const r = s.kind === 'search' ? await qOnGet('/api/music/qq/search?q=' + encodeURIComponent(s.q))
    : s.kind === 'list' ? await qOnGet(`/api/music/qq/playlist?id=${encodeURIComponent(s.id)}&dirid=${s.dirid || 0}&own=${s.own ? 1 : 0}`)
    : await onlineList();
  if (!qOpen || qFollow() || s !== qOnSrc) return;
  if (s.kind === 'search' && r.ok && r.list && !s.name){      // a play list's link pasted in the search box: that list
    return qOnSrcSet({ kind: 'list', id: r.list, dirid: 0, own: false, name: r.title || '歌单 ' + r.list });
  }
  if (!r.ok){
    qOnline = null;
    return qEmpty((r.reason ? r.reason + '。' : '') + (s.kind === 'liked' ? '登录后，这里会列出你 QQ 音乐的「我喜欢」；也可以在上面搜歌、贴歌单链接，点一首就在 Lumilyric 里放。' : ''));
  }
  const cur = onlineNow(), key = 'online|' + JSON.stringify(s) + '|' + r.items.length + '|' + (r.items[0] && r.items[0].mid) + '|' + (cur && cur.mid);
  qOnline = r.items;
  if (key === qKey) return;
  qKey = key; qMenuClose();
  const now = cur ? r.items.findIndex(x => x.mid === cur.mid) : -1;
  const past = now > 0 ? r.items.slice(0, now) : [], next = now >= 0 ? r.items.slice(now + 1) : r.items;
  $('amQHist').hidden = !past.length;
  $('amQHistList').innerHTML = past.map(qRow).join('');
  $('amQList').innerHTML = next.map((x, k) => qRow(x, (now >= 0 ? now + 1 : 0) + k)).join('');
  const what = s.kind === 'search' ? `搜「${s.q}」` : s.kind === 'list' ? `歌单「${s.name || s.id}」` : '「我喜欢」';
  $('amQSrc').textContent = `${what} · QQ 音乐 · 共 ${r.items.length} 首 · 点一首在 Lumilyric 里放`;
  $('amQEmpty').textContent = r.items.length ? (next.length ? '' : '后面没有歌了。') : s.kind === 'search' ? '没有搜到。' : '这里还没有歌。';
  $('amQEmpty').hidden = !!next.length;
}
function qOnlinePlay(row){
  const i = +row.dataset.i, s = qOnline && qOnline[i];
  if (!s) return;
  for (const r of document.querySelectorAll('.amqi.pending')) r.classList.remove('pending');
  row.classList.add('pending');
  qToast('busy', `正在载入「${s.title}」…`);
  onlinePlay(qOnline, i).then(ok => {
    row.classList.remove('pending');
    if (ok) qToast('ok', `正在放「${s.title}」`, 3000); else qToast('err', $('status').textContent || '没有放成', 6000);
    qKey = ''; qLoad();
  });
}
function qAct(action, position){
  if (!qApp()) return Promise.resolve();
  return fetch('/api/nowplaying/control', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, position, app: qApp() }) })
    .then(r => r.json())
    .then(r => { if (!r.ok && action === 'playAt'){ qPendEnd(); qToast('err', '没有切成功' + (r.reason ? '：' + r.reason : '')); }
      if (!r.ok) $('status').textContent = ({ playAt: '没有放成这一首', removeAt: '没有移出列表', openAt: '没有打开', mode: '没有切换成' }[action] || '没有成功') + (r.reason ? '：' + r.reason : ''); })
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
  for (const b of m.querySelectorAll('[data-a="remove"], [data-a="open"]')) b.hidden = qQQD();      // QQ Music: only to play
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
  if (!qFollow()) return qOnlinePlay(row);      // the account's list, played here
  const name = row.querySelector('.t') ? row.querySelector('.t').textContent : '这首歌';
  if (qQQD()) qPendSet(row, name);
  else $('status').textContent = '正在让播放器切到「' + name + '」…';
  qAct('playAt', +row.dataset.i);
};
$('amQScroll').addEventListener('scroll', () => { if (qMenuBtn) qMenuClose(); }, { passive: true });
document.addEventListener('pointerdown', e => { if (qMenuBtn && !e.target.closest('#amQMenu, .amqi .x')) qMenuClose(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && qMenuBtn) qMenuClose(); });
$('amQueue').onclick = () => qShow(!qOpen);
setInterval(() => { if (!qOpen && !qSvc()) qLoad(); }, 4000);   // the shuffle / repeat buttons show QQ's mode (QQ Music has none to show)
/* A click on a line of the list asks for another song, and the player takes a moment to change (it has to start it): the line
   shows it was asked for (it lights up, a ring turns), the panel says so, and when the song playing is another one it says
   it is done. If it has not changed after QPEND_MS, it says it did not work. */
const QPEND_MS = 12000;
let qPend = null, qToastT = 0;       // { title, tid (the song playing when it was asked for), at }
function qToast(kind, text, ms = 0){
  const el = $('amQToast');
  clearTimeout(qToastT);
  el.className = 'amqtoast ' + kind; el.textContent = text; el.hidden = false;
  if (ms) qToastT = setTimeout(() => { el.hidden = true; }, ms);
}
function qPendSet(row, title){
  qPend = { title, tid: (late.F && late.F.trackId) || '', at: performance.now() };
  for (const r of document.querySelectorAll('.amqi.pending')) r.classList.remove('pending');
  row.classList.add('pending');
  qToast('busy', `已发给 QQ 音乐，等它切到「${title}」…`);
}
function qPendEnd(){
  qPend = null;
  for (const r of document.querySelectorAll('.amqi.pending')) r.classList.remove('pending');
}
function qPendCheck(){
  if (!qPend) return;
  const tid = (late.F && late.F.trackId) || '';
  if (tid && tid !== qPend.tid){
    const asked = qPend.title;
    qPendEnd();
    qToast('ok', `已切到「${$('covTi').textContent || asked}」`, 3500);
    qKey = ''; qLoad();
  } else if (performance.now() - qPend.at > QPEND_MS){
    const asked = qPend.title;
    qPendEnd();
    qToast('err', `QQ 音乐 ${QPEND_MS / 1000} 秒内没有切歌：「${asked}」。可能它没响应，或没找到这首歌`, 6000);
  }
}
setInterval(qPendCheck, 300);

/* QQ Music's lists: where they come from (the play list named, the folder its lyric files are in) is set in the panel,
   in the place of shuffle and repeat. Shown while QQ Music (the program) is followed. */
function qqSet(q){
  $('amQ').classList.toggle('qqd', !!q);
  $('amQSet').hidden = !q;
  if (!q) return;
  const pl = lsGet('lrc-qq-list'), cache = lsGet('lrc-qq-cache');
  if (document.activeElement !== $('amQPl')) $('amQPl').value = pl === 'liked' ? '' : pl;
  $('amQPlLiked').setAttribute('aria-pressed', String(pl === 'liked'));
  const note = $('amQPlNote');
  note.classList.toggle('err', !!q.listErr);
  note.textContent = q.listErr ? q.listErr : pl && !q.list ? '没认出歌单的编号：要一串数字，或者含 playlist/数字 的链接' : q.listTitle ? `歌单「${q.listTitle}」，共 ${q.listCount} 首（清空后点载入就不再显示）` : '';
  $('amQCacheTxt').textContent = q.found ? `历史记录来自 ${q.root}（${q.how}），共 ${q.history} 首。` : `没有在 ${q.root}（${q.how}）找到 QQ 音乐的歌词缓存，历史记录是空的。`;
  $('amQCacheNote').classList.toggle('err', !q.found);
  if (document.activeElement !== $('amQCache')) $('amQCache').value = cache;
}
$('amQPlForm').onsubmit = e => { e.preventDefault(); lsSet('lrc-qq-list', $('amQPl').value.trim()); qKey = ''; qLoad(); };
$('amQPlLiked').onclick = () => { lsSet('lrc-qq-list', lsGet('lrc-qq-list') === 'liked' ? '' : 'liked'); qKey = ''; qLoad(); };
$('amQCacheEdit').onclick = () => { const f = $('amQCacheForm'); f.hidden = !f.hidden; if (!f.hidden) $('amQCache').focus(); };
$('amQCacheForm').onsubmit = e => { e.preventDefault(); lsSet('lrc-qq-cache', $('amQCache').value.trim()); qKey = ''; qLoad(); };
$('amQCacheAuto').onclick = () => { $('amQCache').value = ''; lsSet('lrc-qq-cache', ''); qKey = ''; qLoad(); };
/* the favourite star, while QQ Music (the program), NetEase or KuGou is followed. With the account signed in (设置 → 音乐账号,
   accounts.js) the star shows whether the song is in its 我喜欢, as the service says, and a click changes it there and
   shows what the service says after (it is read back). QQ Music without an account: the program itself is told (its
   command line), which cannot be read back; the star then shows what was asked, remembered for the song. Any other
   player: it only holds its place. */
const hearts = (() => { try { return JSON.parse(lsGet('lrc-qq-hearts') || '{}'); } catch (e){ return {}; } })();
const SVC_NAME = { qq: 'QQ 音乐', netease: '网易云', kugou: '酷狗' };
let heartTid = null, heartSeq = 0, heartSigned = false;
function starSet(on, title){
  $('amStar').setAttribute('aria-pressed', String(!!on));
  if (title) $('amStar').title = title;
}
function heartShow(){
  const tid = (late.F && late.F.trackId) || '';
  if (tid === heartTid) return;
  heartTid = tid;
  const svc = qSvc(), my = ++heartSeq;
  heartSigned = false;
  starSet(svc === 'qq' && !!hearts[tid], svc ? `收藏到${SVC_NAME[svc]}的「我喜欢」` : '收藏（跟随 QQ 音乐、网易云、酷狗时可用）');
  if (!svc || !tid) return;
  fetch('/api/music/liked?app=' + encodeURIComponent(qApp()), { cache: 'no-store' }).then(r => r.json()).then(r => {
    if (my !== heartSeq) return;
    heartSigned = !!r.signedIn;
    if (r.known) starSet(r.liked, r.liked ? `已在你${SVC_NAME[svc]}的「我喜欢」里，点一下取消` : `点一下加入你${SVC_NAME[svc]}的「我喜欢」`);
  }).catch(() => {});
}
setInterval(heartShow, 400);
acctChanged(() => { heartTid = null; qKey = ''; if (qOpen) qLoad(); });      // signed in or out: asked again
$('amStar').addEventListener('click', () => {
  const on = $('amStar').getAttribute('aria-pressed') !== 'true', svc = qSvc();
  if (!svc){
    starSet(on);
    $('status').textContent = '「收藏」只在跟随 QQ 音乐、网易云、酷狗时有用，现在只是占个位置';
    return;
  }
  const tid = (late.F && late.F.trackId) || '', my = heartSeq;
  starSet(on);
  $('status').textContent = (on ? '正在加入' : '正在取消') + `${SVC_NAME[svc]}的「我喜欢」…`;
  fetch('/api/nowplaying/control', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: on ? 'favorite' : 'unfavorite', position: 0, app: qApp() }) })
    .then(r => r.json())
    .then(r => {
      const same = my === heartSeq && tid === heartTid;
      if (!r.ok){ $('status').textContent = (on ? '没有加入「我喜欢」' : '没有取消「我喜欢」') + (r.reason ? '：' + r.reason : ''); if (same) starSet(!on); return; }
      if (r.liked === true || r.liked === false){          // the account's own answer, read back
        if (same) starSet(r.liked);
        $('status').textContent = (r.liked ? '已在' : '已不在') + `你${SVC_NAME[svc]}的「我喜欢」里（已向${SVC_NAME[svc]}确认）`;
        return;
      }
      if (on) hearts[tid] = 1; else delete hearts[tid];      // QQ Music's command line: nothing to read back
      lsSet('lrc-qq-hearts', JSON.stringify(Object.fromEntries(Object.entries(hearts).slice(-300))));
      $('status').textContent = (on ? '已让 QQ 音乐加入「我喜欢」' : '已让 QQ 音乐取消「我喜欢」') + '（读不到它有没有成功；在设置的「音乐账号」里登录 QQ 音乐就能确认）';
    })
    .catch(e => { $('status').textContent = '收藏失败：' + e.message; if (my === heartSeq) starSet(!on); });
});
document.querySelectorAll('.amph:not(#amStar)').forEach(b => b.onclick = () => { $('status').textContent = `「${b.getAttribute('aria-label')}」还没有功能，先占个位置`; });

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
