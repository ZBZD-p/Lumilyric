import { late } from '../core/late.js';
import { $, setCur } from '../core/lyrics.js';
import { fx } from '../core/settings.js';
import { render } from '../render/view-dom.js';
import { coverHi, coverURL, flowPalette } from '../background/background.js';
import { fitText } from '../render/frame.js';
import { applyFx, saveFx } from '../ui/ui-effects.js';

export {
  GLASS_DRAWER,
  GLASS_LOOK,
  drawGlass,
  glassExtra,
  glassGL,
  glassKnob,
  glassKnobSeq,
  setGlassKnobSeq,
};

/* 液态玻璃 (Apple "Liquid Glass"), drawn on the GPU.
   The scene behind the controls is ours: the flowing background (#bgFlow) and, while glass is on, the lyrics
   (#glView, the canvas renderer). A WebGL layer between them and the controls takes both as textures every frame
   and draws a piece of glass under each control with a fragment shader:
   - shape: rounded rectangle (signed distance), anti-aliased edge, soft drop shadow;
   - refraction: the rim is a "convex squircle" y = (1 - (1 - x)^4)^(1/4) over a bezel band, flat in the middle
     (after Chris Feijoo, "Liquid Glass in the Browser", kube.io). A ray going straight down is bent at that
     surface by Snell's law (n = 1.5); its sideways travel through the slab is how far inwards the scene is sampled.
     Red, green and blue bend by slightly different amounts (a faint fringe), all on the GPU;
   - a light frost (a few taps), a little extra saturation and brightness;
   - rim light: a thin bright line strongest where the rim faces the light (upper left), weaker opposite, plus a
     soft glow inside the bezel.
   The controls themselves stay normal page elements (text, clicks), only their background becomes transparent.
   The big panels keep the browser's own frosted blur (also GPU). */
const GLASS_SEL = '.top .seg, .bottom .tbar, .xpill, .fps';      // the bar is one piece of glass; what sits on it is not
const GLASS_MAX = 40;
/* the settings card (.modal.drawer .panel) as one piece of glass: frosted (text on it must stay readable over any
   cover), a wide soft rim that bends the picture a little, a clear edge light and a deep shadow */
const GLASS_DRAWER = { shadow: 1, rim: 0.3, clear: 1, refr: 0.4, bezel: 30, frost: 0.85 };
/* extra pieces of glass that are not a page element of their own: functions (dpr) -> item, list of items or null, asked every frame
   (the lifted thumb of a switch, seg-thumb.js). Drawn after the controls, so they lie on top. */
