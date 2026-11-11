// Protect: true redaction, password locking, hidden-info cleanup and certificate (digital ID) signatures.
import * as host from './host.js';
import { state, on, emit, checkpoint, changed } from './state.js';
import { loadSource, buildPdf, totalRotation, pdfjsLib, rightVec, downVec, boxInView } from './doc.js';
import { findText, pageLines, rangeBox, clearTextCache, charFractions } from './commands.js';
import { setTool, pickRegion } from './viewer.js';
import { el, icon, toast, busy, busyProgress, dialog, confirmDialog, uid, baseName } from './util.js';

const SECURE_LIB = '../lib/pdf-lib-secure/pdf-lib.esm.min.js';
const REDACT_SCALE = 2.5; // 180 dpi: sharp enough to read and print
const SIG_BYTES = 16384; // room for the signature and its certificate chain

// ===========================================================================
// Redaction
// ===========================================================================

export function pendingRedactions() {
  if (!state.doc) return 0;
  return state.doc.pages.reduce((n, p) => n + p.annots.filter((a) => a.type === 'redact').length, 0);
}

export function startRedactTool() {
  setTool('redact');
  toast('Drag a box over anything you want removed. Then click Apply redactions.', { ms: 5000 });
}

const PATTERNS = [
  { id: 'ssn', label: 'Social Security numbers', re: /\b\d{3}[- ]\d{2}[- ]\d{4}\b/g },
  { id: 'phone', label: 'Phone numbers', re: /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g },
  { id: 'email', label: 'Email addresses', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  { id: 'card', label: 'Card and account numbers', re: /\b(?:\d[ -]?){12,18}\d\b/g },
  {
    id: 'date',
    label: 'Dates (like birthdays)',
    re: /\b(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4})\b/gi,
  },
];

/** A little extra around found text so no sliver of a letter is left showing. */
function pad(box) {
  const h = box.h || Math.abs(box.y2 - box.y1) || 10;
  const sx = box.dir && Math.abs(box.dir[1]) > 0.5 ? 1 : h * 0.18;
  const sy = box.dir && Math.abs(box.dir[1]) > 0.5 ? h * 0.18 : 1;
  return { x1: box.x1 - sx, y1: box.y1 - sy, x2: box.x2 + sx, y2: box.y2 + sy };
}

/** Mark every match of a pattern for redaction. Returns how many were marked. */
async function markPattern(re, pages) {
  let n = 0;
  for (const page of pages) {
    const lines = await pageLines(page);
    for (const l of lines) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(l.text))) {
        if (!m[0].trim()) continue;
        const box = rangeBox(l, m.index, m.index + m[0].length - 1);
        if (box) {
          page.annots.push({ id: uid(), type: 'redact', ...pad(box), text: m[0] });
          n++;
        }
      }
    }
  }
  return n;
}

/** Mark words, phrases or kinds of information (e.g. "SSN") for redaction. Used by the dialog and the command bar. */
export async function markForRedaction({ words = [], patterns = [], pageNos = null } = {}) {
  if (!state.doc) return 0;
  checkpoint();
  const pages = pageNos ? pageNos.map((n) => state.doc.pages[n - 1]).filter(Boolean) : state.doc.pages;
  let n = 0;
  for (const w of words.map((x) => x.trim()).filter(Boolean)) {
    const hits = await findText(w, pageNos);
    for (const h of hits) {
      h.page.annots.push({ id: uid(), type: 'redact', ...pad(h), text: h.text });
      n++;
    }
  }
  for (const id of patterns) {
    const p = PATTERNS.find((x) => x.id === id);
    if (p) n += await markPattern(new RegExp(p.re.source, p.re.flags), pages);
  }
  changed();
  return n;
}

