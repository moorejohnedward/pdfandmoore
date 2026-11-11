// PDF and Moore — main controller: menus, toolbar, opening/saving, shortcuts, panels.
import * as host from './host.js';
import { state, on, emit, undo, redo, checkpoint, changed } from './state.js';
import { loadSource, pagesForSource, readFormFields, buildPdf, blankPdfBytes, getPageText, renderPageToCanvas } from './doc.js';
import {
  initViewer, rebuild, setZoom, applyFit, setTool, scrollToPage, markupSelection, hideSelectionMenu, getSelectedText,
  deleteSelectedAnnot, updateSelectedAnnot, nudgeSelected, refreshSearchHighlights, placeImage, pickRegion, cssScale,
} from './viewer.js';
import { el, icon, $, $$, toast, busy, busyProgress, dialog, confirmDialog, promptDialog, extOf, baseName, loadImage, debounce } from './util.js';
import { fileToPdf, kindOf, exportWord, exportExcel, exportText, exportHtml, exportImages, compressPdf } from './convert.js';
import { initThumbnails, renderThumbnails, openOrganizer, rotatePages, deletePages, insertBlank, insertFromFiles, insertFiles, extractPages, splitDialog, parseRanges } from './organize.js';
import { ocrPages, grabRegion, grabTextFromImageBytes, pageNeedsOcr } from './ocr.js';
import { initForms, setFormMode, detectFields, autoNameAll, startSigning, duplicateSelected, renderFormPanel, addField, signatureDialog } from './forms.js';
import { initClaude, settingsDialog, signInDialog, mode as aiMode, aiSettings, localModelId } from './claude.js';
import { parseWithRules, runActions, buildAiPrompt, parseAiReply, EXAMPLES } from './commands.js';
import * as localai from './localai.js';
import { findAnnot } from './state.js';
import * as protect from './protect.js';
import * as newdocui from './newdocui.js';
import * as restore from './restore.js';

const APP = 'PDF and Moore';

// ---------------------------------------------------------------------------
// Opening documents
// ---------------------------------------------------------------------------
async function confirmDiscard() {
  if (!state.doc || !state.doc.dirty) return true;
  const r = await dialog({
    title: 'Save changes?',
    body: `Do you want to save the changes to "${state.doc.name}"?`,
    buttons: [
      { label: 'Cancel', value: null },
      { label: "Don't save", value: 'discard' },
      { label: 'Save', value: 'save', primary: true },
    ],
  });
  if (r === 'save') return save();
  return r === 'discard';
}

// Word, Excel and PowerPoint files open in the built-in editors (each in its own window).
const OFFICE_EXT = ['docx', 'docm', 'dotx', 'xlsx', 'xlsm', 'xls', 'xlsb', 'csv', 'tsv', 'ods', 'pptx', 'pptm', 'ppsx'];
const officeEditable = (f) => host.isHosted && !!f.path && OFFICE_EXT.includes(extOf(f.name));

async function hostCmd(cmd, args = {}) {
  try {
    const msg = await host.hostCommand(cmd, args);
    if (typeof msg === 'string' && msg) toast(msg, { ms: 8000 });
  } catch (e) {
    toast(e.message || String(e), { error: true, ms: 8000 });
  }
}

/** Turn Word / Excel / PowerPoint files into a PDF (instead of editing them). */
async function officeToPdfDialog() {
  const files = await host.openFiles({ multiple: true });
  if (files.length) await openFiles(files, { asPdf: true });
}

/** Open one or more files (any supported type). Several files are combined into one PDF. */
async function openFiles(files, { askDiscard = true, asPdf = false } = {}) {
  if (!files || !files.length) return;
  if (!asPdf && files.length === 1 && officeEditable(files[0])) {
    try {
      await host.editOffice(files[0].path);
      toast(`${files[0].name} opened in its own window. (To make it a PDF instead: File › Turn Office files into a PDF.)`, { ms: 6000 });
    } catch (e) {
      toast(e.message || String(e), { error: true, ms: 7000 });
    }
    return;
  }
  if (askDiscard && !(await confirmDiscard())) return;
  busy(files.length > 1 ? 'Combining files…' : `Opening ${files[0].name}…`);
  try {
    const sources = [];
    let anyImage = false;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      busyProgress(i / files.length, `Opening ${f.name}…`);
      const kind = kindOf(f.name);
      if (kind === 'image') anyImage = true;
      const pdfBytes = kind === 'pdf' ? f.bytes : await fileToPdf(f);
      sources.push(await loadSource(pdfBytes, f.name));
    }
    const pages = [];
    for (const s of sources) pages.push(...(await pagesForSource(s)));
    const fields = {};
    for (const s of sources) {
      const list = await readFormFields(s);
      if (list.length) fields[s.id] = list;
    }
    const single = files.length === 1 && kindOf(files[0].name) === 'pdf';
    state.doc = {
      name: files.length === 1 ? baseName(files[0].name) + '.pdf' : baseName(files[0].name) + ' (combined).pdf',
      path: single ? files[0].path : null,
      sources,
      pages,
      fields,
      formValues: {},
      prepared: {},
      dirty: !single,
    };
    state.history = [];
    state.future = [];
    state.selectedAnnot = null;
    state.currentPage = 0;
    state.searchQuery = '';
    state.formMode = 'fill';
    document.body.dataset.formMode = 'fill';
    document.body.classList.remove('no-doc');
    $('#docTitle').value = baseName(state.doc.name);
    rebuild();
    emit('docopen');
    updateTitle();
    $('#viewer').scrollTop = 0;
    requestAnimationFrame(() => {
      applyFit('width');
      $('#viewer').scrollTop = 0;
    });
    busy(false);
    const nFields = Object.values(fields).reduce((n, l) => n + l.length, 0);
    if (nFields) {
      toast(`This PDF has ${nFields} fillable fields. Click a box to fill it in, or use the Form panel to edit them.`, { ms: 5000 });
      showPanel('form');
    }
    // Scans and photos: offer to read the text.
    if (anyImage || (pages.length <= 60 && (await pageNeedsOcr(pages[0])) && (await pageNeedsOcr(pages[pages.length - 1])))) {
      setTimeout(async () => {
        const ok = await confirmDialog(
          'Make the text searchable?',
          'This looks like a scan or photo, so its text cannot be selected or searched yet. Read the text now? Pages that are sideways, upside down or crooked will be straightened.',
          'Read text'
        );
        if (ok) runOcr('all');
      }, 300);
    }
  } catch (e) {
    busy(false);
    toast(e.message || String(e), { error: true, ms: 7000 });
    console.error(e);
  }
}

async function openDialog() {
  const files = await host.openFiles({ multiple: true });
  if (files.length) await openFiles(files);
}

async function newBlank() {
  if (!(await confirmDiscard())) return;
  const size = await dialog({
    title: 'New blank PDF',
    body: 'Choose a page size.',
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'A4', value: 'A4' },
      { label: 'Legal', value: 'Legal' },
      { label: 'Letter', value: 'Letter', primary: true },
    ],
  });
  if (!size) return;
  await openFiles([{ name: 'Untitled.pdf', path: null, bytes: await blankPdfBytes(size) }], { askDiscard: false });
  state.doc.dirty = true;
  updateTitle();
}

async function combineDialog() {
  const files = await host.openFiles({ multiple: true });
  if (!files.length) return;
  if (state.doc) {
    const r = await dialog({
      title: 'Combine files',
      body: `Add ${files.length} file${files.length === 1 ? '' : 's'} to the end of "${state.doc.name}", or start a new combined PDF?`,
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'New PDF', value: 'new' },
        { label: 'Add to this PDF', value: 'add', primary: true },
      ],
    });
    if (r === 'add') return insertFiles(files);
    if (r !== 'new') return;
  }
  await openFiles(files, { asPdf: true });
}

async function closeDocument() {
  if (!(await confirmDiscard())) return;
  state.doc = null;
  document.body.classList.add('no-doc');
  $('#docTitle').value = APP;
  rebuild();
  renderThumbnails();
  emit('docopen');
  renderStart();
  updateTitle();
}

