// Claude assistant side panel: chat about the open document, quick actions,
// reading pages as images, transcribing hard-to-read scans, and filling forms.
import { askClaude, getSettings, saveSettings, isHosted, openClaudeWeb, sendToClaudeWeb } from './host.js';
import { state, on, emit, checkpoint, changed } from './state.js';
import { getAllText, renderPageToCanvas, totalRotation, rightVec, downVec } from './doc.js';
import { el, icon, $, toast, dialog, escapeHtml, uid } from './util.js';
import { getSelectedText, getView } from './viewer.js';
import * as localai from './localai.js';
import { LOCAL_MODELS } from './localai.js';
import { parseWithRules, runActions, buildAiPrompt, parseAiReply, ACTION_SCHEMA, layoutText } from './commands.js';
import { undo } from './state.js';

export const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (balanced, recommended)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (most capable)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (fastest, cheapest)' },
];

let messages = []; // {role, content, display}
let busyReply = false;
let docTextCache = null;
let settings = {};
let keepChat = false; // true while the assistant itself opens a new document

// Requests that ask for a change (rather than a question) — the assistant then edits the document.
const EDIT_WORDS = /^(?:please\s+|can you\s+|could you\s+|i (?:need|want) (?:you to\s+)?|go ahead and\s+)?(add|put|insert|place|move|shift|nudge|delete|remove|erase|make|create|build|design|draft|generate|draw|fill|check|uncheck|tick|change|replace|rename|resize|highlight|underline|circle|sign|rotate|lock|redact|set|give|type|write|clear|number|duplicate|swap|turn|color|colour|bold|center|centre|align|white ?out|cover|apply|detect|name|convert)\b/i;

export async function initClaude() {
  settings = (await getSettings()) || {};
  on('docopen', () => {
    if (keepChat) return;
    messages = [];
    docTextCache = null;
    renderChat();
  });
  on('structure', () => (docTextCache = null));
  on('claude:ask', ({ prompt, focus }) => {
    openPanel();
    const input = $('#claudeInput');
    input.value = prompt;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  on('claude:transcribe', ({ imageDataUrl }) => {
    openPanel();
    send('Transcribe all the text in this image exactly as written, keeping the line breaks and layout. Include handwriting. Mark anything you cannot read as [illegible].', { images: [imageDataUrl], label: 'Read the text in this image' });
  });
  const input = $('#claudeInput');
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(160, input.scrollHeight) + 'px';
  });
  $('#claudeSend').addEventListener('click', submit);
  renderChat();
}

function openPanel() {
  emit('panel', 'claude');
}

function submit() {
  const input = $('#claudeInput');
  const text = input.value.trim();
  if (!text || busyReply) return;
  input.value = '';
  input.style.height = 'auto';
  send(text);
}

const QUICK = [
  { icon: 'summarize', label: 'Summarize', prompt: 'Summarize this document in a short paragraph, then list the key points as bullets.' },
  { icon: 'event', label: 'Dates & amounts', prompt: 'List every date, deadline, dollar amount, quantity and person or company named in this document, with the page each one is on.' },
  { icon: 'help', label: 'Explain selection', needsSelection: true, prompt: (sel) => `Explain this part of the document in plain language:\n\n"""${sel}"""` },
  { icon: 'edit', label: 'Rewrite selection', needsSelection: true, prompt: (sel) => `Rewrite this text so it is clearer and more professional. Reply with only the rewritten text.\n\n"""${sel}"""` },
  { icon: 'image_search', label: 'Look at this page', page: true, prompt: 'Look at this page and describe what it contains. If it has a form, list the fields and what goes in each.' },
  { icon: 'translate', label: 'Translate', prompt: 'Translate this document into Spanish. Keep the structure.' },
  { icon: 'mail', label: 'Draft an email', prompt: 'Draft a short, friendly email I could send along with this document, explaining what it is and anything the reader needs to do.' },
  { icon: 'assignment', label: 'Fill the form', action: 'fill' },
];

/** How Claude is connected: 'api' (built-in, API key), 'web' (signed in at claude.ai) or '' (not yet). */
export function mode() {
  if (settings.claudeMode === 'local') return 'local';
  if (settings.claudeMode === 'web') return 'web';
  if (settings.claudeMode === 'api' && settings.apiKey) return 'api';
  if (settings.apiKey || (!isHosted && settings.claudeMode !== 'none')) return 'api';
  return '';
}
export function aiSettings() {
  return settings;
}
export async function reloadSettings() {
  settings = (await getSettings()) || {};
  renderChat();
  return settings;
}
export function localModelId() {
  return settings.localModel || LOCAL_MODELS[0].id;
}

