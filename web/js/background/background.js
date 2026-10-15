import { late } from '../core/late.js';
import { $, mode, playing, song } from '../core/lyrics.js';
import { COVER_GLIDE, coverGlideNow, dragSize, fx, hexRGB, lt, now, prof, windowResizing } from '../core/settings.js';
import { oneLine } from '../render/view-dom.js';
import { canvasMeasurer, lazyTimeline } from '../render/text-canvas.js';
import { createLookMelt } from './look-melt.js';

export {
  GRAIN,
  analyzeBass,
  bassBuild,
  bassBusy,
  bassEnv,
  coverBmp,
  coverHi,
  coverLabel,
  coverURL,
  curPalette,
  drawFlowBg,
  drawLiveBg,
  drawLiveGL,
  exportDith,
  exportFlowGL,
  exportProf,
  exportProfText,
  flowGLx,
  flowPalette,
  followBassOn,
  liveBloom,
  liveGLVer,
  liveGLx,
  mkCanvas,
  paletteFrom,
  prepCoverTex,
  pulseGate,
  pulseHz,
  setBgDirty,
  setCoverBmp,
  setCoverHi,
  setCoverLabel,
  setCoverURL,
  setExportDith,
  setExportProf,
  setExportProfText,
  setFlowPalette,
  setLiveGLLast,
  setLiveGLVer,
};

/* Flowing background, beat pulse, live canvas view */
/* ================= flowing cover background (Apple Music style) =================
   Four copies of the album cover, each showing a different crop, drift and turn slowly on top of each
   other; the result is blurred heavily, saturated and darkened. Painted small (320 px wide) and scaled
   up: the blur hides the low resolution, so it is cheap enough for every frame of an export.
   Everything is a function of the song time, so the exported video matches what the page shows. */
let coverBmp = null, coverHi = null, coverURL = '', coverLabel = '';
const mkCanvas = (w, h) => typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
const FILTER_OK = (() => { try { return 'filter' in document.createElement('canvas').getContext('2d'); } catch(e){ return false; } })();
/* palette: a few harmonious main colours of the cover (median cut, small specks and clashing hues dropped) */
const TAU = Math.PI * 2;
const FLOW_DEFAULT = ['#241a5c', '#7a2d8f', '#c2416b', '#1f6f8c', '#d9774a', '#3a4fc0'];
let flowPalette = FLOW_DEFAULT.map(h => hexRGB(h));
const curPalette = () => flowPalette.slice(0, Math.max(2, fx.bg.colors || 5));
function rgb2hsl([r, g, b]){
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hsl2rgb([h, s, l]){
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map(v => Math.round((v + m) * 255));
}
function paletteFrom(img, want = 6){
  const n = 48, c = mkCanvas(n, n), x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, n, n);
  const d = x.getImageData(0, 0, n, n).data, px = [];
  for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
  // median cut into 12 boxes
  let boxes = [px];
  while (boxes.length < 16){
    boxes.sort((a, b) => b.length - a.length);
    const B = boxes.shift();
    if (B.length < 8){ boxes.push(B); break; }
    const rng = [0, 1, 2].map(k => Math.max(...B.map(p => p[k])) - Math.min(...B.map(p => p[k])));
    const k = rng.indexOf(Math.max(...rng));
    B.sort((a, b) => a[k] - b[k]);
    boxes.push(B.slice(0, B.length >> 1), B.slice(B.length >> 1));
  }
  let cols = boxes.map(B => {
    const m = [0, 1, 2].map(k => B.reduce((a, p) => a + p[k], 0) / B.length);
    const [, s, l] = rgb2hsl(m);
    // big, coloured areas count most; near-black / near-white / grey areas count less
    return { rgb: m, n: B.length, w: B.length * (0.25 + s) * (l < 0.08 || l > 0.92 ? 0.3 : 1) };
  }).sort((a, b) => b.w - a.w);
  // merge colours that look alike, keep up to 4
  const out = [];
  for (const c of cols){
    if (out.length >= want) break;
    if (c.n < n * n * 0.012 && out.length >= 2) continue;         // specks (text, small details) are dropped
    if (out.some(o => Math.hypot(...o.rgb.map((v, k) => v - c.rgb[k])) < 34)) continue;
    out.push(c);
  }
  // even out brightness and saturation so the colours sit well together
  let hsl = out.map(c => rgb2hsl(c.rgb)).map(([h, s, l]) => [h, Math.min(0.85, s * 1.15), Math.min(0.58, Math.max(0.22, l))]);
  for (let i = 0; hsl.length < want; i++){      // too few colours: add neighbours of the existing ones
    const [h, s, l] = hsl[i % Math.max(1, hsl.length)] || [260, 0.5, 0.35];
    hsl.push([(h + (i % 2 ? 24 : -24) + 360) % 360, s * 0.92, Math.min(0.58, Math.max(0.2, l * (i % 2 ? 0.82 : 1.12)))]);
  }
  return hsl.map(hsl2rgb);
}
/* soft light pools of the palette colours drifting over a dark base of the main colour */
const FLOW_BLOBS = [
  // colour slot, drift radius x/y (fraction of the frame), speed x/y (cycles per second), phase, size (x diagonal)
  { c: 1, ox: .30, oy: .28, fx: .023, fy: .031, ph: 0.4, r: .55 },
  { c: 2, ox: .34, oy: .24, fx: .029, fy: .019, ph: 2.1, r: .50 },
  { c: 3, ox: .28, oy: .32, fx: .017, fy: .027, ph: 3.7, r: .52 },
  { c: 4, ox: .36, oy: .30, fx: .021, fy: .035, ph: 5.2, r: .46 },
  { c: 5, ox: .26, oy: .34, fx: .033, fy: .015, ph: 1.3, r: .42 },
  { c: 0, ox: .38, oy: .22, fx: .015, fy: .025, ph: 4.4, r: .48 },
  { c: 2, ox: .22, oy: .36, fx: .027, fy: .021, ph: 2.9, r: .36 }
];
const FALLOFF = [[0, 1], [0.2, 0.92], [0.4, 0.68], [0.6, 0.36], [0.8, 0.11], [1, 0]];     // close to a gaussian
function paintFlow(x, w, h, t){
  const P = curPalette(), T = t * fx.bg.speed, D = Math.hypot(w, h);
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.globalCompositeOperation = 'source-over'; x.globalAlpha = 1; if (FILTER_OK) x.filter = 'none';
  const [h0, s0, l0] = rgb2hsl(P[0]);
  x.fillStyle = `rgb(${hsl2rgb([h0, s0, l0 * 0.55]).join(',')})`;
  x.fillRect(0, 0, w, h);
  for (const B of FLOW_BLOBS){
    const cx = w * (0.5 + B.ox * Math.cos(T * B.fx * TAU + B.ph));
    const cy = h * (0.5 + B.oy * Math.sin(T * B.fy * TAU + B.ph * 1.7));
    const r = D * B.r * (1 + 0.12 * Math.sin(T * 0.013 * TAU + B.ph * 2.3));
    const [cr, cg, cb] = P[B.c % P.length];
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    for (const [o, a] of FALLOFF) g.addColorStop(o, `rgba(${cr},${cg},${cb},${(a * 0.85).toFixed(3)})`);
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
  }
}
const flowBufs = new Map();
function flowFrame(w, h, t){
  const blur = w / 320 * 14, m = Math.ceil(blur * 2.5);          // margin, so the blur does not darken the edges
  let B = flowBufs.get(w + 'x' + h);
  if (!B){ B = { a: mkCanvas(w + 2 * m, h + 2 * m), b: mkCanvas(w, h) }; flowBufs.set(w + 'x' + h, B); }
  paintFlow(B.a.getContext('2d'), w + 2 * m, h + 2 * m, t);
  const y = B.b.getContext('2d');
  y.setTransform(1, 0, 0, 1, 0, 0); y.globalAlpha = 1; y.globalCompositeOperation = 'source-over';
  if (FILTER_OK) y.filter = `blur(${blur.toFixed(1)}px) saturate(${fx.bg.sat}) brightness(${(1 - fx.bg.dim).toFixed(3)})`;
  y.drawImage(B.a, -m, -m);
  if (FILTER_OK) y.filter = 'none';
  else { y.fillStyle = `rgba(0,0,0,${fx.bg.dim})`; y.fillRect(0, 0, w, h); }
  return B.b;
}
/* fine grain over the background: breaks up the colour steps (banding) of big smooth gradients */
const GRAIN = (() => {
  const n = 128, c = Object.assign(document.createElement('canvas'), { width: n, height: n }), x = c.getContext('2d'), im = x.createImageData(n, n);
  let s = 0x9e3779b9;
  for (let i = 0; i < im.data.length; i += 4){
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;                  // xorshift32
    const v = (s >>> 24) & 255;
    im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 255;
  }
  x.putImageData(im, 0, 0);
  return c;
})();
/* ---- beat pulse: the low-frequency loudness of the whole song, worked out once when the audio is loaded,
   so the live page and the exported video pulse identically ---- */