// ---------------------------------------------------------------------------
// Saving & exporting
// ---------------------------------------------------------------------------
function docFileName(ext = 'pdf') {
  const t = ($('#docTitle').value || 'Untitled').trim().replace(/[\\/:*?"<>|]/g, '-');
  return baseName(t) + '.' + ext;
}

async function save(saveAs = false) {
  if (!state.doc) return false;
  if (!(await protect.beforeSave())) return false;
  if (!saveAs && state.doc.path && state.doc.signedPath === state.doc.path) {
    const r = await dialog({
      title: 'This copy is digitally signed',
      body: 'Saving over it removes the digital signature. Save your changes as a new file instead?',
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Save over it', value: 'over' },
        { label: 'Save as new file', value: 'new', primary: true },
      ],
    });
    if (!r) return false;
    if (r === 'new') saveAs = true;
  }
  busy('Saving…');
  try {
    let { bytes, flattenedForms } = await buildPdf(state.doc);
    bytes = await protect.finalizeBytes(bytes);
    busy(false);
    const path = await host.saveFile({ name: docFileName('pdf'), bytes, path: state.doc.path, saveAs: saveAs || !state.doc.path, mime: 'application/pdf' });
    if (!path) return false;
    state.doc.path = host.isHosted ? path : null;
    state.doc.name = host.isHosted ? path.split(/[\\/]/).pop() : docFileName('pdf');
    $('#docTitle').value = baseName(state.doc.name);
    state.doc.dirty = false;
    updateTitle();
    if (state.doc.signedPath === path) state.doc.signedPath = null;
    toast(
      (flattenedForms ? 'Saved. Form fields were made part of the page because pages were combined or reordered.' : 'Saved.') +
        (state.doc.protection ? ' The file is locked with your password.' : '')
    );
    return true;
  } catch (e) {
    busy(false);
    toast('Could not save: ' + e.message, { error: true, ms: 7000 });
    console.error(e);
    return false;
  }
}

async function exportAs(kind) {
  if (!state.doc) return;
  busy('Converting…');
  try {
    let out;
    if (kind === 'word') out = { name: docFileName('docx'), bytes: await exportWord(), mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    else if (kind === 'excel') out = { name: docFileName('xlsx'), bytes: await exportExcel(), mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    else if (kind === 'text') out = { name: docFileName('txt'), bytes: await exportText(), mime: 'text/plain' };
    else if (kind === 'html') out = { name: docFileName('html'), bytes: await exportHtml(), mime: 'text/html' };
    else if (kind === 'png' || kind === 'jpeg') {
      const r = await exportImages(kind);
      out = { name: r.name, bytes: r.bytes, mime: r.single ? 'image/' + kind : 'application/zip' };
    } else if (kind === 'compress') {
      out = { name: baseName(docFileName()) + ' (smaller).pdf', bytes: await compressPdf(), mime: 'application/pdf' };
    }
    busy(false);
    const saved = await host.saveFile({ ...out, saveAs: true });
    if (saved) toast('Saved ' + (saved.split ? saved.split(/[\\/]/).pop() : out.name));
  } catch (e) {
    busy(false);
    toast('Could not convert: ' + e.message, { error: true, ms: 7000 });
    console.error(e);
  }
}

async function compressDialog() {
  const ok = await confirmDialog(
    'Reduce file size',
    'This saves a smaller copy by turning every page into a compressed picture. It works best for scans and photos. Text in the copy will not be selectable unless you run Recognize text on it afterwards.',
    'Make smaller copy'
  );
  if (ok) exportAs('compress');
}

async function printDoc() {
  if (!state.doc) return;
  busy('Preparing to print…');
  try {
    const { bytes } = await buildPdf(state.doc);
    const { pdfjsLib } = await import('./doc.js');
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const area = $('#printArea');
    area.replaceChildren();
    for (let i = 1; i <= pdf.numPages; i++) {
      busyProgress((i - 1) / pdf.numPages);
      const p = await pdf.getPage(i);
      const vp = p.getViewport({ scale: 150 / 72 });
      const c = document.createElement('canvas');
      c.width = vp.width;
      c.height = vp.height;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      await p.render({ canvasContext: g, viewport: vp }).promise;
      area.append(el('img', { src: c.toDataURL('image/jpeg', 0.92) }));
    }
    busy(false);
    await new Promise((r) => setTimeout(r, 200));
    window.print();
  } catch (e) {
    busy(false);
    toast('Could not print: ' + e.message, { error: true });
  }
}

function updateTitle() {
  const s = $('#saveState');
  if (!state.doc) {
    s.replaceChildren();
    host.setDirty(false, APP);
    return;
  }
  s.replaceChildren(
    state.doc.dirty ? el('span', { class: 'ms' }, 'edit') : el('span', { class: 'ms' }, 'cloud_done'),
    state.doc.dirty ? 'Unsaved changes' : state.doc.path ? 'Saved' : ''
  );
  host.setDirty(state.doc.dirty, `${state.doc.dirty ? '• ' : ''}${baseName(state.doc.name)} - ${APP}`);
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------
async function runOcr(which, { deep = false } = {}) {
  if (!state.doc) return;
  const pages = which === 'all' ? state.doc.pages : [state.doc.pages[state.currentPage]];
  try {
    const r = await ocrPages(pages, { straighten: true, skipTextPages: which === 'all' && !deep, deep });
    if (!r.textFound && which === 'all') toast('No pages needed reading. Use "This page" to force it on a page that already has text.');
    else
      toast(`Text recognized on ${r.textFound} page${r.textFound === 1 ? '' : 's'}${r.straightened ? `, ${r.straightened} straightened` : ''}. You can now search and select it.`, { ms: 5000 });
  } catch (e) {
    toast('Text recognition failed: ' + e.message, { error: true, ms: 7000 });
    console.error(e);
  }
}

async function ocrImageFile() {
  const files = await host.openFiles({ multiple: false, filter: 'image' });
  if (!files.length) return;
  if (!['image', 'tiff', 'heic'].includes(kindOf(files[0].name))) return toast('Pick a picture file (PNG, JPG, TIFF, HEIC…).', { error: true });
  try {
    await grabTextFromImageBytes(files[0].bytes, files[0].name);
  } catch (e) {
    toast(e.message, { error: true });
  }
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------
async function insertImage() {
  const files = await host.openFiles({ multiple: false, filter: 'image' });
  if (!files.length) return;
  const f = files[0];
  const mime = extOf(f.name) === 'png' ? 'image/png' : 'image/jpeg';
  let dataUrl;
  const url = URL.createObjectURL(new Blob([f.bytes], { type: 'image/' + extOf(f.name) }));
  const img = await loadImage(url);
  // Re-encode to PNG/JPEG so any image type can be embedded.
  const c = document.createElement('canvas');
  const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
  c.width = Math.round(img.naturalWidth * scale);
  c.height = Math.round(img.naturalHeight * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  dataUrl = mime === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.9);
  URL.revokeObjectURL(url);
  placeImage(dataUrl, img.naturalWidth * 0.5, img.naturalHeight * 0.5);
}

async function extractDialog() {
  const r = await promptDialog('Extract pages', `Which pages? (1-${state.doc.pages.length}, e.g. "1-3, 7")`, String(state.currentPage + 1));
  if (!r) return;
  const idx = parseRanges(r, state.doc.pages.length);
  if (!idx.length) return toast('No pages matched.', { error: true });
  extractPages(idx.map((i) => state.doc.pages[i].id));
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------
const needDoc = () => !!state.doc;
const cur = () => state.doc && state.doc.pages[state.currentPage];

function menus() {
  return {
    File: [
      ['note_add', 'New blank PDF', newBlank],
      ['folder_open', 'Open…', openDialog, 'Ctrl+O'],
      ['merge', 'Combine files into one PDF…', combineDialog],
      ['#', 'Word, Excel and PowerPoint'],
      ['description', 'New document', () => hostCmd('newOffice', { kind: 'word' })],
      ['table_view', 'New spreadsheet', () => hostCmd('newOffice', { kind: 'sheet' })],
      ['slideshow', 'New presentation', () => hostCmd('newOffice', { kind: 'slides' })],
      ['edit_document', 'Open a Word, Excel or PowerPoint file…', () => hostCmd('openOffice')],
      ['picture_as_pdf', 'Turn Office files into a PDF…', officeToPdfDialog],
      ['-'],
      ['save', 'Save', () => save(false), 'Ctrl+S', needDoc],
      ['save_as', 'Save as…', () => save(true), 'Ctrl+Shift+S', needDoc],
      ['#', 'Save a copy as'],
      ['description', 'Word document (.docx)', () => exportAs('word'), '', needDoc],
      ['table_view', 'Excel workbook (.xlsx)', () => exportAs('excel'), '', needDoc],
      ['image', 'Images (.png)', () => exportAs('png'), '', needDoc],
      ['photo', 'Images (.jpg)', () => exportAs('jpeg'), '', needDoc],
      ['article', 'Plain text (.txt)', () => exportAs('text'), '', needDoc],
      ['html', 'Web page (.html)', () => exportAs('html'), '', needDoc],
      ['compress', 'Smaller PDF (reduce file size)…', compressDialog, '', needDoc],
      ['-'],
      ['print', 'Print', printDoc, 'Ctrl+P', needDoc],
      ['-'],
      ['close', 'Close document', closeDocument, '', needDoc],
    ],
    Edit: [
      ['undo', 'Undo', () => undo(), 'Ctrl+Z', () => state.history.length > 0],
      ['redo', 'Redo', () => redo(), 'Ctrl+Y', () => state.future.length > 0],
      ['-'],
      ['content_copy', 'Copy selected text', () => navigator.clipboard.writeText(getSelectedText()), 'Ctrl+C', needDoc],
      ['library_add', 'Duplicate selected item', () => duplicateSelected('down'), 'Ctrl+D', () => !!findAnnot()],
      ['delete', 'Delete selected item', deleteSelectedAnnot, 'Del', () => !!findAnnot()],
      ['-'],
      ['search', 'Find', openFind, 'Ctrl+F', needDoc],
      ['edit_note', 'Edit existing text', () => setTool('edittext'), 'E', needDoc],
    ],
    View: [
      ['zoom_in', 'Zoom in', () => setZoom(state.zoom * 1.2), 'Ctrl++', needDoc],
      ['zoom_out', 'Zoom out', () => setZoom(state.zoom / 1.2), 'Ctrl+-', needDoc],
      ['fit_page_width', 'Fit width', () => applyFit('width'), '', needDoc],
      ['fit_screen', 'Fit whole page', () => applyFit('page'), '', needDoc],
      ['crop_free', 'Actual size (100%)', () => setZoom(1), 'Ctrl+0', needDoc],
      ['-'],
      ['view_sidebar', 'Show page thumbnails', () => document.body.classList.toggle('hide-sidebar'), ''],
      ['right_panel_open', 'Show side panel', () => togglePanel(), 'Ctrl+J'],
    ],
    Insert: [
      ['title', 'Text box', () => setTool('text'), 'T', needDoc],
      ['image', 'Image…', insertImage, '', needDoc],
      ['signature', 'Signature…', startSigning, '', needDoc],
      ['add_comment', 'Comment', () => setTool('note'), 'C', needDoc],
      ['branding_watermark', 'My logo', () => runQuickCommand('Add my logo at the top left'), '', needDoc],
      ['wallpaper', 'Change my logo…', () => newdocui.chooseLogo(), ''],
      ['#', 'Shapes'],
      ['rectangle', 'Rectangle', () => setTool('rect'), 'R', needDoc],
      ['circle', 'Ellipse', () => setTool('ellipse'), '', needDoc],
      ['horizontal_rule', 'Line', () => setTool('line'), 'L', needDoc],
      ['arrow_right_alt', 'Arrow', () => setTool('arrow'), 'A', needDoc],
      ['-'],
      ['note_add', 'Blank page', () => insertBlank(state.currentPage + 1), '', needDoc],
      ['library_add', 'Pages from another file…', () => insertFromFiles(state.currentPage + 1), '', needDoc],
    ],
    Pages: [
      ['grid_view', 'Organize pages…', openOrganizer, '', needDoc],
      ['-'],
      ['rotate_left', 'Rotate this page left', () => rotatePages([cur().id], -90), '', needDoc],
      ['rotate_right', 'Rotate this page right', () => rotatePages([cur().id], 90), '', needDoc],
      ['rotate_90_degrees_cw', 'Rotate all pages right', () => rotatePages(state.doc.pages.map((p) => p.id), 90), '', needDoc],
      ['delete', 'Delete this page', () => deletePages([cur().id]), '', needDoc],
      ['-'],
      ['ios_share', 'Extract pages to a new PDF…', extractDialog, '', needDoc],
      ['call_split', 'Split into several PDFs…', splitDialog, '', needDoc],
      ['merge', 'Add files to the end…', () => insertFromFiles(), '', needDoc],
    ],
    Tools: [
      ['#', 'Recognize text (OCR)'],
      ['document_scanner', 'Read text on every scanned page', () => runOcr('all'), '', needDoc],
      ['plagiarism', 'Read text on this page', () => runOcr('page'), '', needDoc],
      ['crop', 'Grab text from an area…', () => pickRegion(grabRegion), 'G', needDoc],
      ['blur_on', 'Read faded or worn text (careful, slower)', () => runOcr('all', { deep: true }), '', needDoc],
      ['auto_fix_high', 'Restore old document…', () => restore.restoreDialog(), '', needDoc],
      ['image_search', 'Grab text from a picture file…', ocrImageFile, ''],
      ['-'],
      ['edit_note', 'Edit existing text', () => setTool('edittext'), 'E', needDoc],
      ['format_paint', 'Whiteout (covers only — use Redact for private info)', () => setTool('whiteout'), 'W', needDoc],
      ['height', 'Move lines (table borders, underlines)', () => setTool('lines'), 'M', needDoc],
      ['#', 'Protect'],
      ['ink_eraser', 'Redact an area', protect.startRedactTool, '', needDoc],
      ['manage_search', 'Find and redact…', protect.findAndRedactDialog, '', needDoc],
      ['check_circle', 'Apply redactions', () => protect.applyRedactions(), '', needDoc],
      ['lock', 'Lock with password…', protect.passwordDialog, '', needDoc],
      ['verified', 'Sign with digital ID…', protect.signWithDigitalId, '', needDoc],
      ['cleaning_services', 'Remove hidden information…', protect.removeHiddenInfoDialog, '', needDoc],
      ['ink_highlighter', 'Highlight text', () => setTool('highlight'), 'H', needDoc],
      ['-'],
      ['app_registration', 'Make PDF and Moore my default app…', () => hostCmd('setDefaultApp'), ''],
      ['settings', 'Settings…', settingsDialog, ''],
    ],
    Form: [
      ['edit_note', 'Fill in form', () => (setFormMode('fill'), showPanel('form')), '', needDoc],
      ['design_services', 'Edit form fields', () => (setFormMode('edit'), showPanel('form')), '', needDoc],
      ['auto_awesome', 'Detect fields automatically', async () => { const n = await detectFields(); if (n) toast(`Added ${n} fields.`); showPanel('form'); }, '', needDoc],
      ['label', 'Auto-name fields from labels', async () => { const n = await autoNameAll(); toast(`Renamed ${n} fields.`); showPanel('form'); }, '', needDoc],
      ['#', 'Add a field'],
      ['text_fields', 'Text field', () => fieldTool('text'), '', needDoc],
      ['check_box', 'Checkbox', () => fieldTool('checkbox'), '', needDoc],
      ['radio_button_checked', 'Radio button', () => fieldTool('radio'), '', needDoc],
      ['arrow_drop_down_circle', 'Dropdown', () => fieldTool('dropdown'), '', needDoc],
      ['calendar_month', 'Date', () => fieldTool('date'), '', needDoc],
      ['signature', 'Signature field', () => fieldTool('signature'), '', needDoc],
      ['-'],
      ['draw', 'Sign this document…', startSigning, '', needDoc],
      ['assignment', 'Fill the form with Claude…', () => emitQuickFill(), '', needDoc],
      ['ink_eraser', 'Clear all entries', clearFormValues, '', needDoc],
    ],
    Help: [
      ['keyboard', 'Keyboard shortcuts', shortcutsDialog, 'Ctrl+/'],
      ['info', 'About PDF and Moore', aboutDialog, ''],
    ],
  };
}

function fieldTool(kind) {
  setFormMode('edit');
  showPanel('form');
  setTool('field-' + kind);
}

function emitQuickFill() {
  showPanel('claude');
  const chip = [...$$('#claudeChips .chip')].find((c) => /Fill the form/.test(c.textContent));
  chip && chip.click();
}

function clearFormValues() {
  checkpoint();
  state.doc.pages.forEach((p) => p.annots.forEach((a) => a.type === 'field' && ((a.value = a.kind === 'checkbox' || a.kind === 'radio' ? false : ''), delete a.sig)));
  for (const [src, list] of Object.entries(state.doc.fields || {})) {
    state.doc.formValues[src] = {};
    list.forEach((f) => (state.doc.formValues[src][f.name] = f.kind === 'checkbox' ? false : ''));
  }
  changed();
  emit('forms');
  toast('Cleared all form entries.');
}

let openMenu = null;
function buildMenubar() {
  const bar = $('#menubar');
  bar.replaceChildren();
  for (const name of Object.keys(menus())) {
    const b = el('button', { class: 'menu-top' }, name);
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      openMenu === name ? closeMenus() : showMenuFor(name, b);
    });
    b.addEventListener('mouseenter', () => openMenu && openMenu !== name && showMenuFor(name, b));
    bar.append(b);
  }
  document.addEventListener('mousedown', (e) => {
    if (openMenu && !e.target.closest('.menu-pop, .menu-top')) closeMenus();
  });
}
function closeMenus() {
  $$('.menu-pop.main-menu').forEach((m) => m.remove());
  $$('.menu-top').forEach((b) => b.classList.remove('open'));
  openMenu = null;
}
function showMenuFor(name, btn) {
  closeMenus();
  openMenu = name;
  btn.classList.add('open');
  const r = btn.getBoundingClientRect();
  const pop = el('div', { class: 'menu-pop main-menu', style: { left: r.left + 'px', top: r.bottom + 2 + 'px' } });
  for (const item of menus()[name]) {
    if (item[0] === '-') pop.append(el('div', { class: 'menu-sep' }));
    else if (item[0] === '#') pop.append(el('div', { class: 'menu-head' }, item[1]));
    else {
      const [ic, label, fn, kbd, enabled] = item;
      const ok = !enabled || enabled();
      pop.append(
        el(
          'button',
          {
            class: 'menu-item',
            disabled: !ok,
            onclick: () => {
              closeMenus();
              Promise.resolve(fn()).catch((e) => toast(e.message, { error: true }));
            },
          },
          icon(ic),
          el('span', {}, label),
          kbd ? el('span', { class: 'kbd' }, kbd) : null
        )
      );
    }
  }
  if (name === 'File') addRecent(pop);
  document.body.append(pop);
}
async function addRecent(pop) {
  const recent = await host.getRecentFiles().catch(() => []);
  if (!recent || !recent.length) return;
  const anchor = pop.querySelector('.menu-sep');
  const frag = [el('div', { class: 'menu-sep' }), el('div', { class: 'menu-head' }, 'Recent')];
  for (const p of recent.slice(0, 6)) {
    frag.push(
      el(
        'button',
        { class: 'menu-item', title: p, onclick: () => (closeMenus(), openPath(p)) },
        icon('picture_as_pdf'),
        el('span', {}, p.split(/[\\/]/).pop())
      )
    );
  }
  anchor.before(...frag);
}

async function openPath(path, { asPdf = false } = {}) {
  try {
    const f = await host.readPath(path);
    await openFiles([f], { asPdf });
  } catch (e) {
    toast(`Could not open ${path}: ${e.message}`, { error: true, ms: 7000 });
  }
}

// ---------------------------------------------------------------------------
// Ribbon: colorful tabs with big, labeled tools
// ---------------------------------------------------------------------------
const SWATCHES = ['#000000', '#1a73e8', '#d93025', '#188038', '#f9ab00', '#e8710a', '#9334e6', '#e52592', '#5f6368', '#ffffff'];
const HL_SWATCHES = ['#ffd54f', '#a8e6a1', '#a8d1ff', '#ffb3d9', '#ffc78a', '#d7b8ff'];
let ribbonTab = 'home';

function ribbonTabs() {
  return [
    { id: 'home', label: 'Home', color: '#0b57d0', icon: 'home' },
    { id: 'edit', label: 'Edit', color: '#1a73e8', icon: 'edit_document' },
    { id: 'draw', label: 'Mark up', color: '#e8710a', icon: 'brush' },
    { id: 'forms', label: 'Forms', color: '#188038', icon: 'assignment' },
    { id: 'pages', label: 'Pages', color: '#9334e6', icon: 'auto_stories' },
    { id: 'protect', label: 'Protect', color: '#c5221f', icon: 'shield_lock' },
    { id: 'ai', label: 'AI', color: '#d97757', icon: 'auto_awesome' },
  ];
}

/** A big ribbon button: colored icon tile over a short label. */
function rb(ic, label, fn, { tool = null, title = null, needsDoc = true, big = true } = {}) {
  const b = el(
    'button',
    { class: 'rb' + (big ? '' : ' small') + (needsDoc ? ' needs-doc' : ''), title: title || label, onclick: fn || (() => setTool(tool)) },
    el('span', { class: 'rb-icon' }, icon(ic)),
    el('span', { class: 'rb-label' }, label)
  );
  if (tool) b.dataset.tool = tool;
  return b;
}
function group(title, ...children) {
  return el('div', { class: 'rgroup' }, el('div', { class: 'rgroup-items' }, ...children.flat()), el('div', { class: 'rgroup-title' }, title));
}
function swatchRow(colors, current, onPick, title) {
  return el(
    'div',
    { class: 'swatches', title },
    colors.map((c) =>
      el('button', {
        class: 'swatch-dot' + (c === current ? ' on' : '') + (c === '#ffffff' ? ' light' : ''),
        style: { background: c },
        title: c,
        onclick: (e) => {
          e.currentTarget.parentNode.querySelectorAll('.swatch-dot').forEach((d) => d.classList.remove('on'));
          e.currentTarget.classList.add('on');
          onPick(c);
        },
      })
    )
  );
}

function ribbonContent(tab) {
  const zoom = el(
    'select',
    { class: 'rselect', id: 'zoomSel', title: 'Zoom' },
    el('option', { value: 'width' }, 'Fit width'),
    el('option', { value: 'page' }, 'Fit page'),
    [50, 75, 100, 125, 150, 200, 300].map((z) => el('option', { value: z / 100 }, z + '%')),
    el('option', { value: 'custom', id: 'zoomCustom', hidden: true }, '')
  );
  zoom.value = state.fitMode || String(state.zoom);
  zoom.addEventListener('change', () => {
    const v = zoom.value;
    if (v === 'width' || v === 'page') applyFit(v);
    else if (v !== 'custom') setZoom(Number(v));
  });
  const font = el('select', { class: 'rselect', title: 'Font' }, ['Helvetica', 'Times', 'Courier'].map((f) => el('option', { value: f }, { Helvetica: 'Arial', Times: 'Times New Roman', Courier: 'Courier New' }[f])));
  font.value = state.props.font;
  font.addEventListener('change', () => {
    state.props.font = font.value;
    updateSelectedAnnot({ font: font.value });
  });
  const size = el('input', { class: 'rnum', type: 'number', min: 4, max: 96, value: state.props.fontSize, title: 'Text size' });
  size.addEventListener('change', () => {
    state.props.fontSize = Number(size.value) || 12;
    updateSelectedAnnot({ fontSize: state.props.fontSize });
  });
  size.addEventListener('keydown', (e) => e.stopPropagation());
  const thick = el('select', { class: 'rselect', title: 'Line thickness' }, [1, 2, 3, 4, 6, 8, 12].map((n) => el('option', { value: n }, n + ' pt')));
  thick.value = String(state.props.stroke);
  thick.addEventListener('change', () => {
    state.props.stroke = Number(thick.value);
    updateSelectedAnnot({ stroke: state.props.stroke });
  });
  const colorPick = (c) => {
    state.props.color = c;
    updateSelectedAnnot({ color: c });
  };

  switch (tab) {
    case 'home':
      return [
        group('File', rb('folder_open', 'Open', openDialog, { needsDoc: false }), rb('save', 'Save', () => save(false)), rb('print', 'Print', printDoc)),
        group('Undo', rb('undo', 'Undo', () => undo()), rb('redo', 'Redo', () => redo())),
        group('Pointer', rb('arrow_selector_tool', 'Select', null, { tool: 'select', title: 'Select and move things (V)' }), rb('pan_tool', 'Hand', null, { tool: 'hand', title: 'Drag to scroll (hold Space)' })),
        group('View', el('div', { class: 'rstack' }, zoom, el('div', { class: 'rrow' }, rb('zoom_out', 'Smaller', () => setZoom(state.zoom / 1.2), { big: false }), rb('zoom_in', 'Bigger', () => setZoom(state.zoom * 1.2), { big: false })))),
        group('Find', rb('search', 'Find', openFind)),
        group('Help', rb('lightbulb', 'What can I say?', showExamples, { needsDoc: false }), rb('keyboard', 'Shortcuts', shortcutsDialog, { needsDoc: false })),
      ];
    case 'edit':
      return [
        group('Text', rb('title', 'Add text', null, { tool: 'text', title: 'Click on the page and type (T)' }), rb('edit_note', 'Change text', null, { tool: 'edittext', title: 'Click words already on the page to change them (E)' }), rb('format_paint', 'White out', null, { tool: 'whiteout', title: 'Drag over something to cover it (W)' }), rb('height', 'Move lines', null, { tool: 'lines', title: 'Grab any line on the page, including table borders and underlines, and drag it (Shift = move freely)' })),
        group('Insert', rb('add_photo_alternate', 'Picture', insertImage), rb('branding_watermark', 'My logo', () => runQuickCommand('Add my logo at the top left'), { title: 'Add your saved logo (pick it the first time)' }), rb('signature', 'Signature', startSigning), rb('add_comment', 'Comment', null, { tool: 'note', title: 'Click to add a sticky note (C)' })),
        group('Text style', el('div', { class: 'rstack' }, el('div', { class: 'rrow' }, font, size, rb('format_bold', 'Bold', () => { state.props.bold = !state.props.bold; updateSelectedAnnot({ bold: state.props.bold }); }, { big: false })), swatchRow(SWATCHES, state.props.color, colorPick, 'Text color'))),
      ];
    case 'draw':
      return [
        group('Mark text', rb('ink_highlighter', 'Highlight', null, { tool: 'highlight', title: 'Drag across words (H)' }), rb('format_underlined', 'Underline', null, { tool: 'underline' }), rb('strikethrough_s', 'Strike out', null, { tool: 'strike' })),
        group('Draw', rb('draw', 'Pen', null, { tool: 'draw', title: 'Draw freehand (D)' }), rb('rectangle', 'Box', null, { tool: 'rect' }), rb('circle', 'Circle', null, { tool: 'ellipse' }), rb('arrow_right_alt', 'Arrow', null, { tool: 'arrow' }), rb('horizontal_rule', 'Line', null, { tool: 'line' })),
        group('Color', el('div', { class: 'rstack' }, swatchRow(SWATCHES, state.props.color, colorPick, 'Pen and shape color'), el('div', { class: 'rrow' }, el('span', { class: 'rmini-label' }, 'Highlighter'), swatchRow(HL_SWATCHES, state.props.highlight, (c) => { state.props.highlight = c; updateSelectedAnnot({ color: c }); }, 'Highlighter color')))),
        group('Thickness', el('div', { class: 'rstack' }, thick)),
      ];
    case 'forms':
      return [
        group('New', rb('note_add', 'New form', newFormDialog, { needsDoc: false, title: 'Describe a form and get a finished fillable PDF' })),
        group('Mode', rb('edit_note', 'Fill in', () => (setFormMode('fill'), showPanel('form'))), rb('design_services', 'Edit fields', () => (setFormMode('edit'), showPanel('form')))),
        group('Add a field (click on the page)', rb('text_fields', 'Text', () => fieldTool('text')), rb('check_box', 'Checkbox', () => fieldTool('checkbox')), rb('radio_button_checked', 'Choice', () => fieldTool('radio')), rb('arrow_drop_down_circle', 'Dropdown', () => fieldTool('dropdown')), rb('calendar_month', 'Date', () => fieldTool('date')), rb('signature', 'Sign here', () => fieldTool('signature'))),
        group('Smart', rb('auto_awesome', 'Find fields', async () => { const n = await detectFields(); if (n) toast(`Added ${n} fields.`); showPanel('form'); }), rb('label', 'Name fields', async () => { const n = await autoNameAll(); toast(`Renamed ${n} fields.`); showPanel('form'); }), rb('assignment_turned_in', 'AI fill', () => emitQuickFill())),
        group('Clear', rb('ink_eraser', 'Clear entries', clearFormValues)),
      ];
    case 'pages':
      return [
        group('Fix', rb('auto_fix_high', 'Restore', () => restore.restoreDialog(), { title: 'Make old, crooked, faded or photographed pages look new' })),
        group('Organize', rb('grid_view', 'Organize', openOrganizer), rb('rotate_left', 'Rotate left', () => rotatePages([cur().id], -90)), rb('rotate_right', 'Rotate right', () => rotatePages([cur().id], 90)), rb('delete', 'Delete page', () => deletePages([cur().id]))),
        group('Add', rb('note_add', 'Blank page', () => insertBlank(state.currentPage + 1)), rb('library_add', 'Add file', () => insertFromFiles(state.currentPage + 1)), rb('merge', 'Combine', combineDialog, { needsDoc: false })),
        group('Split', rb('ios_share', 'Extract', extractDialog), rb('call_split', 'Split', splitDialog)),
        group('Save as', rb('description', 'Word', () => exportAs('word')), rb('table_view', 'Excel', () => exportAs('excel')), rb('image', 'Pictures', () => exportAs('png')), rb('compress', 'Smaller', compressDialog)),
      ];
    case 'protect':
      return [
        group(
          'Redact (remove for good)',
          rb('ink_eraser', 'Mark area', protect.startRedactTool, { tool: 'redact', title: 'Drag a box over anything you want removed for good' }),
          rb('manage_search', 'Find & redact', protect.findAndRedactDialog, { title: 'Find names, numbers, SSNs, phone numbers, emails… and mark them' }),
          rb('check_circle', 'Apply redactions', () => protect.applyRedactions(), { title: 'Black out the red boxes and remove what is under them' })
        ),
        group(
          'Password',
          rb(protect.isLocked() ? 'lock' : 'lock_open', protect.isLocked() ? 'Change password' : 'Lock with password', protect.passwordDialog, { title: 'Require a password to open the file' })
        ),
        group(
          'Digital signature',
          rb('verified', 'Sign with ID', protect.signWithDigitalId, { title: 'Sign with a digital ID (certificate). Shows who signed and that nothing changed.' }),
          rb('signature', 'Quick sign', startSigning, { title: 'Place your drawn or typed signature (Fill & Sign)' })
        ),
        group('Privacy', rb('cleaning_services', 'Remove hidden info', protect.removeHiddenInfoDialog, { title: 'Remove author, title, keywords, attachments and scripts when saving' })),
      ];
    case 'ai':
      return [
        group('Assistant', rb('tune', 'Choose AI', () => signInDialog(), { needsDoc: false }), rb('forum', 'Chat', () => showPanel('claude'), { needsDoc: false }), rb('edit', 'Tell it', () => $('#commandInput').focus())),
        group('Read text', rb('document_scanner', 'Read scans', () => runOcr('all')), rb('blur_on', 'Read faded', () => runOcr('all', { deep: true }), { title: 'Extra-careful reading for old, faded, worn or low-contrast pages (slower)' }), rb('crop', 'Grab text', () => pickRegion(grabRegion)), rb('image_search', 'From picture', ocrImageFile, { needsDoc: false })),
        group('Old documents', rb('auto_fix_high', 'Restore', () => restore.restoreDialog(), { title: 'Straighten, turn upright, crop photos, remove yellowing and stains, darken faded text — or retype as a clean new page' })),
        group('Ask', rb('summarize', 'Summarize', () => quickAsk('Summarize')), rb('event', 'Dates & $', () => quickAsk('Dates & amounts')), rb('assignment_turned_in', 'Fill form', () => emitQuickFill())),
        group('Ideas', rb('lightbulb', 'What can I say?', showExamples, { needsDoc: false })),
      ];
  }
  return [];
}

function quickAsk(label) {
  showPanel('claude');
  const chip = [...$$('#claudeChips .chip')].find((c) => c.textContent.includes(label));
  chip && chip.click();
}

function renderRibbon() {
  const tabs = $('#ribbonTabs');
  tabs.replaceChildren(
    ...ribbonTabs().map((t) =>
      el(
        'button',
        {
          class: 'rtab' + (t.id === ribbonTab ? ' active' : ''),
          role: 'tab',
          style: { '--tab': t.color },
          onclick: () => {
            ribbonTab = t.id;
            renderRibbon();
          },
        },
        icon(t.icon),
        t.label
      )
    )
  );
  const color = ribbonTabs().find((t) => t.id === ribbonTab).color;
  const body = $('#ribbon');
  body.style.setProperty('--tab', color);
  body.replaceChildren(...ribbonContent(ribbonTab));
  $$('#ribbon [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === state.tool));
}

function buildRibbon() {
  renderRibbon();
  on('tool', (t) => $$('#ribbon [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t)));
  on('zoom', (z) => {
    const zoom = $('#zoomSel');
    if (!zoom) return;
    if (state.fitMode) zoom.value = state.fitMode;
    else if ([0.5, 0.75, 1, 1.25, 1.5, 2, 3].some((v) => Math.abs(v - z) < 0.001)) zoom.value = String(Math.round(z * 100) / 100);
    else {
      const opt = $('#zoomCustom');
      opt.textContent = Math.round(z * 100) + '%';
      opt.hidden = false;
      zoom.value = 'custom';
    }
  });
  // Clicking a tool on another tab (e.g. shortcut keys) doesn't need the tab to change.
  on('selection', renderContextBar);
  on('annots', renderContextBar);
  on('annotselected', renderContextBar);
}

// ---------------------------------------------------------------------------
// Context bar: quick changes for the selected item
// ---------------------------------------------------------------------------
function renderContextBar() {
  const bar = $('#contextBar');
  const f = findAnnot();
  if (!f || f.annot.type === 'ocrtext') {
    bar.classList.remove('show');
    return;
  }
  const a = f.annot;
  const names = { text: 'Text', highlight: 'Highlight', underline: 'Underline', strike: 'Strike-out', ink: 'Drawing', rect: a.fill === '#ffffff' && !a.stroke ? 'White-out' : 'Box', ellipse: 'Circle', line: 'Line', arrow: 'Arrow', image: 'Picture', note: 'Comment', field: 'Form field' };
  const parts = [el('span', { class: 'ctx-name' }, icon('touch_app'), names[a.type] || 'Item')];
  if (a.type !== 'image' && a.type !== 'field' && !(a.type === 'rect' && a.fill === '#ffffff' && !a.stroke)) {
    const list = a.type === 'highlight' ? HL_SWATCHES : SWATCHES;
    parts.push(swatchRow(list, a.color || a.stroke, (c) => updateSelectedAnnot({ color: c }), 'Color'));
  }
  if (a.type === 'text') {
    const size = el('input', { class: 'rnum', type: 'number', min: 4, max: 96, value: a.size || 12, title: 'Text size' });
    size.addEventListener('change', () => updateSelectedAnnot({ fontSize: Number(size.value) || 12 }));
    size.addEventListener('keydown', (e) => e.stopPropagation());
    parts.push(
      el('button', { class: 'ctx-btn', title: 'Smaller', onclick: () => updateSelectedAnnot({ fontSize: Math.max(4, (a.size || 12) - 2) }) }, icon('text_decrease')),
      size,
      el('button', { class: 'ctx-btn', title: 'Bigger', onclick: () => updateSelectedAnnot({ fontSize: (a.size || 12) + 2 }) }, icon('text_increase')),
      el('button', { class: 'ctx-btn' + (a.bold ? ' on' : ''), title: 'Bold', onclick: () => updateSelectedAnnot({ bold: !a.bold }) }, icon('format_bold'))
    );
  }
  if (['ink', 'rect', 'ellipse', 'line', 'arrow'].includes(a.type) && a.stroke) {
    parts.push(
      el('button', { class: 'ctx-btn', title: 'Thinner', onclick: () => updateSelectedAnnot({ stroke: Math.max(1, (a.width || 2) - 1) }) }, icon('line_weight'), '−'),
      el('button', { class: 'ctx-btn', title: 'Thicker', onclick: () => updateSelectedAnnot({ stroke: (a.width || 2) + 1 }) }, icon('line_weight'), '+')
    );
  }
  if (a.type === 'field') parts.push(el('button', { class: 'ctx-btn wide', onclick: () => showPanel('form') }, icon('tune'), 'Field settings'));
  parts.push(
    el('span', { class: 'ctx-sep' }),
    el('button', { class: 'ctx-btn wide', title: 'Copy it just below (Ctrl+D)', onclick: () => duplicateSelected('down') }, icon('content_copy'), 'Copy'),
    el('button', { class: 'ctx-btn wide danger', title: 'Delete (Del)', onclick: () => deleteSelectedAnnot() }, icon('delete'), 'Delete')
  );
  bar.replaceChildren(...parts);
  bar.style.top = $('#viewer').getBoundingClientRect().top + 10 + 'px';
  bar.classList.add('show');
}

// ---------------------------------------------------------------------------
// "Tell it what to change"
// ---------------------------------------------------------------------------
function engineLabel() {
  const m = aiMode();
  return { local: 'On-device AI', web: 'Claude account', api: 'Claude' }[m] || 'Built-in';
}
function renderEngineChip() {
  const chip = $('#commandEngine');
  chip.replaceChildren(icon(aiMode() ? 'auto_awesome' : 'bolt'), engineLabel());
  chip.onclick = () => (hideCommandPop(), signInDialog());
}

function showCommandPop(content) {
  const pop = $('#commandPop');
  pop.replaceChildren(...[content].flat());
  pop.classList.add('show');
}
function hideCommandPop() {
  $('#commandPop').classList.remove('show');
}

function showExamples() {
  showCommandPop([
    el('div', { class: 'pop-title' }, icon('lightbulb'), 'Things you can type'),
    el(
      'div',
      { class: 'pop-examples' },
      EXAMPLES.map((ex) =>
        el(
          'button',
          {
            class: 'example',
            onclick: () => {
              const input = $('#commandInput');
              input.value = ex;
              input.focus();
              hideCommandPop();
            },
          },
          ex
        )
      )
    ),
    el('div', { class: 'pop-foot' }, 'Simple requests work instantly, for free. Others use the AI you picked (', el('a', { href: '#', onclick: (e) => (e.preventDefault(), hideCommandPop(), signInDialog()) }, engineLabel()), ').'),
  ]);
}

/** Run a command as if typed in the command bar. */
function runQuickCommand(text) {
  $('#commandInput').value = text;
  return runCommand();
}

async function newFormDialog() {
  const box = el('textarea', { class: 'field', rows: 4, placeholder: 'e.g. A gear rental agreement for Dive Moore with customer name, phone, items rented, deposit, date out, date due, damage policy and signature' });
  const body = el(
    'div',
    {},
    el('p', {}, 'Describe the form. You get a finished PDF with real fillable fields you can change afterwards.'),
    box,
    el('p', { class: 'muted small' }, aiMode() ? 'Your AI writes the wording and picks the fields.' : 'Without an AI: list the fields ("…with name, phone, date and signature"), or name a kind of form: waiver, inspection checklist, sign-in sheet, invoice, registration.')
  );
  const r = await dialog({ title: 'Make a new form', body, width: '560px', buttons: [{ label: 'Cancel', value: null }, { label: 'Make it', value: true, primary: true }] });
  if (!r || !box.value.trim()) return;
  let text = box.value.trim();
  if (!/^(create|make|build|design|draft|generate)\b/i.test(text)) text = 'Make ' + text.replace(/^(a|an)\s+/i, 'a ');
  if (!/\b(form|document|sheet|waiver|checklist|invoice|release|application|log|survey|agreement|contract|pdf)\b/i.test(text)) text += ' form';
  return runQuickCommand(text);
}

async function runCommand() {
  const input = $('#commandInput');
  const text = input.value.trim();
  if (!text) return showExamples();
  const parsed = parseWithRules(text);
  if (!state.doc && !parsed.actions.some((a) => a.action === 'create_document') && !aiMode()) return toast('Open a document first, or describe a new one, e.g. "make a waiver form".', { ms: 5000 });
  let actions = parsed.actions;
  let via = 'Built-in';
  // A ready-made form layout is only a fallback: an AI writes one that fits the request.
  if (aiMode() && actions.some((a) => a.action === 'create_document')) actions = [];
  try {
    // Built-in first; if any part of it fails and an AI is chosen, undo that and let the AI do the whole request.
    let builtIn = null;
    if (actions.length && !parsed.unknown.length && aiMode()) {
      const before = state.history.length;
      showCommandPop(el('div', { class: 'pop-working' }, el('div', { class: 'spinner small' }), el('span', {}, 'Making the changes…')));
      builtIn = await runActions(actions, { onNeedSignature: () => signatureDialog(), onNeedLogo: () => newdocui.getLogo({ ask: true }), onNeedImage: () => newdocui.pickImage() });
      if (!(builtIn.length && builtIn.every((r) => r.ok))) {
        if (state.history.length > before) undo();
        builtIn = null;
        actions = [];
      }
    }
    if (!builtIn && (parsed.unknown.length || !actions.length)) {
      const m = aiMode();
      if (!m) {
        showCommandPop([
          el('div', { class: 'pop-title' }, icon('help'), "I didn't understand that yet"),
          el('p', {}, parsed.unknown.length ? `"${parsed.unknown.join('", "')}"` : text),
          el('p', { class: 'muted' }, 'Try wording it like the examples, or choose an AI assistant to handle any request.'),
          el('div', { class: 'pop-actions' }, el('button', { class: 'btn btn-tonal', onclick: showExamples }, icon('lightbulb'), ' Examples'), el('button', { class: 'btn btn-primary', onclick: () => (hideCommandPop(), signInDialog()) }, icon('auto_awesome'), ' Choose AI')),
        ]);
        return;
      }
      showCommandPop(el('div', { class: 'pop-working' }, el('div', { class: 'spinner small' }), el('span', { id: 'popStatus' }, 'Thinking…')));
      const { system, user } = await buildAiPrompt(text, { maxChars: m === 'local' ? 5000 : 40000 });
      let reply;
      if (m === 'local') {
        via = 'On-device AI';
        reply = await localai.askJson(localModelId(), system, user, (p, t) => {
          const st = $('#popStatus');
          if (st) st.textContent = p < 1 ? `Getting the on-device AI ready (first time only)… ${Math.round(p * 100)}%` : 'Thinking…';
        });
      } else if (m === 'api') {
        via = 'Claude';
        reply = await host.askClaude({ model: aiSettings().model || 'claude-sonnet-5-5', max_tokens: 1500, system, messages: [{ role: 'user', content: user }] });
      } else {
        via = 'Claude account';
        await host.sendToClaudeWeb({ text: `${system}\n\n${user}`, hint: "Press Ctrl+V and Enter, then copy Claude's answer." });
        const answer = el('textarea', { class: 'field', rows: 7, placeholder: "Paste Claude's answer here (it starts with { )" });
        hideCommandPop();
        const got = await dialog({
          title: "Paste Claude's answer",
          body: el('div', {}, el('p', { class: 'muted' }, 'Your request was copied and Claude opened. Paste it there (Ctrl+V, Enter), copy all of Claude\'s reply, and paste it below.'), answer),
          width: '560px',
          buttons: [
            { label: 'Cancel', value: null },
            { label: 'Make the changes', value: true, primary: true },
          ],
        });
        if (!got || !answer.value.trim()) return;
        reply = answer.value;
      }
      actions = parseAiReply(reply);
    }
    if (!builtIn && !actions.length) {
      showCommandPop([el('div', { class: 'pop-title' }, icon('help'), 'Nothing to change'), el('p', { class: 'muted' }, 'The request did not turn into any edits. Try saying exactly what to add, remove or move.')]);
      return;
    }
    showCommandPop(el('div', { class: 'pop-working' }, el('div', { class: 'spinner small' }), el('span', {}, 'Making the changes…')));
    const report = builtIn || (await runActions(actions, { onNeedSignature: () => signatureDialog(), onNeedLogo: () => newdocui.getLogo({ ask: true }), onNeedImage: () => newdocui.pickImage() }));
    const okCount = report.filter((r) => r.ok).length;
    input.value = okCount ? '' : input.value;
    showCommandPop([
      el('div', { class: 'pop-title' }, icon(okCount ? 'task_alt' : 'error'), okCount ? 'Done' : "Couldn't do that", el('span', { class: 'pop-via' }, via)),
      el(
        'div',
        { class: 'pop-results' },
        report.map((r) =>
          el(
            'div',
            { class: 'pop-result ' + (r.ok ? 'ok' : 'bad'), onclick: r.page ? () => scrollToPage(state.doc.pages.indexOf(r.page)) : null },
            icon(r.ok ? 'check_circle' : 'cancel'),
            el('span', {}, r.msg)
          )
        )
      ),
      el(
        'div',
        { class: 'pop-actions' },
        okCount ? el('button', { class: 'btn btn-tonal', onclick: () => (undo(), hideCommandPop(), toast('Undone.')) }, icon('undo'), ' Undo') : null,
        el('span', { class: 'muted small' }, okCount ? 'New items are normal: drag to move, double-click text to edit.' : ''),
        el('button', { class: 'btn btn-text', onclick: hideCommandPop }, 'Close')
      ),
    ]);
  } catch (e) {
    console.error(e);
    showCommandPop([
      el('div', { class: 'pop-title' }, icon('error'), 'Something went wrong'),
      el('p', {}, e.message || String(e)),
      el('div', { class: 'pop-actions' }, el('button', { class: 'btn btn-text', onclick: hideCommandPop }, 'Close')),
    ]);
  }
}

function initCommandBar() {
  const input = $('#commandInput');
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      runCommand();
    } else if (e.key === 'Escape') {
      hideCommandPop();
      input.blur();
    }
  });
  input.addEventListener('focus', () => !input.value && state.doc && showExamples());
  $('#commandGo').addEventListener('click', runCommand);
  document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#commandPop, #commandBar, .modal-backdrop')) hideCommandPop();
  });
  renderEngineChip();
  on('aimode', renderEngineChip);
}

// ---------------------------------------------------------------------------
// Side panel, page counter, comments, find
// ---------------------------------------------------------------------------
function showPanel(name) {
  document.body.classList.remove('hide-panel');
  $$('.panel-tab').forEach((t) => t.classList.toggle('active', t.dataset.panel === name));
  $$('.panel-body').forEach((b) => b.classList.toggle('hidden', b.dataset.body !== name));
  if (name === 'form') renderFormPanel();
  if (name === 'comments') renderComments();
  if (name === 'claude') setTimeout(() => $('#claudeInput').focus(), 50);
  if (state.fitMode) setTimeout(() => applyFit(), 50);
}
function togglePanel() {
  document.body.classList.toggle('hide-panel');
  if (state.fitMode) setTimeout(() => applyFit(), 50);
}

function renderPageCounter() {
  const pc = $('#pageCounter');
  if (!state.doc) return pc.replaceChildren();
  const input = el('input', { value: state.currentPage + 1, title: 'Go to page' });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      const n = parseInt(input.value);
      if (n >= 1 && n <= state.doc.pages.length) scrollToPage(n - 1);
      input.blur();
    }
  });
  pc.replaceChildren(
    el('span', {}, 'Page'),
    input,
    el('span', {}, `of ${state.doc.pages.length}`),
    el('button', { class: 'icon-btn small', title: 'Zoom out', onclick: () => setZoom(state.zoom / 1.2) }, icon('remove')),
    el('span', { style: { minWidth: '40px', textAlign: 'center' } }, Math.round(state.zoom * 100) + '%'),
    el('button', { class: 'icon-btn small', title: 'Zoom in', onclick: () => setZoom(state.zoom * 1.2) }, icon('add'))
  );
}

