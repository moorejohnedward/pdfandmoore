// Small DOM and UI helpers shared by the whole app.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function icon(name, cls = '') {
  return el('span', { class: 'ms ' + cls, 'aria-hidden': 'true' }, name);
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}
export function $$(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

// ---------- toast ----------
let toastTimer;
export function toast(message, { error = false, ms = 3200 } = {}) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.toggle('error', error);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- busy overlay ----------
export function busy(message) {
  const o = $('#busy');
  if (message === false) {
    o.classList.remove('show');
    return;
  }
  $('#busyText').textContent = message || 'Working…';
  $('#busyProgress').style.width = '0%';
  o.classList.add('show');
}
export function busyProgress(fraction, message) {
  $('#busyProgress').style.width = Math.round(Math.max(0, Math.min(1, fraction)) * 100) + '%';
  if (message) $('#busyText').textContent = message;
}

// ---------- modal dialogs ----------
/**
 * Show a dialog. `body` is a Node or string. Buttons: [{label, value, primary}].
 * Resolves with the clicked button's value (or null when closed).
 */
export function dialog({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], width }) {
  return new Promise((resolve) => {
    const backdrop = el('div', { class: 'modal-backdrop' });
    const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', style: width ? { width } : null });
    const close = (v) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) {
        const primary = buttons.find((b) => b.primary);
        if (primary) {
          e.preventDefault();
          e.stopPropagation();
          close(typeof primary.value === 'function' ? primary.value() : primary.value);
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    box.append(
      el('div', { class: 'modal-title' }, title || ''),
      el('div', { class: 'modal-body' }, typeof body === 'string' ? el('p', {}, body) : body),
      el(
        'div',
        { class: 'modal-buttons' },
        buttons.map((b) =>
          el(
            'button',
            {
              class: 'btn ' + (b.primary ? 'btn-primary' : 'btn-text'),
              onclick: () => close(typeof b.value === 'function' ? b.value() : b.value),
            },
            b.label
          )
        )
      )
    );
    backdrop.append(box);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close(null);
    });
    document.body.append(backdrop);
    const first = box.querySelector('input, textarea, select') || box.querySelector('.btn-primary');
    if (first) setTimeout(() => first.focus(), 30);
  });
}

export async function confirmDialog(title, message, okLabel = 'OK') {
  return (
    (await dialog({
      title,
      body: message,
      buttons: [
        { label: 'Cancel', value: false },
        { label: okLabel, value: true, primary: true },
      ],
    })) === true
  );
}

export async function promptDialog(title, label, value = '', { multiline = false, placeholder = '' } = {}) {
  const input = multiline
    ? el('textarea', { class: 'field', rows: 5, placeholder })
    : el('input', { class: 'field', type: 'text', placeholder });
  input.value = value;
  const body = el('label', { class: 'field-label' }, label, input);
  return dialog({
    title,
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'OK', value: () => input.value, primary: true },
    ],
  });
}

// ---------- misc ----------
export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}
export function baseName(name) {
  return (name || 'Untitled').replace(/\.[a-z0-9]+$/i, '');
}
export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
export function uid() {
  return Math.random().toString(36).slice(2, 10);
}
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
export function canvasToBytes(canvas, type = 'image/png', quality = 0.92) {
  return new Promise((resolve) => {
    canvas.toBlob(async (b) => resolve(new Uint8Array(await b.arrayBuffer())), type, quality);
  });
}
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read that image.'));
    img.src = src;
  });
}
export function bytesToObjectUrl(bytes, mime) {
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
export function hexToRgb01(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