export async function findAndRedactDialog() {
  if (!state.doc) return;
  const words = el('input', { class: 'field', placeholder: 'e.g. John Smith, 82-5931 Wakida Dr' });
  const boxes = PATTERNS.map((p) => {
    const cb = el('input', { type: 'checkbox', value: p.id });
    return { cb, row: el('label', { class: 'check-row' }, cb, p.label) };
  });
  const body = el(
    'div',
    {},
    el('p', {}, 'Everything found gets a red box so you can check it first. Nothing is removed until you click Apply redactions.'),
    el('label', { class: 'field-label' }, 'Words or phrases (separate with commas)', words),
    el('div', { class: 'field-label' }, 'Also find'),
    el('div', { class: 'check-list' }, boxes.map((b) => b.row))
  );
  const ok = await dialog({
    title: 'Find and redact',
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Mark them', value: true, primary: true },
    ],
  });
  if (!ok) return;
  const n = await markForRedaction({
    words: words.value.split(','),
    patterns: boxes.filter((b) => b.cb.checked).map((b) => b.cb.value),
  });
  toast(n ? `Marked ${n} place${n === 1 ? '' : 's'} with red boxes. Check them, then click Apply redactions.` : 'Nothing like that was found.', { ms: 6000 });
}

function annotBox(a) {
  if ('x1' in a) return { x1: Math.min(a.x1, a.x2), y1: Math.min(a.y1, a.y2), x2: Math.max(a.x1, a.x2), y2: Math.max(a.y1, a.y2) };
  const pts = [];
  if (a.rects) a.rects.forEach((r) => pts.push([r[0], r[1]], [r[2], r[3]]));
  if (a.pts) pts.push(...a.pts);
  if (a.type === 'text') {
    const R = rightVec(a.rot || 0);
    const D = downVec(a.rot || 0);
    const size = a.size || 12;
    const lines = String(a.text || '').split('\n');
    const w = Math.max(a.w || 0, a.minW || 0, ...lines.map((l) => l.length * size * 0.55));
    const h = lines.length * size * 1.2 + 2;
    pts.push([a.x, a.y], [a.x + R[0] * w, a.y + R[1] * w], [a.x + D[0] * h, a.y + D[1] * h], [a.x + R[0] * w + D[0] * h, a.y + R[1] * w + D[1] * h]);
  } else if (a.type === 'note') pts.push([a.x, a.y - 20], [a.x + 20, a.y]);
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
}

const overlaps = (a, b) => a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;

/** Split pdf.js text items into words with PDF-space boxes. */
function wordsOf(items) {
  const out = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, , , e, f] = it.transform;
    const len = Math.hypot(a, b) || 1;
    const dir = [a / len, b / len];
    const up = [-dir[1], dir[0]];
    const h = it.height || len;
    const W = it.width || 0;
    const cum = charFractions(it.str, /mono/i.test(it.fontFamily || ''));
    const re = /\S+/g;
    let m;
    while ((m = re.exec(it.str))) {
      const off = W * cum[m.index];
      const s = [e + dir[0] * off, f + dir[1] * off];
      const wlen = W * (cum[m.index + m[0].length] - cum[m.index]);
      const t = [s[0] + dir[0] * wlen, s[1] + dir[1] * wlen];
      const pts = [
        [s[0] - up[0] * h * 0.25, s[1] - up[1] * h * 0.25],
        [t[0] - up[0] * h * 0.25, t[1] - up[1] * h * 0.25],
        [s[0] + up[0] * h, s[1] + up[1] * h],
        [t[0] + up[0] * h, t[1] + up[1] * h],
      ];
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      out.push({
        word: { text: m[0], x: s[0], y: s[1], width: wlen, height: h, angle: (Math.atan2(dir[1], dir[0]) * 180) / Math.PI },
        box: { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) },
      });
    }
  }
  return out;
}

/**
 * Permanently remove everything under the red boxes.
 * Each affected page is rebuilt as a picture with black boxes burned in, so the hidden text,
 * images and drawings are really gone. The rest of the page's text is kept as invisible,
 * searchable text, and your comments and shapes elsewhere on the page stay editable.
 */
