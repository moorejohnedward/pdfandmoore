// Page thumbnails, the Organize Pages view, and every page-level operation:
// rotate, delete, move, duplicate, insert (blank / from files), extract and split.
import { state, on, emit, checkpoint, changed } from './state.js';
import { renderPageToCanvas, loadSource, pagesForSource, buildPdf, blankPdfBytes, totalRotation } from './doc.js';
import { el, icon, $, uid, toast, busy, busyProgress, dialog, baseName, promptDialog } from './util.js';
import { scrollToPage } from './viewer.js';
import { openFiles, saveFile } from './host.js';
import { fileToPdf } from './convert.js';

const thumbCache = new Map(); // key -> dataURL
let thumbObserver;
let organizeSelection = new Set();

function thumbKey(page) {
  return `${page.src}:${page.index}:${totalRotation(page)}`;
}

async function drawThumb(page, img, width) {
  const key = thumbKey(page) + ':' + width;
  if (thumbCache.has(key)) {
    img.src = thumbCache.get(key);
    return;
  }
  const scale = width / (totalRotation(page) % 180 === 0 ? page.w : page.h);
  const { canvas } = await renderPageToCanvas(state.doc, page, scale);
  const url = canvas.toDataURL('image/jpeg', 0.8);
  thumbCache.set(key, url);
  img.src = url;
}

function lazyThumbs(root) {
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const img = en.target;
        const page = state.doc && state.doc.pages.find((p) => p.id === img.dataset.pageId);
        if (page && !img.dataset.done) {
          img.dataset.done = '1';
          drawThumb(page, img, Number(img.dataset.w)).catch(() => {});
        }
        thumbObserver.unobserve(img);
      }
    },
    { root, rootMargin: '300px' }
  );
}

// ---------------------------------------------------------------------------
// Sidebar thumbnails
// ---------------------------------------------------------------------------
export function initThumbnails() {
  on('structure', renderThumbnails);
  on('docopen', renderThumbnails);
  on('pagechange', (i) => {
    document.querySelectorAll('#thumbs .thumb').forEach((t, n) => t.classList.toggle('current', n === i));
    const cur = document.querySelectorAll('#thumbs .thumb')[i];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  });
}

let dragFrom = null;

export function renderThumbnails() {
  const root = $('#thumbs');
  if (!root) return;
  root.replaceChildren();
  if (!state.doc) return;
  lazyThumbs(root);
  state.doc.pages.forEach((page, i) => {
    const img = el('img', { class: 'thumb-img', 'data-page-id': page.id, 'data-w': 140, alt: `Page ${i + 1}` });
    const t = el(
      'div',
      { class: 'thumb' + (i === state.currentPage ? ' current' : ''), draggable: 'true', title: `Page ${i + 1}` },
      el('div', { class: 'thumb-frame' }, img),
      el('div', { class: 'thumb-num' }, String(i + 1))
    );
    t.addEventListener('click', () => scrollToPage(i));
    t.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      pageContextMenu(e.clientX, e.clientY, [page.id]);
    });
    t.addEventListener('dragstart', (e) => {
      dragFrom = i;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    });
    t.addEventListener('dragover', (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      const r = t.getBoundingClientRect();
      t.classList.toggle('drop-before', e.clientY < r.top + r.height / 2);
      t.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2);
    });
    t.addEventListener('dragleave', () => t.classList.remove('drop-before', 'drop-after'));
    t.addEventListener('drop', (e) => {
      e.preventDefault();
      t.classList.remove('drop-before', 'drop-after');
      if (dragFrom === null) return;
      const r = t.getBoundingClientRect();
      let to = e.clientY < r.top + r.height / 2 ? i : i + 1;
      movePages([state.doc.pages[dragFrom].id], to);
      dragFrom = null;
    });
    t.addEventListener('dragend', () => (dragFrom = null));
    root.append(t);
    thumbObserver.observe(img);
  });
}

function pageContextMenu(x, y, ids) {
  const items = [
    ['rotate_left', 'Rotate left', () => rotatePages(ids, -90)],
    ['rotate_right', 'Rotate right', () => rotatePages(ids, 90)],
    ['content_copy', 'Duplicate', () => duplicatePages(ids)],
    ['note_add', 'Insert blank page after', () => insertBlank(state.doc.pages.findIndex((p) => p.id === ids[ids.length - 1]) + 1)],
    ['file_open', 'Insert pages from file after…', () => insertFromFiles(state.doc.pages.findIndex((p) => p.id === ids[ids.length - 1]) + 1)],
    ['ios_share', 'Extract to new PDF…', () => extractPages(ids)],
    ['delete', 'Delete', () => deletePages(ids)],
  ];
  showMenu(x, y, items);
}

