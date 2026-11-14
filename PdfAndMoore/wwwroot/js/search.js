// Permanent search bar (v9.4): one box at the top of the window that is always there, in Documents and in Mail.
//
// Documents: finds words in the open document as you type (Enter = next, Shift+Enter = previous),
//            and the drop-down also offers your mail and recent files that match.
// Mail:      narrows the emails on screen as you type; Enter searches all mail on the server
//            (Gmail search words work: from:tim, has:attachment, older_than:1y).
//            The drop-down also offers the open document and recent files.
//
// app.js passes in what the box needs, so this file doesn't reach into the document or mail code.

import { el, icon, $ } from './util.js';
import * as host from './host.js';

let api = null; // set by initSearch
let pick = -1; // highlighted row in the drop-down (-1 = none: Enter does the default)
let items = []; // rows in the drop-down: { icon, color, label, sub, run }
let recent = [];
let recentAt = 0;

const input = () => $('#gsInput');
const pop = () => $('#gsPop');
const query = () => (input()?.value || '').trim();
const fileName = (p) => p.split(/[\\/]/).pop();

/**
 * api = {
 *   app(): 'docs' | 'mail',  setApp(app),
 *   doc: { name(): string|null, find(q): Promise<count>, step(dir), position(): {at, total}, clear() },
 *   mail: { filter(q), searchAll(q), countLoaded(q): number, ready(): boolean },
 *   openPath(path),
 * }
 */
export function initSearch(a) {
  api = a;
  const box = input();

  box.addEventListener('input', () => {
    pick = -1;
    runLive();
  });
  box.addEventListener('focus', () => {
    loadRecent();
    renderPop();
  });
  box.addEventListener('blur', () => setTimeout(hidePop, 150));
  box.addEventListener('keydown', onKey);

  $('#gsPrev').addEventListener('mousedown', (e) => (e.preventDefault(), api.doc.step(-1), renderCount()));
  $('#gsNext').addEventListener('mousedown', (e) => (e.preventDefault(), api.doc.step(1), renderCount()));
  $('#gsClear').addEventListener('mousedown', (e) => {
    e.preventDefault();
    clear();
    box.focus();
  });

  // Mail changed its own search (for example "Back to inbox"): keep the box in step.
  window.addEventListener('pam:mailsearch', (e) => {
    if (api.app() !== 'mail') return;
    box.value = e.detail || '';
    renderCount();
  });

  update();
}

/** Ctrl+F (and the Find button): put the cursor in the search box. */
export function focusSearch() {
  const box = input();
  if (!box) return;
  box.focus();
  box.select();
}

/** Called when the user switches between Documents and Mail: the same words carry over. */
export function appChanged() {
  update();
  runLive();
}

/** Called when a document opens or closes. */
export function docChanged() {
  update();
  if (api.app() === 'docs') runLive();
}

function clear() {
  input().value = '';
  pick = -1;
  api.doc.clear();
  if (api.app() === 'mail') api.mail.filter('');
  renderCount();
  renderPop();
}

// ---------------------------------------------------------------------------
// Live search as you type
// ---------------------------------------------------------------------------
let liveTimer = null;
let liveRun = 0;
let liveDone = Promise.resolve();
let liveBusy = false;
function runLive() {
  clearTimeout(liveTimer);
  const q = query();
  renderCount(q ? '…' : '');
  renderPop();
  liveTimer = setTimeout(doLive, 220);
}
/** Runs the search now (also used by Enter, so it never steps through an old result). */
function doLive() {
  clearTimeout(liveTimer);
  liveTimer = null;
  const q = query();
  const run = ++liveRun;
  liveBusy = true;
  liveDone = (async () => {
    try {
      if (api.app() === 'mail') api.mail.filter(q);
      else if (api.doc.name()) await api.doc.find(q);
    } finally {
      if (run === liveRun) liveBusy = false;
    }
    if (run !== liveRun) return;
    renderCount();
    renderPop();
  })();
  return liveDone;
}

function onKey(e) {
  e.stopPropagation(); // typing here never triggers the editor's own shortcuts
  const q = query();
  if (e.key === 'Escape') {
    e.preventDefault();
    if (q) clear();
    else input().blur();
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!items.length) return;
    e.preventDefault();
    pick = e.key === 'ArrowDown' ? Math.min(items.length - 1, pick + 1) : Math.max(-1, pick - 1);
    renderPop();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && /^[12]$/.test(e.key)) {
    // Ctrl+1 / Ctrl+2 still switch apps while typing here.
    e.preventDefault();
    api.setApp(e.key === '1' ? 'docs' : 'mail');
    return;
  }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  if (pick >= 0 && items[pick]) return runItem(items[pick]);
  if (!q) return;
  if (api.app() === 'mail') {
    hidePop();
    api.mail.searchAll(q);
  } else if (api.doc.name()) {
    // A search for new words jumps to the first match by itself; after that Enter goes to the next one.
    if (liveTimer) doLive();
    else if (liveBusy) liveDone.then(renderCount);
    else {
      api.doc.step(e.shiftKey ? -1 : 1);
      renderCount();
    }
  } else if (items[0]) {
    runItem(items[0]);
  }
}

