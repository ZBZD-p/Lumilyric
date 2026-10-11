// The song-change sequence (web/js/render/song-transition.js), frame by frame. Run: node tests/test_transition.js
const { moduleSource, LATE_STUB } = require('./module-source');
const src = LATE_STUB + moduleSource('render/text-canvas.js').match(/function cubicBezier[\s\S]*?\n}\n/)[0] + '\n'
  + moduleSource('render/song-transition.js')
  + '\nreturn { createSongStage, createSongFlow, ease: cubicBezier(0.36, 0, 0.14, 1) };';
const { createSongStage, createSongFlow, ease } = new Function(src)();

const H = 720, FS = 48, D = H + FS * 4, LINE = 100, ANCHOR = H * 0.36, FIRST = -4, LAST = 8;
let fails = 0;

/* events: [ms, 'change', title] | [ms, 'lyrics', title, found]; scroll: the layout has the animation */
function run(name, events, until, opts = {}){
  const { scroll = true, startLines = true, expect } = opts;
  const stage = createSongStage(ease);
  const log = { loads: [], nones: [], blanks: [] };
  const st = { lines: startLines ? 'X' : null, now: 0 };                   // what `song` holds
  const seqOf = {};                                                        // title -> seq handed out at its change
  const flow = createSongFlow(stage, {
    scroll: () => scroll,
    hasLines: () => !!st.lines,
    blank: s => { st.lines = null; log.blanks.push({ at: st.now, s: s.title }); },
    load: (s, res) => { log.loads.push({ at: st.now, s: s.title, phase: stage.phase }); st.lines = s.title; return true; },
    none: s => { st.lines = null; log.nones.push({ at: st.now, s: s.title }); },
  });
  stage.onEmpty = () => flow.tick(st.now);
  const problems = [];
  const prevY = {};
  let ei = 0, maxStep = 0, lockedT = null, last = null, prevDraw = null;
  const frames = [];
  for (let ms = 0; ms <= until; ms += 1000 / 60){
    st.now = ms;
    while (ei < events.length && events[ei][0] <= ms){
      const ev = events[ei++], kind = ev[1], title = ev[2], found = ev.length > 3 ? ev[3] : true;
      if (kind === 'change') seqOf[title] = flow.trackChanged(ms, { title });
      else flow.lyrics(ms, seqOf[title], { title }, found ? { lrc: 'x', source: 's', verbatim: true } : { lrc: null, reason: 'none' });
    }
    const r = stage.step(ms, 100 + ms / 1000);
    last = r;
    frames.push({ ms, phase: r.phase });
    if (!scroll) continue;
    if (r.draw === 'out'){
      if (lockedT === null) lockedT = r.t;
      if (r.t !== lockedT) problems.push(`old lyrics were not locked: t ${lockedT} -> ${r.t} at ${ms.toFixed(0)} ms`);
    } else lockedT = null;
    if (r.draw === 'cur' && (r.phase === 'leaving' || r.phase === 'empty')) problems.push('current song drawn in ' + r.phase);
    if (r.shift){
      // a line is compared with itself in the previous frame; when the draw type changes (cur -> out: switched away
      // while sliding in) the line must carry on from the same place, otherwise the column is a new one
      const handover = prevDraw === 'cur' && r.draw === 'out';
      for (let k = FIRST; k <= LAST; k++){
        const y = ANCHOR + k * LINE + r.shift(k - FIRST, 0, D);
        const key = handover || prevDraw === r.draw ? 'k' + k : null;
        if (key && prevY['k' + k] !== undefined) maxStep = Math.max(maxStep, Math.abs(y - prevY['k' + k]));
        prevY['k' + k] = y;
      }
      prevDraw = r.draw;
    } else { for (const k in prevY) delete prevY[k]; prevDraw = null; }
  }
  if (scroll) for (const l of log.loads) if (l.phase !== 'empty') problems.push(`lyrics loaded in phase "${l.phase}" (must be "empty")`);
  const cap = D * 0.15;
  if (maxStep > cap) problems.push(`a line moved ${maxStep.toFixed(0)} px in one frame (limit ${cap.toFixed(0)})`);
  if (scroll && last.phase !== 'empty' && last.busy) problems.push('still moving at the end');
  if (expect) problems.push(...expect({ log, frames }));
  const shown = log.loads.map(l => l.s + '@' + Math.round(l.at)).join(', ') || '-';
  console.log((problems.length ? 'FAIL ' : 'ok   ') + name + '   (loaded: ' + shown + ', max step ' + maxStep.toFixed(0) + ' px)');
  problems.forEach(p => { fails++; console.log('       ' + p); });
}

