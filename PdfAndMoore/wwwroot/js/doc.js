// Document model: source PDFs, the page list, annotations, form values, and saving.
import * as pdfjsLib from '../lib/pdfjs/pdf.min.mjs';
import { uid, hexToRgb01, promptDialog } from './util.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../lib/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
export { pdfjsLib };

const PDFLib = window.PDFLib;
const { PDFDocument, rgb, degrees, StandardFonts, BlendMode, PDFName, PDFHexString } = PDFLib;

const PDFJS_OPTS = {
  cMapUrl: new URL('../lib/pdfjs/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('../lib/pdfjs/standard_fonts/', import.meta.url).href,
  isEvalSupported: false,
};

// ---------- vectors for page rotation ----------
// For a page shown rotated by `rot` degrees clockwise, these give the PDF user-space
// direction that points "right" and "down" on screen.
export function rightVec(rot) {
  return { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] }[((rot % 360) + 360) % 360];
}
export function downVec(rot) {
  return { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] }[((rot % 360) + 360) % 360];
}
const dot = (p, v) => p[0] * v[0] + p[1] * v[1];

/** For an axis-aligned user-space box, return its top-left corner, width and height as seen on screen at `rot`. */
export function boxInView(x1, y1, x2, y2, rot) {
  const R = rightVec(rot);
  const D = downVec(rot);
  const corners = [
    [x1, y1],
    [x1, y2],
    [x2, y1],
    [x2, y2],
  ];
  let tl = corners[0];
  for (const c of corners) if (dot(c, R) + dot(c, D) < dot(tl, R) + dot(tl, D)) tl = c;
  let bl = corners[0];
  for (const c of corners) if (dot(c, R) - dot(c, D) < dot(bl, R) - dot(bl, D)) bl = c;
  const w = Math.abs(rot % 180 === 0 ? x2 - x1 : y2 - y1);
  const h = Math.abs(rot % 180 === 0 ? y2 - y1 : x2 - x1);
  return { tl, bl, w, h };
}

// ---------- loading ----------

/** Load PDF bytes into a "source": a pdf.js document plus the original bytes. */
export async function loadSource(bytes, label = 'this PDF') {
  let password;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const task = pdfjsLib.getDocument({ ...PDFJS_OPTS, data: bytes.slice(), password });
      const pdf = await task.promise;
      let encrypted = false;
      try {
        await PDFDocument.load(bytes, { updateMetadata: false });
      } catch (e) {
        encrypted = /encrypt/i.test(String(e && e.message));
      }
      if (encrypted && password) {
        // You typed the password, so unlock a working copy: forms, text and links keep working.
        // (Protect › Lock with password puts a password back on when you save.)
        try {
          const secure = await import('../lib/pdf-lib-secure/pdf-lib.esm.min.js');
          const plainDoc = await secure.PDFDocument.load(bytes, { password, updateMetadata: false });
          const plain = await plainDoc.save();
          await PDFDocument.load(plain, { updateMetadata: false });
          return { id: uid(), bytes: plain, pdf, encrypted: false, label, openPassword: password };
        } catch (e) {
          console.warn('Could not unlock a working copy; pages will be copied as pictures.', e);
        }
      }
      return { id: uid(), bytes, pdf, encrypted, label };
    } catch (e) {
      if (e && e.name === 'PasswordException') {
        password = await promptDialog(
          'Password required',
          `${label} is password-protected. Enter the password to open it.`,
          ''
        );
        if (password === null) throw new Error('Opening cancelled.');
        continue;
      }
      throw new Error('This file could not be opened as a PDF. ' + ((e && e.message) || ''));
    }
  }
  throw new Error('Incorrect password.');
}

/** Build page records for every page of a source. */
export async function pagesForSource(source) {
  const pages = [];
  for (let i = 0; i < source.pdf.numPages; i++) {
    const p = await source.pdf.getPage(i + 1);
    const vp = p.getViewport({ scale: 1, rotation: 0 });
    pages.push({
      id: uid(),
      src: source.id,
      index: i,
      baseRotate: p.rotate || 0,
      rotate: 0,
      w: vp.width,
      h: vp.height,
      annots: [],
    });
  }
  return pages;
}

