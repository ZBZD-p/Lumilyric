/* Entry point: index.html loads only this file (after vendor/mp4-muxer.js). Every module is listed here in the order
   the page used to load its scripts in; each module imports only modules that come before it in this list (a name from
   a later one goes through `late`, core/late.js), so the modules run exactly in this order. */
import './core/glide.js';
import './core/core.js';
import './core/lyrics.js';
import './core/settings.js';
import './render/view-dom.js';
import './render/text-canvas.js';
import './background/look-melt.js';
import './background/background.js';
import './background/cover-extract.js';
import './render/bloom.js';
import './render/song-transition.js';
import './render/layout-scroll.js';
import './render/layout-words.js';
import './render/frame.js';
import './export/export.js';
import './core/sync.js';
import './ui/ui-effects.js';
import './ui/fonts.js';
import './player/library.js';
import './player/helper.js';
import './player/follow.js';
import './glass/glass.js';
import './main.js';
import './glass/seg-thumb.js';
import './glass/glass-toggle.js';
import './glass/glass-slider.js';
import './ui/dropdown.js';
import './ui/tooltip.js';
import './render/smooth-scroll.js';
import './ui/menu.js';
import './ui/am.js';
import './ui/desktop.js';
