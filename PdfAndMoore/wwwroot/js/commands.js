// Plain-English editing: "delete page 3", "add today's date next to Date", "white out 808-555-1234".
// 1) A built-in command reader handles everyday requests instantly, offline and free.
// 2) Anything it doesn't understand goes to an AI (on-device, Claude API, or your Claude account),
//    which answers with the same list of actions. Every result is a normal item you can move or edit.
import { state, emit, checkpoint, changed } from './state.js';
import { getPageTextItems, totalRotation, loadSource, pagesForSource, rightVec, downVec, boxInView } from './doc.js';
import { planFromText, DOC_SCHEMA } from './newdoc.js';
import { uid } from './util.js';

// ---------------------------------------------------------------------------
// Actions (the "language" both the built-in reader and the AIs speak)
// ---------------------------------------------------------------------------
export const ACTION_SCHEMA = `
Reply with ONLY JSON: {"actions":[ ... ]}. Pages are numbered from 1. Use text copied exactly from the document for "text", "find" and "near".
Actions:
{"action":"add_text","text":"...","page":1,"where":"top|bottom|center|top-left|top-right|bottom-left|bottom-right","near":"label","position":"right|left|below|above","size":12,"color":"#000000","bold":false}
{"action":"replace_text","find":"old words","replace":"new words","page":null}
{"action":"remove_text","find":"words to white out","page":null}
{"action":"highlight","find":"words","color":"#ffd54f","page":null}
{"action":"underline","find":"words","page":null}
{"action":"strike","find":"words","page":null}
{"action":"circle","find":"words","color":"#d93025","page":null}
{"action":"add_field","kind":"text|checkbox|date|signature|dropdown","near":"label","position":"right|left|below|above","every":false,"page":null,"name":"optional field name"}
{"action":"fill_field","field":"field name or its label","value":"text, or true/false for a checkbox"}
{"action":"add_note","text":"comment","near":"label","page":1}
{"action":"sign","near":"Signature"}
{"action":"delete_pages","pages":[3]}
{"action":"rotate_pages","pages":[1],"degrees":90}
{"action":"move_page","from":4,"to":1}
{"action":"insert_blank_page","after":2}
{"action":"duplicate_page","page":1}
{"action":"page_numbers","where":"bottom"}
{"action":"watermark","text":"DRAFT"}
{"action":"clear","what":"highlights|comments|drawings|text|fields|all","page":null}
{"action":"detect_fields"} {"action":"name_fields"} {"action":"ocr"}
{"action":"redact","find":"words to remove for good","kinds":["ssn","phone","email","card","date"],"page":null}  (true redaction; use kinds for kinds of private info)
{"action":"set_password","password":"..."} {"action":"remove_password"} {"action":"remove_hidden_info"} {"action":"sign_digital"}
{"action":"add_text_box","text":"...","page":1,"where":"top-right","near":"label","position":"below","width":200,"size":11,"color":"#000000","bg":"#fff8e1","border":"#1a73e8","bold":false}
{"action":"add_line","page":1,"near":"label","position":"below","where":"top|bottom","length":"full|text|200","color":"#000000","width":1.5}
{"action":"add_logo","page":1,"where":"top-left","width":110}   (the user's saved logo; they pick one the first time)
{"action":"add_image","page":1,"where":"top-right","width":150}   (asks the user to pick a picture)
{"action":"move_item","target":"selected | field name | text of a text box | line | line under <label> (lines printed in the PDF, e.g. table borders and underlines) | logo | image | box | circle | arrow | note | highlight","dx":0,"dy":0,"where":"top-left..bottom-right","near":"label","position":"below","page":null}   (dx/dy are points as seen on screen: + is right/down, 72 = 1 inch)
{"action":"resize_item","target":"...","width":200,"height":30,"scale":1.5}
{"action":"delete_item","target":"..."}   (ONE item. A printed line can be named exactly by its number from the layout list: "line L81")
{"action":"delete_near","near":"label words","what":"lines|fields|text boxes|lines and fields|everything","count":3,"position":"right|below|above","page":null}   (removes the blank writing lines printed by a label, e.g. the 3 lines after "Comments:", and/or the fields on them, in one go. count is optional; without it, all of that label's stacked lines)
{"action":"move_near","near":"label words","what":"...","dx":0,"dy":20}   {"action":"style_near","near":"label words","what":"lines","color":"#1a73e8","width":2}
To act on several printed lines, prefer delete_near, or one delete_item per line using its L-number (never repeat the same "line under X" target expecting different lines).
{"action":"style_item","target":"...","color":"#d93025","size":14,"bold":true,"bg":"#ffffff","border":"#000000","width":2}
{"action":"restore","mode":"clean|crisp|color|retype","pages":null}   (old/faded/stained/crooked/photographed pages: straighten, crop, clean; "retype" rebuilds the page as clean new text)
{"action":"read_faded"}   (careful OCR for faded or worn text)
{"action":"edit_field","field":"field name or label","rename":"new name","kind":"text|checkbox|date|signature|dropdown","required":true,"options":["A","B"],"multiline":true,"width":200,"height":20,"delete":false}
{"action":"create_document", ...} makes a NEW complete fillable PDF from a description. Shape:
${DOC_SCHEMA}
Use "page":null to mean every page. "every":true adds a field next to every match of "near".
"today" in text means today's date.`;

const COLORS = {
  red: '#d93025', blue: '#1a73e8', green: '#188038', yellow: '#fbbc04', orange: '#e8710a', purple: '#9334e6',
  pink: '#e52592', black: '#000000', gray: '#5f6368', grey: '#5f6368', white: '#ffffff', navy: '#0b2c6b', teal: '#12a4af',
};
const HIGHLIGHTS = { yellow: '#ffd54f', green: '#a8e6a1', blue: '#a8d1ff', pink: '#ffb3d9', orange: '#ffc78a', purple: '#d7b8ff', red: '#ff9a9a' };

function today() {
  const t = new Date();
  return `${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')}/${t.getFullYear()}`;
}

// ---------------------------------------------------------------------------
// The built-in command reader (rules). Returns {actions, unknown:[parts it couldn't read]}.
// ---------------------------------------------------------------------------
const Q = `["“”'‘’]`; // any quote mark
const quoted = (s) => {
  const m = s.match(new RegExp(`${Q}([^"“”]+?)${Q}`));
  return m ? m[1] : null;
};
const allQuoted = (s) => [...s.matchAll(new RegExp(`${Q}([^"“”]+?)${Q}`, 'g'))].map((m) => m[1]);

function parsePages(s) {
  const total = state.doc ? state.doc.pages.length : 1;
  if (/\b(all|every) pages?\b/i.test(s)) return Array.from({ length: total }, (_, i) => i + 1);
  if (/\blast page\b/i.test(s)) return [total];
  if (/\bfirst page\b/i.test(s)) return [1];
  if (/\b(this|current) page\b/i.test(s)) return [state.currentPage + 1];
  const m = s.match(/\bpages?\s+([\d\s,\-–and&to]+)/i);
  if (!m) return null;
  const out = [];
  for (const part of m[1].replace(/\band\b|&/gi, ',').replace(/\bto\b/gi, '-').split(',')) {
    const r = part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (r) for (let i = +r[1]; i <= +r[2]; i++) out.push(i);
    else if (/^\d+$/.test(part.trim())) out.push(+part.trim());
  }
  return out.length ? out : null;
}
const pageOf = (s) => {
  const p = parsePages(s);
  return p && p.length === 1 ? p[0] : null;
};

function parseColor(s, table = COLORS) {
  const m = s.match(/\b(?:in\s+)?(red|blue|green|yellow|orange|purple|pink|black|gray|grey|white|navy|teal)\b/i);
  return m ? table[m[1].toLowerCase()] || COLORS[m[1].toLowerCase()] : null;
}

function parseWhere(s) {
  const m = s.match(/\b(top|bottom)[\s-]*(left|right|center|centre|middle)?\b|\b(center|centre|middle)\b/i);
  if (!m) return null;
  if (m[3]) return 'center';
  const side = (m[2] || '').toLowerCase().replace('centre', 'center').replace('middle', 'center');
  return side && side !== 'center' ? `${m[1].toLowerCase()}-${side}` : m[1].toLowerCase();
}

function parseNear(s) {
  // next to / after / beside / right of / below / under / above / before / left of  + "label" or label words
  const m = s.match(/\b(next to|beside|after|right of|to the right of|following|below|under(?:neath)?|beneath|above|over|before|left of|to the left of|by|near|at|on the)\s+(?:the\s+)?(?:word\s+|label\s+|line\s+|text\s+)?(.+)$/i);
  if (!m) return null;
  const rel = m[1].toLowerCase();
  let target = quoted(m[2]) || m[2].replace(/\b(on|in)\s+(page|all pages|every page).*$/i, '').replace(/\b(field|box|line|label)s?\b\.?$/i, '').trim();
  target = target.replace(/^(?:the|a|an)\s+/i, '').replace(/[.?!]+$/, '').trim();
  if (!target || /^(top|bottom|center|centre|middle|end|start|beginning)\b/i.test(target)) return null;
  let position = 'right';
  if (/below|under|beneath/.test(rel)) position = 'below';
  else if (/above|over/.test(rel)) position = 'above';
  else if (/before|left/.test(rel)) position = 'left';
  return { near: target, position };
}

function stripTail(s) {
  return s.replace(/\s+(on|in)\s+(page\s+\d+|all pages|every page|the (first|last) page)\b.*$/i, '').trim();
}

const KIND_WORDS = [
  [/check\s?boxe?s?|tick boxe?s?/i, 'checkbox'],
  [/signature (field|box|line|spot)s?/i, 'signature'],
  [/date (field|box)e?s?/i, 'date'],
  [/drop\s?downs?|pick lists?|choice lists?/i, 'dropdown'],
  [/radio (button)?s?/i, 'radio'],
  [/(text\s?)?(field|box|blank|fill[- ]in)s?/i, 'text'],
];