export function totalRotation(page) {
  return (((page.baseRotate + page.rotate) % 360) + 360) % 360;
}

export async function blankPdfBytes(sizeName = 'Letter') {
  const sizes = { Letter: [612, 792], A4: [595.28, 841.89], Legal: [612, 1008] };
  const doc = await PDFDocument.create();
  doc.addPage(sizes[sizeName] || sizes.Letter);
  return doc.save();
}

// ---------- form fields ----------

/** Field type name (works with the minified library, where class names are shortened). */
function typeName(f) {
  const L = window.PDFLib;
  if (f instanceof L.PDFTextField) return 'PDFTextField';
  if (f instanceof L.PDFCheckBox) return 'PDFCheckBox';
  if (f instanceof L.PDFDropdown) return 'PDFDropdown';
  if (f instanceof L.PDFOptionList) return 'PDFOptionList';
  if (f instanceof L.PDFRadioGroup) return 'PDFRadioGroup';
  if (f instanceof L.PDFSignature) return 'PDFSignature';
  if (f instanceof L.PDFButton) return 'PDFButton';
  return 'other';
}

/** Read AcroForm fields for a source: [{name, kind, value, options, widgets:[{pageIndex, rect}]}] */
export async function readFormFields(source) {
  if (source.encrypted) return [];
  let doc;
  try {
    doc = await PDFDocument.load(source.bytes, { updateMetadata: false });
  } catch {
    return [];
  }
  const form = doc.getForm();
  const pageRefs = doc.getPages().map((p) => p.ref);
  const out = [];
  for (const f of form.getFields()) {
    const ctor = typeName(f);
    let kind = 'other';
    let value = '';
    let options = [];
    try {
      if (ctor === 'PDFTextField') {
        kind = 'text';
        value = f.getText() || '';
      } else if (ctor === 'PDFCheckBox') {
        kind = 'checkbox';
        value = f.isChecked();
      } else if (ctor === 'PDFDropdown') {
        kind = 'dropdown';
        options = f.getOptions();
        value = (f.getSelected() || [])[0] || '';
      } else if (ctor === 'PDFOptionList') {
        kind = 'dropdown';
        options = f.getOptions();
        value = (f.getSelected() || [])[0] || '';
      } else if (ctor === 'PDFSignature') {
        kind = 'signature';
      } else if (ctor === 'PDFRadioGroup') {
        kind = 'radio';
        options = f.getOptions();
        value = f.getSelected() || '';
      } else continue;
    } catch {
      continue;
    }
    let multiline = false;
    let required = false;
    try {
      required = f.isRequired();
      if (kind === 'text') multiline = f.isMultiline();
    } catch {}
    const widgets = [];
    f.acroField.getWidgets().forEach((w, wi) => {
      const r = w.getRectangle();
      let pageIndex = -1;
      const pRef = w.P();
      if (pRef) pageIndex = pageRefs.findIndex((ref) => ref === pRef || String(ref) === String(pRef));
      if (pageIndex < 0) {
        // Find the page whose /Annots contains this widget.
        const wRef = doc.context.getObjectRef(w.dict);
        doc.getPages().forEach((pg, pi) => {
          const annots = pg.node.Annots();
          if (annots && wRef && annots.asArray().some((a) => String(a) === String(wRef))) pageIndex = pi;
        });
      }
      let onValue = null;
      if (kind === 'radio') onValue = options[wi] ?? null;
      let border = false;
      try {
        const mk = w.getAppearanceCharacteristics();
        border = !!(mk && mk.getBorderColor() && mk.getBorderColor().length);
      } catch {}
      widgets.push({ pageIndex, rect: [r.x, r.y, r.x + r.width, r.y + r.height], onValue, border });
    });
    out.push({ name: f.getName(), kind, value, options, widgets, readOnly: f.isReadOnly(), multiline, required });
  }
  return out;
}

// ---------- text extraction ----------

export async function getPageTextItems(doc, page) {
  const src = doc.sources.find((s) => s.id === page.src);
  const p = await src.pdf.getPage(page.index + 1);
  const tc = await p.getTextContent();
  const items = tc.items.filter((it) => typeof it.str === 'string');
  for (const it of items) it.mono = /mono/i.test((tc.styles[it.fontName] || {}).fontFamily || '');
  return items;
}

