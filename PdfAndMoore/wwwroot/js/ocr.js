// OCR: read text from scans and photos, including sideways, upside-down and crooked ones.
// Pipeline: detect orientation (0/90/180/270) -> measure skew -> straighten -> Tesseract.
import { state, emit, checkpoint, changed } from './state.js';
import { renderPageToCanvas, loadSource, totalRotation } from './doc.js';
import { el, icon, toast, busy, busyProgress, dialog, uid, canvasToBytes } from './util.js';
import { enhanceForOcr, binarizeForOcr } from './imagefix.js';

const Tesseract = window.Tesseract;
const base = new URL('../lib/tesseract/', import.meta.url).href;
const workerOpts = {
  workerPath: base + 'worker.min.js',
  corePath: base + 'core/',
  langPath: base + 'lang/',
  gzip: true,
  workerBlobURL: false,
};

let textWorker = null;
let osdWorker = null;
let progressCb = null;

async function getTextWorker() {
  if (!textWorker) {
    textWorker = await Tesseract.createWorker('eng', 1, {
      ...workerOpts,
      logger: (m) => progressCb && m.status === 'recognizing text' && progressCb(m.progress),
    });
    await textWorker.setParameters({ preserve_interword_spaces: '1' });
  }
  return textWorker;
}

async function getOsdWorker() {
  if (!osdWorker) {
    osdWorker = await Tesseract.createWorker('osd', 0, { ...workerOpts, legacyCore: true, legacyLang: true });
  }
  return osdWorker;
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------
function scaledCopy(src, maxSide) {
  const s = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(src.width * s));
  c.height = Math.max(1, Math.round(src.height * s));
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, 0, 0, c.width, c.height);
  return { canvas: c, scale: s };
}

/** Rotate a canvas clockwise by `deg` around its centre, growing it so nothing is cut off. */
export function rotateCanvas(src, deg) {
  const t = (deg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(t));
  const sin = Math.abs(Math.sin(t));
  const w = src.width;
  const h = src.height;
  const nw = Math.round(w * cos + h * sin);
  const nh = Math.round(w * sin + h * cos);
  const c = document.createElement('canvas');
  c.width = nw;
  c.height = nh;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, nw, nh);
  g.translate(nw / 2, nh / 2);
  g.rotate(t);
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, -w / 2, -h / 2);
  return { canvas: c, map: { t, cx0: w / 2, cy0: h / 2, cx1: nw / 2, cy1: nh / 2 } };
}

/** Map a point in the straightened image back to the original image. */
function unmap(map, x, y) {
  const dx = x - map.cx1;
  const dy = y - map.cy1;
  const c = Math.cos(-map.t);
  const s = Math.sin(-map.t);
  return [dx * c - dy * s + map.cx0, dx * s + dy * c + map.cy0];
}

function grayscale(canvas) {
  const g = canvas.getContext('2d');
  const { data } = g.getImageData(0, 0, canvas.width, canvas.height);
  const out = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (data[j] * 77 + data[j + 1] * 151 + data[j + 2] * 28) >> 8;
  return out;
}

function otsu(gray) {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = i;
    }
  }
  return thr;
}

/**
 * Estimate how crooked the text is, in degrees (positive = needs clockwise rotation).
 * Uses projection profiles: text lines give the sharpest row histogram when level.
 */