const BASS_RATE = 60;                               // values per second
let bassEnv = null, bassBusy = false;
const followBassOn = () => typeof late.followBassLive === 'function' && late.followBassLive();     // follow.js loads later
/* two settings of the pulse (背景 panel), for an analysed file and for the live sound of a player alike:
   低音范围 (fx.bg.pulseHz): what counts as bass, everything below this many Hz. 140 takes the kick drum and the bass
   line; lower, only the deepest thump is left.
   触发强度 (fx.bg.pulseGate): how strong the bass must be before anything moves. Below it the background is still;
   from there to the loudest bass it goes from nothing to the full pulse. 0 = everything moves it, as before. */
const pulseHz = () => Math.min(300, Math.max(40, +fx.bg.pulseHz || 140));
const pulseGate = v => { const g = Math.min(0.95, Math.max(0, +fx.bg.pulseGate || 0)); return g > 0 ? Math.max(0, (v - g) / (1 - g)) : v; };
/* the song's sound kept for the pulse: one channel, thinned out to about 2 kHz (plenty for what lies below 300 Hz),
   so that 低音范围 can be changed without reading the file again. per: how many of its values make one pulse value */
let bassSrc = null;
async function analyzeBass(file){
  bassEnv = null; bassSrc = null; bassBusy = true; late.applyFx();
  try {
    const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ab = await new AC(1, 44100, 44100).decodeAudioData(await file.arrayBuffer());
    const sr = ab.sampleRate, n = ab.length, chs = [...Array(ab.numberOfChannels)].map((_, i) => ab.getChannelData(i));
    const hop = Math.max(1, Math.round(sr / BASS_RATE));
    let k = 1;                                      // averaged k at a time; k divides hop, so the pulse values fall where they always did
    for (let d = Math.floor(sr / 1500); d > 1; d--) if (hop % d === 0){ k = d; break; }
    const m = Math.floor(n / k), x = new Float32Array(m);
    for (let j = 0; j < m; j++){
      let s = 0;
      for (const c of chs) for (let i = j * k, e = i + k; i < e; i++) s += c[i];
      x[j] = s / (k * chs.length);
      if ((j & 0x3ffff) === 0) await new Promise(r => setTimeout(r, 0));     // stay responsive on long songs
    }
    bassSrc = { x, rate: sr / k, per: hop / k };
    bassBuild();
  } catch (e){ bassEnv = null; }
  bassBusy = false; bgDirty = true; late.applyFx();
}
/* the pulse of the whole song from bassSrc, for the 低音范围 now set (a few ms: done again whenever that changes) */
function bassBuild(){
  if (!bassSrc) return;
  try {
    const { x, rate, per } = bassSrc, n = x.length, frames = Math.ceil(n / per);
    const a = Math.exp(-2 * Math.PI * pulseHz() / rate);    // two one-pole low-passes at 低音范围 (140 Hz: kick drum and bass)
    const env = new Float32Array(frames);
    let y1 = 0, y2 = 0, acc = 0, k = 0, f = 0;
    for (let i = 0; i < n; i++){
      y1 = (1 - a) * x[i] + a * y1; y2 = (1 - a) * y1 + a * y2;
      acc += y2 * y2;
      if (++k === per){ env[f++] = Math.sqrt(acc / k); acc = 0; k = 0; }
    }
    // "节拍": loud against the last second or so = a beat; quick attack, slower release
    const sortedL = Float32Array.from(env).sort(), ref = sortedL[Math.floor(sortedL.length * 0.97)] || 1;
    const beat = new Float32Array(frames);
    { let slow = 0, prev = 0;
      const kSlow = 1 - Math.exp(-1 / (BASS_RATE * 0.8)), rel = Math.exp(-1 / (BASS_RATE * 0.16));
      for (let i = 0; i < frames; i++){
        const v = Math.min(1.5, env[i] / ref);
        slow += (v - slow) * kSlow;
        const p = Math.max(0, Math.min(1, (v - 0.75 * slow) / 0.55)) * Math.min(1, v * 1.4);
        prev = Math.max(p, prev * rel);
        beat[i] = prev;
      } }
    // "呼吸": loudness of the low end on a log scale, 0 = quiet parts of this song, 1 = its loudest bass;
    // then eased the same way up and down (about 0.3 s), so the background breathes with the music
    // instead of jumping on every kick
    const lv = env.map(v => Math.log10(1 + 60 * v));
    const sorted = Float32Array.from(lv).sort();
    const lo = sorted[Math.floor(sorted.length * 0.1)], hi = sorted[Math.floor(sorted.length * 0.98)] || 1;
    const out = new Float32Array(frames), ease = 1 - Math.exp(-1 / (BASS_RATE * 0.3));
    let cur = 0;
    for (let i = 0; i < frames; i++){
      const v = Math.max(0, Math.min(1, (lv[i] - lo) / Math.max(1e-6, hi - lo)));
      cur += (v * v - cur) * ease;                 // squared: quiet passages stay calm, loud ones swell
      out[i] = cur;
    }
    bassEnv = { breath: out, beat };
  } catch (e){ bassEnv = null; }
  bgDirty = true;
}
function bassAt(t){
  if (followBassOn()) return late.followBassAt();      // following a player: the live system sound, not an analysed file
  if (!bassEnv || !(fx.bg.pulse > 0)) return 0;
  const E = fx.bg.pulseMode === 'beat' ? bassEnv.beat : bassEnv.breath;
  const x = t * BASS_RATE, i = Math.floor(x);
  if (i < 0 || i >= E.length - 1) return 0;
  return pulseGate(E[i] + (E[i + 1] - E[i]) * (x - i)) * fx.bg.pulse;
}
/* how the pulse shows: 节拍 = quick zoom and a flash of light, 呼吸 = slow swell with a little extra turn */
const pulseLook = () => fx.bg.pulseMode === 'beat' ? { zoom: 0.16, turn: 0, light: 0.2, grow: 0.14 } : { zoom: 0.22, turn: 0.35, light: 0, grow: 0.25 };

