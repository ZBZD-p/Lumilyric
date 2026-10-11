/* ================= one look for every drop-down =================
   The browser draws a <select>'s list itself (white box, system font) and a page cannot style it. So each <select>
   stays in the page as the thing that holds the value, out of sight, and gets a button showing the chosen option;
   the button opens a list drawn by the page (#ddPop, one for all of them): frosted like the menus, the chosen
   option ticked, arrow keys / Enter / Esc, opening upwards when there is no room below.
   Choosing an option sets the <select> and fires its "change", so the rest of the page needs no changes; options
   added or a value set by other code show up at once. */
const DD_CHEV = '<svg class="ddc" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3"/></svg>';
const DD_TICK = '<svg class="ddt" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.5l2.5 2.5 4.5-5.5"/></svg>';
let ddPop = null, ddOpen = null;             // the list, and { sel, btn, active } while it is open
function ddClose(focus){
  if (!ddOpen) return;
  const { btn } = ddOpen;
  ddOpen = null;
  btn.setAttribute('aria-expanded', 'false');
  ddPop.classList.add('closing');
  setTimeout(() => { if (!ddOpen){ ddPop.hidden = true; ddPop.classList.remove('closing'); } }, 140);
  if (focus) btn.focus();
}
function ddMark(){
  [...ddPop.children].forEach((o, i) => o.classList.toggle('active', i === ddOpen.active));
  const a = ddPop.children[ddOpen.active];
  if (a) a.scrollIntoView({ block: 'nearest' });
}
function ddPick(i){
  const { sel } = ddOpen, o = sel.options[i];
  if (!o || o.disabled) return;
  const changed = sel.selectedIndex !== i;
  sel.selectedIndex = i;
  ddClose(true);
  if (changed){ sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); }
}
function ddShow(sel, btn){
  if (!ddPop){
    ddPop = document.createElement('div');
    ddPop.id = 'ddPop'; ddPop.className = 'ddpop'; ddPop.setAttribute('role', 'listbox'); ddPop.hidden = true;
    document.body.appendChild(ddPop);
    ddPop.addEventListener('click', e => { const o = e.target.closest('.ddo'); if (o && ddOpen) ddPick(+o.dataset.i); });
    ddPop.addEventListener('pointermove', e => { const o = e.target.closest('.ddo'); if (o && ddOpen && ddOpen.active !== +o.dataset.i){ ddOpen.active = +o.dataset.i; ddMark(); } });
    addEventListener('pointerdown', e => { if (ddOpen && !ddPop.contains(e.target) && !ddOpen.btn.contains(e.target)) ddClose(); }, true);
    addEventListener('resize', () => ddClose());
    addEventListener('scroll', e => { if (ddOpen && !ddPop.contains(e.target)) ddClose(); }, true);
    addEventListener('keydown', e => {
      if (!ddOpen) return;
      const n = ddOpen.sel.options.length, k = e.key;
      if (k === 'Escape' || k === 'Tab'){ ddClose(k === 'Escape'); if (k === 'Tab') return; }
      else if (k === 'ArrowDown' || k === 'ArrowUp'){ ddOpen.active = (ddOpen.active + (k === 'ArrowDown' ? 1 : n - 1)) % n; ddMark(); }
      else if (k === 'Home' || k === 'End'){ ddOpen.active = k === 'Home' ? 0 : n - 1; ddMark(); }
      else if (k === 'Enter' || k === ' ') ddPick(ddOpen.active);
      else return;
      e.preventDefault(); e.stopPropagation();
    }, true);
  }
  ddPop.textContent = '';
  [...sel.options].forEach((o, i) => {
    const d = document.createElement('div');
    d.className = 'ddo'; d.dataset.i = i; d.setAttribute('role', 'option'); d.setAttribute('aria-selected', i === sel.selectedIndex);
    if (o.disabled) d.setAttribute('aria-disabled', 'true');
    d.innerHTML = DD_TICK; d.appendChild(document.createTextNode(o.textContent));
    ddPop.appendChild(d);
  });
  ddOpen = { sel, btn, active: Math.max(0, sel.selectedIndex) };
  btn.setAttribute('aria-expanded', 'true');
  ddPop.classList.remove('closing'); ddPop.hidden = false;
  // under the button, as wide as it at least; above it when the window ends first; never off the window
  const r = btn.getBoundingClientRect();
  ddPop.style.minWidth = r.width + 'px'; ddPop.style.maxHeight = '';
  const h = ddPop.offsetHeight, w = ddPop.offsetWidth, below = innerHeight - r.bottom - 12, above = r.top - 12;
  const up = h > below && above > below;
  ddPop.style.maxHeight = Math.max(80, up ? above : below) + 'px';
  const hh = Math.min(h, Math.max(80, up ? above : below));
  ddPop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
  ddPop.style.top = (up ? r.top - 6 - hh : r.bottom + 6) + 'px';
  ddPop.style.transformOrigin = up ? '85% 100%' : '85% 0';
  ddMark();
}
function ddEnhance(sel){
  if (sel.dataset.dd) return;
  sel.dataset.dd = '1';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'dd'; btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
  if (sel.getAttribute('aria-label')) btn.setAttribute('aria-label', sel.getAttribute('aria-label'));
  btn.innerHTML = '<span class="ddv"></span>' + DD_CHEV;
  sel.classList.add('dd-native'); sel.tabIndex = -1; sel.before(btn);          // before it: a click on the surrounding label then opens the list
  const sync = () => {
    const o = sel.options[sel.selectedIndex];
    btn.firstChild.textContent = o ? o.textContent : '';
    btn.hidden = sel.hidden; btn.disabled = sel.disabled;
    if (ddOpen && ddOpen.sel === sel && (sel.hidden || sel.disabled)) ddClose();
  };
  btn.addEventListener('click', e => { e.preventDefault(); if (ddOpen && ddOpen.sel === sel) ddClose(); else ddShow(sel, btn); });
  btn.addEventListener('keydown', e => { if (!ddOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')){ e.preventDefault(); ddShow(sel, btn); } });
  sel.addEventListener('change', sync);
  // a <label for=...> still points at the <select>: pass its click and focus on to the button
  sel.addEventListener('click', () => btn.click());
  sel.addEventListener('focus', () => btn.focus());
  // set from code (no event): the value, the chosen index, the options themselves, hidden / disabled
  for (const prop of ['value', 'selectedIndex']){
    const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, prop);
    Object.defineProperty(sel, prop, { get(){ return d.get.call(this); }, set(v){ d.set.call(this, v); sync(); }, configurable: true });
  }
  new MutationObserver(sync).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'selected'] });
  sync();
}
if (typeof document !== 'undefined') document.querySelectorAll('select').forEach(ddEnhance);
