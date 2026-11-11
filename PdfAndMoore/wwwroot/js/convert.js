// Converting files to PDF (Word, Excel, PowerPoint, images, text, web pages...)
// and exporting PDF to Word, Excel, images, text and HTML.
import { htmlToPdf } from './host.js';
import { state } from './state.js';
import { buildPdf, getPageTextItems, getPageText, renderPageToCanvas, totalRotation, loadSource, pdfjsLib } from './doc.js';
import { extOf, baseName, escapeHtml, loadImage, canvasToBytes, busy, busyProgress } from './util.js';

const { PDFDocument, StandardFonts, rgb } = window.PDFLib;

export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'avif', 'svg', 'jfif'];
export const WORD_EXT = ['docx', 'docm', 'dotx'];
export const SHEET_EXT = ['xlsx', 'xlsm', 'xls', 'xlsb', 'ods', 'csv', 'tsv', 'numbers'];
export const SLIDE_EXT = ['pptx', 'pptm', 'ppsx', 'odp'];
export const TEXT_EXT = ['txt', 'md', 'markdown', 'log', 'json', 'xml', 'yml', 'yaml', 'ini', 'cfg', 'cs', 'js', 'ts', 'py', 'java', 'cpp', 'c', 'h', 'sql', 'css', 'bat', 'ps1', 'sh', 'vb', 'xaml', 'csproj', 'sln'];
export const HTML_EXT = ['html', 'htm', 'xhtml', 'svg'];
export const OTHER_DOC_EXT = ['rtf', 'odt', 'eml'];

export function kindOf(name) {
  const e = extOf(name);
  if (e === 'pdf') return 'pdf';
  if (e === 'svg') return 'image';
  if (IMAGE_EXT.includes(e)) return 'image';
  if (WORD_EXT.includes(e)) return 'word';
  if (SHEET_EXT.includes(e)) return 'sheet';
  if (SLIDE_EXT.includes(e)) return 'slides';
  if (HTML_EXT.includes(e)) return 'html';
  if (e === 'rtf') return 'rtf';
  if (e === 'odt') return 'odt';
  if (e === 'eml') return 'eml';
  if (e === 'doc' || e === 'ppt') return 'legacy-office';
  if (e === 'tif' || e === 'tiff') return 'tiff';
  if (e === 'heic' || e === 'heif') return 'heic';
  if (TEXT_EXT.includes(e)) return 'text';
  return 'unknown';
}

const PAGE_CSS = `
  @page { size: letter; margin: 0.75in; }
  body { font-family: Calibri, "Segoe UI", Arial, sans-serif; font-size: 11pt; line-height: 1.4; color: #111; }
  h1,h2,h3 { font-family: "Segoe UI", Arial, sans-serif; }
  table { border-collapse: collapse; font-size: 9.5pt; }
  td, th { border: 1px solid #bbb; padding: 3px 6px; vertical-align: top; }
  th { background: #f1f3f4; }
  img { max-width: 100%; }
  pre { white-space: pre-wrap; font-family: Consolas, "Courier New", monospace; font-size: 9.5pt; }
  .slide { page-break-after: always; border: 1px solid #ccc; border-radius: 8px; padding: 28px 36px; min-height: 5in; }
  .slide h2 { margin-top: 0; }
  .sheet-name { page-break-before: always; }
  .sheet-name:first-child { page-break-before: auto; }
`;