function renderAccountBar() {
  const bar = $('#claudeAccount');
  if (!bar) return;
  const m = mode();
  bar.replaceChildren(
    ...[
    el('span', { class: 'acct-dot ' + (m ? 'on' : 'off') }),
    el('span', { class: 'acct-text' }, m === 'local' ? 'On-device AI (free, private)' : m === 'web' ? 'Signed in: Claude account' : m === 'api' ? 'Claude (API key)' : 'No AI chosen yet'),
    m === 'web' ? el('button', { class: 'btn btn-text small', onclick: () => openClaudeWeb() }, 'Open Claude') : null,
    el('button', { class: 'btn btn-text small', onclick: signInDialog }, m ? 'Change' : 'Choose AI'),
    ].filter(Boolean)
  );
}

function renderChat() {
  const root = $('#claudeChat');
  if (!root) return;
  root.replaceChildren();
  renderAccountBar();
  if (!messages.length) {
    const m = mode();
    root.append(
      el(
        'div',
        { class: 'claude-welcome' },
        el('div', { class: 'claude-logo' }, icon('auto_awesome')),
        el('h3', {}, m ? (state.doc ? 'Ask or tell me what to change' : 'Ask me to make a document') : 'Choose your AI assistant'),
        el(
          'p',
          { class: 'muted' },
          !m
            ? 'Use the free AI that runs on this computer, your Claude account, or a Claude API key.'
            : m === 'local'
              ? 'Free and private: answers come from the AI on this computer. Ask questions, or tell it to add text boxes, lines or your logo, move things, edit form fields, or make a whole new fillable form.'
              : m === 'web'
              ? 'Pick an action or type a question. It is copied for you and Claude opens in its own window: press Ctrl+V there, then Enter.'
              : state.doc
                ? 'Ask a question, or tell me what to change: add text boxes, lines or your logo, move things, edit form fields, fill it in.'
                : 'Describe a document and I\'ll make it, e.g. "make a gear rental form with name, phone, deposit and signature". Or open a PDF to work on.'
        ),
        !m ? el('button', { class: 'btn btn-primary', onclick: signInDialog }, icon('auto_awesome'), ' Choose AI') : null
      )
    );
  }
  for (const m of messages) {
    if (m.hidden) continue;
    const bubble = el('div', { class: 'msg ' + m.role });
    if (m.role === 'user') bubble.append(el('div', { class: 'msg-text' }, m.display || m.content));
    else {
      const body = el('div', { class: 'msg-text md', html: markdown(m.display || '') });
      bubble.append(body);
      if (m.error) bubble.classList.add('error');
      if (m.web) bubble.classList.add('web-note');
      if (m.report) bubble.append(reportEl(m));
      else if (m.done && !m.error && !m.web) bubble.append(replyActions(m.display));
    }
    root.append(bubble);
  }
  if (busyReply) root.append(el('div', { class: 'typing' }, el('span'), el('span'), el('span')));
  const chips = $('#claudeChips');
  chips.replaceChildren(
    ...QUICK.map((q) =>
      el(
        'button',
        { class: 'chip', disabled: !state.doc || busyReply, onclick: () => runQuick(q) },
        icon(q.icon),
        q.label
      )
    )
  );
  root.scrollTop = root.scrollHeight;
}

function reportEl(m) {
  const box = el(
    'div',
    { class: 'msg-report' },
    m.report.map((r) => el('div', { class: 'pop-result ' + (r.ok ? 'ok' : 'bad') }, icon(r.ok ? 'check_circle' : 'cancel'), el('span', {}, r.msg)))
  );
  const latest = messages.filter((x) => x.report).pop() === m;
  if (latest && m.report.some((r) => r.ok) && !m.undone)
    box.append(
      el(
        'div',
        { class: 'msg-actions' },
        el('button', { class: 'btn btn-tonal small', onclick: () => { undo(); m.undone = true; renderChat(); toast('Undone.'); } }, icon('undo'), ' Undo'),
        el('span', { class: 'muted small' }, 'Drag to move · double-click text to edit')
      )
    );
  return box;
}

/** Carry out actions from the built-in reader or an AI, keeping this chat if a new document opens. */
async function perform(actions) {
  const { getLogo, pickImage } = await import('./newdocui.js');
  const { signatureDialog } = await import('./forms.js');
  keepChat = true;
  try {
    return await runActions(actions, { onNeedSignature: () => signatureDialog(), onNeedLogo: () => getLogo({ ask: true }), onNeedImage: () => pickImage() });
  } finally {
    keepChat = false;
    docTextCache = null;
  }
}

