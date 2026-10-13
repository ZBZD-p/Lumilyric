import { late } from './late.js';
import { CHARWISE, CJK, CJK_PUNCT, SAMPLE, bgAdd, mergeSimultaneous, parseLRC, sungEnd } from './core.js';

export {
  $,
  alignStats,
  assignMode,
  assignPlaying,
  audio,
  audioFile,
  base,
  buildWordTiming,
  cur,
  isTTML,
  lineTokenTimes,
  lrcName,
  lrcRawText,
  lrcSong,
  mode,
  parseTTML,
  parseWhisper,
  playing,
  preferAlign,
  setAlignStats,
  setAudio,
  setAudioFile,
  setBase,
  setCur,
  setLrcName,
  setLrcRawText,
  setLrcSong,
  setPreferAlign,
  setSong,
  setSource,
  setStartPerf,
  setUploadedId,
  setWhisperName,
  setWhisperWords,
  song,
  songFromWhisper,
  source,
  stage,
  startPerf,
  toWordLRC,
  uploadedId,
  whisperName,
  whisperWords,
};

/* TTML, Whisper word alignment, enhanced (word-level) LRC */
/* ================= TTML (Apple Music style / AMLL TTML DB word-by-word lyrics) ================= */
function ttmlTime(v){
  if (v == null || v === '') return NaN;
  v = String(v).trim().replace(/s$/, '');
  return v.split(':').reduce((a, x) => a * 60 + parseFloat(x), 0);
}
function parseTTML(text){
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('TTML 文件格式不对');
  const meta = {};
  for (const m of doc.getElementsByTagNameNS('*', 'meta')){
    const k = m.getAttribute('key'), v = m.getAttribute('value');
    if (!k || !v) continue;
    if (k === 'musicName' && !meta.ti) meta.ti = v;
    else if (k === 'artists') meta.ar = meta.ar ? meta.ar + ' / ' + v : v;
    else if (k === 'album' && !meta.al) meta.al = v;
  }
  const role = el => el.getAttribute('ttm:role') || el.getAttributeNS('http://www.w3.org/ns/ttml#metadata', 'role') || '';
  // who sings each line (duets): ttm:agent on the line; the agents in the head, a group one meaning "together" (合)
  const agentOf = el => el.getAttribute('ttm:agent') || el.getAttributeNS('http://www.w3.org/ns/ttml#metadata', 'agent') || '';
  const groupIds = new Set();
  for (const a of doc.getElementsByTagNameNS('*', 'agent')) if ((a.getAttribute('type') || '') === 'group') groupIds.add(a.getAttribute('xml:id') || a.getAttribute('id'));
  /* the words under a node, as a line: text, translation and word times. Background vocals under it (x-bg) are not
     read: the nodes are handed back (bgs). bare: without the brackets background vocals are written in. null when
     there are no words */
  const read = (top, bare) => {
    const chars = [], bgs = [];   // chars: { c, s, e }: s/e from the word span, absent for plain text between spans
    let trans = '';
    const walk = node => {
      for (const n of node.childNodes){
        if (n.nodeType === 3){ for (const c of n.nodeValue) chars.push({ c }); continue; }
        if (n.nodeType !== 1) continue;
        const r = role(n);
        if (r === 'x-translation'){ if (!trans) trans = n.textContent.trim(); continue; }
        if (r === 'x-bg'){ bgs.push(n); continue; }
        if (r === 'x-roman') continue;                           // romanisation is left out
        if (n.getElementsByTagName('*').length){ walk(n); continue; }
        const b = ttmlTime(n.getAttribute('begin')), e = ttmlTime(n.getAttribute('end'));
        for (const c of n.textContent) chars.push({ c, s: b, e });
      }
    };
    walk(top);
    // collapse whitespace the same way the page displays text
    const out = [];
    for (const ch of chars){
      if (/\s/.test(ch.c)){ if (out.length && out[out.length - 1].c !== ' ') out.push({ c: ' ' }); }
      else out.push(ch);
    }
    if (bare){
      while (out.length && /[(（\s]/.test(out[0].c)) out.shift();
      while (out.length && /[)）\s]/.test(out[out.length - 1].c)) out.pop();
    }
    while (out.length && out[out.length - 1].c === ' ') out.pop();
    const textMain = out.map(x => x.c).join('');
    if (!textMain) return { bgs };
    const pb = ttmlTime(top.getAttribute('begin')), pe = ttmlTime(top.getAttribute('end'));
    // word timings in the page's own token order (characters for Chinese/Japanese, words otherwise)
    const groups = [];
    if (CHARWISE.test(textMain)) out.forEach(x => { if (x.c !== ' ') groups.push([x]); });
    else {
      let g = [];
      out.forEach(x => { if (x.c === ' '){ if (g.length) groups.push(g); g = []; } else g.push(x); });
      if (g.length) groups.push(g);
    }
    const wt = groups.map(g => {
      const timed = g.filter(x => isFinite(x.s));
      return { w: g.map(x => x.c).join(''), s: timed.length ? Math.min(...timed.map(x => x.s)) : NaN,
               e: timed.length ? Math.max(...timed.map(x => x.e)) : NaN, m: true };
    });
    // several characters inside one span (e.g. "10"): share the span's time between them
    for (let i = 0; i < wt.length;){
      let j = i;
      while (j + 1 < wt.length && isFinite(wt[i].s) && wt[j + 1].s === wt[i].s && wt[j + 1].e === wt[i].e) j++;
      if (j > i){
        const s0 = wt[i].s, d = (wt[i].e - s0) / (j - i + 1);
        for (let k = i; k <= j; k++){ wt[k].s = s0 + d * (k - i); wt[k].e = s0 + d * (k - i + 1); }
      }
      i = j + 1;
    }
    const anyTimed = wt.some(w => isFinite(w.s));
    if (anyTimed){                 // untimed tokens sit between their neighbours
      wt.forEach((w, i) => {
        if (isFinite(w.s)) return;
        const prev = wt.slice(0, i).reverse().find(x => isFinite(x.s)), next = wt.slice(i + 1).find(x => isFinite(x.s));
        w.s = prev ? prev.e : next.s - 0.1;
        w.e = next ? next.s : w.s + 0.2;
      });
    }
    const hanOnly = CJK.test(textMain) && !/[぀-ヿ]/.test(textMain);
    const L = { t: anyTimed ? wt[0].s : (isFinite(pb) ? pb : 0), en: hanOnly ? '' : textMain, zh: hanOnly ? textMain : trans };
    if (anyTimed){ L.wt = wt; L.wtText = textMain; }
    L.pEnd = isFinite(pe) ? pe : null;
    return { L, bgs };
  };
  let lines = [];
  for (const p of doc.getElementsByTagNameNS('*', 'p')){
    const main = read(p), bgs = main.bgs.map(n => read(n, true).L).filter(Boolean).sort((a, b) => a.t - b.t);
    const L = main.L || bgs.shift();           // background vocals with no line to stand under are the line
    if (!L) continue;
    // background vocals (core.js, bgAdd): over the line when they begin before it does, and the line begins with them
    for (const b of bgs) bgAdd(L, { t: b.t, end: sungEnd(b), en: b.en, zh: b.zh, wt: b.wt, wtText: b.wtText });
    if (L.bg && L.bg.t < L.t - 0.05){ L.bg.above = true; L.t = L.bg.t; }
    const ag = agentOf(p) || (p.parentNode && p.parentNode.getAttribute && agentOf(p.parentNode));
    if (ag) L.who = groupIds.has(ag) ? '合' : ag;
    lines.push(L);
  }
  lines.sort((a, b) => a.t - b.t);
  lines = mergeSimultaneous(lines);            // lines sung while another is become its background vocals too
  lines.forEach((l, i) => l.end = lines[i + 1] ? lines[i + 1].t : Math.max(l.pEnd || l.t + 4, l.bg ? l.bg.end : 0));
  const body = doc.getElementsByTagNameNS('*', 'body')[0];
  const dur = body ? ttmlTime(body.getAttribute('dur')) : NaN;
  const last = lines.length ? lines[lines.length - 1].end : 0;
  return { meta, lines, length: Math.max(isFinite(dur) ? dur : 0, last + 1) };
}
const isTTML = (name, text) => /\.(ttml|xml)$/i.test(name || '') || /^\s*(<\?xml[^>]*>\s*)?<tt[\s>]/.test(text);