function htmlPage(title, bodyHtml, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${PAGE_CSS}${extraCss}</style></head><body>${bodyHtml}</body></html>`;
}

/** Convert any supported file to PDF bytes. */
export async function fileToPdf(file) {
  const kind = kindOf(file.name);
  const title = baseName(file.name);
  switch (kind) {
    case 'pdf':
      return file.bytes;
    case 'image':
      return imagesToPdf([file]);
    case 'tiff':
      return tiffToPdf(file);
    case 'heic':
      return heicToPdf(file);
    case 'word': {
      const res = await window.mammoth.convertToHtml({ arrayBuffer: file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) });
      return renderHtml(title, htmlPage(title, res.value));
    }
    case 'sheet': {
      const wb = window.XLSX.read(file.bytes, { type: 'array' });
      let html = '';
      for (const name of wb.SheetNames) {
        const sheet = wb.Sheets[name];
        if (!sheet['!ref']) continue;
        html += `<h2 class="sheet-name">${escapeHtml(name)}</h2>` + window.XLSX.utils.sheet_to_html(sheet, { header: '', footer: '' });
      }
      return renderHtml(title, htmlPage(title, html || '<p>(empty workbook)</p>'), { landscape: true });
    }
    case 'slides':
      return renderHtml(title, htmlPage(title, await slidesToHtml(file.bytes)), { landscape: true });
    case 'html': {
      const text = new TextDecoder().decode(file.bytes);
      if (extOf(file.name) === 'svg') return imagesToPdf([file]);
      return renderHtml(title, text);
    }
    case 'rtf':
      return renderHtml(title, htmlPage(title, `<pre>${escapeHtml(rtfToText(new TextDecoder('latin1').decode(file.bytes)))}</pre>`));
    case 'odt':
      return renderHtml(title, htmlPage(title, await odtToHtml(file.bytes)));
    case 'eml':
      return renderHtml(title, htmlPage(title, `<pre>${escapeHtml(new TextDecoder().decode(file.bytes))}</pre>`));
    case 'text': {
      const text = new TextDecoder().decode(file.bytes);
      return renderHtml(title, htmlPage(title, `<pre>${escapeHtml(text)}</pre>`));
    }
    case 'legacy-office':
      throw new Error(`Old .${extOf(file.name)} files can't be converted directly. Open it in Word or PowerPoint and save it as .${extOf(file.name)}x (or PDF), then open that.`);
    case 'unsupported-image':
      throw new Error(`.${extOf(file.name)} images aren't supported yet. Open it in Photos or Paint and save it as PNG or JPG, then open that.`);
    default: {
      // Try it as text if it looks like text.
      const text = new TextDecoder('utf-8', { fatal: false }).decode(file.bytes.slice(0, 4000));
      if (/[\x00-\x08\x0E-\x1F]/.test(text)) throw new Error(`"${file.name}" isn't a file type PDF and Moore can open.`);
      return renderHtml(title, htmlPage(title, `<pre>${escapeHtml(new TextDecoder().decode(file.bytes))}</pre>`));
    }
  }
}

/** HTML -> PDF. Uses the Edge engine in the Windows app; a plain text layout when testing in a browser. */
async function renderHtml(title, html, opts = {}) {
  const bytes = await htmlToPdf(html, opts).catch((e) => {
    console.warn('HTML to PDF failed in host, using simple layout', e);
    return null;
  });
  if (bytes) return bytes;
  const div = document.createElement('div');
  div.innerHTML = html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<title[\s\S]*?<\/title>/gi, '');
  div.querySelectorAll('p, h1, h2, h3, h4, li, tr, br, div').forEach((n) => n.append('\n'));
  div.querySelectorAll('td, th').forEach((n) => n.append('\t'));
  return textToPdf(title, div.textContent);
}

/** Simple text-to-PDF layout (also used for "Save as text PDF"). */
export async function textToPdf(title, text) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const size = 10.5;
  const lineH = size * 1.35;
  const margin = 54;
  const [W, H] = [612, 792];
  const maxW = W - margin * 2;
  const safe = (s) =>
    [...s]
      .map((ch) => {
        try {
          font.encodeText(ch);
          return ch;
        } catch {
          return ch === '\t' ? '    ' : '?';
        }
      })
      .join('');
  let page = pdf.addPage([W, H]);
  let y = H - margin;
  page.drawText(safe(title), { x: margin, y, size: 15, font: bold, color: rgb(0.1, 0.1, 0.1) });
  y -= 28;
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    const words = safe(raw.replace(/\t/g, '    ')).split(/(\s+)/);
    let line = '';
    const flush = () => {
      if (y < margin) {
        page = pdf.addPage([W, H]);
        y = H - margin;
      }
      page.drawText(line, { x: margin, y, size, font });
      y -= lineH;
      line = '';
    };
    for (const w of words) {
      if (font.widthOfTextAtSize(line + w, size) > maxW && line) flush();
      line += line ? w : w.trimStart();
    }
    flush();
  }
  return pdf.save();
}

// ---------------------------------------------------------------------------
// Photos and scans: TIFF (often several pages from a scanner), HEIC (iPhone), phone JPEG rotation
// ---------------------------------------------------------------------------
const loaded = {};
function loadScript(src) {
  if (!loaded[src])
    loaded[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../lib/' + src, import.meta.url).href;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.append(s);
    });
  return loaded[src];
}

