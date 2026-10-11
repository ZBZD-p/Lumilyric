import { late } from '../core/late.js';
import { $, setCur } from '../core/lyrics.js';
import { FONT_STACK_EN, FONT_STACK_ZH, fontName, fx } from '../core/settings.js';
import { render, segCache } from '../render/view-dom.js';
import { applyFx, saveFx } from './ui-effects.js';

/* ================= the lyrics' font (settings card, 字体) =================
   Two groups, 歌词 and 译文; each has a Chinese font, an English font, a bold switch and a size scale. Only the lyrics
   change (the cover's title and the page's own text keep their fonts).
   Where the list of fonts comes from: a short list of common fonts, of which only the ones installed on this computer
   are shown (found by measuring: a text drawn in an absent font comes out as wide as in the fallback); or, after
   「读取全部系统字体」, every font the system has (the browser asks for permission once; Chrome / Edge only). */
const COMMON_ZH = [
  ['Microsoft YaHei', '微软雅黑'], ['DengXian', '等线'], ['SimHei', '黑体'], ['SimSun', '宋体'], ['KaiTi', '楷体'], ['FangSong', '仿宋'],
  ['Microsoft JhengHei', '微软正黑'], ['PingFang SC', '苹方'], ['Heiti SC', '黑体-简'], ['Songti SC', '宋体-简'], ['Kaiti SC', '楷体-简'],
  ['Noto Sans SC', '思源黑体'], ['Noto Serif SC', '思源宋体'], ['Source Han Sans SC', '思源黑体 (Adobe)'], ['LXGW WenKai', '霞鹜文楷'],
  ['STXihei', '华文细黑'], ['STSong', '华文宋体'], ['STKaiti', '华文楷体'], ['Yu Gothic', '游ゴシック'], ['Meiryo', 'Meiryo'],
];
const COMMON_EN = [
  ['Segoe UI', 'Segoe UI'], ['Arial', 'Arial'], ['Arial Black', 'Arial Black'], ['Helvetica Neue', 'Helvetica Neue'], ['Helvetica', 'Helvetica'],
  ['Verdana', 'Verdana'], ['Tahoma', 'Tahoma'], ['Trebuchet MS', 'Trebuchet MS'], ['Calibri', 'Calibri'], ['Bahnschrift', 'Bahnschrift'],
  ['Georgia', 'Georgia'], ['Times New Roman', 'Times New Roman'], ['Palatino Linotype', 'Palatino'], ['Cambria', 'Cambria'], ['Garamond', 'Garamond'],
  ['Impact', 'Impact'], ['Consolas', 'Consolas'], ['Courier New', 'Courier New'], ['Comic Sans MS', 'Comic Sans MS'], ['Archivo', 'Archivo（默认）'],
  ['Inter', 'Inter'], ['Roboto', 'Roboto'], ['Montserrat', 'Montserrat'],
];
/* The system lists fonts by their English family name (queryLocalFonts gives no local names), so the common Chinese
   and Japanese ones get the name people know them by. Used for the whole list, which shows these first. */
const LOCAL_NAMES = {
  'Microsoft YaHei': '微软雅黑', 'Microsoft YaHei UI': '微软雅黑 UI', 'DengXian': '等线', 'SimHei': '黑体', 'SimSun': '宋体', 'NSimSun': '新宋体',
  'SimSun-ExtB': '宋体-ExtB', 'SimSun-ExtG': '宋体-ExtG', 'KaiTi': '楷体', 'FangSong': '仿宋', 'YouYuan': '幼圆', 'LiSu': '隶书',
  'Microsoft JhengHei': '微软正黑体', 'Microsoft JhengHei UI': '微软正黑体 UI', 'MingLiU': '细明体', 'PMingLiU': '新细明体', 'DFKai-SB': '标楷体',
  'FZShuTi': '方正舒体', 'FZYaoti': '方正姚体', 'STXihei': '华文细黑', 'STHeiti': '华文黑体', 'STKaiti': '华文楷体', 'STSong': '华文宋体',
  'STFangsong': '华文仿宋', 'STZhongsong': '华文中宋', 'STCaiyun': '华文彩云', 'STHupo': '华文琥珀', 'STLiti': '华文隶书', 'STXingkai': '华文行楷',
  'STXinwei': '华文新魏', 'PingFang SC': '苹方-简', 'PingFang TC': '苹方-繁', 'Heiti SC': '黑体-简', 'Songti SC': '宋体-简', 'Kaiti SC': '楷体-简',
  'Noto Sans SC': '思源黑体', 'Noto Serif SC': '思源宋体', 'Source Han Sans SC': '思源黑体 (Adobe)', 'Source Han Serif SC': '思源宋体 (Adobe)',
  'LXGW WenKai': '霞鹜文楷', 'HarmonyOS Sans SC': '鸿蒙黑体', 'Yu Gothic': '游ゴシック', 'Yu Mincho': '游明朝', 'Meiryo': 'メイリオ', 'MS Gothic': 'MS ゴシック',
  'Malgun Gothic': '맑은 고딕',
};
const fontLabel = n => LOCAL_NAMES[n] ? LOCAL_NAMES[n] + '（' + n + '）' : n;
const BASES = ['monospace', 'serif', 'sans-serif'];
let probe = null;
function installed(name){
  probe = probe || document.createElement('canvas').getContext('2d');
  const text = 'mmmmmmmmmmlli1WM我的歌词字体', size = '72px';
  return BASES.some(b => { probe.font = `${size} ${b}`; const w0 = probe.measureText(text).width; probe.font = `${size} "${name}",${b}`; return probe.measureText(text).width !== w0; });
}
const common = {
  zh: COMMON_ZH.filter(([n]) => installed(n)),
  en: COMMON_EN.filter(([n]) => installed(n)),
};
let allFonts = null;                                   // after 「读取全部系统字体」: [family, ...]