/** Plain text of a page, with line breaks rebuilt from positions. Includes OCR text if the page was recognized. */
export async function getPageText(doc, page) {
  const items = await getPageTextItems(doc, page);
  let text = '';
  let lastY = null;
  for (const it of items) {
    const y = it.transform[5];
    if (lastY !== null && Math.abs(y - lastY) > 2) text += '\n';
    else if (text && !text.endsWith(' ') && it.str && !it.str.startsWith(' ')) text += ' ';
    text += it.str;
    if (it.hasEOL) text += '\n';
    lastY = y;
  }
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text && page.ocrText) text = page.ocrText;
  return text;
}

export async function getAllText(doc, maxChars = 400000) {
  const parts = [];
  let total = 0;
  for (let i = 0; i < doc.pages.length; i++) {
    const t = await getPageText(doc, doc.pages[i]);
    parts.push(`--- Page ${i + 1} ---\n${t}`);
    total += t.length;
    if (total > maxChars) {
      parts.push(`[Text truncated after page ${i + 1} of ${doc.pages.length}]`);
      break;
    }
  }
  return parts.join('\n\n');
}

// ---------- saving ----------

const FONT_MAP = {
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
  Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold],
};

/** Replace characters the standard PDF fonts cannot draw. */
function winAnsiSafe(font, s) {
  let out = '';
  for (const ch of String(s).replace(/[\u200B-\u200F\uFEFF\u00AD\u0000-\u0008]/g, '')) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      const map = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...' };
      out += map[ch] || '?';
    }
  }
  return out;
}

export function wrapText(font, text, size, maxWidth) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    if (!maxWidth) {
      lines.push(para);
      continue;
    }
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (line && font.widthOfTextAtSize(test.trimEnd(), size) > maxWidth) {
        lines.push(line.trimEnd());
        line = w.trimStart();
      } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

function color(hex) {
  const [r, g, b] = hexToRgb01(hex || '#000000');
  return rgb(r, g, b);
}

