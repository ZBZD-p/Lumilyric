import { late } from '../core/late.js';
import { fx, hexRGB } from '../core/settings.js';

export {
  bloomOpts,
  exportBloomGL,
  useWebGL,
};

/* WebGL bloom (glow) */
/* ================= WebGL renderer: physically based bloom =================
   The method of "Next Generation Post Processing in Call of Duty: Advanced Warfare" (Jimenez, SIGGRAPH 2014),
   as used by Unity, Unreal and Blender: work in linear light; halve the image 5-8 times with a 13-tap filter;
   then walk back up, adding each smaller level onto the next larger one through a 3x3 tent filter. Each level
   is twice as wide as the one before, so the light falls off smoothly instead of in rings. Written from the
   published description; three.js's UnrealBloomPass (MIT) served as a reference for the overall structure. */
const BLOOM_VS = 'attribute vec2 p;varying vec2 uv;void main(){uv=p*.5+.5;gl_Position=vec4(p,0.,1.);}';
const BLOOM_LIN = 'vec4 lin(vec4 c){return c.a>0.?vec4(pow(c.rgb/c.a,vec3(2.2))*c.a,c.a):vec4(0.);}';
// first step: straight from the 8-bit text layer (sRGB, premultiplied) into linear light, 13-tap downsample
const BLOOM_DOWN = (first) => `precision highp float;varying vec2 uv;uniform sampler2D src;uniform vec2 px;uniform float gain,th;
${BLOOM_LIN}
float G(float b){if(th<=0.)return 1.;float hi=min(1.,th+.3);return smoothstep(min(th,hi-.05),hi,b);}
vec4 S(vec2 o){vec4 c=texture2D(src,uv+o*px);return ${first ? 'lin(c)*G(max(c.a,max(c.r,max(c.g,c.b))))' : 'c'};}
void main(){
  vec4 a=S(vec2(-2.,2.)),b=S(vec2(0.,2.)),c=S(vec2(2.,2.)),d=S(vec2(-2.,0.)),e=S(vec2(0.)),f=S(vec2(2.,0.)),
       g=S(vec2(-2.,-2.)),h=S(vec2(0.,-2.)),i=S(vec2(2.,-2.)),j=S(vec2(-1.,1.)),k=S(vec2(1.,1.)),l=S(vec2(-1.,-1.)),m=S(vec2(1.,-1.));
  gl_FragColor=(e*.125+(a+c+g+i)*.03125+(b+d+f+h)*.0625+(j+k+l+m)*.125)*gain;
}`;
const BLOOM_UP = `precision highp float;varying vec2 uv;uniform sampler2D src;uniform vec2 px;uniform float w;
vec4 S(vec2 o){return texture2D(src,uv+o*px);}
void main(){
  vec4 r=S(vec2(0.))*4.+(S(vec2(0.,1.))+S(vec2(-1.,0.))+S(vec2(1.,0.))+S(vec2(0.,-1.)))*2.
        +S(vec2(-1.,1.))+S(vec2(1.,1.))+S(vec2(-1.,-1.))+S(vec2(1.,-1.));
  gl_FragColor=r/16.*w;
}`;
const BLOOM_FINAL = `precision highp float;varying vec2 uv;uniform sampler2D txt,blm;uniform vec3 tint;uniform float k,seed,dith;
${BLOOM_LIN}
float h(vec2 q){return fract(sin(dot(q,vec2(12.9898,78.233)))*43758.5453);}
void main(){
  vec4 t=lin(texture2D(txt,uv)),b=texture2D(blm,uv);
  b.rgb*=tint;
  vec4 f=t+b*k;                                          // light adds up in linear space
  float a=clamp(f.a,0.,1.);
  vec3 c=a>0.?clamp(f.rgb/max(f.a,1e-4),0.,1.):vec3(0.);
  c=pow(c,vec3(1./2.2));
  // The page / export canvas is 8-bit and premultiplied, so what is stored is c*a and a: the faint tail of the halo is
  // a run of 1/255 values that ends in a hard edge (1 -> 0) a thin ring around the light. So the dither goes on what
  // is stored (alpha and premultiplied colour, one random threshold for both), not on the colour before it is
  // multiplied by a tiny alpha, where it was worth nothing. Rounding with a random threshold keeps the average:
  // a tail of 0.2/255 becomes one pixel in five at 1/255, which has no edge.
  float u=.5+.5*(h(gl_FragCoord.xy+seed)+h(gl_FragCoord.xy+seed+7.7)-1.)*dith;
  float aq=floor(a*255.+u)/255.;
  vec3 pq=min(floor(c*a*255.+u)/255.,vec3(aq));
  gl_FragColor=vec4(pq,aq);
}`;
function makeBloomGL(canvas){
  const opt = { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true };
  let gl = canvas.getContext('webgl2', opt), v2 = !!gl;
  if (!gl) gl = canvas.getContext('webgl', opt);
  if (!gl) return null;
  // half-float targets when possible (smooth halos), 8-bit otherwise
  let fmt = { internal: gl.RGBA, type: gl.UNSIGNED_BYTE };
  if (v2 && gl.getExtension('EXT_color_buffer_float')) fmt = { internal: gl.RGBA16F, type: gl.HALF_FLOAT };
  else if (!v2){
    const hf = gl.getExtension('OES_texture_half_float'), cb = gl.getExtension('EXT_color_buffer_half_float');
    gl.getExtension('OES_texture_half_float_linear');
    if (hf && cb) fmt = { internal: gl.RGBA, type: hf.HALF_FLOAT_OES };
  }
  const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const vs = sh(gl.VERTEX_SHADER, BLOOM_VS);
  const prog = fs => {
    const p = gl.createProgram(); gl.attachShader(p, vs); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; return { p, u: n => (u[n] ??= gl.getUniformLocation(p, n)) };
  };
  let P;
  try { P = { down0: prog(BLOOM_DOWN(true)), down: prog(BLOOM_DOWN(false)), up: prog(BLOOM_UP), fin: prog(BLOOM_FINAL) }; }
  catch (e){ console.warn('bloom shaders', e); return null; }
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const newTex = (w, h, type, internal) => {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER].forEach(k => gl.texParameteri(gl.TEXTURE_2D, k, gl.LINEAR));
    [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T].forEach(k => gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE));
    if (w) gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
    return t;
  };
  const srcTex = newTex();
  let mips = [], mipKey = '', frame = 0;
  function ensureMips(W, H, n){
    const key = W + 'x' + H + 'x' + n;
    if (key === mipKey) return;
    mips.forEach(m => { gl.deleteTexture(m.t); gl.deleteFramebuffer(m.f); });
    mips = [];
    let w = W, h = H;
    for (let i = 0; i < n; i++){
      w = Math.max(1, w >> 1); h = Math.max(1, h >> 1);
      const t = newTex(w, h, fmt.type, fmt.internal), f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE && fmt.type !== gl.UNSIGNED_BYTE){
        fmt = { internal: gl.RGBA, type: gl.UNSIGNED_BYTE }; mipKey = ''; return ensureMips(W, H, n);   // float targets refused: 8-bit
      }
      mips.push({ t, f, w, h });
    }
    mipKey = key;
  }
  const quad = () => gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return {
    canvas,
    /* src: 2D canvas with the text (transparent). o: { levels, weights[], tint[3], k } */
    render(src, o){
      const W = src.width, H = src.height;
      if (canvas.width !== W || canvas.height !== H){ canvas.width = W; canvas.height = H; }
      const n = Math.max(1, Math.min(o.levels, Math.floor(Math.log2(Math.min(W, H))) - 4));   // smallest level >= 1/16: no haze over the whole frame
      ensureMips(W, H, n);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.disable(gl.BLEND);
      // down
      let inT = srcTex, iw = W, ih = H;
      mips.forEach((m, i) => {
        const pr = i ? P.down : P.down0;
        gl.useProgram(pr.p); gl.bindFramebuffer(gl.FRAMEBUFFER, m.f); gl.viewport(0, 0, m.w, m.h);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, inT);
        gl.uniform1i(pr.u('src'), 0); gl.uniform2f(pr.u('px'), 1 / iw, 1 / ih);
        // the finest level is stored scaled by its weight; the next level undoes that when it reads it
        const w0 = Math.max(0.05, o.weights[0] ?? 1);
        gl.uniform1f(pr.u('gain'), i === 0 ? w0 : i === 1 ? 1 / w0 : 1);
        if (!i) gl.uniform1f(pr.u('th'), o.th || 0);
        quad();
        inT = m.t; iw = m.w; ih = m.h;
      });
      // up: add each level onto the next larger one
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(P.up.p); gl.uniform1i(P.up.u('src'), 0);
      for (let i = mips.length - 1; i > 0; i--){
        const s = mips[i], d = mips[i - 1];
        gl.bindFramebuffer(gl.FRAMEBUFFER, d.f); gl.viewport(0, 0, d.w, d.h);
        gl.bindTexture(gl.TEXTURE_2D, s.t);
        gl.uniform2f(P.up.u('px'), 1 / s.w, 1 / s.h);
        gl.uniform1f(P.up.u('w'), o.weights[i] ?? 1);
        quad();
      }
      gl.disable(gl.BLEND);
      // final: text + bloom, back to sRGB, dithered, premultiplied for the page / the export canvas
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H);
      gl.useProgram(P.fin.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex); gl.uniform1i(P.fin.u('txt'), 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mips[0].t); gl.uniform1i(P.fin.u('blm'), 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform3fv(P.fin.u('tint'), o.tint); gl.uniform1f(P.fin.u('k'), o.k); gl.uniform1f(P.fin.u('dith'), o.dith || 1);
      gl.uniform1f(P.fin.u('seed'), (frame++ % 64) * 1.618);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      quad();
    }
  };
}
/* bloom settings from the 辉光 panel */
function bloomOpts(M){
  const g = fx.glow, c = hexRGB(g.color).map(v => (v / 255) ** 2.2);
  const reach = g.radius * M.fs * (g.style === 'dream' ? 7 : g.style === 'neon' ? 3 : 4.5);   // how far the light spreads, px
  const levels = Math.max(3, Math.min(7, Math.round(Math.log2(Math.max(4, reach)))));
  const decay = g.style === 'neon' ? 0.72 : g.style === 'dream' ? 1.18 : 0.95;  // weight per step outwards
  // the two finest levels are kept low: at full strength they fill the insides of the letters and smear them
  const weights = Array.from({ length: 9 }, (_, i) => decay ** i * (i === 0 ? 0.3 : i === 1 ? 0.65 : 1));
  const white = g.style === 'neon' ? 0.1 : 0.35;           // pastel halo except for neon
  const tint = c.map(v => v + (1 - v) * white);
  const L = levels + (g.style === 'dream' ? 1 : 0);
  const sumW = weights.slice(0, L).reduce((a, b) => a + b, 0);
  const k = g.strength * (g.style === 'neon' ? 1.8 : g.style === 'dream' ? 2.1 : 1.7) * 3 / sumW;   // same overall energy at any spread
  return { levels: L, weights, tint, k, th: g.thresh || 0 };
}
let bloomX = null, bloomXTried = false;                    // offscreen bloom for video export
function exportBloomGL(){
  if (!bloomXTried){ bloomXTried = true; try { bloomX = makeBloomGL(document.createElement('canvas')); } catch(e){ bloomX = null; } }
  return bloomX;
}
const useWebGL = () => fx.render === 'webgl';

/* names that modules loaded before this one call or read (core/late.js) */
Object.assign(late, { useWebGL, makeBloomGL, bloomOpts });