export async function applyRedactions({ ask = true } = {}) {
  if (!state.doc) return 0;
  const pages = state.doc.pages.filter((p) => p.annots.some((a) => a.type === 'redact'));
  if (!pages.length) {
    toast('Nothing is marked yet. Use Mark area or Find and redact first.');
    return 0;
  }
  if (ask) {
    const ok = await confirmDialog(
      'Apply redactions?',
      `The ${pendingRedactions()} red box${pendingRedactions() === 1 ? '' : 'es'} on ${pages.length} page${pages.length === 1 ? '' : 's'} will become solid black and everything under them will be permanently removed when you save. ` +
        'Those pages become flat pictures (their text stays searchable and form fields on them are filled in permanently). Hidden information like the author and keywords is removed too.',
      'Apply redactions'
    );
    if (!ok) return 0;
  }
  busy('Redacting…');
  try {
    checkpoint();
    // 1. Make a PDF of just these pages, unrotated, with form fields filled in (but not our comments/shapes).
    const clones = pages.map((p) => ({ ...p, rotate: -p.baseRotate, annots: p.annots.filter((a) => a.type === 'field') }));
    const { bytes } = await buildPdf({ ...state.doc, pages: clones });
    const tmp = await loadSource(bytes, 'pages to redact');
    const out = await window.PDFLib.PDFDocument.create();

    for (let i = 0; i < pages.length; i++) {
      busyProgress(i / pages.length, `Redacting page ${state.doc.pages.indexOf(pages[i]) + 1}…`);
      const page = pages[i];
      const boxes = page.annots.filter((a) => a.type === 'redact').map(annotBox);
      const p = await tmp.pdf.getPage(i + 1);
      const vp = p.getViewport({ scale: REDACT_SCALE, rotation: 0 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, canvas.width, canvas.height);
      await p.render({ canvasContext: g, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
      g.fillStyle = '#000';
      for (const b of boxes) {
        const c1 = vp.convertToViewportPoint(b.x1, b.y1);
        const c2 = vp.convertToViewportPoint(b.x2, b.y2);
        g.fillRect(Math.min(c1[0], c2[0]), Math.min(c1[1], c2[1]), Math.abs(c2[0] - c1[0]), Math.abs(c2[1] - c1[1]));
      }
      // Text outside the boxes stays searchable.
      const content = await p.getTextContent();
      for (const it of content.items) it.fontFamily = (content.styles[it.fontName] || {}).fontFamily;
      const kept = wordsOf(content.items)
        .filter((w) => !boxes.some((b) => overlaps(w.box, b)))
        .map((w) => w.word);
      for (const o of page.annots.filter((a) => a.type === 'ocrtext')) {
        for (const w of o.words) {
          const b = { x1: w.x, y1: w.y - w.height * 0.2, x2: w.x + w.width, y2: w.y + w.height };
          if (!boxes.some((r) => overlaps(b, r))) kept.push(w);
        }
      }
      const jpg = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
      const img = await out.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
      const [vx, vy, vx2, vy2] = p.view;
      const np = out.addPage([vx2 - vx, vy2 - vy]);
      np.setMediaBox(vx, vy, vx2 - vx, vy2 - vy);
      np.drawImage(img, { x: vx, y: vy, width: vx2 - vx, height: vy2 - vy });
      page._redactWords = kept;
    }
    out.setProducer('PDF and Moore');
    const source = await loadSource(await out.save(), 'redacted pages');
    state.doc.sources.push(source);

    pages.forEach((page, i) => {
      const boxes = page.annots.filter((a) => a.type === 'redact').map(annotBox);
      const rot = totalRotation(page);
      page.src = source.id;
      page.index = i;
      page.baseRotate = 0;
      page.rotate = rot;
      page.annots = page.annots.filter((a) => {
        if (a.type === 'redact' || a.type === 'field' || a.type === 'ocrtext') return false;
        const b = annotBox(a);
        return !b || !boxes.some((r) => overlaps(b, r));
      });
      if (page._redactWords.length) page.annots.push({ id: uid(), type: 'ocrtext', words: page._redactWords });
      delete page._redactWords;
    });
    state.doc.redacted = true;
    if (state.tool === 'redact') setTool('select');
    clearTextCache();
    changed({ structure: true });
    toast(`Redacted ${pages.length} page${pages.length === 1 ? '' : 's'}. Save to make it permanent in the file.`, { ms: 6000 });
    return pages.length;
  } catch (e) {
    toast('Could not redact: ' + e.message, { error: true, ms: 7000 });
    console.error(e);
    return 0;
  } finally {
    busy(false);
  }
}

// ===========================================================================
// Hidden information
// ===========================================================================

export async function removeHiddenInfoDialog() {
  if (!state.doc) return;
  const ok = await confirmDialog(
    'Remove hidden information',
    'When you save, this removes the title, author, subject, keywords and other details stored inside the file, plus attached files, bookmarks and scripts. What you see on the pages does not change.',
    'Remove when I save'
  );
  if (!ok) return;
  state.doc.scrub = true;
  changed();
  toast('Hidden information will be removed when you save.');
}

/** Remove metadata, attachments, scripts and bookmarks (used after redacting, or on request). */
async function scrub(bytes) {
  const { PDFDocument, PDFName } = window.PDFLib;
  const d = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const key of ['Metadata', 'Names', 'OpenAction', 'AA', 'Outlines', 'PieceInfo', 'StructTreeRoot', 'MarkInfo']) d.catalog.delete(PDFName.of(key));
  d.setTitle('');
  d.setAuthor('');
  d.setSubject('');
  d.setKeywords([]);
  d.setCreator('PDF and Moore');
  d.setProducer('PDF and Moore');
  const info = d.getInfoDict();
  for (const k of info.keys()) {
    const name = k.asString().slice(1);
    if (!['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate'].includes(name)) info.delete(k);
  }
  return d.save();
}

// ===========================================================================
// Password protection
// ===========================================================================

const DEFAULT_PERMS = { printing: true, copying: true, forms: true, editing: false };

export function isLocked() {
  return !!(state.doc && state.doc.protection);
}

export async function passwordDialog() {
  if (!state.doc) return;
  const cur = state.doc.protection || {};
  const pw = el('input', { class: 'field', type: 'password', autocomplete: 'new-password', value: cur.userPassword || '' });
  const pw2 = el('input', { class: 'field', type: 'password', autocomplete: 'new-password', value: cur.userPassword || '' });
  const perms = { ...DEFAULT_PERMS, ...(cur.perms || {}) };
  const mk = (key, label) => {
    const cb = el('input', { type: 'checkbox', checked: perms[key] });
    return { key, cb, row: el('label', { class: 'check-row' }, cb, label) };
  };
  const opts = [mk('printing', 'Allow printing'), mk('copying', 'Allow copying text and pictures'), mk('forms', 'Allow filling in forms and signing'), mk('editing', 'Allow other changes (editing, comments, pages)')];
  const err = el('div', { class: 'field-error' });
  const body = el(
    'div',
    {},
    el('p', {}, 'Anyone opening the saved file must type this password. Write it down: if it is lost, the file cannot be opened.'),
    el('label', { class: 'field-label' }, 'Password', pw),
    el('label', { class: 'field-label' }, 'Type it again', pw2),
    el('div', { class: 'field-label' }, 'After opening it, people can:'),
    el('div', { class: 'check-list' }, opts.map((o) => o.row)),
    err
  );
  const buttons = [{ label: 'Cancel', value: null }];
  if (cur.userPassword) buttons.push({ label: 'Remove password', value: 'remove' });
  buttons.push({ label: 'Lock', value: 'lock', primary: true });
  for (;;) {
    const r = await dialog({ title: 'Lock with a password', body, buttons });
    if (!r) return;
    if (r === 'remove') {
      state.doc.protection = null;
      changed();
      emit('protection');
      toast('The password will be removed when you save.');
      return;
    }
    if (pw.value.length < 4) err.textContent = 'Use at least 4 characters.';
    else if (pw.value !== pw2.value) err.textContent = 'The two passwords are different.';
    else break;
  }
  setProtection(pw.value, Object.fromEntries(opts.map((o) => [o.key, o.cb.checked])));
  toast('Locked. The password is added when you save.', { ms: 5000 });
}

/** Set (or clear, with no password) the password used when saving. */
export function setProtection(userPassword, perms = DEFAULT_PERMS) {
  if (!state.doc) return;
  state.doc.protection = userPassword ? { userPassword, perms: { ...DEFAULT_PERMS, ...perms } } : null;
  changed();
  emit('protection');
}

function randomPassword() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a));
}