const glassExtra = [];
let glassGL = null, glassTried = false;
function makeGlassGL(){
  const canvas = document.createElement('canvas');
  canvas.id = 'glassView'; canvas.className = 'glassview'; canvas.setAttribute('aria-hidden', 'true');
  $('glView').after(canvas);
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false });
  if (!gl) return null;
  const VS = `attribute vec2 p;uniform vec4 box;uniform vec2 res;varying vec2 fp;
void main(){ vec2 px = box.xy + p * box.zw; fp = px; gl_Position = vec4(px / res * 2. - 1., 0., 1.); gl_Position.y *= -1.; }`;
  const FS = `precision highp float;varying vec2 fp;
uniform sampler2D bg, fg, dom, blr, ovl; uniform float hasDom, hasBlr, hasOvl; uniform vec4 ovlRect; uniform vec2 res; uniform vec4 rect; uniform vec4 prm; uniform float hasBg, hasFg, dpr, maxDisp;
uniform vec3 look;   // x = shadow, y = rim light, z = clarity (0 = tinted / frosted, 1 = fully clear)
uniform float frostAmt;   // 磨砂: blur radius and fine grain of etched glass
// prm: x = corner radius, y = bezel width, z = opacity, w = largest displacement (px)
float sq(float x){ x = clamp(x, 0., 1.); return pow(1. - pow(1. - x, 4.), .25); }
float sqd(float x){ x = clamp(x, .001, .999); float a = 1. - x; return pow(a, 3.) * pow(1. - pow(a, 4.), -.75); }
vec3 scene(vec2 q){
  vec2 uv = clamp(q / res, 0., 1.);
  vec3 b = hasBg > .5 ? texture2D(bg, uv).rgb : vec3(0.);
  if (hasDom > .5){ vec4 m = texture2D(dom, uv); b = m.rgb + b * (1. - m.a); }   // cover panel (page elements copied to a canvas)
  vec4 f = hasFg > .5 ? texture2D(fg, uv) : vec4(0.);
  vec3 c = f.rgb + b * (1. - f.a);
  if (hasOvl > .5){                                 // words lying on the control under this piece of glass: bent with the rest
    vec2 u = (q - ovlRect.xy) / ovlRect.zw;
    if (u.x > 0. && u.x < 1. && u.y > 0. && u.y < 1.){ vec4 o = texture2D(ovl, u); c = o.rgb + c * (1. - o.a); }
  }
  return c;
}
vec3 frost(vec2 q, float r){
  vec3 c = scene(q) * .4;
  c += scene(q + vec2(r, 0.)) * .15 + scene(q - vec2(r, 0.)) * .15 + scene(q + vec2(0., r)) * .15 + scene(q - vec2(0., r)) * .15;
  return c;
}
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec2 c = rect.xy + rect.zw * .5, hs = rect.zw * .5;
  float R = min(prm.x, min(hs.x, hs.y));
  vec2 d = fp - c, q = abs(d) - (hs - R);
  float sdf = length(max(q, 0.)) + min(max(q.x, q.y), 0.) - R;     // < 0 inside
  // outward normal of the rounded rectangle
  vec2 n = (q.x > 0. && q.y > 0.) ? normalize(q) : (q.x > q.y ? vec2(1., 0.) : vec2(0., 1.));
  n *= sign(d + 1e-4);
  float a = prm.z;
  if (sdf > 0.){                                   // outside: soft shadow, a little lower
    vec2 qs = abs(d - vec2(0., 3. * dpr)) - (hs - R);
    float s2 = length(max(qs, 0.)) + min(max(qs.x, qs.y), 0.) - R;
    float sh = .3 * look.x * exp(-max(s2, 0.) / (5. * dpr)) * a;
    float aa = clamp(.5 - sdf, 0., 1.);
    gl_FragColor = vec4(0., 0., 0., sh * (1. - aa));
    if (aa <= 0.) return;
  }
  float inside = -sdf, bz = prm.y, x = inside / bz;
  // Snell refraction through the squircle rim
  float disp = 0.;
  if (x < 1.){
    float t1 = atan(sqd(x)), t2 = asin(sin(t1) / 1.5);
    disp = tan(t1 - t2) * (sq(x) + .25) / maxDisp;
  }
  vec2 off = -n * disp * prm.w;
  float fr = mix(1.6, 0., look.z) * dpr;            // frost radius
  vec3 col;
  if (hasBlr > .5){
    // Apple-style material: the scene behind is blurred with a wide, smooth (dual Kawase) blur computed once per frame,
    // then made more vivid and lifted a little toward white. No grain: only a 1/255 dither against banding.
    vec3 sharp = vec3(scene(fp + off * 1.06).r, scene(fp + off).g, scene(fp + off * .94).b);
    vec3 bl = vec3(texture2D(blr, clamp((fp + off * 1.06) / res, 0., 1.)).r,
                   texture2D(blr, clamp((fp + off) / res, 0., 1.)).g,
                   texture2D(blr, clamp((fp + off * .94) / res, 0., 1.)).b);
    if (hasOvl > .5){                                // the words on the control stay sharp (bent by the glass), only what is behind them is frosted
      vec2 ua = (fp + off * 1.06 - ovlRect.xy) / ovlRect.zw, ub = (fp + off - ovlRect.xy) / ovlRect.zw, uc = (fp + off * .94 - ovlRect.xy) / ovlRect.zw;
      vec4 oa = (ua.x > 0. && ua.x < 1. && ua.y > 0. && ua.y < 1.) ? texture2D(ovl, ua) : vec4(0.);
      vec4 ob = (ub.x > 0. && ub.x < 1. && ub.y > 0. && ub.y < 1.) ? texture2D(ovl, ub) : vec4(0.);
      vec4 oc = (uc.x > 0. && uc.x < 1. && uc.y > 0. && uc.y < 1.) ? texture2D(ovl, uc) : vec4(0.);
      bl = vec3(oa.r + bl.r * (1. - oa.a), ob.g + bl.g * (1. - ob.a), oc.b + bl.b * (1. - oc.a));
    }
    col = mix(sharp, bl, smoothstep(0., .3, frostAmt));
    float lb = dot(col, vec3(.2126, .7152, .0722));
    col = mix(vec3(lb), col, 1. + .6 * frostAmt);                       // vibrancy: saturation up
    col = mix(col, vec3(1.), (.03 + .07 * (1. - lb)) * frostAmt);      // soft white veil, stronger over dark areas
    col += (hash(fp) - .5) / 255.;
  } else col = vec3(frost(fp + off * 1.06, fr).r, frost(fp + off, fr).g, frost(fp + off * .94, fr).b);
  // glass body: a touch brighter and more saturated, faint white tint
  float l = dot(col, vec3(.2126, .7152, .0722));
  float tint = 1. - look.z;
  col = mix(vec3(l), col, 1. + .12 * tint) * (1. + .04 * tint) + .05 * tint;
  // rim light
  vec2 L = normalize(vec2(-.5, -.866));            // light from the upper left (screen y goes down)
  float facing = dot(n, L);
  float dir = facing > 0. ? pow(facing, 1.6) : .45 * pow(-facing, 1.6);
  float line = exp(-inside / (1.1 * dpr));
  float glow = .18 * pow(max(0., 1. - x), 3.);
  col += (line * .85 + glow) * (.15 + .85 * dir) * look.y;
  float edge = clamp(.5 - sdf, 0., 1.);
  gl_FragColor = vec4(clamp(col, 0., 1.), 1.) * edge * a;
}`;
  const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const prog = (vs, fs) => { const o = gl.createProgram(); gl.attachShader(o, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(o, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(o, 0, 'p'); gl.linkProgram(o);
    if (!gl.getProgramParameter(o, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(o)); return o; };
  const pr = prog(VS, FS);
  // the overlay drawn as it is (no glass): the words outside the lifted piece, while the page's own are hidden
  const pB = prog(VS, `precision highp float;varying vec2 fp;uniform sampler2D ovl;uniform vec4 ovlRect;uniform float al;
void main(){ vec2 u = (fp - ovlRect.xy) / ovlRect.zw; gl_FragColor = (u.x > 0. && u.x < 1. && u.y > 0. && u.y < 1.) ? texture2D(ovl, u) * al : vec4(0.); }`);
  const uB = {}; ['ovl', 'ovlRect', 'al', 'box', 'res'].forEach(k => uB[k] = gl.getUniformLocation(pB, k));
  gl.useProgram(pB); gl.uniform1i(uB.ovl, 4);
  /* blur chain for the frosted material: scene -> 1/2 -> 1/4 -> 1/8 -> 1/16, then back up to 1/4 (dual Kawase) */
  const VQ = `attribute vec2 p;varying vec2 uv;void main(){ uv = p; gl_Position = vec4(p * 2. - 1., 0., 1.); }`;
  const pC = prog(VQ, `precision highp float;varying vec2 uv;uniform sampler2D bg, fg, dom;uniform float hasBg, hasFg, hasDom;uniform vec2 ts;
vec3 scene(vec2 u){ u = clamp(u, 0., 1.);
  vec3 b = hasBg > .5 ? texture2D(bg, u).rgb : vec3(0.);
  if (hasDom > .5){ vec4 m = texture2D(dom, u); b = m.rgb + b * (1. - m.a); }
  vec4 f = hasFg > .5 ? texture2D(fg, u) : vec4(0.); return f.rgb + b * (1. - f.a); }
void main(){ vec2 o = ts; gl_FragColor = vec4((scene(uv) * 4. + scene(uv - o) + scene(uv + o) + scene(uv + vec2(o.x, -o.y)) + scene(uv - vec2(o.x, -o.y))) / 8., 1.); }`);
  const pD = prog(VQ, `precision highp float;varying vec2 uv;uniform sampler2D src;uniform vec2 hp;uniform float o;
void main(){ vec2 h = hp * o; vec3 s = texture2D(src, uv).rgb * 4. + texture2D(src, uv - h).rgb + texture2D(src, uv + h).rgb
  + texture2D(src, uv + vec2(h.x, -h.y)).rgb + texture2D(src, uv - vec2(h.x, -h.y)).rgb; gl_FragColor = vec4(s / 8., 1.); }`);
  const pU = prog(VQ, `precision highp float;varying vec2 uv;uniform sampler2D src;uniform vec2 hp;uniform float o;
void main(){ vec2 h = hp * o; vec3 s = texture2D(src, uv + vec2(-h.x * 2., 0.)).rgb + texture2D(src, uv + vec2(h.x * 2., 0.)).rgb
  + texture2D(src, uv + vec2(0., h.y * 2.)).rgb + texture2D(src, uv + vec2(0., -h.y * 2.)).rgb
  + (texture2D(src, uv + h).rgb + texture2D(src, uv - h).rgb + texture2D(src, uv + vec2(h.x, -h.y)).rgb + texture2D(src, uv - vec2(h.x, -h.y)).rgb) * 2.;
  gl_FragColor = vec4(s / 12., 1.); }`);
  const UQ = (o, ks) => { const u = {}; ks.forEach(k => u[k] = gl.getUniformLocation(o, k)); return u; };
  const uC = UQ(pC, ['bg', 'fg', 'dom', 'hasBg', 'hasFg', 'hasDom', 'ts']), uD = UQ(pD, ['src', 'hp', 'o']), uU = UQ(pU, ['src', 'hp', 'o']);
  gl.useProgram(pC); gl.uniform1i(uC.bg, 0); gl.uniform1i(uC.fg, 1); gl.uniform1i(uC.dom, 2);
  gl.useProgram(pD); gl.uniform1i(uD.src, 3); gl.useProgram(pU); gl.uniform1i(uU.src, 3);
  gl.useProgram(pr);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const U = {}; ['bg', 'fg', 'dom', 'blr', 'ovl', 'hasOvl', 'ovlRect', 'hasBlr', 'hasDom', 'frostAmt', 'res', 'rect', 'prm', 'box', 'hasBg', 'hasFg', 'dpr', 'maxDisp', 'look'].forEach(k => U[k] = gl.getUniformLocation(pr, k));
  const tex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); return t; };
  const tBg = tex(), tFg = tex(), tDom = tex(), tOvl = tex();
  let ovlVer = null;
  gl.uniform1i(U.bg, 0); gl.uniform1i(U.fg, 1); gl.uniform1i(U.dom, 2); gl.uniform1i(U.blr, 3); gl.uniform1i(U.ovl, 4);
  let lv = [], lvKey = '';
  const levels = (W, H) => {
    if (lvKey === W + 'x' + H) return; lvKey = W + 'x' + H;
    for (const l of lv){ gl.deleteTexture(l.t); gl.deleteFramebuffer(l.f); }
    gl.activeTexture(gl.TEXTURE3);              // keep the scene textures on units 0-2 untouched
    lv = [];
    for (let i = 0; i < 4; i++){
      const w = Math.max(1, Math.round(W / 2 ** (i + 1))), h = Math.max(1, Math.round(H / 2 ** (i + 1))), t = tex();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      lv.push({ t, f, w, h });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  };
  const pass = (l, src) => { gl.bindFramebuffer(gl.FRAMEBUFFER, l.f); gl.viewport(0, 0, l.w, l.h);
    if (src){ gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, src.t); }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); };
  let domVer = -1;
  // the largest sideways travel of the profile, to normalise it (same maths as the shader)
  let maxDisp = 0;
  for (let i = 1; i < 1000; i++){
    const x = i / 1000, a = 1 - x, d = Math.pow(a, 3) * Math.pow(1 - Math.pow(a, 4), -0.75);
    const t1 = Math.atan(d), t2 = Math.asin(Math.sin(t1) / 1.5);
    maxDisp = Math.max(maxDisp, Math.tan(t1 - t2) * (Math.pow(1 - Math.pow(a, 4), 0.25) + 0.25));
  }
  gl.uniform1f(U.maxDisp, maxDisp);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  return {
    canvas,
    draw(items, dpr){
      const W = Math.round(innerWidth * dpr), H = Math.round(innerHeight * dpr);
      if (canvas.width !== W || canvas.height !== H){ canvas.width = W; canvas.height = H; }
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (!items.length) return;
      const bgC = $('bgFlow'), bgOn = fx.bg.mode === 'flow' && bgC.width > 2, fgC = $('glView'), fgOn = document.body.classList.contains('webgl') && fgC.width > 2;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tBg);
      if (bgOn){ gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, bgC); }
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tFg);
      if (fgOn){ gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fgC); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); }
      const dom = glassDomScene(W, H, dpr);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, tDom);
      if (dom && domVer !== glassDomVer){ domVer = glassDomVer; gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, dom); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); }
      gl.uniform1f(U.hasDom, dom ? 1 : 0);
      gl.uniform1f(U.hasBg, bgOn ? 1 : 0); gl.uniform1f(U.hasFg, fgOn ? 1 : 0);
      const ov = (items.find(it => it.ovl) || {}).ovl;          // one overlay at a time is enough
      if (ov){
        gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, tOvl);
        if (ovlVer !== ov.ver){ ovlVer = ov.ver; gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, ov.canvas); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false); }
      }
      const fz = Math.max(...items.map(it => it.frost || 0));
      if (fz > 0.01){
        levels(W, H); gl.disable(gl.BLEND);
        const o = 0.6 + 1.6 * fz;                  // blur spread
        gl.useProgram(pC); gl.uniform1f(uC.hasBg, bgOn ? 1 : 0); gl.uniform1f(uC.hasFg, fgOn ? 1 : 0); gl.uniform1f(uC.hasDom, dom ? 1 : 0);
        gl.uniform2f(uC.ts, 1 / W, 1 / H); pass(lv[0]);
        gl.useProgram(pD); gl.uniform1f(uD.o, o);
        for (let i = 1; i < 4; i++){ gl.uniform2f(uD.hp, 0.5 / lv[i].w, 0.5 / lv[i].h); pass(lv[i], lv[i - 1]); }
        gl.useProgram(pU); gl.uniform1f(uU.o, o);
        for (let i = 2; i >= 1; i--){ gl.uniform2f(uU.hp, 0.5 / lv[i].w, 0.5 / lv[i].h); pass(lv[i], lv[i + 1]); }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.enable(gl.BLEND); gl.useProgram(pr);
        gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, lv[1].t);
      }
      gl.uniform2f(U.res, W, H); gl.uniform1f(U.dpr, dpr);
      for (const it of items){
        const m = 24 * dpr;                        // room for the shadow
        if (it.blit){
          gl.useProgram(pB); gl.uniform2f(uB.res, W, H); gl.uniform4f(uB.box, it.ovl.rect[0], it.ovl.rect[1], it.ovl.rect[2], it.ovl.rect[3]);
          gl.uniform4f(uB.ovlRect, it.ovl.rect[0], it.ovl.rect[1], it.ovl.rect[2], it.ovl.rect[3]); gl.uniform1f(uB.al, it.a);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.useProgram(pr);
          continue;
        }
        gl.uniform1f(U.hasOvl, it.ovl ? 1 : 0);
        if (it.ovl) gl.uniform4f(U.ovlRect, it.ovl.rect[0], it.ovl.rect[1], it.ovl.rect[2], it.ovl.rect[3]);
        gl.uniform4f(U.rect, it.x, it.y, it.w, it.h);
        gl.uniform4f(U.box, it.x - m, it.y - m, it.w + 2 * m, it.h + 2 * m);
        gl.uniform4f(U.prm, it.r, it.bezel, it.a, it.disp);
        gl.uniform3f(U.look, it.look[0], it.look[1], it.look[2]); gl.uniform1f(U.frostAmt, it.frost);
        gl.uniform1f(U.hasBlr, fz > 0.01 && it.frost > 0.01 ? 1 : 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
  };
}
/* the cover panel is a page element, not part of any canvas: copy it (cover picture, title, artist) into a canvas
   so the glass can refract it too. Redrawn only when it moves or changes. */
