// Which community-library entry is the song a player is on (web/js/player/amll-match.js). Run: node tests/test_amll_match.js
const { moduleSource } = require('./module-source');
const { amllPick } = new Function(moduleSource('player/amll-match.js') + '\nreturn { amllPick };')();

let fails = 0;
function eq(name, got, want){
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w){ fails++; console.log('FAIL', name, '\n  got ', g, '\n  want', w); }
}
const E = (name, artists, album = '', file = name + '.ttml') => ({ name, artists, album, file });
const file = e => e ? e.file : null;

const idx = [
  E("We Don't Talk Anymore (feat. Selena Gomez)", ['Charlie Puth', 'Selena Gomez'], 'Nine Track Mind', 'wdta.ttml'),
  E('Hello', ['Adele'], '25', 'hello-adele.ttml'),
  E('Hello', ['Lionel Richie'], 'Can\'t Slow Down', 'hello-lionel.ttml'),
  E('Dawn FM', ['The Weeknd'], 'Dawn FM', 'dawn.ttml'),
  E('Dawn FM (Live)', ['The Weeknd'], '', 'dawn-live.ttml'),
  E('Super Shy', ['NewJeans'], 'Get Up', 'supershy.ttml'),
  E('Blinding Lights', ['The Weeknd'], 'After Hours', 'bl-old.ttml'),
  E('Blinding Lights', ['The Weeknd'], 'After Hours', 'bl-new.ttml'),
  E('Under Pressure', ['Queen', 'David Bowie'], '', 'up.ttml'),
];

eq('same name, feat. dropped', file(amllPick(idx, "We Don't Talk Anymore", 'Charlie Puth', '')), 'wdta.ttml');
eq('the player has the feat. too', file(amllPick(idx, "We Don't Talk Anymore (feat. Selena Gomez)", 'Charlie Puth / Selena Gomez', 'Nine Track Mind')), 'wdta.ttml');
eq('one of the artists is enough', file(amllPick(idx, "We Don't Talk Anymore", 'Selena Gomez', '')), 'wdta.ttml');
eq('same name, the other artist', file(amllPick(idx, 'Hello', 'Adele', '')), 'hello-adele.ttml');
eq('same name, the other artist (2)', file(amllPick(idx, 'Hello', 'Lionel Richie', '')), 'hello-lionel.ttml');
eq('same name, an artist that is not there: none', file(amllPick(idx, 'Hello', 'Someone Else', '')), null);
eq('no artist from the player: none', file(amllPick(idx, 'Hello', '', '')), null);
eq('a different song of the artist: none', file(amllPick(idx, 'Starboy', 'The Weeknd', '')), null);
eq('punctuation and case', file(amllPick(idx, 'we dont talk anymore', 'charlie puth', '')), 'wdta.ttml');
eq('a second name in brackets', file(amllPick(idx, 'Super Shy', 'NewJeans (뉴진스)', '')), 'supershy.ttml');
eq('artist written with a separator', file(amllPick(idx, 'Under Pressure', 'Queen & David Bowie', '')), 'up.ttml');

// another recording is not the song
eq('live in the player, studio in the library', file(amllPick(idx, 'Blinding Lights (Live)', 'The Weeknd', '')), null);
eq('live in the library, studio in the player', file(amllPick(idx, 'Dawn FM', 'The Weeknd', '')), 'dawn.ttml');
eq('live on both', file(amllPick(idx, 'Dawn FM (Live)', 'The Weeknd', '')), 'dawn-live.ttml');
eq('remix in the player: none', file(amllPick(idx, 'Super Shy - Remix', 'NewJeans', '')), null);
eq('a harmless tail (Remastered) is still the song', file(amllPick(idx, 'Dawn FM - Remastered 2022', 'The Weeknd', '')), 'dawn.ttml');
eq('explicit tag is still the song', file(amllPick(idx, 'Blinding Lights (Explicit)', 'The Weeknd', '')), 'bl-new.ttml');

// several entries: the later submission when nothing tells them apart
eq('later submission', file(amllPick(idx, 'Blinding Lights', 'The Weeknd', 'After Hours')), 'bl-new.ttml');
// the entry written exactly like the player's wins over one that only has the name once brackets are gone
const two = [E('Song (feat. X)', ['A'], '', 'with-feat.ttml'), E('Song', ['A'], '', 'plain.ttml'), E('Song (feat. Y)', ['A'], '', 'other-feat.ttml')];
eq('exact name first', file(amllPick(two, 'Song', 'A', '')), 'plain.ttml');
eq('exact name first (2)', file(amllPick(two, 'Song (feat. X)', 'A', '')), 'with-feat.ttml');

// a name that is only a bracket
eq('name in brackets only', file(amllPick([E('(Intro)', ['A'], '', 'intro.ttml')], '(Intro)', 'A', '')), 'intro.ttml');
eq('empty title', file(amllPick(idx, '', 'Adele', '')), null);

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