export function estimateSkew(canvas, range = 20) {
  // Even out the paper first so stains and shadows don't look like text lines.
  const small = enhanceForOcr(scaledCopy(canvas, 900).canvas);
  const gray = grayscale(small);
  const thr = Math.min(otsu(gray), 200);
  const W = small.width;
  const H = small.height;
  // Sample dark pixels away from the border.
  let pts = [];
  const m = 4;
  for (let y = m; y < H - m; y++) for (let x = m; x < W - m; x++) if (gray[y * W + x] < thr) pts.push(x, y);
  if (pts.length < 200) return 0;
  const maxPts = 120000;
  if (pts.length > maxPts) {
    const step = Math.ceil(pts.length / 2 / (maxPts / 2));
    const s = [];
    for (let i = 0; i < pts.length; i += 2 * step) s.push(pts[i], pts[i + 1]);
    pts = s;
  }
  const diag = Math.ceil(Math.hypot(W, H));
  const score = (deg) => {
    const t = (deg * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const bins = new Float64Array(diag * 2 + 2);
    for (let i = 0; i < pts.length; i += 2) {
      const r = Math.round(pts[i + 1] * c - pts[i] * s) + diag;
      bins[r]++;
    }
    let v = 0;
    for (let i = 0; i < bins.length; i++) v += bins[i] * bins[i];
    return v;
  };
  let best = 0;
  let bestScore = -1;
  for (let a = -range; a <= range; a += 1) {
    const sc = score(a);
    if (sc > bestScore) {
      bestScore = sc;
      best = a;
    }
  }
  const coarse = best;
  for (let a = coarse - 1; a <= coarse + 1; a += 0.1) {
    const sc = score(a);
    if (sc > bestScore) {
      bestScore = sc;
      best = a;
    }
  }
  // Rotating the image by -best levels the text.
  return Math.abs(best) < 0.15 ? 0 : -best;
}

/** Score how readable an image is in a given orientation (sum of confident real words). */
async function readability(worker, canvas) {
  const { data } = await worker.recognize(canvas);
  let score = 0;
  for (const w of data.words || []) {
    const t = w.text.replace(/[^A-Za-z0-9]/g, '');
    if (t.length >= 2 && w.confidence > 55) score += w.confidence * Math.min(t.length, 8);
  }
  return score;
}

/** Work out which way is up: 0, 90, 180 or 270 degrees of clockwise rotation needed. */
export async function detectOrientation(canvas) {
  // First try Tesseract's orientation detector (fast).
  try {
    const osd = await getOsdWorker();
    const { canvas: small } = scaledCopy(canvas, 1600);
    const { data } = await osd.detect(small);
    if (data && data.orientation_confidence > 3 && data.orientation_degrees != null) {
      return (360 - data.orientation_degrees) % 360 === 0 ? 0 : data.orientation_degrees;
    }
  } catch (e) {
    console.warn('orientation detector unavailable, comparing orientations instead', e);
  }
  // Fallback: read a small copy in all four orientations and keep the best one.
  const worker = await getTextWorker();
  const { canvas: small } = scaledCopy(canvas, 1100);
  let best = 0;
  let bestScore = -1;
  const saved = progressCb;
  progressCb = null;
  try {
    for (const deg of [0, 180, 90, 270]) {
      const sc = await readability(worker, deg ? rotateCanvas(small, deg).canvas : small);
      if (sc > bestScore * 1.15) {
        bestScore = sc;
        best = deg;
      }
      if (deg === 0 && sc > 25000) break; // clearly upright already
    }
  } finally {
    progressCb = saved;
  }
  return best;
}

/**
 * Read the text in an image (canvas). Returns
 * { text, words:[{text, confidence, quad:[[x,y] x4 in ORIGINAL image px: tl,tr,br,bl]}], angle, straightened }
 */
function passScore(data) {
  let s = 0;
  for (const w of data.words || []) {
    const t = (w.text || '').replace(/[^A-Za-z0-9]/g, '');
    if (t.length && w.confidence > 45) s += w.confidence * Math.min(t.length, 10);
  }
  return s;
}

export async function recognizeCanvas(canvas, { onProgress, autoRotate = true, deep = false } = {}) {
  let orient = 0;
  let skew = 0;
  if (autoRotate) {
    orient = await detectOrientation(canvas);
    const oriented = orient ? rotateCanvas(canvas, orient).canvas : canvas;
    skew = estimateSkew(oriented);
  }
  const angle = orient + skew;
  const { canvas: fixed, map } = angle ? rotateCanvas(canvas, angle) : { canvas, map: { t: 0, cx0: 0, cy0: 0, cx1: 0, cy1: 0 } };
  const worker = await getTextWorker();
  // Old, faded or worn pages: also read a cleaned-up copy and a sharp black-and-white copy,
  // and keep whichever reading is most confident.
  const passes = deep ? 3 : 1;
  progressCb = (p) => onProgress && onProgress(p / passes);
  let data;
  let used = 'original';
  try {
    ({ data } = await worker.recognize(fixed));
    let best = passScore(data);
    const weak = () => (data.confidence || 0) < 80 || (data.words || []).length < 8;
    if (deep || weak()) {
      progressCb = (p) => onProgress && onProgress((1 + p) / (deep ? 3 : 2));
      const r2 = (await worker.recognize(enhanceForOcr(fixed))).data;
      const s2 = passScore(r2);
      if (s2 > best * 1.03) {
        data = r2;
        best = s2;
        used = 'enhanced';
      }
      if (deep || weak()) {
        progressCb = (p) => onProgress && onProgress((2 + p) / 3);
        const r3 = (await worker.recognize(binarizeForOcr(fixed))).data;
        const s3 = passScore(r3);
        if (s3 > best * 1.03) {
          data = r3;
          best = s3;
          used = 'black-and-white';
        }
      }
    }
  } finally {
    progressCb = null;
  }
  const words = (data.words || [])
    .filter((w) => w.text && w.text.trim() && w.confidence > 20)
    .map((w) => {
      const { x0, y0, x1, y1 } = w.bbox;
      const quad = [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ].map(([x, y]) => (angle ? unmap(map, x, y) : [x, y]));
      return { text: w.text, confidence: w.confidence, quad, height: y1 - y0 };
    });
  const unsure = words.filter((w) => w.confidence < 65).map((w) => w.text);
  return { text: (data.text || '').trim(), words, angle, orient, skew, straightened: fixed, confidence: data.confidence, unsure, used };
}

// ---------------------------------------------------------------------------
// OCR whole pages -> searchable PDF
// ---------------------------------------------------------------------------
const OCR_SCALE = 300 / 72;

/** Is this page mostly a picture (scan / photo) with little real text? */
export async function pageNeedsOcr(page) {
  const src = state.doc.sources.find((s) => s.id === page.src);
  const p = await src.pdf.getPage(page.index + 1);
  const tc = await p.getTextContent();
  const chars = tc.items.reduce((n, it) => n + (it.str || '').trim().length, 0);
  return chars < 20;
}

/**
 * Recognize text on pages and add an invisible text layer so the PDF becomes searchable/selectable.
 * straighten: replace crooked/rotated scans with a straightened image.
 */
export async function ocrPages(pages, { straighten = true, skipTextPages = true, deep = false } = {}) {
  let done = 0;
  let straightenedCount = 0;
  let textFound = 0;
  busy('Reading text…');
  try {
    checkpoint();
    for (const page of pages) {
      busyProgress(done / pages.length, `Reading text on page ${state.doc.pages.indexOf(page) + 1} of ${state.doc.pages.length}…`);
      if (skipTextPages && !(await pageNeedsOcr(page))) {
        done++;
        continue;
      }
      const { canvas, viewport } = await renderPageToCanvas(state.doc, page, OCR_SCALE);
      const res = await recognizeCanvas(canvas, {
        onProgress: (p) => busyProgress((done + p) / pages.length),
        deep,
      });
      page.annots = page.annots.filter((a) => a.type !== 'ocrtext');
      let vp = viewport;
      let words = res.words;
      if (straighten && Math.abs(res.angle % 360) > 0.3 && !page.annots.length) {
        // Replace the page with the straightened image so it reads naturally.
        const newPage = await replaceWithImage(page, res.straightened);
        if (newPage) {
          straightenedCount++;
          const again = await recognizeCanvas(res.straightened, { autoRotate: false, deep });
          words = again.words;
          const src = state.doc.sources.find((s) => s.id === page.src);
          vp = (await src.pdf.getPage(page.index + 1)).getViewport({ scale: OCR_SCALE, rotation: 0 });
        }
      }
      const ocrWords = words.map((w) => {
        // Baseline from bottom-left to bottom-right of the word, in PDF user space.
        const bl = vp.convertToPdfPoint(...w.quad[3]);
        const br = vp.convertToPdfPoint(...w.quad[2]);
        const tl = vp.convertToPdfPoint(...w.quad[0]);
        const width = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
        const height = Math.hypot(tl[0] - bl[0], tl[1] - bl[1]);
        const angle = (Math.atan2(br[1] - bl[1], br[0] - bl[0]) * 180) / Math.PI;
        return { text: w.text, x: bl[0], y: bl[1] + height * 0.2, width, height, angle };
      });
      if (ocrWords.length) {
        page.annots.push({ id: uid(), type: 'ocrtext', words: ocrWords });
        textFound++;
      }
      page.ocrText = res.text;
      done++;
    }
    changed({ structure: straightenedCount > 0 });
    return { pages: done, straightened: straightenedCount, textFound };
  } finally {
    busy(false);
  }
}

async function replaceWithImage(page, canvas) {
  const { PDFDocument } = window.PDFLib;
  const jpg = await canvasToBytes(canvas, 'image/jpeg', 0.88);
  const pdf = await PDFDocument.create();
  const img = await pdf.embedJpg(jpg);
  const w = canvas.width / OCR_SCALE;
  const h = canvas.height / OCR_SCALE;
  const p = pdf.addPage([w, h]);
  p.drawImage(img, { x: 0, y: 0, width: w, height: h });
  const bytes = await pdf.save();
  const source = await loadSource(bytes, 'straightened page');
  state.doc.sources.push(source);
  page.src = source.id;
  page.index = 0;
  page.baseRotate = 0;
  page.rotate = 0;
  page.w = w;
  page.h = h;
  return page;
}

// ---------------------------------------------------------------------------
// Grab text from a selected area
// ---------------------------------------------------------------------------
export async function grabRegion({ page, rect }) {
  busy('Reading the selected area…');
  try {
    const { canvas, viewport } = await renderPageToCanvas(state.doc, page, OCR_SCALE);
    const a = viewport.convertToViewportPoint(rect.x1, rect.y1);
    const b = viewport.convertToViewportPoint(rect.x2, rect.y2);
    const x = Math.max(0, Math.min(a[0], b[0]));
    const y = Math.max(0, Math.min(a[1], b[1]));
    const w = Math.min(canvas.width - x, Math.abs(a[0] - b[0]));
    const h = Math.min(canvas.height - y, Math.abs(a[1] - b[1]));
    const crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.round(w));
    crop.height = Math.max(1, Math.round(h));
    crop.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, crop.width, crop.height);
    // Prefer real text if the area has it.
    const src = state.doc.sources.find((s) => s.id === page.src);
    const pg = await src.pdf.getPage(page.index + 1);
    const tc = await pg.getTextContent();
    const inside = tc.items.filter((it) => {
      const [tx, ty] = [it.transform[4], it.transform[5]];
      return tx >= rect.x1 - 2 && tx <= rect.x2 && ty >= rect.y1 - 2 && ty <= rect.y2;
    });
    let text = inside.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('').trim();
    if (text.length < 3) {
      const res = await recognizeCanvas(crop, { onProgress: (p) => busyProgress(p), deep: true });
      text = res.text;
      busy(false);
      return showTextResult(text, crop.toDataURL('image/png'), res.unsure);
    }
    busy(false);
    return showTextResult(text, crop.toDataURL('image/png'));
  } finally {
    busy(false);
  }
}