export function showMenu(x, y, items) {
  document.querySelectorAll('.context-menu').forEach((m) => m.remove());
  const menu = el(
    'div',
    { class: 'context-menu menu-pop', style: { left: x + 'px', top: y + 'px' } },
    items.map(([ic, label, fn]) =>
      el(
        'button',
        {
          class: 'menu-item',
          onclick: () => {
            menu.remove();
            fn();
          },
        },
        icon(ic),
        el('span', {}, label)
      )
    )
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  if (r.bottom > window.innerHeight) menu.style.top = Math.max(8, window.innerHeight - r.height - 8) + 'px';
  if (r.right > window.innerWidth) menu.style.left = Math.max(8, window.innerWidth - r.width - 8) + 'px';
  setTimeout(() => document.addEventListener('mousedown', function close(e) {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('mousedown', close);
    }
  }), 0);
}

// ---------------------------------------------------------------------------
// Page operations
// ---------------------------------------------------------------------------
export function rotatePages(ids, deg) {
  checkpoint();
  for (const p of state.doc.pages) if (ids.includes(p.id)) p.rotate = (((p.rotate + deg) % 360) + 360) % 360;
  changed({ structure: true });
}

export async function deletePages(ids) {
  if (ids.length >= state.doc.pages.length) {
    toast('A PDF needs at least one page.', { error: true });
    return;
  }
  checkpoint();
  state.doc.pages = state.doc.pages.filter((p) => !ids.includes(p.id));
  ids.forEach((id) => organizeSelection.delete(id));
  changed({ structure: true });
  toast(`Deleted ${ids.length} page${ids.length === 1 ? '' : 's'}. Press Ctrl+Z to undo.`);
}

export function movePages(ids, toIndex) {
  checkpoint();
  const moving = state.doc.pages.filter((p) => ids.includes(p.id));
  const before = state.doc.pages.slice(0, toIndex).filter((p) => !ids.includes(p.id));
  const after = state.doc.pages.slice(toIndex).filter((p) => !ids.includes(p.id));
  state.doc.pages = [...before, ...moving, ...after];
  changed({ structure: true });
}

export function duplicatePages(ids) {
  checkpoint();
  const out = [];
  for (const p of state.doc.pages) {
    out.push(p);
    if (ids.includes(p.id)) out.push({ ...JSON.parse(JSON.stringify(p)), id: uid(), annots: p.annots.map((a) => ({ ...JSON.parse(JSON.stringify(a)), id: uid() })) });
  }
  state.doc.pages = out;
  changed({ structure: true });
}

export async function insertBlank(at) {
  const ref = state.doc.pages[Math.max(0, at - 1)] || state.doc.pages[0];
  const { PDFDocument } = window.PDFLib;
  const d = await PDFDocument.create();
  d.addPage(ref ? [ref.w, ref.h] : [612, 792]);
  const source = await loadSource(await d.save(), 'blank page');
  state.doc.sources.push(source);
  const pages = await pagesForSource(source);
  checkpoint();
  state.doc.pages.splice(at, 0, ...pages);
  changed({ structure: true });
  setTimeout(() => scrollToPage(at), 50);
}

/** Add the pages of other files (any supported type) into this document. */
export async function insertFiles(files, at = state.doc.pages.length) {
  busy('Adding files…');
  let added = 0;
  try {
    const newPages = [];
    for (let i = 0; i < files.length; i++) {
      busyProgress(i / files.length, `Adding ${files[i].name}…`);
      const pdfBytes = await fileToPdf(files[i]);
      const source = await loadSource(pdfBytes, files[i].name);
      state.doc.sources.push(source);
      newPages.push(...(await pagesForSource(source)));
    }
    checkpoint();
    state.doc.pages.splice(at, 0, ...newPages);
    added = newPages.length;
    changed({ structure: true });
  } catch (e) {
    toast(e.message, { error: true, ms: 6000 });
  } finally {
    busy(false);
  }
  if (added) toast(`Added ${added} page${added === 1 ? '' : 's'}.`);
  return added;
}

export async function insertFromFiles(at = state.doc.pages.length) {
  const files = await openFiles({ multiple: true });
  if (files.length) await insertFiles(files, at);
}

