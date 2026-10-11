// The background look melting between songs (web/js/background/look-melt.js). Run: node tests/test_look_melt.js
const { moduleSource, LATE_STUB } = require('./module-source');
const { createLookMelt } = new Function(LATE_STUB + moduleSource('background/look-melt.js') + '\nreturn { createLookMelt };')();

let fails = 0;
const check = (name, ok, info = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : '  ' + info)); if (!ok) fails++; };
const look = (r, g, b, pal) => ({ pix: Uint8ClampedArray.from([r, g, b, 255, r, g, b, 255]), pal: pal || [[r, g, b], [r, g, b]] });
const R = (m, now) => Array.from(m.at(now).pix.slice(0, 3));

let m = createLookMelt(1000);
check('nothing before the first look', m.at(0) === null);
m.set(look(200, 0, 0), 0);
check('first look is shown at once', R(m, 0)[0] === 200 && !m.busy(0));

m.set(look(0, 0, 200), 100);                       // a new song's cover
check('starts from the old look', R(m, 100)[0] === 200, R(m, 100));
const mid = R(m, 600);
check('half way is a blend', mid[0] > 50 && mid[0] < 150 && mid[2] > 50 && mid[2] < 150, mid);
check('busy while melting', m.busy(600));
check('ends on the target and says so', R(m, 1100)[2] === 200 && !m.busy(1100) && m.at(1100) === m.at(5000));

// the same cover again half way (the page often asks twice): nothing restarts, nothing jumps
m = createLookMelt(1000);
m.set(look(200, 0, 0), 0); m.set(look(0, 0, 200), 100);
const before = R(m, 600);
const again = m.set(look(0, 0, 200), 600);
check('the same target again is ignored', again === false);
check('and the picture does not move', R(m, 600).join() === before.join());
check('and it still ends on time', R(m, 1100)[2] === 200 && !m.busy(1100));

// a different cover half way: carries on from what is shown
m = createLookMelt(1000);
m.set(look(200, 0, 0), 0); m.set(look(0, 0, 200), 100);
const shownNow = R(m, 600);
m.set(look(0, 200, 0), 600);
const afterSwitch = R(m, 600);
check('a new target half way starts from what is on screen', afterSwitch.join() === shownNow.join(), JSON.stringify({ shownNow, afterSwitch }));
let maxStep = 0, prev = afterSwitch;
for (let t = 600; t <= 1700; t += 16){
  const c = R(m, t);
  maxStep = Math.max(maxStep, ...c.map((v, i) => Math.abs(v - prev[i])));
  prev = c;
}
check('no jump on the way (max step per frame small)', maxStep < 20, maxStep);
check('ends on the last target', prev.join() === '0,200,0', prev);

// the palette melts too
m = createLookMelt(1000);
m.set(look(0, 0, 0, [[255, 0, 0], [0, 255, 0]]), 0);
m.set(look(0, 0, 0, [[0, 0, 255], [255, 255, 0]]), 0);
const pal = m.at(500).pal;
check('palette is blended', Math.abs(pal[0][0] - 127) < 3 && Math.abs(pal[0][2] - 127) < 3, JSON.stringify(pal));

console.log(fails ? '\n' + fails + ' problems' : '\nall passed');
process.exit(fails ? 1 : 0);