function svgPathFromUserPoints(points, close) {
  // pdf-lib's drawSvgPath flips Y, so negate Y and draw at origin.
  let d = '';
  points.forEach((p, i) => {
    d += (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + (-p[1]).toFixed(2) + ' ';
  });
  if (close) d += 'Z';
  return d;
}

async function drawAnnotations(outDoc, pdfPage, page, fontCache) {
  const getFont = async (name, bold) => {
    const key = name + (bold ? 'B' : '');
    if (!fontCache[key]) fontCache[key] = await outDoc.embedFont(FONT_MAP[name || 'Helvetica'][bold ? 1 : 0]);
    return fontCache[key];
  };
  for (const a of page.annots) {
    const rot = a.rot ?? 0;
    if (a.type === 'highlight' || a.type === 'underline' || a.type === 'strike') {
      for (const r of a.rects) {
        const [x1, y1, x2, y2] = r;
        if (a.type === 'highlight') {
          pdfPage.drawSvgPath(
            svgPathFromUserPoints(
              [
                [x1, y1],
                [x2, y1],
                [x2, y2],
                [x1, y2],
              ],
              true
            ),
            { x: 0, y: 0, color: color(a.color), opacity: 0.4, borderWidth: 0, blendMode: BlendMode.Multiply }
          );
        } else {
          const { tl, w, h } = boxInView(x1, y1, x2, y2, rot);
          const R = rightVec(rot);
          const D = downVec(rot);
          const off = a.type === 'underline' ? h * 0.92 : h * 0.55;
          const start = [tl[0] + D[0] * off, tl[1] + D[1] * off];
          const end = [start[0] + R[0] * w, start[1] + R[1] * w];
          pdfPage.drawLine({
            start: { x: start[0], y: start[1] },
            end: { x: end[0], y: end[1] },
            thickness: Math.max(0.8, h * 0.07),
            color: color(a.color),
          });
        }
      }
    } else if (a.type === 'rect' || a.type === 'ellipse') {
      let pts;
      if (a.type === 'rect') {
        pts = [
          [a.x1, a.y1],
          [a.x2, a.y1],
          [a.x2, a.y2],
          [a.x1, a.y2],
        ];
      } else {
        const cx = (a.x1 + a.x2) / 2;
        const cy = (a.y1 + a.y2) / 2;
        const rx = Math.abs(a.x2 - a.x1) / 2;
        const ry = Math.abs(a.y2 - a.y1) / 2;
        pts = [];
        for (let i = 0; i < 72; i++) {
          const t = (i / 72) * Math.PI * 2;
          pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
        }
      }
      const opts = { x: 0, y: 0, opacity: a.opacity ?? 1, borderOpacity: a.opacity ?? 1 };
      if (a.fill) opts.color = color(a.fill);
      if (a.stroke) {
        opts.borderColor = color(a.stroke);
        opts.borderWidth = a.width || 2;
      } else opts.borderWidth = 0;
      pdfPage.drawSvgPath(svgPathFromUserPoints(pts, true), opts);
    } else if (a.type === 'line' || a.type === 'arrow' || a.type === 'ink') {
      const pts = a.pts;
      for (let i = 1; i < pts.length; i++) {
        pdfPage.drawLine({
          start: { x: pts[i - 1][0], y: pts[i - 1][1] },
          end: { x: pts[i][0], y: pts[i][1] },
          thickness: a.width || 2,
          color: color(a.stroke),
          opacity: a.opacity ?? 1,
          lineCap: a.butt ? PDFLib.LineCapStyle.Butt : PDFLib.LineCapStyle.Round,
        });
      }
      if (a.type === 'arrow' && pts.length >= 2) {
        const [p0, p1] = [pts[0], pts[pts.length - 1]];
        const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
        const len = 6 + (a.width || 2) * 3;
        for (const s of [-1, 1]) {
          const t = ang + Math.PI + (s * Math.PI) / 7;
          pdfPage.drawLine({
            start: { x: p1[0], y: p1[1] },
            end: { x: p1[0] + len * Math.cos(t), y: p1[1] + len * Math.sin(t) },
            thickness: a.width || 2,
            color: color(a.stroke),
            lineCap: PDFLib.LineCapStyle.Round,
          });
        }
      }
    } else if (a.type === 'text') {
      const font = await getFont(a.font, a.bold);
      const R = rightVec(rot);
      const D = downVec(rot);
      const size = a.size || 12;
      const lines = wrapText(font, winAnsiSafe(font, a.text || ''), size, a.w || 0);
      if (a.bg || a.border) {
        const w = Math.max(a.w || Math.max(...lines.map((l) => font.widthOfTextAtSize(l, size)), 10), a.minW || 0);
        const h = lines.length * size * 1.2 + 2;
        const tl = [a.x, a.y];
        const corners = [tl, [tl[0] + R[0] * w, tl[1] + R[1] * w], [tl[0] + R[0] * w + D[0] * h, tl[1] + R[1] * w + D[1] * h], [tl[0] + D[0] * h, tl[1] + D[1] * h]];
        const opts = { x: 0, y: 0, borderWidth: 0 };
        if (a.bg) opts.color = color(a.bg);
        if (a.border) {
          opts.borderColor = color(a.border);
          opts.borderWidth = a.borderWidth || 1;
        }
        pdfPage.drawSvgPath(svgPathFromUserPoints(corners, true), opts);
      }
      lines.forEach((line, i) => {
        const down = size * 0.9 + i * size * 1.2;
        pdfPage.drawText(line, {
          x: a.x + D[0] * down,
          y: a.y + D[1] * down,
          size,
          font,
          color: color(a.color),
          rotate: degrees(rot),
          opacity: a.opacity ?? 1,
        });
      });
    } else if (a.type === 'image') {
      const bytes = Uint8Array.from(atob(a.dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
      const img = a.dataUrl.startsWith('data:image/png') ? await outDoc.embedPng(bytes) : await outDoc.embedJpg(bytes);
      const { bl, w, h } = boxInView(a.x1, a.y1, a.x2, a.y2, rot);
      pdfPage.drawImage(img, { x: bl[0], y: bl[1], width: w, height: h, rotate: degrees(rot) });
    } else if (a.type === 'note') {
      // A real PDF comment (sticky note) that other PDF readers show and list.
      const size = 20;
      const annot = outDoc.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [a.x, a.y - size, a.x + size, a.y],
        Contents: PDFHexString.fromText(a.text || ''),
        T: PDFHexString.fromText(a.author || 'PDF and Moore'),
        Name: 'Comment',
        C: hexToRgb01(a.color || '#fbbc04'),
        F: 4,
        Open: false,
      });
      const ref = outDoc.context.register(annot);
      pdfPage.node.addAnnot(ref);
    } else if (a.type === 'ocrtext') {
      // Invisible text from OCR so a scanned page becomes searchable.
      const font = await getFont('Helvetica', false);
      for (const w of a.words) {
        const t = winAnsiSafe(font, w.text);
        if (!t.trim()) continue;
        const unit = font.widthOfTextAtSize(t, 1);
        const size = Math.max(1, Math.min(200, unit > 0 ? w.width / unit : w.height));
        pdfPage.drawText(t, { x: w.x, y: w.y, size, font, opacity: 0, rotate: degrees(w.angle || 0) });
      }
    }
  }
}

/** Order fields top-to-bottom, left-to-right as seen on screen, so Tab moves through them naturally. */
function readingOrder(fields, rot) {
  const R = rightVec(rot);
  const D = downVec(rot);
  const key = (a) => {
    const c = [(a.x1 + a.x2) / 2, (a.y1 + a.y2) / 2];
    return { row: dot(c, D), col: dot(c, R), h: Math.abs(rot % 180 === 0 ? a.y2 - a.y1 : a.x2 - a.x1) };
  };
  return [...fields].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (Math.abs(ka.row - kb.row) > Math.min(ka.h, kb.h) * 0.6) return ka.row - kb.row;
    return ka.col - kb.col;
  });
}

