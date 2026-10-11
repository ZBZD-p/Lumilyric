/* The page's modules (web/js, ES modules) as plain source text for the tests: the tests evaluate a file inside
   new Function(...) so they need it without its import lines and export list. `late` (core/late.js) is stubbed, as
   the modules register themselves there when they load. */
const fs = require('fs'), path = require('path');
const WEB_JS = path.join(__dirname, '..', 'web', 'js');
function moduleSource(rel){
  return fs.readFileSync(path.join(WEB_JS, rel), 'utf8')
    .replace(/^import [^\n]*\n/gm, '')
    .replace(/^export \{[^}]*\};?\n/gm, '');
}
const LATE_STUB = 'const late = {};\n';
module.exports = { moduleSource, LATE_STUB, WEB_JS };
