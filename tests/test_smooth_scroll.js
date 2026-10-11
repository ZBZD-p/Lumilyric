// The easing of wheel scrolling (web/js/render/smooth-scroll.js). Run: node tests/test_smooth_scroll.js
const { moduleSource, LATE_STUB } = require('./module-source');
const src = LATE_STUB + moduleSource('render/smooth-scroll.js');
const { glideStep, SCROLL_TAU } = new Function(src + '\nreturn { glideStep, SCROLL_TAU };')();
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '   ' + extra : '')); };
const run = (fps, secs) => { let p = 0; const path = []; for (let i = 0; i < Math.round(secs * fps); i++){ p = glideStep(p, 120, 1 / fps, SCROLL_TAU); path.push(p); } return path; };
const at = (fps, secs) => run(fps, secs).pop();
check('the same place after 0.1 s at 30, 60 and 300 fps', Math.abs(at(60, 0.1) - at(300, 0.1)) < 0.01 && Math.abs(at(60, 0.1) - at(30, 0.1)) < 0.01, [30, 60, 300].map(f => at(f, 0.1).toFixed(2)).join(' / '));
const p = run(60, 1);
check('never goes back, never past the end', p.every((v, i) => v <= 120 && (i === 0 || v >= p[i - 1])));
check('slows down: every step shorter than the one before', p.slice(0, 20).every((v, i) => i < 2 || v - p[i - 1] < p[i - 1] - p[i - 2]));
check('starts at once: a fifth of the way within 2 frames', p[1] > 24, p[1].toFixed(1) + ' of 120 px');
check('there within one pixel in 0.6 s', 120 - at(60, 0.6) < 1, (120 - at(60, 0.6)).toFixed(2) + ' px left');
check('already at the target: stays', glideStep(50, 50, 0.016, SCROLL_TAU) === 50);
console.log(fails ? '\n' + fails + ' problems' : '\nall passed');
process.exit(fails ? 1 : 0);
