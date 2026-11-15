// Mail tab (v9): one inbox for every email account and business address, with Claude built in.
// The Windows side (MailService.cs) reads mail over IMAP and sends over SMTP; this file is the screen.

import * as host from './host.js';
import { el, icon, $, toast, dialog, confirmDialog, promptDialog, extOf, debounce, busy } from './util.js';
import { emailPage, emailPdf, printEmailPage, hasWebPictures } from './print.js';
import { askOnce, mode as aiMode } from './claude.js';
import { openAssistant as openAgent } from './mailagent.js';

const SORT_KEY = 'pam.mailSort';
const SAFE_KEY = 'pam.mailSafe'; // senders that are never clutter
const CLUTTER = 'Clutter';
const REFRESH_MINUTES = 5;
export const UNDO_SEND_KEY = 'pam.undoSend'; // seconds to wait before an email really goes (v9.5)
export const undoSendSeconds = () => {
  const v = Number(localStorage.getItem(UNDO_SEND_KEY));
  return Number.isFinite(v) && localStorage.getItem(UNDO_SEND_KEY) !== null ? Math.max(0, Math.min(60, v)) : 10;
};

const M = {
  settings: null, // from host: accounts (with hasPassword), folders, rules, aboutMe, fetchCount, autoSort
  messages: [],
  account: null, // account id filter, null = all
  folder: 'all',
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
  view: { type: 'inbox' }, // inbox (smart folders) | label (one Gmail label) | search (whole mailbox)
  labels: new Map(), // accountId -> [{name, fullName, kind, total, unread}]
  labelMsgs: new Map(), // "accountId|mailbox" -> { messages, total }
  totals: {}, // accountId -> how many messages that inbox holds on the server
  search: '',
  searchResults: null,
  showLabels: true,
  safe: loadSafe(),
  lastCleanup: null, // [{ accountId, uids }] in the Clutter label, for Undo
  drafts: null, // drafts from every account's Gmail Drafts folder (v9.3); null = not loaded yet
  checked: new Set(), // emails ticked in the list for bulk actions (v9.5)
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const keyOf = (m) => `${m.accountId}|${m.mailbox || 'INBOX'}|${m.uid}`;
const allLoaded = () => [...M.messages, ...[...M.labelMsgs.values()].flatMap((x) => x.messages), ...(M.searchResults || []), ...(M.drafts || [])];
const current = () => allLoaded().find((m) => keyOf(m) === M.selected) || null;
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
  'VA & Benefits': ['military_tech', '#5ab8ff'],
  Diving: ['scuba_diving', '#26c6da'],
  Finance: ['payments', '#3fc28a'],
  Travel: ['flight', '#ffb74d'],
  Promotions: ['sell', '#8fa6bd'],
  Updates: ['info', '#9fa8da'],
  Social: ['groups', '#ce93d8'],
  fun: ['local_fire_department', '#ff8a80'],
  Clutter: ['delete_sweep', '#8fa6bd'],
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
function loadSafe() {
  try {
    const list = JSON.parse(localStorage.getItem(SAFE_KEY) || 'null');
    return Array.isArray(list) ? list : ['divevolk']; // DiveVolk mail is wanted
  } catch {
    return ['divevolk'];
  }
}
function saveSafe() {
  try {
    localStorage.setItem(SAFE_KEY, JSON.stringify(M.safe));
  } catch {}
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
// Each email's remembered sort: [folder, needsReply, urgency ("now" | "soon" | ""), due, kind].
// kind: customer, person, business, automated, marketing, loan, spam ("" = Claude hasn't read it yet).
const JUNK_KINDS = ['marketing', 'loan', 'spam'];
const REAL_KINDS = ['customer', 'person', 'business'];
const URGENCY_RANK = { now: 0, soon: 1 };
const byUrgency = (a, b) => (URGENCY_RANK[a.urgency] ?? 2) - (URGENCY_RANK[b.urgency] ?? 2) || b.date - a.date;
const reviewed = (m) => (M.sort[keyOf(m)] || []).length >= 5;

function entry(m) {
  const c = [...(M.sort[keyOf(m)] || [m.folder || '', !!m.needsReply, m.urgency || '', m.due || '', m.kind || ''])];
  while (c.length < 5) c.push(c.length === 1 ? false : '');
  return c;
}

// Loan and funding offers: almost never a customer, even when they're sent to a business address.
const LOAN_RE = /\b(loans?|lending|lenders?|funding|fundable|financing|line of credit|credit line|working capital|business capital|cash advance|merchant cash|sba|pre-?approved|pre-?qualified|approved for|refinanc\w*|apr)\b/i;
// Sales wording, only counted on mass mailings (a customer asking about a discount is still a customer).
const PROMO_RE = /(% off|\bsale\b|\bdeals?\b|discount|coupon|promo|free shipping|limited time|last chance|ends (tonight|today|soon)|act now|webinar|black friday|cyber monday|exclusive offer|special offer|save \$?\d|shop now|new arrivals)/i;

function isSafe(m) {
  const from = (m.fromAddress || '').toLowerCase();
  const name = (m.fromName || '').toLowerCase();
  return M.safe.some((s) => s && (from.includes(s) || name.includes(s)));
}

/** Why an email counts as clutter (marketing or a loan offer), or '' if it doesn't. */
function clutterReason(m) {
  if (m.needsReply || isSafe(m) || REAL_KINDS.includes(m.kind)) return '';
  if (m.kind === 'loan') return 'Loan offer';
  if (JUNK_KINDS.includes(m.kind)) return 'Marketing';
  if (m.kind === 'automated') return '';
  if (/\.gov$/i.test(m.fromAddress || '')) return '';
  if (LOAN_RE.test(`${m.subject} ${m.fromName}`)) return 'Loan offer';
  if (m.category === 'promotions') return 'Marketing';
  if (m.bulk && PROMO_RE.test(`${m.subject} ${m.preview}`)) return 'Marketing';
  return '';
}

function ruleFolder(m) {
  const labels = (m.labels || []).map((l) => l.toLowerCase());
  // Gmail-tab rules (category:) always come last, so any rule you add beats "it's in Promotions".
  const rules = [...(M.settings?.rules || [])].sort((a, b) => ((a.match || '').toLowerCase().startsWith('category:')) - ((b.match || '').toLowerCase().startsWith('category:')));
  const labelMatch = (match) => {
    // "label:VA" matches the Gmail label "VA" and ones under it or starting with it ("VA & Benefits", "VA/Claims").
    const want = match.slice(6).trim();
    return labels.some((l) => l === want || l.startsWith(want + '/') || l.startsWith(want + ' '));
  };
  // Marketing and loan offers go to Clutter, even when they're sent to john@divemoore.com,
  // unless you put a Gmail label on them yourself.
  const labeled = rules.some((r) => (r.match || '').trim().toLowerCase().startsWith('label:') && labelMatch((r.match || '').trim().toLowerCase()));
  if (!labeled && clutterReason(m)) return CLUTTER;

  for (const id of allIdentities()) {
    if (id.folder && id.folder !== 'Personal' && (m.to + ' ' + m.cc).toLowerCase().includes(id.address.toLowerCase())) return id.folder;
  }
  const hay = `${m.fromName} ${m.fromAddress} ${m.to} ${m.subject}`.toLowerCase();
  for (const r of rules) {
    const match = (r.match || '').trim().toLowerCase();
    if (!match) continue;
    if (match.startsWith('label:')) {
      if (labelMatch(match)) return r.folder;
    } else if (match.startsWith('category:')) {
      if (m.category && m.category === match.slice(9).trim()) return r.folder;
    } else if (hay.includes(match)) return r.folder;
  }
  return null;
}
function applySorting(m) {
  const c = M.sort[keyOf(m)] || [];
  m.needsReply = !!c[1];
  m.urgency = c[2] || '';
  m.due = c[3] || '';
  m.kind = c[4] || '';
  m.folder = ruleFolder(m) || c[0] || '';
  m.clutter = m.folder === CLUTTER;
  m.clutterWhy = m.clutter ? clutterReason(m) || 'Marketing' : '';
}

function aboutMe() {
  return 'About John (context only; never paste it into emails): ' + (M.settings?.aboutMe || '');
}

async function ai(prompt, system, maxTokens = 2000) {
  return askOnce(prompt, { system: system + '\n\n' + aboutMe(), maxTokens });
}

function nowText() {
  const d = new Date();
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + ' at ' + pad(d.getHours()) + pad(d.getMinutes());
}

/**
 * Claude reads each email once: which folder, is it a customer, does someone need an answer,
 * and how time-sensitive is it. Obvious mass mailings are skipped to keep it fast and cheap.
 */
async function smartSort({ onlyNew = true } = {}) {
  if (aiMode() !== 'api' && aiMode() !== 'local') {
    if (!onlyNew) toast('Smart Sort needs an AI. Pick one in Settings › AI assistant. Your keyword rules still sort for free.', { ms: 6000 });
    return;
  }
  const obviousJunk = (m) => m.clutter && (m.bulk || m.category === 'promotions' || m.category === 'social');
  const targets = M.messages.filter((m) => !obviousJunk(m) && (!reviewed(m) || (!onlyNew && !m.folder)));
  if (!targets.length) {
    if (!onlyNew) toast('Everything is already sorted.');
    return;
  }
  const folders = [...new Set([...M.settings.folders, CLUTTER])];
  const addresses = allIdentities().map((i) => `${i.address} = ${i.folder}`).join('\n');
  const system =
    `You sort John's email so he never misses a customer and sees time-sensitive mail first. It is now ${nowText()} (Hawaii time).\n` +
    'For each email decide:\n' +
    `- folder: exactly one of: ${folders.join(', ')}. "Clutter" is marketing, sales pitches, newsletters, cold sales outreach, loan / funding / cash-advance / credit-line offers and spam. ` +
    '"Business" is business mail not tied to one company (DAN, PADI, State, County, insurance, permits, vendors). "School" is Millersville University and coursework.\n' +
    '- kind: "customer" (someone asking about, booking or paying for his services: dive lessons, scuba courses, charters, hydro testing, tank inspections, the museum; or an existing customer), ' +
    '"person" (a real person writing to him), "business" (vendors, agencies, permits, insurance, partners, school staff), "automated" (receipts, shipping, account notices, alerts), ' +
    '"marketing", "loan" (loan, funding, financing, cash advance or credit offers) or "spam".\n' +
    '- needsReply: true only if a real person is waiting on an answer from John.\n' +
    '- urgency: "now" if John should act within about 2 days (a booking or question about the next few days, a deadline, a bill, permit or payment due, an appointment change, a security alert), ' +
    '"soon" if within about a week, otherwise "". Sales deadlines ("ends tonight", "limited time") are never urgent.\n' +
    '- due: the deadline or date in a few words with 24-hour time if there is one (e.g. "Tue 1700", "Nov 20"), otherwise "".\n' +
    'Mail sent to one of these addresses usually belongs to that folder:\n' + addresses +
    '\nReply with JSON only: [{"i":0,"folder":"...","kind":"...","needsReply":false,"urgency":"","due":""}, ...]';
  setStatus(`✨ Claude is reading ${targets.length} emails…`, true);
  try {
    for (let start = 0; start < targets.length; start += 25) {
      const batch = targets.slice(start, start + 25);
      const prompt = batch
        .map((m, i) => `[${i}] ${longDate(m.date)} | From: ${m.fromName} <${m.fromAddress}> | To: ${m.to}${m.bulk ? ' | mass mailing' : ''}${m.category ? ' | Gmail tab: ' + m.category : ''} | Subject: ${m.subject} | ${m.preview.slice(0, 200)}`)
        .join('\n');
      const reply = await ai(prompt, system, 3000);
      if (reply === null) break; // the AI isn't available right now
      const rows = parseJson(reply);
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        const m = batch[r.i];
        if (!m) continue;
        const kind = ['customer', 'person', 'business', 'automated', ...JUNK_KINDS].includes(r.kind) ? r.kind : '';
        let folder = folders.includes(r.folder) ? r.folder : m.folder || 'Personal';
        if (JUNK_KINDS.includes(kind)) folder = CLUTTER;
        const junk = folder === CLUTTER;
        const urgency = !junk && ['now', 'soon'].includes(r.urgency) ? r.urgency : '';
        M.sort[keyOf(m)] = [folder, !junk && !!r.needsReply, urgency, urgency ? String(r.due || '').slice(0, 40) : '', kind || (junk ? 'marketing' : '')];
        applySorting(m);
      }
    }
    saveSortCache();
    render();
    const urgent = M.messages.filter((m) => m.urgency && !m.clutter).length;
    setStatus(`✨ Sorted. ${M.messages.filter((m) => m.needsReply).length} need a reply, ${urgent} time-sensitive.`);
  } catch (e) {
    setStatus('Smart Sort: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Clean up: marketing and loan offers out of the inbox (into the Gmail label "Clutter")
// ---------------------------------------------------------------------------
const cleanupCandidates = () =>
  M.messages.filter((m) => m.clutter && (m.mailbox || 'INBOX') === 'INBOX' && (!M.account || m.accountId === M.account));

function markSafe(m) {
  const who = (m.fromAddress || '').toLowerCase();
  if (!who || M.safe.includes(who)) return;
  M.safe.push(who);
  saveSafe();
  for (const x of allLoaded()) {
    if ((x.fromAddress || '').toLowerCase() === who) {
      const c = M.sort[keyOf(x)];
      if (c && JUNK_KINDS.includes(c[4])) c[4] = 'person';
      if (c && c[0] === CLUTTER) c[0] = '';
      applySorting(x);
    }
  }
  saveSortCache();
}

async function cleanUp() {
  const list = cleanupCandidates();
  if (!list.length) {
    toast('No marketing or loan offers in the inbox right now.');
    return;
  }
  // One line per sender, biggest first.
  const groups = new Map();
  for (const m of list) {
    const k = (m.fromAddress || m.fromName || '?').toLowerCase();
    if (!groups.has(k)) groups.set(k, { name: m.fromName || m.fromAddress, address: m.fromAddress, why: m.clutterWhy, items: [] });
    groups.get(k).items.push(m);
  }
  const rows = [...groups.values()].sort((a, b) => b.items.length - a.items.length);
  const checks = new Map();
  const body = el(
    'div',
    { class: 'mail-clean' },
    el('p', {}, `${list.length} emails look like marketing or loan offers. Checked ones move out of your inbox into the Gmail label “${CLUTTER}”. `,
      el('b', {}, 'Nothing is deleted'), ', and Undo puts them back.'),
    el(
      'div',
      { class: 'mail-clean-list' },
      rows.map((g) => {
        const box = el('input', { type: 'checkbox', checked: true });
        checks.set(g, box);
        const line = el(
          'label',
          { class: 'mail-clean-row' },
          box,
          el('span', { class: 'mail-clean-who' }, el('b', {}, g.name), el('small', {}, g.address)),
          el('span', { class: 'mchip', style: { '--c': g.why === 'Loan offer' ? '#ff8a65' : '#8fa6bd' } }, g.why),
          el('span', { class: 'mail-clean-n' }, String(g.items.length)),
          el('button', {
            class: 'btn btn-text small', title: 'This sender is real mail, never clutter',
            onclick: (e) => {
              e.preventDefault();
              markSafe(g.items[0]);
              box.checked = false;
              line.classList.add('kept');
            },
          }, icon('verified'), 'Keep')
        );
        return line;
      })
    )
  );
  const ok = await dialog({
    title: 'Clean up the inbox',
    body,
    width: '640px',
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Move checked out of inbox', value: true, primary: true },
    ],
  });
  render();
  if (!ok) return;
  const chosen = rows.filter((g) => checks.get(g).checked).flatMap((g) => g.items).filter((m) => m.clutter);
  if (!chosen.length) return;

  setStatus(`Moving ${chosen.length} emails to ${CLUTTER}…`, true);
  const byAccount = new Map();
  for (const m of chosen) {
    if (!byAccount.has(m.accountId)) byAccount.set(m.accountId, []);
    byAccount.get(m.accountId).push(m);
  }
  const undo = [];
  const errors = [];
  let moved = 0;
  for (const [accountId, msgs] of byAccount) {
    try {
      const res = await host.mail.moveToLabel(accountId, msgs.map((m) => m.uid), CLUTTER);
      if (res?.uids?.length) undo.push({ accountId, uids: res.uids });
      const gone = new Set(msgs.map(keyOf));
      M.messages = M.messages.filter((m) => !gone.has(keyOf(m)));
      M.totals[accountId] = Math.max(0, (M.totals[accountId] || 0) - msgs.length);
      moved += msgs.length;
    } catch (e) {
      errors.push(`${accountById(accountId)?.email || 'mail'}: ${e.message}`);
    }
  }
  M.lastCleanup = undo.length ? undo : null;
  M.labelMsgs.clear();
  loadLabels();
  render();
  updateBadge();
  if (errors.length) setStatus(`Moved ${moved}. Couldn't move some: ${errors.join('; ')}`);
  else setStatus(`🧹 Moved ${moved} emails to ${CLUTTER}.`, false, M.lastCleanup ? { label: 'Undo', onclick: undoCleanUp } : null);
}

async function undoCleanUp() {
  const undo = M.lastCleanup;
  if (!undo) return;
  M.lastCleanup = null;
  setStatus('Putting them back…', true);
  try {
    for (const u of undo) await host.mail.moveBack(u.accountId, u.uids, CLUTTER);
    M.labelMsgs.clear();
    await refresh({ quiet: true });
    setStatus('Back in your inbox.');
  } catch (e) {
    setStatus("Couldn't undo: " + e.message);
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
    const fresh = (res.messages || []).map((m) => {
      const prev = old.get(keyOf(m));
      if (prev && prev.read && !m.read) m.read = true; // opened here a moment ago
      applySorting(m);
      return m;
    });
    // Keep older pages that were loaded with "Load older" (anything older than this refresh reached, per account).
    const oldest = {};
    for (const m of fresh) oldest[m.accountId] = Math.min(oldest[m.accountId] ?? Infinity, m.date);
    const kept = M.messages.filter((m) => oldest[m.accountId] !== undefined && m.date < oldest[m.accountId]);
    M.messages = dedupe([...fresh, ...kept]).sort((a, b) => b.date - a.date);
    M.errors = res.errors || [];
    M.totals = res.totals || {};
    M.lastRefresh = Date.now();
    loadLabels(); // in the background: Gmail labels for the sidebar
    loadDrafts({ quiet: true }); // and drafts from every account
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

/** Gmail labels (IMAP folders) for each signed-in account, with server counts. */
async function loadLabels() {
  for (const a of signedIn()) {
    try {
      M.labels.set(a.id, await host.mail.folders(a.id));
    } catch {
      /* labels are a bonus; the inbox still works */
    }
  }
  if (document.body.classList.contains('app-mail')) render();
}

/** Opens one Gmail label (or Sent, Starred…) of one account. */
async function openLabel(accountId, f) {
  M.view = { type: 'label', accountId, mailbox: f.fullName, name: f.name, kind: f.kind };
  M.selected = null;
  const k = accountId + '|' + f.fullName;
  render();
  if (M.labelMsgs.has(k)) return;
  setStatus('Opening ' + f.name + '…', true);
  try {
    const res = await host.mail.fetch(accountId, { mailbox: f.fullName, count: 100 });
    const messages = (res.messages || []).map((m) => (applySorting(m), m)).sort((a, b) => b.date - a.date);
    M.labelMsgs.set(k, { messages, total: (res.totals || {})[accountId] || messages.length });
    setStatus('');
    render();
  } catch (e) {
    setStatus(e.message);
  }
}

/** Claude's mail assistant (v9.3): clean up and organize every account by asking in plain words. */
function openAssistant() {
  openAgent({
    settings: () => M.settings,
    draftsChanged,
    // Claude changed mail on the server: reload what's on screen.
    changed: () => {
      M.labelMsgs.clear();
      if (M.view.type === 'search') M.view = { type: 'inbox' };
      M.searchResults = null;
      refresh({ quiet: true });
    },
  });
}

/** Drafts from every account's Gmail Drafts folder (v9.3), newest first. */
async function loadDrafts({ quiet = false } = {}) {
  if (!quiet) setStatus('Opening drafts…', true);
  try {
    const res = await host.mail.fetch(null, { mailbox: '\\Drafts', count: 100 });
    M.drafts = (res.messages || []).map((m) => ((m.draft = true), m)).sort((a, b) => b.date - a.date);
    if (!quiet) setStatus(res.errors?.length ? "Couldn't reach " + res.errors.join('; ') : '');
    if (document.body.classList.contains('app-mail')) render();
  } catch (e) {
    if (!quiet) setStatus(e.message);
  }
}

function openDrafts() {
  M.view = { type: 'drafts' };
  M.selected = null;
  render();
  loadDrafts();
}

/** After a draft is saved, sent or thrown away: the Drafts list is out of date. */
function draftsChanged() {
  M.drafts = null;
  for (const k of [...M.labelMsgs.keys()]) if (/drafts$/i.test(k)) M.labelMsgs.delete(k);
  loadDrafts({ quiet: true });
}

/** Opens a saved draft in the compose window, exactly as it was left (attachments included). */
async function resumeDraft(m) {
  setStatus('Opening draft…', true);
  try {
    const b = await host.mail.message(m.accountId, m.uid, m.mailbox || '\\Drafts');
    const ids = allIdentities().filter((i) => i.accountId === m.accountId);
    const from = ids.find((i) => i.address.toLowerCase() === (b.from || '').toLowerCase()) || ids[0] || null;
    let text = (b.text || htmlToText(b.html) || '').replace(/\s+$/, '');
    // The signature was saved with the draft so Gmail shows it; take it off so it isn't added twice.
    let signature = true;
    const sig = (from?.signature || '').trim();
    if (sig) {
      if (text.endsWith(sig)) text = text.slice(0, text.length - sig.length).replace(/\s+$/, '');
      else signature = false;
    }
    const attachments = [];
    for (const a of b.attachments || []) attachments.push(await host.mail.attachment(m.accountId, m.uid, a.index, m.mailbox || '\\Drafts'));
    setStatus('');
    composeMail({
      from, to: b.to, cc: b.cc, bcc: b.bcc, subject: b.subject, body: text, attachments, signature,
      draft: { accountId: m.accountId, uid: m.uid }, inReplyTo: b.inReplyTo || null, references: b.references || [],
    });
  } catch (e) {
    setStatus("Couldn't open the draft: " + e.message);
  }
}

/** Loads the next batch of older messages for what's on screen. */
async function loadOlder() {
  setStatus('Loading older mail…', true);
  try {
    if (M.view.type === 'label') {
      const k = M.view.accountId + '|' + M.view.mailbox;
      const cur = M.labelMsgs.get(k);
      const res = await host.mail.fetch(M.view.accountId, { mailbox: M.view.mailbox, count: 100, skip: cur.messages.length });
      const more = (res.messages || []).map((m) => (applySorting(m), m));
      cur.messages = dedupe([...cur.messages, ...more]).sort((a, b) => b.date - a.date);
    } else {
      const batch = M.settings.fetchCount || 200;
      for (const a of signedIn().filter((a) => !M.account || a.id === M.account)) {
        const have = M.messages.filter((m) => m.accountId === a.id).length;
        if (M.totals[a.id] !== undefined && have >= M.totals[a.id]) continue;
        const res = await host.mail.fetch(a.id, { count: batch, skip: have });
        const more = (res.messages || []).map((m) => (applySorting(m), m));
        M.messages = dedupe([...M.messages, ...more]).sort((x, y) => y.date - x.date);
      }
    }
    setStatus('');
    render();
    if (M.view.type === 'inbox' && M.settings.autoSort && aiMode() === 'api') await smartSort({ onlyNew: true });
  } catch (e) {
    setStatus(e.message);
  }
}

/** Searches every message in the mailbox on the server (Gmail search words work too). */
async function searchAll(query) {
  if (!query.trim()) return;
  M.search = query;
  M.view = { type: 'search', query };
  M.selected = null;
  M.searchResults = [];
  render();
  setStatus(`Searching all mail for “${query}”…`, true);
  try {
    const res = await host.mail.search(query, M.account);
    M.searchResults = (res.messages || []).map((m) => (applySorting(m), m)).sort((a, b) => b.date - a.date);
    setStatus(res.errors?.length ? "Couldn't search " + res.errors.join('; ') : `Found ${M.searchResults.length}${M.searchResults.length >= 100 ? '+' : ''}.`);
    render();
  } catch (e) {
    setStatus(e.message);
  }
}

function dedupe(list) {
  const seen = new Set();
  return list.filter((m) => {
    const k = keyOf(m);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function updateBadge() {
  const n = M.messages.filter((m) => !m.read && !m.clutter).length;
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
    { id: 'all', name: 'All mail', icon: 'inbox', color: '#5ab8ff', match: (m) => !m.clutter },
    { id: 'urgent', name: 'Time-sensitive', icon: 'alarm', color: '#ff5f5f', match: (m) => !m.clutter && !!m.urgency, byUrgency: true, countAll: true },
    { id: 'reply', name: 'Needs reply', icon: 'reply', color: '#ffc845', match: (m) => m.needsReply, byUrgency: true, countAll: true },
    { id: 'cust', name: 'Customers', icon: 'storefront', color: '#3fc28a', match: (m) => m.kind === 'customer' && !m.clutter },
    { id: 'biz', name: 'All business', icon: 'work', color: '#ff7a59', match: (m) => BUSINESS.includes(m.folder) },
  ];
  const names = [...(M.settings?.folders || [])];
  if (!names.includes(CLUTTER)) names.push(CLUTTER);
  for (const f of names) {
    const [ic, color] = folderLook(f);
    list.push({ id: 'f:' + f, name: f, icon: ic, color, match: (m) => m.folder === f });
  }
  list.push({ id: 'none', name: 'Unsorted', icon: 'help', color: '#8fa6bd', match: (m) => !m.folder });
  return list;
}

function visible() {
  const q = M.search.toLowerCase();
  const textMatch = (m) => !q || `${m.fromName} ${m.fromAddress} ${m.subject} ${m.preview}`.toLowerCase().includes(q);
  if (M.view.type === 'search') return M.searchResults || [];
  if (M.view.type === 'drafts') return (M.drafts || []).filter((m) => (!M.account || m.accountId === M.account) && textMatch(m));
  if (M.view.type === 'label') return (M.labelMsgs.get(M.view.accountId + '|' + M.view.mailbox)?.messages || []).filter(textMatch);
  const f = folders().find((x) => x.id === M.folder) || folders()[0];
  const list = M.messages.filter(
    (m) =>
      (!M.account || m.accountId === M.account) &&
      f.match(m) &&
      (!q || `${m.fromName} ${m.fromAddress} ${m.subject} ${m.preview}`.toLowerCase().includes(q))
  );
  // Time-sensitive and Needs reply: most urgent first, then newest.
  return f.byUrgency ? list.sort(byUrgency) : list;
}

let statusTimer;
function setStatus(text, working = false, action = null) {
  const s = $('#mailStatus');
  if (!s) return;
  s.replaceChildren(
    working ? el('span', { class: 'spinner small' }) : '',
    el('span', {}, text),
    action ? el('button', { class: 'btn btn-text small', onclick: () => (s.replaceChildren(), action.onclick()) }, action.label) : ''
  );
  clearTimeout(statusTimer);
  if (!working && text) statusTimer = setTimeout(() => s.replaceChildren(), action ? 20000 : 9000);
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
    navBtn(!M.account, '#5ab8ff', 'all_inbox', 'All accounts', 'Everything together', unread(() => true), () => ((M.account = null), (M.view = { type: 'inbox' }), render())),
    ...M.settings.accounts.map((a) =>
      navBtn(M.account === a.id, a.color, null, a.name || a.email, a.hasPassword ? a.email : 'Needs app password', unread((m) => m.accountId === a.id), () => ((M.account = a.id), (M.view = { type: 'inbox' }), render()))
    ),
  ];
  const folderBtns = folders().map((f) =>
    navBtn(
      M.view.type === 'inbox' && M.folder === f.id, f.color, f.icon, f.name, '',
      M.messages.filter((m) => (!M.account || m.accountId === M.account) && f.match(m) && (f.countAll || !m.read)).length,
      () => ((M.folder = f.id), (M.view = { type: 'inbox' }), (M.selected = null), render())
    )
  );

  // Gmail labels, per account (Sent, Starred and the labels John made in Gmail)
  const LABEL_ICON = { sent: 'send', starred: 'star', important: 'label_important', all: 'archive', drafts: 'draft', spam: 'report', trash: 'delete' };
  const draftCount = (M.drafts || []).filter((m) => !M.account || m.accountId === M.account).length;
  const draftsBtn = navBtn(M.view.type === 'drafts', '#ffb74d', 'draft', 'Drafts', 'Every account', draftCount, openDrafts);
  const labelSections = signedIn()
    .filter((a) => !M.account || a.id === M.account)
    .map((a) => {
      const list = (M.labels.get(a.id) || []).filter((f) => ['sent', 'drafts', 'starred', 'all', 'spam', 'trash'].includes(f.kind) || (f.kind === 'label' && f.total > 0));
      if (!list.length) return null;
      const ORDER = { starred: 0, sent: 1, drafts: 2, all: 3, spam: 4, trash: 5 };
      list.sort((x, y) => (x.kind === 'label') - (y.kind === 'label') || (ORDER[x.kind] ?? 9) - (ORDER[y.kind] ?? 9) || x.fullName.localeCompare(y.fullName));
      return [
        el('div', { class: 'mail-sub' }, a.name || a.email),
        list.map((f) => {
          const depth = f.kind === 'label' ? f.fullName.split('/').length - 1 : 0;
          const on = M.view.type === 'label' && M.view.accountId === a.id && M.view.mailbox === f.fullName;
          const b = navBtn(on, a.color, LABEL_ICON[f.kind] || 'label', { all: 'All Mail', spam: 'Spam', trash: 'Trash' }[f.kind] || f.name, '', f.kind === 'label' ? f.unread : 0, () => openLabel(a.id, f));
          b.classList.add('mail-label');
          b.style.paddingLeft = 12 + depth * 18 + 'px';
          return b;
        }),
      ];
    })
    .filter(Boolean);
  const labelsBlock = labelSections.length
    ? [
        el('button', { class: 'mail-sec mail-sec-toggle', onclick: () => ((M.showLabels = !M.showLabels), render()) }, 'Gmail labels', icon(M.showLabels ? 'expand_less' : 'expand_more')),
        ...(M.showLabels ? labelSections.flat(Infinity) : []),
      ]
    : '';
  return el(
    'aside',
    { class: 'mail-side' },
    el('button', { class: 'btn btn-primary mail-new', onclick: () => composeMail() }, icon('edit_square'), 'New email'),
    el('button', { class: 'btn btn-tonal ai-btn mail-new', onclick: () => openAssistant(), title: 'Tell Claude how to clean up and organize your mail' }, icon('auto_awesome'), 'Ask Claude'),
    draftsBtn,
    el('div', { class: 'mail-sec' }, 'Accounts'),
    accounts,
    el('div', { class: 'mail-sec' }, 'Smart folders'),
    folderBtns,
    labelsBlock,
    el('div', { class: 'grow' }),
    el('button', { class: 'mail-nav subtle', onclick: () => window.dispatchEvent(new CustomEvent('pam:settings', { detail: 'mail' })) }, el('span', { class: 'mail-nav-icon' }, icon('settings')), el('span', { class: 'mail-nav-text' }, 'Email settings'))
  );
}

function renderList() {
  const sf = folders().find((x) => x.id === M.folder) || folders()[0];
  const acct = M.view.accountId ? accountById(M.view.accountId) : null;
  const f =
    M.view.type === 'label' ? { name: M.view.name, icon: 'label', color: acct?.color || '#5ab8ff' } :
    M.view.type === 'search' ? { name: `Search: ${M.view.query}`, icon: 'search', color: '#9b6bff' } :
    M.view.type === 'drafts' ? { name: 'Drafts', icon: 'draft', color: '#ffb74d' } : sf;
  const items = visible();
  const tickable = items.filter((m) => !m.draft);
  const ticked = tickable.filter((m) => M.checked.has(keyOf(m)));
  const sv = specialView();
  const allBox = el('input', { type: 'checkbox', class: 'mail-check', title: 'Tick every email shown', 'aria-label': 'Select all' });
  allBox.checked = tickable.length > 0 && ticked.length === tickable.length;
  allBox.indeterminate = ticked.length > 0 && ticked.length < tickable.length;
  allBox.addEventListener('change', () => {
    if (allBox.checked) tickable.forEach((m) => M.checked.add(keyOf(m)));
    else M.checked.clear();
    render();
  });
  const bulkBtn = (ic, label, kind, title) => el('button', { class: 'btn btn-tonal small', title: title || label, onclick: () => (kind === 'labelpick' ? labelMail(ticked, 'label') : changeMail(ticked, kind)) }, icon(ic), label);
  const bulk = ticked.length
    ? el('div', { class: 'mail-bulk' },
        el('b', {}, `${ticked.length} selected`),
        sv
          ? [bulkBtn(sv === 'spam' ? 'report_off' : 'move_to_inbox', sv === 'spam' ? 'Not spam' : 'Move to inbox', sv === 'spam' ? 'notspam' : 'inbox'), bulkBtn('delete_forever', 'Delete forever', 'forever')]
          : [bulkBtn('archive', 'Archive', 'archive', 'Archive (E)'), bulkBtn('delete', 'Delete', 'trash', 'Move to Trash (#)'), bulkBtn('report', 'Spam', 'spam', 'Report spam (!)')],
        bulkBtn('drafts', 'Read', 'read', 'Mark as read (Shift+I)'),
        bulkBtn('mark_email_unread', 'Unread', 'unread', 'Mark as unread (Shift+U)'),
        bulkBtn('star', 'Star', ticked.every((m) => m.starred) ? 'unstar' : 'star', 'Star / unstar (S)'),
        bulkBtn('label', 'Label', 'labelpick', 'Label as… (L)'),
        el('button', { class: 'btn btn-text small', onclick: () => (M.checked.clear(), render()) }, 'Clear'))
    : '';
  // v9.4: searching is done in the permanent search box at the top of the window (search.js).
  return el(
    'section',
    { class: 'mail-list' },
    el(
      'div',
      { class: 'mail-list-head' },
      el('div', { class: 'mail-list-title', style: { '--c': f.color } }, tickable.length ? allBox : '', icon(f.icon), el('span', {}, f.name), el('small', {}, `${items.length}`)),
      el(
        'div',
        { class: 'mail-tools' },
        el('button', { class: 'btn btn-tonal', title: 'Check for new mail', onclick: () => refresh() }, icon('refresh'), 'Refresh'),
        el('button', { class: 'btn btn-tonal ai-btn', title: 'Claude reads new mail: finds customers, what needs a reply and what is time-sensitive', onclick: () => smartSort({ onlyNew: false }) }, icon('auto_awesome'), 'Smart Sort'),
        cleanupCandidates().length
          ? el('button', { class: 'btn btn-tonal', title: 'Move marketing and loan offers out of your inbox (nothing is deleted)', onclick: cleanUp }, icon('cleaning_services'), `Clean up (${cleanupCandidates().length})`)
          : ''
      ),
      M.search && M.view.type !== 'search'
        ? el('div', { class: 'mail-filter-note' }, icon('filter_alt'), el('span', {}, `Showing emails that match “${M.search}”`), el('button', { class: 'btn btn-text small', onclick: () => setSearchText('') }, 'Show all'))
        : '',
      bulk,
      el('div', { id: 'mailStatus', class: 'mail-status' })
    ),
    el(
      'div',
      { class: 'mail-rows' },
      items.length
        ? items.map(row)
        : el('div', { class: 'mail-empty' }, icon('celebration'), el('div', {}, M.loading || (M.view.type === 'drafts' && !M.drafts) ? 'Loading…' : M.view.type === 'search' ? 'Nothing found.' : M.view.type === 'drafts' ? 'No drafts.' : 'Nothing here. Nice!')),
      listFooter()
    )
  );
}

/** "Showing the newest 200 of 66,069" + Load older, and a server-search shortcut. */
function listFooter() {
  const parts = [];
  if (M.search && M.view.type !== 'search')
    parts.push(el('button', { class: 'btn btn-tonal', onclick: () => searchAll(M.search) }, icon('travel_explore'), `Search all mail for “${M.search}”`));
  let loaded = 0;
  let total = 0;
  if (M.view.type === 'label') {
    const cur = M.labelMsgs.get(M.view.accountId + '|' + M.view.mailbox);
    loaded = cur?.messages.length || 0;
    total = cur?.total || 0;
  } else if (M.view.type === 'inbox') {
    for (const a of signedIn().filter((a) => !M.account || a.id === M.account)) {
      loaded += M.messages.filter((m) => m.accountId === a.id).length;
      total += M.totals[a.id] || 0;
    }
  }
  if (M.view.type !== 'search' && total > 0) {
    parts.push(el('div', { class: 'mail-more-text' }, `Showing the newest ${loaded.toLocaleString()} of ${total.toLocaleString()}${M.view.type === 'inbox' ? ' in the inbox' : ''}.`));
    if (loaded < total) parts.push(el('button', { class: 'btn btn-tonal', onclick: loadOlder }, icon('expand_more'), 'Load older'));
  }
  if (M.view.type === 'search') parts.push(el('button', { class: 'btn btn-text', onclick: () => ((M.view = { type: 'inbox' }), setSearchText('')) }, icon('arrow_back'), 'Back to inbox'));
  return parts.length ? el('div', { class: 'mail-more' }, parts) : '';
}

function row(m) {
  const acct = accountById(m.accountId);
  const [, fcolor] = folderLook(m.folder);
  const go = () => (m.draft ? resumeDraft(m) : open(m));
  const box = m.draft ? '' : el('input', { type: 'checkbox', class: 'mail-check', 'aria-label': 'Select', title: 'Tick to act on several emails (X)', onclick: (e) => e.stopPropagation() });
  if (box) {
    box.checked = M.checked.has(keyOf(m));
    box.addEventListener('change', () => (box.checked ? M.checked.add(keyOf(m)) : M.checked.delete(keyOf(m)), render()));
  }
  const star = m.draft
    ? ''
    : el('button', { class: 'mail-star' + (m.starred ? ' on' : ''), title: m.starred ? 'Starred (S to remove)' : 'Star it (S)', 'aria-label': 'Star', onclick: (e) => (e.stopPropagation(), changeMail([m], m.starred ? 'unstar' : 'star')) }, icon(m.starred ? 'star' : 'star_outline'));
  return el(
    'div',
    {
      class: 'mail-row' + (m.read || m.draft ? '' : ' unread') + (keyOf(m) === M.selected ? ' on' : '') + (M.checked.has(keyOf(m)) ? ' ticked' : ''),
      role: 'button',
      tabindex: '0',
      style: { '--acct': acct?.color || '#5ab8ff' },
      onclick: go,
      onkeydown: (e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') (e.preventDefault(), go());
        if (e.key === 'Delete') (e.preventDefault(), specialView() ? changeMail([m], 'forever') : deleteMail(m));
      },
    },
    el(
      'div',
      { class: 'mail-row-top' },
      box,
      el('span', { class: 'mail-from' }, m.draft ? 'To: ' + (m.to || '(nobody yet)') : m.fromName || m.fromAddress),
      el('span', { class: 'mail-date' }, shortDate(m.date)),
      star,
      el('button', { class: 'mail-del', title: m.draft ? 'Delete this draft' : specialView() ? 'Delete forever' : 'Delete (moves it to Trash; Undo puts it back)', 'aria-label': 'Delete', onclick: (e) => (e.stopPropagation(), specialView() && !m.draft ? changeMail([m], 'forever') : deleteMail(m)) }, icon(specialView() && !m.draft ? 'delete_forever' : 'delete'))
    ),
    el('div', { class: 'mail-subject' }, m.subject),
    el('div', { class: 'mail-preview' }, m.preview),
    el(
      'div',
      { class: 'mail-chips' },
      m.draft ? el('span', { class: 'mchip', style: { '--c': '#ffb74d' } }, icon('draft'), 'Draft · ' + (acct?.name || acct?.email || '')) : '',
      m.urgency ? el('span', { class: 'mchip urgent' + (m.urgency === 'soon' ? ' soon' : '') }, icon('alarm'), (m.urgency === 'now' ? 'Time-sensitive' : 'This week') + (m.due ? ' · ' + m.due : '')) : '',
      m.kind === 'customer' && !m.clutter ? el('span', { class: 'mchip cust' }, icon('storefront'), 'Customer') : '',
      m.folder ? el('span', { class: 'mchip', style: { '--c': fcolor } }, m.clutter ? `${CLUTTER} · ${m.clutterWhy}` : m.folder) : '',
      m.needsReply ? el('span', { class: 'mchip reply' }, icon('reply'), 'Needs reply') : '',
      m.hasAttachments ? el('span', { class: 'mchip plain' }, icon('attach_file')) : ''
    )
  );
}

async function open(m) {
  M.selected = keyOf(m);
  render();
  if (M.bodies.has(keyOf(m))) {
    // Opened before and marked unread since (v9.5): opening it again marks it read, like Gmail.
    if (!m.read) {
      m.read = true;
      updateBadge();
      render();
      host.mail.modify(m.accountId, [m.uid], { read: true }, m.mailbox || 'INBOX').catch(() => {});
    }
    return;
  }
  try {
    const body = await host.mail.message(m.accountId, m.uid, m.mailbox || 'INBOX');
    M.bodies.set(keyOf(m), body);
    m.read = true;
    updateBadge();
    if (M.selected === keyOf(m)) render();
  } catch (e) {
    M.bodies.set(keyOf(m), { text: "Couldn't open this email: " + e.message, html: '', attachments: [] });
    if (M.selected === keyOf(m)) renderReader();
  }
}

// ---------------------------------------------------------------------------
// Delete (v9.4): the trash can on each email and in the reader
// ---------------------------------------------------------------------------
/** Takes one email off every list on screen. Returns a function that puts it back. */
function takeOffScreen(m) {
  const k = keyOf(m);
  const lists = [M.messages, M.searchResults, M.drafts, ...[...M.labelMsgs.values()].map((x) => x.messages)].filter(Boolean);
  const removed = [];
  for (const list of lists) {
    const i = list.findIndex((x) => keyOf(x) === k);
    if (i >= 0) removed.push([list, i, list.splice(i, 1)[0]]);
  }
  return () => {
    for (const [list, i, item] of removed.reverse()) if (!list.some((x) => keyOf(x) === k)) list.splice(Math.min(i, list.length), 0, item);
  };
}

/** Moves an email to Trash in Gmail (Gmail keeps Trash for 30 days). Drafts are discarded. Undo puts it back. */
async function deleteMail(m) {
  if (m.draft) {
    if (!(await confirmDialog('Delete this draft?', `“${m.subject || '(no subject)'}” will be removed from Drafts.`, 'Delete'))) return;
  }
  // The next email down gets selected, so you can keep reading (or keep deleting).
  const shown = visible();
  const at = shown.findIndex((x) => keyOf(x) === keyOf(m));
  const wasOpen = M.selected === keyOf(m);
  const next = wasOpen ? shown[at + 1] || shown[at - 1] || null : null;
  const putBack = takeOffScreen(m);
  if (wasOpen) M.selected = next && !next.draft ? keyOf(next) : null;
  render();
  updateBadge();
  if (wasOpen && next && !next.draft) open(next);
  try {
    if (m.draft) {
      await host.mail.deleteDraft(m.accountId, m.uid);
      setStatus('Draft deleted.');
      return;
    }
    const res = await host.mail.modify(m.accountId, [m.uid], { trash: true }, m.mailbox || 'INBOX');
    const trashUids = res?.trashUids || [];
    setStatus(`Moved to Trash: ${m.subject || '(no subject)'}`, false, trashUids.length ? { label: 'Undo', onclick: () => undoDelete(m, trashUids) } : null);
  } catch (e) {
    putBack();
    render();
    updateBadge();
    toast("Couldn't delete it: " + (e.message || e), { error: true });
  }
}

/** Delete key in Mail: deletes the email that's open in the reader. */
export function deleteSelected() {
  const m = current();
  if (!m) return false;
  deleteMail(m);
  return true;
}

async function undoDelete(m, trashUids) {
  setStatus('Putting it back…', true);
  try {
    await host.mail.moveBack(m.accountId, trashUids, '\\Trash');
    // It's back in the inbox with a new ID, so load the lists again rather than reusing the old copy.
    M.labelMsgs.clear();
    setStatus('Put back in the inbox.');
    if (M.view.type === 'search') searchAll(M.view.query);
    else if (M.view.type === 'label') openLabel(M.view.accountId, { fullName: M.view.mailbox, name: M.view.name, kind: M.view.kind });
    await refresh({ quiet: true });
    render();
  } catch (e) {
    setStatus("Couldn't put it back: " + (e.message || e));
  }
}

// ---------------------------------------------------------------------------
// Archive, star, read/unread, labels, spam, Trash & Spam views (v9.5)
// ---------------------------------------------------------------------------
/** "trash" or "spam" when one of those folders is open, else null. */
const specialView = () => (M.view.type === 'label' && ['trash', 'spam'].includes(M.view.kind) ? M.view.kind : null);
const accountLabel = (m) => {
  const a = accountById(m.accountId);
  return a ? (a.name ? `${a.name} <${a.email}>` : a.email) : '';
};
/** The emails a key or bulk button acts on: the ticked ones if any are ticked, else the open one. */
function targets() {
  const ticked = visible().filter((m) => M.checked.has(keyOf(m)) && !m.draft);
  if (ticked.length) return ticked;
  const m = current();
  return m && !m.draft ? [m] : [];
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Changes emails on the server and on screen.
 * kind: archive | trash | spam | notspam | inbox | forever | read | unread | star | unstar | label | movelabel
 */
async function changeMail(list, kind, { label = '' } = {}) {
  list = list.filter((m) => !m.draft);
  if (!list.length) return;
  const n = list.length;
  const what = n === 1 ? `“${list[0].subject || '(no subject)'}”` : plural(n, 'email');
  if (kind === 'forever' && !(await confirmDialog('Delete for good?', `${what} will be deleted for good. This can't be undone.`, 'Delete forever'))) return;
  if (kind === 'spam' && n > 1 && !(await confirmDialog('Report spam?', `Move ${plural(n, 'email')} to Spam? Gmail learns from this.`, 'Report spam'))) return;

  const leaves = ['archive', 'movelabel', 'trash', 'spam', 'notspam', 'inbox', 'forever'].includes(kind);
  const putBacks = [];
  const flags = [];
  if (leaves) {
    // Pick the next email so you can keep going, like Gmail.
    const shown = visible();
    const keys = new Set(list.map(keyOf));
    const wasOpen = keys.has(M.selected);
    let next = null;
    if (wasOpen) {
      const at = shown.findIndex((x) => keyOf(x) === M.selected);
      next = shown.slice(at + 1).find((x) => !keys.has(keyOf(x))) || shown.slice(0, at).reverse().find((x) => !keys.has(keyOf(x))) || null;
    }
    for (const m of list) {
      const archiving = kind === 'archive' || kind === 'movelabel';
      // Archiving from a label or a search keeps it there; it only leaves the inbox.
      if (!archiving || M.view.type === 'inbox' || (m.mailbox || 'INBOX') === 'INBOX') putBacks.push(takeOffScreen(m));
      if (archiving && m.messageId) {
        for (const copy of M.messages.filter((x) => x !== m && x.accountId === m.accountId && x.messageId === m.messageId)) putBacks.push(takeOffScreen(copy));
      }
      M.checked.delete(keyOf(m));
    }
    if (wasOpen) M.selected = next && !next.draft ? keyOf(next) : null;
    if (wasOpen && next && !next.draft) open(next);
  } else {
    const field = kind === 'read' || kind === 'unread' ? 'read' : kind === 'star' || kind === 'unstar' ? 'starred' : null;
    for (const m of list) {
      if (field) {
        flags.push([m, field, m[field]]);
        m[field] = kind === 'read' || kind === 'star';
      }
      if (kind === 'label') m.labels = [...new Set([...(m.labels || []), label])];
    }
  }
  render();
  updateBadge();

  // One server call per account and folder.
  const groups = new Map();
  for (const m of list) {
    const g = m.accountId + '\n' + (m.mailbox || 'INBOX');
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(m);
  }
  const change = {
    archive: { archive: true }, movelabel: { archive: true, addLabels: [label] }, label: { addLabels: [label] },
    trash: { trash: true }, spam: { spam: true }, forever: { deleteForever: true },
    read: { read: true }, unread: { read: false }, star: { starred: true }, unstar: { starred: false },
  }[kind];
  const results = [];
  setStatus('Working…', true);
  try {
    for (const group of groups.values()) {
      const { accountId, mailbox = 'INBOX' } = group[0];
      const uids = group.map((m) => m.uid);
      if (kind === 'notspam' || kind === 'inbox') await host.mail.moveBack(accountId, uids, mailbox);
      else results.push({ group, res: await host.mail.modify(accountId, uids, change, mailbox) });
    }
  } catch (e) {
    for (const back of putBacks.reverse()) back();
    for (const [m, field, was] of flags) m[field] = was;
    render();
    updateBadge();
    setStatus("Couldn't do that: " + (e.message || e));
    return;
  }

  const done = {
    archive: `Archived ${what}.`, movelabel: `Moved ${what} to ${label}.`, label: `Labeled ${what} “${label}”.`,
    trash: `Moved ${what} to Trash.`, spam: `Reported ${what} as spam.`, notspam: `Moved ${what} back to the inbox.`,
    inbox: `Moved ${what} back to the inbox.`, forever: `Deleted ${what} for good.`,
    read: `Marked ${what} as read.`, unread: `Marked ${what} as unread.`, star: `Starred ${what}.`, unstar: `Took the star off ${what}.`,
  }[kind];
  let undo = null;
  if (kind === 'archive' || kind === 'movelabel')
    undo = async () => {
      for (const m of list.filter((x) => x.messageId))
        await host.mail.modifyMatching(m.accountId, `rfc822msgid:${m.messageId}`, { toInbox: true, ...(kind === 'movelabel' ? { removeLabels: [label] } : {}) }, 5);
    };
  else if (kind === 'trash' || kind === 'spam')
    undo = async () => {
      for (const { group, res } of results) if (res?.trashUids?.length) await host.mail.moveBack(group[0].accountId, res.trashUids, kind === 'trash' ? '\\Trash' : '\\Junk');
    };
  if (kind === 'notspam') list.forEach(markSafe);
  if (leaves) M.labelMsgs.forEach((v, k) => !(M.view.type === 'label' && k === M.view.accountId + '|' + M.view.mailbox) && M.labelMsgs.delete(k));
  setStatus(done, false, undo ? { label: 'Undo', onclick: () => undoChange(undo) } : null);
  if (kind === 'notspam' || kind === 'inbox') refresh({ quiet: true });
}

async function undoChange(fn) {
  setStatus('Putting it back…', true);
  try {
    await fn();
    M.labelMsgs.clear();
    if (M.view.type === 'search') searchAll(M.view.query);
    else if (M.view.type === 'label') openLabel(M.view.accountId, { fullName: M.view.mailbox, name: M.view.name, kind: M.view.kind });
    await refresh({ quiet: true });
    setStatus('Put back.');
  } catch (e) {
    setStatus("Couldn't put it back: " + (e.message || e));
  }
}

/** Gmail labels you can put an email in: every label from the sidebar, plus your smart folder names. */
async function pickLabel(m, verb) {
  const names = [...new Set((M.labels.get(m.accountId) || []).filter((f) => f.kind === 'label').map((f) => f.fullName))].sort((a, b) => a.localeCompare(b));
  const input = el('input', { class: 'field', list: 'pamLabelList', placeholder: 'Pick a label or type a new one (use / for a sub-label)', style: { width: '100%' } });
  const listEl = el('datalist', { id: 'pamLabelList' }, names.map((n) => el('option', { value: n })));
  const ok = await dialog({
    title: verb === 'move' ? 'Move to label' : 'Label as',
    body: el('div', {}, el('p', { class: 'hint' }, verb === 'move' ? 'Adds the Gmail label and takes it out of the inbox.' : 'Adds a Gmail label. New labels are made for you.'), input, listEl),
    buttons: [{ label: 'Cancel', value: false }, { label: verb === 'move' ? 'Move' : 'Add label', value: true, primary: true }],
  });
  const name = input.value.trim().replace(/^\/+|\/+$/g, '');
  return ok && name ? name : null;
}
async function labelMail(list, verb) {
  if (!list.length) return;
  const name = await pickLabel(list[0], verb);
  if (name) changeMail(list, verb === 'move' ? 'movelabel' : 'label', { label: name });
}

// ---------------------------------------------------------------------------
// Print and PDF (v9.5)
// ---------------------------------------------------------------------------
async function ensureBody(m) {
  const k = keyOf(m);
  if (!M.bodies.has(k)) {
    M.bodies.set(k, await host.mail.message(m.accountId, m.uid, m.mailbox || 'INBOX'));
    m.read = true;
    updateBadge();
  }
  return M.bodies.get(k);
}

/** The email as a printable page, or null if cancelled. Asks first if it has web pictures that are still hidden. */
async function buildPage(m, verb) {
  let body;
  try {
    body = await ensureBody(m);
  } catch (e) {
    toast("Couldn't open the email: " + (e.message || e), { error: true });
    return null;
  }
  let pictures = M.showPictures.has(keyOf(m));
  if (!pictures && hasWebPictures(body.html)) {
    const v = await dialog({
      title: `${verb} with pictures?`,
      body: 'This email has pictures from the web (logos, photos). Loading them can tell the sender the email was opened.',
      buttons: [{ label: 'Cancel', value: 'cancel' }, { label: 'Without pictures', value: 'no' }, { label: 'Include pictures', value: 'yes', primary: true }],
    });
    if (!v || v === 'cancel') return null;
    pictures = v === 'yes';
  }
  return emailPage(m, body, { pictures, account: accountLabel(m), date: longDate(m.date) });
}

async function printMail(m) {
  const html = await buildPage(m, 'Print');
  if (html) await printEmailPage(html);
}

/** Ctrl+P / the Print button in Mail: prints the email that's open. */
export function printSelected() {
  const m = current();
  if (!m || m.draft) {
    toast('Open an email first, then press Print.');
    return false;
  }
  printMail(m);
  return true;
}

const pdfName = (m) => ((m.subject || 'Email').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Email') + '.pdf';

/** Saves the email as a PDF file, or opens it in Documents to mark up, sign or combine. */
async function mailToPdf(m, { openIt = false } = {}) {
  const html = await buildPage(m, openIt ? 'Open' : 'Save');
  if (!html) return;
  busy('Making the PDF…');
  try {
    const bytes = await emailPdf(html);
    busy(false);
    if (!bytes) return toast('Saving emails as PDF works in the PDF and Moore Windows app.', { error: true });
    if (openIt) {
      if (M.onOpenFile) await M.onOpenFile({ name: pdfName(m), bytes });
    } else {
      const path = await host.saveFile({ name: pdfName(m), bytes, mime: 'application/pdf' });
      if (path) toast('Saved to ' + path);
    }
  } catch (e) {
    busy(false);
    toast("Couldn't make the PDF: " + (e.message || e), { error: true });
  }
}

// ---------------------------------------------------------------------------
// "More" menu in the reader (v9.5)
// ---------------------------------------------------------------------------
function popMenu(anchor, items) {
  document.querySelector('.mail-menu')?.remove();
  const menu = el(
    'div',
    { class: 'menu-pop mail-menu', role: 'menu' },
    items.filter(Boolean).map((it) =>
      it === '-'
        ? el('div', { class: 'menu-sep' })
        : el('button', { class: 'menu-item', role: 'menuitem', onclick: () => (menu.remove(), it.run()) }, icon(it.icon), el('span', {}, it.label), it.kbd ? el('span', { class: 'kbd' }, it.kbd) : '')
    )
  );
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  const below = r.bottom + 4;
  menu.style.top = (below + menu.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - menu.offsetHeight - 4) : below) + 'px';
  const away = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('mousedown', away, true);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', away, true), 0);
}

function moreMenu(btn, m) {
  const sv = specialView();
  popMenu(btn, [
    { icon: 'print', label: 'Print', kbd: 'Ctrl+P', run: () => printMail(m) },
    { icon: 'picture_as_pdf', label: 'Save as PDF…', run: () => mailToPdf(m) },
    { icon: 'edit_document', label: 'Open as PDF in Documents', run: () => mailToPdf(m, { openIt: true }) },
    '-',
    { icon: m.read ? 'mark_email_unread' : 'drafts', label: m.read ? 'Mark as unread' : 'Mark as read', kbd: m.read ? 'Shift+U' : 'Shift+I', run: () => changeMail([m], m.read ? 'unread' : 'read') },
    { icon: m.starred ? 'star' : 'star_outline', label: m.starred ? 'Remove star' : 'Add star', kbd: 'S', run: () => changeMail([m], m.starred ? 'unstar' : 'star') },
    { icon: 'label', label: 'Label as…', kbd: 'L', run: () => labelMail([m], 'label') },
    !sv ? { icon: 'drive_file_move', label: 'Move to label…', kbd: 'V', run: () => labelMail([m], 'move') } : null,
    '-',
    sv === 'spam' ? { icon: 'report_off', label: 'Not spam', run: () => changeMail([m], 'notspam') } : { icon: 'report', label: 'Report spam', kbd: '!', run: () => changeMail([m], 'spam') },
    sv ? { icon: 'delete_forever', label: 'Delete forever', run: () => changeMail([m], 'forever') } : null,
    { icon: 'content_copy', label: 'Copy sender address', run: () => navigator.clipboard.writeText(m.fromAddress).then(() => toast('Copied ' + m.fromAddress)) },
  ]);
}

// ---------------------------------------------------------------------------
// Keyboard (v9.5): Gmail-style keys while Mail is showing and you're not typing
// ---------------------------------------------------------------------------
const KEYS = [
  ['J / K', 'Next / previous email'],
  ['R', 'Reply'], ['A', 'Reply all'], ['F', 'Forward'], ['C', 'New email'],
  ['E', 'Archive'], ['# or Delete', 'Move to Trash'], ['!', 'Report spam'],
  ['S', 'Star / unstar'], ['Shift+U', 'Mark unread'], ['Shift+I', 'Mark read'],
  ['L', 'Label as…'], ['V', 'Move to label…'], ['X', 'Tick the open email'], ['Esc', 'Untick everything'],
  ['/', 'Search'], ['Ctrl+P', 'Print the open email'], ['Ctrl+1 / Ctrl+2', 'Documents / Mail'],
];

export function shortcutsHelp() {
  dialog({
    title: 'Mail keyboard shortcuts',
    width: '480px',
    body: el('table', { style: { width: '100%', borderCollapse: 'collapse' } }, KEYS.map(([k, d]) => el('tr', {}, el('td', { style: { padding: '4px 12px 4px 0', fontWeight: 600, whiteSpace: 'nowrap' } }, k), el('td', {}, d)))),
  });
}

function step(dir) {
  const shown = visible().filter((m) => !m.draft);
  if (!shown.length) return;
  const at = shown.findIndex((m) => keyOf(m) === M.selected);
  const next = at < 0 ? shown[0] : shown[Math.max(0, Math.min(shown.length - 1, at + dir))];
  if (next && keyOf(next) !== M.selected) {
    open(next);
    setTimeout(() => document.querySelector('.mail-row.on')?.scrollIntoView({ block: 'nearest' }), 0);
  }
}

/** Returns true when the key was a Mail shortcut (app.js then stops it). */
export function handleKey(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (!M.settings || !signedIn().length) return false;
  const m = current();
  const list = targets();
  const sv = specialView();
  switch (e.key) {
    case 'j': return step(1), true;
    case 'k': return step(-1), true;
    case 'c': return composeMail(), true;
    case '/': return $('#gsInput')?.focus(), true;
    case 'r': return m && !m.draft ? (reply(m, false), true) : false;
    case 'a': return m && !m.draft ? (reply(m, true), true) : false;
    case 'f': return m && !m.draft ? (forward(m), true) : false;
    case 'e': return list.length && !sv ? (changeMail(list, 'archive'), true) : false;
    case '#':
    case 'Delete':
      if (sv) return list.length ? (changeMail(list, 'forever'), true) : false;
      if (M.checked.size) return list.length ? (changeMail(list, 'trash'), true) : false;
      return deleteSelected();
    case '!': return list.length ? (changeMail(list, sv === 'spam' ? 'notspam' : 'spam'), true) : false;
    case 's': return list.length ? (changeMail(list, list.every((x) => x.starred) ? 'unstar' : 'star'), true) : false;
    case 'U': return list.length ? (changeMail(list, 'unread'), true) : false;
    case 'I': return list.length ? (changeMail(list, 'read'), true) : false;
    case 'l': return list.length ? (labelMail(list, 'label'), true) : false;
    case 'v': return list.length && !sv ? (labelMail(list, 'move'), true) : false;
    case 'x':
      if (!m) return false;
      M.checked.has(keyOf(m)) ? M.checked.delete(keyOf(m)) : M.checked.add(keyOf(m));
      render();
      return true;
    case 'Escape':
      if (!M.checked.size) return false;
      M.checked.clear();
      render();
      return true;
    case '?': return shortcutsHelp(), true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Address suggestions in To / Cc / Bcc (v9.5): people you've emailed or heard from
// ---------------------------------------------------------------------------
function knownContacts() {
  const map = new Map();
  const add = (name, addr, weight) => {
    addr = (addr || '').trim().toLowerCase();
    if (!addr.includes('@') || /no-?reply|donotreply|mailer-daemon|notifications?@|bounce/.test(addr)) return;
    name = (name || '').replace(/"/g, '').trim();
    if (name.toLowerCase() === addr) name = '';
    const cur = map.get(addr);
    if (!cur) map.set(addr, { name, addr, n: weight });
    else {
      cur.n += weight;
      if (!cur.name && name) cur.name = name;
    }
  };
  for (const m of allLoaded()) {
    if (m.clutter || m.bulk) continue;
    add(m.fromName, m.fromAddress, 1);
    for (const a of [...splitAddresses(m.to), ...splitAddresses(m.cc)]) add(a.replace(/<[^>]*>/, ''), emailOnly(a), 2); // people you write to count more
  }
  for (const i of allIdentities()) map.delete(i.address.toLowerCase());
  return [...map.values()];
}

/** Wraps an address box with a drop-down of matching people. Returns the wrapper. */
function withSuggestions(input) {
  const pop = el('div', { class: 'addr-pop', role: 'listbox' });
  const wrap = el('div', { class: 'addr-wrap' }, input, pop);
  let items = [];
  let at = 0;
  let contacts = null;
  const lastToken = () => {
    const v = input.value;
    const i = Math.max(v.lastIndexOf(','), v.lastIndexOf(';'));
    return { start: i + 1, text: v.slice(i + 1).trim().toLowerCase() };
  };
  const hide = () => ((items = []), pop.classList.remove('show'));
  const show = () => {
    const { text } = lastToken();
    if (text.length < 1) return hide();
    contacts ||= knownContacts();
    items = contacts
      .filter((c) => c.addr.includes(text) || c.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(text)) || c.name.toLowerCase().startsWith(text))
      .sort((a, b) => b.n - a.n)
      .slice(0, 7);
    at = 0;
    if (!items.length) return hide();
    pop.replaceChildren(
      ...items.map((c, i) =>
        el('div', { class: 'addr-item' + (i === at ? ' on' : ''), role: 'option', onmousedown: (e) => (e.preventDefault(), pick(i)) },
          el('span', { class: 'addr-name' }, c.name || c.addr), c.name ? el('small', {}, c.addr) : '')
      )
    );
    pop.classList.add('show');
  };
  const pick = (i) => {
    const c = items[i];
    if (!c) return;
    const { start } = lastToken();
    const safeName = c.name && !/[,;<>"]/.test(c.name);
    input.value = input.value.slice(0, start).replace(/\s*$/, start ? ' ' : '') + (safeName ? `${c.name} <${c.addr}>` : c.addr) + ', ';
    hide();
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const mark = () => [...pop.children].forEach((n, i) => n.classList.toggle('on', i === at));
  input.addEventListener('input', (e) => (e.isTrusted ? show() : null));
  input.addEventListener('blur', () => setTimeout(hide, 120));
  input.addEventListener('keydown', (e) => {
    if (!items.length) return;
    if (e.key === 'ArrowDown') (e.preventDefault(), (at = (at + 1) % items.length), mark());
    else if (e.key === 'ArrowUp') (e.preventDefault(), (at = (at - 1 + items.length) % items.length), mark());
    else if ((e.key === 'Enter' && !e.ctrlKey) || e.key === 'Tab') (e.preventDefault(), e.stopPropagation(), pick(at));
    else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), hide());
  });
  return wrap;
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

  const sv = specialView();
  const moreBtn = el('button', { class: 'btn btn-tonal', title: 'More: Save as PDF, Open in Documents, unread, labels, spam…', onclick: (e) => moreMenu(e.currentTarget, m) }, icon('more_horiz'), 'More');
  const actions = el(
    'div',
    { class: 'mail-actions' },
    el('button', { class: 'btn btn-tonal', title: 'Reply (R)', onclick: () => reply(m, false) }, icon('reply'), 'Reply'),
    el('button', { class: 'btn btn-tonal', title: 'Reply all (A)', onclick: () => reply(m, true) }, icon('reply_all'), 'Reply all'),
    el('button', { class: 'btn btn-tonal', title: 'Forward (F)', onclick: () => forward(m) }, icon('forward'), 'Forward'),
    sv
      ? [
          sv === 'spam'
            ? el('button', { class: 'btn btn-tonal', title: 'Not spam: back to the inbox (!)', onclick: () => changeMail([m], 'notspam') }, icon('report_off'), 'Not spam')
            : el('button', { class: 'btn btn-tonal', title: 'Take it out of Trash and put it back in the inbox', onclick: () => changeMail([m], 'inbox') }, icon('move_to_inbox'), 'Move to inbox'),
          el('button', { class: 'btn btn-tonal mail-del-btn', title: 'Delete for good (Del). This can\'t be undone.', onclick: () => changeMail([m], 'forever') }, icon('delete_forever'), 'Delete forever'),
        ]
      : [
          el('button', { class: 'btn btn-tonal', title: 'Archive: out of the inbox, still in All Mail and its labels (E). Undo puts it back.', onclick: () => changeMail([m], 'archive') }, icon('archive'), 'Archive'),
          el('button', { class: 'btn btn-tonal mail-del-btn', title: 'Move to Trash (Del). Undo puts it back.', onclick: () => deleteMail(m) }, icon('delete'), 'Delete'),
        ],
    el('button', { class: 'btn btn-tonal mail-star-btn' + (m.starred ? ' on' : ''), title: m.starred ? 'Remove star (S)' : 'Star it (S)', onclick: () => changeMail([m], m.starred ? 'unstar' : 'star') }, icon(m.starred ? 'star' : 'star_outline'), m.starred ? 'Starred' : 'Star'),
    el('button', { class: 'btn btn-tonal mail-print-btn', title: 'Print this email (Ctrl+P)', onclick: () => printMail(m) }, icon('print'), 'Print'),
    moreBtn,
    el('span', { class: 'mail-actions-sep' }),
    el('button', { class: 'btn btn-tonal ai-btn', onclick: () => summarize(m) }, icon('summarize'), 'Summarize'),
    el('button', { class: 'btn btn-tonal ai-btn', onclick: () => suggestReplies(m) }, icon('auto_awesome'), 'Suggest replies'),
    m.needsReply ? el('button', { class: 'btn btn-tonal', title: 'Take it off Needs reply', onclick: () => moveTo(m, '__reply') }, icon('done'), 'Mark replied') : '',
    m.clutter
      ? el('button', { class: 'btn btn-tonal', title: 'Real mail: never mark this sender as clutter', onclick: () => moveTo(m, '__notClutter') }, icon('verified'), 'Not clutter')
      : el('button', { class: 'btn btn-tonal', title: 'Marketing or an offer: send it to Clutter', onclick: () => moveTo(m, CLUTTER) }, icon('delete_sweep'), 'Clutter'),
    el('select', { class: 'field mail-move', title: 'Move to smart folder', onchange: (e) => moveTo(m, e.target.value) },
      el('option', { value: '' }, 'Move to…'),
      [...new Set([...(M.settings.folders || []), CLUTTER])].map((f) => el('option', { value: f }, f)),
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
          el('div', { class: 'mail-who-to' }, longDate(m.date) + '  ·  ' + (acct ? acct.name || acct.email : '')),
          m.labels?.length ? el('div', { class: 'mail-labels' }, m.labels.map((l) => el('span', { class: 'mchip plain' }, icon('label'), l))) : ''
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
    const file = await host.mail.attachment(m.accountId, m.uid, a.index, m.mailbox || 'INBOX');
    setStatus('');
    if (M.onOpenFile) await M.onOpenFile(file);
  } catch (e) {
    toast(e.message, { error: true });
  }
}
async function saveAttachment(m, a) {
  try {
    const path = await host.mail.saveAttachment(m.accountId, m.uid, a.index, m.mailbox || 'INBOX');
    if (path) toast('Saved to ' + path);
  } catch (e) {
    toast(e.message, { error: true });
  }
}

function moveTo(m, value) {
  if (!value) return;
  const c = entry(m);
  if (value === '__reply') {
    c[0] = c[0] || m.folder;
    c[1] = !m.needsReply;
    if (!c[1]) c[2] = c[3] = ''; // replied: no longer time-sensitive
  } else if (value === '__notClutter') {
    markSafe(m);
    if (JUNK_KINDS.includes(c[4]) || !c[4]) c[4] = 'person';
    if (c[0] === CLUTTER) c[0] = '';
    toast(`Got it. Mail from ${m.fromAddress} won't be marked as clutter.`);
  } else {
    if (m.clutter && value !== CLUTTER) markSafe(m);
    c[0] = value;
    if (value === CLUTTER) {
      if (!JUNK_KINDS.includes(c[4])) c[4] = 'marketing';
      c[1] = false;
      c[2] = c[3] = '';
    } else if (JUNK_KINDS.includes(c[4])) c[4] = 'person';
  }
  M.sort[keyOf(m)] = c;
  saveSortCache();
  applySorting(m);
  if (value !== '__reply' && value !== '__notClutter' && m.folder !== value)
    toast(`A keyword rule keeps this in ${m.folder}. Change the rule in Settings › Email to move it.`, { ms: 6000 });
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
        attachments = await Promise.all(b.attachments.map((a) => host.mail.attachment(m.accountId, m.uid, a.index, m.mailbox || 'INBOX')));
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

/**
 * Opens the compose window. attachments: [{name, bytes}]. Returns when it closes.
 * draft: { accountId, uid } of a saved draft being finished (v9.3). Whatever you write is saved to that
 * account's Gmail Drafts folder as you go, and closing the window keeps it there, like Gmail.
 */
export async function composeMail({
  from = null, to = '', cc = '', bcc = '', subject = '', body = '', quote = '', attachments = [], replyTo = null,
  draft = null, signature = true, inReplyTo = null, references = null,
} = {}) {
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
  if (composeOpen) await composeOpen.close(true);

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
  const bccBox = el('input', { class: 'field', placeholder: 'Bcc', value: bcc });
  const subjBox = el('input', { class: 'field compose-subject', placeholder: 'Subject', value: subject });
  const bodyBox = el('textarea', { class: 'field compose-body', spellcheck: 'true', placeholder: 'Write your email here, or tell Claude what to write above…' });
  bodyBox.value = body + quote;
  const askBox = el('input', { class: 'field compose-ask', placeholder: 'Tell Claude what to write — e.g. “thank Charlie for the call and ask about pricing on AL80s”' });
  const sigOn = el('input', { type: 'checkbox', checked: signature !== false });
  const sigPreview = el('div', { class: 'compose-sig' });
  const attList = el('div', { class: 'compose-atts' });
  const status = el('div', { class: 'compose-status' });
  const undoBtn = el('button', { class: 'btn btn-text small', disabled: true }, icon('undo'), 'Undo Claude');
  const sendBtn = el('button', { class: 'btn btn-primary compose-send' }, icon('send'), 'Send');
  const startText = bodyBox.value;
  // Which email this answers, so Gmail keeps it in the same conversation (also for a reopened draft).
  const thread = { inReplyTo: inReplyTo || replyTo?.messageId || null, references: references || replyTo?.references || [] };

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
    autosave();
  };
  undoBtn.addEventListener('click', () => {
    const u = undo.pop();
    if (!u) return;
    bodyBox.value = u.body;
    subjBox.value = u.subject;
    undoBtn.disabled = !undo.length;
    autosave();
  });

  // ---- Drafts: saved to the From account's Gmail Drafts folder while you write ----
  let draftRef = draft ? { accountId: draft.accountId, uid: draft.uid } : null;
  let saving = Promise.resolve();
  let finished = false; // sent, discarded or closed: no more saves
  let saveError = '';
  const snapshot = () =>
    JSON.stringify([fromSel.value, toBox.value, ccBox.value, bccBox.value, subjBox.value, bodyBox.value, sigOn.checked, files.map((f) => f.name + ':' + f.bytes.length)]);
  let savedSnap = snapshot(); // a new email isn't saved until you change something
  const startSnap = savedSnap;
  const saveDraft = () =>
    (saving = saving.then(async () => {
      if (finished) return;
      const snap = snapshot();
      if (snap === savedSnap) return;
      const id = fromIdentity();
      if (!id || !accountById(id.accountId)?.hasPassword) return;
      let text = bodyBox.value;
      if (sigOn.checked && id.signature) text = text.replace(/\s+$/, '') + '\n\n' + id.signature;
      const sameAccount = draftRef && draftRef.accountId === id.accountId;
      try {
        const res = await host.mail.saveDraft({
          accountId: id.accountId, from: id.address, to: toBox.value, cc: ccBox.value, bcc: bccBox.value,
          subject: subjBox.value, body: text, attachments: files,
          inReplyTo: thread.inReplyTo, references: thread.references, replaceUid: sameAccount ? draftRef.uid : null,
        });
        // Changed the From account: the draft moves to the new account's Drafts.
        if (draftRef && !sameAccount) host.mail.deleteDraft(draftRef.accountId, draftRef.uid).catch(() => {});
        draftRef = res?.uid ? { accountId: id.accountId, uid: res.uid } : null;
        savedSnap = snap;
        saveError = '';
        const acct = accountById(id.accountId);
        say(`Draft saved in ${acct?.name || acct?.email || id.accountEmail} at ${pad(new Date().getHours())}${pad(new Date().getMinutes())}.`);
        draftsChanged();
      } catch (e) {
        saveError = e.message;
        say("Couldn't save the draft: " + e.message);
      }
    }));
  const autosave = debounce(() => saveDraft(), 4000);

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
    autosave();
  };

  // Undo send (v9.5): the window hides and the email waits a few seconds before it really goes.
  let pending = null;
  const reshow = (message) => {
    if (composeOpen && composeOpen !== me) composeOpen.close(true);
    backdrop.style.display = '';
    composeOpen = me;
    document.body.classList.add('composing');
    sendBtn.disabled = false;
    finished = false;
    say(message);
    bodyBox.focus();
  };
  const reallySend = async (id, text) => {
    finished = true; // no autosave while sending
    await saving;
    try {
      await host.mail.send({
        accountId: id.accountId, from: id.address, to: toBox.value, cc: ccBox.value, bcc: bccBox.value,
        subject: subjBox.value, body: text, attachments: files,
        inReplyTo: thread.inReplyTo, references: thread.references,
      });
      sent = true;
      // Sent: the saved draft isn't needed anymore.
      if (draftRef) host.mail.deleteDraft(draftRef.accountId, draftRef.uid).then(draftsChanged, () => {});
      if (replyTo) {
        const c = entry(replyTo);
        c[0] = replyTo.folder;
        c[1] = false;
        c[2] = c[3] = ''; // answered: off Needs reply and Time-sensitive
        M.sort[keyOf(replyTo)] = c;
        saveSortCache();
        applySorting(replyTo);
        render();
      }
      toast(`Sent from ${id.address} at ${pad(new Date().getHours())}${pad(new Date().getMinutes())}.`);
      close(true);
    } catch (e) {
      if (backdrop.style.display === 'none') toast('Not sent: ' + e.message, { error: true, ms: 7000 });
      reshow('Not sent: ' + e.message);
    }
  };

  const send = async () => {
    if (pending) return;
    const id = fromIdentity();
    if (!id) return say('Pick a From address.');
    if (!toBox.value.trim() && !ccBox.value.trim() && !bccBox.value.trim()) return say('Add who it goes to.');
    if (!subjBox.value.trim() && !(await confirmDialog('No subject', 'Send without a subject?', 'Send anyway'))) return;
    let text = bodyBox.value;
    if (sigOn.checked && id.signature) text = text.replace(/\s+$/, '') + '\n\n' + id.signature;
    sendBtn.disabled = true;
    const wait = undoSendSeconds();
    if (!wait) {
      say('Sending…', true);
      return reallySend(id, text);
    }
    // Hide the window, keep a copy in Drafts in case the app closes, and count down.
    saveDraft();
    backdrop.style.display = 'none';
    if (composeOpen === me) composeOpen = null;
    document.body.classList.remove('composing');
    let left = wait;
    const count = el('span', {}, `Sending in ${left}…`);
    const finish = (undone) => {
      clearInterval(pending.timer);
      pending.bar.remove();
      pending = null;
      if (undone) reshow('Not sent. Change anything you like, then Send.');
      else reallySend(id, text);
    };
    const bar = el('div', { class: 'send-undo', role: 'status' },
      el('span', { class: 'spinner small' }), count,
      el('button', { class: 'btn btn-text', onclick: () => finish(true) }, icon('undo'), 'Undo'),
      el('button', { class: 'btn btn-text', onclick: () => finish(false) }, icon('send'), 'Send now'));
    document.body.append(bar);
    pending = {
      bar,
      timer: setInterval(() => {
        left -= 1;
        if (left <= 0) finish(false);
        else count.textContent = `Sending in ${left}…`;
      }, 1000),
    };
  };
  sendBtn.addEventListener('click', send);

  const quick = (label, instruction) => el('button', { class: 'chip', onclick: () => rewrite(instruction) }, label);
  const panel = el(
    'div',
    { class: 'compose', role: 'dialog', 'aria-label': 'New email' },
    el('div', { class: 'compose-head' },
      icon(draft ? 'draft' : replyTo ? 'reply' : 'edit_square'),
      el('span', {}, draft ? 'Draft' : replyTo ? 'Reply' : quote ? 'Forward' : 'New email'),
      el('div', { class: 'grow' }),
      el('button', { class: 'icon-btn', title: 'Close (it stays in Drafts)', onclick: () => close(false) }, icon('close'))),
    el('div', { class: 'compose-scroll' },
      el('div', { class: 'compose-grid' },
        el('label', {}, 'From'), el('div', { class: 'compose-row' }, fromSel, el('button', { class: 'btn btn-tonal ai-btn', onclick: pickFrom, title: 'Choose the right business address' }, icon('auto_awesome'), 'Pick for me')),
        el('label', {}, 'To'), withSuggestions(toBox),
        el('label', {}, 'Cc / Bcc'), el('div', { class: 'compose-row' }, withSuggestions(ccBox), withSuggestions(bccBox)),
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
    el('div', { class: 'compose-foot' }, status,
      el('button', { class: 'btn btn-text', title: 'Throw this email away (removes the draft too)', onclick: () => close(false, { discard: true }) }, icon('delete'), 'Discard'),
      el('button', { class: 'btn btn-tonal', title: 'Save to Drafts in Gmail now', onclick: () => saveDraft() }, icon('save'), 'Save draft'),
      sendBtn)
  );
  const backdrop = el('div', { class: 'compose-backdrop' }, panel);
  panel.addEventListener('input', () => autosave());
  panel.addEventListener('change', () => autosave());
  panel.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing here must never trigger the editor's shortcut keys
    if (e.key === 's' && e.ctrlKey) {
      e.preventDefault();
      saveDraft();
    }
    if (e.key === 'Enter' && e.ctrlKey) send();
    if (e.key === 'Escape') close(false);
  });

  let resolveClosed;
  const closed = new Promise((r) => (resolveClosed = r));
  let closing = false;
  async function close(force, { discard = false } = {}) {
    if (closing) return;
    if (discard) {
      if (!sent && (draftRef || snapshot() !== savedSnap) &&
        !(await confirmDialog('Discard this email?', draftRef ? 'It will be removed from your Drafts too.' : 'What you wrote will be lost.', 'Discard'))) return;
      finished = true;
      await saving;
      if (draftRef) host.mail.deleteDraft(draftRef.accountId, draftRef.uid).then(draftsChanged, (e) => toast("Couldn't remove the draft: " + e.message, { error: true }));
    } else if (!sent) {
      // Closing keeps what you wrote in Drafts, like Gmail.
      closing = true;
      if (snapshot() !== savedSnap) say('Saving to Drafts…', true);
      await saveDraft();
      await saving;
      closing = false;
      if (snapshot() !== savedSnap && !force) {
        const go = await confirmDialog("Couldn't save the draft", `${saveError || 'Saving failed.'} Close anyway and lose what you wrote?`, 'Close anyway');
        if (!go) return;
      } else if (draftRef && savedSnap !== startSnap) toast('Saved in Drafts.');
      finished = true;
    }
    backdrop.remove();
    if (!composeOpen || composeOpen === me) {
      document.body.classList.remove('composing');
      composeOpen = null;
    }
    resolveClosed(sent);
  }
  const me = { close, addFiles: (list) => (files.push(...list), showAtts()) };
  composeOpen = me;

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

/** Changes the search words from inside Mail and tells the search box at the top. */
function setSearchText(q) {
  M.search = q;
  render();
  window.dispatchEvent(new CustomEvent('pam:mailsearch', { detail: q }));
}

/** What the permanent search box at the top of the window (search.js) uses (v9.4). */
export const searchApi = {
  /** Narrows the emails on screen to ones that match (sender, subject, preview). */
  filter(q) {
    const backToInbox = !q && M.view.type === 'search'; // clearing the box leaves search results
    if (M.search === q && !backToInbox) return;
    M.search = q;
    if (backToInbox) M.view = { type: 'inbox' };
    if (!document.body.classList.contains('app-mail')) return; // shown the next time Mail opens
    render();
  },
  /** Searches every message on the server (Gmail search words work). */
  searchAll: (q) => searchAll(q),
  /** How many loaded inbox emails match, for the "N emails match" line. */
  countLoaded(q) {
    const ql = (q || '').trim().toLowerCase();
    if (!ql) return 0;
    if (document.body.classList.contains('app-mail')) return visible().length;
    return M.messages.filter((m) => !m.clutter && `${m.fromName} ${m.fromAddress} ${m.subject} ${m.preview}`.toLowerCase().includes(ql)).length;
  },
  /** True once at least one email account is set up. */
  ready: () => signedIn().length > 0,
};