/** Find {"actions":[...]} in a reply. Returns {actions, text without the JSON}. */
function splitActions(reply) {
  const fence = String(reply).match(/```(?:json)?\s*(\{[\s\S]*?"actions"[\s\S]*?\})\s*```/);
  let json = fence ? fence[1] : null;
  if (!json) {
    const i = String(reply).indexOf('{"actions"');
    const j = String(reply).indexOf('{ "actions"');
    const k = i >= 0 ? i : j;
    if (k >= 0) json = String(reply).slice(k, String(reply).lastIndexOf('}') + 1);
  }
  if (!json) return { actions: [], text: reply };
  try {
    const actions = parseAiReply(json);
    return { actions, text: String(reply).replace(fence ? fence[0] : json, '').trim() };
  } catch {
    return { actions: [], text: reply };
  }
}

function replyActions(text) {
  return el(
    'div',
    { class: 'msg-actions' },
    el('button', { class: 'mini-btn', title: 'Copy', onclick: () => navigator.clipboard.writeText(text).then(() => toast('Copied.')) }, icon('content_copy')),
    state.doc ? el('button', { class: 'mini-btn', title: 'Add to the page as a text box', onclick: () => insertAsText(text) }, icon('text_fields')) : null,
    state.doc ? el('button', { class: 'mini-btn', title: 'Add as a comment', onclick: () => insertAsNote(text) }, icon('add_comment')) : null
  );
}

async function runQuick(q) {
  if (q.action === 'fill') return fillFormWithClaude();
  let prompt = q.prompt;
  if (q.needsSelection) {
    const sel = getSelectedText();
    if (!sel.trim()) return toast('Select some text in the document first.');
    prompt = q.prompt(sel);
  }
  const images = q.page ? [await pageImage(state.currentPage)] : [];
  send(prompt, { images, label: q.label });
}

