// A jump in time in the scrolling layout (web/js/render/seek-motion.js), frame by frame. Run: node tests/test_seek.js
const { moduleSource, LATE_STUB } = require('./module-source');
const src = LATE_STUB + moduleSource('render/text-canvas.js').match(/function cubicBezier[\s\S]*?\n}\n/)[0] + '\n'
  + moduleSource('render/seek-motion.js')
  + '\nreturn { createSeekMotion, ease: cubicBezier(0.36, 0, 0.14, 1) };';
const { createSeekMotion, ease } = new Function(src)();

/* a column like the page's: a line every 3 s (every fifth one of two rows), the current one at 36 % of the height,
   moved there by an eased step at each line change */
const H = 720, FS = 48, REACH = FS * 2, GAP = FS * 0.62, ROW = FS * 1.18, ANCHOR = H * 0.36, N = 80;
const lineT = j => 4 + 3 * j, lineH = j => (j % 5 === 3 ? 2 : 1) * ROW;
const Y = []; for (let j = 0, y = 0; j < N; j++){ Y.push(y); y += lineH(j) + GAP; }
const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const cur = t => { let c = -1; for (let j = 0; j < N; j++) if (lineT(j) - 0.12 <= t) c = j; return c; };
function tops(t){
  let off = ANCHOR - Y[0];
  for (let k = 1, c = cur(t); k <= c; k++) off += (Y[k - 1] - Y[k]) * ease(clamp01((t - lineT(k) + 0.12) / 0.95));
  return Y.map(y => y + off);
}
const makeGeo = key => ({ key, H, reach: REACH, gap: GAP, tops, cur, h: lineH, glide: { dur: 0.95, lag: 0.055, maxLag: 0.4 } });

const DT = 1000 / 120, CAP = 80;       // px a line may move in one frame (the fastest move, two places dragged through at once, does about 60)
let fails = 0;

/* events: [ms, 'press', x] | [ms, 'pointer', x] | [ms, 'release'] | [ms, 'seek', t] | [ms, 'nudge', dt]
           | [ms, 'reset'] | [ms, 'relayout'] | [ms, 'pause'] | [ms, 'play'] */
function run(name, events, until, opts = {}){
  const { t0 = 40, calm = false, cap = CAP, states, expect, endT } = opts;
  const sm = createSeekMotion(ease);
  let geo = makeGeo('a'), t = t0, playing = opts.playing !== false, ei = 0;
  const problems = [], seen = [], say = p => { if (problems.length < 6) problems.push(p); };
  let before = new Map(), last = null, maxStep = 0, maxOuts = 0, beforeState = 'rest', beforeT = null, beforeGoal = null;
  events = events.slice().sort((a, b) => a[0] - b[0]);
  for (let f = 0; f * DT <= until; f++){
    const ms = f * DT;
    if (playing && f) t += DT / 1000;
    while (ei < events.length && events[ei][0] <= ms){
      const [, kind, arg] = events[ei++];
      if (kind === 'press') sm.press(arg); else if (kind === 'pointer') sm.pointer(arg); else if (kind === 'release') sm.release();
      else if (kind === 'seek') t = arg; else if (kind === 'nudge') t += arg;
      else if (kind === 'reset') sm.reset(); else if (kind === 'relayout') geo = makeGeo('b');
      else if (kind === 'pause') playing = false; else if (kind === 'play') playing = true;
    }
    const r = sm.step(ms, t, geo, calm), wasReset = events.some(e => e[1] === 'reset' && e[0] <= ms && e[0] > ms - DT);
    last = r;
    if (seen[seen.length - 1] !== r.state) seen.push(r.state);
    const scrub = r.state === 'scrub', at = ' at ' + ms.toFixed(0) + ' ms';

    // the time shown: waits while pressed, and while scrubbing only ever goes towards the bar's
    if (r.state === 'pressed' && beforeState === 'pressed' && r.t !== beforeT && !wasReset) say('the time moved while pressed' + at);
    if (scrub && beforeState === 'scrub' && Math.abs(t - r.t) > Math.abs(beforeGoal - beforeT) + Math.abs(t - beforeGoal) + 1e-9)
      say('scrubbing went away from the bar' + at);
    if (!scrub && r.state !== 'pressed' && r.t !== t) say('the time shown is not the time given' + at);

    // every column drawn this frame, line by line
    const cols = r.outs.map(o => ({ id: o.id, t: o.t, off: o.off, byRest: true, moving: !o.melting }));
    cols.push({ id: r.id, t: r.t, off: r.live, byRest: r.byRest, moving: true, live: true });
    const moving = r.outs.filter(o => !o.melting).length;
    maxOuts = Math.max(maxOuts, moving);
    if (moving > 1) say('more than one place going out' + at);
    if (moving && !r.live) say('a place going out and nothing coming in' + at);
    const now = new Map(), pair = [];
    for (const c of cols){
      const rest = tops(c.t);
      for (let j = 0; j < N; j++){
        const h = lineH(j), off = c.off ? c.off[j] : 0, pos = rest[j] + off;
        const inside = y => y + h > 0 && y < H;
        const shown = inside(pos) && (!c.byRest || inside(rest[j]));
        const key = c.id + ':' + j, was = before.get(key);
        now.set(key, { pos, off, shown });
        if (c.moving && shown) pair.push({ pos, h, key });
        if (!was || !(shown || was.shown)) continue;
        // no teleport: a line carries on from where it was. Scrubbing, the column runs with the bar by design; what
        // must not jump then is how far a line is from its own place
        const step = Math.abs(c.live && (scrub || beforeState === 'scrub') ? off - was.off : pos - was.pos);
        maxStep = Math.max(maxStep, step);
        if (step > cap) say(`line ${j} jumped ${step.toFixed(0)} px` + at + ' (' + beforeState + ' -> ' + r.state + ')');
      }
    }
    // the lines that move never get closer to each other than they are at rest
    pair.sort((a, b) => a.pos - b.pos);
    for (let i = 1; i < pair.length; i++){
      const d = pair[i].pos - pair[i - 1].pos - pair[i - 1].h;
      if (d < GAP - 0.5){ say(`lines ${pair[i - 1].key} and ${pair[i].key} are ${d.toFixed(0)} px apart` + at + ' (' + r.state + ')'); break; }
    }
    before = now; beforeState = r.state; beforeT = r.t; beforeGoal = t;
  }
  if (last.busy || last.state !== 'rest' || last.live || last.outs.length) problems.push('still moving at the end (' + last.state + ')');
  if (endT != null && Math.abs(last.t - endT) > 0.05) problems.push('ended at ' + last.t.toFixed(2) + ' s, expected ' + endT);
  if (states && seen.join(' ') !== states) problems.push('states: ' + seen.join(' ') + '   expected: ' + states);
  if (expect) problems.push(...expect({ seen, maxOuts, maxStep }));
  console.log((problems.length ? 'FAIL ' : 'ok   ') + name + '   (' + seen.join(' > ') + ', max step ' + maxStep.toFixed(0) + ' px)');
  problems.forEach(p => { fails++; console.log('       ' + p); });
}

