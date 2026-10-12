// Where a hover note is placed (web/js/ui/tooltip.js). Run: node tests/test_tooltip.js
const { moduleSource } = require('./module-source');
const { tipPlace } = new Function(moduleSource('ui/tooltip.js') + '\nreturn { tipPlace };')();
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '   ' + extra : '')); };
const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });
const VW = 1000, VH = 600, W = 120, H = 30;

const mid = tipPlace(rect(400, 100, 40, 40), W, H, 405, VW, VH);
check('under the element, centred on it', !mid.up && mid.top === 148 && mid.left === 360 && mid.ox === 60, JSON.stringify(mid));
const low = tipPlace(rect(400, 540, 40, 40), W, H, 405, VW, VH);
check('above it when the window ends first', low.up && low.top === 502, JSON.stringify(low));
const bar = tipPlace(rect(400, 500, 40, 40), W, H, 405, VW, VH);
check('above it too when it would only just fit under (the bottom bar)', bar.up && bar.top === 462, JSON.stringify(bar));
const corner = tipPlace(rect(970, 0, 24, 24), W, H, 980, VW, VH);
check('kept inside the window, still growing out of the element', corner.left === VW - W - 8 && corner.ox === 110, JSON.stringify(corner));
const edge = tipPlace(rect(0, 100, 20, 20), W, H, 5, VW, VH);
check('the same at the left edge', edge.left === 8 && edge.ox === 2, JSON.stringify(edge));
const row = tipPlace(rect(100, 100, 600, 40), W, H, 250, VW, VH);
check('a whole row: centred on the pointer', row.left === 190, JSON.stringify(row));
const rowKey = tipPlace(rect(100, 100, 600, 40), W, H, null, VW, VH);
check('a whole row reached with the keyboard: centred on the row', rowKey.left === 340, JSON.stringify(rowKey));
const tight = tipPlace(rect(400, 10, 40, 580), W, H, 405, VW, VH);
check('no room above either: stays under', !tight.up, JSON.stringify(tight));

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
