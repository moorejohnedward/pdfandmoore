// Make a complete, good-looking fillable PDF from a short description ("a dive waiver with name,
// date of birth, emergency contact and signature"). The AI (or the built-in reader) writes a simple
// plan (title, sections, fields); this file lays it out on Letter pages and adds real form fields.
import { uid } from './util.js';

const PAGE = [612, 792];
const M = 50; // margin
const GAP = 12; // space between fields in a row

export const DOC_SCHEMA = `{"action":"create_document","title":"Form title","subtitle":"optional line under the title","company":"optional business name for the header","logo":true,"color":"#0b57d0",
 "sections":[{"heading":"Section name","text":"optional paragraph (rules, agreement wording)",
   "fields":[{"label":"Full name","kind":"text|multiline|date|checkbox|yesno|dropdown|radio|signature|initials|email|phone|number","width":"full|half|third","options":["for dropdown/radio"],"lines":3,"required":false}],
   "table":{"columns":["Item","Serial #","Pass"],"rows":5}}],
 "footer":"optional small print at the bottom"}
Use several sections. Put the agreement or instructions as "text". End forms that need it with a section containing signature and date fields.`;

function wrap(font, text, size, width) {
  const out = [];
  for (const para of String(text || '').split(/\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const t = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(t, size) > width && line) {
        out.push(line);
        line = word;
      } else line = t;
    }
    out.push(line);
  }
  return out;
}

function safe(font, s) {
  // Standard fonts only know Western characters; swap the common fancy ones.
  const map = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', '•': '-', '✔': 'x', '☐': '' };
  return String(s ?? '')
    .replace(/[‘’“”–—…•✔☐]/g, (c) => map[c])
    .split('')
    .filter((c) => {
      try {
        font.encodeText(c);
        return true;
      } catch {
        return false;
      }
    })
    .join('');
}

function hex(c, fallback = '#0b57d0') {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c || fallback)) || /^#?([0-9a-f]{6})$/i.exec(fallback);
  const n = parseInt(m[1], 16);
  return window.PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}
function tint(c, amount = 0.88) {
  const { rgb } = window.PDFLib;
  return rgb(c.red + (1 - c.red) * amount, c.green + (1 - c.green) * amount, c.blue + (1 - c.blue) * amount);
}

const WIDTHS = { full: 1, half: 0.5, third: 1 / 3, quarter: 0.25, twothirds: 2 / 3 };

function normKind(k, label = '') {
  k = String(k || '').toLowerCase().replace(/[^a-z]/g, '');
  const l = String(label).toLowerCase();
  if (['text', 'multiline', 'date', 'checkbox', 'yesno', 'dropdown', 'radio', 'signature', 'initials', 'email', 'phone', 'number'].includes(k)) return k;
  if (k === 'textarea' || k === 'paragraph' || k === 'longtext') return 'multiline';
  if (k === 'check' || k === 'tick') return 'checkbox';
  if (k === 'select' || k === 'choice') return 'dropdown';
  if (/signature/.test(l)) return 'signature';
  if (/\bdate\b|birth|dob/.test(l)) return 'date';
  return 'text';
}

/**
 * Lay out a plan. Returns { bytes, fields: [{pageIndex, kind, name, x1,y1,x2,y2, options, onValue, multiline, required}] }.
 */
