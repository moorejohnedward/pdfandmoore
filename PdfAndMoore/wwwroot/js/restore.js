// Restore old documents: turn upright, straighten, crop photos to the paper, remove yellowing,
// stains and shadows, darken faded text — or retype the whole page as a clean new document.
import { state, checkpoint, changed } from './state.js';
import { renderPageToCanvas, loadSource } from './doc.js';
import { detectOrientation, estimateSkew, rotateCanvas, recognizeCanvas } from './ocr.js';
import { restoreImage, cropToPaper, ruledLines, copyCanvas } from './imagefix.js';
import { el, toast, busy, busyProgress, dialog, uid, canvasToBytes } from './util.js';
import { clearTextCache } from './commands.js';

const SCALE = 250 / 72; // 250 dpi working size

const MODES = [
  { id: 'clean', title: 'Clean', text: 'Keeps the original look. White paper, darker text, no stains.' },
  { id: 'crisp', title: 'Like new (black & white)', text: 'Sharp black text on bright white, like a fresh print.' },
  { id: 'color', title: 'Keep colors', text: 'Removes yellowing and stains but keeps colored ink, stamps and photos.' },
  { id: 'retype', title: 'Retype as new', text: 'Reads every word and rebuilds the page in clean type with its lines. Words it wasn’t sure of are highlighted.' },
];

const FONTS = { times: 'TimesRoman', courier: 'Courier', arial: 'Helvetica' };

/** Turn upright, straighten and (optionally) crop. Returns the fixed canvas and what was done. */
async function straighten(canvas, { upright = true, crop = true } = {}) {
  let c = canvas;
  const done = [];
  if (crop) {
    const cropped = cropToPaper(c);
    if (cropped !== c) {
      c = cropped;
      done.push('cropped');
    }
  }
  if (upright) {
    const orient = await detectOrientation(c);
    if (orient) {
      c = rotateCanvas(c, orient).canvas;
      done.push(orient === 180 ? 'turned upright' : 'turned');
    }
    const skew = estimateSkew(c);
    if (Math.abs(skew) > 0.2) {
      c = rotateCanvas(c, skew).canvas;
      done.push('straightened');
    }
  }
  return { canvas: c, done };
}

function fitLetter(w, h) {
  const box = w > h ? [792, 612] : [612, 792];
  const s = Math.min(box[0] / w, box[1] / h);
  return [w * s, h * s];
}