/** Read one simple instruction. Returns an action, a list of actions, or null. */
function parseOne(raw) {
  const s = raw.trim().replace(/\s+/g, ' ');
  const low = s.toLowerCase();
  const q = quoted(s);

  // ---- pages ----
  if (/^(delete|remove|drop|get rid of)\b.*\bpages?\b/i.test(s) && !q) {
    const pages = parsePages(s);
    if (pages) return { action: 'delete_pages', pages };
    if (/\bblank pages?\b/i.test(s)) return { action: 'delete_blank_pages' };
  }
  if (/^(rotate|turn|flip)\b/i.test(s)) {
    const pages = parsePages(s) || [state.currentPage + 1];
    let degrees = 90;
    if (/left|counter|anti/i.test(s)) degrees = -90;
    if (/180|upside|over\b|flip/i.test(s)) degrees = 180;
    return { action: 'rotate_pages', pages, degrees };
  }
  let m;
  if ((m = s.match(/^move page (\d+) (?:to )?(?:the )?(start|beginning|front|end|back|after page (\d+)|before page (\d+)|position (\d+)|page (\d+))/i))) {
    const total = state.doc.pages.length;
    const to = /start|beginning|front/i.test(m[2]) ? 1 : /end|back/i.test(m[2]) ? total : m[3] ? +m[3] + 1 : +(m[4] || m[5] || m[6]);
    return { action: 'move_page', from: +m[1], to };
  }
  if (/^(add|insert|put)\b.*\bblank page\b/i.test(s)) {
    const total = state.doc.pages.length;
    let after = total;
    if ((m = s.match(/after page (\d+)/i))) after = +m[1];
    else if ((m = s.match(/before page (\d+)/i))) after = +m[1] - 1;
    else if (/start|beginning|front|first/i.test(s)) after = 0;
    return { action: 'insert_blank_page', after };
  }
  if ((m = s.match(/^(duplicate|copy) page (\d+)/i))) return { action: 'duplicate_page', page: +m[2] };
  if (/page numbers?/i.test(s) && /^(add|put|number)/i.test(s)) return { action: 'page_numbers', where: parseWhere(s) || 'bottom' };
  if (/^number (the )?pages/i.test(s)) return { action: 'page_numbers', where: 'bottom' };
  if (/watermark|stamp/i.test(s) && /^(add|put|stamp)/i.test(s)) return { action: 'watermark', text: q || (s.match(/(draft|copy|confidential|void|paid|approved|sample)/i) || [, 'DRAFT'])[1].toUpperCase() };

  // ---- forms ----
  if ((/\b(detect|find|create|make|add)\b.*\b(fields|fillable)\b/i.test(s) || /^make (it|this|the (form|document|pdf|page))( into a form)?$/i.test(s)) && !/next to|beside|after|below|under|above/i.test(s)) return { action: 'detect_fields' };
  if (/\b(name|rename|label|clean ?up|tidy)\b.*\bfields\b/i.test(s)) return { action: 'name_fields' };
  if (/^(ocr|read the text|make (it )?searchable|recognize text|scan text)/i.test(s)) return { action: 'ocr' };
  if ((m = s.match(/^(un)?(check|tick|mark|select)\s+(?:the\s+)?(.+?)(?:\s+(?:check)?box)?$/i)) && !/\b(text|word)\b/.test(low)) {
    return { action: 'fill_field', field: quoted(m[3]) || m[3].trim(), value: !m[1], checkbox: true };
  }
  if ((m = s.match(/^(?:fill(?: in)?|set|enter)\s+(?:the\s+)?(.+?)\s+(?:field\s+|box\s+)?(?:with|to|as)\s+(.+)$/i))) {
    return { action: 'fill_field', field: quoted(m[1]) || m[1].replace(/\b(field|box)\b/i, '').trim(), value: valueText(quoted(m[2]) || m[2]) };
  }
  if ((m = s.match(/^(?:put|type|write|enter)\s+(.+?)\s+(?:in|into)\s+(?:the\s+)?(.+?)(?:\s+(?:field|box|blank))?$/i)) && !/\bpage\b/i.test(m[2])) {
    return { action: 'fill_field', field: quoted(m[2]) || m[2].trim(), value: valueText(quoted(m[1]) || m[1]), fallbackText: true };
  }
  if (/^(add|put|insert|place|create|make)\b/i.test(s)) {
    for (const [re, kind] of KIND_WORDS) {
      if (!re.test(s)) continue;
      // "add a text box that says ..." is text, not a field
      if (kind === 'text' && /\b(says|saying|reading|that reads)\b/i.test(s)) break;
      const near = parseNear(s);
      const every = /\b(every|each|all)\b/i.test(s);
      if (near || kind === 'signature') {
        return { action: 'add_field', kind, near: near ? near.near : 'Signature', position: near ? near.position : 'right', every, page: pageOf(s) };
      }
      break;
    }
  }
  if (/^(sign|add my signature|put my signature|insert my signature)/i.test(s)) {
    const near = parseNear(s);
    return { action: 'sign', near: near ? near.near : 'Signature', page: pageOf(s) };
  }

  // ---- new documents ----
  const plan = planFromText(s);
  if (plan) return { action: 'create_document', plan };

  // ---- move / resize / delete things you added ----
  if ((m = s.match(/^(?:move|shift|nudge|slide|drag)\s+(?:the\s+)?(.+?)\s+(up|down|left|right)(?:\s+(?:by\s+)?(\d+(?:\.\d+)?|an?|half an?)\s*(inch(?:es)?|in|"|points?|pts?|px|cm|mm)?)?(?:\s+(?:and|then)\s+(up|down|left|right)\s+(?:by\s+)?(\d+(?:\.\d+)?|an?)\s*(inch(?:es)?|in|"|points?|pts?|px|cm|mm)?)?$/i))) {
    const dist = (n, unit) => {
      let v = !n ? 18 : /^an?$/i.test(n) ? 1 : /^half/i.test(n) ? 0.5 : +n;
      if (!n) return 18;
      if (/^(inch|in|")/i.test(unit || '') || /^an?$|^half/i.test(n)) v *= 72;
      else if (/^cm/i.test(unit || '')) v *= 28.35;
      else if (/^mm/i.test(unit || '')) v *= 2.835;
      return v;
    };
    let dx = 0;
    let dy = 0;
    const apply = (dir, n, unit) => {
      const d = dist(n, unit);
      if (/up/i.test(dir)) dy -= d;
      else if (/down/i.test(dir)) dy += d;
      else if (/left/i.test(dir)) dx -= d;
      else dx += d;
    };
    apply(m[2], m[3], m[4]);
    if (m[5]) apply(m[5], m[6], m[7]);
    return { action: 'move_item', target: quoted(m[1]) || clean(m[1]), dx, dy, page: pageOf(s) };
  }
  if ((m = s.match(/^(?:move|put|place)\s+(?:the\s+)?(.+?)\s+(?:to\s+)?(?:the\s+)?((?:top|bottom)(?:[\s-]*(?:left|right|center|middle))?|center|middle)(?:\s+of\s+(?:the\s+)?page(?:\s+(\d+))?)?$/i))) {
    return { action: 'move_item', target: quoted(m[1]) || clean(m[1]), where: parseWhere(m[2]), page: m[3] ? +m[3] : null };
  }
  if ((m = s.match(/^move\s+(?:the\s+)?(.+?)\s+(next to|beside|after|below|under|above|before)\s+(.+)$/i))) {
    const near = parseNear(m[2] + ' ' + m[3]);
    return { action: 'move_item', target: quoted(m[1]) || clean(m[1]), near: near ? near.near : clean(m[3]), position: near ? near.position : 'right' };
  }
  if ((m = s.match(/^(?:make|resize)\s+(?:the\s+)?(.+?)\s+(bigger|larger|smaller|wider|narrower|taller|shorter|twice as big|half the size)$/i))) {
    const w = m[2].toLowerCase();
    const scale = /bigger|larger/.test(w) ? 1.25 : /twice/.test(w) ? 2 : /half/.test(w) ? 0.5 : /smaller/.test(w) ? 0.8 : null;
    return { action: 'resize_item', target: quoted(m[1]) || clean(m[1]), scale, widthScale: /wider/.test(w) ? 1.3 : /narrower/.test(w) ? 0.75 : null, heightScale: /taller/.test(w) ? 1.3 : /shorter/.test(w) ? 0.75 : null };
  }
  if ((m = s.match(/^(?:make|turn|color|colour)\s+(?:the\s+)?(.+?)\s+(red|blue|green|yellow|orange|purple|pink|black|gray|grey|white|navy|teal|bold)$/i)) && !/\b(form|document|page|pdf)\b/i.test(m[1])) {
    return /bold/i.test(m[2]) ? { action: 'style_item', target: clean(m[1]), bold: true } : { action: 'style_item', target: clean(m[1]), color: COLORS[m[2].toLowerCase()] };
  }
  if ((m = s.match(/^(?:delete|remove|erase|get rid of|take out|take away|clear)\s+(.+)$/i)) && pluralTarget(m[1])) return { action: 'delete_item', target: m[1] };
  if ((m = s.match(/^(?:delete|remove|erase|get rid of)\s+(?:the\s+)?((?:printed\s+|table\s+)?(?:line|border|underline)\s+(?:under(?:neath)?|below|beneath|above|over|left of|right of|to the right of|next to|beside|by|near|for|after)\s+.+)$/i))) return { action: 'delete_item', target: clean(m[1]) };
  if ((m = s.match(/^(?:delete|remove|get rid of)\s+(?:the\s+)?(selected (?:item|thing|box|field|line)|my logo|logo|(?:last |that )?(?:line|arrow|text box|image|picture|box|circle|signature image))$/i))) {
    return { action: 'delete_item', target: m[1].replace(/^(last|that|my) /i, '').replace(/^selected .*/i, 'selected') };
  }
  // ---- forms: edit fields ----
  if ((m = s.match(/^rename\s+(?:the\s+)?(.+?)\s+(?:field\s+)?(?:to|as)\s+(.+)$/i))) return { action: 'edit_field', field: quoted(m[1]) || clean(m[1]).replace(/\s+field$/i, ''), rename: allQuoted(s)[1] || clean(m[2]) };
  if ((m = s.match(/^make\s+(?:the\s+)?(.+?)\s+(?:field\s+)?(required|optional|a checkbox|a date(?: field)?|a signature(?: field)?|a dropdown|multi-?line|a text (?:field|box))$/i)) && !/\b(form|document)\b/i.test(m[1])) {
    const w = m[2].toLowerCase();
    const e = { action: 'edit_field', field: quoted(m[1]) || clean(m[1]).replace(/\s+field$/i, '') };
    if (w === 'required') e.required = true;
    else if (w === 'optional') e.required = false;
    else if (/multi/.test(w)) e.multiline = true;
    else e.kind = /checkbox/.test(w) ? 'checkbox' : /date/.test(w) ? 'date' : /signature/.test(w) ? 'signature' : /dropdown/.test(w) ? 'dropdown' : 'text';
    return e;
  }
  if ((m = s.match(/^(?:delete|remove)\s+(?:the\s+)?(.+?)\s+field$/i))) return { action: 'edit_field', field: quoted(m[1]) || clean(m[1]), delete: true };
  if ((m = s.match(/^(?:give|set)\s+(?:the\s+)?(.+?)\s+(?:dropdown\s+|field\s+)?(?:the\s+)?(?:options|choices)\s+(.+)$/i))) {
    return { action: 'edit_field', field: clean(m[1]), options: m[2].split(/\s*,\s*|\s+(?:and|or)\s+/).map((x) => x.replace(/["“”]/g, '').trim()).filter(Boolean) };
  }
  // ---- lines, logos, text boxes ----
  if (/^(?:add|draw|put|insert)\s+(?:a\s+)?(?:horizontal\s+|divider\s+|thin\s+|thick\s+)?(?:line|divider|rule|separator)\b/i.test(s)) {
    const near = parseNear(s);
    return { action: 'add_line', near: near ? near.near : null, position: near ? (near.position === 'right' ? 'below' : near.position) : null, where: near ? null : parseWhere(s) || 'center', length: /full|across|whole width/i.test(s) ? 'full' : null, color: parseColor(s) || '#000000', width: /thick/i.test(s) ? 3 : 1.2, page: pageOf(s) || state.currentPage + 1 };
  }
  if (/^(?:add|put|insert|place)\s+(?:my\s+|the\s+|a\s+|our\s+)?(?:company\s+|business\s+)?logo\b/i.test(s)) {
    return { action: 'add_logo', where: parseWhere(s) || 'top-left', page: pageOf(s) || 1, allPages: /\b(all|every) pages?\b/i.test(s) };
  }
  if (/^(?:add|put|insert|place)\s+(?:a\s+|an\s+)?(?:picture|image|photo)\b/i.test(s)) return { action: 'add_image', where: parseWhere(s) || 'center', page: pageOf(s) || state.currentPage + 1 };
  if ((m = s.match(/^(?:add|put|insert|place)\s+(?:a\s+)?(?:(red|blue|green|yellow|orange|purple|gray|grey)\s+)?(?:boxed\s+|bordered\s+)?text ?box\b\s*(?:saying|that says|with|reading|:)?\s*(.*)$/i))) {
    const text = q || m[2].replace(/\b(next to|beside|below|under|above|at the|on page|in (?:red|blue|green|black)).*$/i, '').trim() || 'Text';
    const near = parseNear(s.replace(new RegExp(`${Q}[^"“”]+${Q}`), ''));
    const c = m[1] ? COLORS[m[1].toLowerCase()] : '#1a73e8';
    return { action: 'add_text_box', text, near: near ? near.near : null, position: near ? near.position : null, where: near ? null : parseWhere(s) || 'top-right', page: pageOf(s) || state.currentPage + 1, border: c, bg: '#ffffff', size: 11 };
  }

  // ---- old documents ----
  if (/^(?:restore|retype|re-type|clean ?up|fix|repair|refresh|renew|enhance|brighten|whiten|straighten)\b.*\b(?:document|scan|page|pages|it|this|photo|picture|paper|pdf|look)\b|^make (?:it|this|the (?:document|scan|page|pages)) (?:look )?(?:new|like new|clean|readable|crisp|sharp)/i.test(s) && !/\bfields?\b/i.test(s)) {
    const mode = /retype|re-type|type it|clean type|new text/i.test(s) ? 'retype' : /black|crisp|sharp|like new|new/i.test(s) ? 'crisp' : /colou?r/i.test(s) ? 'color' : 'clean';
    return { action: 'restore', mode, pages: parsePages(s) };
  }
  if (/^(?:read|ocr|recognize|pick up|get)\b.*\b(?:faded|worn|old|damaged|faint|light|hard to read)/i.test(s)) return { action: 'read_faded' };

  // ---- protect ----
  if ((m = s.match(/^(?:redact|black ?out|permanently (?:remove|delete|hide)|scrub)\s+(?:all\s+)?(?:the\s+)?(?:words?\s+|text\s+)?(.+)$/i))) {
    const t = m[1];
    if (q || /\d{3}/.test(t)) {
      // A specific value: "redact the phone number 808-555-1234" -> just "808-555-1234".
      const value = clean(stripTail(t)).replace(/^(?:(?:home|mailing|street|my|his|her|their|customer'?s?)\s+)*(?:address|phone(?: number)?|cell(?: number)?|number|ssn|social security(?: number)?|account(?: number)?|card(?: number)?|e-?mail|date(?: of birth)?|dob|birthday|name)\s*(?:of|is|:)?\s+/i, '');
      return { action: 'redact', find: q || value, kinds: [], page: pageOf(s) };
    }
    const kinds = [];
    if (/social security|\bssns?\b|\bss ?#/i.test(t)) kinds.push('ssn');
    if (/phone|cell|fax/i.test(t)) kinds.push('phone');
    if (/e-?mails?/i.test(t)) kinds.push('email');
    if (/card|account|bank|routing/i.test(t)) kinds.push('card');
    if (/dates?\b|birthdays?|dob\b|date of birth/i.test(t)) kinds.push('date');
    if (/personal|private|sensitive|pii/i.test(t) && !kinds.length) kinds.push('ssn', 'phone', 'email', 'card');
    return { action: 'redact', find: kinds.length && !q ? null : q || clean(stripTail(t)), kinds, page: pageOf(s) };
  }
  if (/^apply (?:the |all |my )?redactions?$/i.test(s)) return { action: 'apply_redactions' };
  if (/^(?:remove|take off|delete|clear) (?:the )?password|^unlock\b/i.test(s)) return { action: 'remove_password' };
  if ((m = s.match(/^(?:lock|password[- ]protect|protect|encrypt|add a password|put a password)\b.*?(?:password|with|using)\s*(?:of|is|:|to)?\s*(\S+)$/i)) && !/^(it|this|the|file|document|pdf)$/i.test(m[1])) {
    return { action: 'set_password', password: q || m[1] };
  }
  if (/^(?:lock|password[- ]protect|encrypt)\b/i.test(s) || /^(?:add|put) a password/i.test(s)) return { action: 'set_password', password: q || null };
  if (/^(?:remove|delete|strip|clean ?up|scrub) (?:the )?(?:hidden (?:info|information|data)|metadata|document properties)/i.test(s)) return { action: 'remove_hidden_info' };
  if (/^(?:digitally sign|sign (?:it |this |the (?:document|pdf|file) )?(?:digitally|with (?:my |a )?(?:digital id|certificate)))/i.test(s)) return { action: 'sign_digital' };

  // ---- text edits ----
  if ((m = s.match(/^(?:replace|change|swap)\s+(.+?)\s+(?:with|to|for|into)\s+(.+)$/i))) {
    const parts = allQuoted(s);
    const find = parts[0] || clean(m[1]);
    const replace = parts[1] || clean(stripTail(m[2]));
    return { action: 'replace_text', find, replace: replace === 'today' || /today'?s date/i.test(replace) ? today() : replace, page: pageOf(s) };
  }
  if ((m = s.match(/^(?:remove|delete|erase|white ?out|cover(?: up)?|hide|blank out)\s+(?:the\s+)?(?:words?\s+|text\s+|line\s+)?(.+)$/i))) {
    if (/^(all\s+)?(highlights?|comments?|notes?|drawings?|annotations?|my (edits|changes|marks)|marks|fields|form fields|text boxes|everything i added)\b/i.test(m[1])) {
      return { action: 'clear', what: clearWhat(m[1]), page: pageOf(s) };
    }
    return { action: 'remove_text', find: q || clean(stripTail(m[1])), page: pageOf(s) };
  }
  if ((m = s.match(/^clear\s+(?:all\s+)?(?:the\s+)?(.+)$/i))) return { action: 'clear', what: clearWhat(m[1]), page: pageOf(s) };
  if ((m = s.match(/^(highlight|underline|strike(?: ?out| ?through)?|cross out|circle|box)\s+(?:the\s+)?(?:words?\s+|text\s+)?(.+)$/i))) {
    const verb = m[1].toLowerCase();
    const action = verb.startsWith('high') ? 'highlight' : verb.startsWith('under') ? 'underline' : verb.startsWith('circle') || verb === 'box' ? 'circle' : 'strike';
    let target = q || clean(stripTail(m[2]).replace(/\s+in\s+(red|blue|green|yellow|orange|purple|pink|black)\b.*$/i, ''));
    return { action, find: target, color: parseColor(s, action === 'highlight' ? HIGHLIGHTS : COLORS), page: pageOf(s) };
  }
  if ((m = s.match(/^(?:add|put|leave|insert)\s+(?:a\s+)?(?:comment|note|sticky note)\s*(?:saying|that says|:)?\s*(.*)$/i))) {
    const near = parseNear(m[1]);
    const text = q || m[1].replace(/\b(next to|beside|after|on page|below|under|above).*$/i, '').trim() || 'Note';
    return { action: 'add_note', text, near: near ? near.near : null, page: pageOf(s) || state.currentPage + 1 };
  }
  if (/^(add|put|write|type|insert|place)\b/i.test(s) || /^(title|heading)\b/i.test(s)) {
    // add "text" [next to label | at top] [on page N] [in red] [size N] [bold]
    let text = q;
    const isToday = /today'?s date|\bthe date\b|\btoday\b/i.test(s) && !q;
    if (isToday) text = today();
    if (!text && (m = s.match(/^(?:add|put|write|type|insert|place)\s+(?:a\s+)?(?:title|heading|text(?: box)?|note)?\s*(?:saying|that says|reading|:)?\s*(.+?)(?:\s+(?:next to|beside|after|below|under|above|before|at the|on page|to the|in (?:red|blue|green|black|bold))\b.*)?$/i))) {
      text = m[1].trim();
    }
    if (!text) return null;
    const near = parseNear(s.replace(new RegExp(`${Q}[^"“”]+${Q}`), ''));
    const heading = /\b(title|heading|header)\b/i.test(s);
    const size = (s.match(/\bsize\s+(\d+)/i) || [])[1];
    return {
      action: 'add_text',
      text,
      page: pageOf(s) || (heading ? 1 : state.currentPage + 1),
      allPages: /\b(all|every) pages?\b/i.test(s),
      where: near ? null : parseWhere(s) || (heading ? 'top' : null),
      near: near ? near.near : null,
      position: near ? near.position : null,
      size: size ? +size : heading ? 20 : 12,
      color: parseColor(s) || '#000000',
      bold: heading || /\bbold\b/i.test(s),
    };
  }
  return null;
}

function valueText(v) {
  const t = String(v).trim().replace(/[.]+$/, '');
  if (/^today'?s date$|^today$|^the date$/i.test(t)) return today();
  if (/^(yes|checked|true|on)$/i.test(t)) return true;
  if (/^(no|unchecked|false|off)$/i.test(t)) return false;
  return t;
}
function clean(t) {
  return String(t).replace(/^(?:the|a|an)\s+/i, '').replace(/[.?!]+$/, '').trim();
}
function clearWhat(t) {
  t = t.toLowerCase();
  if (/highlight/.test(t)) return 'highlights';
  if (/comment|note/.test(t)) return 'comments';
  if (/draw|ink|mark|line|shape/.test(t)) return 'drawings';
  if (/field/.test(t)) return 'fields';
  if (/text/.test(t)) return 'text';
  return 'all';
}

/** Split a request into simple instructions ("delete page 2 and rotate page 1"). */
function splitRequest(text) {
  // Don't split inside quotes.
  const parts = [];
  let cur = '';
  let inQ = false;
  const s = text.replace(/\r/g, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (/["“”]/.test(ch)) inQ = !inQ;
    if (!inQ && (ch === '\n' || ch === ';')) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  const verbs = '(?:add|put|write|insert|delete|remove|rotate|move|highlight|underline|circle|replace|change|fill|check|uncheck|sign|number|white ?out|erase|clear|make|detect|duplicate|strike|cross|redact|black ?out|lock|apply|digitally|rename|resize|shift|nudge|draw|create|build)';
  const out = [];
  for (const p of parts) {
    // ", and then delete", " then rotate", " and add"
    out.push(...p.split(new RegExp(`\\s*(?:,\\s*)?(?:\\band then\\b|\\bthen\\b|\\band\\b|,)\\s+(?=${verbs}\\b)`, 'i')));
  }
  return out.map((x) => x.trim().replace(/^(please|can you|could you|i need you to|i want you to|go ahead and)\s+/i, '').replace(/[.!]+$/, '')).filter(Boolean);
}

export function parseWithRules(text) {
  const actions = [];
  const unknown = [];
  for (const part of splitRequest(text)) {
    const a = parseOne(part);
    if (a) actions.push(...(Array.isArray(a) ? a : [a]));
    else unknown.push(part);
  }
  return { actions, unknown };
}

// ---------------------------------------------------------------------------
// Finding words on the page
// ---------------------------------------------------------------------------
const lineCache = new Map();
let measureCtx = null;

/** Where each character of a text piece starts, as a fraction of the piece width (letters are not all the same width). */
export function charFractions(str, mono) {
  const n = str.length;
  if (mono || n < 2) return Array.from({ length: n + 1 }, (_, i) => i / Math.max(1, n));
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  measureCtx.font = '100px Arial, Helvetica, sans-serif';
  const total = measureCtx.measureText(str).width || 1;
  const out = [0];
  for (let i = 1; i < n; i++) out.push(measureCtx.measureText(str.slice(0, i)).width / total);
  out.push(1);
  return out;
}

/** Lines of text on a page, each with a way to locate any character range (PDF coordinates). */
export async function pageLines(page) {
  const key = page.src + ':' + page.index + ':' + (page.annots.some((a) => a.type === 'ocrtext') ? 'o' : '');
  if (lineCache.has(key)) return lineCache.get(key);
  let pieces = [];
  const items = await getPageTextItems(state.doc, page);
  for (const it of items) {
    if (!it.str) continue;
    const [a, b, , , e, f] = it.transform;
    const len = Math.hypot(a, b) || 1;
    pieces.push({ str: it.str, x: e, y: f, w: it.width, h: it.height || len, dir: [a / len, b / len], cum: charFractions(it.str, it.mono) });
  }
  // Scanned pages: use the OCR words.
  for (const o of page.annots.filter((a) => a.type === 'ocrtext')) {
    for (const w of o.words) {
      const ang = ((w.angle || 0) * Math.PI) / 180;
      pieces.push({ str: w.text, x: w.x, y: w.y - w.height * 0.2, w: w.width, h: w.height, dir: [Math.cos(ang), Math.sin(ang)], cum: charFractions(w.text) });
    }
  }
  // Group into lines along the text direction.
  pieces = pieces.filter((p) => p.str.trim() || p.str === ' ');
  const lines = [];
  for (const p of pieces) {
    const up = [-p.dir[1], p.dir[0]];
    const level = p.x * up[0] + p.y * up[1];
    // Superscripts like the "nd" in "2nd" sit a little higher, so allow about half a line of difference.
    let line = lines.find((l) => Math.abs(l.level - level) < Math.max(2, Math.max(l.h, p.h) * 0.5) && l.dir[0] === p.dir[0] && l.dir[1] === p.dir[1]);
    if (!line) lines.push((line = { level, dir: p.dir, up, h: p.h, pieces: [] }));
    line.pieces.push(p);
  }
  for (const l of lines) {
    l.pieces.sort((a, b) => a.x * l.dir[0] + a.y * l.dir[1] - (b.x * l.dir[0] + b.y * l.dir[1]));
    let text = '';
    const map = [];
    let lastEnd = null;
    for (const p of l.pieces) {
      const start = p.x * l.dir[0] + p.y * l.dir[1];
      if (text && lastEnd !== null && start - lastEnd > p.h * 0.2 && !text.endsWith(' ') && !p.str.startsWith(' ')) {
        map.push({ p, i: -1 });
        text += ' ';
      }
      for (let i = 0; i < p.str.length; i++) {
        map.push({ p, i });
        text += p.str[i];
      }
      lastEnd = start + p.w;
    }
    l.text = text;
    l.map = map;
  }
  lineCache.set(key, lines);
  return lines;
}

const norm = (s) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/** Find every place `query` appears. Returns [{page, x1,y1,x2,y2 (PDF box), text}] */
export async function findText(query, pageNos = null) {
  const out = [];
  if (!query || !state.doc) return out;
  const q = norm(query.trim());
  const pages = pageNos ? pageNos.map((n) => state.doc.pages[n - 1]).filter(Boolean) : state.doc.pages;
  for (const page of pages) {
    const lines = await pageLines(page);
    for (const l of lines) {
      const t = norm(l.text);
      let at = t.indexOf(q);
      // Labels are often followed by ":" — also accept a match ignoring punctuation/spacing.
      if (at < 0) {
        const loose = t.replace(/[^a-z0-9]/g, '');
        const lq = q.replace(/[^a-z0-9]/g, '');
        if (lq.length >= 3 && loose.includes(lq)) {
          // Map back: find first char sequence matching ignoring non-alphanumerics.
          let k = 0;
          let start = -1;
          for (let i = 0; i < t.length && k < lq.length; i++) {
            if (!/[a-z0-9]/.test(t[i])) continue;
            if (t[i] === lq[k]) {
              if (k === 0) start = i;
              k++;
            } else if (k > 0) {
              k = t[i] === lq[0] ? 1 : 0;
              start = k ? i : -1;
            }
          }
          if (k === lq.length && start >= 0) at = start;
        }
      }
      while (at >= 0) {
        const end = Math.min(l.map.length - 1, at + q.length - 1);
        const box = rangeBox(l, at, end);
        if (box) out.push({ page, ...box, text: l.text.slice(at, end + 1) });
        at = t.indexOf(q, at + Math.max(1, q.length));
      }
    }
  }
  return out;
}

function frac(p, i) {
  const n = Math.max(1, p.str.length);
  return p.cum ? p.cum[Math.min(i, n)] : i / n;
}
function charPos(entry) {
  const p = entry.p;
  const n = Math.max(1, p.str.length);
  const i = entry.i < 0 ? n : entry.i;
  return [p.x + p.dir[0] * p.w * frac(p, i), p.y + p.dir[1] * p.w * frac(p, i)];
}

export function rangeBox(line, a, b) {
  const ea = line.map[a];
  const eb = line.map[b];
  if (!ea || !eb) return null;
  const p0 = charPos(ea);
  const nB = Math.max(1, eb.p.str.length);
  const iB = eb.i < 0 ? nB : eb.i + 1;
  const p1 = [eb.p.x + eb.p.dir[0] * eb.p.w * frac(eb.p, iB), eb.p.y + eb.p.dir[1] * eb.p.w * frac(eb.p, iB)];
  const h = Math.max(ea.p.h, eb.p.h);
  const up = line.up;
  const desc = h * 0.22;
  const pts = [
    [p0[0] - up[0] * desc, p0[1] - up[1] * desc],
    [p1[0] - up[0] * desc, p1[1] - up[1] * desc],
    [p0[0] + up[0] * h, p0[1] + up[1] * h],
    [p1[0] + up[0] * h, p1[1] + up[1] * h],
  ];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys), dir: line.dir, h };
}

export function clearTextCache() {
  lineCache.clear();
}

// ---------------------------------------------------------------------------
// Doing the actions
// ---------------------------------------------------------------------------
function pageAt(n) {
  return state.doc.pages[(n || state.currentPage + 1) - 1];
}

/** Box placed next to a found label, in the label's reading direction. */
function besideBox(hit, position, w, h) {
  const gap = 4;
  const d = hit.dir || [1, 0];
  if (Math.abs(d[0]) < 0.5) {
    // vertical text: keep it simple and put the item to the "right" in reading order
    return { x1: hit.x1, y1: hit.y2 + gap, x2: hit.x1 + h, y2: hit.y2 + gap + w };
  }
  const cy = (hit.y1 + hit.y2) / 2;
  if (position === 'below') return { x1: hit.x1, y1: hit.y1 - gap - h, x2: hit.x1 + w, y2: hit.y1 - gap };
  if (position === 'above') return { x1: hit.x1, y1: hit.y2 + gap, x2: hit.x1 + w, y2: hit.y2 + gap + h };
  if (position === 'left') return { x1: hit.x1 - gap - w, y1: cy - h / 2, x2: hit.x1 - gap, y2: cy + h / 2 };
  return { x1: hit.x2 + gap, y1: cy - h / 2, x2: hit.x2 + gap + w, y2: cy + h / 2 };
}

/** Top-left anchor (PDF space) for a page preset like "top-right", as seen on screen. */
async function presetAnchor(page, where, textW, textH) {
  const src = state.doc.sources.find((s) => s.id === page.src);
  const p = await src.pdf.getPage(page.index + 1);
  const vp = p.getViewport({ scale: 1, rotation: totalRotation(page) });
  const m = 36;
  let vx = (vp.width - textW) / 2;
  let vy = (vp.height - textH) / 2;
  if (/top/.test(where)) vy = m;
  if (/bottom/.test(where)) vy = vp.height - m - textH;
  if (/left/.test(where)) vx = m;
  if (/right/.test(where)) vx = vp.width - m - textW;
  return vp.convertToPdfPoint(vx, vy);
}

function textWidth(text, size, bold) {
  // Rough Helvetica width, good enough for placing things.
  return String(text)
    .split('\n')
    .reduce((w, line) => Math.max(w, line.length * size * (bold ? 0.58 : 0.53)), 0);
}

function fieldMatch(name) {
  const want = norm(String(name)).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  let best = null;
  let bestScore = 0;
  const consider = (label, ref) => {
    const have = norm(label).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    if (!have.length) return;
    let hit = 0;
    for (const w of want) if (have.some((h) => h === w || (w.length > 3 && h.startsWith(w)) || (h.length > 3 && w.startsWith(h)))) hit++;
    const score = hit / want.length - Math.max(0, have.length - hit) * 0.03 + (norm(label) === norm(String(name)) ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = ref;
    }
  };
  state.doc.pages.forEach((p) => p.annots.forEach((a) => a.type === 'field' && consider(a.name, { annot: a, page: p })));
  for (const [src, list] of Object.entries(state.doc.fields || {})) {
    if ((state.doc.prepared || {})[src]) continue;
    for (const f of list) consider(f.name, { legacy: true, src, f });
  }
  if (bestScore >= 0.6) return best;
  return null;
}

/** All fields with where they are: [{rect, pageObj, ref}] */
function allFieldBoxes() {
  const out = [];
  state.doc.pages.forEach((p) =>
    p.annots.forEach((a) => a.type === 'field' && out.push({ page: p, x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, ref: { annot: a, page: p } }))
  );
  for (const [src, list] of Object.entries(state.doc.fields || {})) {
    if ((state.doc.prepared || {})[src]) continue;
    for (const f of list)
      for (const w of f.widgets) {
        const page = state.doc.pages.find((p) => p.src === src && p.index === w.pageIndex);
        if (page) out.push({ page, x1: w.rect[0], y1: w.rect[1], x2: w.rect[2], y2: w.rect[3], ref: { legacy: true, src, f, onValue: w.onValue } });
      }
  }
  return out;
}

/**
 * Find a field by the words printed next to it: "Owner", or "1st stage - Inspected"
 * (row label - column heading), like a person reading the form.
 */
async function fieldByLabel(name) {
  const parts = String(name).split(/\s+[-–:]\s+|\s*,\s*|\s+(?:under|in the|column)\s+/i).map((x) => x.trim()).filter(Boolean);
  const rowHits = await findText(parts[0]);
  if (!rowHits.length) return null;
  const colHits = parts[1] ? await findText(parts[1]) : [];
  const boxes = allFieldBoxes();
  let best = null;
  let bestD = Infinity;
  for (const r of rowHits) {
    const cy = (r.y1 + r.y2) / 2;
    for (const b of boxes) {
      if (b.page !== r.page) continue;
      // Same row as the label (vertically overlapping), to its right.
      const overlap = Math.min(b.y2, r.y2 + 4) - Math.max(b.y1, r.y1 - 4);
      if (overlap <= 0 || b.x1 < r.x1) continue;
      let d = b.x1 - r.x2 + Math.abs((b.y1 + b.y2) / 2 - cy);
      if (colHits.length) {
        const col = colHits.filter((c) => c.page === b.page && c.y1 > b.y2 - 2).sort((a, c) => Math.abs((a.x1 + a.x2) / 2 - (b.x1 + b.x2) / 2) - Math.abs((c.x1 + c.x2) / 2 - (b.x1 + b.x2) / 2))[0];
        if (!col) continue;
        const colOverlap = Math.min(col.x2, b.x2) - Math.max(col.x1, b.x1);
        if (colOverlap <= 0) continue;
        d = Math.abs(col.y1 - b.y2) + Math.abs((col.x1 + col.x2) / 2 - (b.x1 + b.x2) / 2);
      }
      if (d < bestD) {
        bestD = d;
        best = b.ref;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Things you added (text boxes, lines, logos, fields…) — finding, moving, describing
// ---------------------------------------------------------------------------
const ITEM_WORDS = {
  line: ['line'], arrow: ['arrow'], box: ['rect'], rectangle: ['rect'], square: ['rect'], circle: ['ellipse'], oval: ['ellipse'], ellipse: ['ellipse'],
  logo: ['image'], image: ['image'], picture: ['image'], photo: ['image'], signature: ['image'], drawing: ['ink'], scribble: ['ink'],
  note: ['note'], comment: ['note'], highlight: ['highlight'], 'text box': ['text'], textbox: ['text'], text: ['text'], watermark: ['text'], field: ['field'],
};

function itemName(a) {
  if (a.type === 'text') return `text "${String(a.text).slice(0, 30)}"`;
  if (a.type === 'field') return `field "${a.name}"`;
  if (a.type === 'image') return a.logo ? 'logo' : 'picture';
  return { rect: 'box', ellipse: 'circle', ink: 'drawing', note: 'comment' }[a.type] || a.type;
}

/** Box of an item as seen on screen: top-left corner (PDF space), width, height. */
function itemBox(a) {
  if ('x1' in a) {
    const v = boxInView(a.x1, a.y1, a.x2, a.y2, a.rot || 0);
    return { tl: v.tl, w: v.w, h: v.h };
  }
  if (a.type === 'text') {
    const lines = String(a.text || '').split('\n');
    const w = a.w || Math.max(...lines.map((l) => textWidth(l, a.size || 12, a.bold)));
    return { tl: [a.x, a.y], w, h: lines.length * (a.size || 12) * 1.2 };
  }
  const pts = a.pts || (a.rects ? a.rects.flatMap((r) => [[r[0], r[1]], [r[2], r[3]]]) : a.type === 'note' ? [[a.x, a.y - 20], [a.x + 20, a.y]] : null);
  if (!pts) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const v = boxInView(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), a.rot || 0);
  return { tl: v.tl, w: v.w, h: v.h };
}

function shiftAnnot(a, ux, uy) {
  if ('x1' in a) {
    a.x1 += ux;
    a.x2 += ux;
    a.y1 += uy;
    a.y2 += uy;
  }
  if ('x' in a) {
    a.x += ux;
    a.y += uy;
  }
  if (a.pts) a.pts = a.pts.map((p) => [p[0] + ux, p[1] + uy]);
  if (a.rects) a.rects = a.rects.map((r) => [r[0] + ux, r[1] + uy, r[2] + ux, r[3] + uy]);
  if (a.words) a.words = a.words.map((w) => ({ ...w, x: w.x + ux, y: w.y + uy }));
}

/** "the three lines by Comments", "all fields under Notes", "L40, L41 and L42" → what to act on, or null for one thing. */
export function pluralTarget(target) {
  const t = String(target || '').trim().replace(/[.!]+$/, '');
  let m = t.match(/^(?:(?:the\s+)?(?:printed\s+)?lines?\s+)?(L\d+(?:\s*(?:,|and|&|\s)\s*L\d+)+)$/i);
  if (m) return { refs: m[1].match(/L\d+/gi) };
  const KIND = '(?:printed\\s+|blank\\s+|fill-?in\\s+|writing\\s+|empty\\s+|form\\s+)?(?:lines|underlines|blanks|fields|text ?boxes|boxes|spaces|items|things|stuff|everything|all of it)';
  const re = new RegExp(`^(?:(?:all|each|every)\\s+(?:of\\s+)?(?:the\\s+)?|(?:the\\s+)?(?:(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|both)\\s+)?)(${KIND}(?:\\s*(?:,|and|&|plus)\\s*(?:the\\s+|all\\s+(?:the\\s+)?)?${KIND})*)\\s+(by|near|next to|beside|for|at|around|under(?:neath)?|below|beneath|above|over|after|right of|to the right of|with|of|following|belonging to|on)\\s+(?:the\\s+)?(.+)$`, 'i');
  m = t.match(re);
  if (!m) {
    // "the Comments lines and boxes", "the 3 comment lines"
    const re2 = new RegExp(`^(?:the\\s+|all\\s+(?:of\\s+)?(?:the\\s+)?)?(?:(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|both)\\s+)?(.+?)\\s+(${KIND}(?:\\s*(?:,|and|&|plus)\\s*(?:the\\s+)?${KIND})*)$`, 'i');
    const k = t.match(re2);
    if (!k || /^(?:my|these|those|selected|text|form|blank|all|added|new|empty|printed|other|extra)$/i.test(k[2].trim()) || /\b(lines?|fields?|boxes|text)\b/i.test(k[2])) return null;
    const n2 = k[1] ? (/^\d+$/.test(k[1]) ? +k[1] : WORD_NUMS[k[1].toLowerCase()]) : null;
    return { near: k[2].replace(/["“”]/g, '').replace(/'s$/i, '').trim(), what: k[3], count: n2 || null, position: null };
  }
  const n = m[1] ? (/^\d+$/.test(m[1]) ? +m[1] : WORD_NUMS[m[1].toLowerCase()]) : null;
  const rel = m[3].toLowerCase();
  const position = /under|below|beneath/.test(rel) ? 'below' : /above|over/.test(rel) ? 'above' : /right/.test(rel) ? 'right' : null;
  return { near: m[4].replace(/["“”]/g, '').trim(), what: m[2], count: n || null, position };
}

/**
 * Find something to move/resize/delete: "selected", a field name, the words in a text box,
 * "logo", "line", "the 2nd line", or printed words on the page (those are covered and re-typed).
 */
async function findItem(target, pageNo = null) {
  const t = norm(String(target || '').trim()).replace(/^(?:the|my|our|that|this)\s+/, '');
  const pages = pageNo ? [pageAt(pageNo)].filter(Boolean) : state.doc.pages;
  // A printed line by its short name: "line L12" or just "L12".
  const refM = t.match(/^(?:(?:printed|table|form)\s+)?(?:line\s+)?(l\d+)$/);
  if (refM) {
    const { lineByRef, takeOverLine } = await import('./lines.js');
    for (const page of pageNo ? pages : [state.doc.pages[state.currentPage] || state.doc.pages[0], ...state.doc.pages]) {
      if (!page) continue;
      const l = await lineByRef(page, refM[1]);
      if (!l) continue;
      const already = page.annots.find((x) => x.printedLine === l.id);
      if (already) return { page, annot: already };
      if (page.annots.some((x) => x.coverFor === l.id && x.type === 'rect')) return null; // deleted already
      return { page, annot: await takeOverLine(page, l, { record: false }) };
    }
    return null;
  }
  // A line printed in the PDF, found by the words next to it: "the line under Comments".
  const rel = t.match(/^(?:(?:printed|table|form)\s+)?(?:line|border|underline|rule|divider)\s+(under(?:neath)?|below|beneath|above|over|left of|right of|next to|beside|after|before|by|near|for)\s+(?:the\s+)?(.+)$/);
  if (rel) {
    const hits = await findText(rel[2].replace(/^["“']|["”']$/g, ''), pageNo ? [pageNo] : null);
    const position = /above|over/.test(rel[1]) ? 'above' : /left|before/.test(rel[1]) ? 'left' : /right|next|beside|after/.test(rel[1]) ? 'right' : 'below';
    const { printedLineNear, takeOverLine } = await import('./lines.js');
    const gpos = /under|below|beneath/.test(rel[1]) ? 'below' : position === 'above' ? 'above' : /right/.test(rel[1]) ? 'right' : null;
    for (const h of hits) {
      // The writing line that belongs to the label (right of it, or under it); with a line already gone, the next one.
      const g = position === 'left' ? [] : await lineGroupNear(h.page, h, { count: 1, position: gpos });
      const l = g[0] || (await printedLineNear(h.page, h, position));
      if (l) return { page: h.page, annot: await takeOverLine(h.page, l, { record: false }) };
    }
    return null;
  }
  const all = [];
  for (const page of pages) for (const annot of page.annots) if (annot.type !== 'ocrtext' && annot.type !== 'redact') all.push({ page, annot });
  if (!t || /^(selected|selection|it|this|that)( (item|thing|box|field|line|text|one))?$/.test(t)) {
    const sel = state.selectedAnnot && all.find((x) => x.annot.id === state.selectedAnnot.annotId);
    if (sel) return sel;
    if (!t) return null;
  }
  // "logo", "line", "2nd line", "last arrow", "red box"
  const ord = t.match(/^(?:(first|1st|second|2nd|third|3rd|last|top|bottom)\s+)?(?:(red|blue|green|black|yellow|orange|purple)\s+)?(text box|textbox|[a-z]+)$/);
  if (ord && ITEM_WORDS[ord[3]]) {
    const types = ITEM_WORDS[ord[3]];
    let list = all.filter((x) => types.includes(x.annot.type) && (ord[3] !== 'logo' || x.annot.logo || types.includes('image')));
    if (ord[3] === 'logo' && list.some((x) => x.annot.logo)) list = list.filter((x) => x.annot.logo);
    if (ord[2]) list = list.filter((x) => (x.annot.stroke || x.annot.color || '').toLowerCase() === (COLORS[ord[2]] || '').toLowerCase());
    if (list.length) {
      const which = ord[1] || 'last';
      if (/^(first|1st)$/.test(which)) return list[0];
      if (/^(second|2nd)$/.test(which)) return list[1] || null;
      if (/^(third|3rd)$/.test(which)) return list[2] || null;
      return list[list.length - 1];
    }
  }
  // A text box or watermark by its words.
  const textHit = all.filter((x) => x.annot.type === 'text' && norm(String(x.annot.text)).includes(t.replace(/^(?:text|text box|words?)\s+/, '').replace(/^["“']|["”']$/g, '')));
  if (textHit.length) return textHit[textHit.length - 1];
  // A form field by name or label.
  const { unpreparedFieldCount, prepareExistingFields } = await import('./forms.js');
  const fieldName = t.replace(/\s+(field|box|checkbox)$/, '');
  if (unpreparedFieldCount() && fieldMatch(fieldName)) prepareExistingFields();
  const fm = fieldMatch(fieldName) || (await fieldByLabel(fieldName));
  if (fm && fm.annot) return { page: fm.page, annot: fm.annot };
  // Words printed on the page: cover them and put the same words in a movable text box.
  const hits = await findText(t.replace(/^(?:the\s+)?(?:words?|text|label|heading|title)\s+/, ''), pageNo ? [pageNo] : null);
  if (hits.length) {
    const h = hits[0];
    const size = Math.max(5, Math.round(h.h * 10) / 10);
    const annot = { id: uid(), type: 'text', x: h.x1, y: h.y2, rot: 0, size, color: '#000000', font: 'Helvetica', bold: false, text: h.text, ai: true };
    const cover = { id: uid(), type: 'rect', x1: h.x1 - 1, y1: h.y1 - 1, x2: h.x2 + 1, y2: h.y2 + 1, stroke: null, fill: '#ffffff', width: 0, opacity: 1, ai: true };
    return { page: h.page, annot, printed: { cover } };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Groups of things next to a label: "the three lines by Comments", "the fields under Notes".
// ---------------------------------------------------------------------------

/** Text on a page as label-sized chunks (a row like "Technician: ... Comments:" becomes two chunks). */
export async function textChunks(page) {
  const out = [];
  for (const l of await pageLines(page)) {
    let cur = null;
    for (const p of l.pieces) {
      if (!p.str.trim()) continue;
      const along = (x, y) => x * l.dir[0] + y * l.dir[1];
      const start = along(p.x, p.y);
      const end = start + p.w;
      const pts = [[p.x, p.y], [p.x + l.dir[0] * p.w, p.y + l.dir[1] * p.w], [p.x + l.up[0] * p.h, p.y + l.up[1] * p.h], [p.x + l.dir[0] * p.w + l.up[0] * p.h, p.y + l.dir[1] * p.w + l.up[1] * p.h]];
      if (cur && start - cur.end < Math.max(4, p.h * 1.2)) {
        cur.text += (start - cur.end > p.h * 0.2 && !cur.text.endsWith(' ') && !p.str.startsWith(' ') ? ' ' : '') + p.str;
        cur.end = Math.max(cur.end, end);
        cur.pts.push(...pts);
      } else {
        if (cur) out.push(cur);
        cur = { text: p.str, end, pts: [...pts] };
      }
    }
    if (cur) out.push(cur);
  }
  return out.map((c) => {
    const xs = c.pts.map((q) => q[0]);
    const ys = c.pts.map((q) => q[1]);
    return { text: c.text.trim(), x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
  });
}

/**
 * The blank lines that belong to a label: the line just right of (or under) it, plus the lines stacked
 * below that one with no text between them (a "Comments:" label with three lines to write on).
 */
async function lineGroupNear(page, hit, { count = null, position = null } = {}) {
  const { movableLines } = await import('./lines.js');
  const lines = (await movableLines(page)).filter((l) => l.horiz);
  const chunks = await textChunks(page);
  const ly = (l) => l.y1;
  let first = null;
  if (position !== 'below' && position !== 'above') {
    // Same row, to the right of the label.
    let best = Infinity;
    for (const l of lines) {
      if (ly(l) < hit.y1 - 5 || ly(l) > hit.y2 + 2) continue;
      if (l.x2 < hit.x2 - 2 || l.x1 < hit.x1 - 2) continue;
      const d = Math.max(0, l.x1 - hit.x2);
      if (d < 90 && d < best) {
        best = d;
        first = l;
      }
    }
  }
  if (!first && position !== 'right') {
    // Under the label (or above it).
    let best = Infinity;
    for (const l of lines) {
      if (l.x2 < hit.x1 - 10 || l.x1 > hit.x2 + 10) continue;
      const d = position === 'above' ? ly(l) - hit.y2 : hit.y1 - ly(l);
      if (d < -3 || d > 45) continue;
      if (d < best) {
        best = d;
        first = l;
      }
    }
  }
  if (!first) return [];
  const group = [first];
  const dir = position === 'above' ? 1 : -1; // keep going down the page unless "above"
  while (!count || group.length < count) {
    const cur = group[group.length - 1];
    let next = null;
    let best = Infinity;
    for (const l of lines) {
      if (group.includes(l)) continue;
      const gap = (ly(l) - ly(cur)) * dir;
      if (gap < 3 || gap > 48) continue;
      const overlap = Math.min(l.x2, cur.x2) - Math.max(l.x1, cur.x1);
      if (overlap < 0.6 * Math.min(l.x2 - l.x1, cur.x2 - cur.x1)) continue;
      if (gap < best) {
        best = gap;
        next = l;
      }
    }
    if (!next) break;
    // A new label between them (a table row, another question) ends the group.
    const lo = Math.min(ly(next), ly(cur)) + 2;
    const hi = Math.max(ly(next), ly(cur)) - 2;
    const between = chunks.some((c) => c.y1 < hi && c.y2 > lo && c.x2 > Math.max(next.x1, cur.x1) + 2 && c.x1 < Math.min(next.x2, cur.x2) - 2 && !(c.x1 <= hit.x2 && c.x2 >= hit.x1 && c.y1 <= hit.y2 && c.y2 >= hit.y1));
    if (between) break;
    // Fill-in lines are evenly spaced; a much bigger jump is something else.
    if (group.length >= 2) {
      const step = Math.abs(ly(group[1]) - ly(group[0]));
      if (best > step * 1.7 + 4) break;
    }
    group.push(next);
  }
  return group;
}

const WORD_NUMS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, both: 2, a: 1, an: 1, the: null };

/** What kinds of things a phrase means: "lines and text boxes" → {lines, fields, text}. */
function kindsOf(words) {
  const w = String(words || '').toLowerCase();
  const k = { lines: false, fields: false, text: false };
  if (/\b(everything|all|stuff|things|items|all of it)\b/.test(w) && !/\b(lines?|fields?|boxes?|blanks?)\b/.test(w)) return { lines: true, fields: true, text: true };
  if (/\b(lines?|underlines?|rules?|blanks?|borders?)\b/.test(w)) k.lines = true;
  if (/\b(fields?|text ?boxes|text ?box|boxes|box|blanks?|spaces?|inputs?)\b/.test(w)) k.fields = true;
  if (/\b(text ?boxes|text ?box|boxes|box|notes?)\b/.test(w)) k.text = true;
  if (!k.lines && !k.fields && !k.text) return { lines: true, fields: true, text: true };
  return k;
}

/**
 * Everything belonging to a label: its blank lines, its form fields and text boxes on those lines.
 * Returns {page, hit, lines:[printed lines], fields:[{page, annot}], texts:[{page, annot}]} or null.
 */
export async function itemsNear(label, { what = 'all', count = null, position = null, page: pageNo = null } = {}) {
  const kinds = typeof what === 'string' ? kindsOf(what) : { lines: true, fields: true, text: true, ...what };
  const clean = String(label || '').trim().replace(/^["“'](.*)["”']$/, '$1').replace(/^(?:the\s+)?(.+?)(?:\s+(?:label|section|area|box|line|lines|field|fields))?$/i, '$1');
  const hits = await findText(clean, pageNo ? [pageNo] : null);
  if (!hits.length) return null;
  const { unpreparedFieldCount, prepareExistingFields } = await import('./forms.js');
  if (unpreparedFieldCount()) prepareExistingFields();
  // Prefer a hit that is a real label (its chunk starts with the words) and has lines by it.
  let best = null;
  for (const h of hits) {
    const lines = await lineGroupNear(h.page, h, { count, position });
    const chunks = await textChunks(h.page);
    const own = chunks.find((c) => c.x1 <= h.x1 + 1 && c.x2 >= h.x2 - 1 && c.y1 <= h.y2 && c.y2 >= h.y1);
    const isLabel = own && norm(own.text).replace(/[^a-z0-9]/g, '').startsWith(norm(clean).replace(/[^a-z0-9]/g, ''));
    const score = (lines.length ? 10 : 0) + (isLabel ? 5 : 0) - (own ? Math.max(0, own.text.length - clean.length - 2) * 0.05 : 0);
    if (!best || score > best.score) best = { score, h, lines };
  }
  const { h, lines } = best;
  const page = h.page;
  // The area those lines (or the label's row) cover.
  let R;
  if (lines.length) {
    const ys = lines.map((l) => l.y1);
    R = { x1: Math.min(...lines.map((l) => l.x1)) - 6, x2: Math.max(...lines.map((l) => l.x2)) + 6, y1: Math.min(...ys) - 6, y2: Math.max(Math.max(...ys) + 22, h.y2 + 2) };
  } else {
    R = { x1: h.x2 - 2, x2: page.w || 612, y1: h.y1 - 8, y2: h.y2 + 8 };
  }
  const inside = (a) => {
    const cx = ((a.x1 ?? a.x) + (a.x2 ?? a.x)) / 2;
    const cy = ((a.y1 ?? a.y) + (a.y2 ?? a.y)) / 2;
    return cx >= R.x1 && cx <= R.x2 && cy >= R.y1 && cy <= R.y2;
  };
  const base = norm(clean).replace(/[^a-z0-9]/g, '');
  const fields = [];
  const texts = [];
  for (const a of page.annots) {
    if (a.type === 'field' && kinds.fields) {
      const nm = norm(String(a.name || '')).replace(/[^a-z0-9]/g, '');
      const named = base.length >= 3 && new RegExp(`^${base}\\d*$`).test(nm);
      if (inside(a) || (named && !count)) fields.push({ page, annot: a });
    } else if (a.type === 'text' && kinds.text && !a.fixed && inside(a)) texts.push({ page, annot: a });
  }
  return { page, hit: h, lines: kinds.lines ? lines : [], fields, texts, label: clean };
}

/** Printed lines and fields, described so an AI can point at them exactly. */
export async function describeLayout(page, { maxLines = 140 } = {}) {
  const { printedLines } = await import('./lines.js');
  const lines = (await printedLines(page)).filter((l) => !page.annots.some((a) => a.coverFor === l.id && a.type === 'rect'));
  const chunks = await textChunks(page);
  const H = page.h || 792;
  const top = (y) => Math.round(H - y);
  const near = (l, depth = 0) => {
    if (!l.horiz || depth > 6) return '';
    const left = chunks.filter((c) => c.x2 <= l.x1 + 4 && l.x1 - c.x2 < 70 && l.y1 >= c.y1 - 5 && l.y1 <= c.y2 + 2).sort((a, b) => b.x2 - a.x2)[0];
    if (left) return ` right of "${left.text.slice(-40)}"`;
    const above = chunks.filter((c) => c.y1 >= l.y1 - 2 && c.y1 - l.y1 < 16 && c.x2 > l.x1 && c.x1 < l.x2).sort((a, b) => a.y1 - b.y1)[0];
    if (above) return ` under "${above.text.slice(0, 40)}"`;
    const up = lines.filter((o) => o.horiz && o !== l && o.y1 > l.y1 + 3 && o.y1 - l.y1 < 48 && Math.min(o.x2, l.x2) - Math.max(o.x1, l.x1) > 0.6 * Math.min(o.x2 - o.x1, l.x2 - l.x1)).sort((a, b) => a.y1 - b.y1)[0];
    if (up) {
      const lab = near(up, depth + 1).replace(/^ \(next line below \w+,? ?/, ' ').replace(/\)$/, '');
      return ` (next line below ${up.ref}${lab && !lab.includes('(next') ? lab.replace(/^ /, ', ') : ''})`;
    }
    return '';
  };
  const out = [];
  for (const l of lines.slice(0, maxLines)) {
    const len = Math.round(l.horiz ? l.x2 - l.x1 : l.y2 - l.y1);
    out.push(l.horiz ? `${l.ref}: horizontal, x ${Math.round(l.x1)}-${Math.round(l.x2)}, ${top(l.y1)} from top${near(l)}` : `${l.ref}: vertical, x ${Math.round(l.x1)}, ${top(l.y2)}-${top(l.y1)} from top (${len} long)`);
  }
  const fields = allFieldBoxes()
    .filter((b) => b.page === page)
    .map((b) => {
      const name = b.ref.annot ? b.ref.annot.name : b.ref.f.name;
      const kind = b.ref.annot ? b.ref.annot.kind : b.ref.f.kind;
      return `"${name}" (${kind}) x ${Math.round(b.x1)}-${Math.round(b.x2)}, ${top(b.y2)}-${top(b.y1)} from top`;
    });
  return { lines: out, more: Math.max(0, lines.length - maxLines), fields };
}

/** Short list of the items on the pages, so an AI can refer to them. */
export function describeItems(max = 60) {
  const out = [];
  state.doc.pages.forEach((p, i) =>
    p.annots.forEach((a) => {
      if (a.type === 'ocrtext' || a.type === 'field' || out.length >= max) return;
      out.push(`${itemName(a)} (page ${i + 1})`);
    })
  );
  return out;
}

const FIELD_SIZE = { text: [150, 18], checkbox: [12, 12], radio: [12, 12], date: [90, 18], signature: [170, 30], dropdown: [120, 18] };

/**
 * Do a list of actions. All of it is one Undo step.
 * Returns [{ok, msg, page}] — a plain-English line for each action.
 */
export async function runActions(actions, { onNeedSignature, onNeedLogo, onNeedImage } = {}) {
  const report = [];
  const ok = (msg, page) => report.push({ ok: true, msg, page });
  const fail = (msg) => report.push({ ok: false, msg });
  const creates = actions.filter((a) => a && a.action === 'create_document');
  if (creates.length) {
    try {
      const { createDocument } = await import('./newdocui.js');
      const plan = creates[0].plan || creates[0];
      const res = await createDocument(plan, { onNeedLogo });
      ok(`Made "${plan.title || 'Form'}": ${res.pages} page${res.pages === 1 ? '' : 's'} with ${res.fields} fillable fields. Click any field to type in it, or use Forms › Edit fields to change them.`, state.doc && state.doc.pages[0]);
    } catch (e) {
      console.error(e);
      fail('Could not make the document: ' + e.message);
    }
    actions = actions.filter((a) => !creates.includes(a));
    if (!actions.length) return report;
  }
  if (!state.doc) return [{ ok: false, msg: 'Open a document first.' }];
  checkpoint();
  let structure = false;
  const deferred = [];
  actions = [...actions];
  for (let ai = 0; ai < actions.length; ai++) {
    const raw = actions[ai];
    const a = { ...raw };
    try {
      switch (a.action) {
        case 'delete_pages': {
          const ids = (a.pages || []).map((n) => state.doc.pages[n - 1]).filter(Boolean).map((p) => p.id);
          if (!ids.length) {
            fail(`There is no page ${a.pages.join(', ')}.`);
            break;
          }
          if (ids.length >= state.doc.pages.length) {
            fail('A PDF needs at least one page.');
            break;
          }
          state.doc.pages = state.doc.pages.filter((p) => !ids.includes(p.id));
          structure = true;
          ok(`Deleted page${ids.length > 1 ? 's' : ''} ${a.pages.join(', ')}.`);
          break;
        }
        case 'delete_blank_pages': {
          const blank = [];
          for (const p of state.doc.pages) {
            const lines = await pageLines(p);
            if (!lines.some((l) => l.text.trim()) && !p.annots.length) blank.push(p.id);
          }
          if (!blank.length || blank.length >= state.doc.pages.length) {
            fail('No blank pages found (pages with pictures but no text are kept).');
            break;
          }
          state.doc.pages = state.doc.pages.filter((p) => !blank.includes(p.id));
          structure = true;
          ok(`Deleted ${blank.length} blank page${blank.length > 1 ? 's' : ''}.`);
          break;
        }
        case 'rotate_pages': {
          const pages = (a.pages || [state.currentPage + 1]).map((n) => state.doc.pages[n - 1]).filter(Boolean);
          pages.forEach((p) => (p.rotate = (((p.rotate + (a.degrees || 90)) % 360) + 360) % 360));
          structure = true;
          ok(`Rotated page${pages.length > 1 ? 's' : ''} ${a.pages.join(', ')} ${a.degrees === -90 ? 'left' : a.degrees === 180 ? 'upside down' : 'right'}.`);
          break;
        }
        case 'move_page': {
          const from = state.doc.pages[a.from - 1];
          if (!from) {
            fail(`There is no page ${a.from}.`);
            break;
          }
          state.doc.pages.splice(a.from - 1, 1);
          state.doc.pages.splice(Math.max(0, Math.min(state.doc.pages.length, a.to - 1)), 0, from);
          structure = true;
          ok(`Moved page ${a.from} to position ${a.to}.`);
          break;
        }
        case 'insert_blank_page': {
          const ref = state.doc.pages[Math.max(0, (a.after || 1) - 1)] || state.doc.pages[0];
          const d = await window.PDFLib.PDFDocument.create();
          d.addPage([ref.w, ref.h]);
          const src = await loadSource(await d.save(), 'blank page');
          state.doc.sources.push(src);
          const [pg] = await pagesForSource(src);
          state.doc.pages.splice(Math.max(0, a.after ?? state.doc.pages.length), 0, pg);
          structure = true;
          ok(a.after === 0 ? 'Added a blank page at the start.' : `Added a blank page after page ${a.after}.`);
          break;
        }
        case 'duplicate_page': {
          const p = state.doc.pages[a.page - 1];
          if (!p) {
            fail(`There is no page ${a.page}.`);
            break;
          }
          const copy = JSON.parse(JSON.stringify(p));
          copy.id = uid();
          copy.annots.forEach((x) => (x.id = uid()));
          state.doc.pages.splice(a.page, 0, copy);
          structure = true;
          ok(`Duplicated page ${a.page}.`);
          break;
        }
        case 'add_text': {
          const text = /^today$/i.test(a.text) ? today() : String(a.text);
          const size = a.size || 12;
          const targets = a.allPages || a.page === null ? state.doc.pages : [pageAt(a.page)];
          let placed = 0;
          if (a.near) {
            const hits = await findText(a.near, a.page ? [a.page] : null);
            if (!hits.length) {
              fail(`Couldn't find "${a.near}" to put the text next to.`);
              break;
            }
            for (const hit of a.every ? hits : [hits[0]]) {
              const w = textWidth(text, size, a.bold);
              const box = besideBox(hit, a.position || 'right', w, size * 1.2);
              hit.page.annots.push({ id: uid(), type: 'text', x: box.x1, y: box.y2, rot: 0, size, color: a.color || '#000000', font: 'Helvetica', bold: !!a.bold, text, ai: true });
              placed++;
            }
            ok(`Added "${text}" ${a.position === 'below' ? 'below' : a.position === 'above' ? 'above' : a.position === 'left' ? 'before' : 'next to'} "${a.near}"${placed > 1 ? ` (${placed} places)` : ''}.`, hits[0].page);
            break;
          }
          for (const page of targets) {
            if (!page) continue;
            const w = textWidth(text, size, a.bold);
            const [x, y] = await presetAnchor(page, a.where || 'top', w, size * 1.2);
            page.annots.push({ id: uid(), type: 'text', x, y, rot: totalRotation(page), size, color: a.color || '#000000', font: 'Helvetica', bold: !!a.bold, text, ai: true });
            placed++;
          }
          ok(`Added "${text}" at the ${(a.where || 'top').replace('-', ' ')}${placed > 1 ? ` of ${placed} pages` : ` of page ${state.doc.pages.indexOf(targets[0]) + 1}`}.`, targets[0]);
          break;
        }
        case 'replace_text':
        case 'remove_text': {
          const hits = await findText(a.find, a.page ? [a.page] : null);
          if (!hits.length) {
            fail(`Couldn't find "${a.find}".`);
            break;
          }
          for (const hit of hits) {
            const pad = 1;
            if (a.action === 'remove_text') {
              hit.page.annots.push({ id: uid(), type: 'rect', x1: hit.x1 - pad, y1: hit.y1 - pad, x2: hit.x2 + pad, y2: hit.y2 + pad, stroke: null, fill: '#ffffff', width: 0, opacity: 1, ai: true });
            } else {
              const size = Math.max(5, Math.round(hit.h * 10) / 10);
              hit.page.annots.push({
                id: uid(),
                type: 'text',
                x: hit.x1,
                y: hit.y2,
                rot: 0,
                size,
                color: '#000000',
                font: 'Helvetica',
                bold: false,
                text: /^today$/i.test(a.replace) ? today() : String(a.replace),
                bg: '#ffffff',
                minW: hit.x2 - hit.x1 + 2,
                ai: true,
              });
            }
          }
          ok(`${a.action === 'remove_text' ? 'Whited out' : `Replaced with "${a.replace}":`} "${a.find}"${hits.length > 1 ? ` (${hits.length} places)` : ''}.`, hits[0].page);
          break;
        }
        case 'highlight':
        case 'underline':
        case 'strike':
        case 'circle': {
          const hits = await findText(a.find, a.page ? [a.page] : null);
          if (!hits.length) {
            fail(`Couldn't find "${a.find}".`);
            break;
          }
          for (const hit of hits) {
            if (a.action === 'circle') {
              const p = 4;
              hit.page.annots.push({ id: uid(), type: 'ellipse', x1: hit.x1 - p * 2, y1: hit.y1 - p, x2: hit.x2 + p * 2, y2: hit.y2 + p, stroke: a.color || '#d93025', fill: null, width: 2, opacity: 1, ai: true });
            } else {
              hit.page.annots.push({
                id: uid(),
                type: a.action,
                rects: [[hit.x1, hit.y1, hit.x2, hit.y2]],
                rot: 0,
                color: a.color || (a.action === 'highlight' ? '#ffd54f' : a.action === 'underline' ? '#1a73e8' : '#d93025'),
                text: hit.text,
                ai: true,
              });
            }
          }
          const verb = { highlight: 'Highlighted', underline: 'Underlined', strike: 'Struck out', circle: 'Circled' }[a.action];
          ok(`${verb} "${a.find}"${hits.length > 1 ? ` (${hits.length} places)` : ''}.`, hits[0].page);
          break;
        }
        case 'add_field': {
          const kind = FIELD_SIZE[a.kind] ? a.kind : 'text';
          const hits = a.near ? await findText(a.near, a.page ? [a.page] : null) : [];
          if (!hits.length) {
            fail(`Couldn't find "${a.near}" to put the ${kind === 'checkbox' ? 'checkbox' : 'field'} next to.`);
            break;
          }
          deferred.push(async () => {
            const { suggestName, uniqueName, prepareExistingFields, unpreparedFieldCount } = await import('./forms.js');
            if (unpreparedFieldCount()) prepareExistingFields();
            const [w, h] = FIELD_SIZE[kind];
            const list = a.every ? hits : [hits[0]];
            for (const hit of list) {
              const box = besideBox(hit, a.position || (kind === 'checkbox' ? 'left' : 'right'), w, h);
              const name = a.name && list.length === 1 ? a.name : uniqueName(await suggestName(hit.page, box, kind));
              hit.page.annots.push({
                id: uid(), type: 'field', kind, name, ...box,
                value: kind === 'checkbox' ? false : '', options: kind === 'dropdown' ? ['Option 1', 'Option 2'] : [],
                multiline: false, required: false, border: kind !== 'text' && kind !== 'date', rot: totalRotation(hit.page), ai: true,
              });
            }
            ok(`Added ${list.length > 1 ? list.length + ' ' : 'a '}${kind === 'checkbox' ? 'checkbox' : kind + ' field'}${list.length > 1 ? 'es' : ''} next to "${a.near}".`, hits[0].page);
          });
          break;
        }
        case 'fill_field': {
          const target = fieldMatch(a.field) || (await fieldByLabel(a.field));
          if (!target) {
            if (a.fallbackText && typeof a.value === 'string') {
              const hits = await findText(a.field);
              if (hits.length) {
                const hit = hits[0];
                const box = besideBox(hit, 'right', textWidth(a.value, 11), 13);
                hit.page.annots.push({ id: uid(), type: 'text', x: box.x1, y: box.y2, rot: 0, size: 11, color: '#000000', font: 'Helvetica', bold: false, text: a.value, ai: true });
                ok(`Typed "${a.value}" next to "${a.field}" (there's no fillable box there).`, hit.page);
                break;
              }
            }
            fail(`No form field matching "${a.field}".`);
            break;
          }
          const v = a.value;
          if (target.legacy) {
            state.doc.formValues[target.src] = state.doc.formValues[target.src] || {};
            state.doc.formValues[target.src][target.f.name] = target.f.kind === 'checkbox' ? !!v : String(v);
            ok(typeof v === 'boolean' ? `${v ? 'Checked' : 'Unchecked'} "${a.field}".` : `Filled "${a.field}" with "${v}".`);
          } else {
            const f = target.annot;
            if (f.kind === 'checkbox') f.value = v === true || /^(yes|true|x|✔|checked)$/i.test(String(v));
            else if (f.kind === 'radio') state.doc.pages.forEach((p) => p.annots.forEach((b) => b.type === 'field' && b.kind === 'radio' && b.name === f.name && (b.value = b === f)));
            else f.value = String(v);
            ok(typeof v === 'boolean' ? `${v ? 'Checked' : 'Unchecked'} "${a.field}".` : `Filled "${a.field}" with "${v}".`, target.page);
          }
          emit('forms');
          break;
        }
        case 'add_note': {
          let page = pageAt(a.page);
          let x;
          let y;
          if (a.near) {
            const hits = await findText(a.near, a.page ? [a.page] : null);
            if (hits.length) {
              page = hits[0].page;
              x = hits[0].x2 + 4;
              y = hits[0].y2 + 4;
            }
          }
          if (x === undefined) [x, y] = await presetAnchor(page, 'top-right', 24, 24);
          page.annots.push({ id: uid(), type: 'note', x, y, text: a.text || '', color: '#fbbc04', author: 'Me', date: new Date().toISOString(), ai: true });
          ok(`Added a comment${a.near ? ` next to "${a.near}"` : ''}: "${a.text}".`, page);
          break;
        }
        case 'sign': {
          deferred.push(async () => {
            const forms = await import('./forms.js');
            let sig = forms.savedSignature();
            if (!sig && onNeedSignature) sig = await onNeedSignature();
            if (!sig) {
              fail('No signature yet. Use Insert › Signature once, then ask again.');
              return;
            }
            // A signature field first, otherwise next to the "Signature" label.
            const field = state.doc.pages.flatMap((p) => p.annots.filter((x) => x.type === 'field' && x.kind === 'signature').map((x) => ({ p, x })))[0];
            if (field && !field.x.sig) {
              field.x.sig = sig;
              ok('Signed the signature field.', field.p);
              emit('forms');
              return;
            }
            const hits = await findText(a.near || 'Signature', a.page ? [a.page] : null);
            const img = new Image();
            img.src = sig;
            await img.decode().catch(() => {});
            const h = 28;
            const w = (h * (img.naturalWidth || 3)) / (img.naturalHeight || 1);
            let page;
            let box;
            if (hits.length) {
              page = hits[0].page;
              box = besideBox(hits[0], 'right', w, h);
              box.y1 += h * 0.3;
              box.y2 += h * 0.3;
            } else {
              page = pageAt(a.page || state.doc.pages.length);
              const [x, y] = await presetAnchor(page, 'bottom-right', w, h);
              box = { x1: x, y1: y - h, x2: x + w, y2: y };
            }
            page.annots.push({ id: uid(), type: 'image', ...box, rot: 0, dataUrl: sig, ai: true });
            ok(hits.length ? `Signed next to "${a.near || 'Signature'}".` : 'Signed at the bottom of the last page (no "Signature" label found).', page);
          });
          break;
        }
        case 'page_numbers': {
          const n = state.doc.pages.length;
          for (let i = 0; i < n; i++) {
            const page = state.doc.pages[i];
            const text = `Page ${i + 1} of ${n}`;
            const [x, y] = await presetAnchor(page, a.where === 'top' ? 'top' : a.where || 'bottom', textWidth(text, 9), 11);
            page.annots.push({ id: uid(), type: 'text', x, y, rot: totalRotation(page), size: 9, color: '#5f6368', font: 'Helvetica', bold: false, text, ai: true });
          }
          ok(`Added page numbers to ${n} page${n > 1 ? 's' : ''}.`);
          break;
        }
        case 'watermark': {
          const text = String(a.text || 'DRAFT').toUpperCase();
          for (const page of state.doc.pages) {
            const size = Math.min(110, (Math.min(page.w, page.h) * 1.4) / Math.max(3, text.length));
            const [x, y] = await presetAnchor(page, 'center', textWidth(text, size, true), size * 1.2);
            page.annots.push({ id: uid(), type: 'text', x, y, rot: totalRotation(page), size, color: '#d93025', opacity: 0.18, font: 'Helvetica', bold: true, text, ai: true });
          }
          ok(`Added a "${text}" watermark to every page.`);
          break;
        }
        case 'clear': {
          const types = {
            highlights: ['highlight', 'underline', 'strike'],
            comments: ['note'],
            drawings: ['ink', 'rect', 'ellipse', 'line', 'arrow'],
            text: ['text'],
            fields: ['field'],
            all: ['highlight', 'underline', 'strike', 'note', 'ink', 'rect', 'ellipse', 'line', 'arrow', 'text', 'image'],
          }[a.what || 'all'];
          let n = 0;
          for (const page of a.page ? [pageAt(a.page)] : state.doc.pages) {
            const before = page.annots.length;
            page.annots = page.annots.filter((x) => !types.includes(x.type));
            n += before - page.annots.length;
          }
          n ? ok(`Removed ${n} item${n > 1 ? 's' : ''} (${a.what || 'all'}).`) : fail(`There were no ${a.what || 'added items'} to remove.`);
          break;
        }
        case 'detect_fields':
          deferred.push(async () => {
            const { detectFields } = await import('./forms.js');
            const n = await detectFields();
            ok(`Found ${n} places to fill in and made them fillable.`);
          });
          break;
        case 'name_fields':
          deferred.push(async () => {
            const { autoNameAll } = await import('./forms.js');
            const n = await autoNameAll();
            ok(`Renamed ${n} fields from their labels.`);
          });
          break;
        case 'ocr':
          deferred.push(async () => {
            const { ocrPages } = await import('./ocr.js');
            const r = await ocrPages(state.doc.pages, { straighten: true });
            ok(`Read the text on ${r.textFound} page${r.textFound === 1 ? '' : 's'}.`);
          });
          break;
        case 'add_text_box': {
          const text = /^today$/i.test(a.text) ? today() : String(a.text || 'Text');
          const size = a.size || 11;
          const font = 'Helvetica';
          const w = a.width || Math.min(260, Math.max(80, textWidth(text, size, a.bold) + 8));
          const lines = Math.max(1, Math.ceil(textWidth(text, size, a.bold) / Math.max(20, w - 8)) + (String(text).match(/\n/g) || []).length);
          const h = lines * size * 1.2 + 2;
          let page = pageAt(a.page);
          let x;
          let y;
          if (a.near) {
            const hits = await findText(a.near, a.page ? [a.page] : null);
            if (!hits.length) {
              fail(`Couldn't find "${a.near}" to put the text box next to.`);
              break;
            }
            const box = besideBox(hits[0], a.position || 'right', w, h);
            page = hits[0].page;
            x = box.x1;
            y = box.y2;
          } else {
            [x, y] = await presetAnchor(page, a.where || 'top-right', w, h);
          }
          page.annots.push({ id: uid(), type: 'text', x, y, w, rot: totalRotation(page), size, color: a.color || '#000000', font, bold: !!a.bold, text, bg: a.bg || null, border: a.border || '#1a73e8', borderWidth: 1, ai: true });
          ok(`Added a text box "${text.slice(0, 40)}".`, page);
          break;
        }
        case 'add_line': {
          const page = pageAt(a.page);
          const rot = totalRotation(page);
          const R = rightVec(rot);
          const D = downVec(rot);
          let start;
          let len;
          if (a.near) {
            const hits = await findText(a.near, a.page ? [a.page] : null);
            if (!hits.length) {
              fail(`Couldn't find "${a.near}" to draw the line by.`);
              break;
            }
            const hit = hits[0];
            const v = boxInView(hit.x1, hit.y1, hit.x2, hit.y2, totalRotation(hit.page));
            const gap = a.position === 'above' ? -4 : v.h + 4;
            start = [v.tl[0] + D[0] * gap, v.tl[1] + D[1] * gap];
            len = a.length === 'full' ? null : Number(a.length) || v.w;
            if (len === null) {
              const [lx, ly] = await presetAnchor(hit.page, 'top-left', 0, 0);
              // keep the same height, start at the left margin
              const along = (start[0] - lx) * R[0] + (start[1] - ly) * R[1];
              start = [start[0] - R[0] * along, start[1] - R[1] * along];
              const [rx, ry] = await presetAnchor(hit.page, 'top-right', 0, 0);
              len = Math.abs((rx - lx) * R[0] + (ry - ly) * R[1]);
            }
            hit.page.annots.push({ id: uid(), type: 'line', pts: [start, [start[0] + R[0] * len, start[1] + R[1] * len]], stroke: a.color || '#000000', width: a.width || 1.2, ai: true });
            ok(`Drew a line ${a.position === 'above' ? 'above' : 'under'} "${a.near}".`, hit.page);
            break;
          }
          const [lx, ly] = await presetAnchor(page, (a.where || 'center').replace(/-(left|right|center)$/, '') + '-left', 0, 0);
          const [rx, ry] = await presetAnchor(page, (a.where || 'center').replace(/-(left|right|center)$/, '') + '-right', 0, 0);
          const full = Math.abs((rx - lx) * R[0] + (ry - ly) * R[1]);
          len = Number(a.length) || full;
          const off = (full - len) / 2;
          start = [lx + R[0] * off, ly + R[1] * off];
          page.annots.push({ id: uid(), type: 'line', pts: [start, [start[0] + R[0] * len, start[1] + R[1] * len]], stroke: a.color || '#000000', width: a.width || 1.2, ai: true });
          ok(`Drew a line across the ${(a.where || 'middle').replace('-', ' ')} of page ${state.doc.pages.indexOf(page) + 1}.`, page);
          break;
        }
        case 'add_logo':
        case 'add_image': {
          const getter = a.action === 'add_logo' ? onNeedLogo : onNeedImage;
          deferred.push(async () => {
            const img = getter ? await getter() : null;
            if (!img) return fail(a.action === 'add_logo' ? 'No logo was chosen.' : 'No picture was chosen.');
            const pages = a.allPages ? state.doc.pages : [pageAt(a.page)];
            for (const page of pages) {
              const rot = totalRotation(page);
              const w = a.width || (a.action === 'add_logo' ? 110 : 160);
              const h = (w * img.height) / img.width;
              const [x, y] = await presetAnchor(page, a.where || 'top-left', w, h);
              const R = rightVec(rot);
              const D = downVec(rot);
              const c2 = [x + R[0] * w + D[0] * h, y + R[1] * w + D[1] * h];
              page.annots.push({ id: uid(), type: 'image', x1: Math.min(x, c2[0]), y1: Math.min(y, c2[1]), x2: Math.max(x, c2[0]), y2: Math.max(y, c2[1]), rot, dataUrl: img.dataUrl, logo: a.action === 'add_logo', ai: true });
            }
            ok(`Added ${a.action === 'add_logo' ? 'your logo' : 'the picture'} at the ${(a.where || 'top-left').replace('-', ' ')}${pages.length > 1 ? ' of every page' : ''}.`, pages[0]);
            changed();
          });
          break;
        }
        case 'delete_near':
        case 'move_near':
        case 'style_near': {
          const verb = a.action.split('_')[0];
          const g = await itemsNear(a.near || a.label || a.target, { what: a.what || 'all', count: a.count ? Number(a.count) : null, position: a.position || null, page: a.page });
          if (!g) {
            fail(`Couldn't find "${a.near || a.label || a.target}" on the page.`);
            break;
          }
          const total = g.lines.length + g.fields.length + g.texts.length;
          if (!total) {
            fail(`Found "${g.label}", but no lines or fields next to it to ${verb}.`);
            break;
          }
          const { takeOverLine } = await import('./lines.js');
          const lineAnnots = [];
          for (const l of g.lines) lineAnnots.push(await takeOverLine(g.page, l, { record: false }));
          const items = [...lineAnnots, ...g.fields.map((x) => x.annot), ...g.texts.map((x) => x.annot)];
          if (verb === 'delete') g.page.annots = g.page.annots.filter((x) => !items.includes(x));
          else if (verb === 'move') {
            const rot = totalRotation(g.page);
            const R = rightVec(rot);
            const D = downVec(rot);
            const dx = Number(a.dx) || 0;
            const dy = Number(a.dy) || 0;
            for (const it of items) shiftAnnot(it, R[0] * dx + D[0] * dy, R[1] * dx + D[1] * dy);
          } else {
            for (const it of lineAnnots) {
              if (a.color) it.stroke = a.color;
              if (a.width) it.width = Number(a.width);
            }
          }
          const parts = [];
          if (g.lines.length) parts.push(`${g.lines.length} line${g.lines.length > 1 ? 's' : ''}`);
          if (g.fields.length) parts.push(`${g.fields.length} field${g.fields.length > 1 ? 's' : ''} (${g.fields.map((x) => '"' + x.annot.name + '"').join(', ')})`);
          if (g.texts.length) parts.push(`${g.texts.length} text box${g.texts.length > 1 ? 'es' : ''}`);
          const what = parts.join(' and ');
          ok(verb === 'delete' ? `Removed ${what} by "${g.hit.text}".` : verb === 'move' ? `Moved ${what} by "${g.hit.text}".` : `Changed ${what} by "${g.hit.text}".`, g.page);
          if (a.count && g.lines.length && g.lines.length < a.count) fail(`Only found ${g.lines.length} line${g.lines.length > 1 ? 's' : ''} by "${g.hit.text}", not ${a.count}.`);
          emit('forms');
          break;
        }
        case 'move_item':
        case 'resize_item':
        case 'delete_item':
        case 'style_item': {
          // Several things at once ("the 3 lines by Comments", "L40, L41 and L42") → one action for each.
          const many = pluralTarget(a.target);
          if (many && a.action !== 'resize_item') {
            if (many.refs) {
              actions.splice(ai + 1, 0, ...many.refs.map((r) => ({ ...raw, target: 'line ' + r })));
              break;
            }
            actions.splice(ai + 1, 0, { ...raw, action: a.action.replace('_item', '_near'), near: many.near, what: many.what, count: many.count, position: many.position, target: undefined });
            break;
          }
          const found = await findItem(a.target, a.page);
          if (!found) {
            fail(`Couldn't find "${a.target}" to ${a.action.split('_')[0]}. Click it first and say "selected", or use the words in it.`);
            break;
          }
          const { page, annot, printed } = found;
          if (printed) {
            // Words printed on the page: cover them, and (unless deleting) put them back as a text box we can change.
            page.annots.push(printed.cover);
            if (a.action !== 'delete_item') page.annots.push(annot);
            else {
              ok(`Covered "${annot.text}".`, page);
              break;
            }
          }
          if (a.action === 'delete_item') {
            page.annots = page.annots.filter((x) => x !== annot);
            ok(`Removed the ${itemName(annot)}.`, page);
            break;
          }
          if (a.action === 'style_item') {
            if (a.color) {
              if ('stroke' in annot && annot.type !== 'text') annot.stroke = a.color;
              else annot.color = a.color;
            }
            if (a.size && annot.type === 'text') annot.size = a.size;
            if (a.bold !== undefined && annot.type === 'text') annot.bold = !!a.bold;
            if (a.bg !== undefined && annot.type === 'text') annot.bg = a.bg;
            if (a.border !== undefined && annot.type === 'text') annot.border = a.border;
            if (a.width && annot.type !== 'text' && annot.type !== 'image') annot.width = a.width;
            ok(`Changed the ${itemName(annot)}.`, page);
            break;
          }
          const rot = totalRotation(page);
          const R = rightVec(rot);
          const D = downVec(rot);
          if (a.action === 'resize_item') {
            const b = itemBox(annot);
            if (annot.type === 'text') {
              const sc = a.scale || (a.width && b ? a.width / Math.max(1, b.w) : 1.25);
              annot.size = Math.max(4, Math.round((annot.size || 12) * sc * 10) / 10);
              if (annot.w) annot.w *= a.widthScale || sc;
              ok(`Resized the ${itemName(annot)} to ${annot.size} pt.`, page);
              break;
            }
            if (!b || !('x1' in annot)) {
              fail(`The ${itemName(annot)} can't be resized that way.`);
              break;
            }
            let nw = a.width || b.w * (a.widthScale || a.scale || 1);
            let nh = a.height || b.h * (a.heightScale || a.scale || 1);
            if (annot.type === 'image' && a.width && !a.height) nh = (b.h * nw) / b.w;
            if (annot.type === 'image' && a.height && !a.width) nw = (b.w * nh) / b.h;
            const tl = b.tl;
            const c2 = [tl[0] + R[0] * nw + D[0] * nh, tl[1] + R[1] * nw + D[1] * nh];
            Object.assign(annot, { x1: Math.min(tl[0], c2[0]), y1: Math.min(tl[1], c2[1]), x2: Math.max(tl[0], c2[0]), y2: Math.max(tl[1], c2[1]) });
            ok(`Resized the ${itemName(annot)}.`, page);
            break;
          }
          // move
          let target = page;
          let dx = 0;
          let dy = 0;
          const b = itemBox(annot);
          if (a.where && b) {
            const [x, y] = await presetAnchor(page, a.where, b.w, b.h);
            dx = (x - b.tl[0]) * R[0] + (y - b.tl[1]) * R[1];
            dy = (x - b.tl[0]) * D[0] + (y - b.tl[1]) * D[1];
          } else if (a.near && b) {
            const hits = await findText(a.near);
            if (!hits.length) {
              fail(`Couldn't find "${a.near}" to move it next to.`);
              break;
            }
            const nb = besideBox(hits[0], a.position || 'right', b.w, b.h);
            const v = boxInView(nb.x1, nb.y1, nb.x2, nb.y2, rot);
            target = hits[0].page;
            dx = (v.tl[0] - b.tl[0]) * R[0] + (v.tl[1] - b.tl[1]) * R[1];
            dy = (v.tl[0] - b.tl[0]) * D[0] + (v.tl[1] - b.tl[1]) * D[1];
          } else {
            dx = Number(a.dx) || 0;
            dy = Number(a.dy) || 0;
          }
          if (!dx && !dy && target === page) {
            fail('Say how far or where to move it, e.g. "move the logo up 1 inch" or "move Total to the top right".');
            break;
          }
          shiftAnnot(annot, R[0] * dx + D[0] * dy, R[1] * dx + D[1] * dy);
          if (target !== page) {
            page.annots = page.annots.filter((x) => x !== annot);
            target.annots.push(annot);
          }
          ok(`Moved the ${itemName(annot)}${a.where ? ' to the ' + a.where.replace('-', ' ') : a.near ? ' next to "' + a.near + '"' : ''}.`, target);
          break;
        }
        case 'edit_field': {
          const { unpreparedFieldCount, prepareExistingFields, uniqueName } = await import('./forms.js');
          if (unpreparedFieldCount()) prepareExistingFields();
          const t = fieldMatch(a.field) || (await fieldByLabel(a.field));
          if (!t || !t.annot) {
            fail(`No form field matching "${a.field}".`);
            break;
          }
          const f = t.annot;
          const page = t.page;
          if (a.delete) {
            page.annots = page.annots.filter((x) => x !== f);
            ok(`Deleted the "${f.name}" field.`, page);
            break;
          }
          const changes = [];
          if (a.rename) {
            f.name = uniqueName(String(a.rename), f.id);
            changes.push(`renamed to "${f.name}"`);
          }
          if (a.kind && a.kind !== f.kind) {
            const kind = ['text', 'checkbox', 'date', 'signature', 'dropdown', 'radio'].includes(a.kind) ? a.kind : 'text';
            f.kind = kind;
            f.value = kind === 'checkbox' || kind === 'radio' ? false : '';
            f.border = kind === 'checkbox' || kind === 'radio' || kind === 'signature';
            if (kind === 'checkbox') {
              const cx = (f.x1 + f.x2) / 2;
              const cy = (f.y1 + f.y2) / 2;
              Object.assign(f, { x1: cx - 6, x2: cx + 6, y1: cy - 6, y2: cy + 6 });
            }
            if (kind === 'dropdown' && !(f.options || []).length) f.options = ['Option 1', 'Option 2'];
            changes.push(`now a ${kind} field`);
          }
          if (typeof a.required === 'boolean') {
            f.required = a.required;
            changes.push(a.required ? 'required' : 'optional');
          }
          if (Array.isArray(a.options) && a.options.length) {
            f.options = a.options.map(String);
            if (f.kind !== 'dropdown' && f.kind !== 'radio') f.kind = 'dropdown';
            changes.push(`choices: ${f.options.join(', ')}`);
          }
          if (typeof a.multiline === 'boolean') {
            f.multiline = a.multiline;
            if (a.multiline && Math.abs(f.y2 - f.y1) < 30) f.y1 = f.y2 - 44;
            changes.push(a.multiline ? 'several lines' : 'one line');
          }
          if (a.width || a.height) {
            const rot = totalRotation(page);
            const v = boxInView(f.x1, f.y1, f.x2, f.y2, rot);
            const R = rightVec(rot);
            const D = downVec(rot);
            const nw = a.width || v.w;
            const nh = a.height || v.h;
            const c2 = [v.tl[0] + R[0] * nw + D[0] * nh, v.tl[1] + R[1] * nw + D[1] * nh];
            Object.assign(f, { x1: Math.min(v.tl[0], c2[0]), y1: Math.min(v.tl[1], c2[1]), x2: Math.max(v.tl[0], c2[0]), y2: Math.max(v.tl[1], c2[1]) });
            changes.push('resized');
          }
          changes.length ? ok(`Field "${f.name}": ${changes.join(', ')}.`, page) : fail(`Nothing to change on "${f.name}".`);
          emit('forms');
          break;
        }
        case 'restore':
          deferred.push(async () => {
            const { restorePages } = await import('./restore.js');
            const { busy } = await import('./util.js');
            const pages = (a.pages || []).length ? a.pages.map((n) => state.doc.pages[n - 1]).filter(Boolean) : state.doc.pages.slice();
            const mode = ['clean', 'crisp', 'color', 'retype'].includes(a.mode) ? a.mode : 'clean';
            busy('Restoring…');
            try {
              const res = await restorePages(pages, { mode, upright: true, crop: true, searchable: true, markUnsure: true, font: 'times' });
              ok(`Restored ${res.length} page${res.length === 1 ? '' : 's'} (${{ clean: 'cleaned', crisp: 'like new, black and white', color: 'cleaned, colors kept', retype: 'retyped as clean text' }[mode]}).`, pages[0]);
            } finally {
              busy(false);
            }
          });
          break;
        case 'read_faded':
          deferred.push(async () => {
            const { ocrPages } = await import('./ocr.js');
            const r = await ocrPages(state.doc.pages, { straighten: true, skipTextPages: false, deep: true });
            ok(`Read the text on ${r.textFound} page${r.textFound === 1 ? '' : 's'} with extra care.`);
          });
          break;
        case 'redact': {
          const kinds = (a.kinds || []).filter(Boolean);
          const words = a.find ? [a.find] : [];
          if (!kinds.length && !words.length) {
            fail('Tell me what to redact, e.g. "redact 123-45-6789" or "redact phone numbers".');
            break;
          }
          deferred.push(async () => {
            const P = await import('./protect.js');
            const n = await P.markForRedaction({ words, patterns: kinds, pageNos: a.page ? [a.page] : null });
            if (!n) return fail(`Couldn't find ${words.length ? '"' + a.find + '"' : 'anything like that'} to redact.`);
            const pages = await P.applyRedactions({ ask: false });
            ok(`Redacted ${n} place${n === 1 ? '' : 's'} on ${pages} page${pages === 1 ? '' : 's'}. It is removed for good when you save.`);
          });
          break;
        }
        case 'apply_redactions':
          deferred.push(async () => {
            const P = await import('./protect.js');
            const pages = await P.applyRedactions({ ask: false });
            pages ? ok(`Redacted ${pages} page${pages === 1 ? '' : 's'}.`) : fail('Nothing is marked for redaction.');
          });
          break;
        case 'set_password':
          deferred.push(async () => {
            const P = await import('./protect.js');
            if (a.password && String(a.password).length >= 4) {
              P.setProtection(String(a.password));
              ok('Locked: the password is added when you save.');
            } else {
              await P.passwordDialog();
              if (P.isLocked()) ok('Locked: the password is added when you save.');
            }
          });
          break;
        case 'remove_password':
          deferred.push(async () => {
            const P = await import('./protect.js');
            if (!P.isLocked()) return fail('This document has no password.');
            P.setProtection(null);
            ok('The password will be removed when you save.');
          });
          break;
        case 'remove_hidden_info':
          state.doc.scrub = true;
          ok('Hidden information (author, title, keywords, attachments, scripts) will be removed when you save.');
          break;
        case 'sign_digital':
          deferred.push(async () => {
            const P = await import('./protect.js');
            const signed = await P.signWithDigitalId();
            signed ? ok('Signed with your digital ID and saved a signed copy.') : fail('Digital signing was cancelled.');
          });
          break;
        default:
          fail(`I don't know how to "${a.action}".`);
      }
    } catch (e) {
      console.error(e);
      fail(`Something went wrong with "${a.action}": ${e.message}`);
    }
  }
  changed({ structure });
  for (const fn of deferred) {
    try {
      await fn();
    } catch (e) {
      console.error(e);
      fail(e.message);
    }
  }
  if (deferred.length) changed();
  clearTextCache();
  emit('forms');
  return report;
}

// ---------------------------------------------------------------------------
// Prompts for the AIs
// ---------------------------------------------------------------------------
/** Printed lines and fields of the page being looked at (and a few more pages), for the AI. */
export async function layoutText(maxChars = 6000) {
  const d = state.doc;
  if (!d) return '';
  const order = [state.currentPage, ...d.pages.keys()].filter((v, i, a) => a.indexOf(v) === i && d.pages[v]);
  let out = '';
  for (const i of order) {
    if (out.length > maxChars) break;
    try {
      const lay = await describeLayout(d.pages[i]);
      if (!lay.lines.length && !lay.fields.length) continue;
      out += `\n--- Layout of page ${i + 1} (points; page is ${Math.round(d.pages[i].w || 612)} wide) ---\n`;
      if (lay.lines.length) out += `Printed lines (target them as "line L<n>"):\n${lay.lines.join('\n')}${lay.more ? `\n(+${lay.more} more)` : ''}\n`;
      if (lay.fields.length) out += `Form fields:\n${lay.fields.join('\n')}\n`;
    } catch (e) {
      console.warn(e);
    }
  }
  return out.length > maxChars * 1.5 ? out.slice(0, maxChars * 1.5) + '\n[...]' : out;
}

export async function buildAiPrompt(request, { maxChars = 6000 } = {}) {
  const d = state.doc;
  if (!d) {
    return {
      system: `You make PDF documents. No document is open. If the user wants a new form or document, reply with a create_document action.\n${ACTION_SCHEMA}`,
      user: `Today is ${today()}.\nRequest: ${request}`,
    };
  }
  const fields = [];
  d.pages.forEach((p, i) => p.annots.forEach((a) => a.type === 'field' && fields.push(`${a.name} (${a.kind}, page ${i + 1})`)));
  for (const [src, list] of Object.entries(d.fields || {})) if (!(d.prepared || {})[src]) list.forEach((f) => fields.push(`${f.name} (${f.kind})`));
  let text = '';
  for (let i = 0; i < d.pages.length && text.length < maxChars; i++) {
    const lines = await pageLines(d.pages[i]);
    const t = lines
      .map((l) => l.text.trim())
      .filter(Boolean)
      .join('\n');
    text += `--- Page ${i + 1} ---\n${t}\n`;
  }
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n[...]';
  const system = `You edit PDF documents. Turn the user's request into actions.\n${ACTION_SCHEMA}`;
  const user =
    `Document: "${d.name}", ${d.pages.length} page(s). The user is looking at page ${state.currentPage + 1}. Today is ${today()}.\n` +
    (fields.length ? `Form fields: ${fields.slice(0, 120).join('; ')}\n` : '') +
    (describeItems().length ? `Items already added (can be moved/resized/deleted by these words): ${describeItems().join('; ')}\n` : '') +
    (state.selectedAnnot ? 'One item is selected (target "selected").\n' : '') +
    `Text on the pages:\n${text}\n` +
    (await layoutText(maxChars >= 20000 ? 20000 : 2500)) +
    `\nRequest: ${request}`;
  return { system, user };
}

/** Pull {"actions":[...]} out of an AI reply (it may have extra words or code fences). */
export function parseAiReply(reply) {
  const m = String(reply).match(/\{[\s\S]*\}/);
  if (!m) throw new Error("The AI's answer didn't contain any actions.");
  let obj;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    // Small models sometimes leave a trailing comma.
    obj = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1'));
  }
  const actions = Array.isArray(obj) ? obj : obj.actions;
  if (!Array.isArray(actions)) throw new Error("The AI's answer didn't contain any actions.");
  return actions.filter((a) => a && typeof a.action === 'string');
}

export const EXAMPLES = [
  "Add today's date next to Date",
  'Check New: Purchase Date',
  'Add a checkbox next to every "Yes"',
  'Highlight Total in yellow',
  'Replace "2021" with "2026"',
  'White out the phone number 987-1750',
  'Add "APPROVED" at the top right in green',
  'Delete page 2 and rotate page 1 right',
  'Add page numbers',
  'Sign next to Signature',
  'Make the form fillable',
  'Add a DRAFT watermark',
  'Redact social security numbers',
  'Lock with password "kona2026"',
  'Sign digitally',
  'Make a dive waiver form for Dive Moore',
  'Create a form called Gear Rental with name, phone, gear rented, deposit, date out, date due and signature',
  'Move the logo up 1 inch',
  'Move the line under Comments down 10 points',
  'Remove the three lines and text boxes by Comments',
  'Delete line L81',
  'Restore this document',
  'Make it look like new',
  'Retype this page as a clean document',
  'Add my logo at the top left',
  'Add a line under Comments',
  'Add a text box saying "Office use only" at the bottom right',
  'Rename Owner to Customer name',
  'Make Technician required',
];
