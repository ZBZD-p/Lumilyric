// Background vocals (web/js/core/core.js): lines sung while another one is become its background. Run: node tests/test_bgvocals.js
const { moduleSource } = require('./module-source');
const { mergeSimultaneous, bgAdd, bgPiece } = new Function(moduleSource('core/core.js') + '\nreturn { mergeSimultaneous, bgAdd, bgPiece };')();

let fails = 0;
function eq(name, got, want){
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w){ fails++; console.log('FAIL', name, '\n  got ', g, '\n  want', w); }
}
// a line with one word timing per word, evenly spread over [s, e]
const line = (s, e, en, zh = '') => {
  const ws = en.split(' '), d = (e - s) / ws.length;
  return { t: s, en, zh, wt: ws.map((w, i) => ({ w, s: s + d * i, e: s + d * (i + 1), m: true })), wtText: en, pEnd: e };
};
const texts = ls => ls.map(l => l.en);
const bgTexts = ls => ls.map(l => l.bg ? l.bg.en : null);

// the end of "We Don't Talk Anymore" (am-lyrics/1031416185.ttml, 192 s on)
const tail = [
  line(192.67, 195.10, "We don't talk anymore", '我们之间只剩沉默'),
  line(192.94, 194.52, "Don't wanna know", '我不想知道'),
  line(194.52, 196.74, "Kind of dress you're wearing tonight", '今夜你会穿哪一条裙装'),
  line(196.646, 197.374, 'Oh'),                     // 0.1 s before it ends: a line of its own
  line(197.108, 199.055, "If he's holding onto you so tight"),
];
const a = mergeSimultaneous(tail);
eq('overlapping line goes under, and the one that carries on', texts(a), ["We don't talk anymore", 'Oh', "If he's holding onto you so tight"]);
eq('background text joined', a[0].bg.en, "Don't wanna know Kind of dress you're wearing tonight");
eq('background translation joined', a[0].bg.zh, '我不想知道 今夜你会穿哪一条裙装');
eq('background word times kept', a[0].bg.wt.length, 3 + 6);
eq('background span', [a[0].bg.t, a[0].bg.end], [192.94, 196.74]);
eq('under by default', a[0].bg.above, false);

// a line only timed a little early is not a second voice (0.3 s over: "Oh" / "If he's holding...")
const early = mergeSimultaneous([line(196.646, 197.374, 'Oh'), line(197.108, 199.055, "If he's holding onto you so tight")]);
eq('0.3 s of overlap stays a line of its own', texts(early), ['Oh', "If he's holding onto you so tight"]);

// a line that begins together with the main line is not under it
const together = mergeSimultaneous([line(10, 12, 'One'), line(10.05, 12, 'Two')]);
eq('begins with it: stays', texts(together), ['One', 'Two']);

// the line that carries on must follow straight on: a gap keeps it a line of its own
const sung = mergeSimultaneous([line(0, 6, 'Main'), line(1, 2, 'Echo'), line(3, 4, 'Later')]);
eq('a second piece, a good part of the line still to come', [texts(sung), bgTexts(sung)], [['Main'], ['Echo Later']]);
const gap = mergeSimultaneous([line(0, 6, 'Main'), line(1, 2, 'Echo'), line(5.5, 6.5, 'Later')]);
eq('not straight on and little of the line left: a line of its own', [texts(gap), bgTexts(gap)], [['Main', 'Later'], ['Echo', null]]);
const straight = mergeSimultaneous([line(0, 6, 'Main'), line(1, 2, 'Echo'), line(2.05, 5.5, 'Carries on')]);
eq('straight on from the echo: taken too', [texts(straight), bgTexts(straight)], [['Main'], ['Echo Carries on']]);
const late = mergeSimultaneous([line(0, 6, 'Main'), line(1, 2, 'Echo'), line(5.5, 7, 'Carries on')]);
eq('straight on but after the line has ended', texts(late), ['Main', 'Carries on']);

const gap2 = mergeSimultaneous([line(0, 3, 'Main'), line(1, 2, 'Echo'), line(2.6, 3.4, 'Next')]);
eq('begins when little of the line is left: a line of its own', texts(gap2), ['Main', 'Next']);
eq('only the echo under it', bgTexts(gap2), ['Echo', null]);

// without word times a line ends where its <p> does (pEnd), and lines need no words to be merged
const bare = mergeSimultaneous([{ t: 0, en: 'Main', zh: '', pEnd: 4 }, { t: 1, en: 'Echo', zh: '', pEnd: 3 }]);
eq('without word times', [texts(bare), bgTexts(bare)], [['Main'], ['Echo']]);

// bgAdd: pieces in the order they are sung, one text
const A = {};
bgAdd(A, { t: 5, end: 6, en: 'two', zh: '二', wt: [{ w: 'two', s: 5, e: 6 }], wtText: 'two' });
bgAdd(A, { t: 3, end: 4, en: 'one', zh: '一', wt: [{ w: 'one', s: 3, e: 4 }], wtText: 'one' });
eq('bgAdd order', [A.bg.en, A.bg.zh, A.bg.t, A.bg.end, A.bg.wt.map(w => w.w).join('')], ['one two', '一 二', 3, 6, 'onetwo']);
// a piece with no word times makes the whole of it a plain line
const B = {};
bgAdd(B, { t: 1, end: 2, en: 'x', zh: '', wt: [{ w: 'x', s: 1, e: 2 }], wtText: 'x' });
bgAdd(B, { t: 2, end: 3, en: 'y', zh: '' });
eq('no word times for all: none', B.bg.wt, undefined);

// the background vocals' own times, unless they cannot be right. "Stan" (AMLL TTML DB) writes "((screaming)" under a line
// at 4:31 as 0 to 0: with that time the line went to the start of the song and swallowed every line up to its place
{
  const L = line(271.17, 273.72, "See Slim, shut up bitch! I'm tryin to talk!");
  const zero = { t: 0, end: 0, en: 'screaming', zh: '尖叫声', wt: [{ w: 'screaming', s: 0, e: 0, m: true }], wtText: 'screaming' };
  const p0 = bgPiece(L, zero);
  eq('a background at 0 to 0 is sung with the line', [p0.t, p0.end, p0.en, p0.zh, p0.wt], [271.17, 273.72, 'screaming', '尖叫声', undefined]);
  const far = { t: 12, end: 14, en: 'far', wt: [{ w: 'far', s: 12, e: 14, m: true }] };
  eq('a background far from its line is sung with it too', bgPiece(L, far).t, 271.17);
  const ok = { t: 270.9, end: 272.4, en: 'oh', wt: [{ w: 'oh', s: 270.9, e: 272.4, m: true }], wtText: 'oh' };
  eq('a background with real times keeps them', [bgPiece(L, ok).t, bgPiece(L, ok).end, !!bgPiece(L, ok).wt], [270.9, 272.4, true]);
  const lines = [line(1, 3, 'one'), L, line(300, 302, 'last')];
  bgAdd(L, bgPiece(L, zero));
  eq('the line stays where it is sung', [L.t, L.bg.above], [271.17, false]);
  eq('and nothing before it is taken in', texts(mergeSimultaneous(lines)), ['one', "See Slim, shut up bitch! I'm tryin to talk!", 'last']);
}

// a "line" sung for minutes (its times are wrong) takes nothing into it: the lines stay as they are
eq('a line of bad times takes no other line', texts(mergeSimultaneous([line(0, 273.72, 'long'), line(5, 8, 'a'), line(10, 13, 'b')])), ['long', 'a', 'b']);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
