import { $ } from '../core/lyrics.js';
import { qqQuality, qqQualitySet } from '../player/online.js';

export {
  acctChanged,
};

/* 音乐账号 (the effects drawer): QQ音乐 / 网易云 / 酷狗, each signed in by a QR code scanned with its phone app. The local
   program does the talking (server/music_apis.py); this only shows who is signed in, the code, and how the scan goes.
   When an account comes or goes, the star and the list are told (acctChanged). */
const NAMES = { qq: 'QQ音乐', netease: '网易云音乐', kugou: '酷狗音乐' };
const listeners = [];
const acctChanged = fn => listeners.push(fn);
const tell = () => listeners.forEach(fn => { try { fn(); } catch (e){} });
let state = {};
async function load(){
  let r;
  try { r = await (await fetch('/api/music/status', { cache: 'no-store' })).json(); }
  catch (e){ for (const row of document.querySelectorAll('.acctrow')){ row.querySelector('.acctst').textContent = '本地程序没有运行'; row.querySelector('button').disabled = true; } return; }
  state = r.services || {};
  for (const row of document.querySelectorAll('.acctrow')){
    const s = state[row.dataset.svc] || {}, st = row.querySelector('.acctst'), b = row.querySelector('button');
    st.classList.toggle('on', !!s.user);
    st.textContent = !s.installed ? '接口服务没有安装' : s.user ? '已登录：' + s.user.name : '未登录';
    b.disabled = !s.installed;
    b.textContent = s.user ? '退出' : '扫码登录';
  }
}
/* the quality QQ Music songs are played at here (player/online.js) */
function qualityShow(){ for (const b of document.querySelectorAll('#acctQuality button')) b.setAttribute('aria-pressed', b.dataset.q === qqQuality()); }
for (const b of document.querySelectorAll('#acctQuality button')) b.onclick = () => { qqQualitySet(b.dataset.q); qualityShow(); };
qualityShow();
let poll = 0, until = 0, cur = null, channel = 'qq';
function stop(){ clearTimeout(poll); poll = 0; }
function msg(t){ $('acctMsg').textContent = t; }
async function begin(){
  stop();
  $('acctQR').removeAttribute('src'); $('acctRetry').hidden = true;
  msg('正在拿二维码…（第一次要先启动' + NAMES[cur] + '的接口服务，可能要十几秒）');
  let r;
  try { r = await (await fetch('/api/music/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ svc: cur, channel }) })).json(); }
  catch (e){ msg('拿不到二维码：' + e.message); $('acctRetry').hidden = false; return; }
  if (!r.ok){ msg('拿不到二维码：' + (r.reason || '')); $('acctRetry').hidden = false; return; }
  $('acctQR').src = r.img;
  msg('用' + (cur === 'qq' ? { qq: '手机 QQ', wechat: '微信', qqmusic: 'QQ音乐 App' }[channel] : NAMES[cur] + ' App') + '扫一扫这个二维码');
  until = performance.now() + 180000;
  const key = r.key, svc = cur;
  const check = async () => {
    poll = 0;
    if (cur !== svc || $('acctModal').hidden) return;
    if (performance.now() > until){ msg('等太久了，二维码可能已经过期'); $('acctRetry').hidden = false; return; }
    let c;
    try { c = await (await fetch('/api/music/login/check?svc=' + svc + '&key=' + encodeURIComponent(key), { cache: 'no-store' })).json(); }
    catch (e){ poll = setTimeout(check, 2000); return; }
    if (c.state === 'ok'){ msg('登录成功'); await load(); tell(); setTimeout(close, 900); return; }
    if (c.state === 'expired'){ msg('二维码过期了' + (c.reason ? '：' + c.reason : '')); $('acctRetry').hidden = false; return; }
    if (c.state === 'scanned') msg('已扫码，请在手机上点确认');
    poll = setTimeout(check, 1500);
  };
  poll = setTimeout(check, 1500);
}
function open(svc){
  cur = svc; channel = 'qq';
  $('acctTitle').textContent = '扫码登录' + NAMES[svc];
  $('acctChan').hidden = svc !== 'qq';
  for (const b of $('acctChan').querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.ch === channel));
  $('acctModal').hidden = false;
  begin();
}
function close(){ stop(); cur = null; $('acctModal').hidden = true; }
$('acctClose').onclick = close;
$('acctRetry').onclick = begin;
$('acctModal').addEventListener('click', e => { if (e.target === $('acctModal')) close(); });
addEventListener('keydown', e => { if (e.key === 'Escape' && !$('acctModal').hidden) close(); });
$('acctChan').onclick = e => {
  const b = e.target.closest('button[data-ch]');
  if (!b || b.dataset.ch === channel) return;
  channel = b.dataset.ch;
  for (const x of $('acctChan').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
  begin();
};
for (const row of document.querySelectorAll('.acctrow')){
  row.querySelector('button').onclick = async () => {
    const svc = row.dataset.svc, s = state[svc] || {};
    if (!s.user) return open(svc);
    row.querySelector('button').disabled = true;
    try { await fetch('/api/music/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ svc }) }); } catch (e){}
    await load(); tell();
  };
}
if ($('fxBtn')) $('fxBtn').addEventListener('click', () => setTimeout(load, 50));      // fresh each time the drawer opens
load();