/** EXIF orientation of a JPEG (1 = upright). Phones store photos sideways and set this flag. */
export function jpegOrientation(bytes) {
  try {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
    let i = 2;
    while (i < bytes.length - 10) {
      if (bytes[i] !== 0xff) return 1;
      const marker = bytes[i + 1];
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (marker === 0xe1 && String.fromCharCode(...bytes.slice(i + 4, i + 8)) === 'Exif') {
        const t = i + 10;
        const le = bytes[t] === 0x49;
        const u16 = (o) => (le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
        const u32 = (o) => (le ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0 : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
        const ifd = t + u32(t + 4);
        const n = u16(ifd);
        for (let k = 0; k < n; k++) {
          const e = ifd + 2 + k * 12;
          if (u16(e) === 0x0112) return u16(e + 8) || 1;
        }
        return 1;
      }
      if (marker === 0xda) return 1;
      i += 2 + len;
    }
  } catch {}
  return 1;
}

/** Page size for an image: real size if the file says its dpi, otherwise fit a letter page. */
function pageSizeFor(w, h, dpi = null) {
  if (dpi && dpi > 30 && dpi < 2400) {
    const pw = (w * 72) / dpi;
    const ph = (h * 72) / dpi;
    if (pw <= 1224 && ph <= 1584) return [pw, ph];
  }
  const box = w > h ? [792, 612] : [612, 792];
  const s = Math.min(box[0] / w, box[1] / h, 72 / 96);
  return [w * s, h * s];
}

async function addCanvasPage(pdf, canvas, dpi, { bilevel = false } = {}) {
  const img = bilevel || canvas.width * canvas.height < 1.5e6 ? await pdf.embedPng(await canvasToBytes(canvas, 'image/png')) : await pdf.embedJpg(await canvasToBytes(canvas, 'image/jpeg', 0.9));
  const [w, h] = pageSizeFor(canvas.width, canvas.height, dpi);
  pdf.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
}

/** TIFF files (every page of a multi-page scan). */
export async function tiffToPdf(file) {
  await loadScript('pako.min.js');
  await loadScript('utif.js');
  const UTIF = window.UTIF;
  const buf = file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength);
  const ifds = UTIF.decode(buf).filter((ifd) => ifd.t256 && ifd.t257 && !(ifd.t254 && ifd.t254[0] & 1)); // skip thumbnails
  if (!ifds.length) throw new Error('This TIFF file has no pages that can be read.');
  const pdf = await PDFDocument.create();
  for (let i = 0; i < ifds.length; i++) {
    busyProgress(i / ifds.length, `Reading page ${i + 1} of ${ifds.length}…`);
    const ifd = ifds[i];
    UTIF.decodeImage(buf, ifd);
    const rgba = UTIF.toRGBA8(ifd);
    const c = document.createElement('canvas');
    c.width = ifd.width;
    c.height = ifd.height;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, ifd.width * ifd.height * 4), ifd.width, ifd.height), 0, 0);
    const xres = ifd.t282 ? (Array.isArray(ifd.t282[0]) ? ifd.t282[0][0] / (ifd.t282[0][1] || 1) : ifd.t282[0]) : null;
    const unitCm = ifd.t296 && ifd.t296[0] === 3;
    await addCanvasPage(pdf, c, xres ? (unitCm ? xres * 2.54 : xres) : 200, { bilevel: ifd.t258 && ifd.t258[0] === 1 });
  }
  return pdf.save();
}

/** HEIC/HEIF photos from iPhones. */
export async function heicToPdf(file) {
  await loadScript('heic2any.min.js');
  const out = await window.heic2any({ blob: new Blob([file.bytes], { type: 'image/heic' }), toType: 'image/jpeg', quality: 0.92, multiple: true });
  const blobs = Array.isArray(out) ? out : [out];
  const files = [];
  for (let i = 0; i < blobs.length; i++) files.push({ name: `${baseName(file.name)}-${i + 1}.jpg`, bytes: new Uint8Array(await blobs[i].arrayBuffer()) });
  return imagesToPdf(files);
}

