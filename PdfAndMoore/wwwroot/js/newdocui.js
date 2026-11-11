// Opening a newly made document, and the saved logo used by "add my logo" and new forms.
import * as host from './host.js';
import { state, emit, changed } from './state.js';
import { buildFormDocument, fieldAnnots } from './newdoc.js';
import { confirmDialog, toast, busy, loadImage } from './util.js';

const LOGO_KEY = 'pdfandmoore.logo';

export function savedLogo() {
  try {
    const v = JSON.parse(localStorage.getItem(LOGO_KEY) || 'null');
    return v && v.dataUrl ? v : null;
  } catch {
    return null;
  }
}

/** Pick a picture file. Returns {dataUrl, width, height} as PNG (or JPEG for photos), at most 1200 pixels across. */
export async function pickImage() {
  const files = await host.openFiles({ multiple: false, filter: 'image' });
  if (!files || !files.length) return null;
  const f = files[0];
  const blobUrl = URL.createObjectURL(new Blob([f.bytes]));
  try {
    const img = await loadImage(blobUrl);
    const scale = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const photo = /\.(jpe?g)$/i.test(f.name);
    return { dataUrl: photo ? c.toDataURL('image/jpeg', 0.9) : c.toDataURL('image/png'), width: c.width, height: c.height };
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/** Choose (or change) the logo kept for "add my logo" and new forms. */
export async function chooseLogo() {
  const img = await pickImage();
  if (!img) return null;
  try {
    localStorage.setItem(LOGO_KEY, JSON.stringify(img));
  } catch {
    toast('That picture is too large to remember; it is used just this time.', { ms: 5000 });
  }
  toast('Logo saved. Say "add my logo" any time.');
  return img;
}

/** The saved logo, or ask for one the first time. */
export async function getLogo({ ask = true } = {}) {
  const s = savedLogo();
  if (s || !ask) return s;
  const ok = await confirmDialog('Choose your logo', 'Pick the picture to use as your logo (PNG or JPG). It is remembered for next time; change it any time from Insert › Change my logo.', 'Choose picture');
  return ok ? chooseLogo() : null;
}

/** Lay out a plan as a new fillable PDF and open it. */
export async function createDocument(plan, { onNeedLogo } = {}) {
  if (!plan || typeof plan !== 'object') throw new Error('No document description was given.');
  if (!Array.isArray(plan.sections) || !plan.sections.length) throw new Error('The description had no sections or fields.');
  let logo = savedLogo();
  if (!logo && plan.logo === true && onNeedLogo) logo = await onNeedLogo();
  busy('Making your document…');
  let built;
  try {
    built = await buildFormDocument(plan, { logoDataUrl: plan.logo === false ? null : logo && logo.dataUrl });
  } finally {
    busy(false);
  }
  const name = String(plan.title || 'New form').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80) + '.pdf';
  await window.pdfAndMoore.openFiles([{ name, path: null, bytes: built.bytes }], { askDiscard: true });
  if (!state.doc || state.doc.name !== name) throw new Error('The new document was not opened.');
  const annots = fieldAnnots(built.fields);
  built.fields.forEach((f, i) => state.doc.pages[f.pageIndex].annots.push(annots[i]));
  state.doc.dirty = true;
  state.doc.path = null;
  changed();
  emit('forms');
  return { pages: state.doc.pages.length, fields: annots.length };
}