async function pageImage(i) {
  const page = state.doc.pages[i];
  const { canvas } = await renderPageToCanvas(state.doc, page, 1.6);
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function documentText() {
  if (docTextCache === null && state.doc) docTextCache = await getAllText(state.doc, 300000);
  return docTextCache || '';
}

function systemPrompt(docText) {
  const d = state.doc;
  let s =
    'You are Claude, the assistant built into "PDF and Moore", a PDF editor. Be concise, practical and friendly. ' +
    'Use short paragraphs and bullet lists. When quoting the document, mention the page number.';
  if (d) {
    s += `\n\nThe user has "${d.name}" open (${d.pages.length} pages). They are looking at page ${state.currentPage + 1}.`;
    if (docText.replace(/--- Page \d+ ---/g, '').trim().length < 40) {
      s += ' The document has little or no selectable text (it may be a scan). If the user needs its text, suggest Tools > Recognize text (OCR), or use the page images if provided.';
    } else s += `\n\n<document>\n${docText}\n</document>`;
  }
  return s;
}

async function send(text, { images = [], label = null, hidden = false, onDone = null } = {}) {
  if (busyReply) return;
  settings = (await getSettings()) || {};
  // Typed requests to change the document are carried out, not just answered.
  if (!images.length && !label && !hidden) {
    // A pasted answer from Claude (claude.ai) with actions in it.
    if (/"actions"\s*:/.test(text)) {
      const { actions } = splitActions(text);
      if (actions.length) return doActions(text, actions, 'Claude account', 'Pasted from Claude');
    }
    const parsed = parseWithRules(text);
    const templateOnly = mode() && parsed.actions.some((a) => a.action === 'create_document'); // an AI writes a better one
    if (parsed.actions.length && !parsed.unknown.length && !templateOnly) {
      if (!mode()) return doActions(text, parsed.actions, 'Built-in');
      // Try the built-in reader quietly; if any part fails, undo it and let the AI handle the whole request.
      const before = state.history.length;
      const report = await perform(parsed.actions);
      if (report.length && report.every((r) => r.ok)) return doActions(text, null, 'Built-in', null, report);
      if (state.history.length > before) undo();
    }
    if (EDIT_WORDS.test(text) && mode() && mode() !== 'api') return agentEdit(text);
    if (!state.doc && !mode() && parsed.actions.length) return doActions(text, parsed.actions, 'Built-in');
  }
  if (!mode()) {
    const ok = await signInDialog();
    if (!ok) return;
  }
  if (mode() === 'web') return sendToWeb(text, { images, label });
  if (mode() === 'local') return sendLocal(text, { images, label, hidden, onDone });
  const content = images.length
    ? [...images.map((d) => ({ type: 'image', source: { type: 'base64', media_type: d.slice(5, d.indexOf(';')), data: d.split(',')[1] } })), { type: 'text', text }]
    : text;
  messages.push({ role: 'user', content, display: label || text, hidden });
  const reply = { role: 'assistant', content: '', display: '', done: false };
  messages.push(reply);
  busyReply = true;
  renderChat();
  try {
    const docText = await documentText();
    const apiMessages = messages
      .filter((m) => m !== reply && (m.role === 'user' || m.done) && !m.error)
      .map((m) => ({ role: m.role, content: m.content }));
    const layout = state.doc ? await layoutText(20000) : '';
    const body = { model: settings.model || MODELS[0].id, max_tokens: 6000, system: systemPrompt(docText) + (layout ? `\n\nLAYOUT (printed lines and fields; use these to target exactly what the user means):${layout}` : '') + EDIT_HELP, messages: apiMessages };
    let pending = false;
    const full = await askClaude(body, (chunk) => {
      reply.display += chunk;
      if (!pending) {
        pending = true;
        requestAnimationFrame(() => {
          pending = false;
          const bubbles = document.querySelectorAll('#claudeChat .msg.assistant .msg-text');
          const last = bubbles[bubbles.length - 1];
          if (last) last.innerHTML = markdown(reply.display);
          $('#claudeChat').scrollTop = $('#claudeChat').scrollHeight;
        });
      }
    });
    reply.content = full || reply.display;
    reply.display = reply.content;
    reply.done = true;
    const { actions, text: said } = splitActions(reply.content);
    if (actions.length) {
      reply.display = said || 'Here are the changes:';
      busyReply = false;
      renderChat();
      reply.report = await perform(actions);
    }
    if (onDone) await onDone(reply.content);
  } catch (e) {
    reply.error = true;
    reply.done = true;
    reply.display = friendlyError(e);
    reply.content = reply.display;
  } finally {
    busyReply = false;
    renderChat();
  }
}

function friendlyError(e) {
  const m = String((e && e.message) || e);
  if (/401|authentication|invalid x-api-key/i.test(m)) return '**Your API key was not accepted.** Open Settings (gear icon) and check the key.';
  if (/429|rate/i.test(m)) return 'Claude is busy right now (rate limit). Wait a few seconds and try again.';
  if (/credit|billing|balance/i.test(m)) return 'Your Anthropic account is out of credit. Add credit at console.anthropic.com, then try again.';
  if (/Failed to fetch|network|NameResolution|No such host/i.test(m)) return 'Could not reach Claude. Check your internet connection.';
  return 'Something went wrong talking to Claude: ' + m.slice(0, 400);
}

const EDIT_HELP = `

EDITING: You can change the document yourself. When the user asks you to add, move, fill, fix, edit fields, or make something (including a brand-new fillable document from a description, even with no document open), say in one short sentence what you'll do, then include exactly one block:
\`\`\`json
{"actions":[ ... ]}
\`\`\`
The app carries out the actions and shows the results with an Undo button. Only use actions from this list:
${ACTION_SCHEMA}
For questions, just answer normally without a JSON block. For create_document, write complete, realistic wording (agreements, instructions) and sensible fields grouped into sections.`;

/**
 * Ask the chosen AI one question and get the whole answer back (no chat bubble).
 * Claude account mode can't answer directly: the question is copied and Claude opens; returns null.
 */
export async function askOnce(prompt, { system = 'You are a careful document assistant. Answer with only what was asked for.', maxTokens = 4000 } = {}) {
  settings = (await getSettings()) || {};
  const m = mode();
  if (!m) {
    const ok = await signInDialog();
    if (!ok) return null;
  }
  if (mode() === 'api') return askClaude({ model: settings.model || MODELS[0].id, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] });
  if (mode() === 'local') return localai.chat(localModelId(), [{ role: 'system', content: system }, { role: 'user', content: prompt.slice(0, 9000) }]);
  await sendToClaudeWeb({ text: `${system}\n\n${prompt}`, hint: "Press Ctrl+V and Enter. Copy Claude's answer when it's done." });
  toast('Copied for Claude. Paste it in the Claude window (Ctrl+V, Enter).', { ms: 6000 });
  return null;
}

/** Show a request and its results in the chat. */
async function doActions(text, actions, via, display = null, done = null) {
  messages.push({ role: 'user', content: text, display: display || text });
  const reply = { role: 'assistant', content: '', display: `*Working on it (${via})…*`, done: false };
  messages.push(reply);
  renderChat();
  try {
    reply.report = done || (await perform(actions));
    const okCount = reply.report.filter((r) => r.ok).length;
    reply.display = okCount ? `**Done** — ${via}.` : "**I couldn't do that.**";
  } catch (e) {
    reply.error = true;
    reply.display = 'Something went wrong: ' + (e.message || e);
  }
  reply.done = true;
  reply.content = reply.display;
  renderChat();
}