export async function extractPages(ids, { remove = false } = {}) {
  busy('Creating new PDF…');
  try {
    const { bytes } = await buildPdf(state.doc, { pageIds: ids });
    busy(false);
    const name = `${baseName(state.doc.name)} (pages ${describeRange(ids)}).pdf`;
    const saved = await saveFile({ name, bytes, mime: 'application/pdf' });
    if (saved) {
      toast('Saved ' + name);
      if (remove) deletePages(ids);
    }
  } finally {
    busy(false);
  }
}

function describeRange(ids) {
  const nums = state.doc.pages.map((p, i) => (ids.includes(p.id) ? i + 1 : null)).filter(Boolean);
  const parts = [];
  let start = nums[0];
  let prev = nums[0];
  for (const n of nums.slice(1).concat([null])) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = n;
  }
  return parts.join(',');
}

/** Parse "1-3, 5, 8-" style page ranges (1-based) into page indexes. */
export function parseRanges(text, count) {
  const out = [];
  for (const part of String(text).split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^(\d*)\s*-\s*(\d*)$/);
    if (m) {
      const a = m[1] ? parseInt(m[1]) : 1;
      const b = m[2] ? parseInt(m[2]) : count;
      for (let i = a; i <= b; i++) if (i >= 1 && i <= count) out.push(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part);
      if (n >= 1 && n <= count) out.push(n - 1);
    }
  }
  return out;
}

export async function splitDialog() {
  const count = state.doc.pages.length;
  const every = el('input', { class: 'field', type: 'number', min: 1, max: count, value: 1 });
  const ranges = el('input', { class: 'field', placeholder: 'e.g. 1-3, 4-6, 7-' });
  const modeEvery = el('input', { type: 'radio', name: 'splitmode', checked: true });
  const modeRanges = el('input', { type: 'radio', name: 'splitmode' });
  const body = el(
    'div',
    { class: 'stack' },
    el('label', { class: 'check-label' }, modeEvery, ' Every ', every, ' page(s)'),
    el('label', { class: 'check-label' }, modeRanges, ' By page ranges: ', ranges),
    el('p', { class: 'muted' }, 'The parts are saved together in one .zip file.')
  );
  const ok = await dialog({ title: `Split into separate PDFs (${count} pages)`, body, buttons: [{ label: 'Cancel', value: null }, { label: 'Split', value: true, primary: true }] });
  if (!ok) return;
  let groups = [];
  if (modeEvery.checked) {
    const n = Math.max(1, parseInt(every.value) || 1);
    for (let i = 0; i < count; i += n) groups.push(state.doc.pages.slice(i, i + n).map((p) => p.id));
  } else {
    for (const part of ranges.value.split(',')) {
      const idx = parseRanges(part, count);
      if (idx.length) groups.push(idx.map((i) => state.doc.pages[i].id));
    }
  }
  if (!groups.length) return toast('No pages matched those ranges.', { error: true });
  busy('Splitting…');
  try {
    const zip = new window.JSZip();
    for (let g = 0; g < groups.length; g++) {
      busyProgress(g / groups.length);
      const { bytes } = await buildPdf(state.doc, { pageIds: groups[g] });
      zip.file(`${baseName(state.doc.name)} - part ${g + 1} (pages ${describeRange(groups[g])}).pdf`, bytes);
    }
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    busy(false);
    const saved = await saveFile({ name: `${baseName(state.doc.name)} - split.zip`, bytes, mime: 'application/zip' });
    if (saved) toast(`Split into ${groups.length} PDFs.`);
  } finally {
    busy(false);
  }
}

// ---------------------------------------------------------------------------
// Organize Pages view (big grid)
// ---------------------------------------------------------------------------
export function openOrganizer() {
  if (!state.doc) return;
  organizeSelection = new Set();
  document.body.classList.add('organizing');
  renderOrganizer();
}
export function closeOrganizer() {
  document.body.classList.remove('organizing');
  $('#organizer').replaceChildren();
}
on('structure', () => document.body.classList.contains('organizing') && renderOrganizer());