function renderComments() {
  const root = $('#commentsPanel');
  root.replaceChildren();
  if (!state.doc) return;
  const notes = [];
  state.doc.pages.forEach((p, i) => p.annots.forEach((a) => (a.type === 'note' || a.type === 'highlight' || a.type === 'underline' || a.type === 'strike') && notes.push({ a, i, p })));
  if (!notes.length) {
    root.append(el('p', { class: 'muted' }, 'No comments or highlights yet. Use the Comment tool (C) to add a sticky note, or select text and click Highlight.'));
    return;
  }
  for (const { a, i, p } of notes) {
    const label = { note: 'Comment', highlight: 'Highlight', underline: 'Underline', strike: 'Strikeout' }[a.type];
    root.append(
      el(
        'div',
        {
          class: 'comment-card',
          onclick: () => {
            state.selectedAnnot = { pageId: p.id, annotId: a.id };
            emit('selection');
            scrollToPage(i);
          },
        },
        el('div', { class: 'meta' }, icon(a.type === 'note' ? 'chat_bubble' : 'ink_highlighter'), `${label} · page ${i + 1}`, a.author ? ` · ${a.author}` : ''),
        el('div', {}, a.type === 'note' ? a.text || '(empty)' : `“${(a.text || '').slice(0, 200)}”`)
      )
    );
  }
}