/** Build a clean typed page from OCR words and ruled lines. */
async function retypePage(pdf, canvas, words, lines, pageW, pageH, fontKey) {
  const { StandardFonts, rgb } = window.PDFLib;
  const font = await pdf.embedFont(StandardFonts[FONTS[fontKey] || 'TimesRoman']);
  const page = pdf.addPage([pageW, pageH]);
  const sx = pageW / canvas.width;
  const sy = pageH / canvas.height;
  for (const l of lines) {
    page.drawLine({ start: { x: l.x1 * sx, y: pageH - l.y1 * sy }, end: { x: l.x2 * sx, y: pageH - l.y2 * sy }, thickness: Math.max(0.5, Math.min(3, l.w * sx)), color: rgb(0.1, 0.1, 0.1) });
  }
  // Group words into lines so each line gets one even text size.
  const ws = words
    .map((w) => {
      const xs = w.quad.map((q) => q[0]);
      const ys = w.quad.map((q) => q[1]);
      return { ...w, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    })
    .sort((a, b) => a.y1 - b.y1 || a.x0 - b.x0);
  const rows = [];
  for (const w of ws) {
    const row = rows.find((r) => Math.abs(r.base - w.y1) < (w.y1 - w.y0) * 0.45);
    if (row) row.words.push(w);
    else rows.push({ base: w.y1, words: [w] });
  }
  const unsure = [];
  // Body text should come out one even size: rows close to the typical size get exactly that size.
  for (const r of rows) {
    const hs = r.words.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
    r.lineH = hs[Math.floor(hs.length * 0.75)] * sy;
  }
  const sorted = rows.map((r) => r.lineH).sort((a, b) => a - b);
  const typical = sorted[Math.floor(sorted.length / 2)] || 10;
  for (const r of rows) {
    const lineH = r.lineH > typical * 0.7 && r.lineH < typical * 1.3 ? typical : r.lineH;
    const size = Math.max(5, Math.min(40, lineH * 1.12));
    const base = r.words.map((w) => w.y1).sort((a, b) => a - b)[Math.floor(r.words.length / 2)];
    for (const w of r.words) {
      const text = w.text.replace(/[^\x20-\x7E -ÿ]/g, '');
      if (!text.trim()) continue;
      const boxW = (w.x1 - w.x0) * sx;
      let s = size;
      const tw = font.widthOfTextAtSize(text, s);
      if (tw > boxW * 1.12) s = Math.max(4, (s * boxW * 1.12) / tw);
      // Most words have no descenders, so the row's middle bottom edge is the baseline.
      const y = pageH - base * sy + 0.5;
      page.drawText(text, { x: w.x0 * sx, y, size: s, font, color: rgb(0.05, 0.05, 0.08) });
      if (w.confidence < 60) unsure.push({ x1: w.x0 * sx - 1, x2: w.x1 * sx + 1, y1: pageH - w.y1 * sy - 1, y2: pageH - w.y0 * sy + 1, text });
    }
  }
  return { page, unsure };
}

/** Restore pages. opts: {mode, upright, crop, searchable, font, markUnsure} */
export async function restorePages(pages, opts) {
  const { PDFDocument } = window.PDFLib;
  const out = await PDFDocument.create();
  const results = [];
  checkpoint();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const label = `page ${state.doc.pages.indexOf(page) + 1}`;
    const step = (p, t) => busyProgress((i + p) / pages.length, `${t} (${label})…`);
    step(0, 'Looking at the page');
    const { canvas } = await renderPageToCanvas(state.doc, page, SCALE);
    step(0.15, 'Straightening');
    const fixed = await straighten(canvas, opts);
    let pageW;
    let pageH;
    if (fixed.done.includes('cropped')) [pageW, pageH] = fitLetter(fixed.canvas.width, fixed.canvas.height);
    else [pageW, pageH] = [fixed.canvas.width / SCALE, fixed.canvas.height / SCALE];
    const res = { page, done: fixed.done, unsure: [] };
    if (opts.mode === 'retype') {
      step(0.3, 'Cleaning');
      const clean = restoreImage(fixed.canvas, 'clean');
      step(0.4, 'Reading every word');
      const ocr = await recognizeCanvas(clean, { autoRotate: false, deep: true, onProgress: (p) => step(0.4 + p * 0.45, 'Reading every word') });
      step(0.88, 'Retyping');
      const lines = ruledLines(clean);
      const { unsure } = await retypePage(out, clean, ocr.words, lines, pageW, pageH, opts.font);
      res.unsure = unsure;
      res.words = ocr.words.length;
      res.ocr = null; // real text
    } else {
      step(0.35, 'Restoring');
      const img = restoreImage(fixed.canvas, opts.mode);
      const bytes = opts.mode === 'crisp' ? await canvasToBytes(img, 'image/png') : await canvasToBytes(img, 'image/jpeg', 0.9);
      const emb = opts.mode === 'crisp' ? await out.embedPng(bytes) : await out.embedJpg(bytes);
      out.addPage([pageW, pageH]).drawImage(emb, { x: 0, y: 0, width: pageW, height: pageH });
      if (opts.searchable) {
        step(0.5, 'Reading the text');
        const ocr = await recognizeCanvas(img, { autoRotate: false, deep: true, onProgress: (p) => step(0.5 + p * 0.45, 'Reading the text') });
        const sx = pageW / img.width;
        const sy = pageH / img.height;
        res.ocr = ocr.words.map((w) => {
          const [bl, br, tl] = [w.quad[3], w.quad[2], w.quad[0]];
          const width = Math.hypot(br[0] - bl[0], br[1] - bl[1]) * sx;
          const height = Math.hypot(tl[0] - bl[0], tl[1] - bl[1]) * sy;
          return { text: w.text, x: bl[0] * sx, y: pageH - bl[1] * sy + height * 0.2, width, height, angle: 0 };
        });
        res.unsure = ocr.words.filter((w) => w.confidence < 60).length;
      }
    }
    results.push(res);
  }
  const source = await loadSource(await out.save(), 'restored pages');
  state.doc.sources.push(source);
  results.forEach((r, i) => {
    const p = r.page;
    const pdfPage = out.getPages()[i];
    const { width, height } = pdfPage.getSize();
    p.src = source.id;
    p.index = i;
    p.baseRotate = 0;
    p.rotate = 0;
    p.w = width;
    p.h = height;
    p.annots = [];
    if (r.ocr && r.ocr.length) p.annots.push({ id: uid(), type: 'ocrtext', words: r.ocr });
    if (opts.markUnsure && Array.isArray(r.unsure)) for (const u of r.unsure) p.annots.push({ id: uid(), type: 'highlight', rects: [[u.x1, u.y1, u.x2, u.y2]], rot: 0, color: '#ffd54f', text: u.text });
  });
  clearTextCache();
  changed({ structure: true });
  return results;
}

