import { late } from '../core/late.js';
import { $, assignPlaying, audio, lrcName, lrcSong, playing, setAlignStats, setAudio, setBase, setLrcName, setLrcRawText, setLrcSong, setStartPerf, setWhisperWords, song } from '../core/lyrics.js';
import { fx, lyricDelay, total } from '../core/settings.js';
import { render } from '../render/view-dom.js';
import { pulseGate, pulseHz, setBgDirty } from '../background/background.js';
import { coverSide, coverVideo, imageSide, setCover, setCoverVideo } from '../background/cover-extract.js';
import { createSongFlow } from '../render/song-transition.js';
import { songStage, useScroll } from '../render/layout-scroll.js';
import { exporting, setDelay } from '../export/export.js';
import { applyFx, coverImgURL, setCoverAskPick, showCoverAsk } from '../ui/ui-effects.js';
import { api, helper } from './helper.js';

export {
  followOn,
};

/* Follow the desktop player (QQ Music, NetEase, Kugou ...): song, lyrics, cover and position come from the local helper */
let followOn = false;
let F = { pos: 0, at: 0, playing: false, duration: 0, trackId: '', app: '' };    // last snapshot from the player
let followCorr = 0, followCorrT = 0;       // smoothing: seconds still to be absorbed, and when it was last decayed
let followCoverSeq = 0;
let followInfo = null, followLyr = '';       // last snapshot (title, app ...) and the lyric note for the status line
let followAlbum = '', followLyrWait = Promise.resolve(), followCoverVer = 0, followSessKey = '', savedAudio = null, delayBefore = 0, followDelayApp = null;
const FOLLOW_JUMP = 0.35, FOLLOW_RATE = 0.03;

function followRaw(){ return F.playing ? F.pos + (Date.now() - F.at) / 1000 : F.pos; }
function followNow(){
  const p = performance.now();
  if (followCorr){                          // pull the shown time toward the player at 3 % per second
    const step = (p - followCorrT) / 1000 * FOLLOW_RATE;
    followCorr = Math.abs(followCorr) <= step ? 0 : followCorr - Math.sign(followCorr) * step;
  }
  followCorrT = p;
  const t = followRaw() + followCorr;
  return Math.max(0, F.duration > 0 ? Math.min(t, F.duration) : t);
}
function followTotal(){ return F.duration > 0 ? F.duration : song.length; }

/* players without a timeline (Kugou): the helper counts time itself, dragging the bar tells it the real position */
let followCalAt = 0, followQuiet = false;
function followLoad(text, name, note){
  followQuiet = true;
  try { return late.loadLRCText(text, name, note); } finally { followQuiet = false; }
}
function followSeek(t){
  if (followQuiet){ render(true); return; }          // applySource() seeks to 0 after loading lyrics: not a user drag
  if (!followInfo || followInfo.timeline !== false){ render(true); return; }
  t = Math.max(0, Math.min(followTotal(), t));
  F.pos = t; F.at = Date.now(); followCorr = 0;
  render(true);
  api('/api/nowplaying/calibrate', JSON.stringify({ app: followInfo.app, trackId: F.trackId, position: t }), { 'Content-Type': 'application/json' })
    .then(() => { followCalAt = Date.now(); }).catch(() => {});
}

/* ---- remote control: play, pause, previous, next on the player being followed (Windows' media session; the same
   thing the keyboard's media keys reach). What the player then does comes back like any other change. */
function followControl(action){
  if (!followOn || !followInfo) return;
  if (action === 'pause') pauseAsked = performance.now() + 1500;      // pressed here: shown at once (see pauseT)
  api('/api/nowplaying/control', JSON.stringify({ action, app: followInfo.app }), { 'Content-Type': 'application/json' })
    .then(txt => { const r = JSON.parse(txt); if (!r.ok) $('status').textContent = (followInfo.appName || '播放器') + ' 没有执行这个操作' + (r.reason ? '：' + r.reason : ''); })
    .catch(e => { $('status').textContent = '控制播放器失败：' + e.message; });
}
$('prevBtn').onclick = () => followControl('prev');
$('nextBtn').onclick = () => followControl('next');

