// Duets (web/js/core/core.js): singer labels in LRC, and which lines stand on the other side. Run: node tests/test_duet.js
const { moduleSource } = require('./module-source');
const { parseLRC, duetSides } = new Function(moduleSource('core/core.js') + '\nreturn { parseLRC, duetSides };')();

let fails = 0;
function eq(name, got, want){
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w){ fails++; console.log('FAIL', name, '\n  got ', g, '\n  want', w); }
}
const texts = song => song.lines.map(l => l.en || l.zh);
const sides = (song, artist) => duetSides(song, artist).map(r => r ? 'R' : 'L').join('');

// the user's lines: a word-timed label line, then the guest's words; the artist sings before it
const a = parseLRC(`[ar:The Weeknd]
[01:10.00]<01:10.00>Before <01:10.50>the <01:11.00>guest
[01:17.30]<01:17.30>Selena <01:17.35>Gomez：<01:17.40>
[01:17.35]<01:17.35>I <01:17.73>just <01:18.02>hope <01:18.31>you're <01:18.65>lying <01:19.21>next <01:19.41>to <01:19.62>somebody<01:20.16>
[01:21.00]The Weeknd：
[01:21.50]Back to me`);
eq('label line is not shown', texts(a), ['Before the guest', "I just hope you're lying next to somebody", 'Back to me']);
eq('who', a.lines.map(l => l.who || ''), ['', 'Selena Gomez', 'The Weeknd']);
eq('word times kept', a.lines[1].wt.length, 8);
eq('guest on the other side', sides(a, 'The Weeknd'), 'LRL');
eq('artist with both names: the first named is the main voice', sides(a, 'The Weeknd / Selena Gomez'), 'LRL');
eq('no artist: the first label is the main voice', sides(a, ''), 'LLR');

// only the guest is labelled: the unlabelled lines are the artist's
const b = parseLRC(`[00:01.00]One
[00:02.00]Selena Gomez：
[00:03.00]Two
[00:04.00]Three`);
eq('one label, not the artist', sides(b, 'The Weeknd'), 'LRR');

// 男 / 女 / 合, also at the start of a line; credits are not labels
const c = parseLRC(`[00:00.50]作词：某人
[00:00.80]作曲：某人
[00:01.00]男：第一句
[00:02.00]女：第二句
[00:03.00]合：一起唱
[00:04.00]男：
[00:05.00]第四句`);
eq('credits dropped, labels taken off', texts(c), ['第一句', '第二句', '一起唱', '第四句']);
eq('男 / 女 / 合', sides(c, '某歌手'), 'LRLL');

// a colon inside an ordinary line is not a label
const d = parseLRC(`[00:01.00]Hello
[00:02.00]She said: come back home
[00:03.00]Bye`);
eq('a colon in a line', texts(d), ['Hello', 'She said: come back home', 'Bye']);
eq('no labels: nothing moves', sides(d, 'X'), 'LLL');

// "A & B：" is together: the main side
const e = parseLRC(`[00:01.00]A：
[00:02.00]one
[00:03.00]B：
[00:04.00]two
[00:05.00]A & B：
[00:06.00]three`);
eq('together', sides(e, ''), 'LRL');

// TTML agents (as parseTTML sets them): v1 is the main voice, a group is together
const f = { lines: [{ who: 'v1' }, { who: 'v2' }, { who: '合' }, { who: 'v2' }] };
eq('TTML v1 / v2', sides(f, 'Someone Else'), 'LRLR');

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