/* ---- GPU version of the flowing background: every pixel is computed in floating point and dithered by
   less than one colour step before it is stored as 8-bit, so smooth gradients show no bands and no visible grain ---- */
const MELT_MS = 1800;                                // how long the background takes to change to the next song's look
const FLOW_VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
const FLOW_FS = `precision highp float;
uniform vec2 res;uniform vec3 base;uniform vec3 col[7];uniform vec4 blob[7];uniform float sat,bright,seed,style,t,pulse,pzoom,pturn,plight,dith,dcell;
uniform sampler2D tex;
float h(vec2 q){return fract(sin(dot(q,vec2(12.9898,78.233)))*43758.5453);}
vec4 cw(float v){vec4 n=vec4(1.,2.,3.,4.)-v;vec4 s=n*n*n;float x=s.x,y=s.y-4.*s.x,z=s.z-4.*s.y+6.*s.x;return vec4(x,y,z,6.-x-y-z)/6.;}
vec3 bicubic(vec2 uv){                          // smooth B-spline sampling of the tiny cover: no bilinear diamonds
  vec2 ts=vec2(32.);uv=uv*ts-.5;vec2 fx=fract(uv);uv-=fx;
  vec4 xc=cw(fx.x),yc=cw(fx.y);vec4 c=uv.xxyy+vec2(-.5,1.5).xyxy;
  vec4 s=vec4(xc.xz+xc.yw,yc.xz+yc.yw);vec4 o=(c+vec4(xc.yw,yc.yw)/s)/ts.xxyy;
  vec3 s0=texture2D(tex,o.xz).rgb,s1=texture2D(tex,o.yz).rgb,s2=texture2D(tex,o.xw).rgb,s3=texture2D(tex,o.yw).rgb;
  float sx=s.x/(s.x+s.y),sy=s.z/(s.z+s.w);
  return mix(mix(s3,s2,sx),mix(s1,s0,sx),sy);
}
void main(){
  vec2 f=vec2(gl_FragCoord.x,res.y-gl_FragCoord.y);
  vec3 c=vec3(0.);
  if(style>.001){
    // the shrunken cover, turned slowly and bent by a smooth warp field (a stand-in for a bent mesh)
    vec2 p=(f/res-.5)*vec2(res.x/res.y,1.);
    float a=t*.055+pulse*pturn;                 // loud bass can nudge the turn
    p=mat2(cos(a),-sin(a),sin(a),cos(a))*p;
    p*=(.66+.05*sin(t*.071))*(1.-pzoom*pulse);   // and swells the picture
    p+=.11*vec2(sin(p.y*3.1+t*.23),sin(p.x*2.7-t*.19+1.3));
    p+=.05*vec2(sin(p.y*5.9-t*.13+2.1),sin(p.x*5.1+t*.11+.7));
    c=bicubic(p+.5);
    float d=distance(f/res,vec2(.5));
    c*=mix(.7,1.,smoothstep(.85,.3,d));       // soft vignette
  }
  if(style<.999){                                // style between 0 and 1: both are drawn and mixed (the style switch melts)
    vec3 b=base;
    for(int i=0;i<7;i++){
      float d=length(f-blob[i].xy)/blob[i].z;
      b=mix(b,col[i],blob[i].w*exp(-3.2*d*d));
    }
    float lb=dot(b,vec3(.2126,.7152,.0722));
    b=mix(vec3(lb),b,sat);                       // the light pools take the saturation setting, the cover is as it is
    c=style>.001?mix(b,c,style):b;
  }
  float l=dot(c,vec3(.2126,.7152,.0722));
  c=c*bright*(1.+plight*pulse);
  vec2 fq=floor(f/dcell);                        // export "防色带": bigger, stronger grain survives video compression
  float n=h(fq+seed)+h(fq+seed+19.19)-1.;        // triangular dither, dith 8-bit steps wide
  gl_FragColor=vec4(clamp(c+n*dith/255.,0.,1.),1.);
}`;
/* the cover prepared for the "封面流动" style: 32 x 32 (details vanish, the colour layout stays),
   colours pushed (soft contrast, strong saturation, contrast back up), then blurred a little */
