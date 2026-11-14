// One Settings window for the whole app (v9): Look & feel, AI assistant, Email, Updates.

import * as host from './host.js';
import { el, icon, toast, dialog, confirmDialog } from './util.js';
import { MODELS, signInDialog, reloadSettings } from './claude.js';
import * as mail from './mail.js';

// ---------------------------------------------------------------------------
// Theme and size
// ---------------------------------------------------------------------------
export function applyLook({ theme, textSize }) {
  const root = document.documentElement;
  root.dataset.theme = theme === 'light' ? 'light' : 'dark';
  root.dataset.size = ['normal', 'large', 'xl'].includes(textSize) ? textSize : 'large';
}

export async function initLook() {
  const prefs = { theme: 'dark', textSize: 'large', ...(await host.getUiPrefs().catch(() => ({}))) };
  applyLook(prefs);
  try {
    localStorage.setItem('pam.ui', JSON.stringify(prefs)); // read before first paint next time (also by the Office editors)
  } catch {}
  return prefs;
}

async function setLook(prefs) {
  applyLook(prefs);
  await host.setUiPrefs(prefs).catch(() => {});
}

function choiceCards(options, value, onPick) {
  const wrap = el('div', { class: 'choice-cards' });
  const draw = (v) =>
    wrap.replaceChildren(
      ...options.map((o) =>
        el('button', { class: 'choice-card' + (o.value === v ? ' on' : ''), onclick: () => (draw(o.value), onPick(o.value)) },
          el('span', { class: 'choice-art', style: o.art || null }, o.icon ? icon(o.icon) : o.label[0]),
          el('b', {}, o.label),
          o.sub ? el('small', {}, o.sub) : '')
      )
    );
  draw(value);
  return wrap;
}

