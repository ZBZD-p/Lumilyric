import { late } from '../core/late.js';
import { $, audio, lrcSong, playing, setAlignStats, setLrcName, setLrcRawText, setLrcSong, setWhisperWords, song } from '../core/lyrics.js';
import { purelyInstrumental } from '../core/core.js';
import { createSongFlow } from '../render/song-transition.js';
import { songStage, useScroll } from '../render/layout-scroll.js';
import { seek, setPlaying } from '../core/settings.js';
import { setCover } from '../background/cover-extract.js';
import { amllLookup } from './library.js';

export {
  QUALITIES,
  onlineList,
  onlineNow,
  onlinePlay,
  qqQuality,
  qqQualitySet,
};

/* Playing QQ Music songs in Lumilyric itself (not following a player): the songs of the AM layout's list (the account's
   我喜欢 or another of its play lists, a public play list, or a search: ui/am.js), one after another. A song's file is
   fetched by the local program (server/music_apis.py qq_song: the quality chosen in 设置 → 音乐账号, the best of it this
   account may have, or its 30-second preview) and played while it comes in (/api/music/qq/stream, byte ranges as from any
   web server): it starts after the first moments of the file, not after the whole of it. When all of it is here, it is
   also kept as the song's file (its beat is found, it can be exported with the video), as for a file the user chose.
   Its lyrics are looked for as for a followed player (the community library first, then QQ Music and the others through
   LDDC), its picture is the album's.
   The list is the queue: when a song ends the next one is played; the previous / next buttons step through it. The next
   song is fetched ahead (PREFETCH_AFTER s into this one), and the last few stay (the program keeps their files in memory,
   this page their lyrics and pictures): going on, or back to the one before, starts at once.
   A song change looks as when following a player (song-transition.js): the old lyrics are dragged away at once, the
   new ones come in from below when they are found; the sound does not wait for them. */
let queue = [], at = -1, seq = 0, mine = null, loading = false;      // mine: the audio element of the song played from the list
const onlineNow = () => (at >= 0 && (loading || (audio && audio === mine)) && queue[at]) || null;      // (a file opened by hand since: none)
Object.assign(late, { onlineNow });      // the picture question after lyrics load is not asked for these songs: they have the album's (ui-effects.js)

const QUALITIES = { standard: '标准', high: '高品质', lossless: '无损' };
function qqQuality(){ try { const q = localStorage.getItem('lrc-qq-quality'); return q in QUALITIES ? q : 'high'; } catch (e){ return 'high'; } }
function qqQualitySet(q){ try { localStorage.setItem('lrc-qq-quality', q); } catch (e){} }
const qualityName = (q, preview) => preview ? '试听片段（这首要会员，只给了 30 秒）' : q === 'flac' ? '无损 FLAC' : q === 'm4a' ? 'm4a' : q + ' kbps';

async function onlineList(){
  try { return await (await fetch('/api/music/qq/liked', { cache: 'no-store' })).json(); }
  catch (e){ return { ok: false, reason: '本地程序没有运行' }; }
}

/* lyrics for a song by its names: the community library (word by word), else the best of the sources LDDC searches */
async function findLyrics(s){
  try {
    const a = await amllLookup(s.title, s.artist, s.album, s.dur || 0);
    if (a && a.lrc) return a;
  } catch (e){}
  try {
    const q = new URLSearchParams({ title: s.title, artist: s.artist, duration: String(s.dur || 0), src: 'QQ音乐' });
    const r = await (await fetch('/api/lyrics/find?' + q)).json();
    if (r && r.lrc) return r;
  } catch (e){}
  return null;
}

/* the song's names on the page, and its lyrics when res has them (else, once the search is over, none: the cover in the
   middle, AM; a pure-music song too). waiting: the search is not over yet, the names only for now */
