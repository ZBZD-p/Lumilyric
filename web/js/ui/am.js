import { late } from '../core/late.js';
import { $, audio } from '../core/lyrics.js';
import { fx } from '../core/settings.js';

/* ================= AM 布局: the buttons around the picture =================
   The layout itself is coverLayout (render/frame.js) and body.am (style.css). Apple Music's full-screen player has
   more buttons than this player has things to do; they are all there so that the picture is complete. Those with
   something to do here do it:
     the cross (top left)        leaves the AM layout
     the volume (top right)      sets the volume of the audio file that is loaded, the speaker mutes it
     文A (bottom right)          switches the lyrics between both languages and English: the header's switch is hidden
     the speech bubble beside it shows or hides the lyrics: hidden, the cover and its controls glide to the middle
                                 (amHideNow, render/frame.js)
   The rest (.amph: AirPlay, favourite, shuffle, repeat) only hold their place, and say so. */
$('amX').onclick = () => {
  const c = $('fxAM');
  if (c.checked){ c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })); }
};
$('amLang').onclick = () => {
  const order = ['both', 'en'], on = document.querySelector('.seg button[data-mode][aria-pressed="true"]');
  const next = order[(order.indexOf(on ? on.dataset.mode : 'both') + 1) % order.length];
  const b = document.querySelector(`.seg button[data-mode="${next}"]`);
  if (b) b.click();
};
$('amLyr').onclick = () => { fx.amLyrics = fx.amLyrics === false; late.saveFx(); late.applyFx(); };
document.querySelectorAll('.amtog, #amStar').forEach(b => b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'))));      // shuffle, repeat, favourite: on / off to look at
document.querySelectorAll('.amph').forEach(b => b.onclick = () => { $('status').textContent = `「${b.getAttribute('aria-label')}」还没有功能，先占个位置`; });

/* the volume of the loaded audio file (nothing to set while a player is followed: that sound is the player's own) */
let vol = 1, before = 1;
try { const v = parseFloat(localStorage.getItem('lrc-am-vol')); if (isFinite(v)) vol = Math.max(0, Math.min(1, v)); } catch (e){}
function showVol(){
  const el = $('amVol');
  el.value = Math.round(vol * 100); el.style.setProperty('--p', vol * 100 + '%');
  $('amMute').classList.toggle('off', vol === 0);
  if (audio && audio.volume !== vol) audio.volume = vol;
}
$('amVol').oninput = e => { vol = e.target.value / 100; try { localStorage.setItem('lrc-am-vol', vol); } catch (err){} showVol(); };
$('amMute').onclick = () => { if (vol > 0){ before = vol; vol = 0; } else vol = before || 1; showVol(); };
showVol();
setInterval(() => { if (audio && audio.volume !== vol) audio.volume = vol; }, 1000);      // an audio file loaded later takes the volume too