/* "Paused" is shown only once it has lasted a moment (PAUSE_HOLD). Changing songs, a player reports itself paused for
   an instant between the two, and the button would flash to "play" and back. A pause asked for with the page's own
   button (pauseAsked) is shown at once; "playing" always is. */
const PAUSE_HOLD = 450;                               // ms
let pauseT = 0, pauseAsked = 0;
function setPlayIcon(p){
  $('icon').innerHTML = p ? '<path d="M6 4h4v16H6zM14 4h4v16h-4z"/>' : '<path d="M7 4.5v15l13-7.5z"/>';
  $('play').setAttribute('aria-label', p ? '暂停' : '播放');
}

/* ---- one snapshot from the helper */
function followApply(s){
  if (s.at < followCalAt && s.trackId === F.trackId) return;      // computed before the last calibration
  const shown = followOn && F.at ? followNow() : 0;
  const was = { playing: F.playing, trackId: F.trackId };
  F = { pos: s.position, at: s.at, playing: !!s.playing, duration: s.duration || 0, trackId: s.trackId, app: s.app };
  const tNew = followRaw(), prev = followInfo;
  followInfo = s;
  const jump = Math.abs(tNew - shown) > FOLLOW_JUMP || was.playing !== F.playing || was.trackId !== F.trackId;
  followCorr = jump ? 0 : shown - tNew;
  followCorrT = performance.now();
  if (F.playing || performance.now() < pauseAsked){
    clearTimeout(pauseT); pauseT = 0;
    if (playing !== F.playing){ assignPlaying(F.playing); setPlayIcon(playing); late.poke(); }
  } else if (playing && !pauseT){
    pauseT = setTimeout(() => {
      pauseT = 0;
      if (followOn && !F.playing && playing){ assignPlaying(false); setPlayIcon(false); late.poke(); }
    }, PAUSE_HOLD);
  }
  if (was.trackId !== F.trackId){ followCoverVer = s.coverVer || 0; followTrack(s); }
  else if (s.coverVer && s.coverVer !== followCoverVer){      // the player attached or changed its picture later
    followCoverVer = s.coverVer;
    // ... which starts the cover over, unless this song's moving cover is up already: the late picture would take
    // its place for a moment, only for the same moving cover to be found and put back
    if (!(followMoving && followMoving.tid === s.trackId && followMoving.el === coverVideo)) followCover(s, ++followCoverSeq);
  }
  else if (!prev || prev.app !== s.app || prev.timeline !== s.timeline) followStatus();
  $('seek').disabled = s.timeline !== false;
  followSessions(s);
  followDelay(s.app);
}

function followStatus(){
  const s = followInfo;
  if (!s) return;
  const name = [s.title, s.artist].filter(Boolean).join(' - ');
  $('status').textContent = `跟随：${s.appName || s.app} · ${name || '没有歌名'}` + (followLyr ? ' · ' + followLyr : '') +
    (s.timeline === false ? ' · 这个播放器不提供进度：从切歌起自己计时，拖一下进度条对准' : '');
}
function followNote(why){ followLyr = why; followStatus(); }

function followDelay(app){                  // the fixed lag of each player is remembered per player
  if (!app) return;
  if (followDelayApp !== app){
    followDelayApp = app;
    let v = 0;
    try { v = parseFloat(localStorage.getItem('lrc-follow-delay:' + app)) || 0; } catch(e){}
    setDelay(v);
  } else {
    try { localStorage.setItem('lrc-follow-delay:' + app, String(lyricDelay)); } catch(e){}
  }
}

