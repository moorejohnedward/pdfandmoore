// Claude's mail assistant (v9.3): tell Claude how to clean up and organize your email, in plain words.
// Claude searches and reads mail in every account, then labels, archives, marks read/unread, stars,
// moves to Trash and saves drafts. Every change waits for John's OK, and Undo puts it back.
// Claude can't send email or delete anything for good (Gmail empties Trash after 30 days).
//
// How it works: the Claude API's "tool use". Claude answers with tool calls (search_mail, change_matching…),
// this file carries them out through the Windows side (MailService.cs) and sends the results back,
// until Claude has a final answer.

import * as host from './host.js';
import { el, icon, toast } from './util.js';
import { reloadSettings, aiSettings, mode as aiMode, markdown, MODELS } from './claude.js';

const MAX_STEPS = 30; // tool rounds per request, so a confused run can't go on forever
const MATCH_MAX = 5000; // emails changed per change_matching call
const MATCH_CAP = 20000;

let ctx = null; // from mail.js: { settings(), changed(), draftsChanged() }

const S = {
  messages: [], // the conversation sent to Claude
  log: [], // what's shown: { kind: 'user' | 'assistant' | 'tool' | 'ask' | 'error', ... }
  undo: [], // [{ label, parts: [{ accountId, mailbox, uids, change, trashMailbox, trashUids }] }]
  ids: new Map(), // short ID ("m12") -> { accountId, mailbox, uid, messageId, references, subject }
  nextId: 1,
  allowAll: false, // "OK everything for this request" (never covers Trash)
  busy: false,
  stop: false,
  changedSomething: false,
  els: null,
};

// ---------------------------------------------------------------------------
// Accounts and addresses
// ---------------------------------------------------------------------------
const accounts = () => (ctx?.settings()?.accounts || []).filter((a) => a.hasPassword);
const accountById = (id) => accounts().find((a) => a.id === id);
const acctName = (id) => accountById(id)?.email || '?';

/** "all", "" or missing = every account; otherwise an account's email, one of its aliases, or its name. */
function pickAccounts(which) {
  const w = String(which || '').trim().toLowerCase();
  if (!w || w === 'all') return accounts();
  const hit = accounts().filter(
    (a) => a.email.toLowerCase() === w || (a.name || '').toLowerCase() === w || a.identities.some((i) => i.address.toLowerCase() === w)
  );
  if (!hit.length) throw new Error(`No signed-in account matches "${which}". Accounts: ${accounts().map((a) => a.email).join(', ')}`);
  return hit;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
function when(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}
function nowText() {
  const d = new Date();
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + ' at ' + pad(d.getHours()) + pad(d.getMinutes());
}
const n = (x) => Number(x || 0).toLocaleString();

// ---------------------------------------------------------------------------
// Tools Claude can use
// ---------------------------------------------------------------------------
const CHANGE_PROPS = {
  add_labels: { type: 'array', items: { type: 'string' }, description: 'Gmail labels to add. Use / for nested labels, e.g. "Business/Square". New labels are made automatically.' },
  remove_labels: { type: 'array', items: { type: 'string' }, description: 'Gmail labels to take off.' },
  archive: { type: 'boolean', description: 'Take out of the inbox. The email stays in All Mail and under its labels.' },
  move_to_inbox: { type: 'boolean', description: 'Put back in the inbox.' },
  mark_read: { type: 'boolean', description: 'true = mark read, false = mark unread.' },
  star: { type: 'boolean', description: 'true = star, false = unstar.' },
  trash: { type: 'boolean', description: 'Move to Trash. Only when John asks to delete. Gmail empties Trash after 30 days.' },
  reason: { type: 'string', description: 'One short line for John: why this change.' },
};

const TOOLS = [
  {
    name: 'search_mail',
    description:
      'Search John\'s mail on the server (All Mail, every label). Uses Gmail search words: from:, to:, subject:, label:, category:promotions|social|updates|forums, ' +
      'in:inbox, is:unread, is:starred, has:attachment, older_than:30d, newer_than:7d, before:2026/01/01, larger:5M, -word to exclude, OR, quotes. ' +
      'Returns how many match in each account and the newest ones with short IDs (m1, m2…) for read_email, change_emails and create_draft.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Gmail search, e.g. "in:inbox category:promotions older_than:30d".' },
        account: { type: 'string', description: 'An account email or alias, or "all" (default).' },
        max: { type: 'integer', description: 'How many of the newest matches to list (default 20, at most 50).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'read_email',
    description: 'Read one email (by its short ID from search_mail) without marking it read.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'list_labels',
    description: "List each account's Gmail labels with how many emails (and unread) are under each. Reuse these instead of making near-duplicates.",
    input_schema: { type: 'object', properties: { account: { type: 'string', description: 'An account email, or "all" (default).' } } },
  },
  {
    name: 'change_emails',
    description: 'Change specific emails by their short IDs from search_mail: labels, archive, inbox, read/unread, star, trash. John approves it in the app first.',
    input_schema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } }, ...CHANGE_PROPS },
      required: ['ids', 'reason'],
    },
  },
  {
    name: 'change_matching',
    description:
      `Change every email matching a Gmail search, in one account or all of them (for big clean-ups). Check the count with search_mail first. ` +
      `Changes the newest ${MATCH_MAX} matches per account by default (max up to ${MATCH_CAP}); if more match and the search leaves out mail that was ` +
      'already changed (e.g. "in:inbox" when archiving), call it again. John approves it in the app first.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        account: { type: 'string', description: 'An account email or alias, or "all".' },
        max: { type: 'integer' },
        ...CHANGE_PROPS,
      },
      required: ['query', 'reason'],
    },
  },
  {
    name: 'create_draft',
    description:
      "Save an email in Drafts for John to review and send himself (you can't send). Plain text, no signature (the app adds the From address's signature). " +
      'Give reply_to_id to answer an email in the same conversation.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: "One of John's addresses (see the list)." },
        to: { type: 'string' },
        cc: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        reply_to_id: { type: 'string' },
      },
      required: ['from', 'to', 'subject', 'body'],
    },
  },
];