export async function buildFormDocument(plan, { logoDataUrl = null } = {}) {
  const { PDFDocument, StandardFonts, rgb } = window.PDFLib;
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const accent = hex(plan.color);
  const ink = rgb(0.13, 0.13, 0.13);
  const gray = rgb(0.4, 0.4, 0.42);
  const line = rgb(0.55, 0.55, 0.58);
  const W = PAGE[0] - 2 * M;
  const fields = [];
  const used = new Set();
  const nameOf = (label) => {
    let base = String(label || 'Field').replace(/[.:*]+$/, '').trim() || 'Field';
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base} ${i}`;
    used.add(n);
    return n;
  };

  let page;
  let y;
  let pageIndex = -1;
  const newPage = () => {
    page = pdf.addPage(PAGE);
    pageIndex++;
    y = PAGE[1] - M;
    if (pageIndex > 0) {
      page.drawText(safe(bold, plan.title || ''), { x: M, y: y - 9, size: 9, font: bold, color: gray });
      page.drawLine({ start: { x: M, y: y - 15 }, end: { x: PAGE[0] - M, y: y - 15 }, thickness: 0.5, color: line });
      y -= 30;
    }
  };
  const need = (h) => {
    if (y - h < M + 2) newPage();
  };
  newPage();

  // ---- header: logo, company, title ----
  let logo = null;
  if (plan.logo !== false && logoDataUrl) {
    try {
      const b = Uint8Array.from(atob(logoDataUrl.split(',')[1]), (c) => c.charCodeAt(0));
      logo = logoDataUrl.startsWith('data:image/png') ? await pdf.embedPng(b) : await pdf.embedJpg(b);
    } catch {
      logo = null;
    }
  }
  const headerH = 64;
  let tx = M;
  if (logo) {
    const h = 56;
    const w = Math.min(150, (logo.width / logo.height) * h);
    page.drawImage(logo, { x: M, y: y - h, width: w, height: h });
    tx = M + w + 16;
  }
  const tw = PAGE[0] - M - tx;
  let ty = y - 4;
  if (plan.company) {
    page.drawText(safe(bold, plan.company).toUpperCase(), { x: tx, y: ty - 9, size: 9, font: bold, color: accent });
    ty -= 14;
  }
  let tsize = 20;
  const title = safe(bold, plan.title || 'Form');
  while (bold.widthOfTextAtSize(title, tsize) > tw && tsize > 12) tsize--;
  const tl = wrap(bold, title, tsize, tw);
  for (const t of tl) {
    page.drawText(t, { x: tx, y: ty - tsize, size: tsize, font: bold, color: ink });
    ty -= tsize * 1.15;
  }
  if (plan.subtitle) {
    for (const t of wrap(font, safe(font, plan.subtitle), 10, tw)) {
      page.drawText(t, { x: tx, y: ty - 12, size: 10, font, color: gray });
      ty -= 13;
    }
  }
  y = Math.min(y - headerH, ty - 8);
  page.drawRectangle({ x: M, y: y, width: W, height: 2.5, color: accent });
  y -= 18;

  // ---- sections ----
  const label = (text, x, yy, width, req) => {
    const t = safe(font, text) + (req ? ' *' : '');
    let s = 8.5;
    while (font.widthOfTextAtSize(t, s) > width && s > 6) s -= 0.5;
    page.drawText(t, { x, y: yy, size: s, font, color: gray });
  };
  const addField = (f) => fields.push({ pageIndex, ...f });

  for (const sec of plan.sections || []) {
    if (sec.heading) {
      need(40);
      page.drawRectangle({ x: M, y: y - 18, width: W, height: 20, color: tint(accent) });
      page.drawRectangle({ x: M, y: y - 18, width: 3, height: 20, color: accent });
      page.drawText(safe(bold, sec.heading), { x: M + 10, y: y - 12.5, size: 11, font: bold, color: ink });
      y -= 30;
    }
    if (sec.text) {
      for (const t of wrap(font, safe(font, sec.text), 9.5, W)) {
        need(13);
        page.drawText(t, { x: M, y: y - 9.5, size: 9.5, font, color: ink });
        y -= 12.5;
      }
      y -= 8;
    }
    // Pack fields into rows.
    let row = [];
    let rowW = 0;
    const flush = () => {
      if (!row.length) return;
      const rowH = Math.max(...row.map((r) => r.h));
      need(rowH + 6);
      let x = M;
      for (const r of row) {
        const w = r.frac * W - (row.length > 1 ? (GAP * (row.length - 1)) / row.length : 0);
        r.draw(x, y, w);
        x += w + GAP;
      }
      y -= rowH + 6;
      row = [];
      rowW = 0;
    };
    for (const raw of sec.fields || []) {
      const kind = normKind(raw.kind, raw.label);
      const lbl = raw.label || 'Field';
      const req = !!raw.required;
      let frac = WIDTHS[raw.width] || (['checkbox', 'yesno'].includes(kind) ? 1 / 3 : ['date', 'phone', 'number', 'initials'].includes(kind) ? 1 / 3 : kind === 'signature' ? 2 / 3 : kind === 'multiline' || kind === 'radio' ? 1 : 0.5);
      let h;
      let draw;
      if (kind === 'checkbox') {
        h = 16;
        draw = (x, yy, w) => {
          const b = { x1: x, y1: yy - 13, x2: x + 11, y2: yy - 2 };
          page.drawRectangle({ x: b.x1, y: b.y1, width: 11, height: 11, borderColor: line, borderWidth: 0.8 });
          const t = safe(font, lbl);
          let s = 9.5;
          while (font.widthOfTextAtSize(t, s) > w - 16 && s > 6.5) s -= 0.5;
          page.drawText(t, { x: x + 16, y: yy - 11, size: s, font, color: ink });
          addField({ kind: 'checkbox', name: nameOf(lbl), ...b, border: true, required: req });
        };
      } else if (kind === 'yesno') {
        h = 30;
        frac = WIDTHS[raw.width] || 0.5;
        draw = (x, yy, w) => {
          label(lbl, x, yy - 8, w, req);
          const base = nameOf(lbl);
          ['Yes', 'No'].forEach((opt, i) => {
            const bx = x + i * 52;
            const b = { x1: bx, y1: yy - 27, x2: bx + 11, y2: yy - 16 };
            page.drawRectangle({ x: b.x1, y: b.y1, width: 11, height: 11, borderColor: line, borderWidth: 0.8 });
            page.drawText(opt, { x: bx + 15, y: yy - 25, size: 9.5, font, color: ink });
            addField({ kind: 'checkbox', name: nameOf(`${base} - ${opt}`), ...b, border: true });
          });
        };
      } else if (kind === 'radio') {
        const opts = (raw.options && raw.options.length ? raw.options : ['Option 1', 'Option 2']).map(String);
        h = 30;
        draw = (x, yy, w) => {
          label(lbl, x, yy - 8, w, req);
          const name = nameOf(lbl);
          let bx = x;
          for (const opt of opts) {
            const t = safe(font, opt);
            const tw2 = font.widthOfTextAtSize(t, 9.5);
            if (bx + 15 + tw2 > x + w) break;
            const b = { x1: bx, y1: yy - 27, x2: bx + 11, y2: yy - 16 };
            page.drawCircle({ x: bx + 5.5, y: yy - 21.5, size: 5.5, borderColor: line, borderWidth: 0.8 });
            page.drawText(t, { x: bx + 15, y: yy - 25, size: 9.5, font, color: ink });
            addField({ kind: 'radio', name, onValue: opt, ...b, border: true });
            bx += 15 + tw2 + 16;
          }
        };
      } else if (kind === 'multiline') {
        const lines = Math.max(2, Math.min(12, Number(raw.lines) || 3));
        h = 12 + lines * 15;
        draw = (x, yy, w) => {
          label(lbl, x, yy - 8, w, req);
          const top = yy - 11;
          const bh = lines * 15;
          page.drawRectangle({ x, y: top - bh, width: w, height: bh, borderColor: line, borderWidth: 0.7 });
          addField({ kind: 'text', name: nameOf(lbl), x1: x + 1, y1: top - bh + 1, x2: x + w - 1, y2: top - 1, multiline: true, required: req });
        };
      } else if (kind === 'signature' || kind === 'initials') {
        h = 44;
        if (kind === 'initials') frac = WIDTHS[raw.width] || 1 / 4;
        draw = (x, yy, w) => {
          const by = yy - 34;
          page.drawLine({ start: { x, y: by }, end: { x: x + w, y: by }, thickness: 0.8, color: ink });
          if (kind === 'signature') page.drawText('X', { x: x + 2, y: by + 4, size: 12, font: bold, color: gray });
          label(lbl, x, by - 10, w, req);
          addField({ kind: 'signature', name: nameOf(lbl), x1: x + 14, y1: by + 1, x2: x + w, y2: by + 30, border: false, required: req });
        };
      } else {
        // text, date, email, phone, number, dropdown: label above an underlined box
        h = 34;
        draw = (x, yy, w) => {
          label(lbl, x, yy - 8, w, req);
          const by = yy - 30;
          page.drawLine({ start: { x, y: by }, end: { x: x + w, y: by }, thickness: 0.7, color: line });
          const box = { x1: x, y1: by + 1, x2: x + w, y2: by + 18 };
          if (kind === 'dropdown') {
            page.drawRectangle({ x, y: by, width: w, height: 18, borderColor: line, borderWidth: 0.7 });
            page.drawSvgPath('M 0 0 L 7 0 L 3.5 4.5 Z', { x: x + w - 12, y: by + 11, color: gray });
            addField({ kind: 'dropdown', name: nameOf(lbl), ...box, options: (raw.options || ['Option 1', 'Option 2']).map(String), border: false, required: req });
          } else if (kind === 'date') {
            addField({ kind: 'date', name: nameOf(lbl), ...box, required: req });
          } else addField({ kind: 'text', name: nameOf(lbl), ...box, required: req });
        };
      }
      if (rowW + frac > 1.001) flush();
      row.push({ frac, h, draw });
      rowW += frac;
    }
    flush();
    // Table: header + rows of cells, each a field.
    if (sec.table && Array.isArray(sec.table.columns) && sec.table.columns.length) {
      const cols = sec.table.columns.map(String).slice(0, 8);
      const rows = Math.max(1, Math.min(40, Number(sec.table.rows) || 5));
      const cw = W / cols.length;
      const header = () => {
        page.drawRectangle({ x: M, y: y - 18, width: W, height: 18, color: tint(accent, 0.8) });
        cols.forEach((c, i) => {
          const t = safe(bold, c);
          let s = 8.5;
          while (bold.widthOfTextAtSize(t, s) > cw - 6 && s > 6) s -= 0.5;
          page.drawText(t, { x: M + i * cw + 4, y: y - 12.5, size: s, font: bold, color: ink });
        });
        y -= 18;
      };
      need(40);
      header();
      for (let r = 1; r <= rows; r++) {
        if (y - 20 < M + 24) {
          newPage();
          header();
        }
        cols.forEach((c, i) => {
          const x = M + i * cw;
          page.drawRectangle({ x, y: y - 20, width: cw, height: 20, borderColor: line, borderWidth: 0.5 });
          const isCheck = c.trim().length <= 14 && /^(?:[\w#]+\s+)?(pass|fail|ok|done|yes|no|x|✓|checked|complete|returned|in|out)(?:\s+[\w]+)?$|\bok\b|^(pass|fail)/i.test(c.trim()) && !/date|serial|#|name|size|qty|amount|price|notes?/i.test(c);
          if (isCheck) addField({ kind: 'checkbox', name: nameOf(`${c} ${r}`), x1: x + cw / 2 - 5.5, y1: y - 15.5, x2: x + cw / 2 + 5.5, y2: y - 4.5, border: true });
          else addField({ kind: /date/i.test(c) ? 'date' : 'text', name: nameOf(`${c} ${r}`), x1: x + 2, y1: y - 19, x2: x + cw - 2, y2: y - 1 });
        });
        y -= 20;
      }
      y -= 12;
    }
    y -= 6;
  }

  // ---- footer on every page ----
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawLine({ start: { x: M, y: M - 2 }, end: { x: PAGE[0] - M, y: M - 2 }, thickness: 0.5, color: line });
    if (plan.footer) {
      const t = wrap(font, safe(font, plan.footer), 7.5, W - 70)[0];
      p.drawText(t, { x: M, y: M - 13, size: 7.5, font, color: gray });
    }
    const pn = `Page ${i + 1} of ${pages.length}`;
    p.drawText(pn, { x: PAGE[0] - M - font.widthOfTextAtSize(pn, 7.5), y: M - 13, size: 7.5, font, color: gray });
  });
  pdf.setTitle(plan.title || 'Form');
  pdf.setProducer('PDF and Moore');
  pdf.setCreator('PDF and Moore');
  return { bytes: await pdf.save(), fields };
}

/** Turn the laid-out fields into the editor's field items (editable in Forms › Edit fields). */
export function fieldAnnots(fields) {
  return fields.map((f) => ({
    id: uid(),
    type: 'field',
    kind: f.kind,
    name: f.name,
    x1: f.x1,
    y1: f.y1,
    x2: f.x2,
    y2: f.y2,
    value: f.kind === 'checkbox' || f.kind === 'radio' ? false : '',
    onValue: f.onValue || null,
    options: f.options || [],
    multiline: !!f.multiline,
    required: !!f.required,
    border: !!f.border,
    rot: 0,
    ai: true,
  }));
}

// ---------------------------------------------------------------------------
// Without an AI: ready-made plans and "a form with A, B and C".
// ---------------------------------------------------------------------------
const AGREE = 'I have read and understand this document. By signing below I agree to its terms.';

export const TEMPLATES = [
  {
    match: /waiver|release|liability|consent/i,
    plan: (title) => ({
      title: title || 'Release of Liability and Assumption of Risk',
      sections: [
        { heading: 'Participant', fields: [{ label: 'Full name', width: 'half', required: true }, { label: 'Date of birth', kind: 'date', width: 'quarter' }, { label: 'Phone', kind: 'phone', width: 'quarter' }, { label: 'Address', width: 'full' }, { label: 'Email', kind: 'email', width: 'half' }, { label: 'Activity / course', width: 'half' }] },
        { heading: 'Emergency contact', fields: [{ label: 'Emergency contact name', width: 'half' }, { label: 'Relationship', width: 'quarter' }, { label: 'Emergency phone', kind: 'phone', width: 'quarter' }] },
        { heading: 'Health', fields: [{ label: 'Do you have any medical conditions we should know about?', kind: 'yesno', width: 'full' }, { label: 'If yes, please explain', kind: 'multiline', lines: 2 }] },
        {
          heading: 'Agreement',
          text: 'I understand that this activity involves inherent risks, including serious injury. I voluntarily assume all risks and release the business, its owners, staff and agents from liability for any injury, loss or damage, to the fullest extent allowed by law. ' + AGREE,
          fields: [{ label: 'I have read and agree to this release', kind: 'checkbox', width: 'full' }, { label: 'Participant signature', kind: 'signature' }, { label: 'Date', kind: 'date' }, { label: 'Parent/guardian signature (if under 18)', kind: 'signature' }, { label: 'Date', kind: 'date' }],
        },
      ],
    }),
  },
  {
    match: /inspection|equipment|test (sheet|log)|checklist|service/i,
    plan: (title) => ({
      title: title || 'Equipment Inspection Checklist',
      sections: [
        { heading: 'Customer and equipment', fields: [{ label: 'Customer name', width: 'half' }, { label: 'Phone', kind: 'phone', width: 'quarter' }, { label: 'Date received', kind: 'date', width: 'quarter' }, { label: 'Make / model', width: 'half' }, { label: 'Serial number', width: 'half' }] },
        { heading: 'Inspection', table: { columns: ['Item', 'Condition / reading', 'Pass', 'Fail'], rows: 8 } },
        { heading: 'Result', fields: [{ label: 'Result', kind: 'radio', options: ['Pass', 'Fail', 'Needs service'] }, { label: 'Notes', kind: 'multiline', lines: 3 }, { label: 'Technician signature', kind: 'signature' }, { label: 'Date', kind: 'date' }] },
      ],
    }),
  },
  {
    match: /sign[- ]?in|sign[- ]?up|attendance|roster/i,
    plan: (title) => ({ title: title || 'Sign-in Sheet', sections: [{ fields: [{ label: 'Event', width: 'half' }, { label: 'Date', kind: 'date', width: 'quarter' }, { label: 'Location', width: 'quarter' }], table: { columns: ['Name', 'Phone', 'Email', 'Time in', 'Initials'], rows: 20 } }] }),
  },
  {
    match: /invoice|bill|receipt|quote|estimate/i,
    plan: (title) => ({
      title: title || 'Invoice',
      sections: [
        { heading: 'Bill to', fields: [{ label: 'Customer name', width: 'half' }, { label: 'Invoice #', width: 'quarter' }, { label: 'Date', kind: 'date', width: 'quarter' }, { label: 'Address', width: 'full' }, { label: 'Phone', kind: 'phone', width: 'half' }, { label: 'Email', kind: 'email', width: 'half' }] },
        { heading: 'Items', table: { columns: ['Description', 'Qty', 'Unit price', 'Amount'], rows: 10 } },
        { heading: 'Totals', fields: [{ label: 'Subtotal', width: 'third' }, { label: 'Tax', width: 'third' }, { label: 'Total due', width: 'third' }, { label: 'Payment method', kind: 'dropdown', options: ['Cash', 'Card', 'Check', 'Venmo', 'Other'], width: 'half' }, { label: 'Notes', kind: 'multiline', lines: 2 }] },
      ],
    }),
  },
  {
    match: /registration|intake|application|enrollment|enrolment|sign up|new (customer|student|client)/i,
    plan: (title) => ({
      title: title || 'Registration Form',
      sections: [
        { heading: 'Your information', fields: [{ label: 'First name', width: 'half', required: true }, { label: 'Last name', width: 'half', required: true }, { label: 'Date of birth', kind: 'date', width: 'third' }, { label: 'Phone', kind: 'phone', width: 'third' }, { label: 'Email', kind: 'email', width: 'third' }, { label: 'Address', width: 'full' }] },
        { heading: 'Emergency contact', fields: [{ label: 'Name', width: 'half' }, { label: 'Phone', kind: 'phone', width: 'half' }] },
        { heading: 'Details', fields: [{ label: 'How did you hear about us?', kind: 'dropdown', options: ['Friend', 'Google', 'Social media', 'Walk-in', 'Other'], width: 'half' }, { label: 'Comments', kind: 'multiline', lines: 3 }] },
        { heading: 'Signature', text: AGREE, fields: [{ label: 'Signature', kind: 'signature' }, { label: 'Date', kind: 'date' }] },
      ],
    }),
  },
];

function titleCase(s) {
  return s.replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

/** Guess a field type from its label. */
export function guessField(label) {
  const l = label.toLowerCase();
  if (/signature|sign here|signed/.test(l)) return { label: titleCase(label), kind: 'signature' };
  if (/initials?/.test(l)) return { label: titleCase(label), kind: 'initials' };
  if (/\bdate\b|birth|dob|expir|due/.test(l)) return { label: titleCase(label), kind: 'date', width: 'third' };
  if (/phone|cell|mobile|fax/.test(l)) return { label: titleCase(label), kind: 'phone', width: 'third' };
  if (/e-?mail/.test(l)) return { label: titleCase(label), kind: 'email', width: 'half' };
  if (/address/.test(l)) return { label: titleCase(label), width: 'full' };
  if (/notes?|comments?|describe|explain|details|description|history|reason/.test(l)) return { label: titleCase(label), kind: 'multiline', lines: 3 };
  if (/^(do|does|did|are|is|have|has|can|will|would)\b|\?$|yes ?\/ ?no/.test(l)) {
    const q = label.replace(/\s*\(?yes ?\/ ?no\)?/i, '');
    return { label: q.charAt(0).toUpperCase() + q.slice(1), kind: 'yesno', width: 'full' };
  }
  if (/checkbox|agree|i accept|i understand/.test(l)) return { label: label.replace(/\s*checkbox/i, ''), kind: 'checkbox', width: 'full' };
  return { label: titleCase(label), width: /name/.test(l) ? 'half' : 'half' };
}

/**
 * Read requests like "make a fillable scuba waiver form" or
 * "create a form called Gear Rental with name, phone, gear, deposit and signature".
 * Returns a plan or null.
 */
export function planFromText(text) {
  const s = text.trim();
  if (!/^(?:please\s+)?(?:create|make|build|design|draft|generate|start|give me|i need)\b.*\b(?:form|document|sheet|waiver|checklist|invoice|release|application|log|survey|questionnaire|agreement|contract|pdf)\b/i.test(s)) return null;
  let title = null;
  const called = s.match(/\b(?:called|named|titled)\s+["“']?([^"”',]+?)["”']?(?=\s+(?:with|that|for|including)\b|[,.]|$)/i);
  if (called) title = titleCase(called[1].trim());
  const listM = s.match(/\b(?:with|including|that (?:has|asks for|collects)|fields?(?: for)?:?)\s+(.+)$/i);
  let fields = [];
  if (listM) {
    fields = listM[1]
      .replace(/\.$/, '')
      .split(/\s*,\s*|\s+and\s+|\s*;\s*/i)
      .map((x) => x.replace(/^(?:a|an|the|their|his|her|fields? for)\s+/i, '').replace(/\s+fields?$/i, '').trim())
      .filter((x) => x && x.length < 80);
  }
  if (!title) {
    const t = s.match(/\b(?:a|an|the)\s+(?:new\s+)?(?:simple\s+|fillable\s+|blank\s+|printable\s+|professional\s+)*(.+?)\s*(?:\bform\b|\bsheet\b|\bdocument\b|\bpdf\b|(?=\s+(?:with|for|that|including)\b)|$)/i);
    if (t) {
      title = titleCase(t[1].replace(/\b(fillable|form|pdf)\b/gi, '').trim());
      if (/\b(form)\b/i.test(s) && !/form$/i.test(title) && !/waiver|checklist|invoice|log|sheet|agreement|application|survey/i.test(title)) title += ' Form';
    }
  }
  const forWho = s.match(/\bfor\s+(?:my\s+)?(?:business\s+)?([A-Z][\w&' ]{2,40})(?=\s+(?:with|that|including)\b|[,.]|$)/);
  if (fields.length) {
    const guessed = fields.map(guessField);
    const sigs = guessed.filter((f) => f.kind === 'signature' || f.kind === 'initials' || (f.kind === 'date' && /^date$/i.test(f.label)));
    const rest = guessed.filter((f) => !sigs.includes(f));
    const sections = [{ heading: 'Information', fields: rest }];
    if (sigs.length) sections.push({ heading: 'Signature', text: AGREE, fields: sigs });
    return { title: title || 'Form', company: forWho ? forWho[1].trim() : undefined, sections, source: 'list' };
  }
  const tpl = TEMPLATES.find((t) => t.match.test(s));
  if (tpl) {
    const plan = tpl.plan(title && !/^(Fillable|New|Blank)?\s*Form$/i.test(title) ? title : null);
    if (forWho) plan.company = forWho[1].trim();
    plan.source = 'template';
    return plan;
  }
  return null;
}