let coverTex = null, coverTexVer = 0;
function prepCoverTex(img){
  const n = 32, c = Object.assign(document.createElement('canvas'), { width: n, height: n }), x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, n, n);
  const im = x.getImageData(0, 0, n, n);
  coverLook(im.data, n);
  x.putImageData(im, 0, 0);
  coverTex = c; coverTexVer++;
}
function coverLook(d, n){                           // the colours pushed and blurred, in place (d: n x n RGBA)
  for (let i = 0; i < d.length; i += 4){
    let r = (d[i] - 128) * 0.45 + 128, g = (d[i + 1] - 128) * 0.45 + 128, b = (d[i + 2] - 128) * 0.45 + 128;
    const y = r * 0.3 + g * 0.59 + b * 0.11;
    r = y + (r - y) * 2.8; g = y + (g - y) * 2.8; b = y + (b - y) * 2.8;
    d[i] = (r - 128) * 1.6 + 128; d[i + 1] = (g - 128) * 1.6 + 128; d[i + 2] = (b - 128) * 1.6 + 128; d[i + 3] = 255;
  }
  for (let pass = 0; pass < 3; pass++){            // separable box blur, radius 2
    for (const horiz of [true, false]){
      const src = Uint8ClampedArray.from(d);
      for (let yy = 0; yy < n; yy++) for (let xx = 0; xx < n; xx++){
        let r = 0, g = 0, b = 0;
        for (let k = -2; k <= 2; k++){
          const X = horiz ? Math.min(n - 1, Math.max(0, xx + k)) : xx, Y = horiz ? yy : Math.min(n - 1, Math.max(0, yy + k));
          const j = (Y * n + X) * 4; r += src[j]; g += src[j + 1]; b += src[j + 2];
        }
        const j = (yy * n + xx) * 4; d[j] = r / 5; d[j + 1] = g / 5; d[j + 2] = b / 5;
      }
    }
  }
  coverRelief(d, n);
}
/* A cover that is nearly one colour all over leaves a background that looks like a flat fill, however it flows. Such
   a picture is given some relief, and no more than it lacks: how far its brightness and its colours range is measured
   (between the 5 % and the 95 % mark) and compared with RELIEF.spread. Short of that, first the light and dark it does
   have is pulled apart (at most gain times); what is still missing comes from a few broad, soft swells of lighter and
   darker laid over it, the colour turned a few degrees with them (hue: at most that many, for a picture with nothing
   in it at all). The colour itself stays the cover's. A cover with enough in it is not touched. */