// Find
let findHits = [];
let findIdx = -1;
const textCache = new Map();
function openFind() {
  if (!state.doc) return;
  $('#findBar').style.top = $('#viewer').getBoundingClientRect().top + 10 + 'px';
  $('#findBar').classList.add('show');
  $('#findInput').focus();
  $('#findInput').select();
}
function closeFind() {
  $('#findBar').classList.remove('show');
  state.searchQuery = '';
  refreshSearchHighlights();
}
const runFind = debounce(async () => {
  const q = $('#findInput').value.trim().toLowerCase();
  state.searchQuery = q;
  findHits = [];
  findIdx = -1;
  if (q) {
    for (let i = 0; i < state.doc.pages.length; i++) {
      const p = state.doc.pages[i];
      const key = p.src + ':' + p.index + ':' + (p.ocrText ? 1 : 0);
      if (!textCache.has(key)) textCache.set(key, (await getPageText(state.doc, p)).toLowerCase());
      const t = textCache.get(key);
      let at = t.indexOf(q);
      while (at >= 0) {
        findHits.push(i);
        at = t.indexOf(q, at + q.length);
      }
    }
  }
  $('#findCount').textContent = q ? (findHits.length ? `${findHits.length} found` : 'No results') : '';
  refreshSearchHighlights();
  if (findHits.length) stepFind(1);
}, 250);
function stepFind(dir) {
  if (!findHits.length) return;
  findIdx = (findIdx + dir + findHits.length) % findHits.length;
  $('#findCount').textContent = `${findIdx + 1} of ${findHits.length}`;
  scrollToPage(findHits[findIdx]);
}