function followSessions(s){
  const list = s.sessions || [];
  const key = list.map(x => x.app).join('|');
  const sel = $('followApp');
  sel.hidden = list.length < 2;
  if (key === followSessKey) return;
  followSessKey = key;
  const want = localStorage.getItem('lrc-follow-app') || '';
  sel.innerHTML = '';
  const auto = document.createElement('option'); auto.value = ''; auto.textContent = '自动'; sel.appendChild(auto);
  for (const x of list){
    const o = document.createElement('option'); o.value = x.app;
    o.textContent = (x.appName || x.app) + (x.playing ? ' ▶' : '');
    sel.appendChild(o);
  }
  sel.value = list.some(x => x.app === want) ? want : '';
}

/* ---- a new song: lyrics and cover */
function followBlank(s){                      // a song without lines: nothing on screen, the title stays in the header
  followQuiet = true;
  try {
    setWhisperWords(null); setAlignStats(null);
    setLrcSong({ meta: { ti: s.title, ar: s.artist, al: s.album }, lines: [], length: 1 });
    setLrcName(s.title); setLrcRawText('');
    late.applySource('lrc');
  } finally { followQuiet = false; }
}
/* the player's own title / artist / album are right; the header inside a lyric file is often not */
function followMeta(s){
  if (!lrcSong) return;
  lrcSong.meta.ti = s.title || lrcSong.meta.ti;
  if (s.artist) lrcSong.meta.ar = s.artist;
  if (s.album) lrcSong.meta.al = s.album;
  $('songTitle').textContent = lrcSong.meta.ti || lrcName;
  $('songArtist').textContent = [lrcSong.meta.ar, lrcSong.meta.al].filter(Boolean).join(' · ') || ' ';
}

/* A song change is one strict sequence (song-transition.js): lock and drag the old lyrics away, empty screen while the
   new ones are looked for, load and drag them in. Nothing is loaded before the old ones have left. */