const RELIEF = { spread: 64, gain: 3, hue: 10 };
function coverRelief(d, n){
  const N = n * n, Y = new Float32Array(N), U = new Float32Array(N), V = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4){ Y[i] = d[j] * 0.3 + d[j + 1] * 0.59 + d[j + 2] * 0.11; U[i] = d[j] - d[j + 1]; V[i] = d[j + 2] - (d[j] + d[j + 1]) / 2; }
  const range = A => { const o = Float32Array.from(A).sort(); return [o[Math.floor(N * 0.05)], o[Math.floor(N * 0.95)]]; };
  const [y0, y1] = range(Y), [u0, u1] = range(U), [v0, v1] = range(V), ys = y1 - y0;
  const has = Math.max(ys, u1 - u0, v1 - v0);
  if (has >= RELIEF.spread) return;
  const g = ys > 4 ? Math.min(RELIEF.gain, RELIEF.spread / ys) : 1, mid = (y0 + y1) / 2;
  const lack = Math.max(0, RELIEF.spread - Math.max(has, ys * g)), amp = lack / 2, turn = RELIEF.hue * Math.PI / 180 * lack / RELIEF.spread;
  for (let yy = 0, i = 0, j = 0; yy < n; yy++) for (let xx = 0; xx < n; xx++, i++, j += 4){
    // the swells: two slow waves across the picture, -1 ... 1, not the same in any two corners
    const w = 0.6 * Math.sin(TAU * (xx / n * 0.9 + 0.13)) * Math.cos(TAU * (yy / n * 0.7 + 0.31)) + 0.4 * Math.sin(TAU * ((xx + yy) / n * 0.6 + 0.57));
    const y = Y[i], to = Math.max(0, y + (y - mid) * (g - 1) + w * amp);
    let r = d[j], gr = d[j + 1], b = d[j + 2];
    if (y > 24){ const k = to / y; r *= k; gr *= k; b *= k; } else { r += to - y; gr += to - y; b += to - y; }      // lighter or darker in its own colour; nearly black has none
    if (turn){                                   // the colour turned about grey
      const c = Math.cos(w * turn), sn = Math.sin(w * turn), p = (1 - c) / 3, q = sn * 0.57735;
      const R = r * (c + p) + gr * (p - q) + b * (p + q), G = r * (p + q) + gr * (c + p) + b * (p - q), B = r * (p - q) + gr * (p + q) + b * (c + p);
      r = R; gr = G; b = B;
    }
    d[j] = r; d[j + 1] = gr; d[j + 2] = b;
  }
}
/* the same of a picture that changes (the frame a moving cover is showing): one small canvas, used again each time */
let lookCv = null, lookX = null;
function coverLookOf(src){
  if (!lookCv){ lookCv = Object.assign(document.createElement('canvas'), { width: 32, height: 32 }); lookX = lookCv.getContext('2d', { willReadFrequently: true }); }
  lookX.drawImage(src, 0, 0, 32, 32);
  const d = lookX.getImageData(0, 0, 32, 32).data;
  coverLook(d, 32);
  return d;
}
/* A moving cover (cover-extract.js) and the 封面流动 background of the live page: once the background has melted into
   the cover's still, the picture the video is showing takes the still's place, a little more of it with every frame
   (glide: the seconds it trails by), so the whole background changes colour with the cover, gliding even where the
   video cuts. Not in the exported video, and not for 主色光斑, whose colours are picked once from the still.
   A setting (背景 panel: 背景跟随动态封面, fx.bg.coverLive), off unless switched on; 响应时间 beside it is the glide
   (fx.bg.coverLiveGlide, 0 = at once ... 1 s). */
