// Fillable form tools: turn existing fields into editable boxes, auto-detect new fields,
// name fields from nearby labels, the Form panel, and signatures.
import { state, emit, on, checkpoint, changed, findAnnot, findPage } from './state.js';
import { getPageTextItems, renderPageToCanvas, totalRotation, rightVec, downVec } from './doc.js';
import { el, icon, $, uid, toast, dialog, busy, loadImage } from './util.js';
import { recognizeCanvas } from './ocr.js';
import { setTool, getView, scrollToPage, placeImage } from './viewer.js';

export const FIELD_KINDS = {
  text: { label: 'Text', icon: 'text_fields', size: [160, 18] },
  checkbox: { label: 'Checkbox', icon: 'check_box', size: [12, 12] },
  radio: { label: 'Radio button', icon: 'radio_button_checked', size: [12, 12] },
  dropdown: { label: 'Dropdown', icon: 'arrow_drop_down_circle', size: [120, 18] },
  date: { label: 'Date', icon: 'calendar_month', size: [100, 18] },
  signature: { label: 'Signature', icon: 'signature', size: [180, 30] },
};

const dot = (p, v) => p[0] * v[0] + p[1] * v[1];

// ---------------------------------------------------------------------------
// Convert the PDF's existing fields into editable field boxes
// ---------------------------------------------------------------------------
export function hasEditableFields() {
  return !!state.doc && state.doc.pages.some((p) => p.annots.some((a) => a.type === 'field'));
}

export function unpreparedFieldCount() {
  const d = state.doc;
  if (!d || !d.fields) return 0;
  let n = 0;
  for (const [src, list] of Object.entries(d.fields)) if (!(d.prepared || {})[src]) n += list.length;
  return n;
}

/** Turn every existing PDF field into a field box we can move, resize, rename and retype. */
export function prepareExistingFields() {
  const d = state.doc;
  d.prepared = d.prepared || {};
  let count = 0;
  for (const [srcId, fields] of Object.entries(d.fields || {})) {
    if (d.prepared[srcId]) continue;
    const values = d.formValues[srcId] || {};
    for (const f of fields) {
      f.widgets.forEach((w) => {
        const pages = d.pages.filter((p) => p.src === srcId && p.index === w.pageIndex);
        for (const page of pages) {
          const [x1, y1, x2, y2] = w.rect;
          const value = f.name in values ? values[f.name] : f.value;
          page.annots.push({
            id: uid(),
            type: 'field',
            kind: f.kind === 'text' && /date/i.test(f.name) ? 'date' : f.kind,
            name: f.name,
            x1: Math.min(x1, x2),
            y1: Math.min(y1, y2),
            x2: Math.max(x1, x2),
            y2: Math.max(y1, y2),
            value: f.kind === 'radio' ? value === w.onValue : value,
            onValue: w.onValue,
            options: f.options || [],
            multiline: f.multiline,
            required: f.required,
            border: f.kind === 'checkbox' || f.kind === 'radio' ? w.border : false,
            rot: totalRotation(page),
          });
          count++;
        }
      });
    }
    d.prepared[srcId] = true;
  }
  return count;
}

export function setFormMode(mode) {
  if (mode === 'edit' && unpreparedFieldCount()) {
    checkpoint();
    const n = prepareExistingFields();
    changed();
    toast(`${n} existing field${n === 1 ? '' : 's'} ready to edit. Drag to move, use the corner to resize.`);
  }
  state.formMode = mode;
  document.body.dataset.formMode = mode;
  emit('formmode', mode);
  emit('annots');
  emit('forms');
  renderFormPanel();
}

// ---------------------------------------------------------------------------
// Naming fields from the text around them
// ---------------------------------------------------------------------------
const textCache = new Map();
const OCR_SCALE = 300 / 72;

/** True when extracted text is gibberish (a font that hides its real letters). */
function looksGarbled(str) {
  const tokens = str.split(/\s+/).filter((t) => t.length >= 4);
  if (!tokens.length) return false;
  let bad = 0;
  for (const t of tokens) {
    const caseFlips = (t.slice(1).match(/[a-z][A-Z]/g) || []).length;
    const digitInside = /[A-Za-z]\d+[A-Za-z]/.test(t) && !/^\d+(st|nd|rd|th)$/i.test(t);
    const oddPunct = /[a-z][,;][A-Z]/.test(t) || /^[,;][A-Z]/.test(t);
    if (caseFlips >= 2 || digitInside || oddPunct) bad++;
  }
  return bad / tokens.length > 0.4;
}

/** Text on a page as boxes in PDF user space. Falls back to OCR when the PDF's text is garbled. */
async function pageTextBoxes(page) {
  const key = page.src + ':' + page.index;
  if (textCache.has(key)) return textCache.get(key);
  const items = await getPageTextItems(state.doc, page);
  let boxes = items
    .filter((it) => it.str && it.str.trim())
    .map((it) => {
      const [a, b, , , e, f] = it.transform;
      const len = Math.hypot(a, b) || 1;
      const h = it.height || len;
      const dir = [a / len, b / len];
      const up = [-dir[1], dir[0]];
      const pts = [
        [e, f],
        [e + dir[0] * it.width, f + dir[1] * it.width],
        [e + up[0] * h, f + up[1] * h],
        [e + dir[0] * it.width + up[0] * h, f + dir[1] * it.width + up[1] * h],
      ];
      return { str: it.str, pts };
    });
  const garbled = boxes.filter((b) => looksGarbled(b.str));
  if (!boxes.length || garbled.length) {
    // Some labels use a font that hides the real letters: read those with OCR instead.
    try {
      const { canvas, viewport } = await renderPageToCanvas(state.doc, page, OCR_SCALE);
      const res = await recognizeCanvas(canvas, { autoRotate: false });
      const ocrBoxes = res.words.map((w) => ({ str: w.text, pts: w.quad.map((q) => viewport.convertToPdfPoint(q[0], q[1])) }));
      if (!boxes.length) boxes = ocrBoxes;
      else {
        const inside = (o, g) => {
          const xs = g.pts.map((p) => p[0]);
          const ys = g.pts.map((p) => p[1]);
          const cx = o.pts.reduce((n, p) => n + p[0], 0) / 4;
          const cy = o.pts.reduce((n, p) => n + p[1], 0) / 4;
          return cx >= Math.min(...xs) - 3 && cx <= Math.max(...xs) + 3 && cy >= Math.min(...ys) - 3 && cy <= Math.max(...ys) + 3;
        };
        const replacement = [];
        for (const g of garbled) replacement.push(...ocrBoxes.filter((o) => inside(o, g)));
        boxes = boxes.filter((b) => !garbled.includes(b)).concat(replacement);
      }
    } catch (e) {
      console.warn('OCR for labels failed', e);
    }
  }
  textCache.set(key, boxes);
  return boxes;
}