let glassDom = null, glassDomKey = '', glassDomVer = 0;
function glassDomScene(W, H, dpr){
  const panel = $('coverPanel');
  if (panel.hidden) return null;
  const art = $('covArt'), ti = $('covTi'), ar = $('covAr');
  const ra = art.getBoundingClientRect(), rt = ti.getBoundingClientRect(), rr = ar.getBoundingClientRect();
  const key = [W, H, dpr, ra.left, ra.top, ra.width, rt.left, rt.top, rr.top, ti.textContent, ar.textContent, coverURL, coverHi && coverHi.width].join('|');
  if (key === glassDomKey && glassDom) return glassDom;
  glassDomKey = key; glassDomVer++;
  if (!glassDom) glassDom = document.createElement('canvas');
  if (glassDom.width !== W || glassDom.height !== H){ glassDom.width = W; glassDom.height = H; }
  const x = glassDom.getContext('2d');
  x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, W, H); x.scale(dpr, dpr);
  const cs = getComputedStyle(art), rad = parseFloat(art.style.getPropertyValue('--cr')) || 0;
  x.save();
  x.beginPath(); x.roundRect(ra.left, ra.top, ra.width, ra.height, rad);
  x.shadowColor = 'rgba(0,0,0,0.45)'; x.shadowBlur = ra.width * 0.12; x.shadowOffsetY = ra.width * 0.04;
  x.fillStyle = '#222'; x.fill(); x.shadowColor = 'transparent'; x.clip();
  if (coverHi){
    const k = Math.max(ra.width / coverHi.width, ra.height / coverHi.height), w = coverHi.width * k, h = coverHi.height * k;
    x.imageSmoothingQuality = 'high'; x.drawImage(coverHi, ra.left + (ra.width - w) / 2, ra.top + (ra.height - h) / 2, w, h);
  } else {
    const P = flowPalette, g = x.createLinearGradient(ra.left, ra.top, ra.right, ra.bottom);
    g.addColorStop(0, `rgb(${P[0].join(',')})`); g.addColorStop(1, `rgb(${(P[2] || P[1] || P[0]).join(',')})`);
    x.fillStyle = g; x.fillRect(ra.left, ra.top, ra.width, ra.height);
  }
  x.restore();
  x.textBaseline = 'top';
  for (const [e, r, col] of [[ti, rt, '#fff'], [ar, rr, 'rgba(255,255,255,0.6)']]){
    const st = getComputedStyle(e);
    x.font = `${st.fontWeight} ${st.fontSize} ${st.fontFamily}`; x.fillStyle = col;
    x.fillText(fitText(x, e.textContent, r.width), r.left, r.top + (r.height - parseFloat(st.fontSize)) / 2);
  }
  return glassDom;
}
/* every frame: where the controls are, how round, how visible; then draw */
const glassFade = new WeakMap();
let glassLast = 0;
function drawGlass(){
  if (fx.ui !== 'glass'){
    if (glassGL) glassGL.canvas.style.display = 'none';
    glassOver([], 1);                                     // the copy above the settings card keeps its last picture otherwise (a lifted thumb stuck there)
    document.body.classList.remove('glass-gpu'); return;
  }
  if (!glassTried){ glassTried = true; try { glassGL = makeGlassGL(); } catch(e){ console.warn('glass', e); glassGL = null; } }
  if (!glassGL) return;
  glassGL.canvas.style.display = '';
  document.body.classList.add('glass-gpu');               // style.css: panels drawn here drop their own blur
  const dpr = Math.min(devicePixelRatio || 1, 2), now0 = performance.now(), dt = Math.min(0.5, (now0 - (glassLast || now0)) / 1000); glassLast = now0;
  const idle = document.body.classList.contains('idle');
  const items = [];
  for (const el of document.querySelectorAll(GLASS_SEL)){
    if (el.hidden || !el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight) continue;
    const hides = !!el.closest('.top, .bottom');
    let f = glassFade.get(el) ?? 1;
    f += ((hides && idle ? 0 : 1) - f) * (1 - Math.exp(-dt / 0.18));   // follows the controls' fade
    glassFade.set(el, f);
    if (f < 0.01) continue;
    const rad = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, r.width / 2, r.height / 2);
    const G = glassProfile('btn'), h = r.height * dpr, w = r.width * dpr;
    const bezel = Math.max(3 * dpr, Math.min((G.bezel ?? 18) * dpr, Math.min(w, h) * 0.5));     // 边缘宽度
    items.push({ x: r.left * dpr, y: r.top * dpr, w, h, r: rad * dpr, bezel, disp: bezel * 1.6 * (G.refr ?? 1), a: f,
      look: [G.shadow ?? 0.3, G.rim ?? 0.4, G.clear ?? 0.8], frost: G.frost ?? 0 });      // 折射
  }
  const card = document.querySelector('.modal.drawer:not([hidden]):not(.prewarm) .panel');
  if (card){
    const r = card.getBoundingClientRect(), G = GLASS_DRAWER;
    if (r.width > 4 && r.left < innerWidth && r.right > 0){
      const rad = Math.min(parseFloat(getComputedStyle(card).borderTopLeftRadius) || 0, r.width / 2, r.height / 2), bezel = G.bezel * dpr;
      items.push({ x: r.left * dpr, y: r.top * dpr, w: r.width * dpr, h: r.height * dpr, r: rad * dpr, bezel, disp: bezel * 1.6 * G.refr, a: 1,
        look: [G.shadow, G.rim, G.clear], frost: G.frost });
    }
  }
  const over = [];
  for (const fn of glassExtra){ const it = fn(dpr); if (it) for (const x of [].concat(it)) (x.over ? over : items).push(x); }
  glassOver(over, dpr);
  glassGL.draw(items, dpr);
}
/* Glass for controls that lie on the settings card (the lifted thumb of its segmented switches, seg-thumb.js). The
   card is a page element above the GPU layer, so glass drawn there would be under it. These pieces are drawn first,
   alone, by the same shader, and the picture is copied to a canvas above the page (#glassOver) before the layer
   draws its usual frame. Same glass as everywhere else, smooth, instead of the browser's displacement filter, which
   samples without smoothing and made the words under it jagged. Only while such a piece exists. */