/** Show recognized text with Copy / Ask Claude / Read with Claude buttons. */
export async function showTextResult(text, imageDataUrl, unsure = []) {
  const ta = el('textarea', { class: 'field ocr-text', rows: 12 });
  ta.value = text || '';
  const fixBtn = el(
    'button',
    {
      class: 'btn btn-tonal',
      onclick: async () => {
        fixBtn.disabled = true;
        fixBtn.textContent = 'Working…';
        try {
          const fixed = await repairText(ta.value, unsure);
          if (fixed) ta.value = fixed;
        } catch (e) {
          toast('Could not fix the text: ' + e.message, { error: true });
        } finally {
          fixBtn.disabled = false;
          fixBtn.textContent = 'Fill in damaged words (AI)';
        }
      },
    },
    'Fill in damaged words (AI)'
  );
  const body = el(
    'div',
    { class: 'ocr-result' },
    imageDataUrl ? el('img', { class: 'ocr-thumb', src: imageDataUrl }) : null,
    el('label', { class: 'field-label' }, text ? 'Text found (you can edit it):' : 'No text was found. Try "Read with Claude" for handwriting or very blurry images.', ta),
    text ? el('div', { class: 'ocr-tools' }, fixBtn, el('span', { class: 'muted small' }, unsure.length ? `${unsure.length} word${unsure.length === 1 ? ' was' : 's were'} hard to read. The AI can fill in worn or missing letters; its guesses are shown in [brackets].` : 'The AI can fix misread or missing letters; guesses are shown in [brackets].')) : null
  );
  const r = await dialog({
    title: 'Text from image',
    body,
    width: '640px',
    buttons: [
      imageDataUrl ? { label: 'Read with Claude', value: 'claude' } : null,
      { label: 'Ask Claude about it', value: 'ask' },
      { label: 'Copy text', value: 'copy', primary: true },
    ].filter(Boolean),
  });
  if (r === 'copy') {
    await navigator.clipboard.writeText(ta.value).catch(() => {});
    toast('Text copied.');
  } else if (r === 'ask') {
    emit('claude:ask', { prompt: 'Here is some text I pulled from a document:\n\n"""\n' + ta.value + '\n"""\n\n', focus: true });
  } else if (r === 'claude') {
    emit('claude:transcribe', { imageDataUrl });
  }
  return ta.value;
}