/** Each image becomes one page sized to the image (fitted to a letter page unless it says its size). */
export async function imagesToPdf(files) {
  const pdf = await PDFDocument.create();
  for (const f of files) {
    const e = extOf(f.name);
    let img;
    if (e === 'png') img = await pdf.embedPng(f.bytes);
    else if ((e === 'jpg' || e === 'jpeg' || e === 'jfif') && jpegOrientation(f.bytes) === 1) img = await pdf.embedJpg(f.bytes);
    else {
      // Decode with the browser, then store as PNG.
      const mime = e === 'svg' ? 'image/svg+xml' : e === 'jpg' || e === 'jfif' ? 'image/jpeg' : 'image/' + e;
      const url = URL.createObjectURL(new Blob([f.bytes], { type: mime }));
      try {
        const im = await loadImage(url);
        const c = document.createElement('canvas');
        c.width = im.naturalWidth || 1200;
        c.height = im.naturalHeight || 1600;
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(im, 0, 0, c.width, c.height);
        // Photos (and phone pictures turned upright here) stay JPEG; drawings become PNG.
        img = /^(jpe?g|jfif|webp|avif)$/.test(e) ? await pdf.embedJpg(await canvasToBytes(c, 'image/jpeg', 0.92)) : await pdf.embedPng(await canvasToBytes(c, 'image/png'));
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const [w, h] = pageSizeFor(img.width, img.height);
    const page = pdf.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return pdf.save();
}

async function slidesToHtml(bytes) {
  const zip = await window.JSZip.loadAsync(bytes);
  const slideFiles = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n) || /^content\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/\d+/) || 0) - parseInt(b.match(/\d+/) || 0));
  let html = '';
  for (const name of slideFiles) {
    const xml = await zip.file(name).async('string');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const paras = [...doc.getElementsByTagNameNS('*', 'p')]
      .map((p) => [...p.getElementsByTagNameNS('*', 't')].map((t) => t.textContent).join(''))
      .filter((t) => t.trim());
    const [first, ...rest] = paras;
    html += `<div class="slide"><h2>${escapeHtml(first || '')}</h2>${rest.length ? '<ul>' + rest.map((t) => `<li>${escapeHtml(t)}</li>`).join('') + '</ul>' : ''}</div>`;
  }
  return html || '<p>(no slide text found)</p>';
}

async function odtToHtml(bytes) {
  const zip = await window.JSZip.loadAsync(bytes);
  const xml = await zip.file('content.xml').async('string');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return [...doc.getElementsByTagNameNS('*', 'p'), ...doc.getElementsByTagNameNS('*', 'h')]
    .map((p) => `<p>${escapeHtml(p.textContent)}</p>`)
    .join('');
}

function rtfToText(rtf) {
  return rtf
    .replace(/\\par[d]?/g, '\n')
    .replace(/\{\\\*[^{}]*\}/g, '')
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Group a page's text items into lines of "cells" (used for Word and Excel export). */
async function pageLines(page) {
  const items = (await getPageTextItems(state.doc, page)).filter((i) => i.str.trim());
  if (!items.length && page.ocrText) return page.ocrText.split('\n').map((t) => [{ text: t, x: 0 }]);
  const rows = [];
  for (const it of items) {
    const y = it.transform[5];
    const x = it.transform[4];
    let row = rows.find((r) => Math.abs(r.y - y) < Math.max(2, (it.height || 10) * 0.4));
    if (!row) rows.push((row = { y, cells: [] }));
    row.cells.push({ text: it.str, x, w: it.width, size: it.height || 10, font: it.fontName });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.cells.sort((a, b) => a.x - b.x);
    // Merge pieces that are close together into one cell.
    const merged = [];
    for (const c of r.cells) {
      const last = merged[merged.length - 1];
      if (last && c.x - (last.x + last.w) < Math.max(4, c.size * 0.9)) {
        last.text += (c.x - (last.x + last.w) > c.size * 0.15 ? ' ' : '') + c.text;
        last.w = c.x + c.w - last.x;
      } else merged.push({ ...c });
    }
    merged.y = r.y;
    return merged;
  });
}

export async function exportWord() {
  const D = window.docx;
  const children = [];
  const pages = state.doc.pages;
  for (let i = 0; i < pages.length; i++) {
    busyProgress(i / pages.length, `Converting page ${i + 1} of ${pages.length}…`);
    const lines = await pageLines(pages[i]);
    const sizes = lines.flat().map((c) => c.size || 10);
    const body = sizes.length ? sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)] : 10;
    let prevY = null;
    for (const line of lines) {
      const text = line.map((c) => c.text).join('\t');
      const size = Math.max(...line.map((c) => c.size || 10));
      const isHeading = size > body * 1.3 && text.length < 120;
      const gap = prevY !== null && line.y !== undefined ? prevY - line.y : 0;
      children.push(
        new D.Paragraph({
          children: [new D.TextRun({ text, size: Math.round(Math.min(48, Math.max(16, size * 2))), bold: isHeading })],
          spacing: { before: gap > body * 2 ? 160 : 0, after: 40 },
        })
      );
      prevY = line.y;
    }
    if (i < pages.length - 1) children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
  }
  const document = new D.Document({ creator: 'PDF and Moore', title: baseName(state.doc.name), sections: [{ children }] });
  const blob = await D.Packer.toBlob(document);
  return new Uint8Array(await blob.arrayBuffer());
}