/** On-device AI or Claude account: turn an edit request into actions. */
async function agentEdit(text) {
  const m = mode();
  const { system, user } = await buildAiPrompt(text, { maxChars: m === 'local' ? 5000 : 40000 });
  if (m === 'web') {
    await sendToClaudeWeb({ text: `${system}\n\nReply with only the JSON.\n\n${user}`, hint: "Press Ctrl+V and Enter. Then copy Claude's whole answer and paste it into the PDF and Moore chat box." });
    messages.push({ role: 'user', content: text, display: text });
    messages.push({ role: 'assistant', done: true, web: true, content: '', display: "**Copied for Claude.** In the Claude window press **Ctrl+V**, then **Enter**. When Claude answers, copy its whole reply and **paste it here** — I'll make the changes." });
    renderChat();
    toast('Copied. Press Ctrl+V in the Claude window.');
    return;
  }
  messages.push({ role: 'user', content: text, display: text });
  const reply = { role: 'assistant', content: '', display: '*Thinking…*', done: false };
  messages.push(reply);
  busyReply = true;
  renderChat();
  try {
    const answer = await localai.askJson(localModelId(), system, user, (p) => {
      reply.display = p < 1 ? `*Getting the on-device AI ready (first time only)… ${Math.round(p * 100)}%*` : '*Thinking…*';
      const bubbles = document.querySelectorAll('#claudeChat .msg.assistant .msg-text');
      const last = bubbles[bubbles.length - 1];
      if (last) last.innerHTML = markdown(reply.display);
    });
    const actions = parseAiReply(answer);
    busyReply = false;
    reply.display = '*Making the changes…*';
    renderChat();
    reply.report = await perform(actions);
    reply.display = reply.report.some((r) => r.ok) ? '**Done** — on-device AI.' : "**I couldn't do that.** Try saying it more simply, like the examples.";
  } catch (e) {
    reply.error = true;
    reply.display = 'The on-device AI could not do that: ' + (e.message || e);
  } finally {
    busyReply = false;
    reply.done = true;
    reply.content = reply.display;
    renderChat();
  }
}

// ---------------------------------------------------------------------------
// On-device AI (free)
// ---------------------------------------------------------------------------
async function sendLocal(text, { images = [], label = null, hidden = false, onDone = null } = {}) {
  if (images.length) {
    toast("The on-device AI can't look at pictures. Run Tools › Read text (OCR) first, then ask again.", { error: true, ms: 6000 });
    return;
  }
  messages.push({ role: 'user', content: text, display: label || text, hidden });
  const reply = { role: 'assistant', content: '', display: '', done: false };
  messages.push(reply);
  busyReply = true;
  renderChat();
  try {
    const docText = (await documentText()).slice(0, 7000);
    const sys =
      'You are the helpful assistant inside the PDF editor "PDF and Moore". Answer briefly and clearly. ' +
      (state.doc ? `The user has "${state.doc.name}" open. Its text:\n<document>\n${docText}\n</document>` : '');
    const history = messages.filter((m) => m !== reply && !m.error && !m.web && (m.role === 'user' || m.done)).slice(-6).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.display }));
    let pending = false;
    const full = await localai.chat(
      localModelId(),
      [{ role: 'system', content: sys }, ...history],
      (chunk) => {
        reply.display += chunk;
        if (!pending) {
          pending = true;
          requestAnimationFrame(() => {
            pending = false;
            const bubbles = document.querySelectorAll('#claudeChat .msg.assistant .msg-text');
            const last = bubbles[bubbles.length - 1];
            if (last) last.innerHTML = markdown(reply.display);
          });
        }
      },
      (p, t) => {
        reply.display = `*Getting the on-device AI ready… ${Math.round(p * 100)}%*\n\n${t ? '`' + t.slice(0, 80) + '`' : ''}`;
        const bubbles = document.querySelectorAll('#claudeChat .msg.assistant .msg-text');
        const last = bubbles[bubbles.length - 1];
        if (last) last.innerHTML = markdown(reply.display);
      }
    );
    reply.content = full;
    reply.display = full;
    reply.done = true;
    if (onDone) await onDone(full);
  } catch (e) {
    reply.error = true;
    reply.done = true;
    reply.display = 'The on-device AI could not run: ' + (e.message || e);
  } finally {
    busyReply = false;
    renderChat();
  }
}

// ---------------------------------------------------------------------------
// Claude account (claude.ai) mode: copy, then paste into Claude
// ---------------------------------------------------------------------------
const WEB_LIMIT = 60000; // keep pastes a comfortable size for the chat box