function cleanFieldName(name) {
  // A "." makes PDF readers treat the name as a parent/child path, so use "_" instead.
  return (String(name || 'Field').trim() || 'Field').replace(/\./g, '_');
}

/**
 * Create real PDF form fields from the 'field' annotations on a page.
 * `groups` remembers fields already created on earlier pages so a name used on
 * several pages becomes one field with several boxes (like Acrobat).
 */
async function addFormFields(outDoc, pdfPage, page, groups, fontCache) {
  const fields = page.annots.filter((a) => a.type === 'field');
  if (!fields.length) return;
  const form = outDoc.getForm();
  const rot = totalRotation(page);
  pdfPage.node.set(PDFName.of('Tabs'), PDFName.of('R'));
  for (const a of readingOrder(fields, rot)) {
    const x = Math.min(a.x1, a.x2);
    const y = Math.min(a.y1, a.y2);
    const width = Math.abs(a.x2 - a.x1);
    const height = Math.abs(a.y2 - a.y1);
    const rect = { x, y, width, height, rotate: degrees(rot) };
    // No background, so the printed lines and boxes of the form stay visible.
    const border = a.border ? { borderColor: rgb(0.35, 0.35, 0.35), borderWidth: 1, backgroundColor: undefined } : { borderWidth: 0, borderColor: undefined, backgroundColor: undefined };
    const name = cleanFieldName(a.name);
    const key = a.kind + ':' + name;
    try {
      if (a.kind === 'signature') {
        if (a.sig) {
          // Already signed in PDF and Moore: stamp the signature into the box.
          const bytes = Uint8Array.from(atob(a.sig.split(',')[1]), (c) => c.charCodeAt(0));
          const img = await outDoc.embedPng(bytes);
          const fit = Math.min(width / img.width, height / img.height);
          const { bl } = boxInView(a.x1, a.y1, a.x2, a.y2, rot);
          pdfPage.drawImage(img, { x: bl[0], y: bl[1], width: img.width * fit, height: img.height * fit, rotate: degrees(rot) });
          continue;
        }
        // An empty signature field that Acrobat and other readers let people sign.
        const sig = outDoc.context.obj({
          FT: 'Sig',
          T: PDFHexString.fromText(name),
          Type: 'Annot',
          Subtype: 'Widget',
          Rect: [x, y, x + width, y + height],
          F: 4,
          P: pdfPage.ref,
          MK: { BC: [0.35, 0.35, 0.35], R: rot },
        });
        const ref = outDoc.context.register(sig);
        pdfPage.node.addAnnot(ref);
        form.acroForm.addField(ref);
        continue;
      }
      if (a.kind === 'radio') {
        let group = groups[key];
        if (!group) {
          group = groups[key] = form.createRadioGroup(name);
          if (a.required) group.enableRequired();
        }
        const opt = String(a.onValue || 'Choice' + (group.getOptions().length + 1));
        group.addOptionToPage(opt, pdfPage, { ...rect, ...border });
        if (a.value === true || a.value === opt) group.select(opt);
        continue;
      }
      if (a.kind === 'checkbox') {
        let cb = groups[key];
        if (!cb) cb = groups[key] = form.createCheckBox(groups[name] ? name + '_' + Object.keys(groups).length : name);
        groups[name] = true;
        cb.addToPage(pdfPage, { ...rect, ...border });
        if (a.value) cb.check();
        if (a.required) cb.enableRequired();
        continue;
      }
      if (a.kind === 'dropdown') {
        let dd = groups[key];
        if (!dd) {
          dd = groups[key] = form.createDropdown(name);
          dd.setOptions((a.options || []).filter(Boolean));
          if (a.editable) dd.enableEditing();
        }
        groups[name] = true;
        dd.addToPage(pdfPage, { ...rect, ...border, font: await embedStd(outDoc, fontCache) });
        if (a.value) dd.select(String(a.value), !!a.editable);
        if (a.required) dd.enableRequired();
        continue;
      }
      // text and date
      let tf = groups[key];
      if (!tf) {
        tf = groups[key] = form.createTextField(groups[name] ? name + '_' + Object.keys(groups).length : name);
        if (a.multiline) tf.enableMultiline();
        if (a.required) tf.enableRequired();
        if (a.maxLength) tf.setMaxLength(a.maxLength);
        if (a.align === 'center') tf.setAlignment(PDFLib.TextAlignment.Center);
        if (a.align === 'right') tf.setAlignment(PDFLib.TextAlignment.Right);
      }
      groups[name] = true;
      tf.addToPage(pdfPage, { ...rect, ...border, font: await embedStd(outDoc, fontCache) });
      // Like Acrobat's "Auto", but never huge: a comfortable size for the box height.
      tf.setFontSize(a.fontSize || Math.max(6, Math.min(11, (a.multiline ? 11 : (Math.min(width, height) || 14) * 0.62))));
      if (a.value) tf.setText(String(a.value));
    } catch (e) {
      console.warn('Could not create field', name, e);
    }
  }
}

