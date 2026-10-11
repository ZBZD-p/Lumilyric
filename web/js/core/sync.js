import { $ } from './lyrics.js';
import { lyricDelay } from './settings.js';
import { fmtDelay, setDelay } from '../export/export.js';

/* Offset input */
/* typed offsets: "1.5", "-12", "+0.35", "1:05.2", "-0:30", full-width digits and "−" also work */
function parseDelay(txt){
  let t = String(txt).normalize('NFKC').replace(/[−–—]/g, '-').replace(/[s秒\s]/gi, '');
  if (!t) return 0;
  let sign = 1;
  if (/^[+-]/.test(t)){ if (t[0] === '-') sign = -1; t = t.slice(1); }
  if (!/^\d*(\.\d*)?(:\d*(\.\d*)?)?$/.test(t)) return NaN;
  const v = t.split(':').reduce((a, x) => a * 60 + (parseFloat(x) || 0), 0);
  return sign * v;
}
const nv = $('nudgeVal');
nv.addEventListener('focus', () => nv.select());
nv.addEventListener('keydown', e => {
  if (e.key === 'Enter'){ e.preventDefault(); nv.blur(); }
  else if (e.key === 'Escape'){ e.preventDefault(); nv.value = fmtDelay(lyricDelay); nv.blur(); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown'){
    e.preventDefault();
    const step = (e.shiftKey ? 0.01 : 0.05) * (e.key === 'ArrowUp' ? 1 : -1);
    const cur0 = parseDelay(nv.value);
    setDelay((isFinite(cur0) ? cur0 : lyricDelay) + step); nv.value = fmtDelay(lyricDelay); nv.select();
  }
});
nv.addEventListener('blur', () => {
  const v = parseDelay(nv.value);
  if (isFinite(v)) setDelay(v);
  nv.value = fmtDelay(lyricDelay);
  if (!isFinite(v)) $('status').textContent = '偏移只能填数字，比如 1.5、-12、或 1:05.2';
});
$('nudgeMinus').onclick = e => setDelay(lyricDelay - (e.shiftKey ? 0.01 : 0.05));
$('nudgePlus').onclick = e => setDelay(lyricDelay + (e.shiftKey ? 0.01 : 0.05));
$('nudgeZero').onclick = () => setDelay(0);
setDelay(lyricDelay);