async function sendToWeb(text, { images = [], label = null } = {}) {
  let payload = text;
  if (state.doc && !images.length) {
    const docText = await documentText();
    const body = docText.replace(/--- Page \d+ ---/g, '').trim();
    if (body.length > 40) {
      const clipped = docText.length > WEB_LIMIT ? docText.slice(0, WEB_LIMIT) + '\n[...document shortened...]' : docText;
      payload = `${text}\n\nThe document is "${state.doc.name}" (${state.doc.pages.length} pages):\n\n<document>\n${clipped}\n</document>`;
    }
  }
  if (images.length) {
    // Pictures go on the clipboard as an image; the question is shown so it can be typed after pasting.
    await sendToClaudeWeb({ imageBase64: images[0].split(',')[1], hint: 'Press Ctrl+V to paste the page picture, then ask: ' + (label || text).slice(0, 80) });
  } else {
    await sendToClaudeWeb({ text: payload, hint: 'Copied! Click in the message box, press Ctrl+V, then Enter.' });
  }
  messages.push({ role: 'user', content: text, display: label || text });
  messages.push({
    role: 'assistant',
    done: true,
    display: images.length
      ? `**Page picture copied.** In the Claude window press **Ctrl+V**, then type: *${escapeMd(text.slice(0, 160))}*`
      : `**Copied for Claude${state.doc ? ' (with the document text)' : ''}.** In the Claude window click the message box, press **Ctrl+V**, then **Enter**.`,
    content: '',
    web: true,
  });
  renderChat();
  toast('Copied. Press Ctrl+V in the Claude window.');
}

