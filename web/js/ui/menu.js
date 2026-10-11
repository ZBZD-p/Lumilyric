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
}
moreBtn.onclick = () => setMenu(!menuOpen());
moreMenu.addEventListener('click', e => { if (e.target.closest('[data-close]')) setMenu(false); });
addEventListener('pointerdown', e => {
  if (menuOpen() && !moreMenu.contains(e.target) && !moreBtn.contains(e.target) && !e.target.closest('.ddpop')) setMenu(false);   // (a drop-down's list is outside the menu, but part of it)
}, true);
addEventListener('keydown', e => {
  if (e.key === 'Escape' && menuOpen()){ e.stopPropagation(); setMenu(false); moreBtn.focus(); }
}, true);

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
