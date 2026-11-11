// Bridge between the web UI and the C# (WPF) host.
// Inside the Windows app, calls go to C# through WebView2's postMessage.
// When the page is opened in a normal browser (for testing), simple fallbacks are used.

const webview = window.chrome && window.chrome.webview;
export const isHosted = !!webview;

let nextId = 1;
const pending = new Map();
const streamHandlers = new Map();
const eventHandlers = new Map();

if (webview) {
  webview.addEventListener('message', (e) => {
    const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
    if (msg.type === 'reply') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error || 'Unknown error'));
    } else if (msg.type === 'stream') {
      const h = streamHandlers.get(msg.id);
      if (h) h(msg.text);
    } else if (msg.type === 'event') {
      (eventHandlers.get(msg.name) || []).forEach((fn) => fn(msg.data));
    }
  });
}

export function onHostEvent(name, fn) {
  if (!eventHandlers.has(name)) eventHandlers.set(name, []);
  eventHandlers.get(name).push(fn);
}

function callHost(cmd, args = {}, onStream) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    if (onStream) streamHandlers.set(id, onStream);
    webview.postMessage(JSON.stringify({ id, cmd, args }));
  }).finally(() => streamHandlers.delete(id));
}

// ---------- base64 helpers ----------
export function bytesToBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------- browser fallbacks ----------
function pickFilesInBrowser(accept, multiple) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = !!multiple;
    if (accept) input.accept = accept;
    input.onchange = async () => {
      const files = [];
      for (const f of input.files) {
        files.push({ name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) });
      }
      resolve(files);
    };
    input.click();
  });
}

