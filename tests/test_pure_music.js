// A song that is pure music: its lyrics are a placeholder line (web/js/core/core.js). Run: node tests/test_pure_music.js
const { moduleSource } = require('./module-source');
const { purelyInstrumental } = new Function(moduleSource('core/core.js') + '\nreturn { purelyInstrumental };')();
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '   ' + extra : '')); };

check('the line the sources give for a song without words', purelyInstrumental('[00:00.00]此歌曲为没有填词的纯音乐，请您欣赏'));
check('with the credits above it', purelyInstrumental('[ti:Interlude]\n[ar:X]\n[00:00.000]作曲 : Someone\n[00:01.000]纯音乐，请欣赏\n'));
check('in English, with a word timing in it', purelyInstrumental('[00:00.00]<00:00.00>Instrumental<00:02.00>'));
check('and with Windows line ends', purelyInstrumental('[00:00.00]纯音乐，请欣赏\r\n[00:10.00]\r\n'));
check('a song with words is not', !purelyInstrumental('[00:01.00]Headlights cutting through the quiet\n[00:04.00]Every sign is glowing white\n[00:08.00]Hold the wheel\n[00:12.00]and let it ride\n[00:16.00]Nothing left\n'));
check('a lyric that only mentions it, among many lines, is not', !purelyInstrumental('[00:01.00]a\n[00:02.00]b\n[00:03.00]c\n[00:04.00]d\n[00:05.00]instrumental break\n[00:06.00]e'));
check('nothing at all, or no lines, is not (that is "no lyrics found", another case)', !purelyInstrumental('') && !purelyInstrumental(null) && !purelyInstrumental('[ti:x]\n[ar:y]'));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