/* ================= word-level timing: fuzzy-align Whisper words to the LRC text ================= */
let whisperWords = null, alignStats = null, whisperName = '';
let lrcSong = null, lrcName = '', source = 'lrc';
let lrcRawText = '', audioFile = null, uploadedId = null, preferAlign = false;   // 'lrc' = LRC text (+ Whisper timing), 'whisper' = Whisper only

function parseWhisper(text){
  const data = JSON.parse(text);
  let items = [];
  const push = (w, s, e) => { if (w != null && isFinite(s)) items.push({ w: String(w), s: +s, e: isFinite(e) ? +e : +s }); };
  if (Array.isArray(data?.transcription)){
    // some whisper.cpp runs emit the same segment several times; keep the first copy of each
    const seen = new Set();
    data.transcription = data.transcription.filter(sg => {
      const k = (sg.offsets ? sg.offsets.from + '-' + sg.offsets.to : '') + '|' + (sg.text || '').trim();
      if (seen.has(k)) return false; seen.add(k); return true;
    }).sort((a, b) => (a.offsets ? a.offsets.from : 0) - (b.offsets ? b.offsets.from : 0));
    // whisper.cpp JSON (-oj / -ojf). Segment offsets are on the real timeline (ms). Token offsets may be on a
    // VAD-shortened timeline, so they are shifted to start at their segment. With --dtw, t_dtw (10 ms units) wins.
    data.transcription.forEach(sg => {
      const text = (sg.text || '').trim();
      if (!text || /^\[.*\]$|^\(.*\)$/.test(text)) return;          // [Music], (applause) …
      const segFrom = sg.offsets ? sg.offsets.from / 1000 : NaN, segTo = sg.offsets ? sg.offsets.to / 1000 : NaN;
      const toks = (sg.tokens || []).filter(t => t && typeof t.text === 'string' && !/^\[_/.test(t.text) && t.text.trim());
      if (!toks.length || !isFinite(segFrom)){ push(text, segFrom, segTo); return; }
      const base = toks[0].offsets ? toks[0].offsets.from / 1000 : 0;
      const at = t => {
        if (typeof t.t_dtw === 'number' && t.t_dtw >= 0) return t.t_dtw / 100;
        return segFrom + ((t.offsets ? t.offsets.from / 1000 : base) - base);
      };
      toks.forEach((t, i) => {
        const s0 = Math.min(at(t), segTo);
        let e0 = i + 1 < toks.length ? at(toks[i + 1]) : (t.offsets ? segFrom + (t.offsets.to / 1000 - base) : segTo);
        e0 = Math.min(Math.max(e0, s0 + 0.05), Math.max(segTo, s0 + 0.05));
        items.push({ w: t.text, s: s0, e: e0 });
      });
    });
  } else if (Array.isArray(data?.segments)){
    data.segments.forEach(sg => Array.isArray(sg.words) && sg.words.length
      ? sg.words.forEach(w => push(w.word ?? w.text, w.start, w.end))
      : push(sg.text, sg.start, sg.end));
  } else if (Array.isArray(data?.words)){
    data.words.forEach(w => push(w.word ?? w.text, w.start, w.end));
  } else {
    const arr = Array.isArray(data) ? data : Object.keys(data).sort((a, b) => (+a) - (+b)).map(k => data[k]);
    arr.forEach(o => {
      if (!o || typeof o !== 'object') return;
      const w = o.original_subtitle ?? o.word ?? o.text ?? o.content;
      if ('start_time' in o) push(w, o.start_time / 1000, o.end_time / 1000);     // milliseconds
      else push(w, o.start ?? o.begin, o.end);
    });
  }
  // segment-level entries holding several words: spread the words over the span
  const out = [];
  for (const it of items){
    const ws = it.w.trim().split(/\s+/).filter(Boolean);
    ws.forEach((w, i) => {
      const d = (it.e - it.s) / ws.length, s0 = it.s + d * i;
      if (CJK.test(w)){
        // Chinese: one token per character; punctuation is dropped but remembered for line breaks
        const punct = (w.match(/[，。、！？；：,.!?;:]+$/) || [''])[0];
        const chars = Array.from(w).filter(c => c.trim() && !CJK_PUNCT.test(c));
        chars.forEach((c, k) => out.push({ w: c, s: s0 + d * k / chars.length, e: s0 + d * (k + 1) / chars.length, cjk: true, p: k === chars.length - 1 ? punct : '' }));
      } else out.push({ w, s: s0, e: s0 + d });
    });
  }
  out.sort((a, b) => a.s - b.s);
  // Whisper often starts the first word of a phrase too early (it swallows the silence or intro before it).
  // When a phrase-opening word is far longer than a normal word, move its start up to just before its end.
  const durs = out.map(w => w.e - w.s).filter(d => d > 0.02).sort((a, b) => a - b);
  const med = durs.length ? durs[durs.length >> 1] : 0.3;
  const keep = Math.min(0.6, Math.max(0.25, med * 1.5));
  let fixedStarts = 0;
  out.forEach((w, i) => {
    const prev = out[i - 1];
    const opens = !prev || prev.p || /[,.!?;，。！？；、]$/.test(prev.w) || w.s - prev.e > 0.15;
    if (opens && w.e - w.s > Math.max(0.8, med * 3)){ w.s = w.e - keep; w.fixed = true; fixedStarts++; }
  });
  out.fixedStarts = fixedStarts;
  // mark runs of zero-length words: Whisper puts these where it lost track of timing
  for (let i = 0; i < out.length; i++){
    let j = i;
    while (j < out.length && out[j].e - out[j].s < 0.03 && Math.abs(out[j].s - out[i].s) < 0.05) j++;
    if (j - i >= 2) for (let k = i; k < j; k++) out[k].weak = true;
    if (j > i) i = j - 1;
  }
  return out;
}

function normWord(w){
  let s = w.toLowerCase().replace(/[‘’ʼ`]/g, "'").replace(/^[^a-z0-9*'\u3400-\u9fff\uf900-\ufaff]+|[^a-z0-9*'\u3400-\u9fff\uf900-\ufaff]+$/g, '');
  s = s.replace(/^'em$/, 'them').replace(/^'?cause$|^cuz$|^'cuz$/, 'cause').replace(/^'til$/, 'till');
  s = s.replace(/in'$/, 'ing');
  return s.replace(/[^a-z0-9*\u3400-\u9fff\uf900-\ufaff]/g, '');
}
function lev(a, b){
  if (a === b) return 0;
  const m = a.length, n = b.length; if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j), cur = new Array(n + 1);
  for (let i = 1; i <= m; i++){
    cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
function wordSim(a, b){
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes('*') || b.includes('*')){            // censored words: * stands for any letters
    const [pat, other] = a.includes('*') ? [a, b] : [b, a];
    if (/^\*+$/.test(pat)) return 0.62;
    const re = new RegExp('^' + pat.split(/\*+/).map(x => x.replace(/[^a-z0-9]/g, '')).join('[a-z0-9*]*') + '$');
    if (re.test(other)) return 0.92;
  }
  return 1 - lev(a, b) / Math.max(a.length, b.length);
}

function alignWords(lines, ww){
  // flatten the LRC English words (the LRC text always wins; Whisper only supplies timing)
  const A = [];
  lines.forEach((L, li) => {
    L.wt = null;
    const txt = L.en || L.zh;
    L.wtText = txt;
    if (!txt) return;
    late.tokens(txt).filter(x => x.trim()).forEach((w, k) => A.push({ li, k, w, n: normWord(w) }));
  });
  const B = ww.map(x => ({ ...x, n: normWord(x.w) }));
  const N = A.length, Mn = B.length;
  if (!N || !Mn) return null;
  const GAP = -0.35, W = Mn + 1;
  const S = new Float32Array((N + 1) * W), P = new Uint8Array((N + 1) * W);   // 1 diag, 2 up (skip lrc), 3 left (skip whisper)
  for (let i = 1; i <= N; i++){ S[i * W] = S[(i - 1) * W] + GAP; P[i * W] = 2; }
  for (let j = 1; j <= Mn; j++){ S[j] = S[j - 1] + GAP; P[j] = 3; }
  for (let i = 1; i <= N; i++){
    const a = A[i - 1], L = lines[a.li], lo = L.t - 2, hi = L.end + 2;
    for (let j = 1; j <= Mn; j++){
      let best = S[(i - 1) * W + j] + GAP, bp = 2;
      const left = S[i * W + j - 1] + GAP;
      if (left > best){ best = left; bp = 3; }
      const b = B[j - 1];
      const d = b.s < lo ? lo - b.s : b.s > hi ? b.s - hi : 0;
      if (d < 8){
        const sim = wordSim(a.n, b.n);
        if (sim >= 0.5){
          const sc = S[(i - 1) * W + j - 1] + (2 * sim - 0.5) - 0.18 * d - (b.weak ? 0.6 : 0);
          if (sc > best){ best = sc; bp = 1; }
        }
      }
      S[i * W + j] = best; P[i * W + j] = bp;
    }
  }
  const match = new Array(N).fill(-1);
  for (let i = N, j = Mn; i > 0 || j > 0;){
    const p = P[i * W + j];
    if (p === 1){ match[i - 1] = j - 1; i--; j--; } else if (p === 2) i--; else j--;
  }
  // weak (zero-length) matches only give an approximate start, never a hard anchor
  A.forEach((a, i) => { if (match[i] >= 0 && B[match[i]].weak) match[i] = -1; });
  return { A, B, match };
}

function buildWordTiming(song, ww){
  const lines = song.lines;
  const al = alignWords(lines, ww);
  if (!al) return null;
  const { A, B, match } = al;
  const byLine = lines.map(() => []);
  A.forEach((a, i) => byLine[a.li].push({ w: a.w, s: match[i] >= 0 ? B[match[i]].s : NaN, e: match[i] >= 0 ? B[match[i]].e : NaN, m: match[i] >= 0 }));

  // average pace from matched neighbours (start-to-start), used to fill the gaps
  const steps = [];
  byLine.forEach(ws => { for (let k = 1; k < ws.length; k++) if (ws[k].m && ws[k - 1].m) steps.push(ws[k].s - ws[k - 1].s); });
  steps.sort((x, y) => x - y);
  const pace = Math.min(0.45, Math.max(0.14, steps.length ? steps[steps.length >> 1] : 0.25));

  // line starts: from matched words where possible, otherwise LRC time + interpolated offset of neighbours
  const start = lines.map((L, li) => {
    const ws = byLine[li], k = ws.findIndex(w => w.m);
    return k < 0 ? NaN : ws[k].s - k * pace;
  });
  const anchored = lines.map((_, li) => isFinite(start[li]));
  const off = lines.map((L, li) => anchored[li] ? start[li] - L.t : NaN);
  for (let li = 0; li < lines.length; li++){
    if (anchored[li]) continue;
    let p = li - 1; while (p >= 0 && !anchored[p]) p--;
    let n = li + 1; while (n < lines.length && !anchored[n]) n++;
    let o = 0;
    if (p >= 0 && n < lines.length){
      const tp = lines[p].t, tn = lines[n].t, f = tn > tp ? (lines[li].t - tp) / (tn - tp) : 0.5;
      o = off[p] + (off[n] - off[p]) * f;
    } else if (p >= 0) o = off[p]; else if (n < lines.length) o = off[n];
    start[li] = lines[li].t + o;
  }
  // keep line starts in order
  for (let li = 1; li < lines.length; li++) if (start[li] < start[li - 1] + 0.05) start[li] = start[li - 1] + 0.05;

  let matched = 0, total = 0;
  lines.forEach((L, li) => {
    const ws = byLine[li];
    const S0 = start[li];
    const E0 = li + 1 < lines.length ? start[li + 1] : S0 + Math.max(2, ws.length * pace + 1);
    if (ws.length){
      total += ws.length; matched += ws.filter(w => w.m).length;
      // clamp matched anchors into the line window; drop any that land outside or out of order
      let last = S0 - 0.001;
      ws.forEach(w => { if (w.m && (w.s < last || w.s >= E0)) { w.m = false; matched--; } if (w.m) last = w.s; });
      const idx = ws.map((w, k) => w.m ? k : -1).filter(k => k >= 0);
      const weight = w => Math.max(1, normWord(w.w).length) + 2;
      const fill = (from, to, t0, t1) => {          // spread words [from,to) over [t0,t1) by length
        const tot = ws.slice(from, to).reduce((a, w) => a + weight(w), 0) || 1;
        let acc = 0;
        for (let k = from; k < to; k++){ ws[k].s = t0 + (t1 - t0) * acc / tot; acc += weight(ws[k]); }
      };
      if (!idx.length){
        const span = Math.min(ws.length * pace, (E0 - S0) * 0.9);
        fill(0, ws.length, S0, S0 + span);
      } else {
        if (idx[0] > 0) fill(0, idx[0], Math.max(S0, ws[idx[0]].s - idx[0] * pace * 1.5), ws[idx[0]].s);
        for (let q = 1; q < idx.length; q++) if (idx[q] - idx[q - 1] > 1) fill(idx[q - 1] + 1, idx[q], ws[idx[q - 1]].s + (ws[idx[q - 1]].e - ws[idx[q - 1]].s) * 0.5, ws[idx[q]].s);
        const lk = idx[idx.length - 1];
        if (lk < ws.length - 1){
          const t0 = Math.max(ws[lk].e, ws[lk].s + 0.1), need = (ws.length - 1 - lk) * pace;
          fill(lk + 1, ws.length, t0, Math.min(t0 + need, E0 - 0.05));
        }
      }
      // ends
      ws.forEach((w, k) => {
        const next = k + 1 < ws.length ? ws[k + 1].s : E0;
        if (!w.m || !isFinite(w.e) || w.e > next) w.e = Math.min(next, w.s + Math.max(pace, 0.12));
        if (k && w.s < ws[k - 1].s) w.s = ws[k - 1].s;
      });
      L.wt = ws;
    }
    L.t0 = L.t0 ?? L.t;
    L.t = ws.length ? ws[0].s : S0;
  });
  // global pass: word starts never go backwards across line boundaries
  let prev = -Infinity;
  lines.forEach(L => {
    if (L.wt){
      L.wt.forEach(w => { if (w.s < prev + 0.03){ w.s = prev + 0.03; if (w.e < w.s + 0.08) w.e = w.s + 0.08; } prev = w.s; });
      L.t = L.wt[0].s;
    } else { if (L.t < prev + 0.03) L.t = prev + 0.03; prev = L.t; }
  });
  lines.forEach((L, i) => L.end = lines[i + 1] ? lines[i + 1].t : (L.wt ? L.wt[L.wt.length - 1].e + 1.5 : L.t + 4));
  return { matched, total, pace };
}

/* Whisper-only: group recognised words into display lines */
function songFromWhisper(ww, title){
  const lines = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const wt = cur.map(w => ({ w: w.w.trim(), s: w.s, e: Math.max(w.e, w.s + 0.08), m: true }));
    let text = '';
    wt.forEach((w, i) => { const prev = wt[i - 1]; text += (i && !(CJK.test(prev.w) || CJK.test(w.w)) ? ' ' : '') + w.w; });
    const zhLine = CJK.test(text);
    lines.push({ t: wt[0].s, en: zhLine ? '' : text, zh: zhLine ? text : '', wt, wtText: text });
    cur = [];
  };
  ww.forEach((w, i) => {
    const txt = w.w.trim(); if (!txt) return;
    cur.push(w);
    const next = ww[i + 1];
    const gap = next ? next.s - w.e : Infinity;
    const tail = w.p != null ? w.p : txt;
    const endsSentence = /[.?!。？！]["')\]]*$/.test(tail);
    const endsClause = /[,;:，；：、]$/.test(tail);
    const n = cur.length, zh = !!w.cjk;
    if (gap > 0.9 || (endsSentence && n >= 2) || (endsSentence && gap > 0.25) ||
        (endsClause && n >= (zh ? 8 : 7)) || n >= (zh ? 16 : 12)) flush();
  });
  flush();
  // keep words in order and give every line an end
  let prev = -Infinity;
  lines.forEach(L => { L.wt.forEach(w => { if (w.s < prev + 0.02) w.s = prev + 0.02; prev = w.s; }); L.t = L.wt[0].s; });
  lines.forEach((L, i) => {
    const lastE = L.wt[L.wt.length - 1].e;
    L.end = lines[i + 1] ? lines[i + 1].t : lastE + 1.5;
  });
  const tail = lines.length ? lines[lines.length - 1].end : 0;
  return { meta: { ti: title }, lines, length: tail + 1, whisperOnly: true };
}

/* per-token start times for the text shown as the main line */
function lineTokenTimes(L, pri){
  if (!L.wt || !L.wt.length) return null;
  const n = late.tokens(pri).filter(x => x.trim()).length;
  if (pri === (L.wtText ?? L.en) && n === L.wt.length) return L.wt.map(w => w.s);
  // Chinese (or other) main line: spread its characters across the sung span
  const s0 = L.wt[0].s, s1 = Math.max(L.wt[L.wt.length - 1].s, s0 + 0.2);
  return Array.from({ length: n }, (_, k) => s0 + (n > 1 ? (s1 - s0) * k / (n - 1) : 0));
}

/* enhanced (word-level) LRC */
const ts = x => { x = Math.max(0, x); const m = Math.floor(x / 60), s = x - m * 60; return String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0'); };
function toWordLRC(song){
  const D = typeof late.lyricDelay === 'number' ? late.lyricDelay : 0;
  const T = x => ts(x + D);
  const out = [];
  ['ti', 'ar', 'al'].forEach(k => song.meta[k] && out.push(`[${k}:${song.meta[k]}]`));
  out.push(song.whisperOnly ? '[by:Whisper 识别 · 逐词]' : '[by:逐词对齐 · Whisper 时间 + LRC 文本]');
  song.lines.forEach(L0 => {
    for (const L of L0.bg ? [L0, L0.bg] : [L0]){          // background vocals follow their line, with their own times
      const main = L.wtText ?? (L.en || L.zh);
      const toks = main ? late.tokens(main) : [];
      if (L.wt && toks.filter(x => x.trim()).length === L.wt.length){
        let k = 0, line = '';
        for (const x of toks){ if (!x.trim()){ line += ' '; continue; } line += `<${T(L.wt[k].s)}>${x}`; k++; }
        out.push(`[${T(L.t)}]` + line + `<${T(L.wt[L.wt.length - 1].e)}>`);
      } else if (main) out.push(`[${T(L.t)}]${main}`);
      const other = main === L.en ? L.zh : '';
      if (other) out.push(`[${T(L.t)}]${other}`);
    }
  });
  return out.join('\n') + '\n';
}

const $ = id => document.getElementById(id);
const stage = $('stage');
let song = parseLRC(SAMPLE);
let mode = 'both';
try { mode = localStorage.getItem('lrc-mode') || 'both'; } catch(e){}
if (mode !== 'en') mode = 'both';             // the switch offers English and both; a saved 中文 (no longer offered) shows both
let audio = null, playing = false, base = 0, startPerf = 0, cur = null;

function setBase(v){ return base = v; }   // other modules cannot assign to an imported binding

function setStartPerf(v){ return startPerf = v; }   // other modules cannot assign to an imported binding

function assignPlaying(v){ return playing = v; }   // other modules cannot assign to an imported binding

function setCur(v){ return cur = v; }   // other modules cannot assign to an imported binding

function assignMode(v){ return mode = v; }   // other modules cannot assign to an imported binding

function setPreferAlign(v){ return preferAlign = v; }   // other modules cannot assign to an imported binding

function setUploadedId(v){ return uploadedId = v; }   // other modules cannot assign to an imported binding

function setWhisperWords(v){ return whisperWords = v; }   // other modules cannot assign to an imported binding

function setAlignStats(v){ return alignStats = v; }   // other modules cannot assign to an imported binding

function setLrcSong(v){ return lrcSong = v; }   // other modules cannot assign to an imported binding

function setLrcRawText(v){ return lrcRawText = v; }   // other modules cannot assign to an imported binding

function setLrcName(v){ return lrcName = v; }   // other modules cannot assign to an imported binding

function setWhisperName(v){ return whisperName = v; }   // other modules cannot assign to an imported binding

function setAudio(v){ return audio = v; }   // other modules cannot assign to an imported binding

function setSource(v){ return source = v; }   // other modules cannot assign to an imported binding

function setSong(v){ return song = v; }   // other modules cannot assign to an imported binding

function setAudioFile(v){ return audioFile = v; }   // other modules cannot assign to an imported binding