function downloadInBrowser(name, bytes, mime) {
  const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- public API ----------

/** Show an Open dialog. Returns [{name, path, bytes}] (empty if cancelled). */
export async function openFiles({ multiple = false, filter = 'all' } = {}) {
  if (!webview) {
    const accept = filter === 'pdf' ? '.pdf' : filter === 'image' ? 'image/*' : '';
    return pickFilesInBrowser(accept, multiple);
  }
  const res = await callHost('openFiles', { multiple, filter });
  return (res || []).map((f) => ({ name: f.name, path: f.path, bytes: base64ToBytes(f.base64) }));
}

/** Read a file by full path (used for recent files and files opened from Explorer). */
export async function readPath(path) {
  const res = await callHost('readPath', { path });
  return { name: res.name, path: res.path, bytes: base64ToBytes(res.base64) };
}

/**
 * Save bytes. If path is given and saveAs is false, writes straight to that path.
 * Otherwise shows a Save dialog. Returns the saved path, or null if cancelled.
 */
export async function saveFile({ name, bytes, path = null, saveAs = true, mime }) {
  if (!webview) {
    window.__lastSaved = { name, bytes }; // lets the automated tests check the output
    downloadInBrowser(name, bytes, mime);
    return name;
  }
  return callHost('saveFile', { name, path, saveAs, base64: bytesToBase64(bytes) });
}

/** Convert an HTML page to PDF bytes using the Edge engine (C# side). */
export async function htmlToPdf(html, { landscape = false } = {}) {
  if (!webview) return null; // caller falls back to a simple text layout
  const b64 = await callHost('htmlToPdf', { html, landscape });
  return base64ToBytes(b64);
}

export async function getSettings() {
  if (!webview) {
    try {
      return JSON.parse(localStorage.getItem('pdfandmoore.settings') || '{}');
    } catch {
      return {};
    }
  }
  return callHost('getSettings');
}

export async function saveSettings(settings) {
  if (!webview) {
    try {
      localStorage.setItem('pdfandmoore.settings', JSON.stringify(settings));
    } catch {}
    return true;
  }
  return callHost('saveSettings', settings);
}

export async function getRecentFiles() {
  if (!webview) return [];
  return callHost('getRecent');
}

export async function setDirty(dirty, title) {
  if (!webview) return;
  return callHost('setState', { dirty, title });
}

/** Open claude.ai (the person's own Claude account) in a window beside the document. */
export async function openClaudeWeb(hint) {
  if (!webview) {
    window.open('https://claude.ai/new', 'claude');
    return true;
  }
  return callHost('openClaudeWeb', { hint });
}

/** Copy text or a PNG (base64) for pasting into Claude, then bring the Claude window up. */
export async function sendToClaudeWeb({ text = null, imageBase64 = null, hint = null }) {
  if (!webview) {
    if (imageBase64) {
      const blob = new Blob([base64ToBytes(imageBase64)], { type: 'image/png' });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch(() => {});
    } else await navigator.clipboard.writeText(text || '').catch(() => {});
    window.open('https://claude.ai/new', 'claude');
    return true;
  }
  return callHost('sendToClaudeWeb', { text, imageBase64, hint });
}

/** Edit a Word, Excel or PowerPoint file (by full path) in the built-in editor, in its own window. */
export async function editOffice(path) {
  if (!webview) throw new Error('The Word, Excel and PowerPoint editors work in the PDF and Moore Windows app.');
  return callHost('editOffice', { path });
}

/** Run a simple host command (new Office file, default app...). Returns a message to show, or null. */
export async function hostCommand(cmd, args = {}) {
  if (!webview) throw new Error('This works in the PDF and Moore Windows app.');
  return callHost(cmd, args);
}

export async function cancelClose() {
  if (!webview) return;
  return callHost('cancelClose');
}

export async function openExternal(url) {
  if (!webview) {
    window.open(url, '_blank');
    return;
  }
  return callHost('openExternal', { url });
}

/**
 * Send a request to Claude. `body` is an Anthropic Messages API body (without stream flag).
 * onText receives streamed text chunks. Resolves with the full reply text.
 */
export async function askClaude(body, onText) {
  if (webview) {
    return callHost('claude', { body: JSON.stringify(body) }, onText);
  }
  // Browser fallback: direct API call with the key from local settings.
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error('Add your Anthropic API key in Settings first.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) throw new Error(await res.text());
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      try {
        const ev = JSON.parse(line.slice(5));
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
          full += ev.delta.text;
          onText && onText(ev.delta.text);
        } else if (ev.type === 'error') {
          throw new Error(ev.error && ev.error.message);
        }
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
  }
  return full;
}

/** Tell the host the web UI is ready (host then sends any file passed on the command line). */
export function notifyReady() {
  if (webview) callHost('ready').catch(() => {});
}

// ---------- Digital IDs (certificate signatures) ----------
// In the Windows app these use the Windows certificate store, so IDs from a smart card,
// a company or a certificate authority work too. In a normal browser (tests) a stand-in
// signer can be provided as window.__testSigner.
const NEEDS_APP = 'Digital IDs work in the PDF and Moore Windows app.';

export async function listDigitalIds() {
  if (webview) return (await callHost('listDigitalIds')) || [];
  return window.__testSigner ? window.__testSigner.list() : [];
}
export async function createDigitalId({ name, email, org }) {
  if (webview) return callHost('createDigitalId', { name, email, org });
  if (window.__testSigner) return window.__testSigner.create({ name, email, org });
  throw new Error(NEEDS_APP);
}
export async function importDigitalId(password) {
  if (webview) return callHost('importDigitalId', { password });
  throw new Error(NEEDS_APP);
}
export async function exportDigitalId(thumbprint, password) {
  if (webview) return callHost('exportDigitalId', { thumbprint, password });
  throw new Error(NEEDS_APP);
}
/** Make a detached CMS (PKCS#7) signature over `bytes`. Returns DER bytes. */
export async function signCms(thumbprint, bytes) {
  if (webview) return base64ToBytes(await callHost('signCms', { thumbprint, dataBase64: bytesToBase64(bytes) }));
  if (window.__testSigner) return base64ToBytes(await window.__testSigner.sign(thumbprint, bytesToBase64(bytes)));
  throw new Error(NEEDS_APP);
}
