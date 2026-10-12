import { late } from '../core/late.js';
import { CHARWISE, CJK } from '../core/core.js';
import { $, cur, lineTokenTimes, mode, setCur, song, stage } from '../core/lyrics.js';
import { exitSpec, findIdx, fx, karaokeTimes, lt, now } from '../core/settings.js';

export {
  chunkText,
  greedy,
  joinU,
  lineTexts,
  oneLine,
  render,
  segCache,
  segmentsFor,
  setOneLine,
  tokens,
  units,
  updateSweepDOM,
  zhSeg,
};

/* Single-line layout: line splitting and the web (DOM) view */
/* ---------- single-line mode: split long lines into timed segments ---------- */
let oneLine = true;
try { oneLine = localStorage.getItem('lrc-one') !== '0'; } catch(e){}
const meas = document.createElement('div');
meas.className = 'line measure'; meas.setAttribute('aria-hidden', 'true');
meas.innerHTML = '<div class="pri"></div><div class="sub"></div>';
stage.appendChild(meas);
const segCache = new Map();

function textWidth(text, isSub){
  meas.classList.toggle('zh', !isSub && CJK.test(text));
  const el = meas.querySelector(isSub ? '.sub' : '.pri');
  el.textContent = text;
  return el.getBoundingClientRect().width;
}
const DOM_M = { w: textWidth, avail: () => stage.clientWidth * 0.96 };
const joinU = us => us.map((u, i) => (i && u.sp ? ' ' : '') + u.s).join('');

function units(text, isSub, M){
  const out = [];
  text.trim().split(/\s+/).forEach((w, i) => {
    // a phrase too wide on its own (long Chinese run) is broken into characters
    if (CHARWISE.test(w) && M.w(w, isSub) > M.avail()){
      Array.from(w).forEach((c, j) => out.push({ s: c, sp: j === 0 && i > 0 }));
    } else out.push({ s: w, sp: i > 0 });
  });
  return out;
}
function greedy(us, isSub, M){
  const parts = []; let curr = [];
  for (const u of us){
    const tryU = curr.concat({ ...u, sp: curr.length ? u.sp : false });
    if (curr.length && M.w(joinU(tryU), isSub) > M.avail()){ parts.push(curr); curr = [{ ...u, sp: false }]; }
    else curr = tryU;
  }
  if (curr.length) parts.push(curr);
  return parts;
}
function splitEven(us, k){
  const lens = us.map(u => u.s.length + (u.sp ? 1 : 0));
  const tot = lens.reduce((a, b) => a + b, 0);
  const parts = []; let curr = [], acc = 0;
  us.forEach((u, idx) => {
    const target = tot * (parts.length + 1) / k;
    const left = us.length - idx;
    const need = k - parts.length - 1;
    if (curr.length && parts.length < k - 1 && (acc + lens[idx] / 2 > target || left <= need)){
      parts.push(curr); curr = [];
    }
    curr.push({ ...u, sp: curr.length ? u.sp : false });
    acc += lens[idx];
  });
  if (curr.length) parts.push(curr);
  return parts;
}
const zhSeg = (() => { try { return new Intl.Segmenter('zh', { granularity: 'word' }); } catch(e){ return null; } })();
function finerUnits(us){
  const out = [];
  for (const u of us){
    if (!CJK.test(u.s)){ out.push(u); continue; }
    const words = zhSeg ? [...zhSeg.segment(u.s)] : Array.from(u.s).map(c => ({ segment: c, isWordLike: /\p{L}|\p{N}/u.test(c) }));
    let first = true;
    for (const w of words){
      if (!w.isWordLike && out.length && !first){ out[out.length - 1] = { ...out[out.length - 1], s: out[out.length - 1].s + w.segment }; continue; }
      out.push({ s: w.segment, sp: first ? u.sp : false }); first = false;
    }
  }
  return out;
}
function chunkText(text, isSub, kMin, M = DOM_M){
  if (!text) return [];
  if (M.w(text, isSub) <= M.avail() && kMin <= 1) return [text];
  let us = units(text, isSub, M);
  // asked for more parts than there are pieces (a Chinese translation with no spaces, to go with an English line
  // that was split in two): break the Chinese into words, punctuation staying with the word before it
  if (us.length < kMin) us = finerUnits(us);
  if (us.length < kMin) us = us.flatMap(u => CJK.test(u.s) ? (u.s.match(/.[\p{P}\s]*/gu) || [u.s]).map((c, j) => ({ s: c, sp: j ? false : u.sp })) : [u]);   // still too few: single characters (punctuation stays attached)
  const g = greedy(us, isSub, M);
  if (us.length > 1 && us.length <= kMin) return splitEven(us, us.length).map(joinU);
  for (let k = Math.max(kMin, g.length); k <= Math.min(us.length, g.length + 3); k++){
    const parts = splitEven(us, k);
    if (parts.every(p => M.w(joinU(p), isSub) <= M.avail())) return parts.map(joinU);
  }
  return g.map(joinU);
}

