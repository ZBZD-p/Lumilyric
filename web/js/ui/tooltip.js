/* ================= one look for every hover note =================
   The browser draws the note of a title="" itself (system box, system font, its own delay) and a page cannot style
   it. So the page shows the notes: when the pointer comes over an element with a title, the text moves to data-tip
   (no title, no browser note) and is shown in one small card drawn by the page (#tip, one for all of them), frosted
   like the drop-down lists. Nothing else changes: the page goes on writing title="" in index.html and el.title = ...
   in code; a title set while its note is up changes the note at once.

   The note comes after the pointer has rested for a moment, and at once when another note was up a moment ago (going
   along a row of buttons). It goes away when the pointer leaves, on a press, a key or the wheel, and stays away until
   the pointer comes back. Keyboard focus shows it too. A finger gets none: there is no hovering with a finger. */
const TIP_WAIT = 600, TIP_WARM = 400, TIP_GAP = 8, TIP_EDGE = 8, TIP_ROOM = 40, TIP_WIDE = 220;
let tipEl = null, tipFor = null, tipT = 0, tipUp = false, tipGone = -1e9, tipX = null;

/* where the card goes: under the element and centred on it (on the pointer when the element is a whole row), above
   it when it would be squeezed against the bottom of the window (the bottom bar), never off the window. ox is where
   the element is, seen from the card's left edge: the card grows out of that point. */
function tipPlace(r, w, h, x, vw, vh){
  const cx = x != null && r.width > TIP_WIDE ? Math.max(r.left, Math.min(r.right, x)) : r.left + r.width / 2;
  const up = r.bottom + TIP_GAP + h > vh - TIP_ROOM && r.top - TIP_GAP - h >= TIP_EDGE;
  const left = Math.max(TIP_EDGE, Math.min(vw - w - TIP_EDGE, cx - w / 2));
  return { left, top: up ? r.top - TIP_GAP - h : r.bottom + TIP_GAP, up, ox: Math.max(0, Math.min(w, cx - left)) };
}
function tipTake(el){                        // the title becomes data-tip; people using a screen reader keep the text
  const t = el.getAttribute('title');
  if (t === null) return;
  el.removeAttribute('title');
  if (t){ el.dataset.tip = t; el.setAttribute('aria-description', t); }
  else { delete el.dataset.tip; el.removeAttribute('aria-description'); }
}
function tipHide(){
  clearTimeout(tipT);
  if (!tipUp) return;
  tipUp = false; tipGone = performance.now();
  tipEl.classList.remove('on');
}
function tipShow(){
  const el = tipFor, text = el && el.isConnected ? el.dataset.tip : '';
  const r = text ? el.getBoundingClientRect() : null;
  if (!r || !(r.width || r.height)) return tipHide();
  if (!tipEl){
    tipEl = document.createElement('div');
    tipEl.id = 'tip'; tipEl.className = 'tip'; tipEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(tipEl);
  }
  tipEl.textContent = text;
  tipEl.style.left = tipEl.style.top = '0';                 // measured at the corner, where nothing squeezes it
  const p = tipPlace(r, tipEl.offsetWidth, tipEl.offsetHeight, tipX, innerWidth, innerHeight);
  tipEl.style.left = p.left + 'px'; tipEl.style.top = p.top + 'px';
  tipEl.style.transformOrigin = p.ox + 'px ' + (p.up ? '100%' : '0');
  tipEl.classList.add('on'); tipUp = true;
}
function tipAim(el, x){
  if (el === tipFor) return;
  const warm = tipUp || performance.now() - tipGone < TIP_WARM;
  tipHide();
  tipFor = el; tipX = x;
  if (!el) return;
  if (warm) tipShow(); else tipT = setTimeout(tipShow, TIP_WAIT);
}
const tipOf = t => { const el = t && t.closest ? t.closest('[title],[data-tip]') : null; if (el) tipTake(el); return el; };

if (typeof document !== 'undefined'){
  addEventListener('pointerover', e => { if (e.pointerType !== 'touch' && !e.buttons) tipAim(tipOf(e.target), e.clientX); }, true);
  addEventListener('pointermove', e => { if (!tipUp) tipX = e.clientX; }, { capture: true, passive: true });
  document.documentElement.addEventListener('pointerleave', () => tipAim(null));
  addEventListener('focusin', e => { if (e.target.matches && e.target.matches(':focus-visible')) tipAim(tipOf(e.target), null); });
  addEventListener('focusout', () => tipAim(null));
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'scroll', 'resize', 'blur']) addEventListener(ev, tipHide, { capture: true, passive: true });
  new MutationObserver(list => {
    for (const m of list){ tipTake(m.target); if (m.target === tipFor && tipUp) tipShow(); }
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['title'] });
}