function extentIn(pts, v) {
  const vals = pts.map((p) => dot(p, v));
  return [Math.min(...vals), Math.max(...vals)];
}

function tidyLabel(s) {
  return s
    .replace(/[_.…]{2,}/g, ' ')
    .replace(/[☐□■▢☑✓]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[:;：\s]+$/, '')
    .replace(/^[:;：\s]+/, '')
    .trim();
}

const UNIT = /^["“”']?\s*(psi|h2o|h₂o|inh2o|in\.?\s*h2o|°\s*[fc]|%|lbs?|bar|cu\.?\s*ft|ft|in|kg|mm|cm)\.?$/i;
const isUnit = (s) => UNIT.test(tidyLabel(s).replace(/\s+/g, ''));

/** Join words into a phrase in reading order (multi-line labels top to bottom). */
function phrase(items) {
  const rows = [];
  for (const it of [...items].sort((a, b) => a.t - b.t)) {
    let row = rows.find((r) => Math.abs(r.mid - (it.t + it.b) / 2) < Math.max(3, (it.b - it.t) * 0.5));
    if (!row) rows.push((row = { mid: (it.t + it.b) / 2, items: [] }));
    row.items.push(it);
  }
  return tidyLabel(
    rows
      .map((r) => {
        r.items.sort((a, b) => a.l - b.l);
        let out = '';
        let end = null;
        for (const it of r.items) {
          if (out && end !== null && it.l - end > 1.2 && !out.endsWith(' ')) out += ' ';
          out += it.str;
          end = it.r;
        }
        return out;
      })
      .join(' ')
  );
}

/** Expand from one word to the neighbouring words of the same label. */
function growPhrase(seed, pool) {
  const group = [seed];
  let changedAny = true;
  while (changedAny) {
    changedAny = false;
    for (const it of pool) {
      if (group.includes(it)) continue;
      const near = group.some((g) => {
        const sameLine = Math.abs((g.t + g.b) / 2 - (it.t + it.b) / 2) < Math.max(3, (g.b - g.t) * 0.6);
        const hGap = Math.max(it.l - g.r, g.l - it.r);
        // Lines of one label sit very close together; the next table row is a bit further away.
        const lh = g.b - g.t;
        const nextLine = Math.abs(it.l - g.l) < 4 && ((it.t - g.b < lh * 0.18 && it.t - g.b > -2) || (g.t - it.b < lh * 0.18 && g.t - it.b > -2));
        return (sameLine && hGap < 7) || nextLine;
      });
      if (near) {
        group.push(it);
        changedAny = true;
      }
    }
  }
  return group;
}

/**
 * Suggest a field name from the labels around it, the way a person would name it:
 * "Owner", "1st stage - Inspected", "HP Spool Replace - Yes", "Dump Valves - Cleaned", "Comments 2".
 */
export async function suggestName(page, box, kind) {
  const rot = totalRotation(page);
  const R = rightVec(rot);
  const D = downVec(rot);
  const ext = (b) => {
    const pts = [
      [b.x1, b.y1],
      [b.x2, b.y2],
      [b.x1, b.y2],
      [b.x2, b.y1],
    ];
    const [l, r] = extentIn(pts, R);
    const [t, bt] = extentIn(pts, D);
    return { l, r, t, b: bt };
  };
  const F = ext(box);
  const fh = F.b - F.t;
  const texts = (await pageTextBoxes(page)).map((b) => {
    const [l, r] = extentIn(b.pts, R);
    const [t, bt] = extentIn(b.pts, D);
    return { str: b.str, l, r, t, b: bt };
  });
  const others = page.annots.filter((a) => a.type === 'field' && !(a.x1 === box.x1 && a.y1 === box.y1 && a.x2 === box.x2 && a.y2 === box.y2)).map((a) => ({ a, ...ext(a) }));
  const vOverlap = (it) => Math.min(it.b, F.b) - Math.max(it.t, F.t);
  const onRow = texts.filter((it) => vOverlap(it) >= 0.4 * Math.min(it.b - it.t, fh));
  const blocked = (it) => others.some((o) => o.r <= F.l + 1 && o.l >= it.r - 1 && Math.min(o.b, F.b) - Math.max(o.t, F.t) > 0);
  const allLeft = onRow.filter((it) => it.r <= F.l + 2);
  const left = allLeft.filter((it) => !blocked(it)).sort((a, b) => F.l - a.r - (F.l - b.r));
  const OPTION = /^(yes|no|n\/a|na|pass|fail|ok|true|false)$/i;
  // Units ("PSI"), choices ("Yes"), numbers and stray symbols are never a field's main label.
  const isNoise = (str) => {
    const t = tidyLabel(str);
    return isUnit(str) || OPTION.test(t) || /^[\W\d_]*$/.test(t) || t.replace(/\W/g, '').length <= 2 || /^["“”]?h[,.]?[2₂]?[o0]$/i.test(t.replace(/\s/g, ''));
  };
  const nearestOf = (list) => [...list].filter((it) => !isNoise(it.str)).sort((a, b) => F.l - a.r - (F.l - b.r))[0];
  const leftLabels = left.filter((it) => !isNoise(it.str));
  const right = onRow.filter((it) => it.l >= F.r - 2).sort((a, b) => a.l - F.r - (b.l - F.r));
  const hOverlap = (it) => Math.min(it.r, F.r) - Math.max(it.l, F.l);
  const above = texts.filter((it) => it.b <= F.t + 2 && hOverlap(it) > Math.min(it.r - it.l, F.r - F.l) * 0.3 && F.t - it.b < 220).sort((a, b) => F.t - a.b - (F.t - b.b));
  const fw = F.r - F.l;
  // A short label printed right under a small box (like "Yes" under a checkbox).
  const below = texts
    .filter((it) => it.t >= F.b - 2 && it.t - F.b < 12 && Math.abs((it.l + it.r) / 2 - (F.l + F.r) / 2) < Math.max(fw, 12))
    .sort((a, b) => a.t - b.t)
    .filter((it) => {
      const g = growPhrase(it, texts);
      const gl = Math.min(...g.map((x) => x.l));
      const gr = Math.max(...g.map((x) => x.r));
      return gr - gl < Math.max(fw, 10) * 4;
    });

  const header = above.length ? phrase(growPhrase(above[0], texts).filter((it) => it.b <= F.t + 2)) : '';
  const headerGap = above.length ? F.t - above[0].b : Infinity;

  const leftOfField = texts.filter((it) => it.r <= F.l + 2);
  // Row title: the leftmost text in the row (first column of a table). Looks a little above the
  // field too, because table labels often sit at the top of a tall cell.
  const titleOf = (cands) => {
    const real = cands.filter((it) => !isNoise(it.str));
    if (!real.length) return '';
    const minL = Math.min(...real.map((it) => it.l));
    const col = real.filter((it) => it.l - minL < 4);
    const mid = (F.t + F.b) / 2;
    const seed = col.sort((a, b) => Math.abs((a.t + a.b) / 2 - mid) - Math.abs((b.t + b.b) / 2 - mid))[0];
    return phrase(growPhrase(seed, leftOfField));
  };

  const strictTitle = titleOf(allLeft);
  const bandLeft = texts.filter((it) => it.r <= F.l + 2 && it.b >= F.t - 4 && (it.t + it.b) / 2 >= F.t - 16 && (it.t + it.b) / 2 <= F.b + 4);
  const rowTitle = strictTitle || titleOf(bandLeft);

  const nearItem = leftLabels[0];
  const near = nearItem ? phrase(growPhrase(nearItem, leftLabels)) : '';
  const nearGap = nearItem ? F.l - nearItem.r : Infinity;
  const nearIsTitle = !!near && near === strictTitle;
  const join = (...parts) => [...new Set(parts.filter((x) => x && /[A-Za-z0-9]/.test(x)))].join(' - ');

  let name = '';
  if (kind === 'checkbox' || kind === 'radio') {
    const rightLabel = right.length && right[0].l - F.r < 20 ? phrase(growPhrase(right[0], right)) : '';
    const belowLabel = below.length ? phrase(growPhrase(below[0], texts)) : '';
    if (rightLabel) {
      // "Yes"/"No" boxes get the question they answer: "HP Spool Replace - Yes".
      const ctx = nearestOf(allLeft);
      name = rightLabel.length <= 6 ? join(ctx ? phrase(growPhrase(ctx, allLeft)) : rowTitle, rightLabel) : rightLabel;
    } else if (strictTitle && header) {
      name = join(strictTitle, header);
    } else if (belowLabel) {
      let head = headerGap < 30 ? header : '';
      if (!head && OPTION.test(belowLabel)) {
        // "Yes"/"No" under a box: use the heading of that group, even if it is not right above.
        const cx = (F.l + F.r) / 2;
        const line = texts.filter((it) => it.b <= F.t + 2 && F.t - it.b < 30).sort((a, b) => F.t - a.b - (F.t - b.b));
        if (line.length) {
          const rowY = line[0].b;
          const cands = line.filter((it) => Math.abs(it.b - rowY) < 12);
          const best = cands.sort((a, b) => Math.max(0, a.l - cx, cx - a.r) - Math.max(0, b.l - cx, cx - b.r))[0];
          if (best) head = phrase(growPhrase(best, texts).filter((it) => it.b <= F.t + 2));
        }
      }
      name = join(head, belowLabel);
    } else if (near && nearGap < 20) {
      name = near;
    } else {
      name = join(rowTitle, header);
    }
  } else {
    const group = nearItem ? growPhrase(nearItem, allLeft) : [];
    const hasColon = group.some((x) => /[:;：]\s*$/.test(x.str)) || allLeft.some((x) => /^[:;：]$/.test(x.str.trim()) && nearItem && x.l >= nearItem.r - 1 && x.l - nearItem.r < 4);
    const fmid = (F.t + F.b) / 2;
    const nearAligned = nearItem && Math.abs((nearItem.t + nearItem.b) / 2 - fmid) <= Math.max(4, fh * 0.3);
    // A field whose own label is on the left of the field above it: "Comments" -> "Comments 2".
    const up = others
      .filter((o) => o.b <= F.t + 2 && F.t - o.b < 40 && Math.min(o.r, F.r) - Math.max(o.l, F.l) > Math.min(fw, o.r - o.l) * 0.5)
      .sort((a, b) => b.b - a.b)[0];
    // Walk up a stack of blank lines (Comments / line 2 / line 3) to the one that has a "Label:".
    const ownLabel = (o) => texts.some((it) => it.r <= o.l + 2 && o.l - it.r < 25 && Math.min(it.b, o.b) - Math.max(it.t, o.t) > 0 && /[:;：]\s*$/.test(it.str));
    const aboveOf = (o) =>
      others.filter((q) => q !== o && q.b <= o.t + 2 && o.t - q.b < 40 && Math.min(q.r, o.r) - Math.max(q.l, o.l) > Math.min(o.r - o.l, q.r - q.l) * 0.5).sort((a, b) => b.b - a.b)[0];
    const headerInCol = () => above.length && (!up || above[0].b > up.b);
    let upHasOwnLabel = false;
    for (let o = up, i = 0; o && i < 6; o = aboveOf(o), i++) {
      if (ownLabel(o)) {
        upHasOwnLabel = true;
        break;
      }
    }
    if (near && nearGap < 25 && nearAligned && (hasColon || near.length > 2)) {
      name = !hasColon && nearIsTitle && headerGap < 30 ? join(near, header) : near;
    } else if (!left.length && up && upHasOwnLabel && !headerInCol()) {
      name = up.a.name.replace(/ \d+$/, '');
    } else {
      name = join(rowTitle, header);
    }
  }
  if (!name) name = header || (FIELD_KINDS[kind] ? FIELD_KINDS[kind].label : 'Field');
  return name.replace(/\s+-\s+-\s+/g, ' - ').slice(0, 80);
}

export function uniqueName(name, exceptId = null, kind = null) {
  const used = new Set();
  for (const p of state.doc.pages) for (const a of p.annots) if (a.type === 'field' && a.id !== exceptId && !(kind === 'radio' && a.kind === 'radio')) used.add(a.name);
  for (const [src, list] of Object.entries(state.doc.fields || {})) if (!(state.doc.prepared || {})[src]) list.forEach((f) => used.add(f.name));
  if (!used.has(name)) return name;
  let n = 2;
  while (used.has(`${name} ${n}`)) n++;
  return `${name} ${n}`;
}

/** Rename every field from its nearby label (fixes names like "undefined_4" or "Check Box1.0"). */
export async function autoNameAll({ onlyMessy = false } = {}) {
  if (unpreparedFieldCount()) setFormMode('edit');
  checkpoint();
  busy('Reading the labels next to each field…');
  let n = 0;
  try {
  const messy = /^(undefined|check ?box|text|field|untitled|button|radio|group|choice|yes|no)[_\s\d.]*$/i;
  for (const page of state.doc.pages) {
    for (const a of page.annots) {
      if (a.type !== 'field' || a.kind === 'radio') continue;
      if (onlyMessy && !messy.test(a.name) && !/[_.]\d+$/.test(a.name)) continue;
      const name = await suggestName(page, a, a.kind);
      const unique = uniqueName(name, a.id);
      if (unique !== a.name) {
        a.name = unique;
        n++;
      }
      // Tidy the type too: signature lines become signature fields, dates become date fields.
      if (a.kind === 'text' && /^(signature|signed by|sign here)\b/i.test(a.name) && !a.value) {
        a.kind = 'signature';
        a.border = false;
      } else if (a.kind === 'text' && /\bdate\b|\bdue\b/i.test(a.name)) a.kind = 'date';
    }
  }
  } finally {
    busy(false);
  }
  changed();
  renderFormPanel();
  return n;
}

// ---------------------------------------------------------------------------
// Adding fields
// ---------------------------------------------------------------------------
/** Called by the viewer when a field tool is used. `box` is in PDF user space. */
export async function addField(page, kind, box, { dragged = false } = {}) {
  if (unpreparedFieldCount()) prepareExistingFields();
  const rot = totalRotation(page);
  if (!dragged) {
    // Single click: use a sensible default size centred on the click.
    const [w, h] = FIELD_KINDS[kind].size;
    const R = rightVec(rot);
    const D = downVec(rot);
    const cx = box.x1;
    const cy = box.y1;
    const p1 = [cx - (R[0] * w) / 2 - (D[0] * h) / 2, cy - (R[1] * w) / 2 - (D[1] * h) / 2];
    const p2 = [cx + (R[0] * w) / 2 + (D[0] * h) / 2, cy + (R[1] * w) / 2 + (D[1] * h) / 2];
    box = { x1: Math.min(p1[0], p2[0]), x2: Math.max(p1[0], p2[0]), y1: Math.min(p1[1], p2[1]), y2: Math.max(p1[1], p2[1]) };
  }
  let name = await suggestName(page, box, kind);
  let onValue = null;
  if (kind === 'radio') {
    // Radio buttons in one group share a name; each needs its own value.
    const group = state.doc.pages.flatMap((p) => p.annots).filter((a) => a.type === 'field' && a.kind === 'radio');
    const last = group[group.length - 1];
    onValue = name;
    name = last ? last.name : 'Choice';
  } else name = uniqueName(name);
  checkpoint();
  const a = {
    id: uid(),
    type: 'field',
    kind,
    name,
    ...box,
    value: kind === 'checkbox' || kind === 'radio' ? false : '',
    onValue,
    options: kind === 'dropdown' ? ['Option 1', 'Option 2'] : [],
    multiline: kind === 'text' && Math.abs(box.y2 - box.y1) > 30 && rot % 180 === 0,
    required: false,
    border: kind === 'checkbox' || kind === 'radio' || kind === 'signature',
    rot,
  };
  page.annots.push(a);
  state.selectedAnnot = { pageId: page.id, annotId: a.id };
  if (state.formMode !== 'edit') {
    state.formMode = 'edit';
    document.body.dataset.formMode = 'edit';
    emit('formmode', 'edit');
  }
  changed();
  emit('selection');
  renderFormPanel();
  return a;
}

/** Duplicate the selected annotation just below itself (great for columns of checkboxes). */
export function duplicateSelected(direction = 'down') {
  const f = findAnnot();
  if (!f) return false;
  const { page, annot } = f;
  const v = getView(page.id);
  if (!v || !v.viewport) return false;
  const copy = JSON.parse(JSON.stringify(annot));
  copy.id = uid();
  const rot = totalRotation(page);
  const D = direction === 'down' ? downVec(rot) : rightVec(rot);
  let step = 20;
  if ('x1' in annot) {
    const [lo, hi] = extentIn(
      [
        [annot.x1, annot.y1],
        [annot.x2, annot.y2],
      ],
      D
    );
    step = hi - lo + 4;
  }
  const dx = D[0] * step;
  const dy = D[1] * step;
  if ('x1' in copy) {
    copy.x1 += dx;
    copy.x2 += dx;
    copy.y1 += dy;
    copy.y2 += dy;
  }
  if ('x' in copy) {
    copy.x += dx;
    copy.y += dy;
  }
  if (copy.pts) copy.pts = copy.pts.map((p) => [p[0] + dx, p[1] + dy]);
  if (copy.rects) copy.rects = copy.rects.map((r) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
  if (copy.type === 'field') {
    if (copy.kind !== 'radio') copy.name = uniqueName(copy.name.replace(/ \d+$/, ''), copy.id);
    copy.value = copy.kind === 'checkbox' || copy.kind === 'radio' ? false : '';
  }
  checkpoint();
  page.annots.push(copy);
  state.selectedAnnot = { pageId: page.id, annotId: copy.id };
  changed();
  emit('selection');
  renderFormPanel();
  // Rename from the label next to the new position.
  if (copy.type === 'field' && copy.kind !== 'radio') {
    suggestName(page, copy, copy.kind).then((n) => {
      copy.name = uniqueName(n, copy.id);
      renderFormPanel();
      emit('annots');
    });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Automatic field detection (lines, empty table cells, check boxes)
// ---------------------------------------------------------------------------
export async function detectFields({ allPages = true } = {}) {
  if (unpreparedFieldCount()) prepareExistingFields();
  const pages = allPages ? state.doc.pages : [state.doc.pages[state.currentPage]];
  busy('Looking for places to fill in…');
  const created = [];
  try {
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const found = await detectOnPage(page);
      const existing = page.annots.filter((a) => a.type === 'field');
      for (const c of found) {
        if (existing.some((e) => overlapRatio(e, c) > 0.25)) continue;
        if (created.some((e) => e.page === page && overlapRatio(e.box, c) > 0.25)) continue;
        created.push({ page, box: c, kind: c.kind });
      }
    }
    if (!created.length) {
      toast('No new places to fill in were found.');
      return 0;
    }
    checkpoint();
    for (const c of created) {
      const name = uniqueName(await suggestName(c.page, c.box, c.kind));
      // Signature lines become signature fields and date blanks become date fields.
      if (c.kind === 'text' && /^(signature|signed|sign here)\b/i.test(name)) c.kind = 'signature';
      else if (c.kind === 'text' && /\b(date|due)\b/i.test(name)) c.kind = 'date';
      c.page.annots.push({
        id: uid(),
        type: 'field',
        kind: c.kind,
        name,
        x1: c.box.x1,
        y1: c.box.y1,
        x2: c.box.x2,
        y2: c.box.y2,
        value: c.kind === 'checkbox' ? false : '',
        options: [],
        multiline: c.box.multiline || false,
        required: false,
        border: false,
        rot: totalRotation(c.page),
      });
    }
    state.formMode = 'edit';
    document.body.dataset.formMode = 'edit';
    emit('formmode', 'edit');
    changed();
    renderFormPanel();
    return created.length;
  } finally {
    busy(false);
  }
}

function overlapRatio(a, b) {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const area = Math.min((a.x2 - a.x1) * (a.y2 - a.y1), (b.x2 - b.x1) * (b.y2 - b.y1)) || 1;
  return inter / area;
}

async function detectOnPage(page) {
  const K = 2; // pixels per point
  const { canvas, viewport } = await renderPageToCanvas(state.doc, page, K);
  const W = canvas.width;
  const H = canvas.height;
  const data = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const dark = new Uint8Array(W * H);
  for (let i = 0, j = 0; i < dark.length; i++, j += 4) dark[i] = data[j] * 0.3 + data[j + 1] * 0.59 + data[j + 2] * 0.11 < 200 ? 1 : 0;

  // 1) Horizontal and vertical line segments.
  const hRuns = [];
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (!dark[y * W + x]) {
        x++;
        continue;
      }
      const s = x;
      while (x < W && dark[y * W + x]) x++;
      if (x - s >= 18 * K) hRuns.push({ y, x1: s, x2: x });
    }
  }
  const hLines = mergeRuns(hRuns, 'y');
  const vRuns = [];
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H) {
      if (!dark[y * W + x]) {
        y++;
        continue;
      }
      const s = y;
      while (y < H && dark[y * W + x]) y++;
      if (y - s >= 8 * K) vRuns.push({ y: x, x1: s, x2: y });
    }
  }
  // Check boxes first, so their edges are not mistaken for table lines.
  const boxes = findSquares(dark, W, H, K);
  const inBox = (x1, y1, x2, y2) => boxes.some((b) => x1 >= b.x1 - 2 && x2 <= b.x2 + 2 && y1 >= b.y1 - 2 && y2 <= b.y2 + 2);
  const vLines = mergeRuns(vRuns, 'y')
    .map((l) => ({ x: l.pos, y1: l.a, y2: l.b }))
    .filter((l) => !inBox(l.x, l.y1, l.x, l.y2));
  const hl = hLines.map((l) => ({ y: l.pos, x1: l.a, x2: l.b })).filter((l) => !inBox(l.x1, l.y, l.x2, l.y));

  // Text positions (view pixels), to tell labels from empty spaces.
  const texts = (await pageTextBoxes(page)).map((b) => {
    const pts = b.pts.map((p) => viewport.convertToViewportPoint(p[0], p[1]));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { str: b.str, x1: Math.min(...xs), x2: Math.max(...xs), y1: Math.min(...ys), y2: Math.max(...ys) };
  });
  const textIn = (x1, y1, x2, y2) => texts.filter((t) => t.x2 > x1 + 1 && t.x1 < x2 - 1 && t.y2 > y1 + 1 && t.y1 < y2 - 1);

  const out = [];
  const tol = 3 * K;
  const toUserBox = (x1, y1, x2, y2, extra = {}) => {
    const a = viewport.convertToPdfPoint(x1, y1);
    const b = viewport.convertToPdfPoint(x2, y2);
    return { x1: Math.min(a[0], b[0]), x2: Math.max(a[0], b[0]), y1: Math.min(a[1], b[1]), y2: Math.max(a[1], b[1]), ...extra };
  };

  // 2) Check boxes: hollow little squares, and box glyphs in the text.
  for (const b of boxes) {
    if (textIn(b.x1 + 2, b.y1 + 2, b.x2 - 2, b.y2 - 2).some((t) => !/^[☐□▢\s]+$/.test(t.str))) continue;
    out.push(toUserBox(b.x1 + 1, b.y1 + 1, b.x2 - 1, b.y2 - 1, { kind: 'checkbox' }));
  }
  for (const t of texts) {
    const m = t.str.match(/[☐□▢]/);
    if (!m) continue;
    // Place the box over the glyph (approximate position within the text run).
    const idx = t.str.indexOf(m[0]);
    const cw = (t.x2 - t.x1) / Math.max(1, t.str.length);
    const size = Math.min(t.y2 - t.y1, cw * 1.6);
    const x1 = t.x1 + idx * cw;
    out.push(toUserBox(x1, t.y2 - size, x1 + size, t.y2, { kind: 'checkbox' }));
  }
  const squareLike = (x1, y1, x2, y2) => boxes.some((b) => b.x1 >= x1 - tol && b.x2 <= x2 + tol && b.y1 >= y1 - tol && b.y2 <= y2 + tol);

  // 3) Table cells: areas enclosed by lines with no text inside.
  const cells = [];
  for (const top of hl) {
    const vs = vLines
      .filter((v) => v.x >= top.x1 - tol && v.x <= top.x2 + tol && v.y1 <= top.y + tol && v.y2 > top.y + 6 * K)
      .sort((a, b) => a.x - b.x);
    for (let i = 0; i < vs.length - 1; i++) {
      const L = vs[i];
      const R = vs[i + 1];
      if (R.x - L.x < 10 * K) continue;
      const bottom = hl
        .filter((h) => h.y > top.y + 6 * K && h.x1 <= L.x + tol && h.x2 >= R.x - tol)
        .sort((a, b) => a.y - b.y)[0];
      if (!bottom) continue;
      if (L.y2 < bottom.y - tol || R.y2 < bottom.y - tol) continue;
      cells.push({ x1: L.x, y1: top.y, x2: R.x, y2: bottom.y });
    }
  }
  // Rows that are mostly labels are headings: their empty cells (like a table's top-left corner) are not fields.
  const rowKey = (c) => Math.round(c.y1 / 6) + ':' + Math.round(c.y2 / 6);
  const rowStats = {};
  for (const c of cells) {
    const k = rowKey(c);
    rowStats[k] = rowStats[k] || { text: 0, all: 0 };
    rowStats[k].all++;
    if (textIn(c.x1 + 2, c.y1 + 2, c.x2 - 2, c.y2 - 2).length) rowStats[k].text++;
  }
  const seen = new Set();
  for (const c of cells) {
    const st = rowStats[rowKey(c)];
    if (st.all >= 3 && st.all - st.text <= 1 && st.text / st.all >= 0.75 && !textIn(c.x1 + 2, c.y1 + 2, c.x2 - 2, c.y2 - 2).length) continue;
    const key = [c.x1, c.y1, c.x2, c.y2].map((n) => Math.round(n / 4)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    const pad = 2 * K;
    const inner = [c.x1 + pad, c.y1 + pad, c.x2 - pad, c.y2 - pad];
    const t = textIn(...inner);
    const cw = (c.x2 - c.x1) / K;
    const ch = (c.y2 - c.y1) / K;
    if (!t.length && cw <= 26 && ch <= 26 && cw / ch > 0.5 && cw / ch < 2.4) {
      // A tiny enclosed box with nothing in it is a check box (e.g. boxes stacked on top of each other).
      if (!squareLike(c.x1, c.y1, c.x2, c.y2)) out.push(toUserBox(c.x1 + K, c.y1 + K, c.x2 - K, c.y2 - K, { kind: 'checkbox' }));
      continue;
    }
    if (inner[3] - inner[1] < 8 * K || inner[2] - inner[0] < 12 * K) continue;
    if (squareLike(...inner)) continue;
    if (t.length) {
      // Cell with a unit at the right (e.g. "PSI"): fill the space before it.
      const onlyUnits = t.every((x) => x.str.trim().length <= 5 && x.x1 > inner[0] + (inner[2] - inner[0]) * 0.55);
      if (!onlyUnits) continue;
      const left = Math.min(...t.map((x) => x.x1)) - pad;
      if (left - inner[0] < 20 * K) continue;
      out.push(toUserBox(inner[0], inner[1], left, inner[3], { kind: 'text' }));
      continue;
    }
    const h = (inner[3] - inner[1]) / K;
    out.push(toUserBox(inner[0], inner[1], inner[2], inner[3], { kind: 'text', multiline: h > 34 }));
  }

  // 4) Fill-in lines: a horizontal rule that is not part of a table/box.
  for (const line of hl) {
    const len = (line.x2 - line.x1) / K;
    if (len < 30 || len > 560) continue;
    const touches = vLines.some((v) => (Math.abs(v.x - line.x1) < tol || Math.abs(v.x - line.x2) < tol) && v.y1 <= line.y + tol && v.y2 >= line.y - tol);
    if (touches) continue;
    if (cells.some((c) => line.y >= c.y1 - tol && line.y <= c.y2 + tol && line.x1 >= c.x1 - tol && line.x2 <= c.x2 + tol)) continue;
    // Space above the line, stopping at any text or line above.
    let top = line.y - 18 * K;
    for (const h2 of hl) if (h2 !== line && h2.y < line.y - 2 && h2.y > top && h2.x2 > line.x1 && h2.x1 < line.x2) top = h2.y + 2;
    let x1 = line.x1;
    const over = textIn(line.x1, top, line.x2, line.y - 1);
    if (over.length) {
      // Text sitting on the line (a label like "Name ____"): start after it.
      const lastLabelEnd = Math.max(...over.filter((t) => t.x1 < line.x1 + (line.x2 - line.x1) * 0.5).map((t) => t.x2), -1);
      if (lastLabelEnd < 0) continue;
      x1 = lastLabelEnd + 3;
      if (line.x2 - x1 < 25 * K) continue;
    }
    if (line.y - top < 8 * K) continue;
    out.push(toUserBox(x1 + K, top + K, line.x2 - K, line.y - 1, { kind: 'text' }));
  }
  return out;
}

/** Group single-pixel runs from neighbouring rows into lines. */
function mergeRuns(runs, axisKey) {
  const lines = [];
  const open = [];
  for (const r of runs) {
    let hit = null;
    for (const l of open) {
      if (r[axisKey] - l.last <= 1 && Math.abs(r.x1 - l.a) < 6 && Math.abs(r.x2 - l.b) < 6) {
        hit = l;
        break;
      }
    }
    if (hit) {
      hit.last = r[axisKey];
      hit.sum += r[axisKey];
      hit.n++;
      hit.a = Math.min(hit.a, r.x1);
      hit.b = Math.max(hit.b, r.x2);
    } else {
      const l = { first: r[axisKey], last: r[axisKey], sum: r[axisKey], n: 1, a: r.x1, b: r.x2 };
      open.push(l);
      lines.push(l);
    }
    // Drop lines that ended.
    for (let i = open.length - 1; i >= 0; i--) if (r[axisKey] - open[i].last > 1) open.splice(i, 1);
  }
  return lines.filter((l) => l.last - l.first <= 8).map((l) => ({ pos: l.sum / l.n, a: l.a, b: l.b }));
}

/** Find small hollow squares (printed check boxes). */
function findSquares(dark, W, H, K) {
  const seen = new Uint8Array(W * H);
  const out = [];
  const stack = [];
  const minS = 5 * K;
  const maxS = 22 * K;
  for (let start = 0; start < dark.length; start++) {
    if (!dark[start] || seen[start]) continue;
    let x1 = W;
    let y1 = H;
    let x2 = 0;
    let y2 = 0;
    let n = 0;
    stack.push(start);
    seen[start] = 1;
    let tooBig = false;
    while (stack.length) {
      const i = stack.pop();
      const x = i % W;
      const y = (i - x) / W;
      n++;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
      if (x2 - x1 > maxS * 1.5 || y2 - y1 > maxS * 1.5) tooBig = true;
      const nb = [i - 1, i + 1, i - W, i + W];
      for (const j of nb) {
        if (j < 0 || j >= dark.length || seen[j] || !dark[j]) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === W - 1)) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (tooBig) continue;
    const w = x2 - x1 + 1;
    const h = y2 - y1 + 1;
    if (w < minS || h < minS || w > maxS || h > maxS) continue;
    const ratio = w / h;
    if (ratio < 0.5 || ratio > 2.4) continue; // printed check boxes are often a little rectangular
    // Hollow: the outline has ink, the middle is mostly empty.
    const fill = n / (w * h);
    if (fill > 0.5) continue;
    let inner = 0;
    let innerN = 0;
    for (let y = y1 + Math.ceil(h * 0.3); y < y2 - h * 0.3; y++)
      for (let x = x1 + Math.ceil(w * 0.3); x < x2 - w * 0.3; x++) {
        inner += dark[y * W + x];
        innerN++;
      }
    if (innerN && inner / innerN > 0.15) continue;
    // Each side must be mostly inked (a real box, not a letter like "O" or "D").
    const side = (xa, ya, xb, yb) => {
      let c = 0;
      let t = 0;
      for (let y = ya; y <= yb; y++)
        for (let x = xa; x <= xb; x++) {
          c += dark[y * W + x];
          t++;
        }
      return c / t;
    };
    const k = Math.max(1, Math.round(K * 0.75));
    if (side(x1, y1, x2, y1 + k) < 0.6 || side(x1, y2 - k, x2, y2) < 0.6 || side(x1, y1, x1 + k, y2) < 0.6 || side(x2 - k, y1, x2, y2) < 0.6) continue;
    out.push({ x1, y1, x2, y2 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------
const SIG_KEY = 'pdfandmoore.signature';
export function savedSignature() {
  try {
    return localStorage.getItem(SIG_KEY);
  } catch {
    return null;
  }
}

/** Ask for a signature (draw / type / upload). Resolves with a PNG data URL, or null. */
export async function signatureDialog({ allowSaved = true } = {}) {
  const saved = allowSaved ? savedSignature() : null;
  const tabs = ['Draw', 'Type', 'Upload'];
  let mode = 'Draw';
  const pad = el('canvas', { class: 'sig-pad', width: 560, height: 180 });
  const ctx = pad.getContext('2d');
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#0b1f4d';
  let drawing = false;
  let drew = false;
  const pos = (e) => {
    const r = pad.getBoundingClientRect();
    return [((e.clientX - r.left) * pad.width) / r.width, ((e.clientY - r.top) * pad.height) / r.height];
  };
  pad.addEventListener('pointerdown', (e) => {
    drawing = true;
    drew = true;
    pad.setPointerCapture(e.pointerId);
    ctx.beginPath();
    ctx.moveTo(...pos(e));
  });
  pad.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    ctx.lineTo(...pos(e));
    ctx.stroke();
  });
  pad.addEventListener('pointerup', () => (drawing = false));
  const typed = el('input', { class: 'field sig-typed', placeholder: 'Type your name' });
  const fontSel = el(
    'select',
    { class: 'field' },
    ['"Segoe Script", "Brush Script MT", cursive', '"Lucida Handwriting", cursive', '"Ink Free", cursive', '"Segoe Print", cursive'].map((f, i) => el('option', { value: f }, ['Script', 'Handwriting', 'Ink', 'Print'][i]))
  );
  const preview = el('div', { class: 'sig-preview' });
  const updatePreview = () => {
    preview.textContent = typed.value || 'Your Name';
    preview.style.fontFamily = fontSel.value;
  };
  typed.addEventListener('input', updatePreview);
  fontSel.addEventListener('change', updatePreview);
  updatePreview();
  let uploaded = null;
  const fileIn = el('input', { type: 'file', accept: 'image/*' });
  const upPreview = el('img', { class: 'sig-upload-preview' });
  fileIn.addEventListener('change', () => {
    const f = fileIn.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      uploaded = r.result;
      upPreview.src = uploaded;
    };
    r.readAsDataURL(f);
  });
  const remember = el('input', { type: 'checkbox', checked: true });
  const panels = {
    Draw: el('div', {}, pad, el('button', { class: 'btn btn-text', onclick: () => (ctx.clearRect(0, 0, pad.width, pad.height), (drew = false)) }, 'Clear')),
    Type: el('div', { class: 'sig-type' }, typed, fontSel, preview),
    Upload: el('div', {}, fileIn, upPreview),
  };
  const tabBar = el(
    'div',
    { class: 'tabs' },
    tabs.map((t) =>
      el(
        'button',
        {
          class: 'tab' + (t === mode ? ' active' : ''),
          onclick: (e) => {
            mode = t;
            tabBar.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === e.currentTarget));
            Object.entries(panels).forEach(([k, p]) => (p.style.display = k === t ? '' : 'none'));
          },
        },
        t
      )
    )
  );
  Object.entries(panels).forEach(([k, p]) => (p.style.display = k === mode ? '' : 'none'));
  const body = el(
    'div',
    { class: 'sig-dialog' },
    saved ? el('div', { class: 'sig-saved' }, el('img', { src: saved }), el('button', { class: 'btn btn-primary', 'data-use-saved': '1' }, 'Use saved signature')) : null,
    tabBar,
    ...Object.values(panels),
    el('label', { class: 'check-label' }, remember, ' Remember this signature on this computer')
  );
  let useSaved = false;
  const resultP = dialog({
    title: 'Add your signature',
    body,
    width: '620px',
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Use signature', value: 'ok', primary: true },
    ],
  });
  const savedBtn = body.querySelector('[data-use-saved]');
  if (savedBtn)
    savedBtn.addEventListener('click', () => {
      useSaved = true;
      document.querySelector('.modal .btn-primary:last-child')?.click();
    });
  const r = await resultP;
  if (!r) return null;
  if (useSaved) return saved;
  let dataUrl = null;
  if (mode === 'Draw') {
    if (!drew) return null;
    dataUrl = trimCanvas(pad);
  } else if (mode === 'Type') {
    if (!typed.value.trim()) return null;
    const c = el('canvas', { width: 900, height: 220 });
    const g = c.getContext('2d');
    g.fillStyle = '#0b1f4d';
    g.font = `110px ${fontSel.value}`;
    g.textBaseline = 'middle';
    g.fillText(typed.value, 20, 110);
    dataUrl = trimCanvas(c);
  } else if (uploaded) {
    // Normalise to PNG so it embeds cleanly.
    const img = await loadImage(uploaded);
    const c = el('canvas', { width: img.naturalWidth, height: img.naturalHeight });
    c.getContext('2d').drawImage(img, 0, 0);
    dataUrl = c.toDataURL('image/png');
  }
  if (dataUrl && remember.checked) {
    try {
      localStorage.setItem(SIG_KEY, dataUrl);
    } catch {}
  }
  return dataUrl;
}