function followHeader(s){                    // the header follows the player at once, whatever the lyrics are doing
  $('songTitle').textContent = s.title || lrcName || ' ';
  $('songArtist').textContent = [s.artist, s.album].filter(Boolean).join(' · ') || ' ';
}
const followFlow = createSongFlow(songStage, {
  scroll: () => useScroll(),
  hasLines: () => song.lines.length > 0,
  blank: s => followBlank(s),
  load: (s, res) => {
    if (!followLoad(res.lrc, [s.title, s.artist].filter(Boolean).join(' - '))) return false;
    followMeta(s);
    followNote(`歌词来自 ${res.source}（${res.verbatim ? '逐字' : '逐行'}）`);
    return true;
  },
  none: (s, res) => { followBlank(s); followNote((res && res.reason) || '没有找到匹配的歌词'); },
});
songStage.onEmpty = () => setTimeout(() => followFlow.tick(performance.now()), 0);
function followTrack(s){
  const myCover = ++followCoverSeq;
  let lyrDone;
  followAlbum = '';
  followLyrWait = new Promise(r => { lyrDone = r; });      // the cover match waits for the album name the lyrics came with
  followLyr = '正在找歌词…';
  const seq = followFlow.trackChanged(performance.now(), s);
  followHeader(s);
  followStatus();
  if (!s.title){
    followFlow.lyrics(performance.now(), seq, s, { lrc: null, reason: '播放器没有给出歌名' });
    lyrDone(); return;
  }
  followCover(s, myCover);
  api('/api/nowplaying/lyrics', JSON.stringify({ trackId: s.trackId }), { 'Content-Type': 'application/json' })
    .then(txt => JSON.parse(txt))
    .catch(e => ({ lrc: null, reason: '找歌词出错：' + (e.message || e) }))
    .then(res => {
      if (followOn && followFlow.lyrics(performance.now(), seq, s, res)) followAlbum = res.album || '';
      lyrDone();
    });
}
/* a sharper cover was chosen for this song: the helper keeps it on disk, next time it simply comes with the song */
function followSaveCover(blob, tid, side){
  if (!blob || !tid) return;
  fetch('/api/nowplaying/cover/save?track=' + encodeURIComponent(tid) + '&side=' + (side || 0),
        { method: 'POST', body: blob, headers: { 'Content-Type': blob.type || 'image/jpeg' } }).catch(() => {});
}
/* cover: the player's own picture first; a small one (a thumbnail) or none -> search and ask before replacing */
const COVER_MIN = 400, COVER_ASK = 85, COVER_AUTO = 95;   // px of the shorter side (below it a better cover is looked for); match score (0-100) needed to ask / to replace without asking
const cvNorm = t => String(t || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const cvClean = t => String(t || '').replace(/[\(（\[【《<].*?[\)）\]】》>]/g, ' ').replace(/\s+[-–—]\s+.*$/, '');
/* the artists of a song, each as it is written and, when the player adds a second name in brackets ("NewJeans (뉴진스)"),
   also by each of the two names alone: other sites give only one of them */
const cvArtists = t => new Set(String(t || '').normalize('NFKC').toLowerCase().split(/[\/、,，&;；]|\s+x\s+|\s+feat\.?\s+/)
  .flatMap(a => [a, a.replace(/[\(\[【《<].*?[\)\]】》>]/g, ' '), ...[...a.matchAll(/[\(\[【《<](.*?)[\)\]】》>]/g)].map(m => m[1])]).map(cvNorm).filter(Boolean));
/* raw names compared the way people do: "Dawn FM (Explicit)" and "Dawn FM" and "Best Friends - Single" are the
   same release for a cover. 1 = identical, 0.95 = identical once brackets / "- Single" are dropped, 0.6 = contained */
function cvSame(wantRaw, gotRaw){
  const a = cvNorm(wantRaw), b = cvNorm(gotRaw);
  if (a && a === b) return 1;
  const ac = cvNorm(cvClean(wantRaw)) || a, bc = cvNorm(cvClean(gotRaw)) || b;
  if (ac && ac === bc) return 0.95;
  return cvRel(ac, bc);
}
function cvRel(want, got){                          // 1 = same, 0.6 = one contains the other, 0 = unrelated
  if (!want || !got) return 0;
  if (want === got) return 1;
  return Math.min(want.length, got.length) >= 2 && (want.includes(got) || got.includes(want)) ? 0.6 : 0;
}
/* how well a search result fits the song (0-100): artist up to 50, album / song name up to 40, +10 when both are exact */
function coverMatch(it, s){
  const A = cvArtists(s.artist), B = cvArtists(it.artist);
  let art = A.size ? 0 : 0.4;                       // the player gave no artist: neutral
  for (const x of A) for (const y of B) art = Math.max(art, cvRel(x, y));
  // a title with brackets dropped ("Dawn FM (Alternate World)" = "Dawn FM") may be a different release with a different
  // picture: it can be asked about, but only an exact name is certain enough to be replaced without asking
  const rn = cvSame(s.title, it.title), nameScore = rn === 1 ? 35 : rn >= 0.95 ? 33 : rn ? 22 : 0;   // single: the album is often named after the song
  const ra = s.album ? cvSame(s.album, it.title) : 0;
  const pts = s.album ? Math.max(ra * 40, rn * 25) : nameScore;
  const exact = s.album ? ra === 1 : rn === 1;
  return Math.round(Math.min(100, art * 50 + pts + (art === 1 && exact ? 10 : 0)));
}
/* the covers found for the song now playing: searched once per song, for the moving cover (followMotion) and for a
   sharper picture (followCoverSuggest). Gives the song with its album filled in and the results, or null when the
   song has changed meanwhile. */
let followFound = { my: 0, p: null };
function followCoverItems(s, my){
  if (followFound.my !== my) followFound = { my, p: (async () => {
    // some players (Kugou) give no album: use the one from the lyrics search, waiting for it at most 8 s
    await Promise.race([followLyrWait, new Promise(r => setTimeout(r, 8000))]);
    if (my !== followCoverSeq || !followOn) return null;
    s = { ...s, album: s.album || followAlbum || (lrcSong && lrcSong.meta && lrcSong.meta.al) || '' };
    // the album name is the better thing to search for; the song name finds singles. Both, album results first.
    const queries = [];
    if (s.album) queries.push([cvClean(s.album).trim() || s.album, s.artist].filter(Boolean).join(' '));
    queries.push([cvClean(s.title).trim() || s.title, s.artist].filter(Boolean).join(' '));
    const got = await Promise.all([...new Set(queries)].map(q =>
      api('/api/cover/search', JSON.stringify({ q }), { 'Content-Type': 'application/json' }).then(t => JSON.parse(t).items || []).catch(() => [])));
    if (my !== followCoverSeq || !followOn) return null;
    const seen = new Set(), items = [];
    for (let i = 0; ; i++){                                  // interleave the lists so each one's best come first
      let any = false;
      for (const L of got) if (i < L.length){ any = true; if (!seen.has(L[i].key)){ seen.add(L[i].key); items.push(L[i]); } }
      if (!any) break;
    }
    return { s, items };
  })() };
  return followFound.p;
}
/* A moving cover (Apple Music, see cover_search.py) comes before any picture: when the song's album has one, it is
   used without asking, and only while the cover is shown at all (it is a download of some ten MB, kept on disk
   afterwards). "(Explicit)" / "[Clean]" in the player's album name is the same album, and the same cover.
   The album itself comes first. Failing that, another edition of it will do (MOTION_OK: the same artist, and the same
   album name once what is in brackets is left out: "... (Deluxe Edition)", "... (Alternate World)"): players often
   name the deluxe edition where Apple Music has the moving cover on the plain one only. Its picture may then differ a
   little from the player's own. Returns true when the moving cover is in place. */
const MOTION_OK = 85;
let followMoving = null;                           // { tid, el }: the song whose moving cover was put up, and that video
const cvTags = t => String(t || '').replace(/[\(（\[【]\s*(explicit|clean)\s*[\)）\]】]/ig, ' ').trim();
async function followMotion(s0, my){
  if (!fx.cover) return false;
  const f = await followCoverItems(s0, my);
  if (!f || my !== followCoverSeq || !followOn) return false;
  const s = { ...f.s, album: cvTags(f.s.album), title: cvTags(f.s.title) };
  const pick = f.items.filter(it => it.motion && it.am).map(it => ({ it, sc: coverMatch(it, s) })).filter(x => x.sc >= MOTION_OK).sort((a, b) => b.sc - a.sc)[0];
  if (!pick) return false;
  try {
    const r = await fetch(`/api/cover/motion?id=${encodeURIComponent(pick.it.am[0])}&cc=${encodeURIComponent(pick.it.am[1])}`);
    if (!r.ok) return false;
    const blob = await r.blob();
    if (my !== followCoverSeq || !followOn) return false;
    if (!await setCoverVideo(blob, `${pick.it.title} · ${pick.it.source}（动态）`)) return false;
    followMoving = { tid: s0.trackId, el: coverVideo };
    followLyr = (followLyr ? followLyr + ' · ' : '') + `封面已换成 ${pick.it.source} 的动态封面（${pick.sc > COVER_AUTO ? '' : '同一专辑的另一个版本，'}匹配度 ${pick.sc}%）`;
    followStatus();
    return true;
  } catch (e){ return false; }
}
async function followCoverSuggest(s, my, hadCover){
  const f = await followCoverItems(s, my);
  if (!f || my !== followCoverSeq || !followOn) return;
  // "(Explicit)" / "[Clean]" in the player's names is the same album with the same cover: not a different edition
  s = { ...f.s, album: cvTags(f.s.album), title: cvTags(f.s.title) };
  const items = f.items;
  // every result is scored; the best few are downloaded and measured, and the best one that is really sharper than
  // the cover in use wins (the top scorer may be a small picture while an equally good one is large)
  const ranked = items.map(it => ({ it, sc: coverMatch(it, s) })).filter(x => x.sc >= COVER_ASK)
    .sort((a, b) => b.sc - a.sc).slice(0, 6);
  if (!ranked.length) return;
  const dl = await Promise.all(ranked.map(async x => {
    try {
      const r = await fetch(coverImgURL(x.it.full || x.it.thumb));
      if (!r.ok) return x;
      const blob = await r.blob();
      return { ...x, blob, side: await imageSide(blob) };
    } catch (e){ return x; }
  }));
  if (my !== followCoverSeq || !followOn) return;
  const sharper = dl.filter(g => g.blob && g.side > coverSide).sort((a, b) => (b.sc - a.sc) || (b.side - a.side));
  if (!sharper.length){
    const top = dl.filter(g => g.blob).sort((a, b) => b.side - a.side)[0];
    if (top){
      followLyr = (followLyr ? followLyr + ' · ' : '') + `没有换封面：搜到的最大只有 ${top.side} 像素，不比现在的（${coverSide} 像素）清晰`;
      followStatus();
    }
    return;
  }
  const pick = sharper[0], best = pick.it, bestSc = pick.sc, blob = pick.blob, side = pick.side;
  if (bestSc > COVER_AUTO){                               // as good as certain: no question, just use it
    const was = coverSide;
    if (await setCover(blob, `${best.title} · ${best.source}`)){
      followSaveCover(blob, s.trackId, coverSide);
      followLyr = (followLyr ? followLyr + ' · ' : '') + `封面已换成 ${best.source} 的高清图（${was} → ${coverSide} 像素，匹配度 ${bestSc}%）`;
      followStatus();
      return;
    }
    if (my !== followCoverSeq || !followOn) return;
  }
  if (!$('coverModal').hidden || !$('exportModal').hidden || !$('coverAsk').hidden) return;
  best._tid = s.trackId;                                  // so an accepted cover is kept for this very song
  setCoverAskPick(best);
  showCoverAsk(best.thumb, `${hadCover ? '播放器给的封面太小' : '播放器没有给封面'}，找到一个很像的：${best.title || '（无标题）'}` +
    `${best.artist ? ' · ' + best.artist : ''}（${best.source}${side ? '，' + side + ' 像素' : ''}），匹配度 ${bestSc}%。要换成它吗？`);
}
async function followCover(s, my){
  try {
    let blob = null, small = true;
    for (let i = 0; i < 4 && !blob && my === followCoverSeq && followOn; i++){      // the player may attach it a moment late
      const r = await fetch('/api/nowplaying/cover?track=' + encodeURIComponent(s.trackId), { cache: 'no-store' });
      if (r.ok) blob = await r.blob(); else if (i < 3) await new Promise(r2 => setTimeout(r2, 1200));
    }
    if (my !== followCoverSeq || !followOn) return;
    if (blob){
      try {
        const bmp = await createImageBitmap(blob);
        small = Math.min(bmp.width, bmp.height) < COVER_MIN;
        bmp.close && bmp.close();
      } catch(e){}
      await setCover(blob, '播放器封面');
    }
    if (my !== followCoverSeq || !followOn) return;
    if (await followMotion(s, my)) return;                 // a moving cover, when the album has one, before any picture
    if (small && my === followCoverSeq && followOn) await followCoverSuggest(s, my, !!blob);
  } catch (e){}
}

/* ---- the helper pushes (Server-Sent Events): song state when it changes, bass samples as they arrive */
let followES = null, followErr = 0;
function followSnapshot(s){
  if (s.ok) return followApply(s);
  F.playing = false; if (playing){ assignPlaying(false); setPlayIcon(false); }
  $('status').textContent = '跟随：' + (s.reason || '没有检测到播放器');
  followInfo = null; followSessKey = ''; $('followApp').hidden = true;
  F.trackId = '';
}
function followOpen(){
  followClose();
  const app = localStorage.getItem('lrc-follow-app') || '';
  const es = followES = new EventSource('/api/nowplaying/stream' + (app ? '?app=' + encodeURIComponent(app) : ''));
  const mine = () => followES === es && followOn;
  followBassCut();
  es.onopen = () => { followErr = 0; };
  es.addEventListener('np', e => { followErr = 0; if (mine()) try { followSnapshot(JSON.parse(e.data)); } catch(err){} });
  es.addEventListener('bass', e => { if (mine()) try { followBass(JSON.parse(e.data)); } catch(err){} });
  es.onerror = () => {
    if (!mine()) return;
    if (es.readyState === 2){                              // refused: an older helper without the stream
      setFollow(false, true);
      $('status').textContent = '本地程序还是旧版本，关掉 start_server.bat 的黑色窗口再重新打开就好';
    } else if (++followErr >= 5){                          // the browser keeps reconnecting by itself
      setFollow(false, true);          // keep the switch, so it comes back with the helper
      $('status').textContent = '本地程序已断开，已退出跟随播放器。重新打开 start_server.bat 后再点“跟随播放器”';
    }
  };
}
function followClose(){
  if (followES){ const es = followES; followES = null; es.close(); }
}

/* ---- pulse from the live system sound: the helper sends the low-end level 100 times a second; the same two
   looks as the offline analysis (呼吸 / 节拍) are worked out here on the stream ---- */
const BASS_HZ = 100;
let BASS_LAG = 0.05;                                       // seconds the picture trails the capture; smooths the 50 ms polling
try { const v = parseFloat(localStorage.getItem('lrc-bass-lag')); if (isFinite(v)) BASS_LAG = Math.max(0, Math.min(0.5, v)); } catch(e){}
let bassLive = false, bassQ = [], bassWin = [], bassLo = 0, bassHi = 1;
let bassRef = 0.02, bassSlow = 0, bassPrev = 0, bassCur = 0, bassN = 0;
function followBassLive(){
  return followOn && bassLive && !(typeof exporting !== 'undefined' && exporting) && bassQ.length > 0;
}
function bassFeed(t, env){
  bassRef = Math.max(env, bassRef * Math.exp(-1 / (BASS_HZ * 20)));        // loudest bass of the last ~20 s
  const ref = Math.max(0.01, bassRef * 0.85);
  const v = Math.min(1.5, env / ref);
  bassSlow += (v - bassSlow) * (1 - Math.exp(-1 / (BASS_HZ * 0.8)));
  const p = Math.max(0, Math.min(1, (v - 0.75 * bassSlow) / 0.55)) * Math.min(1, v * 1.4);
  bassPrev = Math.max(p, bassPrev * Math.exp(-1 / (BASS_HZ * 0.16)));
  const lv = Math.log10(1 + 60 * env);
  bassWin.push(lv); if (bassWin.length > BASS_HZ * 15) bassWin.shift();
  if (++bassN % 50 === 1 && bassWin.length > 50){
    const so = bassWin.slice().sort((a, b) => a - b);
    bassLo = so[Math.floor(so.length * 0.1)]; bassHi = so[Math.floor(so.length * 0.98)] || 1;
  }
  const x = Math.max(0, Math.min(1, (lv - bassLo) / Math.max(0.15, bassHi - bassLo)));
  const e = x * x;                                         // quick attack, slow release: less laggy than the offline look
  bassCur += (e - bassCur) * (1 - Math.exp(-1 / (BASS_HZ * (e > bassCur ? 0.08 : 0.3))));
  bassQ.push([t, bassCur, bassPrev]);
  if (bassQ.length > BASS_HZ * 4) bassQ.shift();
}
function followBassAt(){
  if (!(fx.bg.pulse > 0) || !bassQ.length) return 0;
  const t = Date.now() - BASS_LAG * 1000, last = bassQ[bassQ.length - 1];
  if (t - last[0] > 700) return 0;                         // no sound coming in: calm
  const k = fx.bg.pulseMode === 'beat' ? 2 : 1;
  let i = bassQ.length - 1;
  while (i > 0 && bassQ[i][0] > t) i--;
  const a = bassQ[i], b = bassQ[Math.min(i + 1, bassQ.length - 1)];
  const f = b[0] > a[0] ? Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))) : 0;
  return pulseGate(a[k] + (b[k] - a[k]) * f) * fx.bg.pulse;
}
/* 低音范围: the helper measures the live sound, so it is told what counts as bass (when following starts, and when
   the setting changes). An older helper does not know the address and goes on with 140 Hz. */