function showLyrics(s, res, waiting){
  const name = [s.title, s.artist].filter(Boolean).join(' - ');
  // lyrics loaded stop the sound and go back to 0 (main.js applySource, as for a file chosen by hand); these come while
  // the song plays: it goes on where it is
  const keep = audio && audio === mine ? { t: audio.currentTime, on: playing } : null;
  let ok = false;
  if (res && res.lrc && (res.ttml || !purelyInstrumental(res.lrc))){
    try { ok = res.ttml ? late.loadTTMLText(res.lrc, name, '来自 ' + res.source) : late.loadLRCText(res.lrc, name, '来自 ' + res.source); } catch (e){ ok = false; }
  }
  if (!ok){
    setWhisperWords(null); setAlignStats(null);
    setLrcSong({ meta: { ti: s.title, ar: s.artist, al: s.album }, lines: [], length: 1 });
    setLrcName(s.title); setLrcRawText('');
    late.applySource('lrc');
  }
  if (lrcSong){                                          // the song's own names, not the lyric file's header
    lrcSong.meta.ti = s.title; lrcSong.meta.ar = s.artist; lrcSong.meta.al = s.album;
    $('songTitle').textContent = s.title;
    $('songArtist').textContent = [s.artist, s.album].filter(Boolean).join(' · ') || ' ';
  }
  if (late.setNoLyrics) late.setNoLyrics(!ok && !waiting);
  if (keep){ seek(keep.t); if (keep.on) setPlaying(true); }
  return ok;
}

/* a song's lyrics and picture, looked for once and kept for the last few songs (META_KEEP: the one before, this one, the
   next), whatever the quality */
const META_KEEP = 5;
const metas = new Map();                                 // mid -> { lyrics: Promise, pic: Promise<Blob|null> }
function meta(s){
  let m = metas.get(s.mid);
  if (m) metas.delete(s.mid);
  else m = {
    lyrics: findLyrics(s),
    pic: s.big ? fetch('/api/cover/img?u=' + encodeURIComponent(s.big)).then(r => r.ok ? r.blob() : null).catch(() => null) : Promise.resolve(null),
  };
  metas.set(s.mid, m);                                   // (the newest last)
  while (metas.size > META_KEEP) metas.delete(metas.keys().next().value);
  return m;
}
/* have the program start fetching the song's file (or find it kept): { quality, preview }, or throws the reason */
async function fileFor(s, q){
  let r;
  try { r = await (await fetch(`/api/music/qq/prefetch?mid=${encodeURIComponent(s.mid)}&q=${q}`, { cache: 'no-store' })).json(); }
  catch (e){ throw new Error('本地程序没有运行'); }
  if (!r.ok) throw new Error(r.reason || 'QQ 音乐没有给播放地址');
  return r;
}
const PREFETCH_AFTER = 4;
let pre = null;                                          // { mid, q, file: Promise } of the next song
function prefetch(i){
  const s = queue[i], q = qqQuality();
  if (!s || (pre && pre.mid === s.mid && pre.q === q)) return;
  meta(s);
  const p = { mid: s.mid, q, file: fileFor(s, q) };
  p.file.catch(() => { if (pre === p) pre = null; });     // (asked again when it is played)
  pre = p;
}
/* the song change: the old lyrics leave, the new ones are loaded once they have (song-transition.js), or none */
let lyrNote = '', say = () => {};
const flow = createSongFlow(songStage, {
  scroll: () => useScroll(),
  hasLines: () => song.lines.length > 0,
  blank: s => showLyrics(s, null, true),
  load: (s, res) => {
    const ok = showLyrics(s, res, false);
    lyrNote = ok ? '' : ' · 没有找到歌词'; say();
    return ok;
  },
  none: (s, res) => {
    showLyrics(s, null, false);
    lyrNote = res && res.lrc && purelyInstrumental(res.lrc) ? ' · 纯音乐' : ' · 没有找到歌词'; say();
  },
});
{ const before = songStage.onEmpty;      // (follow.js waits for the same moment)
  songStage.onEmpty = () => { if (before) before(); setTimeout(() => flow.tick(performance.now()), 0); }; }