const COVER_LIVE = { every: 33, glide: 0.12 };
const coverLiveOn = () => !!fx.bg.coverLive && fx.bg.style !== 'blobs';
const coverLiveGlide = () => { const g = +fx.bg.coverLiveGlide; return isFinite(g) ? Math.min(1, Math.max(0, g)) : COVER_LIVE.glide; };
function defaultCoverTex(){                        // until there is a cover: soft blobs of the default palette
  const n = 32, c = Object.assign(document.createElement('canvas'), { width: n, height: n }), x = c.getContext('2d');
  x.fillStyle = FLOW_DEFAULT[0]; x.fillRect(0, 0, n, n);
  [[1, 6, 8, 16], [2, 26, 10, 15], [3, 10, 26, 16], [4, 27, 26, 13], [5, 16, 16, 10]].forEach(([k, cx, cy, r]) => {
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, FLOW_DEFAULT[k]); g.addColorStop(1, FLOW_DEFAULT[k] + '00');
    x.fillStyle = g; x.fillRect(0, 0, n, n);
  });
  return c;
}
function makeFlowGL(canvas){
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false, premultipliedAlpha: false, alpha: false });
  if (!gl) return null;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null; };
  const vs = sh(gl.VERTEX_SHADER, FLOW_VS), fs = sh(gl.FRAGMENT_SHADER, FLOW_FS);
  if (!vs || !fs) return null;
  const pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) return null;
  gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = n => gl.getUniformLocation(pr, n);
  const u = { res: U('res'), base: U('base'), col: U('col'), blob: U('blob'), sat: U('sat'), bright: U('bright'), seed: U('seed'), dith: U('dith'), dcell: U('dcell'),
              style: U('style'), t: U('t'), tex: U('tex'), pulse: U('pulse'), pzoom: U('pzoom'), pturn: U('pturn'), plight: U('plight') };
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);   // mirrored: no seams where the turned image runs out
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
  gl.uniform1i(u.tex, 0);
  let frame = 0, texVer = -1, shown = null, lastCover = null, live = null;      // live: the look that follows a moving cover
  const melt = createLookMelt(MELT_MS);                // the live page's look; the export renderer never melts
  const pixelsOf = src => {
    const c = Object.assign(document.createElement('canvas'), { width: 32, height: 32 }), x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(src, 0, 0, 32, 32);
    return x.getImageData(0, 0, 32, 32).data;
  };
  const api = {
    canvas, dither: { amp: 1, cell: 1 }, fade: false, animating: false,
    render(w, h, t, flowT){                         // flowT: the time the flow moves by (the live page's own clock); t: the song's (the pulse)
      if (canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; }
      gl.viewport(0, 0, w, h);
      const cover = fx.bg.style !== 'blobs', wantVer = coverTexVer + (coverTex ? 0 : -1000), nowMs = performance.now();
      let P = curPalette(), st = cover ? 1 : 0;
      if (api.fade){
        // the look comes from the melt: a new cover, or the other style, starts a melt from what is on screen, whatever is under way
        if (texVer !== wantVer || lastCover !== cover || (live && !coverLiveOn())){      // ... or 背景跟随动态封面 was switched off: back to the still
          texVer = wantVer; lastCover = cover;
          // the background was following a moving cover: the melt starts from what that left on screen, not from the still
          if (live){ melt.set({ pix: Uint8ClampedArray.from(live.buf), pal: live.pal, st: live.st }, nowMs - 2 * MELT_MS); live = null; }
          melt.set({ pix: pixelsOf(coverTex || defaultCoverTex()), pal: flowPalette.map(c => c.slice()), st }, nowMs);
        }
        const look = melt.at(nowMs);
        if (look){
          P = look.pal.slice(0, Math.max(2, fx.bg.colors || 5));
          st = look.st;
          if (look !== shown){
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 32, 32, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(look.pix.buffer, look.pix.byteOffset, look.pix.length));
            shown = look;
          }
        }
        api.animating = melt.busy(nowMs);
        const v = cover && look && !api.animating && coverLiveOn() ? late.coverVideo : null;
        if (v && v.readyState >= 2 && v.videoWidth && !v.paused){
          if (!live || live.of !== v) live = { of: v, buf: Float32Array.from(look.pix), out: new Uint8ClampedArray(look.pix.length), pal: look.pal, st: look.st, at: 0 };
          if (nowMs - live.at >= COVER_LIVE.every){
            const g = coverLiveGlide(), k = g > 0.005 ? 1 - Math.exp(-(live.at ? Math.min(0.25, (nowMs - live.at) / 1000) : COVER_LIVE.every / 1000) / g) : 1;
            live.at = nowMs;
            try {
              const px = coverLookOf(v), b = live.buf, o = live.out;
              for (let i = 0; i < b.length; i++){ b[i] += (px[i] - b[i]) * k; o[i] = b[i]; }
              gl.bindTexture(gl.TEXTURE_2D, texture);
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 32, 32, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(o.buffer));
            } catch (e){}
          }
          api.animating = true;                      // keep drawing while the cover moves, even when the song is paused
        }
      } else if (cover && texVer !== wantVer){
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, coverTex || defaultCoverTex());
        texVer = wantVer;
      }
      const T = (flowT ?? t) * fx.bg.speed, D = Math.hypot(w, h), pulse = bassAt(t), PL = pulseLook();
      const [h0, s0, l0] = rgb2hsl(P[0]);
      gl.uniform2f(u.res, w, h);
      gl.uniform3fv(u.base, hsl2rgb([h0, s0, l0 * 0.55]).map(v => v / 255));
      const cols = [], blobs = [];
      FLOW_BLOBS.forEach(B => {
        const cx = w * (0.5 + B.ox * Math.cos(T * B.fx * TAU + B.ph));
        const cy = h * (0.5 + B.oy * Math.sin(T * B.fy * TAU + B.ph * 1.7));
        const r = D * B.r * (1 + 0.12 * Math.sin(T * 0.013 * TAU + B.ph * 2.3)) * (1 + PL.grow * pulse);
        cols.push(...P[B.c % P.length].map(v => v / 255));
        blobs.push(cx, cy, r, 0.85);
      });
      gl.uniform3fv(u.col, cols); gl.uniform4fv(u.blob, blobs);
      gl.uniform1f(u.style, st); gl.uniform1f(u.t, T); gl.uniform1f(u.pulse, pulse);
      gl.uniform1f(u.pzoom, PL.zoom); gl.uniform1f(u.pturn, PL.turn); gl.uniform1f(u.plight, PL.light);
      gl.uniform1f(u.sat, fx.bg.sat); gl.uniform1f(u.bright, 1 - fx.bg.dim);
      gl.uniform1f(u.seed, (frame++ % 64) * 1.618);          // the dither pattern changes every frame, like film grain
      gl.uniform1f(u.dith, api.dither.amp); gl.uniform1f(u.dcell, api.dither.cell);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  };
  return api;
}
let exportDith = 1;
let exportProf = null, exportProfText = '';                             // per-stage timings while exporting MP4 (ms, summed)                                 // dither strength of the export bloom (画质 / 防色带)
let flowGLx = null, flowGLxTried = false;           // offscreen renderer for video export
function exportFlowGL(){
  if (!flowGLxTried){ flowGLxTried = true; try { flowGLx = makeFlowGL(document.createElement('canvas')); } catch(e){ flowGLx = null; } }
  return flowGLx;
}

/* export: background for a full W x H frame at song (audio) time t */
function drawFlowBg(ctx, W, H, t){
  const R = exportFlowGL();
  ctx.save();
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  if (R){ R.render(W, H, t); ctx.drawImage(R.canvas, 0, 0); }
  else {                                                     // no WebGL: small blurred canvas, scaled up
    const w = 480, h = Math.max(2, Math.round(480 * H / W));
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(flowFrame(w, h, t), 0, 0, W, H);
  }
  ctx.globalAlpha = fx.bg.grain; ctx.globalCompositeOperation = 'overlay';
  if (fx.bg.grain > 0.001){ ctx.fillStyle = ctx.createPattern(GRAIN, 'repeat'); ctx.fillRect(0, 0, W, H); }
  ctx.restore();
}

/* live page: a small canvas behind everything, stretched to the window by CSS.
   The flow moves by a clock of its own (bgClock): it runs at the clock's pace while the song plays and stands still
   while it is paused, but does not go with the song time when that jumps. Dragging the progress bar used to send the
   background racing along with it. The pulse still goes by the song time (it is the bass at that moment). The export
   draws by the song time alone (drawFlowBg), so a video is the same every time. */