async function encrypt(bytes, prot) {
  const secure = await import(SECURE_LIB);
  const d = await secure.PDFDocument.load(bytes, { updateMetadata: false });
  const p = prot.perms || DEFAULT_PERMS;
  const restricted = !p.printing || !p.copying || !p.forms || !p.editing;
  d.encrypt({
    userPassword: prot.userPassword,
    // With no limits the owner password is the same; with limits it is random so they can't be lifted.
    ownerPassword: restricted ? randomPassword() : prot.userPassword,
    permissions: {
      printing: p.printing ? 'highResolution' : false,
      copying: !!p.copying,
      contentAccessibility: true,
      modifying: !!p.editing,
      annotating: !!p.editing,
      fillingForms: !!(p.forms || p.editing),
      documentAssembly: !!p.editing,
    },
  });
  return d.save();
}

/** Last steps before writing the file: remove hidden info and add the password if asked. */
export async function finalizeBytes(bytes, { lock = true } = {}) {
  if (state.doc.redacted || state.doc.scrub) bytes = await scrub(bytes);
  if (lock && state.doc.protection) bytes = await encrypt(bytes, state.doc.protection);
  return bytes;
}

/** Called before saving. Returns false to stop the save. */
export async function beforeSave() {
  const n = pendingRedactions();
  if (n) {
    const r = await dialog({
      title: 'Apply redactions first?',
      body: `There ${n === 1 ? 'is 1 area' : `are ${n} areas`} marked for redaction (red boxes). They are not removed until you apply them.`,
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Save without applying', value: 'skip' },
        { label: 'Apply and save', value: 'apply', primary: true },
      ],
    });
    if (!r) return false;
    if (r === 'apply' && !(await applyRedactions({ ask: false }))) return false;
  }
  return true;
}