let glassOverC = null, glassOverBox = null;
/* the lifted knob of a switch or a slider as such a piece: cur = { x, y, w, h (css px, in the window), a },
   under = a picture of what lies under it (its track), which the glass bends. The fixed look of the controls. */
function glassKnob(cur, under, dpr){
  const w = cur.w * dpr, h = cur.h * dpr, G = GLASS_LOOK, bezel = Math.max(3 * dpr, Math.min(G.bezel * dpr, Math.min(w, h) * 0.5));
  return { x: cur.x * dpr, y: cur.y * dpr, w, h, r: h / 2, bezel, disp: bezel * 1.6 * G.refr, a: cur.a, look: [G.shadow, G.rim, G.clear], frost: GLASS_DRAWER.frost, ovl: under, over: true };   // lies on the settings card: it refracts the frosted scene, as the card does, not the sharp lyrics behind it
}
let glassKnobSeq = 0;
function glassOver(over, dpr){
  const c = glassOverC, x = c && c.getContext('2d');
  if (x && glassOverBox){ x.clearRect(...glassOverBox); glassOverBox = null; }
  if (!over.length){ if (c) c.style.display = 'none'; return; }
  glassGL.draw(over, dpr);
  const g = glassGL.canvas, cv = glassOverC || (glassOverC = document.body.appendChild(Object.assign(document.createElement('canvas'), { id: 'glassOver', className: 'glassover' })));
  cv.setAttribute('aria-hidden', 'true');
  if (cv.width !== g.width || cv.height !== g.height){ cv.width = g.width; cv.height = g.height; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const m = 26 * dpr;                                // the shadow around a piece
  for (const it of over){
    const r = it.blit ? it.ovl.rect : [it.x - m, it.y - m, it.w + 2 * m, it.h + 2 * m];
    x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[0] + r[2]); y1 = Math.max(y1, r[1] + r[3]);
  }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(g.width, Math.ceil(x1)); y1 = Math.min(g.height, Math.ceil(y1));
  cv.style.display = '';
  if (x1 <= x0 || y1 <= y0) return;
  cv.getContext('2d').drawImage(g, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  glassOverBox = [x0, y0, x1 - x0, y1 - y0];
}
/* the look of the glass on the controls: fixed, chosen by eye (it used to be six sliders in the settings, for tuning) */
const GLASS_LOOK = { shadow: 0.6, rim: 0.25, clear: 1, refr: 0.4, bezel: 47, frost: 0 };
const glassProfile = () => GLASS_LOOK;
function applyGlass(){
  const on = fx.ui === 'glass';
  document.body.classList.toggle('ui-glass', on);
  document.querySelectorAll(GLASS_SEL).forEach(el => el.classList.toggle('lg', on));
  if (!on && glassGL) glassGL.canvas.style.display = 'none';
}
document.querySelectorAll('#fxUi button').forEach(b => b.onclick = () => { fx.ui = b.dataset.ui; saveFx(); applyFx(); setCur(null); render(true); });

function setGlassKnobSeq(v){ return glassKnobSeq = v; }   // other modules cannot assign to an imported binding

/* names that modules loaded before this one call or read (core/late.js) */
Object.assign(late, { applyGlass });