export async function exportExcel() {
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  const pages = state.doc.pages;
  const all = [];
  for (let i = 0; i < pages.length; i++) {
    busyProgress(i / pages.length, `Reading page ${i + 1} of ${pages.length}…`);
    const lines = await pageLines(pages[i]);
    // Use the x positions on the page to line cells up into columns.
    const xs = [...new Set(lines.flat().map((c) => Math.round(c.x / 12) * 12))].sort((a, b) => a - b);
    const rows = lines.map((line) => {
      const row = new Array(xs.length).fill('');
      for (const c of line) {
        const col = xs.indexOf(Math.round(c.x / 12) * 12);
        row[col] = row[col] ? row[col] + ' ' + c.text : c.text;
      }
      // Numbers become real numbers.
      return row.map((v) => (/^-?\$?[\d,]+(\.\d+)?%?$/.test(v.trim()) && v.trim() ? Number(v.replace(/[$,%]/g, '')) : v));
    });
    const compact = rows.map((r) => r.filter((v, idx) => rows.some((rr) => rr[idx] !== '')));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(compact), `Page ${i + 1}`);
    all.push(...compact, []);
  }
  if (pages.length > 1) {
    const ws = XLSX.utils.aoa_to_sheet(all);
    XLSX.utils.book_append_sheet(wb, ws, 'All pages');
    wb.SheetNames.unshift(wb.SheetNames.pop());
  }
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

export async function exportText() {
  let out = '';
  for (let i = 0; i < state.doc.pages.length; i++) {
    out += (i ? '\n\n' : '') + `----- Page ${i + 1} -----\n` + (await getPageText(state.doc, state.doc.pages[i]));
  }
  return new TextEncoder().encode(out);
}

export async function exportHtml() {
  let body = '';
  for (let i = 0; i < state.doc.pages.length; i++) {
    const lines = await pageLines(state.doc.pages[i]);
    body += `<section class="page"><h2>Page ${i + 1}</h2>` + lines.map((l) => `<p>${escapeHtml(l.map((c) => c.text).join('  '))}</p>`).join('') + '</section>';
  }
  return new TextEncoder().encode(htmlPage(baseName(state.doc.name), body));
}

/** Render the finished PDF (with edits) to images. Returns a zip of PNG/JPG files, or a single image. */
export async function exportImages(format = 'png', dpi = 150) {
  const { bytes } = await buildPdf(state.doc);
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const files = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    busyProgress((i - 1) / pdf.numPages, `Saving page ${i} of ${pdf.numPages} as an image…`);
    const p = await pdf.getPage(i);
    const vp = p.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: g, viewport: vp }).promise;
    files.push({ name: `${baseName(state.doc.name)} - page ${i}.${format === 'jpeg' ? 'jpg' : 'png'}`, bytes: await canvasToBytes(c, format === 'jpeg' ? 'image/jpeg' : 'image/png', 0.9) });
  }
  if (files.length === 1) return { single: true, ...files[0] };
  const zip = new window.JSZip();
  files.forEach((f) => zip.file(f.name, f.bytes));
  return { single: false, name: baseName(state.doc.name) + ' - images.zip', bytes: await zip.generateAsync({ type: 'uint8array' }) };
}

/** Make the file smaller by re-saving pages as compressed images (for scans and photos). */
export async function compressPdf(dpi = 110, quality = 0.7) {
  const { bytes } = await buildPdf(state.doc);
  const src = await pdfjsLib.getDocument({ data: bytes }).promise;
  const out = await PDFDocument.create();
  for (let i = 1; i <= src.numPages; i++) {
    busyProgress((i - 1) / src.numPages, `Compressing page ${i} of ${src.numPages}…`);
    const p = await src.getPage(i);
    const vp1 = p.getViewport({ scale: 1 });
    const vp = p.getViewport({ scale: dpi / 72 });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    await p.render({ canvasContext: g, viewport: vp }).promise;
    const img = await out.embedJpg(await canvasToBytes(c, 'image/jpeg', quality));
    const page = out.addPage([vp1.width, vp1.height]);
    page.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
  }
  return out.save({ useObjectStreams: true });
}

export { totalRotation, renderPageToCanvas, loadSource, busy };