function lineTexts(L){
  const pri = mode === 'zh' ? (L.zh || L.en) : (L.en || L.zh);
  const sub = mode === 'both' && L.en && L.zh ? L.zh : '';
  return { pri, sub };
}
function segmentsFor(i, M = DOM_M, cache = segCache){
  const L = song.lines[i];
  const { pri, sub } = lineTexts(L);
  const key = i + '|' + mode + '|' + oneLine;
  if (cache.has(key)) return cache.get(key);
  const times = lineTokenTimes(L, pri);
  const withTail = segs => {          // hide the line during long instrumental breaks
    if (L.wt){
      const lastE = L.wt[L.wt.length - 1].e;
      if (L.end - lastE > 6) segs.push({ blank: true, pri: '', sub: '', t: lastE + 2.5, end: L.end });
    }
    cache.set(key, segs);
    return segs;
  };
  // where the line's last word ends, when the times are the lyrics' own (one per word): karaokeTimes, hold
  const we = L.wt && times && times.length === L.wt.length ? L.wt[L.wt.length - 1].e : undefined;
  if (!oneLine) return withTail([{ pri, sub, t: L.t, end: L.end, times, we }]);
  let pp = chunkText(pri, false, 1, M), ss = chunkText(sub, true, 1, M);
  const k = Math.max(pp.length, ss.length);
  if (pp.length < k) pp = chunkText(pri, false, k, M);
  if (ss.length && ss.length < k) ss = chunkText(sub, true, k, M);
  if (ss.length > pp.length) ss = ss.slice(0, pp.length - 1).concat(ss.slice(pp.length - 1).join(' '));
  const cnt = pp.map(p => tokens(p).filter(x => x.trim()).length);
  if (times && cnt.reduce((a, b) => a + b, 0) === times.length){
    let o = 0;
    const segs = pp.map((p, j) => { const tt = times.slice(o, o + cnt[j]); o += cnt[j]; return { pri: p, sub: ss[j] || '', t: tt[0], times: tt }; });
    segs.forEach((g, j) => g.end = segs[j + 1] ? segs[j + 1].t : L.end);
    segs[segs.length - 1].we = we;
    return withTail(segs);
  }
  const lens = pp.map(p => p.length), tot = lens.reduce((a, b) => a + b, 0) || 1;
  const dur = L.end - L.t; let acc = 0;
  const segs = pp.map((p, j) => {
    const s = { pri: p, sub: ss[j] || '', t: L.t + dur * acc / tot };
    acc += lens[j]; s.end = L.t + dur * acc / tot;
    return s;
  });
  return withTail(segs);
}

function tokens(text){
  if (CHARWISE.test(text)) return Array.from(text);
  return text.split(/(\s+)/).filter(Boolean);
}

