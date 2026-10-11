import { $ } from '../core/lyrics.js';

/* ================= desktop version only (desktop/app.py): the window's own buttons =================
   The desktop window has no title bar; the page draws minimise / maximise / close itself (.deskbar in index.html)
   and its top strip drags the window. In a browser window.pywebview never appears and nothing here runs. */
function desktopInit(){
  const api = window.pywebview && window.pywebview.api;
  if (!api || !api.win_close || document.body.classList.contains('desktop')) return;
  document.body.classList.add('desktop');
  $('dkMin').onclick = () => api.win_minimize();
  $('dkMax').onclick = () => api.win_maximize();
  $('dkX').onclick = () => api.win_close();
  /* real full screen (over the taskbar): the dot, F11; Esc leaves it */
  let full = false, busy = false;
  const toggleFull = async () => {
    if (busy) return;
    busy = true;
    try { full = !!(await api.win_fullscreen()); document.body.classList.toggle('deskfull', full); } catch(e){}
    busy = false;
  };
  $('dkFull').onclick = toggleFull;
  addEventListener('keydown', e => {
    if (e.key === 'F11' || (e.key === 'Escape' && full && !document.querySelector('.modal:not([hidden]):not(.drawer)'))){ e.preventDefault(); toggleFull(); }
  });
}
window.addEventListener('pywebviewready', desktopInit);
desktopInit();