const onlyLoaded = title => ({ log }) =>
  log.loads.length === 1 && log.loads[0].s === title ? [] : ['expected only "' + title + '" loaded, got ' + JSON.stringify(log.loads)];

run('normal: lyrics arrive while the old ones are still leaving',
  [[1000, 'change', 'Y'], [1300, 'lyrics', 'Y']], 5000, {
    expect: ({ log }) => log.loads.length === 1 && log.loads[0].at >= 1790 && log.loads[0].at < 1900
      ? [] : ['loaded at the wrong time ' + JSON.stringify(log.loads)] });

run('slow search: empty screen, then the lyrics the moment they arrive',
  [[1000, 'change', 'Y'], [4000, 'lyrics', 'Y']], 7000, {
    expect: ({ log, frames }) => {
      const p = [];
      if (log.loads.length !== 1 || log.loads[0].at < 4000 || log.loads[0].at > 4040) p.push('wrong load time: ' + JSON.stringify(log.loads));
      if (!frames.filter(f => f.ms > 1900 && f.ms < 3900).every(f => f.phase === 'empty')) p.push('screen not empty while searching');
      return p;
    } });

run('not found: stays empty',
  [[1000, 'change', 'Y'], [1500, 'lyrics', 'Y', false]], 5000, {
    expect: ({ log, frames }) => log.loads.length === 0 && log.nones.length === 1 && frames[frames.length - 1].phase === 'empty'
      ? [] : ['expected none + empty'] });

run('changed again while leaving: only the newest loads',
  [[1000, 'change', 'Y'], [1300, 'change', 'Z'], [1350, 'lyrics', 'Y'], [1500, 'lyrics', 'Z']], 5000, { expect: onlyLoaded('Z') });

run('changed again while searching: the old answer is dropped',
  [[1000, 'change', 'Y'], [3000, 'change', 'Z'], [3100, 'lyrics', 'Y'], [3500, 'lyrics', 'Z']], 6000, { expect: onlyLoaded('Z') });

run('changed while entering: Y then Z',
  [[1000, 'change', 'Y'], [1100, 'lyrics', 'Y'], [2300, 'change', 'Z'], [2400, 'lyrics', 'Z']], 7000, {
    expect: ({ log }) => log.loads.length === 2 && log.loads[0].s === 'Y' && log.loads[1].s === 'Z' ? [] : ['expected Y then Z'] });

run('three quick skips',
  [[1000, 'change', 'A'], [1100, 'change', 'B'], [1200, 'change', 'C'], [1250, 'lyrics', 'A'], [1900, 'lyrics', 'C'], [2000, 'lyrics', 'B']], 6000, {
    expect: onlyLoaded('C') });

run('nothing was shown: no leaving, straight to empty',
  [[1000, 'change', 'Y'], [1100, 'lyrics', 'Y']], 4000, {
    startLines: false,
    expect: ({ log }) => log.loads.length === 1 && log.loads[0].at < 1200 ? [] : ['should load at once: ' + JSON.stringify(log.loads)] });

run('layout without the animation: blank at once, load on arrival',
  [[1000, 'change', 'Y'], [1400, 'lyrics', 'Y']], 3000, {
    scroll: false,
    expect: ({ log }) => log.blanks.length === 1 && log.blanks[0].at < 1020 && log.loads.length === 1 && log.loads[0].at < 1420
      ? [] : ['blank/load timing wrong ' + JSON.stringify(log)] });

console.log(fails ? '\n' + fails + ' problems' : '\nall passed');
process.exit(fails ? 1 : 0);