/**
 * Old, worn or faded text: ask the AI to fill in damaged or missing letters and words,
 * marking anything it had to guess in [brackets].
 */
export async function repairText(text, unsure = []) {
  const { askOnce } = await import('./claude.js');
  const prompt =
    'This text was read by OCR from an old, faded or damaged document. Fix OCR mistakes and fill in letters or words that are worn away or missing, using the context. ' +
    'Keep the original wording, spelling style, line breaks and layout. Put anything you had to guess in [square brackets]. Do not add commentary — reply with only the corrected text.' +
    (unsure.length ? `\n\nWords the OCR was unsure about: ${unsure.slice(0, 200).join(', ')}` : '') +
    `\n\n<text>\n${text}\n</text>`;
  const out = await askOnce(prompt);
  return out ? out.replace(/^<text>\s*|\s*<\/text>$/g, '').trim() : null;
}

/** OCR an image file the user picked or dropped (without turning it into a document). */
export async function grabTextFromImageBytes(bytes, name) {
  if (/\.(tiff?|heic|heif)$/i.test(name)) {
    // Convert scanner/iPhone formats first, then read the first page.
    const { fileToPdf } = await import('./convert.js');
    busy(`Opening ${name}…`);
    try {
      const pdfBytes = await fileToPdf({ name, bytes });
      const src = await loadSource(pdfBytes, name);
      const p = await src.pdf.getPage(1);
      const vp = p.getViewport({ scale: 300 / 72 });
      const c = document.createElement('canvas');
      c.width = vp.width;
      c.height = vp.height;
      await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      bytes = await canvasToBytes(c, 'image/png');
    } finally {
      busy(false);
    }
  }
  const url = URL.createObjectURL(new Blob([bytes]));
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('That image could not be read.'));
    img.src = url;
  });
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(img, 0, 0);
  URL.revokeObjectURL(url);
  busy(`Reading text in ${name}…`);
  let res;
  try {
    res = await recognizeCanvas(c, { onProgress: (p) => busyProgress(p), deep: true });
  } finally {
    busy(false);
  }
  const { canvas: thumb } = scaledCopy(res.straightened, 1200);
  if (res.angle) toast(`Straightened the image by ${Math.round(res.angle * 10) / 10}°.`);
  return showTextResult(res.text, thumb.toDataURL('image/jpeg', 0.85), res.unsure);
}

export { icon, totalRotation };