const GROUPS = { main: 'Main', sub: 'Sub' };
const idOf = (g, k) => 'fxFont' + GROUPS[g] + k;       // fxFontMainZh, fxFontMainEn, fxFontMainBold, fxFontMainS ...
function fillSelect(sel, kind, current){
  const list = allFonts ? allFonts.map(n => [n, fontLabel(n)]) : common[kind];
  sel.textContent = '';
  const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
  add('', '默认');
  list.forEach(([n, t]) => add(n, t));
  if (current && !list.some(([n]) => n === current)) add(current, current + '（当前电脑上没有找到）');
  sel.value = current || '';
}
/* the web view reads these (style.css, .line); the canvas reads fx.font itself (lyricFont in settings.js) */
function applyFontVars(){
  const R = document.documentElement.style, M = fx.font.main, S = fx.font.sub;
  const set = (k, v) => v ? R.setProperty(k, v) : R.removeProperty(k);
  set('--lyr-zh', M.zh ? fontName(M.zh) + FONT_STACK_ZH : '');
  set('--lyr-en', M.en ? fontName(M.en) + FONT_STACK_EN : '');
  set('--lyr-w', M.bold ? '' : '400');                 // bold = the page's own weights (the CSS fallbacks)
  set('--lyr-sub', S.zh || S.en ? (S.zh ? fontName(S.zh) : '') + (S.en ? fontName(S.en) : '') + FONT_STACK_ZH : '');
  set('--lyr-sub-w', S.bold ? '700' : '');
  R.setProperty('--lyr-s', String(M.s));
  R.setProperty('--lyr-sub-s', String(S.s));
}
function syncFontUi(){
  for (const g of Object.keys(GROUPS)){
    const F = fx.font[g];
    fillSelect($(idOf(g, 'Zh')), 'zh', F.zh);
    fillSelect($(idOf(g, 'En')), 'en', F.en);
    const s = $(idOf(g, 'S'));
    $(idOf(g, 'Bold')).checked = !!F.bold;
    s.value = Math.round(F.s * 100); $(idOf(g, 'SV')).textContent = Math.round(F.s * 100) + '%';
    s.style.setProperty('--p', ((s.value - s.min) / (s.max - s.min) * 100) + '%');
  }
}
/* a font setting changed: what is drawn on the canvas is rebuilt (applyFx sees fx.font in its key), the web view re-lays out */
function changed(){
  saveFx(); applyFontVars(); applyFx();
  segCache.clear(); setCur(null); render(true);
}
for (const g of Object.keys(GROUPS)){
  $(idOf(g, 'Zh')).onchange = e => { fx.font[g].zh = e.target.value; changed(); };
  $(idOf(g, 'En')).onchange = e => { fx.font[g].en = e.target.value; changed(); };
  $(idOf(g, 'Bold')).onchange = e => { fx.font[g].bold = e.target.checked; changed(); };
  $(idOf(g, 'S')).oninput = e => { fx.font[g].s = +e.target.value / 100; changed(); syncSliders(g); };
}
function syncSliders(g){
  const F = fx.font[g], s = $(idOf(g, 'S'));
  $(idOf(g, 'SV')).textContent = Math.round(F.s * 100) + '%';
  s.style.setProperty('--p', ((s.value - s.min) / (s.max - s.min) * 100) + '%');
}
$('fxFontAll').onclick = async () => {
  const note = $('fxFontNote');
  if (!window.queryLocalFonts){ note.textContent = '这个浏览器不能读取系统字体列表，用上面列出的常用字体就行；其它字体可以把名字告诉我加进列表。'; return; }
  try {
    const list = await window.queryLocalFonts();
    // the Chinese / Japanese fonts people know come first (in the order of the list above), then the rest A to Z
    const names = [...new Set(list.map(f => f.family))], known = Object.keys(LOCAL_NAMES);
    allFonts = [...known.filter(n => names.includes(n)), ...names.filter(n => !LOCAL_NAMES[n]).sort((a, b) => a.localeCompare(b))];
    syncFontUi();
    note.textContent = `已列出这台电脑的 ${allFonts.length} 种字体。`;
    $('fxFontAll').hidden = true;
  } catch (err){
    note.textContent = '没有得到读取字体的许可（浏览器会问一次，请点「允许」）。';
  }
};
/* applyFx (ui-effects.js) calls this: the settings were replaced (restore defaults) or loaded */
function applyFontFx(){ applyFontVars(); syncFontUi(); }
applyFontFx();

Object.assign(late, { applyFontFx });
