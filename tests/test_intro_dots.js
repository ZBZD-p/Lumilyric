// The dots before the first line (web/js/render/intro-dots.js). Run: node tests/test_intro_dots.js
const { moduleSource } = require('./module-source');
const { DOTS, introDots } = new Function(moduleSource('render/intro-dots.js') + '\nreturn { DOTS, introDots };')();

let fails = 0;
const check = (name, problems) => {
  console.log((problems.length ? 'FAIL ' : 'ok   ') + name);
  problems.slice(0, 6).forEach(p => { fails++; console.log('       ' + p); });
};
const frames = (t1, f) => { for (let i = 0; i <= (t1 + 1) * 120; i++) f(i / 120); };

check('a short intro has no dots', [3.9, 2, 0.5].flatMap(t1 => {
  const p = []; frames(t1, t => { if (introDots(t, t1)) p.push('dots at ' + t.toFixed(2) + ' s of an intro of ' + t1 + ' s'); }); return p.slice(0, 1);
}));

for (const t1 of [4, 6.5, 16.4, 45, 121.3]){
  const p = [], end = t1 - DOTS.out, B = DOTS.breath;
  let before = null, litAt = [null, null, null];
  frames(t1, t => {
    const d = introDots(t, t1), at = ' at ' + t.toFixed(3) + ' s';
    if (!d){
      if (t > 0.01 && t < end + DOTS.gone - 0.01) p.push('no dots' + at);
      if (before && before.alpha > 0.15) p.push('they vanished at once' + at);
      before = null; return;
    }
    if (t >= end + DOTS.gone) p.push('still there after they should have gone' + at);
    if (!(d.alpha >= 0 && d.alpha <= 1) || d.dots.some(a => !(a >= DOTS.dim - 1e-9 && a <= 1))) p.push('opacity out of range' + at);
    if (d.scale < 1 - DOTS.shrink - 1e-9 || d.scale > 1 + B.by + 1e-9) p.push('size out of range' + at);
    if (d.dots[0] < d.dots[1] - 1e-9 || d.dots[1] < d.dots[2] - 1e-9) p.push('not lit from the left' + at);
    d.dots.forEach((a, k) => { if (a >= 0.999 && litAt[k] == null) litAt[k] = t; });
    if (before){
      // nothing jumps from one frame to the next (the fastest thing is going away, 0.2 s)
      if (Math.abs(d.alpha - before.alpha) > 0.08) p.push('opacity jumped' + at);
      if (Math.abs(d.scale - before.scale) > 0.03) p.push('size jumped' + at);
      d.dots.forEach((a, k) => { if (a < before.dots[k] - 1e-9) p.push('dot ' + k + ' got dimmer' + at); else if (a - before.dots[k] > 0.05 && t1 >= 6) p.push('dot ' + k + ' jumped' + at); });
    }
    // at the end: all lit, at their biggest, then smaller and fainter
    if (t > end - 0.5 && t < end){
      if (d.dots.some(a => a < 0.999)) p.push('not all lit just before the end' + at);
      if (Math.abs(d.scale - (1 + B.by)) > 1e-9) p.push('not at their biggest just before the end' + at);
      if (d.alpha < 0.999) p.push('faint just before the end' + at);
    }
    if (t > end && before && (d.alpha > before.alpha + 1e-9 || d.scale > before.scale + 1e-9)) p.push('not going away' + at);
    before = d;
  });
  if (litAt.some(v => v == null) || !(litAt[0] < litAt[1] && litAt[1] < litAt[2])) p.push('lit at ' + JSON.stringify(litAt));
  check('an intro of ' + t1 + ' s', p);
}

// the breaths: counted back from the end, one every `period` seconds, whatever the length of the intro
{
  const p = [], t1 = 40, end = t1 - DOTS.out, B = DOTS.breath, top = end - B.last;
  const sc = t => introDots(t, t1).scale;
  for (let n = 0; n < 5; n++){
    const a = top - n * B.period;
    if (Math.abs(sc(a) - (1 + B.by)) > 1e-6) p.push('not at the top at ' + a.toFixed(2));
    if (Math.abs(sc(a - B.up) - 1) > 1e-6) p.push('not at the bottom at ' + (a - B.up).toFixed(2));
    if (!(sc(a - B.up / 2) > 1.02 && sc(a - B.up / 2) < 1 + B.by - 0.02)) p.push('not on the way up at ' + (a - B.up / 2).toFixed(2));
  }
  check('breathing', p);
}

console.log(fails ? '\n' + fails + ' problems' : '\nall passed');
process.exit(fails ? 1 : 0);
