import { late } from '../core/late.js';
import { coverHi, coverURL, mkCanvas, paletteFrom, prepCoverTex, setBgDirty, setCoverBmp, setCoverHi, setCoverLabel, setCoverURL, setFlowPalette } from './background.js';

export {
  coverSide,
  extractCover,
  imageSide,
  setCover,
};

/* Cover picture embedded in audio files */
/* the cover picture embedded in an audio file: ID3v2 APIC (mp3), FLAC PICTURE, MP4 'covr' (m4a) */
function id3Picture(u8){
  if (u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return null;
  const ver = u8[3], ss = (a, b, c, d) => (a << 21) | (b << 14) | (c << 7) | d;
  const be = i => ((u8[i] << 24) >>> 0) + (u8[i + 1] << 16) + (u8[i + 2] << 8) + u8[i + 3];
  const size = ss(u8[6], u8[7], u8[8], u8[9]) + 10;
  let p = 10;
  if (u8[5] & 0x40) p += ver === 4 ? ss(u8[10], u8[11], u8[12], u8[13]) : be(10) + 4;
  const stop = Math.min(size, u8.length);
  while (p + 10 < stop){
    const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsz = ver === 4 ? ss(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]) : be(p + 4);
    if (id === 'APIC'){
      let q = p + 10; const end = Math.min(q + fsz, u8.length), enc = u8[q++];
      let mime = ''; while (q < end && u8[q]) mime += String.fromCharCode(u8[q++]);
      q += 2;                                                     // end of mime + picture type
      if (enc === 1 || enc === 2){ while (q + 1 < end && !(u8[q] === 0 && u8[q + 1] === 0)) q += 2; q += 2; }
      else { while (q < end && u8[q]) q++; q++; }
      return new Blob([u8.subarray(q, end)], { type: mime.includes('/') ? mime : 'image/jpeg' });
    }
    p += 10 + fsz;
  }
  return null;
}
function flacPicture(u8){
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'fLaC') return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 4;
  while (p + 4 <= u8.length){
    const hdr = u8[p], type = hdr & 0x7f, len = (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3];
    p += 4;
    if (type === 6 && p + len <= u8.length){
      let q = p + 4;
      const ml = dv.getUint32(q); q += 4;
      const mime = new TextDecoder().decode(u8.subarray(q, q + ml)); q += ml;
      const dl = dv.getUint32(q); q += 4 + dl + 16;
      const n = dv.getUint32(q); q += 4;
      return new Blob([u8.subarray(q, q + n)], { type: mime || 'image/jpeg' });
    }
    p += len;
    if (hdr & 0x80) break;
  }
  return null;
}
function mp4Picture(u8){
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let i = 0; i + 24 < u8.length; i++){
    if (u8[i] === 0x63 && u8[i + 1] === 0x6f && u8[i + 2] === 0x76 && u8[i + 3] === 0x72 &&       // 'covr'
        u8[i + 8] === 0x64 && u8[i + 9] === 0x61 && u8[i + 10] === 0x74 && u8[i + 11] === 0x61){  // 'data'
      const dl = dv.getUint32(i + 4);
      return new Blob([u8.subarray(i + 20, Math.min(u8.length, i + 4 + dl))]);
    }
  }
  return null;
}
async function extractCover(file){
  const LIM = 12 * 1024 * 1024;
  const head = new Uint8Array(await file.slice(0, LIM).arrayBuffer());
  let b = id3Picture(head) || flacPicture(head) || mp4Picture(head);
  if (!b && file.size > LIM && /\.(m4a|mp4|aac|alac)$/i.test(file.name))      // m4a tags may sit at the end
    b = mp4Picture(new Uint8Array(await file.slice(file.size - LIM).arrayBuffer()));
  return b;
}
/* short side in px of the picture now used as the cover (0 = none yet), and of any picture */
let coverSide = 0;
async function imageSide(blob){
  try { const b = await createImageBitmap(blob), s = Math.min(b.width, b.height); if (b.close) b.close(); return s; } catch(e){ return 0; }
}
async function setCover(blob, label){
  try {
    const bmp = await createImageBitmap(blob);
    coverSide = Math.min(bmp.width, bmp.height);
    const s = 256, k = Math.min(1, s / Math.max(bmp.width, bmp.height));      // keep a small copy: it gets blurred anyway
    const c = mkCanvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    setCoverBmp(c);
    const k2 = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));      // sharp copy for the cover panel
    setCoverHi(mkCanvas(Math.max(1, Math.round(bmp.width * k2)), Math.max(1, Math.round(bmp.height * k2))));
    const hx = coverHi.getContext('2d'); hx.imageSmoothingQuality = 'high'; hx.drawImage(bmp, 0, 0, coverHi.width, coverHi.height);
    late.setCoverPanelDirty(true);
    setFlowPalette(paletteFrom(c, 6));
    prepCoverTex(c);
    if (coverURL) URL.revokeObjectURL(coverURL);
    setCoverURL(URL.createObjectURL(blob)); setCoverLabel(label);
    setBgDirty(true); late.applyFx();
    return true;
  } catch (e){ return false; }
}