/* the bar clicked at ms, on the place of time to: pressed (the bar's value changes at once), let go a moment later */
const click = (ms, to, held = 70) => [[ms, 'press', 300], [ms, 'seek', to], [ms + held, 'release']];
/* the bar pressed at ms and dragged through the places [after ms, time], let go at the end */
function dragBar(ms, from, path, letGo){
  const ev = [[ms, 'press', 300], [ms, 'seek', from]];
  path.forEach(([d, to], i) => ev.push([ms + d, 'pointer', 310 + i * 5], [ms + d, 'seek', to]));
  ev.push([ms + letGo, 'release']);
  return ev;
}
const sweep = (from, to, a, b, n) => Array.from({ length: n }, (_, i) => [a + (b - a) * i / (n - 1), from + (to - from) * i / (n - 1)]);

for (const playing of [true, false]){
  const p = playing ? '' : ' (paused)', end = (to, since) => playing ? to + since / 1000 : to;
  run('click, forward' + p, click(500, 130), 3000, { playing, states: 'rest pressed drag rest', endT: end(130, 2500) });
  run('click, back' + p, click(500, 130).map(e => e[1] === 'seek' ? [e[0], 'seek', 16] : e), 3000,
    { playing, t0: 130, states: 'rest pressed drag rest', endT: end(16, 2500) });
  run('click, a few lines on (a short drag)' + p, click(500, 52), 3000, { playing, states: 'rest pressed drag rest' });
  run('click, one line on (glides)' + p, click(500, 44), 3000, { playing, states: 'rest pressed glide rest' });
  run('keyboard, 5 s on and 5 s back' + p, [[500, 'nudge', 5], [2500, 'nudge', -5]], 4500, { playing, states: 'rest glide rest glide rest' });
  run('keyboard, held: 5 s on, eight times' + p, Array.from({ length: 8 }, (_, i) => [500 + i * 120, 'nudge', 5]), 4000,
    { playing, states: 'rest glide rest' });
  run('keyboard, on and straight back' + p, [[500, 'nudge', 5], [700, 'nudge', -5], [900, 'nudge', -5], [1000, 'nudge', 5]], 3500,
    { playing, states: 'rest glide rest' });
  run('a jump from elsewhere (the player jumped)' + p, [[500, 'seek', 150]], 3000, { playing, states: 'rest drag rest' });
  run('held and dragged across the song' + p, dragBar(500, 60, sweep(60, 200, 150, 1400, 60), 1500), 4000,
    { playing, states: 'rest pressed scrub rest', endT: end(200, 2100) });
  run('dragged, stopped, dragged back' + p,
    dragBar(500, 60, [...sweep(60, 150, 150, 700, 30), ...sweep(150, 30, 1600, 2200, 30)], 2400), 4500,
    { playing, states: 'rest pressed scrub rest' });
}