/** The Restore dialog with a before/after preview of the current page. */
export async function restoreDialog() {
  if (!state.doc) return;
  let mode = 'clean';
  const opt = { upright: true, crop: true, searchable: true, markUnsure: true, font: 'times', all: state.doc.pages.length > 1 };
  const before = el('img', { alt: '' });
  const after = el('img', { alt: '' });
  const note = el('div', { class: 'muted small' }, 'Making the preview…');
  const preview = async () => {
    note.textContent = 'Making the preview…';
    try {
      const page = state.doc.pages[state.currentPage];
      const { canvas } = await renderPageToCanvas(state.doc, page, 2.2);
      before.src = canvas.toDataURL('image/jpeg', 0.8);
      const fixed = await straighten(canvas, opt);
      const shown = restoreImage(fixed.canvas, mode === 'retype' ? 'clean' : mode);
      after.src = shown.toDataURL('image/jpeg', 0.85);
      note.textContent = (fixed.done.length ? 'Will be ' + fixed.done.join(', ') + '. ' : '') + (mode === 'retype' ? 'Retyping happens when you click Restore (the preview shows the cleaned page it reads from).' : '');
    } catch (e) {
      note.textContent = 'Preview not available: ' + e.message;
    }
  };
  const modeEls = MODES.map((m) => {
    const r = el('input', { type: 'radio', name: 'rmode', value: m.id, checked: m.id === mode });
    const box = el('label', { class: 'restore-mode' + (m.id === mode ? ' on' : '') }, r, el('div', {}, el('b', {}, m.title), m.text));
    r.addEventListener('change', () => {
      mode = m.id;
      modeEls.forEach((x) => x.classList.toggle('on', x.querySelector('input').checked));
      fontRow.style.display = mode === 'retype' ? '' : 'none';
      preview();
    });
    return box;
  });
  const check = (key, label, refresh = false) => {
    const cb = el('input', { type: 'checkbox', checked: opt[key] });
    cb.addEventListener('change', () => {
      opt[key] = cb.checked;
      if (refresh) preview();
    });
    return el('label', { class: 'check-row' }, cb, label);
  };
  const fontSel = el('select', { class: 'field' }, el('option', { value: 'times' }, 'Classic (Times)'), el('option', { value: 'courier' }, 'Typewriter (Courier)'), el('option', { value: 'arial' }, 'Modern (Arial)'));
  fontSel.addEventListener('change', () => (opt.font = fontSel.value));
  const fontRow = el('label', { class: 'field-label', style: { display: 'none' } }, 'Typeface for the retyped page', fontSel);
  const body = el(
    'div',
    {},
    el('div', { class: 'restore-grid' }, el('figure', {}, before, el('figcaption', {}, 'Now')), el('figure', {}, after, el('figcaption', {}, 'Restored'))),
    note,
    el('div', { class: 'restore-modes' }, modeEls),
    fontRow,
    el(
      'div',
      { class: 'check-list' },
      check('upright', 'Turn upright and straighten crooked pages', true),
      check('crop', 'Photos: crop to the paper (removes the table or background)', true),
      check('searchable', 'Make the text searchable and copyable'),
      check('markUnsure', 'Highlight words that were hard to read so I can check them'),
      state.doc.pages.length > 1 ? check('all', `All ${state.doc.pages.length} pages (otherwise just this page)`) : null
    )
  );
  setTimeout(preview, 50);
  const ok = await dialog({ title: 'Restore old document', body, width: '720px', buttons: [{ label: 'Cancel', value: null }, { label: 'Restore', value: true, primary: true }] });
  if (!ok) return;
  const pages = opt.all ? state.doc.pages.slice() : [state.doc.pages[state.currentPage]];
  busy('Restoring…');
  try {
    const res = await restorePages(pages, { ...opt, mode });
    const unsure = res.reduce((n, r) => n + (Array.isArray(r.unsure) ? r.unsure.length : r.unsure || 0), 0);
    toast(`Restored ${res.length} page${res.length === 1 ? '' : 's'}.` + (unsure && opt.markUnsure && mode === 'retype' ? ` ${unsure} hard-to-read word${unsure === 1 ? ' is' : 's are'} highlighted in yellow — check them.` : '') + ' Undo puts the original back.', { ms: 8000 });
    return res;
  } catch (e) {
    console.error(e);
    toast('Could not restore: ' + e.message, { error: true, ms: 8000 });
  } finally {
    busy(false);
  }
}

export { copyCanvas };
