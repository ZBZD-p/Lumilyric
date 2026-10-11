import { late } from '../core/late.js';
import { $, audioFile, mode, setCur, song } from '../core/lyrics.js';
import { exitSpec, fx, glowLayers, lt, lyricDelay, now, setLyricDelay, setPlaying, total } from '../core/settings.js';
import { oneLine, render } from '../render/view-dom.js';
import { PRESETS, buildTimeline, canvasMeasurer, layoutSeg } from '../render/text-canvas.js';
import { exportFlowGL, exportProf, exportProfText, flowGLx, setExportDith, setExportProf, setExportProfText } from '../background/background.js';
import { useScroll } from '../render/layout-scroll.js';
import { useWordMode } from '../render/layout-words.js';
import { drawFrame, useCoverPanel } from '../render/frame.js';

export {
  closeExport,
  exporting,
  fmtDelay,
  setDelay,
};

/* Video export: MP4 / MOV / PNG ZIP, audio, saving */
/* ---- export panel ---- */
const xp = {
  modal: $('exportModal'), canvas: $('xPreview'), size: $('xSize'), fps: $('xFps'),
  go: $('xStart'), cancel: $('xCancel'), save: $('xSave'), bar: $('xBar'), msg: $('xMsg'), info: $('xInfo'),
  fmt: $('xFmt'), qual: $('xQual'), speed: $('xSpeed'), disk: $('xDisk'), diskInfo: $('xDiskInfo'), note: $('xNote'), est: $('xEst'), crop: $('xCrop'), cropInfo: $('xCropInfo'), audio: $('xAudio'), audioInfo: $('xAudioInfo')
};
let exporting = false, abortExport = false, exported = null, withAudio = false;
const modeName = () => ({ en: 'English', zh: '中文', both: '双语' })[mode];

const FMT_NOTES = {
  mp4: '视频只有画面、没有声音，从 0:00 开始，放进剪辑软件后和原曲开头对齐即可。',
  mp4a: '视频带原曲声音（AAC 编码），画面和声音已经对齐，放进剪辑软件直接用。',
  mov: '透明背景的 MOV（PNG 编码，无损）。Premiere、After Effects、达芬奇、Final Cut 可直接导入并保留透明；文件比 MP4 大。剪映对这种格式的支持不确定，建议先导一小段试试。',
  zip: '每一帧一张透明 PNG，打包成 ZIP。解压后：Premiere 导入第一张并勾选“图像序列”；达芬奇会自动识别为序列；AE 导入时勾选“PNG 序列”。帧率按导出时选的设置。'
};
/* smallest centred box that holds every line through its whole animation (blur, rise, exit drift) */
function cropBox(M, segs, W, H){
  const fs = M.fs, sfs = M.sfs, bs = fs / 72;
  const lineH = fs * 1.15, subH = sfs * 1.45, gap = sfs * 0.7;
  let maxW = 0, maxH = 0;
  for (const seg of segs){
    if (seg.blank) continue;
    const lay = layoutSeg(seg, M);
    const k = seg.title ? 0.7 : 1;
    const w = Math.max(0, ...lay.rows.map(r => r.width), ...lay.subRows.map(r => r.width)) * k;
    const h = (lay.rows.length * lineH + (lay.subRows.length ? gap + lay.subRows.length * subH : 0)) * k;
    maxW = Math.max(maxW, w); maxH = Math.max(maxH, h);
  }
  const blurPad = 2 * 22 * bs + (fx.glow.on ? Math.max(...glowLayers().map(L => L.sigma)) * fs * 2.5 : 0);   // widest blur + glow
  const X = exitSpec();
  const hw = maxW / 2 * (1 + Math.max(0, X.sc)) + blurPad + 0.2 * fs;
  const hh = maxH / 2 * (1 + Math.max(0, X.sc)) + Math.max(0.6, Math.abs(X.dy) + 0.1) * fs + blurPad + 0.2 * fs;   // entry starts 0.42 em low; exits drift by dy
  const even = v => Math.max(2, Math.ceil(v / 2) * 2);
  const w = Math.min(W, even(2 * hw)), h = Math.min(H, even(2 * hh));
  return { w, h, x: (W - w) / 2, y: (H - h) / 2 };
}

function audioOpt(){
  const canAudio = xp.fmt.value === 'mp4' && !!audioFile && !!window.AudioEncoder;
  xp.audio.disabled = !canAudio || exporting;
  xp.audioInfo.textContent = !audioFile ? '还没有载入音频' : xp.fmt.value !== 'mp4' ? '透明格式不带声音，在剪辑软件里放原曲即可'
    : !window.AudioEncoder ? '这个浏览器不支持音频编码，请用最新版 Chrome / Edge' : audioFile.name;
  xp.note.textContent = FMT_NOTES[canAudio && xp.audio.checked ? 'mp4a' : xp.fmt.value] + (xp.fmt.value === 'mp4' && fx.bg.mode !== 'flow' ? '背景纯黑，也可以用“滤色 / Screen”混合模式叠到其他画面上。' : '');
}
function previewFrame(){
  const [W, H] = PRESETS[xp.size.value];
  if (!canPickFile()){
    xp.disk.checked = false; xp.disk.disabled = true;
    xp.diskInfo.textContent = '这里不能选位置（需要用 Chrome / Edge 直接打开本地页面），导出后点“保存视频”';
  }
  const transparent = xp.fmt.value !== 'mp4';
  xp.fmt.options[0].text = 'MP4 · ' + (fx.bg.mode === 'flow' ? '流光背景（效果设置里的背景）' : '黑色背景');
  xp.qual.closest('label').hidden = transparent;          // PNG frames are lossless anyway
  xp.speed.closest('label').hidden = transparent;
  xp.canvas.width = W; xp.canvas.height = H;
  xp.canvas.classList.toggle('alpha', transparent);
  audioOpt();
  const ctx = xp.canvas.getContext('2d');
  const M = canvasMeasurer(ctx, W, H);
  const segs = buildTimeline(M);
  let t = lt(now());
  if (t < 0.5 && song.lines[0]) t = song.lines[0].t + 1.5;   // show a real lyric line in the preview
  drawFrame(ctx, W, H, M, segs, t, transparent);
  if (useCoverPanel()) xp.cropInfo.textContent = '显示封面时导出完整画面';
  else if (useScroll()) xp.cropInfo.textContent = '滚动歌词铺满整个画面，这次导出完整画面';
  else if (useWordMode()) xp.cropInfo.textContent = '逐词布局导出完整画面';
  else if (fx.bg.mode === 'flow' && !transparent) xp.cropInfo.textContent = '流光背景铺满整个画面，这次导出完整画面';
  else if (xp.crop.checked){
    const b = cropBox(M, segs, W, H);
    ctx.save();
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.setLineDash([W / 120, W / 160]); ctx.lineWidth = Math.max(2, W / 640);
    ctx.strokeStyle = 'rgba(255,255,255,.55)';
    ctx.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
    ctx.restore();
    xp.cropInfo.textContent = `导出 ${b.w}×${b.h}，放在 ${W}×${H} 画面正中间即可`;
  } else xp.cropInfo.textContent = '';
  estimateSize();
}
/* rough file size of a transparent export (MOV / PNG ZIP): a few real frames are rendered and PNG-encoded at the
   export size, and the share of frames that change is measured over the whole song (frames where nothing moves
   are stored once). Runs a moment after the settings change, in small steps so the page stays responsive. */