// ---------------------------------------------------------------------------
// Start screen
// ---------------------------------------------------------------------------
async function renderStart() {
  const root = $('#startScreen');
  const tile = (ic, color, label, sub, fn) =>
    el('button', { class: 'start-tile', onclick: fn }, el('div', { class: 'tile-art' }, el('span', { class: 'ms', style: { color } }, ic)), el('div', { class: 'tile-label' }, label), el('div', { class: 'tile-sub' }, sub));
  const recent = await host.getRecentFiles().catch(() => []);
  root.replaceChildren(
    el(
      'div',
      { class: 'start-hero' },
      el('img', { class: 'app-logo', src: 'img/app.png', alt: '', style: { width: '64px', height: '64px' } }),
      el('div', {}, el('h1', {}, 'PDF and Moore'), el('p', {}, 'Open, edit, sign, fill and convert PDFs, with Claude built in.'))
    ),
    el('h2', {}, 'Start something'),
    el(
      'div',
      { class: 'start-tiles' },
      tile('folder_open', '#0b57d0', 'Open a file', 'PDF, Word, Excel, images, and more', openDialog),
      tile('note_add', '#188038', 'Blank PDF', 'Start from an empty page', newBlank),
      tile('merge', '#9334e6', 'Combine files', 'Merge several files into one PDF', combineDialog),
      tile('auto_awesome', '#e37400', 'Make a form from a description', 'Describe it; get a finished fillable PDF', newFormDialog),
      tile('assignment', '#188038', 'Make a PDF fillable', 'Open a PDF, then add fields', async () => {
        await openDialog();
        if (state.doc) {
          setFormMode('edit');
          showPanel('form');
        }
      }),
      tile('document_scanner', '#d93025', 'Text from a picture', 'Read text, even upside down, crooked or faded', ocrImageFile),
      tile('auto_fix_high', '#9334e6', 'Restore an old document', 'Scan or photo: straighten, clean, make it look new', async () => {
        await openDialog();
        if (state.doc) restore.restoreDialog();
      })
    ),
    el('h2', {}, 'Recent files'),
    recent && recent.length
      ? el(
          'div',
          { class: 'recent-list' },
          recent.map((p) => el('button', { class: 'recent-row', onclick: () => openPath(p) }, icon('picture_as_pdf'), el('span', {}, p.split(/[\\/]/).pop()), el('span', { class: 'path' }, p)))
        )
      : el('p', { class: 'muted' }, 'Files you open will show up here. You can also drag files onto this window.')
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
function shortcutsDialog() {
  const rows = [
    ['Ctrl+O', 'Open'], ['Ctrl+S', 'Save'], ['Ctrl+Shift+S', 'Save as'], ['Ctrl+P', 'Print'], ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
    ['Ctrl+F', 'Find'], ['Ctrl+J', 'Show/hide side panel (Claude)'], ['Ctrl + mouse wheel', 'Zoom'], ['Ctrl+0', 'Actual size'],
    ['V', 'Select'], ['T', 'Add text'], ['E', 'Edit existing text'], ['H', 'Highlight'], ['U', 'Underline'], ['D', 'Draw'],
    ['R', 'Rectangle'], ['A', 'Arrow'], ['L', 'Line'], ['W', 'Whiteout'], ['C', 'Comment'], ['G', 'Grab text from an area'],
    ['Delete', 'Delete selected item'], ['Ctrl+D', 'Copy selected item below it'], ['Arrow keys', 'Nudge selected item (Shift = bigger steps)'], ['Esc', 'Back to Select'],
  ];
  dialog({
    title: 'Keyboard shortcuts',
    width: '520px',
    body: el('table', { style: { width: '100%', borderCollapse: 'collapse' } }, rows.map(([k, v]) => el('tr', {}, el('td', { style: { padding: '4px 12px 4px 0', fontWeight: 600, whiteSpace: 'nowrap' } }, k), el('td', {}, v)))),
  });
}
function aboutDialog() {
  dialog({
    title: 'PDF and Moore',
    body: el(
      'div',
      {},
      el('p', {}, 'A PDF editor with Google Docs–style controls and Claude as your assistant.'),
      el('p', { class: 'muted' }, 'Built with PDF.js (Mozilla), pdf-lib, Tesseract OCR, Mammoth, SheetJS and docx. Word editor: SuperDoc (AGPL-3.0). Spreadsheet editor: FortuneSheet and FortuneExcel (MIT). Slide editor: pptxtojson and PptxGenJS (MIT). Windows app: C# / WPF with Microsoft Edge WebView2.')
    ),
  });
}

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------
function typingInField(e) {
  const t = e.target;
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}

function onKey(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl && k === 'o') return e.preventDefault(), openDialog();
  if (ctrl && k === 's') return e.preventDefault(), save(e.shiftKey);
  if (ctrl && k === 'p') return e.preventDefault(), printDoc();
  if (ctrl && k === 'j') return e.preventDefault(), togglePanel();
  if (ctrl && k === 'f') return e.preventDefault(), openFind();
  if (ctrl && k === '/') return e.preventDefault(), shortcutsDialog();
  if (ctrl && (k === '=' || k === '+')) return e.preventDefault(), setZoom(state.zoom * 1.2);
  if (ctrl && k === '-') return e.preventDefault(), setZoom(state.zoom / 1.2);
  if (ctrl && k === '0') return e.preventDefault(), setZoom(1);
  if (typingInField(e)) return;
  if (ctrl && k === 'z') return e.preventDefault(), e.shiftKey ? redo() : undo();
  if (ctrl && k === 'y') return e.preventDefault(), redo();
  if (ctrl && k === 'd') return e.preventDefault(), duplicateSelected('down');
  if (!state.doc) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (deleteSelectedAnnot()) e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    hideSelectionMenu();
    closeFind();
    if (state.tool !== 'select') setTool('select');
    else if (state.selectedAnnot) {
      state.selectedAnnot = null;
      emit('selection');
    }
    return;
  }
  if (e.key.startsWith('Arrow') && state.selectedAnnot) {
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (nudgeSelected(d[0] * cssScale(), d[1] * cssScale())) e.preventDefault();
    return;
  }
  if (ctrl || e.altKey) return;
  const map = { v: 'select', t: 'text', e: 'edittext', h: 'highlight', u: 'underline', d: 'draw', r: 'rect', a: 'arrow', l: 'line', w: 'whiteout', c: 'note', m: 'lines' };
  if (map[k]) return setTool(map[k]);
  if (k === 'g') return pickRegion(grabRegion);
  if (e.key === '/' || (k === 'k' && ctrl)) {
    e.preventDefault();
    return $('#commandInput').focus();
  }
  if (e.key === ' ' && state.tool === 'select') {
    e.preventDefault();
    setTool('hand');
    const up = (ev) => {
      if (ev.key === ' ') {
        setTool('select');
        window.removeEventListener('keyup', up);
      }
    };
    window.addEventListener('keyup', up);
  }
}