// ===========================================================================
// Digital ID (certificate) signatures
// ===========================================================================

function idLabel(id) {
  const parts = [id.name];
  if (id.email) parts.push(id.email);
  parts.push(id.selfSigned ? 'your own ID' : 'issued by ' + id.issuer);
  parts.push('expires ' + new Date(id.expires).toLocaleDateString());
  return parts.join(' · ');
}

async function createIdDialog() {
  const name = el('input', { class: 'field', placeholder: 'Your full name' });
  const email = el('input', { class: 'field', type: 'email', placeholder: 'you@example.com' });
  const org = el('input', { class: 'field', placeholder: 'Business name (optional)' });
  const err = el('div', { class: 'field-error' });
  const body = el(
    'div',
    {},
    el(
      'p',
      {},
      'This makes a digital ID on this computer, like Acrobat\'s "self-signed" ID. PDFs you sign with it show your name and a check that nothing changed after signing. ' +
        'People who need an officially verified ID (some government forms) get one from a certificate company, then add it with Import.'
    ),
    el('label', { class: 'field-label' }, 'Name', name),
    el('label', { class: 'field-label' }, 'Email', email),
    el('label', { class: 'field-label' }, 'Business', org),
    err
  );
  for (;;) {
    const r = await dialog({ title: 'Create a digital ID', body, buttons: [{ label: 'Cancel', value: null }, { label: 'Create', value: true, primary: true }] });
    if (!r) return null;
    if (!name.value.trim()) {
      err.textContent = 'Enter your name.';
      continue;
    }
    try {
      busy('Creating your digital ID…');
      return await host.createDigitalId({ name: name.value.trim(), email: email.value.trim(), org: org.value.trim() });
    } catch (e) {
      err.textContent = e.message;
    } finally {
      busy(false);
    }
  }
}