function systemPrompt() {
  const st = ctx.settings();
  const list = accounts()
    .map((a) => `- ${a.email}${a.name ? ` (${a.name})` : ''}; sends as: ${a.identities.map((i) => `${i.address}${i.business ? ' = ' + i.business : ''}`).join(', ')}`)
    .join('\n');
  return (
    `You are Claude inside PDF and Moore, John Moore's own email app on his Windows PC. You help him clean up, organize and stay on top of all his email accounts. ` +
    `It is now ${nowText()} (Hawaii time).\n\nJohn's signed-in accounts:\n${list}\n\n` +
    `About John (context only): ${st?.aboutMe || ''}\n\n` +
    'How to work:\n' +
    '- Look before you change: search_mail (and read_email when it matters), then change. For many emails use change_matching with a precise Gmail search; for a few, change_emails with IDs.\n' +
    '- Prefer labels and archiving over Trash. Use Trash only when John asks to delete. Nothing is deleted for good from here.\n' +
    '- Never archive, trash or mark read mail from customers or real people, the VA, government (.gov), banks, insurance, school, permits or anything waiting on a reply, unless John names it. ' +
    'When cleaning up marketing, use searches like category:promotions or unsubscribe mailings and leave out those senders.\n' +
    '- Use / for nested labels ("Business/Square"). Reuse existing labels (list_labels).\n' +
    "- You can't send email. create_draft puts a draft in Drafts for John to check and send.\n" +
    '- John approves each change in the app. If he skips one, don\'t try it again; ask what he wants instead.\n' +
    '- Answer in short, plain words. Use 24-hour time (1750) and American units. When you change mail, finish with what changed and the counts.'
  );
}

// ---------------------------------------------------------------------------
// Running tools
// ---------------------------------------------------------------------------
function shortId(m) {
  const id = 'm' + S.nextId++;
  S.ids.set(id, { accountId: m.accountId, mailbox: m.mailbox, uid: m.uid, messageId: m.messageId, references: m.references || [], subject: m.subject });
  return id;
}

function changeFrom(input) {
  const c = {
    addLabels: (input.add_labels || []).map(String).filter((x) => x.trim()),
    removeLabels: (input.remove_labels || []).map(String).filter((x) => x.trim()),
    archive: input.archive === true,
    toInbox: input.move_to_inbox === true,
    trash: input.trash === true,
  };
  if (typeof input.mark_read === 'boolean') c.read = input.mark_read;
  if (typeof input.star === 'boolean') c.starred = input.star;
  if (c.archive && c.toInbox) throw new Error('Pick archive or move_to_inbox, not both.');
  const any = c.addLabels.length || c.removeLabels.length || c.archive || c.toInbox || c.trash || 'read' in c || 'starred' in c;
  if (!any) throw new Error('No change was asked for.');
  return c;
}