// ---------------------------------------------------------------------------
// Drag & drop files onto the window
// ---------------------------------------------------------------------------
function initDrop() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    depth++;
    document.body.classList.add('dragging-files');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dragging-files');
  });
  window.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging-files');
    const files = [];
    for (const f of e.dataTransfer.files) files.push({ name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) });
    if (state.doc) {
      const r = await dialog({
        title: 'Open dropped files',
        body: `Add ${files.length === 1 ? files[0].name : files.length + ' files'} to this document, or open as a new document?`,
        buttons: [
          { label: 'Cancel', value: null },
          { label: 'Open as new', value: 'new' },
          { label: 'Add to this PDF', value: 'add', primary: true },
        ],
      });
      if (r === 'add') return insertFiles(files, state.currentPage + 1);
      if (r !== 'new') return;
    }
    openFiles(files);
  });
}

// ---------------------------------------------------------------------------
// Start up
// ---------------------------------------------------------------------------
async function main() {
  initViewer($('#viewer'));
  initThumbnails();
  initForms();
  protect.initProtect();
  on('protection', () => ribbonTab === 'protect' && renderRibbon());
  await initClaude();
  buildMenubar();
  buildRibbon();
  initCommandBar();
  initDrop();
  renderStart();
  document.addEventListener('keydown', onKey);

  on('addfield', ({ page, kind, box, dragged }) => addField(page, kind, box, { dragged }));
  on('dirty', updateTitle);
  on('pagechange', renderPageCounter);
  on('zoom', renderPageCounter);
  on('structure', renderPageCounter);
  on('annots', () => !$('[data-body="comments"]').classList.contains('hidden') && renderComments());
  on('comments', renderComments);
  on('panel', showPanel);
  on('structure', () => textCache.clear());

  $('#btnSave').addEventListener('click', () => save(false));
  $('#btnSettings').addEventListener('click', settingsDialog);
  $('#btnClaudeTop').addEventListener('click', () => showPanel('claude'));
  $('#btnOrganize').addEventListener('click', openOrganizer);
  $('#btnClosePanel').addEventListener('click', togglePanel);
  $$('.panel-tab').forEach((t) => t.addEventListener('click', () => showPanel(t.dataset.panel)));
  $('#docTitle').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') e.target.blur();
  });
  $('#docTitle').addEventListener('change', () => {
    if (!state.doc) return;
    state.doc.name = docFileName('pdf');
    state.doc.path = null; // a new name means "save as a new file"
    state.doc.dirty = true;
    updateTitle();
  });
  $('#findInput').addEventListener('input', runFind);
  $('#findInput').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') stepFind(e.shiftKey ? -1 : 1);
    if (e.key === 'Escape') closeFind();
  });
  $('#findNext').addEventListener('click', () => stepFind(1));
  $('#findPrev').addEventListener('click', () => stepFind(-1));
  $('#findClose').addEventListener('click', closeFind);
  $$('#selMenu button').forEach((b) =>
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const act = b.dataset.act;
      if (act === 'copy') {
        navigator.clipboard.writeText(getSelectedText());
        toast('Copied.');
        hideSelectionMenu();
      } else if (act === 'claude') {
        const text = getSelectedText();
        hideSelectionMenu();
        emit('claude:ask', { prompt: `About this part of the document:\n"""${text}"""\n\n` });
      } else markupSelection(act);
    })
  );

  // Messages from the Windows app (files opened from Explorer, "Open with", closing with unsaved changes).
  host.onHostEvent('openPath', (p) => openPath(p));
  host.onHostEvent('openPathAsPdf', (p) => openPath(p, { asPdf: true }));
  host.onHostEvent('saveBeforeClose', async () => {
    const ok = await save(false);
    if (ok) host.setDirty(false, APP);
    else host.cancelClose();
  });
  window.addEventListener('beforeunload', (e) => {
    if (!host.isHosted && state.doc && state.doc.dirty) e.preventDefault();
  });
  host.notifyReady();
  setTool('select');
  window.pdfAndMoore = { state, openFiles, save, buildPdf: () => buildPdf(state.doc), runOcr, setFormMode, detectFields, autoNameAll, renderPageToCanvas, protect };
}

main().catch((e) => {
  console.error(e);
  toast('Start-up error: ' + e.message, { error: true, ms: 10000 });
});
