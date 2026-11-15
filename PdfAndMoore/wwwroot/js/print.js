// Printing (v9.5): one place that prints PDF pages, used by the Print button for documents and for emails.
// Emails are laid out as a clean letter-size page, turned into a PDF by the Edge engine (C# side), then
// printed the same way as documents, so long emails break across pages properly.

import * as host from './host.js';
import { el, $, busy, busyProgress, toast, escapeHtml } from './util.js';

/** Renders PDF bytes into the hidden print area and opens the Windows print dialog. */
export async function printPdfBytes(bytes, { message = 'Preparing to print…' } = {}) {
  busy(message);
  try {
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
    toast('Could not print: ' + (e.message || e), { error: true });
  } finally {
    // Free the page pictures once the print dialog is done with them.
    setTimeout(() => $('#printArea')?.replaceChildren(), 1500);
  }
}

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------
const DROP_TAGS = 'script,iframe,frame,frameset,object,embed,applet,link,meta,base,form,input,button,select,textarea,noscript,template,svg script';

/** Strips anything that could run or phone home from an email's HTML. pictures=false also drops web images. */
export function cleanEmailHtml(html, { pictures = false } = {}) {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  doc.querySelectorAll(DROP_TAGS).forEach((n) => n.remove());
  for (const n of doc.querySelectorAll('*')) {
    for (const a of [...n.attributes]) {
      const name = a.name.toLowerCase();
      const v = a.value.trim().toLowerCase();
      if (name.startsWith('on') || name === 'srcset' || name === 'ping') n.removeAttribute(a.name);
      else if (/^(href|src|action|formaction|background|poster|xlink:href)$/.test(name) && /^(javascript|vbscript):/.test(v)) n.removeAttribute(a.name);
    }
    if (!pictures && n.tagName === 'IMG' && !/^(data|cid):/i.test(n.getAttribute('src') || '')) n.remove();
  }
  return doc.body ? doc.body.innerHTML : '';
}

/** True when the email has pictures that come from the web (tracking pixels, logos…). */
export function hasWebPictures(html) {
  return /<img[^>]+src\s*=\s*["']?\s*https?:/i.test(html || '');
}

/**
 * A whole printable page for one email: account, subject, From / To / Cc / Date, attachments, then the message.
 * m: the email summary; body: { text, html, attachments }; account: "John Moore <john@divemoore.com>".
 */
export function emailPage(m, body, { pictures = false, account = '', date = '' } = {}) {
  const csp = pictures
    ? "default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline' *; font-src *;"
    : "default-src 'none'; img-src data:; style-src 'unsafe-inline';";
  const row = (label, value) => (value ? `<tr><th>${label}</th><td>${escapeHtml(value)}</td></tr>` : '');
  const atts = body?.attachments?.length
    ? `<div class="atts"><b>${body.attachments.length} attachment${body.attachments.length === 1 ? '' : 's'}:</b> ${body.attachments.map((a) => escapeHtml(a.name)).join(', ')}</div>`
    : '';
  const content =
    body?.html && body.html.trim()
      ? `<div class="msg">${cleanEmailHtml(body.html, { pictures })}</div>`
      : `<div class="msg text">${escapeHtml(body?.text || m.preview || '')}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${escapeHtml(m.subject || 'Email')}</title>
<style>
  @page { size: letter; margin: 0.5in; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #1f2933; margin: 0; }
  .acct { display: flex; justify-content: space-between; border-bottom: 2px solid #1f2933; padding-bottom: 6px; margin-bottom: 14px; font-size: 9.5pt; color: #52606d; }
  .acct b { color: #1f2933; }
  h1 { font-size: 16pt; margin: 0 0 10px; line-height: 1.25; }
  table.hdr { border-collapse: collapse; margin-bottom: 10px; font-size: 10pt; }
  table.hdr th { text-align: left; color: #52606d; font-weight: 600; padding: 1px 12px 1px 0; vertical-align: top; white-space: nowrap; }
  table.hdr td { padding: 1px 0; word-break: break-word; }
  .atts { font-size: 10pt; background: #f2f4f7; border-radius: 4px; padding: 6px 10px; margin-bottom: 10px; }
  hr { border: 0; border-top: 1px solid #cbd2d9; margin: 10px 0 14px; }
  .msg { word-wrap: break-word; overflow-wrap: anywhere; }
  .msg.text { white-space: pre-wrap; }
  .msg img { max-width: 100%; height: auto; }
  .msg table { max-width: 100% !important; }
</style></head><body>
<div class="acct"><span><b>PDF and Moore</b> · Mail</span><span>${escapeHtml(account)}</span></div>
<h1>${escapeHtml(m.subject || '(no subject)')}</h1>
<table class="hdr">
${row('From', m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress)}
${row('To', m.to)}
${row('Cc', m.cc)}
${row('Date', date)}
</table>
${atts}
<hr>
${content}
</body></html>`;
}

/** Turns an email page into PDF bytes. Returns null outside the Windows app. */
export async function emailPdf(html) {
  return host.htmlToPdf(html);
}

/** Prints an email page. In the Windows app it goes through PDF (proper page breaks); in a browser it prints directly. */
export async function printEmailPage(html) {
  busy('Preparing the email to print…');
  let bytes = null;
  try {
    bytes = await emailPdf(html);
  } catch (e) {
    busy(false);
    return toast('Could not print: ' + (e.message || e), { error: true });
  }
  if (bytes) return printPdfBytes(bytes, { message: 'Preparing the email to print…' });
  busy(false);
  // Outside the Windows app (tests, browser): print the page itself, kept inside a shadow root so its styles stay put.
  const area = $('#printArea');
  area.replaceChildren();
  const holder = el('div', { class: 'print-email' });
  const shadow = holder.attachShadow({ mode: 'open' });
  const doc = new DOMParser().parseFromString(html, 'text/html');
  shadow.innerHTML = doc.head.querySelector('style').outerHTML + doc.body.innerHTML;
  area.append(holder);
  await new Promise((r) => setTimeout(r, 200));
  window.print();
  setTimeout(() => area.replaceChildren(), 1500);
}
