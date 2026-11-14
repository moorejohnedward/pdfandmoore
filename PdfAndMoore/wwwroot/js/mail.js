// Mail tab (v9): one inbox for every email account and business address, with Claude built in.
// The Windows side (MailService.cs) reads mail over IMAP and sends over SMTP; this file is the screen.

import * as host from './host.js';
import { el, icon, $, toast, dialog, confirmDialog, extOf, debounce } from './util.js';
import { askOnce, mode as aiMode } from './claude.js';

const SORT_KEY = 'pam.mailSort';
const REFRESH_MINUTES = 5;

const M = {
  settings: null, // from host: accounts (with hasPassword), folders, rules, aboutMe, fetchCount, autoSort
  messages: [],
  account: null, // account id filter, null = all
  folder: 'all',
  search: '',
  selected: null, // message key
  bodies: new Map(), // key -> { text, html, attachments }
  summaries: new Map(),
  replies: new Map(),
  showPictures: new Set(),
  sort: loadSortCache(),
  loading: false,
  lastRefresh: null,
  errors: [],
  onOpenFile: null, // set by app.js: opens attachment bytes in the document editor
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const keyOf = (m) => `${m.accountId}|${m.uid}`;
const current = () => M.messages.find((m) => keyOf(m) === M.selected) || null;
const accountById = (id) => (M.settings?.accounts || []).find((a) => a.id === id);
const allIdentities = () => (M.settings?.accounts || []).flatMap((a) => a.identities.map((i) => ({ ...i, accountId: a.id, accountEmail: a.email })));
const signedIn = () => (M.settings?.accounts || []).filter((a) => a.hasPassword);
const BUSINESS = ['KHT', 'Dive Moore', 'Museum', 'Business'];

const FOLDER_LOOK = {
  KHT: ['propane_tank', '#ff7a59'],
  'Dive Moore': ['scuba_diving', '#2bb3d9'],
  Museum: ['museum', '#9b6bff'],
  Business: ['business_center', '#ffc845'],
  School: ['school', '#3fc28a'],
  Personal: ['home', '#ff5fa2'],
  Newsletters: ['newspaper', '#8fa6bd'],
};
const folderLook = (f) => FOLDER_LOOK[f] || ['folder', '#8fa6bd'];

function pad(n) {
  return String(n).padStart(2, '0');
}
/** Military time: today "1750", earlier "Nov 12 0930". */
function shortDate(ms) {
  const d = new Date(ms);
  const hm = pad(d.getHours()) + pad(d.getMinutes());
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return hm;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + hm;
}
function longDate(ms) {
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) + '  ' + pad(d.getHours()) + pad(d.getMinutes());
}
function emailOnly(s) {
  const m = /<([^>]+)>/.exec(s || '');
  return (m ? m[1] : s || '').trim().replace(/^"|"$/g, '');
}
function splitAddresses(s) {
  return (s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean);
}
function loadSortCache() {
  try {
    return JSON.parse(localStorage.getItem(SORT_KEY) || '{}');
  } catch {
    return {};
  }
}
function saveSortCache() {
  const keys = Object.keys(M.sort);
  if (keys.length > 4000) keys.slice(0, keys.length - 4000).forEach((k) => delete M.sort[k]);
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify(M.sort));
  } catch {}
}

