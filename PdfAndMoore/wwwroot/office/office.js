// PDF and Moore - shared code for the Word / Excel / PowerPoint editor windows:
// the colored title bar, Save / Save as / Print, unsaved-changes tracking, and the bridge to the Windows app.
(function () {
  'use strict';
  const webview = window.chrome && window.chrome.webview;

  // ---------- bridge to C# (same message format as the PDF editor) ----------
  let nextId = 1;
  const pending = new Map();
  const handlers = {};
  if (webview) {
    webview.addEventListener('message', (e) => {
      const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      if (msg.type === 'reply') {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || 'Unknown error'));
      } else if (msg.type === 'event') {
        (handlers[msg.name] || []).forEach((fn) => fn(msg.data));
      }
    });
  }

  // When the page is opened in a normal browser (for testing): ?file=sample.docx
  const testHost = {
    async ready() {
      const f = new URLSearchParams(location.search).get('file');
      if (!f) return { name: null, path: null, base64: null };
      const bytes = new Uint8Array(await (await fetch(f)).arrayBuffer());
      return { name: f.split('/').pop(), path: f, base64: bytesToB64(bytes) };
    },
    async save(args) {
      window.__saved = args;
      return { path: 'test.' + args.ext, name: 'test.' + args.ext };
    },
  };

  function call(cmd, args = {}) {
    if (!webview) return Promise.resolve(testHost[cmd] ? testHost[cmd](args) : null);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      webview.postMessage(JSON.stringify({ id, cmd, args }));
    });
  }
  function on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); }

  function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const extOf = (name) => { const m = /\.([a-z0-9]+)$/i.exec(name || ''); return m ? m[1].toLowerCase() : ''; };

  // ---------- UI helpers ----------
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
    return e;
  };
  let toastTimer;
  function toast(text, { error = false, ms = 3500 } = {}) {
    let t = document.querySelector('.ob-toast');
    if (!t) { t = el('div', { class: 'ob-toast' }); document.body.append(t); }
    t.textContent = text;
    t.classList.toggle('error', error);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
  function busy(text) {
    let b = document.querySelector('.ob-busy');
    if (!b) { b = el('div', { class: 'ob-busy' }); document.body.append(b); }
    b.textContent = text || '';
    b.classList.toggle('show', !!text);
  }
  function notice(text) {
    const n = document.querySelector('.ob-notice');
    n.querySelector('span').textContent = text || '';
    n.classList.toggle('show', !!text);
    document.body.classList.toggle('has-notice', !!text);
    window.dispatchEvent(new Event('resize'));
  }

  // ---------- the shell ----------
  const KIND_LABEL = { word: 'Document', sheet: 'Spreadsheet', slides: 'Presentation' };

  /**
   * opts: { kind, saveExt(originalExt) -> ext, mount(container), load(bytes, name, ext) -> {notice?},
   *         blank(), save(ext) -> Uint8Array, print? () , beforePrint?() }
   */
  async function start(opts) {
    document.body.classList.add('kind-' + opts.kind);
    const state = { name: null, path: null, dirty: false, saving: false, settledAt: Infinity };

    const nameEl = el('div', { class: 'ob-name' }, 'Opening…');
    const dirtyEl = el('div', { class: 'ob-dirty' });
    const btn = (icon, label, title, fn, primary) =>
      el('button', { class: 'ob-btn' + (primary ? ' primary' : ''), title, type: 'button', onclick: fn }, el('span', { class: 'ob-ic' }, icon), label);
    const bar = el('header', { class: 'ob' },
      el('img', { class: 'ob-logo', src: '../img/app.png', alt: '' }),
      el('div', { class: 'ob-kind' }, KIND_LABEL[opts.kind] + ' •'),
      nameEl, dirtyEl,
      el('div', { class: 'ob-spacer' }),
      btn('save', 'Save', 'Save (Ctrl+S)', () => save(false), true),
      btn('save_as', 'Save as…', 'Save as (Ctrl+Shift+S)', () => save(true)),
      opts.print ? btn('print', 'Print', 'Print (Ctrl+P)', () => print()) : null,
      btn('picture_as_pdf', 'Open as PDF', 'Open this file in the PDF editor (fill, sign, combine…)', () => openAsPdf())
    );
    const noticeBar = el('div', { class: 'ob-notice' }, el('span'), el('button', { title: 'Hide', onclick: () => notice('') }, '×'));
    const editor = el('main', { id: 'editor' });
    const printArea = el('div', { id: 'printArea' });
    document.body.append(bar, noticeBar, editor, printArea);

    const api = {
      markDirty() {
        if (Date.now() < state.settledAt) return; // ignore changes the editor makes while a file is loading
        if (state.dirty) return;
        state.dirty = true;
        updateTitle();
      },
      toast, busy, notice, call,
    };

    function displayName() { return state.name || 'Untitled.' + opts.saveExt(''); }
    function updateTitle() {
      nameEl.textContent = displayName();
      dirtyEl.textContent = state.dirty ? '• Not saved' : state.path ? '• Saved' : '';
      call('setState', { dirty: state.dirty, title: `${displayName()}${state.dirty ? ' *' : ''} - PDF and Moore` });
    }

    async function save(saveAs) {
      if (state.saving) return false;
      state.saving = true;
      try {
        const origExt = extOf(state.name || '');
        const ext = opts.saveExt(origExt);
        busy('Saving…');
        const bytes = await opts.save(ext);
        busy('');
        const res = await call('save', { base64: bytesToB64(bytes), ext, saveAs: !!saveAs, name: displayName() });
        if (!res) { call('cancelClose'); return false; } // cancelled
        state.path = res.path;
        state.name = res.name;
        state.dirty = false;
        updateTitle();
        toast('Saved ' + res.name);
        return true;
      } catch (e) {
        busy('');
        call('cancelClose');
        toast('Couldn’t save: ' + (e.message || e), { error: true, ms: 7000 });
        return false;
      } finally {
        state.saving = false;
      }
    }

    async function print() {
      try {
        if (opts.beforePrint) await opts.beforePrint(printArea);
        await call('print');
      } catch (e) {
        toast(e.message || String(e), { error: true });
      }
    }

    async function openAsPdf() {
      if (state.dirty || !state.path) {
        const ok = await save(false);
        if (!ok) return;
      }
      try { await call('openAsPdf'); } catch (e) { toast(e.message || String(e), { error: true }); }
    }

    // Keyboard shortcuts (capture phase so the editors don't swallow them)
    document.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); e.stopPropagation(); save(e.shiftKey); }
      else if (k === 'p' && opts.print) { e.preventDefault(); e.stopPropagation(); print(); }
    }, true);

    on('saveBeforeClose', () => save(false));

    // Start
    await opts.mount(editor, api);
    try {
      const file = await call('ready');
      state.settledAt = Infinity;
      if (file && file.base64) {
        state.name = file.name;
        state.path = file.path;
        busy('Opening ' + file.name + '…');
        const result = await opts.load(b64ToBytes(file.base64), file.name, extOf(file.name), api);
        if (result && result.notice) notice(result.notice);
        if (result && result.renamed) { state.name = result.renamed; state.path = null; state.dirty = true; }
      } else {
        await opts.blank(api);
      }
    } catch (e) {
      toast('Couldn’t open the file: ' + (e.message || e), { error: true, ms: 10000 });
      console.error(e);
    } finally {
      busy('');
      setTimeout(() => { state.settledAt = 0; }, 1200);
      updateTitle();
    }
  }

  window.OfficeShell = { start, call, on, toast, busy, notice, extOf, bytesToB64, b64ToBytes, isHosted: !!webview };
})();