function describeChange(c) {
  const parts = [];
  if (c.trash) parts.push('move to Trash');
  if (c.archive) parts.push('archive (take out of the inbox)');
  if (c.toInbox) parts.push('put back in the inbox');
  if (c.addLabels.length) parts.push('add label ' + c.addLabels.map((l) => `"${l}"`).join(', '));
  if (c.removeLabels.length) parts.push('remove label ' + c.removeLabels.map((l) => `"${l}"`).join(', '));
  if (c.read === true) parts.push('mark read');
  if (c.read === false) parts.push('mark unread');
  if (c.starred === true) parts.push('star');
  if (c.starred === false) parts.push('unstar');
  return parts.join(', ');
}

async function runTool(name, input) {
  switch (name) {
    case 'search_mail': {
      const max = Math.min(50, Math.max(1, Number(input.max) || 20));
      const accts = pickAccounts(input.account);
      const only = accts.length === 1 ? accts[0].id : null;
      const res = await host.mail.search(String(input.query || ''), only, max);
      const msgs = (res.messages || []).filter((m) => accts.some((a) => a.id === m.accountId)).sort((a, b) => b.date - a.date).slice(0, max);
      const counts = Object.fromEntries(accts.map((a) => [a.email, res.totals?.[a.id] ?? 0]));
      addLog('tool', 'search', `Searched “${input.query}” — ${Object.entries(counts).map(([e, c]) => `${n(c)} in ${e}`).join(', ')}`);
      return {
        matches_per_account: counts,
        errors: res.errors || [],
        newest: msgs.map((m) => ({
          id: shortId(m), account: acctName(m.accountId), date: when(m.date), from: `${m.fromName} <${m.fromAddress}>`, to: m.to,
          subject: m.subject, preview: (m.preview || '').slice(0, 160), labels: m.labels, in_inbox: m.inInbox, read: m.read, starred: m.starred,
          attachments: m.hasAttachments, mass_mailing: m.bulk,
        })),
      };
    }
    case 'read_email': {
      const ref = S.ids.get(String(input.id));
      if (!ref) throw new Error('Unknown ID. Use an ID from search_mail.');
      const b = await host.mail.message(ref.accountId, ref.uid, ref.mailbox, { peek: true });
      let text = b.text || htmlText(b.html);
      if (text.length > 8000) text = text.slice(0, 8000) + '\n[...trimmed...]';
      addLog('tool', 'mail', `Read “${ref.subject}”`);
      return { from: b.from, to: b.to, cc: b.cc, subject: b.subject, attachments: (b.attachments || []).map((a) => a.name), text };
    }
    case 'list_labels': {
      const out = {};
      for (const a of pickAccounts(input.account)) {
        const folders = await host.mail.folders(a.id);
        out[a.email] = folders.map((f) => `${f.kind === 'label' ? f.fullName : f.kind}: ${n(f.total)}${f.unread ? ` (${n(f.unread)} unread)` : ''}`);
      }
      addLog('tool', 'label', 'Looked at your labels');
      return out;
    }
    case 'change_emails': {
      const change = changeFrom(input);
      const refs = (input.ids || []).map((id) => [id, S.ids.get(String(id))]);
      const missing = refs.filter(([, r]) => !r).map(([id]) => id);
      if (missing.length) throw new Error('Unknown IDs: ' + missing.join(', '));
      const groups = new Map();
      for (const [, r] of refs) {
        const k = r.accountId + '|' + r.mailbox;
        if (!groups.has(k)) groups.set(k, { accountId: r.accountId, mailbox: r.mailbox, uids: [] });
        groups.get(k).uids.push(r.uid);
      }
      const what = describeChange(change);
      const counts = [...groups.values()].map((g) => `${n(g.uids.length)} in ${acctName(g.accountId)}`).join(', ');
      const ok = await askApproval({ title: `${what[0].toUpperCase()}${what.slice(1)}`, detail: `${refs.length} email${refs.length === 1 ? '' : 's'} (${counts})`, reason: input.reason, trash: change.trash });
      if (!ok) return { done: false, note: 'John skipped this change.' };
      const parts = [];
      for (const g of groups.values()) parts.push({ ...(await host.mail.modify(g.accountId, g.uids, change, g.mailbox)), change });
      recordUndo(what, parts);
      const total = parts.reduce((t, p) => t + (p.count || 0), 0);
      addLog('tool', 'done_all', `Changed ${n(total)} email${total === 1 ? '' : 's'}: ${what}`);
      return { done: true, changed: total };
    }
    case 'change_matching': {
      const change = changeFrom(input);
      const query = String(input.query || '').trim();
      if (!query) throw new Error('No search given.');
      const max = Math.min(MATCH_CAP, Math.max(1, Number(input.max) || MATCH_MAX));
      const accts = pickAccounts(input.account);
      // Count first, so John sees exactly how many emails each account will change.
      const res = await host.mail.search(query, accts.length === 1 ? accts[0].id : null, 5);
      const counts = accts.map((a) => ({ a, total: res.totals?.[a.id] ?? 0 })).filter((x) => x.total > 0);
      if (!counts.length) return { done: false, note: 'Nothing matches that search.' };
      const what = describeChange(change);
      const detail = counts.map((x) => `${n(Math.min(x.total, max))}${x.total > max ? ` of ${n(x.total)}` : ''} in ${x.a.email}`).join(', ');
      const sample = (res.messages || []).slice(0, 5).map((m) => `${m.fromName || m.fromAddress}: ${m.subject}`);
      const ok = await askApproval({ title: `${what[0].toUpperCase()}${what.slice(1)}`, detail: `Emails matching “${query}”: ${detail}`, sample, reason: input.reason, trash: change.trash });
      if (!ok) return { done: false, note: 'John skipped this change.' };
      const parts = [];
      const out = {};
      for (const { a } of counts) {
        addLog('tool', 'hourglass_top', `Working on ${a.email}…`);
        const r = await host.mail.modifyMatching(a.id, query, change, max);
        parts.push({ ...r, change });
        out[a.email] = { changed: r.count, matched: r.total };
      }
      recordUndo(`${what} — “${query}”`, parts);
      const total = parts.reduce((t, p) => t + (p.count || 0), 0);
      addLog('tool', 'done_all', `Changed ${n(total)} emails: ${what}`);
      return { done: true, per_account: out };
    }
    case 'create_draft': {
      const all = accounts().flatMap((a) => a.identities.map((i) => ({ ...i, accountId: a.id })));
      const id = all.find((i) => i.address.toLowerCase() === String(input.from || '').toLowerCase());
      if (!id) throw new Error(`"${input.from}" isn't one of John's addresses: ${all.map((i) => i.address).join(', ')}`);
      const ref = input.reply_to_id ? S.ids.get(String(input.reply_to_id)) : null;
      let body = String(input.body || '').replace(/\s+$/, '');
      if (id.signature) body += '\n\n' + id.signature;
      await host.mail.saveDraft({
        accountId: id.accountId, from: id.address, to: String(input.to || ''), cc: String(input.cc || ''), bcc: '',
        subject: String(input.subject || ''), body,
        inReplyTo: ref?.messageId || null, references: ref ? [...(ref.references || []), ref.messageId].filter(Boolean) : [],
      });
      ctx.draftsChanged();
      addLog('tool', 'draft', `Saved a draft to ${input.to}: “${input.subject}” (in Drafts)`);
      return { done: true, note: 'Saved in Drafts. John will review and send it.' };
    }
    default:
      throw new Error('Unknown tool: ' + name);
  }
}

