import { $ } from '../core/lyrics.js';
import { poke } from '../main.js';

/* ================= the "more" menu of the bottom bar =================
   The bar only has play, progress, time and "more"; every other action is a row of this menu (index.html, #moreMenu).
   The rows are the same elements, with the same ids, that used to be buttons in a row, so nothing else changed.
   Rows marked data-close do one thing and close the menu; switches and the offset stepper keep it open. */
const moreBtn = $('moreBtn'), moreMenu = $('moreMenu');
let menuCloseT = 0;
const menuOpen = () => !moreMenu.hidden && !moreMenu.classList.contains('closing');
function setMenu(open){
  if (open === menuOpen()) return;
  clearTimeout(menuCloseT);
  moreMenu.classList.toggle('closing', !open);            // shrinks back into the button, then is really hidden
  if (open) moreMenu.hidden = false;
  else menuCloseT = setTimeout(() => { moreMenu.hidden = true; moreMenu.classList.remove('closing'); }, 170);
  moreBtn.setAttribute('aria-expanded', open);
  document.body.classList.toggle('menu-open', open);      // the controls do not fade away under an open menu (main.js)
  if (open) poke();                                       // and are shown if they had faded (opened from the keyboard)
  else closeSub();
}
moreBtn.onclick = () => setMenu(!menuOpen());
moreMenu.addEventListener('click', e => { if (e.target.closest('[data-close]')) setMenu(false); });
addEventListener('pointerdown', e => {
  if (menuOpen() && !moreMenu.contains(e.target) && !moreBtn.contains(e.target) && !e.target.closest('.ddpop, .submenu')) setMenu(false);   // (a drop-down's list and a second-level menu are outside the menu, but part of it)
}, true);
addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (subOpen){ e.stopPropagation(); const row = subRow; closeSub(); row.focus(); return; }
  if (menuOpen()){ e.stopPropagation(); setMenu(false); moreBtn.focus(); }
}, true);

/* second-level menus: a row with data-sub="id" opens the menu of that id beside this one, on the side with room (left
   of it, or right of it in the AM layout, where the menu stands at the left). On the page, not in the menu: the menu
   scrolls and would cut it off. It opens when the pointer rests on the row or when the row is clicked, and closes
   when the pointer moves on to another row of the menu, on a click elsewhere, on Escape and with the menu. */
const subs = [...document.querySelectorAll('.submenu')];
subs.forEach(s => document.body.appendChild(s));
let subOpen = null, subRow = null, subT = 0;
function openSub(row){
  const sub = $(row.dataset.sub);
  if (!sub || subOpen === sub) return;
  closeSub();
  subOpen = sub; subRow = row;
  row.setAttribute('aria-expanded', 'true'); row.classList.add('open');
  sub.hidden = false;
  subFollow();
}
function subPlace(){
  const sub = subOpen, m = moreMenu.getBoundingClientRect(), r = subRow.getBoundingClientRect(), w = sub.offsetWidth, h = sub.offsetHeight;
  const left = m.left - w - 8 >= 8;
  const x = left ? m.left - w - 8 : Math.min(m.right + 8, innerWidth - w - 8);
  const y = Math.max(8, Math.min(r.top - 7, innerHeight - h - 8));          // its first row level with this row
  Object.assign(sub.style, { left: x + 'px', top: y + 'px', transformOrigin: `${left ? '100%' : '0'} ${Math.round(r.top + r.height / 2 - y)}px` });
}
/* while the menu is still growing out of its button (and its rows coming in), it is not where it will stand: the
   second-level menu follows it frame by frame until it is still */
function subFollow(){
  if (!subOpen) return;
  subPlace();
  if (moreMenu.getAnimations({ subtree: true }).some(a => a.playState === 'running')) requestAnimationFrame(subFollow);
}
function closeSub(){
  clearTimeout(subT);
  if (!subOpen) return;
  subOpen.hidden = true;
  subRow.setAttribute('aria-expanded', 'false'); subRow.classList.remove('open');
  subOpen = subRow = null;
}
moreMenu.addEventListener('click', e => {
  const row = e.target.closest('[data-sub]');
  if (!row) return;
  if (subRow === row) closeSub();
  else { openSub(row); const first = subOpen && subOpen.querySelector('.mi:not([hidden])'); if (first && e.detail === 0) first.focus(); }   // from the keyboard: into it
});
moreMenu.addEventListener('pointerover', e => {
  const row = e.target.closest('.mi');
  if (!row || row === subRow) return clearTimeout(subT);
  clearTimeout(subT);
  if (row.dataset.sub) subT = setTimeout(() => openSub(row), 120);
  else if (subOpen) subT = setTimeout(closeSub, 260);       // on to another row: it goes, after a moment (a pointer on its way there may cross one)
});
subs.forEach(s => {
  s.addEventListener('pointerenter', () => clearTimeout(subT));
  s.addEventListener('click', e => { if (e.target.closest('[data-close]')) setMenu(false); });
});
addEventListener('resize', () => { if (subOpen) subPlace(); });

/* the status line says what just happened (song found, lyrics source, cover replaced ...) and then gets out of the way */
const statusEl = $('status');
let statusT = 0;
function statusShow(){
  statusEl.classList.remove('quiet');
  clearTimeout(statusT);
  statusT = setTimeout(() => statusEl.classList.add('quiet'), 7000);
}
new MutationObserver(statusShow).observe(statusEl, { childList: true, characterData: true, subtree: true });
statusShow();