let estSeq = 0;
const fmtBytes = b => b >= 1e9 ? (b / 1073741824).toFixed(1) + ' GB' : b >= 1e6 ? Math.round(b / 1048576) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
async function estimateSize(){
  const id = ++estSeq;
  const el = xp.est, fmtSel = xp.fmt.value;
  if (fmtSel === 'mp4' || exporting){ el.hidden = true; return; }
  el.hidden = false; el.textContent = '正在估算文件大小…';
  await new Promise(r => setTimeout(r, 250));
  if (id !== estSeq) return;
  const [W, H] = PRESETS[xp.size.value], fps = +xp.fps.value;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { alpha: true });
  const M = canvasMeasurer(ctx, W, H), segs = buildTimeline(M);
  let EW = W, EH = H;
  if (xp.crop.checked && !useScroll() && !useWordMode() && !useCoverPanel()){
    const b = cropBox(M, segs, W, H); EW = b.w; EH = b.h;
    cv.width = EW; cv.height = EH; ctx.setTransform(1, 0, 0, 1, -b.x, -b.y);
  }
  const probe = { fillRect(){}, clearRect(){}, beginPath(){}, rect(){}, clip(){}, save(){}, restore(){}, translate(){}, scale(){}, drawImage(){}, setTransform(){}, getTransform(){ return new DOMMatrix(); }, set globalAlpha(v){}, set globalCompositeOperation(v){}, set fillStyle(v){}, set filter(v){} };
  const probeM = Object.assign(Object.create(M), { sprites: { draw(){}, drawLit(){} }, _probe: true });
  const keyAt = t => drawFrame(probe, W, H, probeM, segs, lt(t), true);
  const dur = total() + 1, frames = Math.ceil(dur * fps);
  // 1) how many frames change: sample the song evenly, compare each sample with the frame right after it
  const S = Math.min(frames, 900), moving = [];
  for (let i = 0; i < S; i++){
    const t = (i + 0.5) * dur / S, k = keyAt(t);
    if (k == null || k !== keyAt(t + 1 / fps)) moving.push(t);
    if (i % 150 === 149){ await tick0(); if (id !== estSeq) return; }
  }
  const moveShare = moving.length / S;
  // 2) how big one changing frame is: render a few of them and encode them to PNG
  const pick = moving.length ? Array.from({ length: Math.min(8, moving.length) }, (_, j) => moving[Math.floor((j + 0.5) * moving.length / Math.min(8, moving.length))]) : [];
  let bytes = 0;
  for (const t of pick){
    drawFrame(ctx, W, H, M, segs, lt(t), true);
    const b = await new Promise(r => cv.toBlob(r, 'image/png'));
    bytes += b ? b.size : 0;
    if (id !== estSeq) return;
  }
  const per = pick.length ? bytes / pick.length : 0;
  const changing = Math.round(frames * moveShare);
  // static stretches still store their first frame once
  const total0 = changing * per + Math.max(1, Math.round(frames * (1 - moveShare) / (fps * 3))) * per;
  el.innerHTML = `预计文件大小：约 <b>${fmtBytes(total0 * 0.8)} – ${fmtBytes(total0 * 1.25)}</b>` +
    `<br>${EW}×${EH} · ${fps} fps · ${frames} 帧，其中约 ${Math.round(moveShare * 100)}% 的帧在动（每帧约 ${fmtBytes(per)}），不动的帧不重复存。` +
    (total0 > 2e9 ? `<br>文件较大：勾选「只导出歌词区域」、改用 30 fps，或者导出黑底 MP4 再用「滤色」叠加，都能小很多。` : '');
}
function openExport(){
  if (!exporting) setPlaying(false);              // while a background export runs, the music keeps going
  xp.modal.hidden = false;
  $('xPill').hidden = true;
  xp.info.textContent = `时长 ${late.fmt(total())} · 语言：${modeName()} · ${oneLine ? '单行模式' : '自动换行'}` + (lyricDelay ? ` · 偏移 ${lyricDelay > 0 ? '+' : ''}${lyricDelay.toFixed(2)}s` : '');
  if (!exporting && !exported){ xp.save.hidden = true; xp.msg.textContent = ''; setBar(0); }
  if (!exporting) previewFrame();
  xp.go.focus();
}
function closeExport(){ if (exporting) return hideExport(); xp.modal.hidden = true; }
/* background export: the window goes away, a small pill shows progress; the player stays usable */
function hideExport(){
  xp.modal.hidden = true;
  updatePill();
  $('xPill').hidden = false; $('xPill').focus();
}
let pillPct = 0;
function updatePill(){
  const p = $('xPill');
  if (exporting){ p.classList.remove('done'); p.textContent = `正在导出 ${Math.round(pillPct * 100)}% · 点这里查看`; }
  else if (exported){ p.classList.add('done'); p.textContent = exported.saved ? '视频已保存 · 点这里查看' : '视频导出好了 · 点这里保存'; }
  else { p.classList.add('done'); p.textContent = '导出已结束 · 点这里查看'; }
}
$('xPill').onclick = openExport;
$('xHide').onclick = hideExport;
function setBar(v){ xp.bar.style.width = (v * 100).toFixed(1) + '%'; pillPct = v; if (!$('xPill').hidden) updatePill(); }
/* live preview while exporting: the frame just rendered, shown in the export window about once per second */
function showLive(cv, box, W, H, transparent){
  if (xp.modal.hidden) return;
  const c = xp.canvas;
  if (c.width !== W || c.height !== H){ c.width = W; c.height = H; }
  const x = c.getContext('2d');
  x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; x.filter = 'none';
  if (transparent) x.clearRect(0, 0, W, H); else { x.fillStyle = '#000'; x.fillRect(0, 0, W, H); }
  x.drawImage(cv, box ? box.x : 0, box ? box.y : 0);
}
const tick0 = () => new Promise(r => setTimeout(r, 0));