async function askPassword(title, text) {
  const pw = el('input', { class: 'field', type: 'password', autocomplete: 'off' });
  const r = await dialog({ title, body: el('div', {}, el('p', {}, text), el('label', { class: 'field-label' }, 'Password', pw)), buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: () => pw.value, primary: true }] });
  return r === null ? null : r;
}

/** Pick (or make) the digital ID to sign with. Returns the ID or null. */
async function chooseId() {
  for (;;) {
    let ids = [];
    try {
      ids = await host.listDigitalIds();
    } catch (e) {
      toast(e.message, { error: true });
    }
    if (!ids.length) {
      const r = await dialog({
        title: 'Sign with a digital ID',
        body: 'You don\'t have a digital ID yet. Create one in a few seconds, or import one you got from your company or a certificate provider (.pfx or .p12 file).',
        buttons: [
          { label: 'Cancel', value: null },
          { label: 'Import a file', value: 'import' },
          { label: 'Create my ID', value: 'create', primary: true },
        ],
      });
      if (!r) return null;
      if (r === 'create') {
        const id = await createIdDialog();
        if (id) return id;
        continue;
      }
      const pw = await askPassword('Import a digital ID', 'Enter the password that protects the .pfx or .p12 file.');
      if (pw === null) continue;
      try {
        const id = await host.importDigitalId(pw);
        if (id) return id;
      } catch (e) {
        toast('Could not import: ' + e.message, { error: true, ms: 7000 });
      }
      continue;
    }
    const sel = el('select', { class: 'field' }, ids.map((id) => el('option', { value: id.thumbprint }, idLabel(id))));
    const r = await dialog({
      title: 'Sign with a digital ID',
      body: el('div', {}, el('label', { class: 'field-label' }, 'Digital ID', sel)),
      width: '560px',
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'New ID', value: 'create' },
        { label: 'Back up ID', value: 'backup' },
        { label: 'Use this ID', value: 'use', primary: true },
      ],
    });
    if (!r) return null;
    if (r === 'use') return ids.find((x) => x.thumbprint === sel.value);
    if (r === 'create') {
      const id = await createIdDialog();
      if (id) return id;
    }
    if (r === 'backup') {
      const pw = await askPassword('Back up your digital ID', 'Choose a password for the backup file. You need it to import the ID on another computer.');
      if (pw) {
        try {
          const saved = await host.exportDigitalId(sel.value, pw);
          if (saved) toast('Backup saved.');
        } catch (e) {
          toast('Could not back up: ' + e.message, { error: true, ms: 7000 });
        }
      }
    }
  }
}

function savedSignatureImage() {
  try {
    const s = JSON.parse(localStorage.getItem('pdfandmoore.signature') || 'null');
    return s && s.dataUrl ? s.dataUrl : null;
  } catch {
    return null;
  }
}

/** Draw what the signature looks like on the page (name, date, reason, and your handwritten signature if saved). */
async function drawAppearance(pdf, pdfPage, rect, rot, { name, reason, when }) {
  const { StandardFonts, rgb, degrees } = window.PDFLib;
  const [x1, y1, x2, y2] = rect;
  const { tl, w, h } = boxInView(x1, y1, x2, y2, rot);
  const R = rightVec(rot);
  const D = downVec(rot);
  const at = (right, down) => ({ x: tl[0] + R[0] * right + D[0] * down, y: tl[1] + R[1] * right + D[1] * down });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const blue = rgb(0.04, 0.34, 0.82);
  // Box outline.
  pdfPage.drawRectangle({ ...at(0, h), width: w, height: h, rotate: degrees(rot), borderColor: blue, borderWidth: 0.8, color: rgb(0.95, 0.97, 1), opacity: 0.6, borderOpacity: 1 });
  let left = 4;
  const sigImg = savedSignatureImage();
  if (sigImg && w > h * 2.2) {
    const bytes = Uint8Array.from(atob(sigImg.split(',')[1]), (c) => c.charCodeAt(0));
    const img = sigImg.startsWith('data:image/png') ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const ih = h - 6;
    const iw = Math.min(w * 0.45, (img.width / img.height) * ih);
    pdfPage.drawImage(img, { ...at(4, 3 + ih), width: iw, height: ih, rotate: degrees(rot) });
    left = 8 + iw;
  }
  const lines = [
    { t: 'Digitally signed by', f: font, s: 1 },
    { t: name, f: bold, s: 1.35 },
    { t: 'Date: ' + when.toLocaleString(), f: font, s: 1 },
  ];
  if (reason) lines.push({ t: 'Reason: ' + reason, f: font, s: 1 });
  const avail = w - left - 4;
  let base = Math.min(9, (h - 6) / lines.reduce((n, l) => n + l.s * 1.2, 0));
  for (const l of lines) base = Math.min(base, avail / Math.max(1, l.f.widthOfTextAtSize(l.t, l.s)));
  base = Math.max(4, base);
  let down = 3;
  for (const l of lines) {
    const size = base * l.s;
    down += size;
    pdfPage.drawText(l.t, { ...at(left, down), size, font: l.f, color: l === lines[1] ? rgb(0.1, 0.1, 0.1) : rgb(0.3, 0.3, 0.3), rotate: degrees(rot) });
    down += size * 0.2;
  }
}

