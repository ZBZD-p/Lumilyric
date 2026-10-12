// The interruptible glide (web/js/core/glide.js). Run: node tests/test_glide.js
const { moduleSource } = require('./module-source');
const { glideAt, glideKick } = new Function(moduleSource('core/glide.js') + '\nreturn { glideAt, glideKick };')();
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '   ' + extra : '')); };
const W = 6.5, WAIT = 0.2;
const x = (g, ms) => { const a = glideAt(g, ms); return a ? a.x : 0; };

const g = glideKick(null, 300, 0, WAIT, W);
check('it starts where the thing was', x(g, 0) === 300);
check('it stays put while it waits', x(g, 100) === 300 && x(g, 199) === 300);
const path = []; for (let ms = 200; ms <= 1400; ms += 50) path.push(x(g, ms));
check('then it only ever gets nearer: no overshoot, no going back', path.every((v, i) => v >= 0 && (!i || v <= path[i - 1])), path.map(v => v.toFixed(0)).join(' '));
check('off gently: little in the first 50 ms, much more in the next 150', 300 - x(g, 250) < 15 && x(g, 250) - x(g, 400) > 60, `${x(g, 250).toFixed(1)} ${x(g, 400).toFixed(1)}`);
check('as good as there a second after it set off, and then it is over', x(g, 1200) < 4 && glideAt(g, 3000) === null, x(g, 1200).toFixed(2));

/* switched back while under way: the place moves by -300 */
const mid = glideAt(g, 500), g2 = glideKick(g, -300, 500, WAIT, W);
check('interrupted: it carries on from where it is', Math.abs(x(g2, 500) - (mid.x - 300)) < 1e-9);
check('at the speed it had', Math.abs(glideAt(g2, 500).v - mid.v) < 1e-9 && mid.v < 0);
check('without waiting again', g2.wait === 0 && x(g2, 510) !== x(g2, 500));
const back = []; for (let ms = 500; ms <= 2000; ms += 50) back.push(x(g2, ms));
check('and comes to rest at the new place', Math.abs(back[back.length - 1]) < 1 && glideAt(g2, 4000) === null);
check('never further out than the two places are apart', back.every(v => Math.abs(v) <= 300), 'most ' + Math.max(...back.map(Math.abs)).toFixed(1));
const steps = back.slice(1).map((v, i) => Math.abs(v - back[i]));
check('no jump anywhere on the way', Math.max(...steps) < 60, 'largest step in 50 ms: ' + Math.max(...steps).toFixed(1));

/* many quick switches (every 80 ms), there and back */
let q = null, at = 0, far = 0, jump = 0, last = 0;
for (let i = 0; i < 12; i++){
  const before = x(q, at);
  q = glideKick(q, i % 2 ? -300 : 300, at, WAIT, W);
  jump = Math.max(jump, Math.abs(x(q, at) - (before + (i % 2 ? -300 : 300))));
  for (let ms = at; ms < at + 80; ms += 16){ far = Math.max(far, Math.abs(x(q, ms))); last = x(q, ms); }
  at += 80;
}
check('quick switching: the drawn place never jumps', jump < 1e-9);
check('quick switching: it stays between the two places', far <= 300 + 1e-9, 'furthest ' + far.toFixed(1));
check('and settles when the switching stops', Math.abs(x(q, at + 1500)) < 1 && glideAt(q, at + 4000) === null);

/* switched back before it has set off */
const w1 = glideKick(null, 300, 0, WAIT, W), w2 = glideKick(w1, -300, 100, WAIT, W);
check('switched back while still waiting: nothing happens at all', glideAt(w2, 100) === null && glideAt(w2, 500) === null);
const w3 = glideKick(w1, 50, 100, WAIT, W);
check('a glide still waiting keeps what is left of its wait', Math.abs(w3.wait - 0.1) < 1e-9 && x(w3, 190) === 350);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