/* ---------- container writers for transparent output ---------- */
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++){ let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8, crc = 0){ crc = ~crc >>> 0; for (let i = 0; i < u8.length; i++) crc = CRC_T[(crc ^ u8[i]) & 255] ^ (crc >>> 8); return ~crc >>> 0; }

class Bytes {                      // tiny big/little-endian byte builder
  constructor(){ this.a = []; }
  u8(v){ this.a.push(v & 255); return this; }
  u16(v){ return this.u8(v >> 8).u8(v); }
  u32(v){ return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v); }
  u64(v){ return this.u32(Math.floor(v / 4294967296)).u32(v >>> 0); }
  le16(v){ return this.u8(v).u8(v >> 8); }
  le32(v){ return this.u8(v).u8(v >>> 8).u8(v >>> 16).u8(v >>> 24); }
  str(s){ for (const ch of s) this.u8(ch.charCodeAt(0)); return this; }
  raw(u8){ for (const b of u8) this.a.push(b); return this; }
  zero(n){ for (let i = 0; i < n; i++) this.a.push(0); return this; }
  out(){ return new Uint8Array(this.a); }
}
function atom(type, ...parts){
  const body = parts.map(p => p instanceof Uint8Array ? p : p.out());
  const len = 8 + body.reduce((n, b) => n + b.length, 0);
  const h = new Bytes().u32(len).str(type).out();
  const o = new Uint8Array(len); o.set(h, 0); let off = 8;
  for (const b of body){ o.set(b, off); off += b.length; }
  return o;
}

/* QuickTime .mov with PNG frames (codec 'png ', 32-bit depth = RGBA) */
/* PNG encoding spread over several CPU cores: each frame is handed to a worker as an ImageBitmap, the worker
   encodes it (and, for ZIP, computes its CRC) on its own thread. The browser's canvas.toBlob does one frame at a
   time, which is what limited transparent exports. Falls back to toBlob where workers are not available. */