function renderOrganizer() {
  const root = $('#organizer');
  root.replaceChildren();
  const sel = () => [...organizeSelection];
  const need = (fn) => () => (organizeSelection.size ? fn() : toast('Select one or more pages first (click a page, Shift-click for a range).'));
  const bar = el(
    'div',
    { class: 'org-bar' },
    el('div', { class: 'org-title' }, icon('grid_view'), ' Organize pages'),
    el('span', { class: 'muted org-count' }, organizeSelection.size ? `${organizeSelection.size} selected` : `${state.doc.pages.length} pages`),
    el('div', { class: 'grow' }),
    tbBtn('select_all', 'Select all', () => {
      organizeSelection = new Set(state.doc.pages.map((p) => p.id));
      renderOrganizer();
    }),
    tbBtn('rotate_left', 'Rotate left', need(() => rotatePages(sel(), -90))),
    tbBtn('rotate_right', 'Rotate right', need(() => rotatePages(sel(), 90))),
    tbBtn('content_copy', 'Duplicate', need(() => duplicatePages(sel()))),
    tbBtn('delete', 'Delete', need(() => deletePages(sel()))),
    tbBtn('ios_share', 'Extract', need(() => extractPages(sel()))),
    tbBtn('note_add', 'Insert blank', () => insertBlank(lastSelectedIndex() + 1)),
    tbBtn('library_add', 'Insert from file', () => insertFromFiles(lastSelectedIndex() + 1)),
    tbBtn('call_split', 'Split', () => splitDialog()),
    el('button', { class: 'btn btn-primary', onclick: closeOrganizer }, 'Done')
  );
  const grid = el('div', { class: 'org-grid' });
  lazyThumbs(grid);
  let lastClicked = null;
  state.doc.pages.forEach((page, i) => {
    const img = el('img', { class: 'thumb-img', 'data-page-id': page.id, 'data-w': 190 });
    const card = el(
      'div',
      { class: 'org-card' + (organizeSelection.has(page.id) ? ' selected' : ''), draggable: 'true' },
      el('div', { class: 'thumb-frame' }, img),
      el(
        'div',
        { class: 'org-card-bar' },
        el('span', {}, String(i + 1)),
        el(
          'span',
          { class: 'org-mini' },
          miniBtn('rotate_right', 'Rotate', () => rotatePages([page.id], 90)),
          miniBtn('delete', 'Delete', () => deletePages([page.id]))
        )
      )
    );
    card.addEventListener('click', (e) => {
      if (e.target.closest('.org-mini')) return;
      if (e.shiftKey && lastClicked !== null) {
        const [a, b] = [Math.min(lastClicked, i), Math.max(lastClicked, i)];
        for (let k = a; k <= b; k++) organizeSelection.add(state.doc.pages[k].id);
      } else if (e.ctrlKey || e.metaKey) {
        organizeSelection.has(page.id) ? organizeSelection.delete(page.id) : organizeSelection.add(page.id);
      } else {
        organizeSelection = new Set([page.id]);
      }
      lastClicked = i;
      renderOrganizer();
    });
    card.addEventListener('dblclick', () => {
      closeOrganizer();
      setTimeout(() => scrollToPage(i, { smooth: false }), 50);
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!organizeSelection.has(page.id)) organizeSelection = new Set([page.id]);
      pageContextMenu(e.clientX, e.clientY, sel());
    });
    card.addEventListener('dragstart', (e) => {
      if (!organizeSelection.has(page.id)) organizeSelection = new Set([page.id]);
      e.dataTransfer.setData('text/plain', 'pages');
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      const r = card.getBoundingClientRect();
      card.classList.toggle('drop-before', e.clientX < r.left + r.width / 2);
      card.classList.toggle('drop-after', e.clientX >= r.left + r.width / 2);
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-before', 'drop-after'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const r = card.getBoundingClientRect();
      card.classList.remove('drop-before', 'drop-after');
      if (e.dataTransfer.files && e.dataTransfer.files.length) return; // handled by the window drop handler
      movePages(sel(), e.clientX < r.left + r.width / 2 ? i : i + 1);
    });
    grid.append(card);
    thumbObserver.observe(img);
  });
  root.append(bar, grid);
}

function lastSelectedIndex() {
  let last = state.doc.pages.length - 1;
  if (organizeSelection.size) last = Math.max(...state.doc.pages.map((p, i) => (organizeSelection.has(p.id) ? i : -1)));
  return last;
}

function tbBtn(ic, label, fn) {
  return el('button', { class: 'tb-btn labeled', title: label, onclick: fn }, icon(ic), el('span', {}, label));
}
function miniBtn(ic, label, fn) {
  return el('button', { class: 'mini-btn', title: label, onclick: (e) => (e.stopPropagation(), fn()) }, icon(ic));
}

export { blankPdfBytes, promptDialog, emit };