async function embedStd(outDoc, fontCache) {
  if (!fontCache.Helvetica) fontCache.Helvetica = await outDoc.embedFont(StandardFonts.Helvetica);
  return fontCache.Helvetica;
}

/** Remove a page's existing form widgets (used when the form was rebuilt in Prepare Form). */
function stripWidgets(pdfPage) {
  const annots = pdfPage.node.Annots();
  if (!annots) return;
  const ctx = pdfPage.doc.context;
  const keep = annots.asArray().filter((ref) => {
    const d = ctx.lookup(ref);
    const sub = d && d.get && d.get(PDFName.of('Subtype'));
    return !(sub && String(sub) === '/Widget');
  });
  pdfPage.node.set(PDFName.of('Annots'), ctx.obj(keep));
}

function applyFormValues(libDoc, values) {
  if (!values) return;
  const form = libDoc.getForm();
  for (const [name, value] of Object.entries(values)) {
    const f = form.getFieldMaybe(name);
    if (!f) continue;
    try {
      const ctor = typeName(f);
      if (ctor === 'PDFTextField') f.setText(String(value ?? ''));
      else if (ctor === 'PDFCheckBox') value ? f.check() : f.uncheck();
      else if ((ctor === 'PDFDropdown' || ctor === 'PDFOptionList') && value) f.select(String(value));
      else if (ctor === 'PDFRadioGroup' && value) f.select(String(value));
    } catch (e) {
      console.warn('Could not set field', name, e);
    }
  }
}