const PNG_WORKER_SRC = `
const T = new Uint32Array(256); for (let n = 0; n < 256; n++){ let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c >>> 0; }
let cv = null, cx = null;
onmessage = async e => {
  const { id, bmp, crc } = e.data;
  try {
    if (!cv || cv.width !== bmp.width || cv.height !== bmp.height){ cv = new OffscreenCanvas(bmp.width, bmp.height); cx = cv.getContext('2d'); }
    cx.clearRect(0, 0, cv.width, cv.height); cx.drawImage(bmp, 0, 0); bmp.close();
    const blob = await cv.convertToBlob({ type: 'image/png' });
    let c = 0;
    if (crc){ const u = new Uint8Array(await blob.arrayBuffer()); c = ~0 >>> 0; for (let i = 0; i < u.length; i++) c = T[(c ^ u[i]) & 255] ^ (c >>> 8); c = ~c >>> 0; }
    postMessage({ id, blob, size: blob.size, crc: c });
  } catch (err){ postMessage({ id, error: String(err && err.message || err) }); }
};`;
async function pngPool(withCrc){
  const n = Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  let ws = [];
  try {
    if (typeof OffscreenCanvas !== 'function' || typeof Worker !== 'function' || !window.createImageBitmap) throw 0;
    const url = URL.createObjectURL(new Blob([PNG_WORKER_SRC], { type: 'text/javascript' }));
    ws = Array.from({ length: n }, () => new Worker(url));
    URL.revokeObjectURL(url);
  } catch (e){ ws.forEach(w => w.terminate()); ws = []; }
  const waiting = new Map(); let seq = 0, rr = 0;
  ws.forEach(w => w.onmessage = e => { const p = waiting.get(e.data.id); if (p){ waiting.delete(e.data.id); e.data.error ? p.rej(new Error(e.data.error)) : p.res(e.data); } });
  const viaToBlob = cv => new Promise((res, rej) => cv.toBlob(async b => {
    if (!b) return rej(new Error('PNG 编码失败'));
    res({ blob: b, size: b.size, crc: withCrc ? crc32(new Uint8Array(await b.arrayBuffer())) : 0 });
  }, 'image/png'));
  const pool = {
    threads: ws.length,
    // returns a promise of { blob, size, crc } for what the canvas shows right now
    async encode(cv){
      if (!ws.length) return viaToBlob(cv);
      const bmp = await createImageBitmap(cv);
      const id = ++seq, w = ws[rr++ % ws.length];
      return new Promise((res, rej) => { waiting.set(id, { res, rej }); w.postMessage({ id, bmp, crc: withCrc }, [bmp]); });
    },
    close(){ ws.forEach(w => w.terminate()); }
  };
  if (ws.length){                          // make sure the workers really run here (some pages forbid them)
    try {
      const c = document.createElement('canvas'); c.width = c.height = 2;
      await Promise.race([pool.encode(c), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
    } catch (e){ pool.close(); ws = []; pool.threads = 0; }
  }
  return pool;
}
/* writes pieces (bytes or Blobs) into the file the user picked, in order, while the export is still running.
   Before, MOV / ZIP were assembled as one huge Blob and only copied to the file at the end (minutes for a few GB). */
function streamSink(writable){
  let chain = Promise.resolve(), err = null, pending = 0, end = 0;
  return {
    put(data, pos){
      const n = data.size ?? data.length; pending += n; end = Math.max(end, pos + n);
      chain = chain.then(() => writable.write({ type: 'write', position: pos, data })).then(() => { pending -= n; }, e => { err = err || e; });
      if (err) throw err;
    },
    get pending(){ return pending; },
    get size(){ return end; },
    async drain(){ await chain; if (err) throw err; }
  };
}
function movWriter(W, H, fps, sink){
  const ftyp = atom('ftyp', new Bytes().str('qt  ').u32(0x200).str('qt  '));
  const parts = [], offsets = [], sizes = [];
  let pos = ftyp.length + 16;                 // ftyp + 64-bit mdat header
  if (sink){ sink.put(ftyp, 0); sink.put(new Bytes().u32(1).str('mdat').u64(16).out(), ftyp.length); }   // size filled in at the end
  return {
    sink,
    add(fr, repeat){                          // fr: { blob, size } — the PNG stays a Blob (kept out of page memory)
      if (repeat && offsets.length){ offsets.push(offsets[offsets.length - 1]); sizes.push(sizes[sizes.length - 1]); return; }
      if (sink) sink.put(fr.blob, pos); else parts.push(fr.blob);
      offsets.push(pos); sizes.push(fr.size); pos += fr.size;
    },
    finish(){
      const n = sizes.length, ts = Math.round(fps * 1000), delta = 1000, dur = n * delta;
      const matrix = b => b.u32(0x10000).u32(0).u32(0).u32(0).u32(0x10000).u32(0).u32(0).u32(0).u32(0x40000000);
      const mvhd = atom('mvhd', matrix(new Bytes().u32(0).u32(0).u32(0).u32(ts).u32(dur).u32(0x10000).u16(0x100).zero(10)).zero(24).u32(2));
      const tkhd = atom('tkhd', matrix(new Bytes().u32(0x0000000f).u32(0).u32(0).u32(1).u32(0).u32(dur).zero(8).u16(0).u16(0).u16(0).u16(0)).u32(W * 65536).u32(H * 65536));
      const mdhd = atom('mdhd', new Bytes().u32(0).u32(0).u32(0).u32(ts).u32(dur).u16(0).u16(0));
      const hdlrM = atom('hdlr', new Bytes().u32(0).str('mhlr').str('vide').zero(12).u8(12).str('VideoHandler'));
      const vmhd = atom('vmhd', new Bytes().u32(1).u16(0x40).u16(0x8000).u16(0x8000).u16(0x8000));
      const hdlrD = atom('hdlr', new Bytes().u32(0).str('dhlr').str('alis').zero(12).u8(11).str('DataHandler'));
      const dinf = atom('dinf', atom('dref', new Bytes().u32(0).u32(1), atom('alis', new Bytes().u32(1))));
      const name = 'PNG';
      const entry = atom('png ', new Bytes().zero(6).u16(1).u16(0).u16(0).str('appl').u32(0).u32(0x200)
        .u16(W).u16(H).u32(72 * 65536).u32(72 * 65536).u32(0).u16(1)
        .u8(name.length).str(name).zero(31 - name.length).u16(32).u16(0xFFFF));
      const stsd = atom('stsd', new Bytes().u32(0).u32(1), entry);
      const stts = atom('stts', new Bytes().u32(0).u32(1).u32(n).u32(delta));
      const stsc = atom('stsc', new Bytes().u32(0).u32(1).u32(1).u32(1).u32(1));
      const sz = new Bytes().u32(0).u32(0).u32(n); sizes.forEach(v => sz.u32(v));
      const co = new Bytes().u32(0).u32(n); offsets.forEach(v => co.u64(v));
      const stbl = atom('stbl', stsd, stts, stsc, atom('stsz', sz), atom('co64', co));
      const minf = atom('minf', vmhd, hdlrD, dinf, stbl);
      const moov = atom('moov', mvhd, atom('trak', tkhd, atom('mdia', mdhd, hdlrM, minf)));
      const mdatH = new Bytes().u32(1).str('mdat').u64(pos - ftyp.length).out();
      if (sink){ sink.put(moov, pos); sink.put(mdatH, ftyp.length); return null; }
      return new Blob([ftyp, mdatH, ...parts, moov], { type: 'video/quicktime' });
    }
  };
}

/* ZIP (stored, no compression — PNG is already compressed) */
function zipWriter(sink){
  const parts = [], central = [];
  let pos = 0, count = 0, last = null;
  const enc = new TextEncoder();
  return {
    addFile(name, data, crc, len = data.length ?? data.size){      // data: Uint8Array or Blob
      const nm = enc.encode(name);
      const lh = new Bytes().le32(0x04034b50).le16(20).le16(0x0800).le16(0).le16(0).le16(0x21)
        .le32(crc).le32(len).le32(len).le16(nm.length).le16(0).raw(nm).out();
      central.push(new Bytes().le32(0x02014b50).le16(20).le16(20).le16(0x0800).le16(0).le16(0).le16(0x21)
        .le32(crc).le32(len).le32(len).le16(nm.length).le16(0).le16(0).le16(0).le16(0).le32(0).le32(pos).raw(nm).out());
      if (sink){ sink.put(lh, pos); sink.put(data, pos + lh.length); } else parts.push(lh, data);
      pos += lh.length + len; count++;
      if (pos > 0xFFFFFFF0) throw new Error('PNG 序列超过 4GB，请降低分辨率或帧率');
    },
    add(fr, repeat, idx){                     // fr: { blob, size, crc }
      if (!repeat || !last) last = fr;
      this.addFile(`frames/frame_${String(idx).padStart(6, '0')}.png`, last.blob, last.crc, last.size);
    },
    sink,
    finish(){
      const cdSize = central.reduce((n, c) => n + c.length, 0);
      const eocd = new Bytes().le32(0x06054b50).le16(0).le16(0).le16(count).le16(count).le32(cdSize).le32(pos).le16(0).out();
      if (sink){ let p = pos; for (const c of central){ sink.put(c, p); p += c.length; } sink.put(eocd, p); return null; }
      return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
    }
  };
}

async function pickCodec(W, H, fps, bitrate, wantQ){
  const list = W * H > 2e6 ? ['avc1.640033', 'avc1.640034', 'avc1.4D0033'] :
               fps > 30 ? ['avc1.64002A', 'avc1.640032', 'avc1.4D002A'] : ['avc1.640028', 'avc1.64002A', 'avc1.4D0028', 'avc1.42E028'];
  let fallback = null;
  for (const hw of ['prefer-hardware', 'no-preference']){
    for (const codec of list){
      // constant quality (a fixed quantizer per frame): smooth gradients keep their fine dither instead of
      // being flattened into bands whenever the bitrate gets tight
      if (wantQ) try {
        const r = await VideoEncoder.isConfigSupported({ codec, width: W, height: H, framerate: fps, hardwareAcceleration: hw, bitrateMode: 'quantizer' });
        if (r.supported) return { codec, hw, q: true };
      } catch(e){}
      try {
        const cfg = { codec, width: W, height: H, bitrate, framerate: fps, hardwareAcceleration: hw };
        const r = await VideoEncoder.isConfigSupported(cfg);
        if (r.supported && !wantQ) return { codec, hw };
        if (r.supported && !fallback) fallback = { codec, hw };
      } catch(e){}
    }
    if (fallback) return fallback;          // the graphics card without constant quality beats a slow software encoder
  }
  return null;
}

/* audio for the MP4: the loaded file decoded at 48 kHz and encoded to AAC (Opus only if AAC is unavailable) */
async function prepareAudioTrack(file){
  const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ab = await new AC(2, 1, 48000).decodeAudioData(await file.arrayBuffer());
  const sr = ab.sampleRate, ch = Math.min(2, ab.numberOfChannels);
  for (const [codec, muxCodec] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]){
    const cfg = { codec, sampleRate: sr, numberOfChannels: ch, bitrate: 192000 };
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { ab, sr, ch, cfg, muxCodec }; } catch(e){}
  }
  throw new Error('这个浏览器不能编码 AAC 音频，可以取消勾选“带上音频”再导出');
}
async function encodeAudioTrack(muxer, T){
  let err = null;
  const ae = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => err = e });
  ae.configure(T.cfg);
  const n = T.ab.length, F = 4096, chans = [...Array(T.ch)].map((_, i) => T.ab.getChannelData(i));
  for (let off = 0; off < n; off += F){
    if (err) throw err;
    if (abortExport){ ae.close(); throw { stopped: true }; }
    const len = Math.min(F, n - off), data = new Float32Array(len * T.ch);
    for (let c = 0; c < T.ch; c++) data.set(chans[c].subarray(off, off + len), c * len);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: T.sr, numberOfFrames: len, numberOfChannels: T.ch, timestamp: Math.round(off / T.sr * 1e6), data });
    ae.encode(ad); ad.close();
    if (ae.encodeQueueSize > 32) await new Promise(r => setTimeout(r, 0));
  }
  await ae.flush(); ae.close();
  if (err) throw err;
}
/* a file written in pieces at given positions (the MP4 writer goes back once to fill in a size near the start) */
function chunkedFile(sink){
  const parts = [];                                   // { pos, data } in order, never overlapping
  let end = 0;
  if (sink){
    // straight into the file the user picked: every piece (and the header patch at the end) is written at its position
    let chain = Promise.resolve(), err = null, pending = 0;
    return {
      write(data, pos){
        data = new Uint8Array(data); pending += data.length; end = Math.max(end, pos + data.length);
        chain = chain.then(() => sink.write({ type: 'write', position: pos, data })).then(() => { pending -= data.length; }, e => { err = err || e; });
      },
      get pending(){ return pending; },
      async drain(){ await chain; if (err) throw err; },
      get size(){ return end; }
    };
  }
  return {
    get pending(){ return 0; },
    async drain(){},
    write(data, pos){
      data = new Uint8Array(data);                    // copy: the writer may reuse its buffer
      if (pos >= end){ parts.push({ pos, data }); end = pos + data.length; return; }
      // a patch over bytes already written
      for (const p of parts){
        const a = Math.max(pos, p.pos), b = Math.min(pos + data.length, p.pos + p.data.length);
        if (a < b) p.data.set(data.subarray(a - pos, b - pos), a - p.pos);
      }
      if (pos + data.length > end){ const k = end - pos; parts.push({ pos: end, data: data.subarray(k) }); end = pos + data.length; }
    },
    blob(type){ return new Blob(parts.map(p => p.data), { type }); }
  };
}
/* 保存位置: the browser's save dialog (any drive / folder). Not available inside an embedded frame. */
const canPickFile = () => typeof window.showSaveFilePicker === 'function' && window.self === window.top;
function exportBaseName(){ return (song.meta.ti || '歌词').replace(/[\\/:*?"<>|]+/g, ' ').trim(); }
async function pickSaveFile(fmtSel, W, H){
  const ext = fmtSel === 'mp4' ? (window.VideoEncoder && window.Mp4Muxer ? 'mp4' : 'webm') : fmtSel;
  const T = { mp4: ['MP4 视频', 'video/mp4'], webm: ['WebM 视频', 'video/webm'], mov: ['MOV 视频', 'video/quicktime'], zip: ['ZIP 压缩包', 'application/zip'] }[ext];
  const h = await window.showSaveFilePicker({
    id: 'lrc-export', startIn: 'videos', suggestedName: `${exportBaseName()} 歌词 ${W}x${H}.${ext}`,
    types: [{ description: T[0], accept: { [T[1]]: ['.' + ext] } }]
  });
  return { handle: h, ext, name: h.name };
}
async function runExport(){
  if (exporting) return;
  // the save dialog has to open right away, while the click still counts
  let disk = null;
  if (xp.disk.checked && canPickFile()){
    const [W0, H0] = PRESETS[xp.size.value];
    try { disk = await pickSaveFile(xp.fmt.value, W0, H0); }
    catch (e){
      if (e && e.name === 'AbortError'){ xp.msg.textContent = '没有选保存位置，导出没有开始。'; return; }
      disk = null;                                     // the dialog failed: export first, save afterwards
    }
  }
  if (exporting) return;
  let writable = null;
  const [W, H] = PRESETS[xp.size.value], fps = +xp.fps.value;
  // read before the controls are locked below (a disabled checkbox would otherwise read as "no audio")
  const wantAudio = xp.audio.checked && !xp.audio.disabled && !!audioFile;
  exporting = true; abortExport = false; exported = null; setExportProfText('');
  xp.go.disabled = true; xp.size.disabled = xp.fps.disabled = xp.fmt.disabled = xp.qual.disabled = xp.speed.disabled = xp.disk.disabled = xp.crop.disabled = xp.audio.disabled = true; xp.save.hidden = true;
  xp.cancel.textContent = '停止导出'; $('xHide').hidden = false;
  xp.msg.textContent = '正在准备字体…';
  try {
    const fmtSel = xp.fmt.value, transparent = fmtSel !== 'mp4';
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { alpha: transparent });
    const M = canvasMeasurer(ctx, W, H);
    let EW = W, EH = H, box = null;          // encoded size (smaller when cropping)
    if (document.fonts){
      await Promise.all([`800 ${M.fs}px Archivo`, `900 ${M.fs}px "Noto Sans SC"`, `400 ${M.sfs}px "Noto Sans SC"`]
        .map(f => document.fonts.load(f, '歌词 Lyrics').catch(() => {})));
    }
    const segs = buildTimeline(M);
    if (xp.crop.checked && !(fx.bg.mode === 'flow' && !transparent) && !useScroll() && !useWordMode() && !useCoverPanel()){
      box = cropBox(M, segs, W, H);
      EW = box.w; EH = box.h;
      cv.width = EW; cv.height = EH;                     // resizing resets the context state
      ctx.setTransform(1, 0, 0, 1, -box.x, -box.y);     // keep drawing in full-frame coordinates
    }
    const probe = { fillRect(){}, save(){}, restore(){}, translate(){}, scale(){}, drawImage(){}, set globalAlpha(v){}, set globalCompositeOperation(v){}, set fillStyle(v){}, set filter(v){} };
    const probeM = Object.assign(Object.create(M), { sprites: { draw(){}, drawLit(){} }, _probe: true });
    const staticKeyAt = t => drawFrame(probe, W, H, probeM, segs, t);
    const dur = total() + 1;
    const frames = Math.ceil(dur * fps);
    const bitrate = (EW * EH > 2e6 ? 24e6 : EW * EH > 1.5e6 ? 10e6 : 6e6) * (fx.bg.mode === 'flow' && !transparent ? (EW * EH > 2e6 ? 1.5 : 2) : 1);   // smooth gradients need more bits or they band
    // 画质 / 防色带: constant quality (when the encoder offers it) or more bits, plus stronger grain on the background
    const qual = transparent ? 'std' : xp.qual.value;
    try { localStorage.setItem('lrc-xqual', xp.qual.value); } catch(e){}
    const QP = { high: 17, max: 11 }[qual];
    const rate = Math.round(bitrate * ({ std: 1, high: 1.7, max: 2.6 }[qual] || 1));
    const pick = !transparent && window.VideoEncoder && window.Mp4Muxer ? await pickCodec(EW, EH, fps, rate, !!QP) : null;
    const flowX = fx.bg.mode === 'flow' && !transparent ? exportFlowGL() : null;
    const unit = Math.max(1, EH / 1080);
    if (flowX) flowX.dither = qual === 'max' ? { amp: 3.2, cell: Math.round(2 * unit) } : qual === 'high' ? { amp: 2, cell: Math.round(unit * 1.5) } : { amp: 1, cell: 1 };
    setExportDith(qual === 'max' ? 3 : qual === 'high' ? 2 : 1);
    const codec = pick && pick.codec;

    if (transparent){
      // draw each frame on a transparent canvas, encode it to PNG (several in flight at once), then pack
      // with a save location picked, every PNG goes straight into that file as soon as it is ready
      if (disk && disk.ext === fmtSel) writable = await disk.handle.createWritable();
      const sink = writable ? streamSink(writable) : null;
      const out = fmtSel === 'mov' ? movWriter(EW, EH, fps, sink) : zipWriter(sink);
      xp.msg.textContent = '正在准备 PNG 编码…';
      const pool = await pngPool(fmtSel === 'zip');
      const ahead = Math.max(8, pool.threads * 3);          // frames in flight at once
      const queue = [];           // { f, repeat, promise }
      let inFlight = 0;
      const drain = async () => { const q = queue.shift(); const fr = q.repeat ? null : await q.promise; if (!q.repeat) inFlight--; out.add(fr, q.repeat, q.f); };
      const t0 = performance.now();
      let lastKey = null, Pd = 0, Pe = 0, Pw = 0, Pn = 0, Pt = performance.now(), profTxt = '';
      try {
        for (let f = 0; f < frames; f++){
          if (abortExport) break;
          const q0 = performance.now();
          const repeat = lastKey != null && staticKeyAt(lt(f / fps)) === lastKey;
          if (repeat) queue.push({ f, repeat: true });
          else {
            lastKey = drawFrame(ctx, W, H, M, segs, lt(f / fps), true);
            const q1 = performance.now(); Pd += q1 - q0;
            const pr = pool.encode(cv);
            queue.push({ f, repeat: false, promise: pr }); inFlight++;
            Pe += performance.now() - q1;
          }
          const q2 = performance.now();
          while (inFlight > ahead) await drain();
          while (queue.length && queue[0].repeat) await drain();
          if (sink && sink.pending > 256 * 1048576) await sink.drain();     // the disk is slower than the PNG encoders
          Pw += performance.now() - q2; Pn++;
          if (f % 30 === 0){
            setBar(f / frames);
            const el = (performance.now() - t0) / 1000, left = el / Math.max(1, f) * (frames - f);
            if (Pn >= 30){                    // averages since the start (static stretches would distort a short window)
              const per = (performance.now() - Pt) / Pn, a = v => (v / Pn).toFixed(1);
              profTxt = `\n平均每帧 ${per.toFixed(1)} ms（约 ${Math.round(1000 / per)} 帧/秒）：画 ${a(Pd)} · 交给编码 ${a(Pe)} · 等 PNG 编码 ${a(Pw)}`;
            }
            xp.msg.textContent = `正在渲染透明帧 ${late.fmt(f / fps)} / ${late.fmt(dur)} · 预计还需 ${late.fmt(left)} · ` +
              (pool.threads ? `${pool.threads} 个线程编码 PNG` : '单线程编码 PNG') + profTxt;
            showLive(cv, box, W, H, true);
            await tick0();
          }
        }
        while (queue.length) await drain();
      } finally { pool.close(); }
      setExportProfText(profTxt);
      if (abortExport) throw { stopped: true };
      xp.msg.textContent = fmtSel === 'mov' ? '正在封装 MOV…' : '正在打包 ZIP…';
      await tick0();
      const blob = out.finish();
      if (sink){
        xp.msg.textContent = '正在写完最后的数据…';
        await sink.drain();
        xp.msg.textContent = '正在关闭文件（浏览器会把临时文件换成正式文件，可能还要扫描一下，大文件需要一会儿）…';
        await writable.close(); writable = null;
        exported = { saved: disk.name, size: sink.size, ext: fmtSel };
      } else exported = { blob, ext: fmtSel };
    } else if (codec){
      // the file is collected in pieces, not one growing buffer: long or 4K videos can pass 2 GB,
      // more than a browser allows in one piece
      if (disk && disk.ext === 'mp4') writable = await disk.handle.createWritable();
      const parts = chunkedFile(writable);
      withAudio = false;
      const track = wantAudio ? await prepareAudioTrack(audioFile) : null;
      const muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.StreamTarget({ onData: parts.write, chunked: true, chunkSize: 16 * 1024 * 1024 }),
        video: { codec: 'avc', width: EW, height: EH, frameRate: fps },
        ...(track ? { audio: { codec: track.muxCodec, numberOfChannels: track.ch, sampleRate: track.sr } } : {}),
        fastStart: false
      });
      if (track){
        xp.msg.textContent = '正在编码音频…';
        await encodeAudioTrack(muxer, track);
        withAudio = track.muxCodec;
      }
      let encErr = null;
      const enc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => encErr = e });
      // 编码速度: 'realtime' makes hardware encoders pick their fast presets (with a fixed quantizer the quality is
      // still set by QP, so it changes less than one would think)
      const fast = xp.speed.value === 'speed';
      try { localStorage.setItem('lrc-xspeed', xp.speed.value); } catch(e){}
      const lat = fast ? 'realtime' : 'quality';
      enc.configure(pick.q ? { codec, width: EW, height: EH, framerate: fps, latencyMode: lat, hardwareAcceleration: pick.hw, bitrateMode: 'quantizer' }
                           : { codec, width: EW, height: EH, bitrate: rate, framerate: fps, latencyMode: lat, hardwareAcceleration: pick.hw });
      const hwLabel = (pick.hw === 'prefer-hardware' ? '显卡编码' : '浏览器自动选择编码') + (fast ? ' · 速度优先' : '') + (pick.q ? ` · 恒定画质 QP ${QP}` : ` · ${Math.round(rate / 1e6)} Mbps`);
      const waitQueue = () => new Promise(r => {
        let done = false; const fin = () => { if (!done){ done = true; r(); } };
        enc.addEventListener ? enc.addEventListener('dequeue', fin, { once: true }) : 0;
        setTimeout(fin, 4);
      });
      const t0 = performance.now();
      let lastKey = null, lastVF = null, reused = 0;
      // timing of each stage, shown under the progress so a slow export can be traced to its cause
      const PZ = () => ({ probe: 0, bg: 0, draw: 0, bloom: 0, frame: 0, wait: 0, n: 0, reused: 0, t: performance.now() });
      setExportProf(PZ()); let profShown = '';
      const alwaysMoving = fx.bg.mode === 'flow';       // the background moves in every frame: no frame can be reused
      for (let f = 0; f < frames; f++){
        if (abortExport || encErr) break;
        const tsUs = Math.round(f * 1e6 / fps), dUs = Math.round(1e6 / fps), P = exportProf;
        // frames where nothing moves are copied from the previous frame instead of redrawn
        let q0 = performance.now();
        const key = !alwaysMoving && lastKey != null && staticKeyAt(lt(f / fps)) === lastKey ? lastKey : null;
        let q1 = performance.now(); P.probe += q1 - q0;
        let vf;
        if (key && lastVF){ vf = new VideoFrame(lastVF, { timestamp: tsUs, duration: dUs }); reused++; P.reused++; P.frame += performance.now() - q1; }
        else {
          const k = drawFrame(ctx, W, H, M, segs, lt(f / fps));
          const q2 = performance.now(); P.draw += q2 - q1;
          vf = new VideoFrame(cv, { timestamp: tsUs, duration: dUs });
          if (lastVF) lastVF.close();
          lastVF = k ? vf.clone() : null; lastKey = k;
          P.frame += performance.now() - q2;
        }
        enc.encode(vf, pick.q ? { keyFrame: f % (fps * 2) === 0, avc: { quantizer: QP } } : { keyFrame: f % (fps * 2) === 0 });
        vf.close();
        q0 = performance.now();
        while (enc.encodeQueueSize > 24) await waitQueue();
        if (parts.pending > 192 * 1048576) await parts.drain();      // the disk is slower than the encoder: wait a bit
        P.wait += performance.now() - q0; P.n++;
        if (f % 30 === 0){
          setBar(f / frames);
          const el = (performance.now() - t0) / 1000, left = el / Math.max(1, f) * (frames - f);
          if (P.n >= 30){
            const per = (performance.now() - P.t) / P.n, a = v => (v / P.n).toFixed(1);
            const textMs = Math.max(0, P.draw - P.bg - P.bloom);
            profShown = `\n每帧 ${per.toFixed(1)} ms（约 ${Math.round(1000 / per)} 帧/秒）：背景 ${a(P.bg)} · 文字 ${a(textMs)} · 辉光 ${a(P.bloom)} · 取帧 ${a(P.frame)} · 等编码器 ${a(P.wait)} · 判断静止 ${a(P.probe)}` +
              (P.reused ? ` · 复用 ${Math.round(P.reused / P.n * 100)}% 的帧` : '');
            setExportProf(PZ()); setExportProfText(profShown);
          }
          xp.msg.textContent = `正在渲染 ${late.fmt(f / fps)} / ${late.fmt(dur)} · 预计还需 ${late.fmt(left)} · ${hwLabel}` + profShown;
          showLive(cv, box, W, H, false);
          await tick0();
        }
      }
      if (lastVF) lastVF.close();
      if (encErr) throw encErr;
      if (abortExport){ enc.close(); throw { stopped: true }; }
      xp.msg.textContent = '正在封装 MP4…';
      await enc.flush(); enc.close();
      muxer.finalize();
      if (writable){
        xp.msg.textContent = '正在写入文件…';
        await parts.drain(); await writable.close(); writable = null;
        exported = { saved: disk.name, size: parts.size, ext: 'mp4' };
      } else exported = { blob: parts.blob('video/mp4'), ext: 'mp4' };
    } else {
      // fallback: real-time capture with MediaRecorder (WebM)
      if (!window.MediaRecorder || !cv.captureStream) throw new Error('这个浏览器不支持视频编码，请换用最新版 Chrome 或 Edge。');
      const stream = cv.captureStream(fps);
      const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
      const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: rate });
      const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
      const done = new Promise(r => rec.onstop = r);
      drawFrame(ctx, W, H, M, segs, lt(0));
      rec.start(1000);
      const start = performance.now();
      await new Promise(res => {
        (function loop(){
          const t = (performance.now() - start) / 1000;
          if (abortExport || t >= dur){ res(); return; }
          drawFrame(ctx, W, H, M, segs, lt(t));
          setBar(t / dur);
          xp.msg.textContent = `实时录制中 ${late.fmt(t)} / ${late.fmt(dur)}（此浏览器只能按实际时长录制，请保持页面在前台）`;
          requestAnimationFrame(loop);
        })();
      });
      rec.stop(); await done;
      if (abortExport) throw { stopped: true };
      exported = { blob: new Blob(chunks, { type: 'video/webm' }), ext: 'webm' };
    }
    if (disk && !exported.saved){
      // MOV / ZIP / WebM are finished in memory: write them to the chosen file now
      xp.msg.textContent = '正在写入文件…';
      writable = await disk.handle.createWritable();
      await writable.write(exported.blob); await writable.close(); writable = null;
      exported = { saved: disk.name, size: exported.blob.size, ext: exported.ext, wrongExt: exported.ext !== disk.ext };
    }
    setBar(1);
    const mb = ((exported.blob ? exported.blob.size : exported.size) / 1048576).toFixed(1);
    exported.w = EW; exported.h = EH; exported.full = [W, H];
    xp.msg.textContent = `完成：${EW}×${EH}${box ? `（${W}×${H} 正中间的歌词区域）` : ''} · ${fps} 帧 · ${exported.ext.toUpperCase()}${exported.ext === 'mp4' && withAudio ? (withAudio === 'aac' ? ' · 含音频（AAC）' : ' · 含音频（Opus：这个浏览器不能编 AAC，Premiere 等软件可能读不出声音）') : ''} · ${mb} MB`;
    if (exported.saved){
      xp.msg.textContent += ` · 已保存为「${exported.saved}」（你选的文件夹）` + (exported.wrongExt ? '。注意：这个浏览器只能导出 WebM，文件扩展名请改成 .webm' : '');
      xp.save.hidden = true;
    } else { xp.save.hidden = false; xp.save.focus(); }
    if (exportProfText) xp.msg.textContent += exportProfText;
  } catch (e){
    if (writable) try { await writable.abort(); } catch(_){}      // no half-written file left behind
    setBar(0);
    xp.msg.textContent = e && e.stopped ? '已停止导出。' : '导出失败：' + (e && e.message || e) + '。可以换一个尺寸或帧率再试。';
  } finally {
    setExportProf(null);
    setExportDith(1);
    if (flowGLx) flowGLx.dither = { amp: 1, cell: 1 };
    exporting = false; $('xHide').hidden = true;
    if (!$('xPill').hidden) updatePill();
    xp.go.disabled = false; xp.size.disabled = xp.fps.disabled = xp.fmt.disabled = xp.qual.disabled = xp.speed.disabled = xp.crop.disabled = false;
    xp.disk.disabled = !canPickFile();
    audioOpt();
    xp.cancel.textContent = '关闭';
  }
}

