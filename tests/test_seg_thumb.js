// The springs of the switch thumb (web/js/glass/seg-thumb.js). Run: node tests/test_seg_thumb.js
const { moduleSource, LATE_STUB } = require('./module-source');
const src = LATE_STUB + moduleSource('glass/seg-thumb.js');
const { springStep, thumbShape, SEG_SPRING } = new Function(src + '\nreturn { springStep, thumbShape, SEG_SPRING };')();
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '   ' + extra : '')); };

/* run a spring from 0 to 1 at a frame rate, in the 4 ms sub-steps the page uses */
function run([k, c], fps, secs = 2){
  const s = { x: 0, v: 0 }; let peak = 0, settled = null, n = Math.round(secs * fps);
  for (let i = 0; i < n; i++){
    for (let dt = 1 / fps; dt > 1e-9; dt -= 0.004) springStep(s, 1, k, c, Math.min(0.004, dt));
    peak = Math.max(peak, s.x);
    if (Math.abs(s.x - 1) > 0.01) settled = null; else if (settled === null) settled = (i + 1) / fps;
  }
  return { peak, settled, end: s.x };
}
for (const name of Object.keys(SEG_SPRING)){
  const a = run(SEG_SPRING[name], 60), b = run(SEG_SPRING[name], 300), c = run(SEG_SPRING[name], 24);
  check(`${name}: arrives and stays (60 fps)`, a.settled !== null && a.settled < 0.9 && Math.abs(a.end - 1) < 1e-3, `settled after ${a.settled} s, peak ${a.peak.toFixed(3)}`);
  check(`${name}: the same motion at 24, 60 and 300 fps`, Math.abs(a.peak - b.peak) < 0.02 && Math.abs(a.peak - c.peak) < 0.03, `peaks ${c.peak.toFixed(3)} / ${a.peak.toFixed(3)} / ${b.peak.toFixed(3)}`);
}
const press = run(SEG_SPRING.press, 60), follow = run(SEG_SPRING.follow, 60);
check('pressing bounces: the lift overshoots by 15 to 40 %', press.peak > 1.15 && press.peak < 1.4, 'peak ' + press.peak.toFixed(3));
check('following the finger barely overshoots', follow.peak < 1.06, 'peak ' + follow.peak.toFixed(3));

const g = { w: 60, h: 30 };
const rest = thumbShape(g, 38, 0, 0, true), up = thumbShape(g, 38, 1, 0, true), fast = thumbShape(g, 38, 1, 1500, true), flat = thumbShape(g, 38, 1, 0, false);
check('at rest the thumb is exactly the segment', rest.w === 60 && rest.h === 30);
check('lifted glass is taller than the switch and a little wider', up.h > 38 && up.h < 38 * 1.6 && up.w > 60 && up.w < 80, `${up.w.toFixed(1)} x ${up.h.toFixed(1)}`);
check('moving fast: wider and flatter', fast.w > up.w * 1.1 && fast.h < up.h * 0.95, `${fast.w.toFixed(1)} x ${fast.h.toFixed(1)}`);
check('the stretch has a limit', thumbShape(g, 38, 1, 1e6, true).w <= up.w * 1.3 + 1e-9 && thumbShape(g, 38, 1, 1e6, true).h > 20);
check('same shape moving left or right', thumbShape(g, 38, 1, -1500, true).w === fast.w);
check('plain interface: only grows a little', flat.h < 38 && flat.h > 30 && flat.w < 64);
console.log(fails ? '\n' + fails + ' problems' : '\nall passed');
process.exit(fails ? 1 : 0);