function followBassCut(){
  if (followOn) fetch('/api/nowplaying/bass/cut?hz=' + pulseHz()).catch(() => {});
}
function followBass(j){
  if (j.ok === false){ bassLive = false; return; }          // not installed: no pulse, nothing else is affected
  if (!bassLive){ bassLive = true; if (typeof applyFx === 'function') applyFx(); }
  for (const [t, v] of j.samples || []) bassFeed(t, v);
}

/* ---- on / off */
function setFollow(on, keepPref){
  if (on === followOn) return;
  followOn = on;
  if (!keepPref){ try { localStorage.setItem('lrc-follow', on ? '1' : '0'); } catch(e){} }
  $('followBtn').classList.toggle('on', on);
  $('prevBtn').hidden = $('nextBtn').hidden = !on;       // previous / next only mean something for a player
  $('followBtn').setAttribute('aria-pressed', on);
  followClose();
  if (on){
    songStage.reset();
    delayBefore = lyricDelay; followDelayApp = null;
    if (audio){ audio.pause(); savedAudio = audio; setAudio(null); }
    assignPlaying(false); setPlayIcon(false);
    $('seek').disabled = true;                 // (the play button stays usable: it asks the player to play / pause)
    F = { pos: 0, at: 0, playing: false, duration: 0, trackId: '', app: '' };
    followCorr = 0; followErr = 0; followInfo = null; followLyr = ''; followSessKey = '';
    $('status').textContent = '跟随：正在连接播放器…';
    bassQ = []; bassWin = []; bassCur = bassPrev = bassSlow = 0;
    followOpen();
  } else {
    bassLive = false; setBgDirty(true);
    songStage.reset(); followCoverSeq++;
    const t = followRaw();
    if (savedAudio){ setAudio(savedAudio); savedAudio = null; }
    else { setBase(Math.min(t, total())); setStartPerf(performance.now()); }
    assignPlaying(false); setPlayIcon(false);
    $('play').disabled = false; $('seek').disabled = false;
    $('followApp').hidden = true;
    setDelay(delayBefore);
    render(true);
    $('status').textContent = '已退出跟随播放器，歌词保留';
  }
}
function followInit(){
  $('followBtn').hidden = !(helper && helper.nowplaying === true);
  if ($('followBtn').hidden) return;
  let saved = true;                       // on by default; stays off once the user has turned it off
  try { saved = localStorage.getItem('lrc-follow') !== '0'; } catch(e){}
  if (saved) setFollow(true, true);
}
$('followBtn').onclick = () => setFollow(!followOn);
$('followApp').onchange = e => {
  try { localStorage.setItem('lrc-follow-app', e.target.value); } catch(e2){}
  F.trackId = '';                           // treat the next snapshot as a new song
  followDelayApp = null;
  if (followOn) followOpen();                // the stream is per player
};
addEventListener('pagehide', () => {         // the per-player offset must not become the global one
  if (followOn){ try { localStorage.setItem('lrc-delay', String(delayBefore)); } catch(e){} }
});

/* names that modules loaded before this one call or read (core/late.js) */
Object.assign(late, { followNow, followTotal, followControl, followSeek, followBassLive, followBassAt, followBassCut, followSaveCover, followInit });
Object.defineProperties(late, {
  followOn: { get: () => followOn, enumerable: true },
  F: { get: () => F, enumerable: true },
});