/**
 * Add a signature field and an empty slot for the signature, then fill the slot with a CMS
 * signature covering every byte of the file except the slot itself.
 */
export async function signBytes(bytes, { id, pageIndex = 0, rect = null, rot = 0, reason = '', location = '' }) {
  const { PDFDocument, PDFName, PDFHexString, PDFString, PDFNumber } = window.PDFLib;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = pdf.getPages()[pageIndex];
  const when = new Date();
  if (rect) await drawAppearance(pdf, page, rect, rot, { name: id.name, reason, when });
  const ctx = pdf.context;
  const sig = ctx.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [0, PDFName.of('PMBR1_____'), PDFName.of('PMBR2_____'), PDFName.of('PMBR3_____')],
    Contents: PDFHexString.of('0'.repeat(SIG_BYTES * 2)),
    Name: PDFHexString.fromText(id.name),
    M: PDFString.fromDate(when),
  });
  if (reason) sig.set(PDFName.of('Reason'), PDFHexString.fromText(reason));
  if (location) sig.set(PDFName.of('Location'), PDFHexString.fromText(location));
  const sigRef = ctx.register(sig);
  const r = rect || [0, 0, 0, 0];
  const ap = ctx.register(ctx.formXObject([], { BBox: [0, 0, Math.abs(r[2] - r[0]), Math.abs(r[3] - r[1])] }));
  const form = pdf.getForm();
  const existing = form.getFields().map((f) => f.getName());
  let n = 1;
  while (existing.includes('Signature' + n)) n++;
  const widget = ctx.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    T: PDFHexString.fromText('Signature' + n),
    Rect: r,
    V: sigRef,
    F: 132, // print + locked
    P: page.ref,
    AP: { N: ap },
  });
  const widgetRef = ctx.register(widget);
  page.node.addAnnot(widgetRef);
  form.acroForm.addField(widgetRef);
  form.acroForm.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  const prepared = await pdf.save({ useObjectStreams: false, updateFieldAppearances: false });

  // Find the slot and the byte-range placeholder in the saved file.
  const text = new TextDecoder('latin1').decode(prepared);
  const hole = '<' + '0'.repeat(SIG_BYTES * 2) + '>';
  const start = text.lastIndexOf(hole);
  const brMatch = /\/ByteRange\s*\[\s*0\s+\/PMBR1_____\s+\/PMBR2_____\s+\/PMBR3_____\s*\]/.exec(text);
  if (start < 0 || !brMatch) throw new Error('Could not prepare the signature.');
  const end = start + hole.length;
  const ranges = [0, start, end, prepared.length - end];
  let br = `/ByteRange [${ranges.join(' ')}]`;
  if (br.length > brMatch[0].length) throw new Error('Could not prepare the signature (file too large).');
  br = br.padEnd(brMatch[0].length, ' ');
  const out = new Uint8Array(prepared);
  for (let i = 0; i < br.length; i++) out[brMatch.index + i] = br.charCodeAt(i);

  const signed = new Uint8Array(ranges[1] + ranges[3]);
  signed.set(out.subarray(0, start), 0);
  signed.set(out.subarray(end), start);
  const cms = await host.signCms(id.thumbprint, signed);
  if (cms.length > SIG_BYTES) throw new Error('The signature is too large for this file.');
  const hex = Array.from(cms, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  for (let i = 0; i < hex.length; i++) out[start + 1 + i] = hex.charCodeAt(i);
  return out;
}