function showSeg(seg, t){
  const old = stage.querySelectorAll('.line.live');
  const X = exitSpec();
  old.forEach(o => {
    o.classList.remove('live');
    if (!X.line){                        // word by word: each word gets its own start
      const ws = o.querySelectorAll('.pri .w'), st = ws.length > 1 ? X.S / (ws.length - 1) : 0;
      ws.forEach((w, k) => w.style.animationDelay = (k * st).toFixed(3) + 's');
      o.classList.add('xword');
    }
    o.classList.add('out');
    setTimeout(() => o.remove(), (X.D + X.S) * 1000 + 120);
  });

  if (seg && seg.blank) return;
  let pri, sub, dur, elapsed;
  const el = document.createElement('div');
  el.className = 'line live' + (oneLine ? ' one' : '');
  if (!seg){
    el.classList.add('title');
    pri = song.meta.ti || '准备就绪';
    sub = song.meta.ar || '';
    elapsed = 0; dur = 1.2;
  } else {
    ({ pri, sub } = seg);
    dur = Math.max(0.3, seg.end - seg.t);
    elapsed = t - seg.t;
  }
  if (CJK.test(pri)) el.classList.add('zh');

  const p = document.createElement('div'); p.className = 'pri';
  const tk = tokens(pri);
  const n = tk.filter(x => x.trim()).length;
  const kar = fx.anim === 'karaoke' && seg ? karaokeTimes(seg, n) : null;
  if (fx.anim === 'karaoke') p.style.animationDelay = (-elapsed).toFixed(3) + 's';
  const spread = Math.min(dur * 0.7, n * 0.24);
  const step = n > 1 ? spread / (n - 1) : 0;
  let k = 0;
  for (const x of tk){
    if (!x.trim()){ p.appendChild(document.createTextNode(' ')); continue; }
    const s = document.createElement('span'); s.className = 'w'; s.textContent = x;
    if (fx.anim === 'karaoke'){
      s.textContent = '';
      const lit = (box, text) => {
        const kb = document.createElement('span'); kb.className = 'kb'; kb.textContent = text;
        const kg = document.createElement('span'); kg.className = 'kg'; kg.textContent = text; kg.setAttribute('aria-hidden', 'true');
        box.append(kg, kb);
      };
      const d = kar ? kar.st[k] - t : -9, du = kar ? kar.du[k] : 0.01; k++;   // the title card is shown fully lit
      if (kar && k === n && late.holdStrength(kar)){
        // a long last word: a little more light around it while it is sung (holdGlow, text-canvas.js)
        const kh = document.createElement('span'); kh.className = 'kh'; kh.textContent = x; kh.setAttribute('aria-hidden', 'true');
        kh.style.setProperty('--hg', late.holdStrength(kar).toFixed(3)); kh.style.setProperty('--hd', kar.hold.toFixed(3) + 's'); kh.style.setProperty('--hdl', d.toFixed(3) + 's');
        s.appendChild(kh);
      }
      if (kar && late.liftSplit(x, du)){
        // the letters rise one by one (liftWord, text-canvas.js): each is a box of its own, timed in measureSweep
        const cs = Array.from(x), km = kernMargins(cs);
        cs.forEach((c, i) => {
          const b = document.createElement('span'); b.className = 'c'; lit(b, c);
          if (Math.abs(km[i]) > 0.01) b.style.marginLeft = km[i].toFixed(2) + 'px';
          s.appendChild(b);
        });
        s.classList.add('ws'); s._kt = [d, du];
      } else {
        lit(s, x);
        s.style.setProperty('--kdl', d.toFixed(3) + 's'); s.style.setProperty('--kd', du.toFixed(3) + 's'); s.style.setProperty('--kld', late.liftDur(du).toFixed(3) + 's');
      }
      p.appendChild(s); continue;
    }
    const d = seg && seg.times ? seg.times[k] - t : k * step - elapsed; k++;
    s.style.animationDelay = d.toFixed(3) + 's';
    p.appendChild(s);
  }
  el.appendChild(p);
  if (sub){
    const s = document.createElement('div'); s.className = 'sub'; s.textContent = sub;
    s.style.animationDelay = ((seg && seg.times ? 0.15 : Math.min(spread * 0.5, 0.5) + 0.1) - elapsed).toFixed(3) + 's';
    el.appendChild(s);
  }
  stage.appendChild(el);
  if (kar){ p._kar = kar; measureSweep(p); }
}
/* letters that are boxes of their own lose the kerning between them: it is put back as a margin before each letter */
function kernMargins(cs){
  let pre = '', end = 0;
  return cs.map(c => { pre += c; const wc = textWidth(c, false), x = textWidth(pre, false) - wc, m = x - end; end = x + wc; return m; });
}
/* DOM karaoke: measure where each word sits along the line (rows joined end to end), once per layout; a word whose
   letters rise one by one gives each letter its place in the sweep and its own times */