let bgLastT = -1, bgLastDraw = 0, bgDirty = true, liveGL, bgClock = null, bgSize = null, bgWasResizing = false;
function drawLiveBg(){
  const c = $('bgFlow'), on = fx.bg.mode === 'flow';
  c.classList.toggle('on', on);
  if (!on) return;
  const ms = performance.now(), t = now();
  const cv = late.coverVideo;
  if (cv && !cv.paused && coverLiveOn()) bgDirty = true;      // a moving cover: the background follows it, also while the song is paused
  const rz = windowResizing();
  if (bgWasResizing && !rz) bgDirty = true;                    // the edge has come to rest: once more, at the size it came to
  bgWasResizing = rz;
  if (ms - bgLastDraw < ((bassEnv || followBassOn()) && fx.bg.pulse > 0 ? 15 : 33) || (t === bgLastT && !bgDirty)) return;   // 30 fps, 60 when pulsing; nothing while paused
  if (bgClock === null) bgClock = t;
  if (playing) bgClock += Math.min(0.1, Math.max(0, (ms - bgLastDraw) / 1000));      // (a long gap: the page was hidden)
  bgLastDraw = ms; bgLastT = t; bgDirty = false;
  if (liveGL === undefined){ try { liveGL = makeFlowGL(c); if (liveGL) liveGL.fade = true; } catch(e){ liveGL = null; } }
  if (liveGL){
    const k = Math.min(devicePixelRatio || 1, 2560 / Math.max(1, innerWidth));
    // an edge being dragged: the picture keeps the size it had (CSS stretches it); resizing the buffer at every pixel
    // is what made the background stutter
    const size = rz && bgSize ? bgSize : (bgSize = [Math.round(innerWidth * k), Math.round(innerHeight * k)]);
    liveGL.render(size[0], size[1], t, bgClock);
    if (liveGL.animating) bgDirty = true;                      // keep drawing while the look changes, even when paused
    return;
  }
  const w = 320, h = Math.max(2, Math.round(320 * innerHeight / Math.max(1, innerWidth)));
  if (c.width !== w || c.height !== h){ c.width = w; c.height = h; }
  c.getContext('2d').drawImage(flowFrame(w, h, bgClock), 0, 0);
}

/* live page in WebGL mode: the same canvas drawing as the export, at screen resolution, through the bloom */
let liveBloom, liveGLx = null, liveGLKey = '', liveGLLast = '', liveGLVer = 0;
/* 显示封面 switched on or off: the lyrics are laid out anew for their new area at once, but drawn where they were, and
   glide from there to their place. The cover moves first (coverSlide, frame.js; .covpanel in style.css); the lyrics
   stay put for a moment and then follow as if it pulled them along: off gently, then a long soft landing (COVER_GLIDE
   in settings.js). They only move: nothing fades. The rows of the scrolling column change their alignment in the
   same glide (scrollAlignNow, layout-scroll.js). It has a speed (coverGlideNow, settings.js), so switching again
   while it is under way, even several times quickly, carries on from where the lyrics are: no jump, no stalling.
   liveAt: the lyrics' own place in the last frame (their anchor, late.lyricAnchor, in window px).
   liveK: how far from their place the lyrics are drawn for each unit of the change still to come (drawn at
   place + liveK * u). Set anew at every switch so that they are drawn exactly where they were just before it. */
let liveCover = null, liveAt = null, liveK = { x: 0, y: 0 };
/* the place itself moves during the glide (the rows of the column re-align with it): liveU is u in the last frame and
   liveS how far the place moves per unit of u, measured from the last two frames, so that "where they were" can be
   said for this very moment and not for a frame ago (at speed that is ten pixels) */