/** First JSON object or array in an AI reply. */
function parseJson(text) {
  if (!text) return null;
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const close = text[start] === '{' ? '}' : ']';
  const end = text.lastIndexOf(close);
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sorting: your rules first (free, instant), Claude for the rest
// ---------------------------------------------------------------------------
function ruleFolder(m) {
  for (const id of allIdentities()) {
    if (id.folder && id.folder !== 'Personal' && (m.to + ' ' + m.cc).toLowerCase().includes(id.address.toLowerCase())) return id.folder;
  }
  const hay = `${m.fromName} ${m.fromAddress} ${m.to} ${m.subject}`.toLowerCase();
  for (const r of M.settings?.rules || []) if (r.match && hay.includes(r.match.toLowerCase())) return r.folder;
  return null;
}
function applySorting(m) {
  const cached = M.sort[keyOf(m)];
  const rule = ruleFolder(m);
  m.folder = rule || (cached && cached[0]) || '';
  m.needsReply = !!(cached && cached[1]);
}

function aboutMe() {
  return 'About John (context only; never paste it into emails): ' + (M.settings?.aboutMe || '');
}

async function ai(prompt, system, maxTokens = 2000) {
  return askOnce(prompt, { system: system + '\n\n' + aboutMe(), maxTokens });
}

async function smartSort({ onlyNew = true } = {}) {
  if (aiMode() !== 'api' && aiMode() !== 'local') {
    if (!onlyNew) toast('Smart Sort needs an AI. Pick one in Settings › AI assistant. Your keyword rules still sort for free.', { ms: 6000 });
    return;
  }
  const targets = M.messages.filter((m) => !ruleFolder(m) && (onlyNew ? !M.sort[keyOf(m)] : true));
  if (!targets.length) {
    if (!onlyNew) toast('Everything is already sorted.');
    return;
  }
  const folders = M.settings.folders.join(', ');
  const addresses = allIdentities().map((i) => `${i.address} = ${i.folder}`).join('\n');
  const system =
    `Sort each email into exactly one folder from this list: ${folders}.\n` +
    '"Business" is business mail not tied to one company (DAN, PADI, State, County, city, insurance, permits, vendors). ' +
    '"School" is Millersville University and coursework. "Newsletters" is marketing, promotions and automated bulk mail.\n' +
    'Mail sent to one of these addresses usually belongs to that folder:\n' + addresses +
    '\nAlso set needsReply true only if a real person is waiting on an answer from John.\n' +
    'Reply with JSON only: [{"i":0,"folder":"...","needsReply":false}, ...]';
  setStatus(`✨ Sorting ${targets.length} emails…`, true);
  try {
    for (let start = 0; start < targets.length; start += 30) {
      const batch = targets.slice(start, start + 30);
      const prompt = batch.map((m, i) => `[${i}] From: ${m.fromName} <${m.fromAddress}> | To: ${m.to} | Subject: ${m.subject} | ${m.preview.slice(0, 180)}`).join('\n');
      const reply = await ai(prompt, system, 2500);
      if (reply === null) break; // the AI isn't available right now
      const rows = parseJson(reply);
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        const m = batch[r.i];
        if (!m) continue;
        const folder = M.settings.folders.includes(r.folder) ? r.folder : 'Personal';
        M.sort[keyOf(m)] = [folder, !!r.needsReply];
        applySorting(m);
      }
    }
    saveSortCache();
    render();
    setStatus(`✨ Sorted. ${M.messages.filter((m) => m.needsReply).length} need a reply.`);
  } catch (e) {
    setStatus('Smart Sort: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Loading mail
// ---------------------------------------------------------------------------
export async function loadSettings() {
  M.settings = await host.mail.getSettings().catch(() => null);
  return M.settings;
}

export async function refresh({ quiet = false } = {}) {
  if (M.loading) return;
  if (!M.settings) await loadSettings();
  if (!M.settings || !signedIn().length) {
    render();
    return;
  }
  M.loading = true;
  if (!quiet) setStatus('Checking mail…', true);
  try {
    const res = await host.mail.fetch();
    const old = new Map(M.messages.map((m) => [keyOf(m), m]));
    M.messages = (res.messages || []).map((m) => {
      const prev = old.get(keyOf(m));
      if (prev && prev.read && !m.read) m.read = true; // opened here a moment ago
      applySorting(m);
      return m;
    });
    M.messages.sort((a, b) => b.date - a.date);
    M.errors = res.errors || [];
    M.lastRefresh = Date.now();
    render();
    setStatus(M.errors.length ? "Couldn't reach " + M.errors.join('; ') : `Up to date at ${pad(new Date().getHours())}${pad(new Date().getMinutes())}.`);
    if (M.settings.autoSort && aiMode() === 'api') await smartSort({ onlyNew: true });
  } catch (e) {
    setStatus('Mail: ' + e.message);
  } finally {
    M.loading = false;
    updateBadge();
  }
}

function updateBadge() {
  const n = M.messages.filter((m) => !m.read).length;
  const badge = $('#mailBadge');
  if (!badge) return;
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.classList.toggle('hidden', n === 0);
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
function folders() {
  const list = [
    { id: 'all', name: 'All mail', icon: 'inbox', color: '#5ab8ff', match: () => true },
    { id: 'reply', name: 'Needs reply', icon: 'reply', color: '#ffc845', match: (m) => m.needsReply },
    { id: 'biz', name: 'All business', icon: 'work', color: '#ff7a59', match: (m) => BUSINESS.includes(m.folder) },
  ];
  for (const f of M.settings?.folders || []) {
    const [ic, color] = folderLook(f);
    list.push({ id: 'f:' + f, name: f, icon: ic, color, match: (m) => m.folder === f });
  }
  list.push({ id: 'none', name: 'Unsorted', icon: 'help', color: '#8fa6bd', match: (m) => !m.folder });
  return list;
}

function visible() {
  const f = folders().find((x) => x.id === M.folder) || folders()[0];
  const q = M.search.toLowerCase();
  return M.messages.filter(
    (m) =>
      (!M.account || m.accountId === M.account) &&
      f.match(m) &&
      (!q || `${m.fromName} ${m.fromAddress} ${m.subject} ${m.preview}`.toLowerCase().includes(q))
  );
}

let statusTimer;
function setStatus(text, working = false) {
  const s = $('#mailStatus');
  if (!s) return;
  s.replaceChildren(working ? el('span', { class: 'spinner small' }) : '', el('span', {}, text));
  clearTimeout(statusTimer);
  if (!working && text) statusTimer = setTimeout(() => s.replaceChildren(), 9000);
}

export function render() {
  const root = $('#mailView');
  if (!root) return;
  if (!M.settings || !(M.settings.accounts || []).length || !signedIn().length) {
    root.replaceChildren(welcome());
    return;
  }
  const side = renderSide();
  const list = renderList();
  const reader = el('section', { class: 'mail-read', id: 'mailRead' });
  root.replaceChildren(side, list, reader);
  renderReader();
}

function welcome() {
  return el(
    'div',
    { class: 'mail-welcome' },
    el('div', { class: 'mail-welcome-art' }, icon('mark_email_unread')),
    el('h1', {}, 'Your email, right here'),
    el('p', {}, 'Read and send from every account and business address in one place, with Claude to help write, sort and reply.'),
    el('ol', {},
      el('li', {}, 'In each Google account, make an ', el('b', {}, 'app password'), ' (Settings walks you through it).'),
      el('li', {}, 'Paste it into ', el('b', {}, 'Settings › Email'), ' and press ', el('b', {}, 'Save & test'), '.'),
      el('li', {}, 'Your inbox shows up here, sorted into KHT, Dive Moore, Museum, School and more.')
    ),
    el('button', { class: 'btn btn-primary big-btn', onclick: () => window.dispatchEvent(new CustomEvent('pam:settings', { detail: 'mail' })) }, icon('manage_accounts'), 'Set up email accounts')
  );
}

function renderSide() {
  const unread = (pred) => M.messages.filter((m) => !m.read && pred(m)).length;
  const navBtn = (on, color, ic, label, sub, count, onclick) =>
    el(
      'button',
      { class: 'mail-nav' + (on ? ' on' : ''), style: { '--c': color }, onclick },
      ic ? el('span', { class: 'mail-nav-icon' }, icon(ic)) : el('span', { class: 'mail-dot' }),
      el('span', { class: 'mail-nav-text' }, el('span', {}, label), sub ? el('small', {}, sub) : ''),
      count ? el('span', { class: 'mail-count' }, String(count)) : ''
    );

  const accounts = [
    navBtn(!M.account, '#5ab8ff', 'all_inbox', 'All accounts', 'Everything together', unread(() => true), () => ((M.account = null), render())),
    ...M.settings.accounts.map((a) =>
      navBtn(M.account === a.id, a.color, null, a.name || a.email, a.hasPassword ? a.email : 'Needs app password', unread((m) => m.accountId === a.id), () => ((M.account = a.id), render()))
    ),
  ];
  const folderBtns = folders().map((f) =>
    navBtn(
      M.folder === f.id, f.color, f.icon, f.name, '',
      M.messages.filter((m) => (!M.account || m.accountId === M.account) && f.match(m) && (f.id === 'reply' || !m.read)).length,
      () => ((M.folder = f.id), (M.selected = null), render())
    )
  );
  return el(
    'aside',
    { class: 'mail-side' },
    el('button', { class: 'btn btn-primary mail-new', onclick: () => composeMail() }, icon('edit_square'), 'New email'),
    el('div', { class: 'mail-sec' }, 'Accounts'),
    accounts,
    el('div', { class: 'mail-sec' }, 'Smart folders'),
    folderBtns,
    el('div', { class: 'grow' }),
    el('button', { class: 'mail-nav subtle', onclick: () => window.dispatchEvent(new CustomEvent('pam:settings', { detail: 'mail' })) }, el('span', { class: 'mail-nav-icon' }, icon('settings')), el('span', { class: 'mail-nav-text' }, 'Email settings'))
  );
}

function renderList() {
  const f = folders().find((x) => x.id === M.folder) || folders()[0];
  const items = visible();
  const search = el('input', { class: 'mail-search', type: 'search', placeholder: 'Search sender, subject or text…', value: M.search });
  search.addEventListener(
    'input',
    debounce(() => {
      M.search = search.value;
      const pos = search.selectionStart;
      render();
      const s = $('.mail-search');
      s.focus();
      s.setSelectionRange(pos, pos);
    }, 200)
  );
  search.addEventListener('keydown', (e) => e.stopPropagation());
  return el(
    'section',
    { class: 'mail-list' },
    el(
      'div',
      { class: 'mail-list-head' },
      el('div', { class: 'mail-list-title', style: { '--c': f.color } }, icon(f.icon), el('span', {}, f.name), el('small', {}, `${items.length}`)),
      el(
        'div',
        { class: 'mail-tools' },
        el('button', { class: 'btn btn-tonal', title: 'Check for new mail', onclick: () => refresh() }, icon('refresh'), 'Refresh'),
        el('button', { class: 'btn btn-tonal ai-btn', title: 'Let Claude sort everything your rules didn’t catch', onclick: () => smartSort({ onlyNew: false }) }, icon('auto_awesome'), 'Smart Sort')
      ),
      search,
      el('div', { id: 'mailStatus', class: 'mail-status' })
    ),
    el(
      'div',
      { class: 'mail-rows' },
      items.length
        ? items.map(row)
        : el('div', { class: 'mail-empty' }, icon('celebration'), el('div', {}, M.loading ? 'Loading…' : 'Nothing here. Nice!'))
    )
  );
}

function row(m) {
  const acct = accountById(m.accountId);
  const [, fcolor] = folderLook(m.folder);
  return el(
    'button',
    { class: 'mail-row' + (m.read ? '' : ' unread') + (keyOf(m) === M.selected ? ' on' : ''), style: { '--acct': acct?.color || '#5ab8ff' }, onclick: () => open(m) },
    el('div', { class: 'mail-row-top' }, el('span', { class: 'mail-from' }, m.fromName || m.fromAddress), el('span', { class: 'mail-date' }, shortDate(m.date))),
    el('div', { class: 'mail-subject' }, m.subject),
    el('div', { class: 'mail-preview' }, m.preview),
    el(
      'div',
      { class: 'mail-chips' },
      m.folder ? el('span', { class: 'mchip', style: { '--c': fcolor } }, m.folder) : '',
      m.needsReply ? el('span', { class: 'mchip reply' }, icon('reply'), 'Needs reply') : '',
      m.hasAttachments ? el('span', { class: 'mchip plain' }, icon('attach_file')) : ''
    )
  );
}

async function open(m) {
  M.selected = keyOf(m);
  render();
  if (M.bodies.has(keyOf(m))) return;
  try {
    const body = await host.mail.message(m.accountId, m.uid);
    M.bodies.set(keyOf(m), body);
    m.read = true;
    updateBadge();
    if (M.selected === keyOf(m)) render();
  } catch (e) {
    M.bodies.set(keyOf(m), { text: "Couldn't open this email: " + e.message, html: '', attachments: [] });
    if (M.selected === keyOf(m)) renderReader();
  }
}

function renderReader() {
  const box = $('#mailRead');
  if (!box) return;
  const m = current();
  if (!m) {
    box.replaceChildren(el('div', { class: 'mail-read-empty' }, el('img', { src: 'img/app.png', alt: '' }), el('div', {}, 'Pick an email to read it')));
    return;
  }
  const body = M.bodies.get(keyOf(m));
  const acct = accountById(m.accountId);
  const summary = M.summaries.get(keyOf(m));
  const replies = M.replies.get(keyOf(m));

  const actions = el(
    'div',
    { class: 'mail-actions' },
    el('button', { class: 'btn btn-tonal', onclick: () => reply(m, false) }, icon('reply'), 'Reply'),
    el('button', { class: 'btn btn-tonal', onclick: () => reply(m, true) }, icon('reply_all'), 'Reply all'),
    el('button', { class: 'btn btn-tonal', onclick: () => forward(m) }, icon('forward'), 'Forward'),
    el('span', { class: 'mail-actions-sep' }),
    el('button', { class: 'btn btn-tonal ai-btn', onclick: () => summarize(m) }, icon('summarize'), 'Summarize'),
    el('button', { class: 'btn btn-tonal ai-btn', onclick: () => suggestReplies(m) }, icon('auto_awesome'), 'Suggest replies'),
    el('select', { class: 'field mail-move', title: 'Move to smart folder', onchange: (e) => moveTo(m, e.target.value) },
      el('option', { value: '' }, 'Move to…'),
      (M.settings.folders || []).map((f) => el('option', { value: f }, f)),
      el('option', { value: '__reply' }, m.needsReply ? 'Mark as replied' : 'Mark needs reply'))
  );

  const atts = body?.attachments?.length
    ? el(
        'div',
        { class: 'mail-atts' },
        body.attachments.map((a) =>
          el(
            'div',
            { class: 'mail-att' },
            icon(attIcon(a.name)),
            el('span', { class: 'mail-att-name', title: a.name }, a.name),
            el('small', {}, sizeText(a.size)),
            canOpenInApp(a.name) ? el('button', { class: 'btn btn-text small', onclick: () => openAttachment(m, a) }, 'Open') : '',
            el('button', { class: 'btn btn-text small', onclick: () => saveAttachment(m, a) }, 'Save')
          )
        )
      )
    : '';

  box.replaceChildren(
    el('div', { class: 'mail-read-head' },
      el('h1', {}, m.subject),
      el('div', { class: 'mail-who' },
        el('span', { class: 'mail-avatar', style: { '--acct': acct?.color } }, (m.fromName || m.fromAddress || '?').trim()[0].toUpperCase()),
        el('div', {},
          el('div', { class: 'mail-who-name' }, m.fromName || m.fromAddress, el('small', {}, ' <' + m.fromAddress + '>')),
          el('div', { class: 'mail-who-to' }, 'To: ' + m.to + (m.cc ? '   Cc: ' + m.cc : '')),
          el('div', { class: 'mail-who-to' }, longDate(m.date) + '  ·  ' + (acct ? acct.name || acct.email : ''))
        )
      ),
      actions,
      summary ? el('div', { class: 'mail-ai-card' }, el('div', { class: 'mail-ai-title' }, icon('auto_awesome'), "Claude's summary"), el('div', { class: 'mail-ai-text' }, summary)) : '',
      replies && replies.length
        ? el('div', { class: 'mail-ai-card' },
            el('div', { class: 'mail-ai-title' }, icon('auto_awesome'), 'Suggested replies — click one to open it, ready to edit'),
            el('div', { class: 'mail-suggest' }, replies.map((r) => el('button', { class: 'mail-suggestion', onclick: () => reply(m, false, r.body) }, el('b', {}, r.label), el('span', {}, r.body))))
          )
        : '',
      atts
    ),
    renderBody(m, body)
  );
}

function renderBody(m, body) {
  if (!body) return el('div', { class: 'mail-body loading' }, el('span', { class: 'spinner small' }), 'Opening…');
  if (body.html && body.html.trim()) {
    const allow = M.showPictures.has(keyOf(m));
    const csp = allow
      ? "default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline' *; font-src *;"
      : "default-src 'none'; img-src data:; style-src 'unsafe-inline';";
    const frame = el('iframe', { class: 'mail-frame', sandbox: 'allow-popups allow-popups-to-escape-sandbox', referrerpolicy: 'no-referrer' });
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>body{font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2933;margin:18px 22px;word-wrap:break-word}img{max-width:100%;height:auto}</style></head><body>${body.html}</body></html>`;
    return el(
      'div',
      { class: 'mail-body html' },
      allow ? '' : el('div', { class: 'mail-pics' }, icon('hide_image'), 'Pictures are hidden to keep trackers out.', el('button', { class: 'btn btn-text small', onclick: () => (M.showPictures.add(keyOf(m)), renderReader()) }, 'Show pictures')),
      frame
    );
  }
  return el('div', { class: 'mail-body text' }, body.text || m.preview);
}

const attIcon = (name) => ({ pdf: 'picture_as_pdf', png: 'image', jpg: 'image', jpeg: 'image', heic: 'image', docx: 'description', doc: 'description', xlsx: 'table_view', xls: 'table_view', csv: 'table_view', pptx: 'slideshow', zip: 'folder_zip' })[extOf(name)] || 'draft';
const canOpenInApp = (name) => ['pdf', 'png', 'jpg', 'jpeg', 'heic', 'tif', 'tiff', 'webp', 'docx', 'xlsx', 'xls', 'csv', 'pptx', 'txt'].includes(extOf(name));
const sizeText = (b) => (!b ? '' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');

async function openAttachment(m, a) {
  try {
    setStatus('Opening ' + a.name + '…', true);
    const file = await host.mail.attachment(m.accountId, m.uid, a.index);
    setStatus('');
    if (M.onOpenFile) await M.onOpenFile(file);
  } catch (e) {
    toast(e.message, { error: true });
  }
}
async function saveAttachment(m, a) {
  try {
    const path = await host.mail.saveAttachment(m.accountId, m.uid, a.index);
    if (path) toast('Saved to ' + path);
  } catch (e) {
    toast(e.message, { error: true });
  }
}

function moveTo(m, value) {
  if (!value) return;
  const k = keyOf(m);
  const cached = M.sort[k] || [m.folder, m.needsReply];
  if (value === '__reply') M.sort[k] = [cached[0] || m.folder, !m.needsReply];
  else M.sort[k] = [value, cached[1]];
  saveSortCache();
  applySorting(m);
  if (ruleFolder(m) && value !== '__reply') toast(`A keyword rule keeps this in ${m.folder}. Change the rule in Settings › Email to move it.`, { ms: 6000 });
  render();
}

// ---------------------------------------------------------------------------
// Claude in the reader
// ---------------------------------------------------------------------------
function describe(m) {
  const b = M.bodies.get(keyOf(m));
  let text = (b && (b.text || htmlToText(b.html))) || m.preview;
  if (text.length > 7000) text = text.slice(0, 7000) + '\n[...trimmed...]';
  return `From: ${m.fromName} <${m.fromAddress}>\nTo: ${m.to}\nCc: ${m.cc}\nDate: ${longDate(m.date)}\nSubject: ${m.subject}\n\n${text}`;
}
function htmlToText(html) {
  if (!html) return '';
  // Keep paragraph breaks: a detached document has no layout, so innerText can't add them for us.
  const marked = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)>/gi, '\n$&').replace(/<p[\s>]/gi, '\n$&');
  const doc = new DOMParser().parseFromString(marked, 'text/html');
  doc.querySelectorAll('script,style,head,title').forEach((n) => n.remove());
  return (doc.body?.textContent || '')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function summarize(m) {
  setStatus('✨ Claude is reading…', true);
  try {
    const text = await ai(
      describe(m),
      'Summarize this email for John in 2-4 short bullet lines starting with "• ". If John needs to do something, add a final line starting with "To do: ". Use 24-hour time and American units. Plain text only.',
      600
    );
    if (text === null) return setStatus('');
    M.summaries.set(keyOf(m), text.trim());
    setStatus('');
    renderReader();
  } catch (e) {
    setStatus(e.message);
  }
}

async function suggestReplies(m) {
  const from = identityForReply(m);
  setStatus('✨ Claude is writing reply options…', true);
  try {
    const text = await ai(
      `John will reply from: ${from?.address} (${from?.business || 'personal'})\n\n${describe(m)}`,
      'Suggest 3 different replies John could send to this email (for example: yes, a question, a polite no — whatever fits). ' +
        'Each body is a complete short email with a greeting and a sign-off line but NO signature block. Never invent facts; use [brackets] for unknowns. Plain text. ' +
        'Reply with JSON only: [{"label":"2-4 words","body":"..."}]',
      2500
    );
    if (text === null) return setStatus('');
    const list = parseJson(text);
    if (!Array.isArray(list) || !list.length) throw new Error("Claude's answer wasn't in the expected format. Try again.");
    M.replies.set(keyOf(m), list.slice(0, 3).map((r) => ({ label: String(r.label || 'Reply'), body: String(r.body || '') })));
    setStatus('');
    renderReader();
  } catch (e) {
    setStatus(e.message);
  }
}

// ---------------------------------------------------------------------------
// Reply / forward
// ---------------------------------------------------------------------------
function identityForReply(m) {
  const ids = allIdentities();
  const to = (m.to + ' ' + m.cc).toLowerCase();
  return ids.find((i) => to.includes(i.address.toLowerCase())) || ids.find((i) => i.accountId === m.accountId) || ids[0];
}

function quoted(m) {
  const b = M.bodies.get(keyOf(m));
  const text = (b && (b.text || htmlToText(b.html))) || m.preview;
  return `\n\nOn ${longDate(m.date)}, ${m.fromName || m.fromAddress} <${m.fromAddress}> wrote:\n` + text.split('\n').map((l) => '> ' + l).join('\n');
}

function reply(m, all, body = '') {
  const from = identityForReply(m);
  const mine = new Set(allIdentities().map((i) => i.address.toLowerCase()));
  let cc = '';
  if (all) {
    cc = [...splitAddresses(m.to), ...splitAddresses(m.cc)]
      .filter((a) => !mine.has(emailOnly(a).toLowerCase()) && emailOnly(a).toLowerCase() !== m.fromAddress.toLowerCase())
      .join(', ');
  }
  composeMail({
    from,
    to: m.fromAddress,
    cc,
    subject: /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject,
    body,
    quote: quoted(m),
    replyTo: m,
  });
}

async function forward(m) {
  let attachments = [];
  const b = M.bodies.get(keyOf(m));
  if (b?.attachments?.length) {
    const keep = await confirmDialog('Forward', `Include the ${b.attachments.length} attachment(s)?`, 'Include them');
    if (keep) {
      setStatus('Getting attachments…', true);
      try {
        attachments = await Promise.all(b.attachments.map((a) => host.mail.attachment(m.accountId, m.uid, a.index)));
      } catch (e) {
        toast(e.message, { error: true });
      }
      setStatus('');
    }
  }
  composeMail({
    from: identityForReply(m),
    subject: /^fwd:/i.test(m.subject) ? m.subject : 'Fwd: ' + m.subject,
    quote: `\n\n---------- Forwarded message ----------\nFrom: ${m.fromName} <${m.fromAddress}>\nDate: ${longDate(m.date)}\nSubject: ${m.subject}\nTo: ${m.to}\n\n` +
      ((b && (b.text || htmlToText(b.html))) || m.preview),
    attachments,
  });
}

// ---------------------------------------------------------------------------
// Compose window (works from Mail and from the document editor)
// ---------------------------------------------------------------------------
let composeOpen = null;

/** Opens the compose window. attachments: [{name, bytes}]. Returns when it closes. */
export async function composeMail({ from = null, to = '', cc = '', subject = '', body = '', quote = '', attachments = [], replyTo = null } = {}) {
  if (!M.settings) await loadSettings();
  if (!M.settings) {
    toast('Email works in the PDF and Moore Windows app.', { error: true });
    return;
  }
  if (!signedIn().length) {
    const go = await confirmDialog('Set up email first', 'Add an app password for at least one email account, then you can send from here.', 'Open email settings');
    if (go) window.dispatchEvent(new CustomEvent('pam:settings', { detail: 'mail' }));
    return;
  }
  if (composeOpen) composeOpen.close(true);

  const ids = allIdentities();
  const files = [...attachments];
  const undo = [];
  let sent = false;

  const fromSel = el(
    'select',
    { class: 'field compose-from' },
    M.settings.accounts.map((a) =>
      el('optgroup', { label: (a.name || a.email) + (a.hasPassword ? '' : '  (needs app password)') },
        a.identities.map((i) => el('option', { value: a.id + '|' + i.address, disabled: !a.hasPassword }, (i.business ? i.business + '  —  ' : '') + i.address)))
    )
  );
  const pick = from || ids.find((i) => accountById(i.accountId)?.hasPassword) || ids[0];
  if (pick) fromSel.value = pick.accountId + '|' + pick.address;
  const fromIdentity = () => {
    const [accountId, address] = fromSel.value.split('|');
    return ids.find((i) => i.accountId === accountId && i.address === address);
  };

  const toBox = el('input', { class: 'field', placeholder: 'name@example.com, another@example.com', value: to });
  const ccBox = el('input', { class: 'field', placeholder: 'Cc', value: cc });
  const bccBox = el('input', { class: 'field', placeholder: 'Bcc' });
  const subjBox = el('input', { class: 'field compose-subject', placeholder: 'Subject', value: subject });
  const bodyBox = el('textarea', { class: 'field compose-body', spellcheck: 'true', placeholder: 'Write your email here, or tell Claude what to write above…' });
  bodyBox.value = body + quote;
  const askBox = el('input', { class: 'field compose-ask', placeholder: 'Tell Claude what to write — e.g. “thank Charlie for the call and ask about pricing on AL80s”' });
  const sigOn = el('input', { type: 'checkbox', checked: true });
  const sigPreview = el('div', { class: 'compose-sig' });
  const attList = el('div', { class: 'compose-atts' });
  const status = el('div', { class: 'compose-status' });
  const undoBtn = el('button', { class: 'btn btn-text small', disabled: true }, icon('undo'), 'Undo Claude');
  const sendBtn = el('button', { class: 'btn btn-primary compose-send' }, icon('send'), 'Send');
  const startText = bodyBox.value;

  const say = (t, working = false) => status.replaceChildren(working ? el('span', { class: 'spinner small' }) : '', el('span', {}, t));
  const showSig = () => {
    const sig = fromIdentity()?.signature || '';
    sigPreview.textContent = sigOn.checked ? (sig ? sig.replace(/\n/g, '  ·  ') : 'This address has no signature yet (add one in Settings › Email).') : '';
  };
  const showAtts = () =>
    attList.replaceChildren(
      ...files.map((f, i) =>
        el('span', { class: 'compose-att' }, icon(attIcon(f.name)), f.name, el('small', {}, sizeText(f.bytes.length)),
          el('button', { class: 'icon-btn small', title: 'Remove', onclick: () => (files.splice(i, 1), showAtts()) }, icon('close')))
      )
    );
  fromSel.addEventListener('change', showSig);
  sigOn.addEventListener('change', showSig);

  // The part John wrote vs. the quoted original below it.
  const marker = quote.split('\n').map((l) => l.trim()).find((l) => l) || null;
  const split = () => {
    const t = bodyBox.value;
    const i = marker ? t.indexOf(marker) : -1;
    if (i < 0) return [t, ''];
    let s = i;
    while (s > 0 && t[s - 1] === '\n') s--;
    return [t.slice(0, s), t.slice(s)];
  };
  const setOwn = (own) => {
    undo.push({ body: bodyBox.value, subject: subjBox.value });
    undoBtn.disabled = false;
    bodyBox.value = own.trimEnd() + split()[1];
    bodyBox.scrollTop = 0;
  };
  undoBtn.addEventListener('click', () => {
    const u = undo.pop();
    if (!u) return;
    bodyBox.value = u.body;
    subjBox.value = u.subject;
    undoBtn.disabled = !undo.length;
  });

  const write = async () => {
    const request = askBox.value.trim();
    if (!request) return say('Type what you want Claude to write first.');
    const id = fromIdentity();
    const [own] = split();
    say('✨ Claude is writing…', true);
    try {
      const prompt =
        `Sending from: ${id.address} (${id.business || 'personal'})\n` +
        (toBox.value ? `To: ${toBox.value}\n` : '') +
        (subjBox.value ? `Current subject: ${subjBox.value}\n` : '') +
        (own.trim() ? `Current draft:\n${own}\n\n` : '') +
        (replyTo ? `This is a reply to:\n---\n${describe(replyTo)}\n---\n\n` : '') +
        `What John wants: ${request}`;
      const text = await ai(
        prompt,
        'Write an email John can send as-is. Do NOT include a signature block (the app adds it); end with a short sign-off line only, like "Mahalo,". ' +
          'Never invent facts, prices, dates or names; put unknowns in [square brackets]. Plain text, no markdown. Reply with JSON only: {"subject":"...","body":"..."}',
        2000
      );
      if (text === null) return say("Claude's answer will be in the Claude window. Paste it into the email.");
      const j = parseJson(text);
      setOwn(j?.body || text);
      if (j?.subject && (!subjBox.value.trim() || !replyTo)) subjBox.value = j.subject;
      askBox.value = '';
      say('✨ Draft ready. Read it over, change anything, then Send.');
    } catch (e) {
      say(e.message);
    }
  };
  askBox.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      write();
    }
  });

  const rewrite = async (instruction) => {
    const [own] = split();
    if (!own.trim()) return say('Write something first (or use Write it), then Claude can polish it.');
    const id = fromIdentity();
    say('✨ Claude is rewriting…', true);
    try {
      const text = await ai(
        `Sending from: ${id.address} (${id.business || 'personal'})\nInstruction: ${instruction}\n\nDraft:\n${own}`,
        'Rewrite the email draft as instructed. Keep every fact, name, number and date. No signature block. Plain text. Reply with ONLY the rewritten email.',
        2000
      );
      if (text === null) return say("Claude's answer will be in the Claude window.");
      setOwn(text.trim());
      say('✨ Done. Use Undo Claude if you liked it better before.');
    } catch (e) {
      say(e.message);
    }
  };

  const pickFrom = async () => {
    const [own] = split();
    const text = `${toBox.value} ${subjBox.value} ${own}`.toLowerCase();
    let best = null;
    if (aiMode() === 'api' || aiMode() === 'local') {
      say('✨ Choosing the right address…', true);
      try {
        const reply = await ai(
          `To: ${toBox.value}\nSubject: ${subjBox.value}\n\n${own.slice(0, 3000)}`,
          'Pick which of John\'s addresses this email should be sent from. Options:\n' +
            ids.map((i) => `${i.address} — ${i.business || 'personal'} (topics: ${i.hints})`).join('\n') +
            '\nReply with JSON only: {"address":"..."}',
          300
        );
        const a = parseJson(reply || '')?.address;
        best = ids.find((i) => i.address.toLowerCase() === String(a || '').toLowerCase());
      } catch (e) {
        say(e.message);
      }
    }
    if (!best) {
      let score = 0;
      for (const i of ids) {
        const s = (i.hints || '').split(',').map((h) => h.trim().toLowerCase()).filter((h) => h && text.includes(h)).length;
        if (s > score) (best = i), (score = s);
      }
    }
    if (best) {
      fromSel.value = best.accountId + '|' + best.address;
      showSig();
      say('Sending as ' + (best.business || best.address) + '.');
    } else say("Couldn't tell. Pick the From address yourself.");
  };

  const attach = async () => {
    const picked = await host.openFiles({ multiple: true, filter: 'any' }).catch((e) => (toast(e.message, { error: true }), []));
    for (const f of picked) files.push({ name: f.name, bytes: f.bytes });
    showAtts();
  };

  const send = async () => {
    const id = fromIdentity();
    if (!id) return say('Pick a From address.');
    if (!toBox.value.trim() && !ccBox.value.trim() && !bccBox.value.trim()) return say('Add who it goes to.');
    if (!subjBox.value.trim() && !(await confirmDialog('No subject', 'Send without a subject?', 'Send anyway'))) return;
    let text = bodyBox.value;
    if (sigOn.checked && id.signature) text = text.replace(/\s+$/, '') + '\n\n' + id.signature;
    sendBtn.disabled = true;
    say('Sending…', true);
    try {
      await host.mail.send({
        accountId: id.accountId, from: id.address, to: toBox.value, cc: ccBox.value, bcc: bccBox.value,
        subject: subjBox.value, body: text, attachments: files,
        inReplyTo: replyTo?.messageId || null, references: replyTo?.references || [],
      });
      sent = true;
      if (replyTo) {
        const k = keyOf(replyTo);
        M.sort[k] = [replyTo.folder, false];
        saveSortCache();
        applySorting(replyTo);
        render();
      }
      toast(`Sent from ${id.address} at ${pad(new Date().getHours())}${pad(new Date().getMinutes())}.`);
      close(true);
    } catch (e) {
      say('Not sent: ' + e.message);
      sendBtn.disabled = false;
    }
  };
  sendBtn.addEventListener('click', send);

  const quick = (label, instruction) => el('button', { class: 'chip', onclick: () => rewrite(instruction) }, label);
  const panel = el(
    'div',
    { class: 'compose', role: 'dialog', 'aria-label': 'New email' },
    el('div', { class: 'compose-head' },
      icon(replyTo ? 'reply' : 'edit_square'),
      el('span', {}, replyTo ? 'Reply' : quote ? 'Forward' : 'New email'),
      el('div', { class: 'grow' }),
      el('button', { class: 'icon-btn', title: 'Close', onclick: () => close(false) }, icon('close'))),
    el('div', { class: 'compose-scroll' },
      el('div', { class: 'compose-grid' },
        el('label', {}, 'From'), el('div', { class: 'compose-row' }, fromSel, el('button', { class: 'btn btn-tonal ai-btn', onclick: pickFrom, title: 'Choose the right business address' }, icon('auto_awesome'), 'Pick for me')),
        el('label', {}, 'To'), toBox,
        el('label', {}, 'Cc / Bcc'), el('div', { class: 'compose-row' }, ccBox, bccBox),
        el('label', {}, 'Subject'), subjBox
      ),
      el('div', { class: 'compose-ai' },
        el('div', { class: 'compose-row' }, icon('auto_awesome'), askBox, el('button', { class: 'btn btn-primary', onclick: write }, 'Write it')),
        el('div', { class: 'compose-chips' },
          quick('Make it professional', 'Make it more professional and polished.'),
          quick('Friendlier', 'Make it warmer and friendlier while staying professional.'),
          quick('Shorter', 'Make it shorter and more direct.'),
          quick('More detail', 'Add a bit more helpful detail without inventing facts.'),
          quick('Fix spelling & grammar', 'Fix spelling, grammar and punctuation only. Change nothing else.'),
          quick('Aloha touch', 'Add a light, genuine Hawaii touch (Aloha greeting, Mahalo sign-off) while staying professional.'),
          undoBtn)
      ),
      bodyBox,
      el('label', { class: 'compose-sig-row' }, sigOn, el('span', {}, 'Add signature'), sigPreview),
      el('div', { class: 'compose-att-row' }, el('button', { class: 'btn btn-tonal', onclick: attach }, icon('attach_file'), 'Attach files'), attList)
    ),
    el('div', { class: 'compose-foot' }, status, el('button', { class: 'btn btn-text', onclick: () => close(false) }, 'Discard'), sendBtn)
  );
  const backdrop = el('div', { class: 'compose-backdrop' }, panel);
  panel.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing here must never trigger the editor's shortcut keys
    if (e.key === 'Enter' && e.ctrlKey) send();
    if (e.key === 'Escape') close(false);
  });

  let resolveClosed;
  const closed = new Promise((r) => (resolveClosed = r));
  async function close(force) {
    if (!force && !sent && bodyBox.value !== startText && !(await confirmDialog('Discard this email?', 'What you wrote will be lost.', 'Discard'))) return;
    backdrop.remove();
    document.body.classList.remove('composing');
    composeOpen = null;
    resolveClosed(sent);
  }
  composeOpen = { close, addFiles: (list) => (files.push(...list), showAtts()) };

  document.body.append(backdrop);
  document.body.classList.add('composing');
  showSig();
  showAtts();
  setTimeout(() => (to ? (bodyBox.focus(), bodyBox.setSelectionRange(body.length, body.length)) : toBox.focus()), 30);
  return closed;
}

/** Files dropped on the window while composing are attached. */
export function composeAttach(files) {
  if (!composeOpen) return false;
  composeOpen.addFiles(files);
  return true;
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------
export async function initMail({ openFile }) {
  M.onOpenFile = openFile;
  await loadSettings();
  render();
  // Check quietly after start-up so the unread badge is ready, then every few minutes.
  if (M.settings && signedIn().length) setTimeout(() => refresh({ quiet: true }), 6000);
  setInterval(() => {
    if (M.settings && signedIn().length && !document.hidden) refresh({ quiet: true });
  }, REFRESH_MINUTES * 60 * 1000);
}

/** Called when Mail is shown. */
export function onShow() {
  render();
  if (!M.lastRefresh || Date.now() - M.lastRefresh > 60 * 1000) refresh();
}

/** Called after email settings change. */
export async function settingsChanged() {
  await loadSettings();
  M.messages.forEach(applySorting);
  render();
  refresh();
}

export const mailState = M;
