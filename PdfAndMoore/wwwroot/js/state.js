// Shared app state plus a tiny event bus so modules can react to changes.

export const state = {
  doc: null, // { name, path, sources, pages, formValues, fields, dirty }
  zoom: 1, // 1 = 100%
  fitMode: 'width', // 'width' | 'page' | null
  tool: 'select',
  formMode: 'fill', // 'fill' = type into fields, 'edit' = move/resize/rename fields
  props: {
    color: '#1a73e8',
    highlight: '#ffd54f',
    stroke: 2,
    fontSize: 12,
    font: 'Helvetica',
    bold: false,
    opacity: 1,
  },
  selectedAnnot: null, // { pageId, annotId }
  currentPage: 0,
  searchQuery: '',
  history: [],
  future: [],
};

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(fn);
}
export function emit(event, data) {
  (listeners.get(event) || []).forEach((fn) => {
    try {
      fn(data);
    } catch (e) {
      console.error(e);
    }
  });
}

// ---------- undo / redo ----------
function snapshot() {
  const d = state.doc;
  return JSON.stringify({ pages: d.pages, formValues: d.formValues, prepared: d.prepared || {} });
}

/** Call BEFORE changing the document so the change can be undone. */
export function checkpoint() {
  if (!state.doc) return;
  state.history.push(snapshot());
  if (state.history.length > 100) state.history.shift();
  state.future = [];
}

/** Call AFTER changing the document. */
export function changed({ structure = false } = {}) {
  if (!state.doc) return;
  state.doc.dirty = true;
  emit(structure ? 'structure' : 'annots');
  emit('dirty');
}

function restore(snap) {
  const s = JSON.parse(snap);
  // Keep per-page caches (OCR text) that are not part of the snapshot.
  const cache = Object.fromEntries(state.doc.pages.map((p) => [p.id, p.ocrText]));
  state.doc.pages = s.pages.map((p) => ({ ...p, ocrText: cache[p.id] ?? p.ocrText }));
  state.doc.formValues = s.formValues;
  state.doc.prepared = s.prepared || {};
  state.doc.dirty = true;
  state.selectedAnnot = null;
  emit('structure');
  emit('dirty');
}

export function undo() {
  if (!state.doc || !state.history.length) return false;
  state.future.push(snapshot());
  restore(state.history.pop());
  return true;
}
export function redo() {
  if (!state.doc || !state.future.length) return false;
  state.history.push(snapshot());
  restore(state.future.pop());
  return true;
}

export function findPage(pageId) {
  return state.doc && state.doc.pages.find((p) => p.id === pageId);
}
export function findAnnot(sel = state.selectedAnnot) {
  if (!sel) return null;
  const page = findPage(sel.pageId);
  if (!page) return null;
  const annot = page.annots.find((a) => a.id === sel.annotId);
  return annot ? { page, annot } : null;
}