// ---------------------------------------------------------------------------
// The Settings window
// ---------------------------------------------------------------------------
export async function openSettings(startTab = 'look') {
  const look = { theme: 'dark', textSize: 'large', ...(await host.getUiPrefs().catch(() => ({}))) };
  const ai = (await host.getSettings().catch(() => ({}))) || {};
  const mailSettings = await mail.loadSettings();
  const updates = await host.getUpdatePrefs().catch(() => ({ checkOnStartup: true }));
  const version = await host.appVersion().catch(() => '');

  // ---- Look & feel ----
  const lookPane = el(
    'div',
    { class: 'set-pane' },
    el('h3', {}, 'Theme'),
    choiceCards(
      [
        { value: 'dark', label: 'Dark', sub: 'Easy on the eyes', icon: 'dark_mode', art: { background: 'linear-gradient(135deg,#0f1b2d,#25395b)', color: '#ffc845' } },
        { value: 'light', label: 'Light', sub: 'Bright and classic', icon: 'light_mode', art: { background: 'linear-gradient(135deg,#ffffff,#e3eefb)', color: '#ff7a59' } },
      ],
      look.theme,
      (v) => setLook({ ...look, theme: (look.theme = v) })
    ),
    el('h3', {}, 'Button and text size'),
    choiceCards(
      [
        { value: 'normal', label: 'Normal', sub: 'Fits the most on screen', icon: 'text_fields', art: { fontSize: '14px' } },
        { value: 'large', label: 'Large', sub: 'Recommended', icon: 'format_size', art: { background: 'linear-gradient(135deg,#ff7a59,#ff5fa2)', color: '#fff' } },
        { value: 'xl', label: 'Extra large', sub: 'Biggest buttons', icon: 'zoom_in', art: { background: 'linear-gradient(135deg,#2bb3d9,#9b6bff)', color: '#fff' } },
      ],
      look.textSize,
      (v) => setLook({ ...look, textSize: (look.textSize = v) })
    ),
    el('p', { class: 'hint' }, 'Changes show right away. PDF pages always stay white so documents look the way they print.')
  );

  // ---- AI assistant ----
  const key = el('input', { class: 'field', type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off', value: ai.apiKey || '' });
  const model = el('select', { class: 'field' }, MODELS.map((m) => el('option', { value: m.id }, m.label)));
  model.value = ai.model || MODELS[0].id;
  const name = el('input', { class: 'field', placeholder: 'Shown as the author of your comments', value: ai.userName || '' });
  const aboutMe = el('textarea', { class: 'field', rows: 5, placeholder: 'Who you are and how you like to write. Claude reads this before writing emails for you.' });
  aboutMe.value = mailSettings?.aboutMe || '';
  const aiPane = el(
    'div',
    { class: 'set-pane' },
    el('button', { class: 'btn btn-tonal', onclick: async () => { await signInDialog(); } }, icon('login'), 'Choose AI: free on this PC, my Claude account, or an API key'),
    el('label', { class: 'field-label' }, 'Claude API key (for the fully automatic option)', key),
    el('p', { class: 'hint' }, 'Get one at console.anthropic.com › API Keys. It\'s billed separately from a Claude subscription, pay per use. Stored encrypted on this PC and only sent to Anthropic.'),
    el('label', { class: 'field-label' }, 'Claude model', model),
    el('label', { class: 'field-label' }, 'Your name', name),
    el('label', { class: 'field-label' }, 'About me (used when Claude writes for you)', aboutMe)
  );

  // ---- Email ----
  const mailPane = el('div', { class: 'set-pane' });
  const folderBox = el('textarea', { class: 'field', rows: 7 });
  const rulesBox = el('div', { class: 'rules' });
  const fetchCount = el('input', { class: 'field', type: 'number', min: 10, max: 500, style: { width: '110px' } });
  const autoSort = el('input', { type: 'checkbox' });
  let ms = mailSettings ? structuredClone(mailSettings) : null;

  const drawRules = () =>
    rulesBox.replaceChildren(
      ...ms.rules.map((r, i) => {
        const m = el('input', { class: 'field', value: r.match, placeholder: 'If sender, To or subject contains…', oninput: (e) => (r.match = e.target.value) });
        const f = el('input', { class: 'field', value: r.folder, placeholder: 'Folder', list: 'folderNames', oninput: (e) => (r.folder = e.target.value) });
        return el('div', { class: 'rule-row' }, m, icon('arrow_forward'), f, el('button', { class: 'icon-btn small', title: 'Remove rule', onclick: () => (ms.rules.splice(i, 1), drawRules()) }, icon('delete')));
      }),
      el('button', { class: 'btn btn-text small', onclick: () => (ms.rules.push({ match: '', folder: '' }), drawRules()) }, icon('add'), 'Add a rule'),
      el('datalist', { id: 'folderNames' }, ms.folders.map((x) => el('option', { value: x })))
    );

  const drawMail = () => {
    if (!ms) {
      mailPane.replaceChildren(el('p', {}, 'Email works in the PDF and Moore Windows app.'));
      return;
    }
    folderBox.value = ms.folders.join('\n');
    fetchCount.value = ms.fetchCount;
    autoSort.checked = ms.autoSort;
    drawRules();
    mailPane.replaceChildren(
      el('h3', {}, 'Email accounts'),
      el('p', { class: 'hint' }, 'Add each mailbox you sign in to (one per Google account). Business aliases go inside the account they belong to.'),
      el(
        'div',
        { class: 'acct-cards' },
        ms.accounts.map((a) =>
          el('div', { class: 'acct-card', style: { '--c': a.color } },
            el('span', { class: 'acct-swatch' }),
            el('div', { class: 'acct-text' },
              el('b', {}, a.name || a.email),
              el('small', {}, a.email + '  ·  ' + a.identities.length + (a.identities.length === 1 ? ' address' : ' addresses')),
              a.hasPassword ? el('span', { class: 'acct-ok' }, icon('check_circle'), 'Signed in') : el('span', { class: 'acct-warn' }, icon('error'), 'Needs app password')),
            el('button', { class: 'btn btn-tonal', onclick: () => editAccount(a) }, icon('edit'), 'Edit'),
            el('button', { class: 'icon-btn', title: 'Remove', onclick: () => removeAccount(a) }, icon('delete')))
        ),
        el('button', { class: 'btn btn-primary', onclick: () => editAccount(null) }, icon('add'), 'Add an email account')
      ),
      el('h3', {}, 'Smart folders'),
      el('p', { class: 'hint' }, 'One per line. "All business" in Mail collects KHT, Dive Moore, Museum and Business.'),
      folderBox,
      el('h3', {}, 'Keyword rules'),
      el('p', { class: 'hint' }, 'Free and instant, and they always beat Claude\'s guess. First match wins. Type label:Business to use a Gmail label (and the labels under it), or category:promotions for a Gmail tab (promotions, social, updates, forums, primary). Anything else matches the sender, recipients or subject.'),
      rulesBox,
      el('h3', {}, 'More'),
      el('label', { class: 'check-row' }, autoSort, 'Let Claude sort new mail automatically (API key option)'),
      el('label', { class: 'field-label' }, 'How many recent emails to load per account', fetchCount)
    );
  };

  const saveMail = async () => {
    const saved = await host.mail.saveSettings(ms);
    ms = structuredClone(saved);
    await mail.settingsChanged();
    drawMail();
  };

  const removeAccount = async (a) => {
    if (!(await confirmDialog('Remove account', `Remove ${a.email} from PDF and Moore? Nothing is deleted from Gmail.`, 'Remove'))) return;
    ms.accounts = ms.accounts.filter((x) => x.id !== a.id);
    await saveMail();
  };

  const editAccount = async (existing) => {
    const a = existing
      ? structuredClone(existing)
      : { id: '', email: '', name: '', color: '#9b6bff', imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 587, identities: [], hasPassword: false };
    const result = await accountDialog(a, ms.folders);
    if (!result) return;
    const { account, newPassword, test } = result;
    const payload = structuredClone(ms);
    const idx = payload.accounts.findIndex((x) => x.id && x.id === account.id);
    const withPw = { ...account, newPassword };
    if (idx >= 0) payload.accounts[idx] = withPw;
    else payload.accounts.push(withPw);
    try {
      const saved = await host.mail.saveSettings(payload);
      ms = structuredClone(saved);
      await mail.settingsChanged();
      drawMail();
      if (test) {
        const savedAcct = ms.accounts.find((x) => x.email === account.email) || ms.accounts[ms.accounts.length - 1];
        toast(`Signing in to ${savedAcct.email}…`);
        try {
          await host.mail.test(savedAcct.id);
          toast(`✓ ${savedAcct.email} can read and send mail.`, { ms: 5000 });
        } catch (e) {
          toast(e.message + '  Also check that IMAP is on in Gmail settings.', { error: true, ms: 10000 });
        }
      }
    } catch (e) {
      toast(e.message, { error: true });
    }
  };
  drawMail();

  // ---- Updates ----
  const startupCheck = el('input', { type: 'checkbox', checked: !!updates.checkOnStartup });
  startupCheck.addEventListener('change', () => host.setUpdatePrefs({ checkOnStartup: startupCheck.checked }));
  const updPane = el(
    'div',
    { class: 'set-pane' },
    el('div', { class: 'version-card' }, el('img', { src: 'img/app.png', alt: '' }), el('div', {}, el('b', {}, 'PDF and Moore'), el('small', {}, 'Version ' + version))),
    el('button', { class: 'btn btn-primary big-btn', onclick: () => host.hostCommand('checkUpdates').catch((e) => toast(e.message, { error: true })) }, icon('system_update'), 'Check for updates now'),
    el('label', { class: 'check-row', style: { marginTop: '16px' } }, startupCheck, 'Check automatically each time the app opens'),
    el('p', { class: 'hint' }, 'Updates come from github.com/moorejohnedward/pdfandmoore. Each download is checked against its fingerprint before it\'s installed, and your work is never closed without asking.')
  );

  // ---- Tabs ----
  const tabs = [
    ['look', 'palette', 'Look & feel', lookPane, '#ff7a59'],
    ['ai', 'auto_awesome', 'AI assistant', aiPane, '#d97757'],
    ['mail', 'mail', 'Email', mailPane, '#2bb3d9'],
    ['updates', 'system_update', 'Updates', updPane, '#3fc28a'],
  ];
  const nav = el('nav', { class: 'set-nav' });
  const body = el('div', { class: 'set-body' });
  const show = (id) => {
    nav.replaceChildren(...tabs.map(([tid, ic, label, , color]) => el('button', { class: 'set-tab' + (tid === id ? ' on' : ''), style: { '--c': color }, onclick: () => show(tid) }, icon(ic), label)));
    body.replaceChildren(tabs.find((t) => t[0] === id)[3]);
  };
  show(tabs.some((t) => t[0] === startTab) ? startTab : 'look');

  const ok = await dialog({
    title: 'Settings',
    body: el('div', { class: 'settings' }, nav, body),
    width: '900px',
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Save', value: true, primary: true },
    ],
  });
  if (!ok) return false;

  // Save AI settings
  const latest = (await host.getSettings().catch(() => ai)) || ai; // "Choose AI" may have changed things meanwhile
  const next = { ...latest, apiKey: key.value.trim(), model: model.value, userName: name.value.trim() };
  if (next.apiKey && !next.claudeMode) next.claudeMode = 'api';
  await host.saveSettings(next);
  await reloadSettings();

  // Save email extras (accounts were saved as they were edited)
  if (ms) {
    ms.folders = folderBox.value.split('\n').map((x) => x.trim()).filter(Boolean);
    ms.fetchCount = Number(fetchCount.value) || 50;
    ms.autoSort = autoSort.checked;
    ms.aboutMe = aboutMe.value.trim();
    try {
      await saveMail();
    } catch (e) {
      toast(e.message, { error: true });
    }
  }
  toast('Settings saved.');
  return true;
}

// ---------------------------------------------------------------------------
// Add / edit one email account
// ---------------------------------------------------------------------------
const COLORS = ['#ff7a59', '#2bb3d9', '#9b6bff', '#3fc28a', '#ffc845', '#ff5fa2', '#5ab8ff', '#8fa6bd'];

async function accountDialog(a, folders) {
  const name = el('input', { class: 'field', value: a.name, placeholder: 'e.g. Business' });
  const email = el('input', { class: 'field', value: a.email, placeholder: 'you@gmail.com or you@yourbusiness.com', type: 'email' });
  const pw = el('input', { class: 'field', type: 'password', placeholder: a.hasPassword ? '•••• saved — paste a new one to replace it' : 'Paste the 16-letter app password', autocomplete: 'off' });
  const showPw = el('button', { class: 'icon-btn small', title: 'Show', onclick: () => (pw.type = pw.type === 'password' ? 'text' : 'password') }, icon('visibility'));
  let color = a.color || COLORS[0];
  const swatches = el('div', { class: 'swatches' });
  const drawSw = () => swatches.replaceChildren(...COLORS.map((c) => el('button', { class: 'swatch-dot' + (c === color ? ' on' : ''), style: { background: c }, title: c, onclick: () => ((color = c), drawSw()) })));
  drawSw();
  const imap = el('input', { class: 'field', value: a.imapHost });
  const imapPort = el('input', { class: 'field', type: 'number', value: a.imapPort });
  const smtp = el('input', { class: 'field', value: a.smtpHost });
  const smtpPort = el('input', { class: 'field', type: 'number', value: a.smtpPort });

  const ids = structuredClone(a.identities || []);
  const idBox = el('div', { class: 'id-cards' });
  const drawIds = () =>
    idBox.replaceChildren(
      ...ids.map((i, n) =>
        el('div', { class: 'id-card' },
          el('div', { class: 'id-grid' },
            el('label', { class: 'field-label' }, 'Email address', el('input', { class: 'field', value: i.address, oninput: (e) => (i.address = e.target.value) })),
            el('label', { class: 'field-label' }, 'Business or role', el('input', { class: 'field', value: i.business, placeholder: 'e.g. Kona Hydrostatic Testing', oninput: (e) => (i.business = e.target.value) })),
            el('label', { class: 'field-label' }, 'Name people see', el('input', { class: 'field', value: i.displayName, oninput: (e) => (i.displayName = e.target.value) })),
            el('label', { class: 'field-label' }, 'Mail sent to it goes in', el('input', { class: 'field', value: i.folder, list: 'acctFolders', oninput: (e) => (i.folder = e.target.value) }))
          ),
          el('label', { class: 'field-label' }, 'Topics that mean "send from this address" (for Pick for me)', el('input', { class: 'field', value: i.hints, oninput: (e) => (i.hints = e.target.value) })),
          el('label', { class: 'field-label' }, 'Signature', el('textarea', { class: 'field', rows: 4, oninput: (e) => (i.signature = e.target.value) }, i.signature)),
          el('button', { class: 'btn btn-text small danger', onclick: () => (ids.splice(n, 1), drawIds()) }, icon('delete'), 'Remove this address'))
      ),
      el('button', { class: 'btn btn-tonal', onclick: () => (ids.push({ address: ids.length ? '' : email.value, displayName: 'John Moore', business: '', folder: 'Personal', hints: '', signature: '' }), drawIds()) }, icon('add'), 'Add an address or alias'),
      el('datalist', { id: 'acctFolders' }, folders.map((f) => el('option', { value: f })))
    );
  drawIds();

  const body = el(
    'div',
    { class: 'acct-dialog' },
    el('div', { class: 'steps' },
      el('div', { class: 'step' }, el('span', { class: 'step-n' }, '1'), el('div', {},
        el('b', {}, 'Make an app password'),
        el('p', { class: 'hint' }, 'Sign in to this Google account, open ', el('a', { href: '#', onclick: (e) => (e.preventDefault(), host.openExternal('https://myaccount.google.com/apppasswords')) }, 'myaccount.google.com/apppasswords'),
          ', name it "PDF and Moore" and copy the 16 letters. (2-Step Verification has to be on. For a Workspace account, an admin may need to allow it.)'))),
      el('div', { class: 'step' }, el('span', { class: 'step-n' }, '2'), el('div', {},
        el('b', {}, 'Turn on IMAP'),
        el('p', { class: 'hint' }, 'Gmail on the web › ⚙ › See all settings › Forwarding and POP/IMAP › Enable IMAP.'))),
      el('div', { class: 'step' }, el('span', { class: 'step-n' }, '3'), el('div', {},
        el('b', {}, 'Aliases'),
        el('p', { class: 'hint' }, 'Each alias must also be added once in Gmail › ⚙ › See all settings › Accounts › "Send mail as", or Gmail sends from the main address instead.')))
    ),
    el('div', { class: 'id-grid' },
      el('label', { class: 'field-label' }, 'Sign-in email', email),
      el('label', { class: 'field-label' }, 'Name in the sidebar', name)),
    el('label', { class: 'field-label' }, 'App password', el('div', { class: 'compose-row' }, pw, showPw)),
    el('div', { class: 'field-label' }, 'Color', swatches),
    el('details', { class: 'adv' }, el('summary', {}, 'Server settings (only for non-Gmail accounts)'),
      el('div', { class: 'id-grid' },
        el('label', { class: 'field-label' }, 'Incoming (IMAP) server', imap), el('label', { class: 'field-label' }, 'Port', imapPort),
        el('label', { class: 'field-label' }, 'Outgoing (SMTP) server', smtp), el('label', { class: 'field-label' }, 'Port', smtpPort))),
    el('h3', {}, 'Addresses you send from with this account'),
    idBox
  );

  const collect = () => ({
    account: {
      ...a,
      name: name.value.trim(),
      email: email.value.trim(),
      color,
      imapHost: imap.value.trim() || 'imap.gmail.com',
      imapPort: Number(imapPort.value) || 993,
      smtpHost: smtp.value.trim() || 'smtp.gmail.com',
      smtpPort: Number(smtpPort.value) || 587,
      identities: ids.filter((i) => i.address.trim()),
    },
    newPassword: pw.value.replace(/\s/g, ''),
  });

  for (;;) {
    const r = await dialog({
      title: a.email ? 'Edit ' + a.email : 'Add an email account',
      body,
      width: '760px',
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Save', value: 'save' },
        { label: 'Save & test', value: 'test', primary: true },
      ],
    });
    if (!r) return null;
    const out = collect();
    if (!out.account.email.includes('@')) {
      toast('Enter the sign-in email address.', { error: true });
      continue;
    }
    if (!out.account.identities.length) out.account.identities.push({ address: out.account.email, displayName: 'John Moore', business: '', folder: 'Personal', hints: '', signature: '' });
    return { ...out, test: r === 'test' };
  }
}