function runItem(it) {
  hidePop();
  pick = -1;
  it.run();
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
function update() {
  const mail = api.app() === 'mail';
  const box = input();
  box.placeholder = mail
    ? 'Search mail…  Enter searches all mail (from:tim, has:attachment)'
    : api.doc.name()
      ? 'Search this document and your mail  (Ctrl+F)'
      : 'Search your mail and recent files  (Ctrl+F)';
  $('#globalSearch').dataset.app = mail ? 'mail' : 'docs';
}

function renderCount(text) {
  const q = query();
  const count = $('#gsCount');
  const docMode = api.app() === 'docs' && !!api.doc.name();
  let t = text;
  if (t === undefined) {
    if (!q) t = '';
    else if (docMode) {
      const { at, total } = api.doc.position();
      t = total ? (at ? `${at} of ${total}` : `${total} found`) : 'None here';
    } else if (api.app() === 'mail') {
      const n = api.mail.countLoaded(q);
      t = n ? `${n} on screen` : 'Enter = all mail';
    } else t = '';
  }
  count.textContent = t;
  $('#globalSearch').classList.toggle('has-text', !!q);
  $('#globalSearch').classList.toggle('doc-mode', docMode && !!q);
}

async function loadRecent() {
  if (Date.now() - recentAt < 15000) return;
  recentAt = Date.now();
  recent = (await host.getRecentFiles().catch(() => [])) || [];
  if (document.activeElement === input()) renderPop();
}

function buildItems() {
  const q = query();
  const ql = q.toLowerCase();
  const list = [];
  if (!q) return list;
  const mailMode = api.app() === 'mail';
  const docName = api.doc.name();

  if (mailMode) {
    list.push({ icon: 'travel_explore', color: '#9b6bff', label: `Search all mail for “${q}”`, sub: 'Every account, on the server  ·  Enter', run: () => api.mail.searchAll(q) });
    if (docName)
      list.push({
        icon: 'description',
        color: '#2bb3d9',
        label: `Find “${q}” in ${docName}`,
        sub: 'The open document',
        run: () => {
          api.setApp('docs'); // switching carries the words over and finds them
        },
      });
  } else {
    if (docName) {
      const { total } = api.doc.position();
      list.push({ icon: 'description', color: '#2bb3d9', label: `In ${docName}`, sub: total ? `${total} found  ·  Enter = next, Shift+Enter = previous` : 'Not found in this document', run: () => (api.doc.step(1), renderCount()) });
    }
    if (api.mail.ready()) {
      const n = api.mail.countLoaded(q);
      if (n)
        list.push({
          icon: 'mail',
          color: '#ff5fa2',
          label: `${n} email${n === 1 ? '' : 's'} match “${q}”`,
          sub: 'In your inbox',
          run: () => {
            api.setApp('mail');
            api.mail.filter(q);
            renderCount();
          },
        });
      list.push({
        icon: 'travel_explore',
        color: '#9b6bff',
        label: `Search all mail for “${q}”`,
        sub: 'Every account, on the server',
        run: () => {
          api.setApp('mail');
          api.mail.searchAll(q);
        },
      });
    }
  }

  const files = recent.filter((p) => fileName(p).toLowerCase().includes(ql) || (ql.length > 2 && p.toLowerCase().includes(ql))).slice(0, 5);
  for (const p of files)
    list.push({
      icon: 'history',
      color: '#ffc845',
      label: fileName(p),
      sub: p,
      run: () => {
        api.setApp('docs');
        api.openPath(p);
      },
    });
  return list;
}

function renderPop() {
  const p = pop();
  if (!p) return;
  items = buildItems();
  if (pick >= items.length) pick = items.length - 1;
  if (!items.length || document.activeElement !== input()) return hidePop();
  p.replaceChildren(
    ...items.map((it, i) =>
      el(
        'button',
        {
          class: 'gs-item' + (i === pick ? ' on' : ''),
          onmousedown: (e) => (e.preventDefault(), runItem(it)),
          onmousemove: () => {
            if (pick !== i) {
              pick = i;
              [...p.children].forEach((c, j) => c.classList.toggle('on', j === i));
            }
          },
        },
        el('span', { class: 'gs-icon', style: { '--c': it.color } }, icon(it.icon)),
        el('span', { class: 'gs-text' }, el('span', { class: 'gs-label' }, it.label), el('span', { class: 'gs-sub' }, it.sub))
      )
    )
  );
  p.classList.add('show');
}

function hidePop() {
  pop()?.classList.remove('show');
}