// clicks in quick succession: the second one at every moment of the first one's move
for (const d of [40, 120, 250, 400, 550, 700, 900, 1050, 1200]){
  run('two clicks, both forward, ' + d + ' ms apart', [...click(500, 130), ...click(570 + d, 200)], 4000,
    { states: d < 1100 ? 'rest pressed drag pressed drag rest' : 'rest pressed drag rest pressed drag rest', endT: 200 + (4000 - 570 - d) / 1000 });
  run('two clicks, forward then back, ' + d + ' ms apart', [...click(500, 130), ...click(570 + d, 20)], 4000, {});
  run('two clicks, back then forward, ' + d + ' ms apart', [...click(500, 20), ...click(570 + d, 180)], 4000, { t0: 130 });
  run('two clicks, the second one near by, ' + d + ' ms apart', [...click(500, 130), ...click(570 + d, 134)], 4000, {});
  run('click, then the keyboard, ' + d + ' ms later', [...click(500, 130), [570 + d, 'nudge', 5], [690 + d, 'nudge', 5]], 4000, {});
  run('click, then held and dragged, ' + d + ' ms later',
    [...click(500, 130), ...dragBar(570 + d, 131, sweep(131, 190, 90, 800, 40), 900)], 4500, {});
  run('click, then held and dragged back, ' + d + ' ms later',
    [...click(500, 130), ...dragBar(570 + d, 128, sweep(128, 30, 90, 800, 40), 900)], 4500, {});
}
run('four clicks, 90 ms apart', [...click(500, 100, 40), ...click(590, 160, 40), ...click(680, 40, 40), ...click(770, 120, 40)], 4000,
  { expect: ({ maxOuts }) => maxOuts === 1 ? [] : ['expected one place going out at a time'] });
run('a glide, then a click', [[500, 'nudge', 5], ...click(800, 150)], 3500, { states: 'rest glide pressed drag rest' });
run('a glide, then held and dragged', [[500, 'nudge', 5], ...dragBar(700, 46, sweep(46, 120, 90, 700, 30), 800)], 3500,
  { states: 'rest glide pressed scrub rest' });

// a followed player
run('the player corrects itself by less than 0.6 s', [[500, 'nudge', 0.5], [1500, 'nudge', -0.5], [2500, 'nudge', 0.3]], 3500,
  { cap: 160, states: 'rest' });
run('dragged; the player gets there late and a little off',
  [...dragBar(500, 60, sweep(60, 140, 150, 900, 40), 1000), [2200, 'nudge', 0.45]], 4000, { cap: 160, states: 'rest pressed scrub rest' });
run('clicked; the player gets there late and a little off', [...click(500, 130), [2300, 'nudge', -0.4]], 4000,
  { cap: 160, states: 'rest pressed drag rest' });
run('the tab was in the background for a while (no frames, the song went on)', [[1000, 'nudge', 0.55]], 2500, { cap: 160, states: 'rest' });

// everything else that happens meanwhile
run('a song change in the middle of a drag', [...click(500, 130), [900, 'reset']], 2500, {
  cap: Infinity, expect: ({ seen }) => seen.join(' ') === 'rest pressed drag rest' ? [] : ['states: ' + seen.join(' ')] });
run('another layout in the middle of a drag', [...click(500, 130), [900, 'relayout']], 2500, { cap: Infinity, states: 'rest pressed drag rest' });
run('a song change while the bar is pressed', [[500, 'press', 300], [500, 'seek', 130], [600, 'reset'], [900, 'release']], 2500,
  { cap: Infinity, states: 'rest pressed rest' });
run('reduced motion: a click just shows the new place', click(500, 130), 2000, { calm: true, cap: Infinity, states: 'rest pressed rest' });
run('reduced motion: dragging still runs along', dragBar(500, 60, sweep(60, 200, 150, 1400, 60), 1500), 4000,
  { calm: true, states: 'rest pressed scrub rest' });

console.log(fails ? '\n' + fails + ' problems' : '\nall passed');
process.exit(fails ? 1 : 0);
