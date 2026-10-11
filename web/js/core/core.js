export {
  CHARWISE,
  CJK,
  CJK_PUNCT,
  SAMPLE,
  parseLRC,
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
  let seenLyric = false;
  for (const e of raw){
    const plain = e.txt.replace(/<[\d:.]+>/g, '').trim();
    if (!plain || CREDIT.test(plain) || (!seenLyric && CREDIT_LABEL.test(plain))) continue;
    if (e.t < 1.5 && meta.ar && plain.includes(meta.ar)) continue; // "title - artist" header line
    const last = lines[lines.length - 1];
    // Chinese = Han characters without Japanese kana; a Chinese line after a foreign-language line is its translation
    const isZh = CJK.test(plain) && !/[\u3040-\u30ff]/.test(plain);
    if (isZh && last && last.en && !last.zh) { last.zh = plain.replace(/\s+/g, ' '); continue; }
    const wl = wordTags(e.txt, off);
    const L = { t: Math.max(0, e.t - off), en: isZh ? '' : wl.text, zh: isZh ? wl.text : '' };
    if (wl.wt){ L.wt = wl.wt; L.wtText = wl.text; L.t = wl.wt[0].s; }
    lines.push(L); seenLyric = true;
  }
  lines.forEach((l, i) => l.end = lines[i + 1] ? lines[i + 1].t : l.t + 4);
  const tail = raw.length ? raw[raw.length - 1].t - off : 0;
  return { meta, lines, length: Math.max(tail, lines.length ? lines[lines.length - 1].end : 0) + 1 };
}
