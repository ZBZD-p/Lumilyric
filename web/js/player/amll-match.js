export {
  amllPick,
};

/* Which song of the community lyrics library (AMLL TTML DB, library.js) is the one a player is on. Used when following
   a player, where a wrong song is worse than none (LDDC is asked as well and answers when this does not): the name and
   an artist must both be the same. Pure (no DOM): tests/test_amll_match.js.

   - name: the same once brackets and a " - …" tail are dropped ("Song (feat. X)" = "Song");
   - artist: at least one of the player's artists is one of the entry's (a name with a second name in brackets,
     "NewJeans (뉴진스)", counts by each of the two); a player that names no artist is not matched at all;
   - a different recording is not the song: when either name carries a live / remix / acoustic ... tag, the tags must
     be the same, not only the words in front of them;
   - several entries for one song: the one whose name is written exactly like the player's, then the one with more
     artists in common and the same album, then the later submission. */
const norm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const BRACKET = /[\(（\[【《<][^\)）\]】》>]*[\)）\]】》>]/g, TAIL = /\s[-–—]\s.*$/, FEAT = /^[\(（\[【《<]\s*(feat|ft|with|featuring)\b/i;
const clean = t => String(t || '').replace(BRACKET, ' ').replace(TAIL, ' ');
const baseOf = t => norm(clean(t)) || norm(t);
// what is written after the name besides "feat. X": "(Live at …)", "- Radio Edit"
const tagsOf = t => (String(t || '').match(BRACKET) || []).filter(x => !FEAT.test(x)).concat(String(t || '').match(TAIL) || []).join(' ');
const RISKY = /live|现场|演唱会|remix|\bmix\b|acoustic|不插电|instrumental|伴奏|纯音乐|demo|cover|翻唱|version|ver\.|edit|sped|slowed|reverb|karaoke|\bdj\b/i;
const artistSet = list => new Set([].concat(list || []).flatMap(a => String(a || '').normalize('NFKC').toLowerCase()
  .split(/[\/、,，&;；]|\s+x\s+|\s+feat\.?\s+/)).flatMap(a => [a.replace(BRACKET, ' '), ...[...a.matchAll(/[\(\[【《<](.*?)[\)\]】》>]/g)].map(m => m[1])])
  .map(norm).filter(Boolean));

/* index: [{ name, artists: [...], album, file }]; the entry, or null */
function amllPick(index, title, artist, album){
  const want = baseOf(title), A = artistSet(artist);
  if (!want || !A.size) return null;
  const tp = tagsOf(title), wantAlbum = norm(album);
  let best = null, bs = -1;
  for (const e of index){
    if (baseOf(e.name) !== want) continue;
    let common = 0;
    for (const x of artistSet(e.artists)) if (A.has(x)) common++;
    if (!common) continue;
    const te = tagsOf(e.name);
    if ((RISKY.test(tp) || RISKY.test(te)) && norm(tp) !== norm(te)) continue;
    const sc = (norm(e.name) === norm(title) ? 100 : 0) + common * 10 + (wantAlbum && norm(e.album) === wantAlbum ? 5 : 0);
    if (sc >= bs){ bs = sc; best = e; }                  // on a tie the later entry (a later submission) stays
  }
  return best;
}