let liveU = 0, liveS = { x: 0, y: 0 };
function drawLiveGL(){
  late.updateCoverPanel();
  const on = late.useWebGL() || late.useScroll() || late.useWordMode() || late.useCoverPanel() || fx.ui === 'glass' || !!late.layoutTrStep();   // glass refracts the lyrics, so they go on the canvas          // scrolling column / cover layout are always drawn on the canvas
  document.body.classList.toggle('webgl', on && liveBloom !== null);
  const cover = !!fx.cover, turned = liveCover !== null && cover !== liveCover, cg = coverGlideNow(performance.now());
  const uWas = turned ? cg.u - ((liveCover ? 1 : 0) - cg.to) : cg.u;      // what was still to come just before this switch
  const from = turned && liveAt && !matchMedia('(prefers-reduced-motion:reduce)').matches ? { x: liveAt.x + liveS.x * (uWas - liveU) + liveK.x * uWas, y: liveAt.y + liveS.y * (uWas - liveU) + liveK.y * uWas } : null;   // where they would be drawn now, had nothing been switched
  liveCover = cover;
  if (!on){
    // the web view: the line is page text in the middle of the stage, and the stage itself glides
    const s = $('stage').getBoundingClientRect(), here = { x: s.left + s.width / 2, y: s.top + s.height / 2 };
    if (from){
      // from where the lyrics are drawn now (the stage itself may still be gliding from the switch before)
      const st = $('stage'), m = new DOMMatrix(getComputedStyle(st).transform), busy = st.getAnimations().length > 0 || Math.abs(uWas) > 0.001;
      st.getAnimations().forEach(a => a.cancel());
      st.animate([{ transform: `translate(${from.x + m.m41 - here.x}px,${from.y + m.m42 - here.y}px)` }, { transform: 'none' }],
        { delay: busy ? 0 : COVER_GLIDE.wait * 1000, duration: 6500 / COVER_GLIDE.w, easing: 'cubic-bezier(.36,0,.14,1)', fill: 'backwards' });
    }
    liveAt = here; liveK = { x: 0, y: 0 }; liveS = { x: 0, y: 0 }; liveU = cg.u;
    return;
  }
  if (liveBloom === undefined){
    try { liveBloom = late.makeBloomGL($('glView')); } catch(e){ liveBloom = null; }
    if (!liveBloom){ $('status').textContent = '这台电脑的浏览器不支持 WebGL，已经用回网页渲染' + (late.useScroll() || late.useWordMode() ? '，滚动 / 逐词布局也用不了' : ''); fx.render = 'dom'; fx.layout = 'single'; fx.cover = false; late.saveFx(); late.applyFx(); return; }
  }
  const dpr = Math.min(devicePixelRatio || 1, 2), r = late.liveRect();
  const CW = Math.round(innerWidth * dpr), CH = Math.round(innerHeight * dpr);
  const W = Math.max(2, Math.round(r.width * dpr)), H = Math.max(2, Math.round(r.height * dpr));
  const rest = [mode, oneLine, liveGLVer, fx.layout, fx.cover].join('|');
  const key = [CW, CH, W, H, rest].join('|');
  if (!liveGLx || liveGLKey !== key || liveGLx.song !== song){
    const pb = prof.on ? performance.now() : 0;
    const tl = Object.assign(document.createElement('canvas'), { width: CW, height: CH });
    const ctx = tl.getContext('2d');
    // same type size as the web view, so switching renderers does not jump
    const probeLine = document.createElement('div'); probeLine.className = 'line'; probeLine.style.visibility = 'hidden';
    $('stage').appendChild(probeLine);
    const cssFs = parseFloat(getComputedStyle(probeLine).fontSize) || 60; probeLine.remove();
    // the page's type size, but no larger than the export's rule allows for the height (a wide, low window would otherwise
    // show two or three lines and look different from the exported video). While an edge is dragged, in coarse steps (dragSize)
    const fs0 = dragSize(Math.min(cssFs * dpr, H * 0.09));
    // a new size, the same type (and song, layout ...): the measurer stays, with the text sprites baked for it and the
    // widths measured; only the canvas it draws on is new. This is most of the frames of a window being dragged. (The
    // scrolling column only: the one-line layout wraps by the width the measurer was made for.)
    const keep = liveGLx && liveGLx.rest === rest && liveGLx.song === song && fx.layout === 'scroll' && liveGLx.M.fs === Math.round(fs0 * fx.font.main.s) ? liveGLx.M : null;
    const M = keep || canvasMeasurer(ctx, W, H, fs0);
    if (keep) keep.ctx = ctx;
    liveGLx = { tl, ctx, M, segs: lazyTimeline(M), song, rest, probeM: Object.assign(Object.create(M), { sprites: { draw(){}, drawLit(){}, drawLitGroup(){} }, _probe: true }) };
    liveGLKey = key; liveGLLast = '';
    if (pb) prof.build += performance.now() - pb;
  }
  const X = liveGLx, t = lt(now());
  const pa = prof.on ? performance.now() : 0;
  const an = late.lyricAnchor(W, H, X.M), here = { x: r.left + an.x / dpr, y: r.top + an.y / dpr };
  if (pa) prof.anchor += performance.now() - pa;
  // switched: drawn where they were (from) = their new place + liveK * u, which gives liveK. Switched straight back
  // before anything moved, u is 0 again and they are simply in their place
  if (turned) liveK = from && Math.abs(cg.u) > 0.001 ? { x: (from.x - here.x) / cg.u, y: (from.y - here.y) / cg.u } : { x: 0, y: 0 };
  if (turned || !liveAt || !cg.moving) liveS = { x: 0, y: 0 };
  else if (Math.abs(cg.u - liveU) > 1e-5) liveS = { x: (here.x - liveAt.x) / (cg.u - liveU), y: (here.y - liveAt.y) / (cg.u - liveU) };
  liveAt = here; liveU = cg.u;
  const gx = liveK.x * cg.u, gy = liveK.y * cg.u;         // how far from their place the lyrics are drawn (window px)
  const probe = { fillRect(){}, clearRect(){}, beginPath(){}, rect(){}, clip(){}, save(){}, restore(){}, translate(){}, scale(){}, drawImage(){}, setTransform(){}, getTransform(){ return new DOMMatrix(); }, set globalAlpha(v){}, set globalCompositeOperation(v){}, set fillStyle(v){}, set filter(v){} };
  const pp = prof.on ? performance.now() : 0;
  const st = late.drawFrame(probe, W, H, X.probeM, X.segs, t, true, true, true);
  if (pp) prof.draw += performance.now() - pp;
  const sig = st && !cg.moving ? st + '|' + key : null;
  if (sig && sig === liveGLLast) return;                   // nothing moves: keep the last picture
  liveGLLast = sig || '';
  const c = X.ctx;
  c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, CW, CH);
  c.setTransform(1, 0, 0, 1, Math.round((r.left + gx) * dpr), Math.round((r.top + gy) * dpr));
  const pd = prof.on ? performance.now() : 0;
  late.drawFrame(c, W, H, X.M, X.segs, t, true, true, true);
  if (pd) prof.draw += performance.now() - pd;
  const o = late.bloomOpts(X.M);
  if (!fx.glow.on || !late.useWebGL()) o.k = 0;       // canvas view without WebGL glow: plain text (glow comes from the sprites)
  const pl = prof.on ? performance.now() : 0;
  liveBloom.render(X.tl, o);
  if (pl) prof.bloom += performance.now() - pl;
}

function setCoverBmp(v){ return coverBmp = v; }   // other modules cannot assign to an imported binding

function setCoverHi(v){ return coverHi = v; }   // other modules cannot assign to an imported binding

function setFlowPalette(v){ return flowPalette = v; }   // other modules cannot assign to an imported binding

function setCoverURL(v){ return coverURL = v; }   // other modules cannot assign to an imported binding

function setCoverLabel(v){ return coverLabel = v; }   // other modules cannot assign to an imported binding

function setBgDirty(v){ return bgDirty = v; }   // other modules cannot assign to an imported binding

function setExportProfText(v){ return exportProfText = v; }   // other modules cannot assign to an imported binding

function setExportDith(v){ return exportDith = v; }   // other modules cannot assign to an imported binding

function setExportProf(v){ return exportProf = v; }   // other modules cannot assign to an imported binding

function setLiveGLVer(v){ return liveGLVer = v; }   // other modules cannot assign to an imported binding

function setLiveGLLast(v){ return liveGLLast = v; }   // other modules cannot assign to an imported binding