async function saveExport(){
  if (!exported) return;
  if (!exported.blob) return;
  const base = exportBaseName();
  const [W, H] = PRESETS[xp.size.value];
  const filename = exported.w !== W || exported.h !== H
    ? `${base} 歌词 ${exported.w}x${exported.h} 居中于${W}x${H}.${exported.ext}`
    : `${base} 歌词 ${W}x${H}.${exported.ext}`;
  let dl = null;
  try { dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null; } catch(e){}
  if (dl){
    let data = exported.blob, name = filename;
    if (exported.ext === 'mov'){
      // this viewer only saves common file types, so the .mov goes out inside a .zip
      xp.msg.textContent = '正在把 MOV 打包成 ZIP…';
      const u8 = new Uint8Array(await exported.blob.arrayBuffer());
      const z = zipWriter(); z.addFile(filename, u8, crc32(u8));
      data = z.finish(); name = filename.replace(/\.mov$/, '.zip');
    }
    try { await dl.save({ filename: name, data }); xp.msg.textContent = '已保存：' + name + (name !== filename ? '（解压后得到 MOV）' : ''); }
    catch (e){
      xp.msg.textContent = e.code === 'declined' ? '已取消保存，可以再点一次“保存视频”。'
        : e.code === 'rate_limited' ? '已有一个保存窗口打开，请先处理它。'
        : '无法在这里保存文件（' + (e.code || 'error') + '）。';
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(exported.blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  xp.msg.textContent = '已开始下载：' + filename;
}

$('exportBtn').onclick = openExport;
xp.go.onclick = runExport;
xp.save.onclick = saveExport;
xp.cancel.onclick = () => { if (exporting) abortExport = true; else closeExport(); };
xp.size.onchange = previewFrame;
xp.fps.onchange = estimateSize;
xp.fmt.onchange = previewFrame;
try { const v = localStorage.getItem('lrc-xspeed'); if (v === 'speed' || v === 'quality') xp.speed.value = v; } catch(e){}
try { if (localStorage.getItem('lrc-xdisk') === '0') xp.disk.checked = false; } catch(e){}
xp.disk.onchange = () => { try { localStorage.setItem('lrc-xdisk', xp.disk.checked ? '1' : '0'); } catch(e){} };
try { const q = localStorage.getItem('lrc-xqual'); if (q && xp.qual.querySelector(`option[value="${q}"]`)) xp.qual.value = q; else xp.qual.value = 'high'; } catch(e){ xp.qual.value = 'high'; }
xp.audio.onchange = audioOpt;
xp.crop.onchange = previewFrame;
xp.modal.addEventListener('click', e => { if (e.target === xp.modal) closeExport(); });

const fmtDelay = d => (d > 0 ? '+' : d < 0 ? '-' : '') + Math.abs(d).toFixed(2);
function setDelay(v){
  if (!isFinite(v)) v = 0;
  setLyricDelay(Math.round(Math.max(-3600, Math.min(3600, v)) * 100) / 100);     // no practical limit (±1 hour)
  if (Object.is(lyricDelay, -0)) setLyricDelay(0);
  try { localStorage.setItem('lrc-delay', String(lyricDelay)); } catch(e){}
  const el = $('nudgeVal');
  if (document.activeElement !== el) el.value = fmtDelay(lyricDelay);
  el.classList.toggle('on', lyricDelay !== 0);
  $('nudgeZero').hidden = lyricDelay === 0;
  el.title = (lyricDelay === 0 ? '歌词与音频对齐，未偏移。' : (lyricDelay > 0 ? '歌词推迟 ' : '歌词提前 ') + Math.abs(lyricDelay).toFixed(2) + ' 秒。')
    + '直接输入秒数后回车：正数 = 推迟，负数 = 提前；也可以写成 分:秒，比如 -1:05.5';
  setCur(null); render(true);
}

/* names that modules loaded before this one call or read (core/late.js) */
Object.defineProperties(late, {
  exporting: { get: () => exporting, enumerable: true },
});