function measureSweep(p){
  const ws = [...p.querySelectorAll('.w')];
  const E = late.SWEEP.edge * parseFloat(getComputedStyle(p).fontSize);
  const offs = [], wd = []; let base = 0, rowTop = null, rowRight = 0;
  for (const w of ws){
    if (rowTop !== null && Math.abs(w.offsetTop - rowTop) > 2){ base += rowRight; rowRight = 0; }
    if (rowTop === null || Math.abs(w.offsetTop - rowTop) > 2){ rowTop = w.offsetTop; p._rowL = w.offsetLeft; }
    const o = base + w.offsetLeft - p._rowL;
    offs.push(o); wd.push(w.offsetWidth); rowRight = w.offsetLeft - p._rowL + w.offsetWidth;
    w.style.setProperty('--o', o.toFixed(1) + 'px');
    if (!w._kt) continue;
    const [d, du] = w._kt, span = w.offsetWidth + E / 2;
    for (const c of w.querySelectorAll('.c')){
      const x0 = c.offsetLeft, x1 = x0 + c.offsetWidth, [t0, ld] = late.letterLift(d, du, x0, x1, span);
      c.style.setProperty('--o', (o + x0).toFixed(1) + 'px');
      c.style.setProperty('--kdl', t0.toFixed(3) + 's'); c.style.setProperty('--kd', Math.max(0.01, du * (x1 - x0) / span).toFixed(3) + 's'); c.style.setProperty('--kld', ld.toFixed(3) + 's');
    }
  }
  p._sw = { offs, ws: wd, E };
}
function updateSweepDOM(){
  if (fx.anim !== 'karaoke') return;
  const t = lt(now());
  stage.querySelectorAll('.line .pri').forEach(p => {
    if (!p._kar || !p._sw) return;
    const c = late.sweepPos(p._kar, p._sw.offs, p._sw.ws, p._sw.E, t);
    if (p._c !== c){ p._c = c; p.style.setProperty('--c', c.toFixed(1) + 'px'); }
  });
}
addEventListener('resize', () => stage.querySelectorAll('.line .pri').forEach(p => p._kar && measureSweep(p)));
if (document.fonts) document.fonts.addEventListener('loadingdone', () => stage.querySelectorAll('.line .pri').forEach(p => p._kar && measureSweep(p)));

function render(force){
  const t = lt(now());
  const i = findIdx(t);
  let seg = null, s = 0;
  if (i >= 0){
    const segs = segmentsFor(i);
    segs.forEach((g, j) => { if (g.t <= t + 0.02) s = j; });
    seg = segs[s];
  }
  const key = i + ':' + s;
  if (force || key !== cur){ setCur(key); showSeg(seg, t); }
}

function setOneLine(v){
  oneLine = v;
  try { localStorage.setItem('lrc-one', v ? '1' : '0'); } catch(e){}
  $('oneLine').checked = v;
  segCache.clear(); render(true);
}

/* names that modules loaded before this one call or read (core/late.js) */
Object.assign(late, { tokens, render });