const header = s => {                    // the header shows the new song at once, whatever the lyrics are doing
  $('songTitle').textContent = s.title || ' ';
  $('songArtist').textContent = [s.artist, s.album].filter(Boolean).join(' · ') || ' ';
};

/* play song i of list (and keep the list as the queue). Resolves true when it plays. */
async function onlinePlay(list, i){
  if (typeof late.followOn !== 'undefined' && late.followOn){
    $('status').textContent = '正在跟随播放器：先关掉「跟随」，才能在 Lumilyric 里放歌';
    return false;
  }
  const s = list[i];
  if (!s) return false;
  queue = list.slice(); at = i;
  const my = ++seq, q = qqQuality();
  loading = true;
  const ahead = pre && pre.mid === s.mid && pre.q === q ? pre.file : null;
  pre = null;
  const m = meta(s);
  $('status').textContent = `正在载入「${s.title}」…`;
  if (audio && !audio.paused && audio === mine) setPlaying(false);      // the song asked for is coming: the one before stops now
  const fseq = flow.trackChanged(performance.now(), s);                // its lyrics leave now
  header(s);
  lyrNote = ' · 正在找歌词…'; say = () => {};
  m.lyrics.then(res => { if (my === seq) flow.lyrics(performance.now(), fseq, s, res || { lrc: null }); });
  let got;
  try { got = await (ahead ? ahead.catch(() => fileFor(s, q)) : fileFor(s, q)); }
  catch (e){
    if (my === seq){ loading = false; $('status').textContent = `放不了「${s.title}」：${e.message}`; }
    return false;
  }
  if (my !== seq) return false;
  const url = `/api/music/qq/stream?mid=${encodeURIComponent(s.mid)}&q=${q}`;
  late.loadAudioUrl(url, `${s.artist} - ${s.title}`);
  mine = audio; loading = false;
  audio.addEventListener('ended', () => { if (my === seq) next(); });
  setPlaying(true);
  m.pic.then(pic => { if (pic && my === seq) setCover(pic, 'QQ 音乐专辑封面'); });
  $('prevBtn').hidden = $('nextBtn').hidden = false;
  say = () => {
    if (my === seq) $('status').textContent = `正在放「${s.title}」· QQ 音乐 ${qualityName(got.quality, got.preview)}` +
      lyrNote + ` · 列表第 ${i + 1} / ${queue.length} 首`;
  };
  say();
  audio.addEventListener('loadedmetadata', say, { once: true });      // (after the file's own "loaded" note)
  // the whole file, once it is all here (from the program's memory: no second download): its beat, and for export
  fetch(url).then(r => r.ok ? r.blob() : null).then(b => {
    if (!b || my !== seq) return;
    const ext = got.quality === 'flac' ? 'flac' : got.quality === 'm4a' ? 'm4a' : 'mp3';
    late.setStreamFile(new File([b], `${s.artist} - ${s.title}.${ext}`, { type: b.type || 'audio/mpeg' }));
  }).catch(() => {});
  setTimeout(() => { if (my === seq) prefetch(at + 1); }, PREFETCH_AFTER * 1000);
  return true;
}
function next(){ if (at >= 0 && at < queue.length - 1) onlinePlay(queue, at + 1); }
function prev(){
  if (at < 0) return;
  if (audio && audio.currentTime > 3){ audio.currentTime = 0; return; }      // a moment in: back to its start, as players do
  if (at > 0) onlinePlay(queue, at - 1);
}
// (following a player, these buttons are its own: follow.js; here only while a song of the list plays)
$('prevBtn').addEventListener('click', () => { if (!late.followOn && onlineNow()) prev(); });
$('nextBtn').addEventListener('click', () => { if (!late.followOn && onlineNow()) next(); });
