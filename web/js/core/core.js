export {
  CHARWISE,
  CJK,
  CJK_PUNCT,
  SAMPLE,
  bgAdd,
  duetSides,
  mergeSimultaneous,
  parseLRC,
  sungEnd,
};

/* Sample lyrics, shared state, small helpers, LRC parsing */
const SAMPLE = `[ti:示例 · Night Drive]
[ar:载入你的 .lrc 文件开始]
[00:01.00]Headlights cutting through the quiet
[00:04.50]车灯划开寂静
[00:04.50]Every sign is glowing white
[00:08.00]每块路牌都泛着白光
[00:08.00]Hold the wheel and let it ride
[00:11.50]握紧方向盘 随它而去
[00:11.50]Nothing left to leave behind
[00:15.00]身后已无可留恋
[00:15.00]Turn the radio down low
[00:18.50]把收音机调低
[00:18.50]Let the city lights go slow
[00:22.00]让城市灯火慢慢后退
[00:22.00]We don't need to know the road
[00:25.50]我们不必知道去路
[00:25.50]Only where the night will go
[00:29.50]只需跟随夜的方向`;

const CJK = /[㐀-鿿豈-﫿]/;
const CHARWISE = /[㐀-鿿豈-﫿\u3040-\u30ff]/;     // scripts written without spaces: one token per character
const CREDIT = /著作权|^(lyrics|composed|produced|arranged|written|mixed|作词|作曲|编曲|制作)[^:：]{0,6}[:：]/i;
const CREDIT_LABEL = /^[^:：]{1,24}[:：]/;          // "词：…", "混音师：…", "Lyrics by：…"
const CJK_PUNCT = /^[\s，。、！？；：,.!?;:“”"'‘’()（）\[\]【】…—-]+$/;

function wordTags(txt, off){
  if (!/<\d+:\d+(?:\.\d+)?>/.test(txt)) return { text: txt };
  const parts = [...txt.matchAll(/<(\d+):(\d+(?:\.\d+)?)>([^<]*)/g)].map(m => ({ s: +m[1] * 60 + parseFloat(m[2]) - off, raw: m[3] }));
  const text = (txt.slice(0, txt.search(/<\d/)) + parts.map(p => p.raw).join('')).replace(/\s+/g, ' ').trim();
  const cjkLine = CHARWISE.test(text);
  const wt = [];
  parts.forEach((p, i) => {
    const toks = cjkLine ? Array.from(p.raw).filter(c => c.trim()) : p.raw.split(/\s+/).filter(Boolean);
    const end = parts[i + 1] ? parts[i + 1].s : p.s + 0.3;
    toks.forEach((w, k) => wt.push({ w, s: p.s + (end - p.s) * k / toks.length, e: p.s + (end - p.s) * (k + 1) / toks.length, m: true }));
  });
  return { text, wt: wt.length ? wt : null };
}
/* who sings (duets, shown as Apple Music shows them: render/layout-scroll.js). A line that is only a name and a
   colon ("Selena Gomez\uff1a", "\u7537\uff1a", "\u5408\uff1a") is a label: it is not shown, and the lines after it, until the next label,
   are that singer's (L.who). A name the song has as a label, or \u7537 / \u5973 / \u5408, may also stand at the start of a line
   ("\u7537\uff1a\u2026\u2026"): it is taken off. Credits ("\u4f5c\u8bcd\uff1a\u2026") have words after the colon and are never labels. */
const SINGER_LABEL = /^([^:\uff1a,\uff0c.\u3002!\uff01?\uff1f"\u201c\u201d()\uff08\uff09]{1,40}?)\s*[:\uff1a]$/;
const SINGER_CREDIT = /^(\u4f5c\u8bcd|\u4f5c\u66f2|\u7f16\u66f2|\u5236\u4f5c|\u76d1\u5236|\u6df7\u97f3|\u6bcd\u5e26|\u548c\u58f0|\u5409\u4ed6|\u8d1d\u65af|\u9f13|\u952e\u76d8|\u5f55\u97f3|\u8bcd|\u66f2|lyrics?|music|composer|producer|arranger|written|vocals? by)/i;
const SINGER_OWN = /^(\u7537|\u5973|\u5408|\u7537\u58f0|\u5973\u58f0|\u5408\u5531|\u9f50\u5531)$/;
function singerLabel(plain){
  const m = plain.match(SINGER_LABEL);
  if (!m) return null;
  const name = m[1].trim();
  return name && name.split(/\s+/).length <= 6 && !SINGER_CREDIT.test(name) ? name : null;
}
/* "Name\uff1awords": the words, when Name is one of the song's singers (and the word times without the name) */
function singerPrefix(plain, wl, names){
  const m = plain.match(/^([^:\uff1a]{1,40}?)\s*[:\uff1a]\s*(\S.*)$/);
  if (!m || !(names.has(m[1].trim()) || SINGER_OWN.test(m[1].trim()))) return null;
  const who = m[1].trim(), text = m[2].trim();
  let wt = wl.wt;
  if (wt){                                   // drop the tokens up to the colon; a token running on past it keeps the rest
    const i = wt.findIndex(w => /[:\uff1a]/.test(w.w));
    if (i < 0) wt = null;
    else {
      const rest = wt[i].w.replace(/^.*?[:\uff1a]/, '');
      wt = (rest ? [{ ...wt[i], w: rest }] : []).concat(wt.slice(i + 1));
      if (!wt.length) wt = null;
    }
  }
  return { who, text, wt };
}
/* which lines stand on the other side (true), as Apple Music shows a duet. The main singer keeps the usual side: the
   label that is (part of) the song's artist, the one named first in it when several are; with no artist to go by,
   the first label of the song. Lines before any label, and lines sung together (合, "A & B"), are the main side.
   With no labels at all nothing moves. Kept on the song for the artist it was worked out for. */
const sgNorm = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const SG_TOGETHER = /^(合|合唱|齐唱|all|both|together|tutti)$/i;
function duetSides(song, artist){
  const key = String(artist || '');
  if (song._duet && song._duet.key === key) return song._duet.right;
  const whos = song.lines.map(l => l.who || '');
  const together = w => SG_TOGETHER.test(w) || /[&＆、,，/]|\s(x|and|with)\s|和/i.test(w);
  const names = [...new Set(whos.filter(w => w && !together(w)))];
  let right = whos.map(() => false);
  if (names.length){
    const art = sgNorm(artist);
    const inArt = names.filter(n => art && sgNorm(n) && art.includes(sgNorm(n))).sort((a, b) => art.indexOf(sgNorm(a)) - art.indexOf(sgNorm(b)));
    // none of them in the artist: one label alone is the guest (the unlabelled lines are the artist's); two or more,
    // or 男 / 女, or no artist known: the first one is the main voice
    // (TTML names its singers v1, v2 ...: v1 is the main voice)
    const main = names.includes('v1') ? 'v1' : inArt[0]
      || (art && names.length === 1 && !/^(男|女|男声|女声)$/.test(names[0]) ? null : names[0]);
    right = whos.map(w => !!w && !together(w) && w !== main);
  }
  song._duet = { key, right };
  return right;
}
/* A second voice under the main one, shown as Apple Music shows it (render/layout-scroll.js): a smaller line that comes
   out under the line (or over it) while the line is the current one. A line has at most one:
   L.bg = { t, end, en, zh, wt, wtText, above }, the texts and word times as a line has them. bgAdd puts one more piece
   of it (b, the same shape) on line A: the pieces are joined into one text, in the order they are sung. */
function bgAdd(A, b){
  const a = A.bg;
  if (!a){ A.bg = { above: false, ...b }; return; }
  const [x, y] = b.t < a.t ? [b, a] : [a, b], join = (p, q) => [p, q].filter(Boolean).join(' ');
  A.bg = { t: x.t, end: Math.max(x.end, y.end), en: join(x.en, y.en), zh: join(x.zh, y.zh), above: !!a.above };
  if (x.wt && y.wt){ A.bg.wt = x.wt.concat(y.wt); A.bg.wtText = join(x.wtText, y.wtText); }
}
/* Lines sung while another one is. In lyrics with real times (TTML) a second voice is sometimes written as lines of
   its own, which begin while the line before is still being sung. Such a line is taken out of the list and becomes
   (part of) the background of the line it is sung under: it begins after that line has (BG.after), with a good part
   of that line still to come (BG.over; less than that is a line that was only timed a little early). Once a line has
   one, the line that carries straight on from it (within BG.next) while the main line is still sung is taken too.
   lines: in order of time, with their own times (L.wt, or L.pEnd for where a line ends). */
const BG = { after: 0.15, over: 0.8, next: 0.1 };
const sungEnd = L => L.wt && L.wt.length ? L.wt[L.wt.length - 1].e : L.pEnd ?? L.t;
function mergeSimultaneous(lines){
  const out = [];
  let A = null, tail = null;                  // the line being sung; where the last piece taken into it ends
  for (const B of lines){
    const endA = A ? sungEnd(A) : -Infinity;
    if (A && ((B.t >= A.t + BG.after && endA - B.t >= BG.over) || (tail !== null && B.t < endA && Math.abs(B.t - tail) <= BG.next))){
      tail = sungEnd(B);
      bgAdd(A, { t: B.t, end: tail, en: B.en, zh: B.zh, wt: B.wt, wtText: B.wtText });
      if (B.bg) bgAdd(A, B.bg);
      continue;
    }
    out.push(A = B); tail = null;
  }
  return out;
}
function parseLRC(text){
  const meta = {}, raw = [];
  text.split(/\r?\n/).forEach((line, order) => {
    const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length){
      const m = line.match(/^\s*\[([a-z]+):(.*)\]\s*$/i);
      if (m) meta[m[1].toLowerCase()] = m[2].trim();
      return;
    }
    const txt = line.replace(/\[[^\]]*\]/g, '').trim();
    tags.forEach(t => raw.push({ t: +t[1] * 60 + parseFloat(t[2]), txt, order }));
  });
  raw.sort((a, b) => a.t - b.t || a.order - b.order);
  const off = (parseFloat(meta.offset) || 0) / 1000;
  const lines = [];
  // the singers this song names in labels of their own (first pass): only those count at the start of a line
  const names = new Set();
  for (const e of raw){ const n = singerLabel(e.txt.replace(/<[\d:.]+>/g, '').trim()); if (n) names.add(n); }
  let seenLyric = false, who = null;
  for (const e of raw){
    const plain = e.txt.replace(/<[\d:.]+>/g, '').trim();
    const label = plain && singerLabel(plain);
    if (label){ who = label; continue; }
    let wl = null, pre = null;
    if (plain && /[:\uff1a]/.test(plain)){
      wl = wordTags(e.txt, off);
      pre = singerPrefix(plain, wl, names);
      if (pre) who = pre.who;
    }
    if (!pre && (!plain || CREDIT.test(plain) || (!seenLyric && CREDIT_LABEL.test(plain)))) continue;
    if (e.t < 1.5 && meta.ar && plain.includes(meta.ar)) continue; // "title - artist" header line
    const line = pre ? pre.text : plain;
    const last = lines[lines.length - 1];
    // Chinese = Han characters without Japanese kana; a Chinese line after a foreign-language line is its translation
    const isZh = CJK.test(line) && !/[\u3040-\u30ff]/.test(line);
    if (isZh && last && last.en && !last.zh && !pre) { last.zh = line.replace(/\s+/g, ' '); continue; }
    if (!wl) wl = wordTags(e.txt, off);
    const txt = pre ? pre.text : wl.text, wt = pre ? pre.wt : wl.wt;
    const L = { t: Math.max(0, e.t - off), en: isZh ? '' : txt, zh: isZh ? txt : '' };
    if (wt){ L.wt = wt; L.wtText = txt; L.t = wt[0].s; }
    if (who) L.who = who;
    lines.push(L); seenLyric = true;
  }
  lines.forEach((l, i) => l.end = lines[i + 1] ? lines[i + 1].t : l.t + 4);
  const tail = raw.length ? raw[raw.length - 1].t - off : 0;
  return { meta, lines, length: Math.max(tail, lines.length ? lines[lines.length - 1].end : 0) + 1 };
}