function trimCanvas(c) {
  const g = c.getContext('2d');
  const { data, width, height } = g.getImageData(0, 0, c.width, c.height);
  let x1 = width;
  let y1 = height;
  let x2 = 0;
  let y2 = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 10) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
  if (x2 <= x1) return c.toDataURL('image/png');
  const pad = 6;
  const out = document.createElement('canvas');
  out.width = x2 - x1 + pad * 2;
  out.height = y2 - y1 + pad * 2;
  out.getContext('2d').drawImage(c, x1 - pad, y1 - pad, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

/** Sign tool: ask for a signature, then place it with a click. */
export async function startSigning() {
  const dataUrl = await signatureDialog();
  if (!dataUrl) return;
  const img = await loadImage(dataUrl);
  placeImage(dataUrl, img.naturalWidth / 3, img.naturalHeight / 3);
}

/** Fill a signature field (called when someone clicks an empty signature box). */
export async function signField(page, annot) {
  const dataUrl = await signatureDialog();
  if (!dataUrl) return;
  checkpoint();
  annot.sig = dataUrl;
  changed();
  emit('forms');
}

// ---------------------------------------------------------------------------
// Form panel (right side)
// ---------------------------------------------------------------------------
export function initForms() {
  on('selection', renderFormPanel);
  on('structure', renderFormPanel);
  on('formmode', renderFormPanel);
  on('signfield', ({ page, annot }) => signField(page, annot));
}

function allFields() {
  const out = [];
  state.doc.pages.forEach((p, i) => p.annots.forEach((a) => a.type === 'field' && out.push({ page: p, pageNo: i + 1, a })));
  return out;
}

export function renderFormPanel() {
  const root = $('#formPanel');
  if (!root) return;
  root.replaceChildren();
  if (!state.doc) {
    root.append(el('p', { class: 'muted' }, 'Open a PDF to work with form fields.'));
    return;
  }
  const editing = state.formMode === 'edit';
  const legacy = unpreparedFieldCount();
  const fields = allFields();
  root.append(
    el(
      'div',
      { class: 'seg' },
      el('button', { class: 'seg-btn' + (!editing ? ' active' : ''), onclick: () => setFormMode('fill') }, icon('edit_note'), ' Fill in'),
      el('button', { class: 'seg-btn' + (editing ? ' active' : ''), onclick: () => setFormMode('edit') }, icon('design_services'), ' Edit fields')
    )
  );
  if (!editing) {
    const n = fields.length + legacy;
    root.append(
      el('p', { class: 'muted' }, n ? `This document has ${n} fillable field${n === 1 ? '' : 's'}. Click a box on the page to fill it in. Press Tab to move to the next one.` : 'No fillable fields yet. Switch to Edit fields to add some.')
    );
    return;
  }
  root.append(el('div', { class: 'panel-label' }, 'Add a field (click on the page, or drag to size it)'));
  root.append(
    el(
      'div',
      { class: 'field-tools' },
      Object.entries(FIELD_KINDS).map(([k, v]) =>
        el('button', { class: 'chip' + (state.tool === 'field-' + k ? ' active' : ''), title: v.label, onclick: () => setTool('field-' + k) }, icon(v.icon), v.label)
      )
    )
  );
  root.append(
    el(
      'div',
      { class: 'panel-actions' },
      el(
        'button',
        {
          class: 'btn btn-tonal',
          onclick: async () => {
            const n = await detectFields();
            if (n) toast(`Added ${n} field${n === 1 ? '' : 's'}. Check them and delete any you don't need.`);
          },
        },
        icon('auto_awesome'),
        ' Detect fields'
      ),
      el(
        'button',
        {
          class: 'btn btn-tonal',
          title: 'Rename fields from the label next to them',
          onclick: async () => {
            const n = await autoNameAll();
            toast(`Renamed ${n} field${n === 1 ? '' : 's'}.`);
          },
        },
        icon('label'),
        ' Auto-name'
      )
    )
  );

  const sel = findAnnot();
  if (sel && sel.annot.type === 'field') root.append(fieldProperties(sel.page, sel.annot));

  root.append(el('div', { class: 'panel-label' }, `Fields (${fields.length})`));
  const list = el('div', { class: 'field-list' });
  let lastPage = 0;
  for (const f of fields) {
    if (f.pageNo !== lastPage) {
      list.append(el('div', { class: 'list-sub' }, `Page ${f.pageNo}`));
      lastPage = f.pageNo;
    }
    const active = sel && sel.annot === f.a;
    list.append(
      el(
        'button',
        {
          class: 'field-row' + (active ? ' active' : ''),
          onclick: () => {
            state.selectedAnnot = { pageId: f.page.id, annotId: f.a.id };
            emit('selection');
            scrollToPage(f.pageNo - 1);
          },
        },
        icon(FIELD_KINDS[f.a.kind]?.icon || 'text_fields'),
        el('span', { class: 'field-row-name' }, f.a.name + (f.a.kind === 'radio' ? ` (${f.a.onValue || ''})` : '')),
        f.a.required ? el('span', { class: 'req' }, '*') : null
      )
    );
  }
  if (!fields.length) list.append(el('p', { class: 'muted' }, 'No fields yet. Pick a field type above and click on the page, or use Detect fields.'));
  root.append(list);
  root.append(
    el(
      'p',
      { class: 'hint' },
      'Tips: Ctrl+D copies the selected field just below it, which is handy for a column of checkboxes. Arrow keys nudge it, and Delete removes it.'
    )
  );
}

function fieldProperties(page, a) {
  const commit = (fn) => {
    checkpoint();
    fn();
    changed();
    renderFormPanel();
  };
  const name = el('input', { class: 'field', value: a.name });
  name.addEventListener('change', () => commit(() => (a.name = a.kind === 'radio' ? name.value.trim() || a.name : uniqueName(name.value.trim() || a.name, a.id))));
  const kind = el('select', { class: 'field' }, Object.entries(FIELD_KINDS).map(([k, v]) => el('option', { value: k }, v.label)));
  kind.value = a.kind;
  kind.addEventListener('change', () =>
    commit(() => {
      a.kind = kind.value;
      a.value = a.kind === 'checkbox' || a.kind === 'radio' ? false : '';
      if (a.kind === 'dropdown' && !(a.options || []).length) a.options = ['Option 1', 'Option 2'];
      if (a.kind === 'radio' && !a.onValue) a.onValue = 'Choice 1';
    })
  );
  const check = (label, prop, title) => {
    const c = el('input', { type: 'checkbox' });
    c.checked = !!a[prop];
    c.addEventListener('change', () => commit(() => (a[prop] = c.checked)));
    return el('label', { class: 'check-label', title }, c, ' ' + label);
  };
  const rows = [
    el('label', { class: 'field-label' }, 'Name', name),
    el('label', { class: 'field-label' }, 'Type', kind),
  ];
  if (a.kind === 'radio') {
    const ov = el('input', { class: 'field', value: a.onValue || '' });
    ov.addEventListener('change', () => commit(() => (a.onValue = ov.value)));
    rows.push(el('label', { class: 'field-label' }, 'Choice value (buttons with the same name form one group)', ov));
  }
  if (a.kind === 'dropdown') {
    const opts = el('textarea', { class: 'field', rows: 4 });
    opts.value = (a.options || []).join('\n');
    opts.addEventListener('change', () => commit(() => (a.options = opts.value.split('\n').map((s) => s.trim()).filter(Boolean))));
    rows.push(el('label', { class: 'field-label' }, 'Choices (one per line)', opts));
  }
  if (a.kind === 'text' || a.kind === 'date' || a.kind === 'dropdown') {
    const fs = el('select', { class: 'field' }, el('option', { value: '0' }, 'Auto'), [8, 9, 10, 11, 12, 14, 16, 18].map((n) => el('option', { value: n }, n + ' pt')));
    fs.value = String(a.fontSize || 0);
    fs.addEventListener('change', () => commit(() => (a.fontSize = Number(fs.value) || 0)));
    rows.push(el('label', { class: 'field-label' }, 'Font size', fs));
  }
  const flags = el('div', { class: 'flags' }, check('Required', 'required'), check('Show border', 'border'));
  if (a.kind === 'text') flags.append(check('Multiple lines', 'multiline'));
  rows.push(flags);
  rows.push(
    el(
      'div',
      { class: 'panel-actions' },
      el('button', { class: 'btn btn-text', onclick: () => duplicateSelected('down') }, icon('content_copy'), ' Copy below'),
      el('button', { class: 'btn btn-text', onclick: () => duplicateSelected('right') }, icon('east'), ' Copy right'),
      el(
        'button',
        {
          class: 'btn btn-text danger',
          onclick: () =>
            commit(() => {
              page.annots.splice(page.annots.indexOf(a), 1);
              state.selectedAnnot = null;
              emit('selection');
            }),
        },
        icon('delete'),
        ' Delete'
      )
    )
  );
  return el('div', { class: 'props-card' }, el('div', { class: 'panel-label' }, 'Selected field'), ...rows);
}

export { findPage };