function htmlText(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n$&'), 'text/html');
  doc.querySelectorAll('script,style,head').forEach((x) => x.remove());
  return (doc.body?.textContent || '').replace(/[ \t ]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Approval and Undo
// ---------------------------------------------------------------------------
function askApproval({ title, detail, sample = [], reason = '', trash = false }) {
  if (S.allowAll && !trash) {
    addLog('tool', 'check', `${title}: ${detail} (OK'd for this request)`);
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const item = { kind: 'ask', title, detail, sample, reason, trash, answer: null };
    item.resolve = (ok, all = false) => {
      if (item.answer !== null) return;
      item.answer = ok ? 'yes' : 'no';
      if (all) S.allowAll = true;
      render();
      resolve(ok);
    };
    S.log.push(item);
    render();
  });
}

function recordUndo(label, parts) {
  S.changedSomething = true;
  S.undo.push({ label, parts: parts.filter((p) => (p.uids?.length || p.trashUids?.length)) });
  render();
}

async function undoLast() {
  const last = S.undo.pop();
  if (!last) return;
  render();
  addLog('tool', 'undo', `Undoing: ${last.label}…`);
  try {
    for (const p of last.parts) {
      const c = p.change;
      if (c.trash && p.trashUids?.length) {
        // Out of Trash and back into the inbox.
        await host.mail.moveBack(p.accountId, p.trashUids, '\\Trash');
        continue;
      }
      const back = { addLabels: c.removeLabels || [], removeLabels: c.addLabels || [], archive: !!c.toInbox, toInbox: !!c.archive, trash: false };
      if (back.addLabels.length || back.removeLabels.length || back.archive || back.toInbox) await host.mail.modify(p.accountId, p.uids, back, p.mailbox);
    }
    const readOnly = last.parts.some((p) => 'read' in p.change || 'starred' in p.change);
    addLog('tool', 'undo', `Undone: ${last.label}${readOnly ? ' (read/unread and stars stay as they are)' : ''}`);
    S.changedSomething = true;
  } catch (e) {
    addLog('error', `Undo didn't finish: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Talking to Claude
// ---------------------------------------------------------------------------
async function ask(text) {
  text = text.trim();
  if (!text || S.busy) return;
  await reloadSettings();
  if (aiMode() !== 'api') {
    addLog('error', 'The mail assistant needs your Claude API key: Settings › AI assistant › "Built in (API key)". The rest of Mail works without it.');
    return;
  }
  S.busy = true;
  S.stop = false;
  S.allowAll = false;
  addLog('user', text);
  const mark = S.messages.length; // to take this request back out if it fails
  S.messages.push({ role: 'user', content: text });
  const model = aiSettings().model || MODELS[0].id;
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      setWorking(step === 0 ? 'Claude is thinking…' : 'Claude is working…');
      const res = await host.claudeRaw({ model, max_tokens: 4096, system: systemPrompt(), tools: TOOLS, messages: S.messages });
      const content = res.content || [];
      S.messages.push({ role: 'assistant', content });
      const said = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (said) addLog('assistant', said);
      const uses = content.filter((b) => b.type === 'tool_use');
      if (!uses.length) break;
      const results = [];
      for (const u of uses) {
        let out;
        if (S.stop) out = { error: 'John pressed Stop.' };
        else {
          try {
            out = await runTool(u.name, u.input || {});
          } catch (e) {
            out = { error: e.message || String(e) };
            addLog('error', `${u.name}: ${out.error}`);
          }
        }
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 60000), ...(out?.error ? { is_error: true } : {}) });
      }
      S.messages.push({ role: 'user', content: results });
      if (S.stop) {
        addLog('assistant', 'Stopped.');
        break;
      }
      if (step === MAX_STEPS - 1) addLog('assistant', 'That was a lot of steps, so I stopped here. Tell me to keep going if you want more.');
    }
  } catch (e) {
    addLog('error', 'Claude: ' + (e.message || e));
    // Take this request out of the conversation so the next one starts clean (changes already made stay made).
    S.messages.length = mark;
  } finally {
    S.busy = false;
    setWorking('');
    render();
    if (S.changedSomething) ctx.changed();
  }
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------
function addLog(kind, a, b) {
  if (kind === 'tool') S.log.push({ kind, icon: a, text: b });
  else S.log.push({ kind, text: a });
  render();
}

let workingText = '';
function setWorking(t) {
  workingText = t;
  render();
}

const EXAMPLES = [
  'What in my inboxes needs my attention this week?',
  'Archive marketing and newsletters older than 30 days in every account, but keep anything from real people',
  'Label everything from PADI and DAN as "Diving" and take it out of the inbox',
  'Find customers who are still waiting on a reply and draft answers for me',
  'Mark every unread promotion as read',
  'Which senders fill up my inbox the most?',
];

function render() {
  const E = S.els;
  if (!E) return;
  const items = S.log.map((it) => {
    if (it.kind === 'user') return el('div', { class: 'agent-msg user' }, it.text);
    if (it.kind === 'assistant') {
      const d = el('div', { class: 'agent-msg assistant' });
      d.innerHTML = markdown(it.text);
      return d;
    }
    if (it.kind === 'error') return el('div', { class: 'agent-step error' }, icon('error'), el('span', {}, it.text));
    if (it.kind === 'tool') return el('div', { class: 'agent-step' }, icon(it.icon), el('span', {}, it.text));
    // Approval card
    return el(
      'div',
      { class: 'agent-ask' + (it.trash ? ' trash' : '') + (it.answer ? ' answered' : '') },
      el('div', { class: 'agent-ask-title' }, icon(it.trash ? 'delete' : 'rule'), it.title),
      el('div', { class: 'agent-ask-detail' }, it.detail),
      it.reason ? el('div', { class: 'agent-ask-reason' }, it.reason) : '',
      it.sample?.length ? el('ul', { class: 'agent-ask-sample' }, it.sample.map((x) => el('li', {}, x))) : '',
      it.answer
        ? el('div', { class: 'agent-ask-answer' }, icon(it.answer === 'yes' ? 'check_circle' : 'block'), it.answer === 'yes' ? 'Done' : 'Skipped')
        : el(
            'div',
            { class: 'agent-ask-btns' },
            el('button', { class: 'btn btn-primary', onclick: () => it.resolve(true) }, icon('check'), 'Do it'),
            it.trash ? '' : el('button', { class: 'btn btn-tonal', title: 'OK this and the rest of this request (Trash still asks)', onclick: () => it.resolve(true, true) }, icon('done_all'), 'Do it and the rest'),
            el('button', { class: 'btn btn-text', onclick: () => it.resolve(false) }, 'Skip')
          )
    );
  });
  const empty = !S.log.length
    ? el(
        'div',
        { class: 'agent-hello' },
        el('div', { class: 'agent-hello-art' }, icon('auto_awesome')),
        el('h2', {}, 'Tell me how to clean up and organize your mail'),
        el('p', {}, "I can search and read every account, label, archive, mark read, star, move to Trash and write drafts. Each change waits for your OK, and Undo puts it back. I can't send email or delete anything for good."),
        el('div', { class: 'agent-examples' }, EXAMPLES.map((x) => el('button', { class: 'chip', onclick: () => ((E.input.value = x), E.input.focus()) }, x)))
      )
    : '';
  E.log.replaceChildren(empty, ...items, workingText ? el('div', { class: 'agent-step working' }, el('span', { class: 'spinner small' }), el('span', {}, workingText)) : '');
  E.log.scrollTop = E.log.scrollHeight;
  E.send.replaceChildren(...(S.busy ? [icon('stop'), 'Stop'] : [icon('send'), 'Ask']));
  E.undo.disabled = !S.undo.length || S.busy;
  E.undo.title = S.undo.length ? 'Undo: ' + S.undo[S.undo.length - 1].label : 'Nothing to undo';
}

/** Opens the assistant. ctx comes from mail.js. */
export function openAssistant(context) {
  ctx = context;
  if (S.els) return S.els.input.focus();
  const input = el('textarea', { class: 'field agent-input', rows: 2, placeholder: 'e.g. “Archive promotions older than 30 days in every account”' });
  const send = el('button', { class: 'btn btn-primary agent-send' });
  const undo = el('button', { class: 'btn btn-tonal', onclick: undoLast }, icon('undo'), 'Undo last change');
  const log = el('div', { class: 'agent-log' });
  const newChat = el('button', { class: 'btn btn-text', title: 'Start over', onclick: () => !S.busy && ((S.messages = []), (S.log = []), render()) }, icon('restart_alt'), 'New chat');
  const close = () => {
    if (S.busy) S.stop = true;
    S.log.filter((x) => x.kind === 'ask' && !x.answer).forEach((x) => x.resolve(false));
    backdrop.remove();
    S.els = null;
    if (S.changedSomething) ctx.changed();
    S.changedSomething = false;
  };
  const panel = el(
    'div',
    { class: 'compose agent', role: 'dialog', 'aria-label': 'Claude mail assistant' },
    el('div', { class: 'compose-head' }, icon('auto_awesome'), el('span', {}, 'Claude: clean up & organize'), el('div', { class: 'grow' }), newChat,
      el('button', { class: 'icon-btn', title: 'Close', onclick: close }, icon('close'))),
    log,
    el('div', { class: 'agent-foot' }, input, el('div', { class: 'agent-foot-btns' }, send, undo))
  );
  const backdrop = el('div', { class: 'compose-backdrop' }, panel);
  send.addEventListener('click', () => {
    if (S.busy) {
      S.stop = true;
      // Answer any open question so the run can finish.
      S.log.filter((x) => x.kind === 'ask' && !x.answer).forEach((x) => x.resolve(false));
      return;
    }
    const t = input.value;
    input.value = '';
    ask(t);
  });
  panel.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing here must never trigger the editor's shortcut keys
    if (e.key === 'Enter' && !e.shiftKey && e.target === input) {
      e.preventDefault();
      send.click();
    }
    if (e.key === 'Escape') close();
  });
  document.body.append(backdrop);
  S.els = { input, send, undo, log };
  render();
  setTimeout(() => input.focus(), 30);
}