async function rasterizeSourcePage(src, index) {
  const p = await src.pdf.getPage(index + 1);
  const vp = p.getViewport({ scale: 200 / 72, rotation: 0 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await p.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Produce the final PDF bytes for the document: page order, rotation, annotations and form values.
 * Returns { bytes, flattenedForms }.
 */
export async function buildPdf(doc, { pageIds = null } = {}) {
  const pages = pageIds ? doc.pages.filter((p) => pageIds.includes(p.id)) : doc.pages;
  const fontCache = {};
  const srcById = Object.fromEntries(doc.sources.map((s) => [s.id, s]));

  // Fast path: one source, pages kept in their original order (some may be removed).
  // Editing the original file keeps bookmarks, links and fillable form fields.
  const single = new Set(pages.map((p) => p.src)).size === 1;
  const inOrder = pages.every((p, i) => i === 0 || p.index > pages[i - 1].index);
  const src0 = srcById[pages[0].src];
  if (single && inOrder && !src0.encrypted) {
    const outDoc = await PDFDocument.load(src0.bytes, { updateMetadata: false });
    const prepared = doc.prepared && doc.prepared[src0.id];
    if (prepared) {
      // The form was rebuilt in Edit Fields: drop the old form completely; the new fields are created below.
      outDoc.catalog.delete(PDFName.of('AcroForm'));
      outDoc.getPages().forEach(stripWidgets);
    } else applyFormValues(outDoc, doc.formValues[src0.id]);
    const keep = new Set(pages.map((p) => p.index));
    const all = outDoc.getPages();
    const groups = {};
    for (const p of pages) {
      const pdfPage = all[p.index];
      pdfPage.setRotation(degrees(totalRotation(p)));
      await drawAnnotations(outDoc, pdfPage, p, fontCache);
      await addFormFields(outDoc, pdfPage, p, groups, fontCache);
    }
    for (let i = all.length - 1; i >= 0; i--) if (!keep.has(i)) outDoc.removePage(i);
    try {
      outDoc.getForm().updateFieldAppearances();
    } catch {}
    outDoc.setProducer('PDF and Moore');
    outDoc.setModificationDate(new Date());
    return { bytes: await outDoc.save(), flattenedForms: false };
  }

  // General path: assemble a new PDF from the pages of every source.
  const outDoc = await PDFDocument.create();
  const libDocs = {};
  const groups = {};
  let flattenedForms = false;
  for (const p of pages) {
    const src = srcById[p.src];
    let pdfPage;
    if (src.encrypted) {
      const jpg = await outDoc.embedJpg(await rasterizeSourcePage(src, p.index));
      // Keep the original page box so annotation coordinates still line up.
      const srcPage = await src.pdf.getPage(p.index + 1);
      const [vx, vy] = srcPage.view;
      pdfPage = outDoc.addPage([p.w, p.h]);
      pdfPage.setMediaBox(vx, vy, p.w, p.h);
      pdfPage.drawImage(jpg, { x: vx, y: vy, width: p.w, height: p.h });
    } else {
      if (!libDocs[src.id]) {
        libDocs[src.id] = await PDFDocument.load(src.bytes, { updateMetadata: false });
        const prepared = doc.prepared && doc.prepared[src.id];
        if (!prepared) {
          applyFormValues(libDocs[src.id], doc.formValues[src.id]);
          try {
            const form = libDocs[src.id].getForm();
            if (form.getFields().length) {
              form.flatten();
              flattenedForms = true;
            }
          } catch {}
        }
      }
      [pdfPage] = await outDoc.copyPages(libDocs[src.id], [p.index]);
      outDoc.addPage(pdfPage);
      if (doc.prepared && doc.prepared[src.id]) stripWidgets(pdfPage);
    }
    pdfPage.setRotation(degrees(totalRotation(p)));
    await drawAnnotations(outDoc, pdfPage, p, fontCache);
    await addFormFields(outDoc, pdfPage, p, groups, fontCache);
  }
  outDoc.setProducer('PDF and Moore');
  outDoc.setCreationDate(new Date());
  outDoc.setModificationDate(new Date());
  return { bytes: await outDoc.save(), flattenedForms };
}

/** Render one page to a canvas at the given scale (used for thumbnails, OCR, export, print). */
export async function renderPageToCanvas(doc, page, scale, canvas = document.createElement('canvas')) {
  const src = doc.sources.find((s) => s.id === page.src);
  const p = await src.pdf.getPage(page.index + 1);
  const vp = p.getViewport({ scale, rotation: totalRotation(page) });
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await p.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS }).promise;
  return { canvas, viewport: vp };
}