/** The whole "Sign with digital ID" flow: pick ID, place the signature, save a signed copy. */
export async function signWithDigitalId() {
  if (!state.doc) return;
  if (!(await beforeSave())) return;
  if (state.doc.protection) {
    const ok = await confirmDialog(
      'Password and digital signature',
      'A file can\'t have both here: the signed copy will be saved without the password. Your document keeps its password setting for normal saves.',
      'Continue'
    );
    if (!ok) return;
  }
  const id = await chooseId();
  if (!id) return;

  const where = await dialog({
    title: 'Where should the signature go?',
    body: el(
      'div',
      {},
      el('p', {}, 'Draw a box on the page to show your signature there, or sign without anything visible (the signature is still checked when the file is opened).')
    ),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Invisible', value: 'invisible' },
      { label: 'Draw a box', value: 'box', primary: true },
    ],
  });
  if (!where) return;
  let placement = null;
  if (where === 'box') {
    placement = await new Promise((resolve) => {
      pickRegion(({ page, rect }) => resolve({ page, rect }));
      toast('Drag a box where the signature should go.', { ms: 5000 });
    });
    if (!placement) return;
  }
  const reasonIn = el('input', { class: 'field', placeholder: 'e.g. I approve this document' });
  const locIn = el('input', { class: 'field', placeholder: 'e.g. Kailua-Kona, HI' });
  const go = await dialog({
    title: 'Sign and save',
    body: el('div', {}, el('p', {}, 'Signing saves a new copy. Any change after signing breaks the signature, so finish your edits first.'), el('label', { class: 'field-label' }, 'Reason (optional)', reasonIn), el('label', { class: 'field-label' }, 'Location (optional)', locIn)),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Sign and save', value: true, primary: true },
    ],
  });
  if (!go) return;

  busy('Signing…');
  try {
    let { bytes } = await buildPdf(state.doc);
    bytes = await finalizeBytes(bytes, { lock: false });
    let pageIndex = 0;
    let rect = null;
    let rot = 0;
    if (placement) {
      pageIndex = state.doc.pages.indexOf(placement.page);
      const b = placement.rect;
      rect = [b.x1, b.y1, b.x2, b.y2];
      rot = totalRotation(placement.page);
    }
    const signed = await signBytes(bytes, { id, pageIndex, rect, rot, reason: reasonIn.value.trim(), location: locIn.value.trim() });
    busy(false);
    const name = baseName(state.doc.name) + ' (signed).pdf';
    const path = await host.saveFile({ name, bytes: signed, saveAs: true, mime: 'application/pdf' });
    if (path) {
      state.doc.signedPath = host.isHosted ? path : name;
      toast('Signed and saved. Anyone opening it can see it was signed by ' + id.name + ' and has not been changed.', { ms: 7000 });
    }
    return signed;
  } catch (e) {
    busy(false);
    toast('Could not sign: ' + e.message, { error: true, ms: 8000 });
    console.error(e);
  }
}

// ===========================================================================
// Wiring
// ===========================================================================
export function initProtect() {
  on('docopen', () => {
    if (!state.doc) return;
    const s = state.doc.sources.find((x) => x.openPassword);
    if (s && !state.doc.protection) {
      state.doc.protection = { userPassword: s.openPassword, perms: { ...DEFAULT_PERMS, editing: true } };
      toast('This file has a password. It keeps it when you save (Protect › Password to change it).', { ms: 6000 });
    }
    emit('protection');
  });
}

export { icon };