function escapeMd(s) {
  return String(s).replace(/[*_`]/g, '');
}

/** Choose how to use Claude: your Claude account (claude.ai) or the built-in assistant (API key). */
export async function signInDialog() {
  settings = (await getSettings()) || {};
  let choice = mode() || 'local';
  const support = await localai.checkSupport();
  const card = (value, ic, title, lines) => {
    const c = el(
      'button',
      { class: 'signin-card' + (choice === value ? ' active' : ''), 'data-value': value, onclick: () => pick(value) },
      el('div', { class: 'signin-icon' }, icon(ic)),
      el('div', {}, el('div', { class: 'signin-title' }, title), ...lines.map((l) => el('div', { class: 'signin-line' }, l)))
    );
    return c;
  };
  const where = el(
    'select',
    { class: 'field' },
    el('option', { value: 'app' }, 'In a PDF and Moore window, next to my document'),
    el('option', { value: 'browser' }, 'In my web browser (Chrome, Edge…)')
  );
  where.value = settings.claudeWhere || 'app';
  const webOpts = el(
    'div',
    { class: 'stack signin-opts' },
    el('label', { class: 'field-label' }, 'Open Claude', where),
    el('p', { class: 'hint' }, 'You sign in on Anthropic\'s own claude.ai page. PDF and Moore never sees your password. If Google sign-in is blocked in the window, choose "my web browser".')
  );
  const key = el('input', { class: 'field', type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off' });
  key.value = settings.apiKey || '';
  const model = el('select', { class: 'field' }, MODELS.map((m) => el('option', { value: m.id }, m.label)));
  model.value = settings.model || MODELS[0].id;
  const apiOpts = el(
    'div',
    { class: 'stack signin-opts' },
    el('label', { class: 'field-label' }, 'Claude API key', key),
    el(
      'p',
      { class: 'hint' },
      'Create one at console.anthropic.com > API Keys (billed by usage, separate from a Claude subscription). ',
      el('a', { href: '#', onclick: (e) => (e.preventDefault(), import('./host.js').then((h) => h.openExternal('https://console.anthropic.com/settings/keys'))) }, 'Get a key')
    ),
    el('label', { class: 'field-label' }, 'Model', model)
  );
  const localModel = el('select', { class: 'field' }, LOCAL_MODELS.map((m) => el('option', { value: m.id }, m.label)));
  localModel.value = settings.localModel || LOCAL_MODELS[0].id;
  const localOpts = el(
    'div',
    { class: 'stack signin-opts' },
    support.ok
      ? el('p', { class: 'hint' }, 'Runs on this computer, so it is free and your documents never leave the PC. It downloads once the first time you use it, then works offline. It is good at simple edits and questions; Claude is smarter for long or tricky documents.')
      : el('p', { class: 'hint warn' }, support.reason + ' Choose a Claude option instead.'),
    el('label', { class: 'field-label' }, 'Model', localModel)
  );
  const cards = el(
    'div',
    { class: 'signin-cards three' },
    card('local', 'memory', 'On this computer', ['Free for everyone', 'Private, works offline']),
    card('web', 'account_circle', 'My Claude account', ['Uses your Free, Pro or Max plan', 'Copy and paste into claude.ai']),
    card('api', 'key', 'Claude API key', ['Smartest, fully automatic', 'Pay per use'])
  );
  function pick(v) {
    choice = v;
    cards.querySelectorAll('.signin-card').forEach((c) => c.classList.toggle('active', c.dataset.value === v));
    localOpts.style.display = v === 'local' ? '' : 'none';
    webOpts.style.display = v === 'web' ? '' : 'none';
    apiOpts.style.display = v === 'api' ? '' : 'none';
  }
  const body = el('div', { class: 'stack' }, cards, localOpts, webOpts, apiOpts);
  pick(choice);
  const ok = await dialog({
    title: 'Choose your AI assistant',
    body,
    width: '640px',
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Continue', value: true, primary: true },
    ],
  });
  if (!ok) return false;
  if (choice === 'api' && !key.value.trim()) {
    toast('Paste your API key to use the built-in assistant.', { error: true });
    return false;
  }
  if (choice === 'local' && !support.ok) {
    toast(support.reason, { error: true, ms: 6000 });
    return false;
  }
  settings = { ...settings, claudeMode: choice, claudeWhere: where.value, apiKey: key.value.trim(), model: model.value, localModel: localModel.value };
  await saveSettings(settings);
  renderChat();
  emit('aimode', choice);
  if (choice === 'local') {
    toast('On-device AI chosen. It downloads the first time you ask it something.', { ms: 5000 });
  } else if (choice === 'web') {
    await openClaudeWeb('Sign in with your Claude account. Then use "Send to Claude" in PDF and Moore.');
    toast('Sign in to Claude in the window that opened.');
  } else toast('Claude is ready.');
  return true;
}

// ---------------------------------------------------------------------------
// Fill the form with Claude
// ---------------------------------------------------------------------------
async function fillFormWithClaude() {
  const fields = [];
  state.doc.pages.forEach((p, i) => p.annots.forEach((a) => a.type === 'field' && fields.push({ a, page: i + 1 })));
  const legacy = Object.entries(state.doc.fields || {}).filter(([src]) => !(state.doc.prepared || {})[src]);
  for (const [src, list] of legacy) for (const f of list) fields.push({ legacy: true, src, f, page: (f.widgets[0]?.pageIndex ?? 0) + 1 });
  if (!fields.length) return toast('This document has no fillable fields. Use Form > Edit fields to add some.');
  const notes = el('textarea', { class: 'field', rows: 8, placeholder: 'e.g. Owner: Jane Smith. Regulator Apeks XTX50, serial 12345, IP 135 PSI at 3000, cracking 1.2 inH2O, passed...' });
  const ok = await dialog({
    title: 'Fill the form with Claude',
    body: el('div', {}, el('p', { class: 'muted' }, `Type or paste the information (notes, an email, a list). Claude will put each piece in the right field. ${fields.length} fields found.`), notes),
    width: '600px',
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Fill form', value: true, primary: true },
    ],
  });
  if (!ok || !notes.value.trim()) return;
  const list = fields.map((x, i) => {
    if (x.legacy) return { id: i, name: x.f.name, type: x.f.kind, options: x.f.options, page: x.page };
    return { id: i, name: x.a.name, type: x.a.kind, options: x.a.options, choice: x.a.onValue || undefined, page: x.page };
  });
  const prompt =
    'Fill in this PDF form using only the information below. Reply with ONLY a JSON object mapping field id to value. ' +
    'Use true/false for checkbox and radio fields (true = select this choice). Use the exact option text for dropdowns. Leave out fields you have no information for.\n\n' +
    `FIELDS:\n${JSON.stringify(list)}\n\nINFORMATION:\n"""${notes.value}"""`;
  openPanel();
  if (mode() === 'local') {
    busyReply = true;
    renderChat();
    try {
      const reply = await localai.askJson(localModelId(), 'You fill in PDF forms. Reply with only JSON.', prompt, (p) => toast(`Getting the on-device AI ready… ${Math.round(p * 100)}%`));
      applyFill(reply);
    } catch (e) {
      toast('The on-device AI could not fill the form: ' + e.message, { error: true, ms: 6000 });
    } finally {
      busyReply = false;
      renderChat();
    }
    return;
  }
  if (mode() === 'web') {
    // Claude account: copy the request, then paste Claude's answer back here.
    await sendToClaudeWeb({ text: prompt, hint: 'Press Ctrl+V and Enter. Then copy Claude\'s whole answer.' });
    const answer = el('textarea', { class: 'field', rows: 8, placeholder: 'Paste Claude\'s answer here (it starts with { )' });
    const got = await dialog({
      title: 'Paste Claude\'s answer',
      body: el('div', {}, el('p', { class: 'muted' }, 'The request was copied and Claude opened. Paste it there (Ctrl+V, Enter), copy Claude\'s reply, and paste it below.'), answer),
      width: '560px',
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Fill form', value: true, primary: true },
      ],
    });
    if (!got || !answer.value.trim()) return;
    try {
      applyFill(answer.value);
    } catch (e) {
      toast(e.message, { error: true });
    }
    return;
  }
  await send(prompt, {
    label: 'Fill the form from my notes',
    onDone: async (reply) => applyFill(reply),
  });

  function applyFill(reply) {
      const m = reply.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('Claude did not return field values.');
      const values = JSON.parse(m[0]);
      checkpoint();
      let n = 0;
      for (const [id, val] of Object.entries(values)) {
        const x = fields[Number(id)];
        if (!x) continue;
        if (x.legacy) {
          state.doc.formValues[x.src] = state.doc.formValues[x.src] || {};
          state.doc.formValues[x.src][x.f.name] = x.f.kind === 'checkbox' ? !!val : x.f.kind === 'radio' ? (val === true ? x.f.options[0] : val) : String(val);
        } else if (x.a.kind === 'radio') {
          if (val === true || val === x.a.onValue) state.doc.pages.forEach((p) => p.annots.forEach((b) => b.type === 'field' && b.kind === 'radio' && b.name === x.a.name && (b.value = b === x.a)));
        } else x.a.value = x.a.kind === 'checkbox' ? !!val : String(val);
        n++;
      }
      state.formMode = 'fill';
      document.body.dataset.formMode = 'fill';
      emit('formmode', 'fill');
      changed();
      emit('forms');
      toast(`Claude filled ${n} field${n === 1 ? '' : 's'}. Check them before saving.`);
  }
}

// ---------------------------------------------------------------------------
// Put a reply on the page
// ---------------------------------------------------------------------------
function insertAsText(text) {
  const page = state.doc.pages[state.currentPage];
  const v = getView(page.id);
  if (!v || !v.viewport) return;
  const rot = totalRotation(page);
  const R = rightVec(rot);
  const D = downVec(rot);
  // Top-left margin of the page as seen on screen.
  const [x, y] = v.toUser(40, 40);
  const width = (rot % 180 === 0 ? page.w : page.h) - 80;
  checkpoint();
  page.annots.push({ id: uid(), type: 'text', x, y, rot, size: 11, color: '#000000', font: 'Helvetica', bold: false, text: plain(text), w: width, bg: '#ffffff' });
  changed();
  toast('Added to the page. Drag it into place, double-click to edit.');
  void R;
  void D;
}

function insertAsNote(text) {
  const page = state.doc.pages[state.currentPage];
  const v = getView(page.id);
  if (!v || !v.viewport) return;
  const [x, y] = v.toUser(20, 20);
  checkpoint();
  page.annots.push({ id: uid(), type: 'note', x, y, text: plain(text), color: '#fbbc04', author: 'Claude', date: new Date().toISOString() });
  changed();
  toast('Added as a comment in the top-left corner.');
}

function plain(md) {
  return md
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

// ---------------------------------------------------------------------------
// Minimal, safe markdown -> HTML for replies
// ---------------------------------------------------------------------------
export function markdown(src) {
  const lines = escapeHtml(src || '').split('\n');
  let html = '';
  let list = null;
  let inCode = false;
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      closeList();
      html += inCode ? '</pre>' : '<pre>';
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      html += line + '\n';
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      closeList();
      html += `<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`;
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      if (list !== 'ul') {
        closeList();
        html += '<ul>';
        list = 'ul';
      }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') {
        closeList();
        html += '<ol>';
        list = 'ol';
      }
      html += `<li>${inline(m[1])}</li>`;
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  if (inCode) html += '</pre>';
  return html;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export async function settingsDialog() {
  settings = (await getSettings()) || {};
  const claudeBtn = el('button', { class: 'btn btn-tonal', onclick: () => (document.querySelector('.modal-backdrop')?.remove(), signInDialog()) }, icon('login'), ' Sign in to Claude / change how Claude connects');
  const key = el('input', { class: 'field', type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off' });
  key.value = settings.apiKey || '';
  const model = el('select', { class: 'field' }, MODELS.map((m) => el('option', { value: m.id }, m.label)));
  model.value = settings.model || MODELS[0].id;
  const name = el('input', { class: 'field', placeholder: 'Shown as the author of your comments' });
  name.value = settings.userName || '';
  const body = el(
    'div',
    { class: 'stack' },
    claudeBtn,
    el('label', { class: 'field-label' }, 'Claude API key', key),
    el('p', { class: 'hint' }, 'Get a key at console.anthropic.com > API Keys. It is stored encrypted on this computer and only sent to Anthropic.'),
    el('label', { class: 'field-label' }, 'Claude model', model),
    el('label', { class: 'field-label' }, 'Your name', name)
  );
  const ok = await dialog({
    title: 'Settings',
    body,
    width: '520px',
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Save', value: true, primary: true },
    ],
  });
  if (!ok) return false;
  settings = { ...settings, apiKey: key.value.trim(), model: model.value, userName: name.value.trim() };
  if (settings.apiKey && !settings.claudeMode) settings.claudeMode = 'api';
  await saveSettings(settings);
  toast('Settings saved.');
  renderChat();
  return !!settings.apiKey;
}
