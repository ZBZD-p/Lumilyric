// The karaoke lift, letter by letter, and the glow of a long last word (web/js/render/text-canvas.js). Run: node tests/test_letter_lift.js
const { moduleSource, LATE_STUB } = require('./module-source');
const src = LATE_STUB + 'const fx = { glow: { on: true } };\n' + moduleSource('render/text-canvas.js');
const { liftWord, liftSplit, letterLift, liftDur, holdGlow, HOLD, fx } = new Function(src + '\nreturn { liftWord, liftSplit, letterLift, liftDur, holdGlow, HOLD, fx };')();
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '   ' + extra : '')); };

check('English, numbers and words with punctuation are split when sung slowly', ['Headlights', "I'm", 'don’t', 'café', '123', 'hi!', 'Привет'].every(s => liftSplit(s, 1)));
check('one letter, joined or stacked scripts and emoji stay whole', !['a', 'مرحبا', 'café', '한국어', '👍'].some(s => liftSplit(s, 1)));
check('a word that is over quickly stays whole', !liftSplit('Headlights', 0.3) && liftSplit('Headlights', 0.5));

/* what liftWord asks to be painted; every letter is 10 px wide */
function run(s, t, st = 1, du = 1, whole){
  const M = { fs: 20, w: text => text.length * 10 }, tk = { s, k: 0, w: s.length * 10 }, parts = [];
  const moving = liftWord(tk, M, { st: [st], du: [du] }, t, 0, (l, text, dx, w) => parts.push({ l, text, dx, w }), whole);
  return { parts, moving, ls: parts.map(p => +p.l.toFixed(3)) };
}
const before = run('abcde', 0.9), early = run('abcde', 1.3), late = run('abcde', 2.2), done = run('abcde', 2.6);
check('a slow word is painted letter by letter, each where it stands in the word',
  early.parts.map(p => p.text).join('') === 'abcde' && early.parts.every((p, i) => p.dx === i * 10 && p.w === 10));
check('and that way the whole time: before it rises, and after', before.parts.length === 5 && done.parts.length === 5);
check('before the word every letter is on the line; long after, every letter is fully up',
  before.ls.every(l => l === 0) && !before.moving && done.ls.every(l => l === 1) && !done.moving);
check('as the word starts only its first letters rise, the rest wait',
  early.moving && early.ls[0] > early.ls[1] && early.ls[1] > 0 && early.ls[2] === 0 && early.ls[4] === 0, early.ls.join(' '));
check('near the end the first letters are up and the last still rise',
  late.moving && late.ls[0] === 1 && late.ls[4] < 1 && late.ls[4] > 0 && late.ls.every((l, i) => !i || l <= late.ls[i - 1]), late.ls.join(' '));
const one = run('مرحبا', 1.3);
check('a word that is not split is painted in one piece and rises whole, as before',
  one.parts.length === 1 && one.parts[0].text === 'مرحبا' && one.parts[0].dx === 0 && one.parts[0].w === 50 && one.ls[0] > 0 && one.ls[0] < 1 && one.moving);
const forced = run('abcde', 1.3, 1, 1, true);
check('a slow word can be kept in one piece (while it is blurred)', forced.parts.length === 1 && forced.parts[0].text === 'abcde');

const [t0, d0] = letterLift(1, 1, 0, 10, 50), [t4, d4] = letterLift(1, 1, 40, 50, 50);
check('the first letter starts with the word, the last when the sweep reaches it', t0 === 1 && Math.abs(t4 - 1.8) < 1e-9);
check('a letter takes the shortest lift time, like a short word', d0 === liftDur(0) && d4 === d0);
const [, dl] = letterLift(1, 5, 0, 10, 50);
check('in a long slow word a letter takes its share of the time', Math.abs(dl - 1.3) < 1e-9);

const quick = run('abcde', 1.1, 1, 0.3);
check('a quick word rises whole, as before', quick.parts.length === 1 && quick.ls[0] > 0 && quick.ls[0] < 1 && quick.moving);

/* the last word of a line, held long: a little more glow */
const kar = hold => ({ st: [1, 2], du: [1, 1], hold });
check('no extra glow on other words, before the word, or when the word is short', holdGlow(kar(2), 0, 1.5) === 0 && holdGlow(kar(2), 1, 1.9) === 0 && holdGlow(kar(0.6), 1, 2.4) === 0 && holdGlow(kar(0), 1, 2.4) === 0);
const g = [2.5, 3.5, 4, 4.4, 4.9].map(t => holdGlow(kar(2), 1, t));
check('it swells while the word is sung, is at its most as the word ends, then settles to nothing', g[0] > 0 && g[1] > g[0] && g[2] > g[1] && g[3] < g[2] && g[4] === 0, g.map(v => v.toFixed(3)).join(' '));
check('never more than a little', Math.abs(g[2] - HOLD.gain) < 1e-9 && HOLD.gain <= 0.35);
check('a word held for a middling time gets part of it', holdGlow(kar(1.3), 1, 3.3) > 0 && holdGlow(kar(1.3), 1, 3.3) < HOLD.gain * 0.6);
fx.glow.hold = 2;
check('长音增亮 scales it', Math.abs(holdGlow(kar(2), 1, 4) - HOLD.gain * 2) < 1e-9);
fx.glow.hold = 0;
check('and at 0 there is none', holdGlow(kar(2), 1, 4) === 0);
fx.glow.hold = 1;
fx.glow.holdFrom = 0.4;
check('触发时长 lets a shorter word in', holdGlow(kar(0.6), 1, 2.6) > 0 && Math.abs(holdGlow(kar(1.4), 1, 3.4) - HOLD.gain) < 1e-9);
fx.glow.holdFrom = 2.5;
check('or keeps a longer one out', holdGlow(kar(2), 1, 4) === 0);
delete fx.glow.holdFrom;
fx.glow.on = false;
check('none at all when the glow is switched off', holdGlow(kar(2), 1, 4) === 0);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
