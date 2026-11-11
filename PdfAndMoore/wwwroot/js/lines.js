// Lines that are printed in the PDF itself (table borders, underlines, boxes) made movable.
// We read the page's drawing instructions to find straight lines, join the pieces of each line,
// and when you grab one we cover the original with white and put an identical line on top that you
// can drag, nudge, recolor or delete. Lines crossing the covered strip are patched so tables stay whole.
import { state, checkpoint, changed, emit } from './state.js';
import { pdfjsLib } from './doc.js';
import { uid } from './util.js';

const cache = new Map();

function mul(m, n) {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function hexColor(args) {
  if (!args || !args.length) return '#000000';
  if (typeof args[0] === 'string') return args[0];
  const v = args.length === 1 ? [args[0], args[0], args[0]] : args.slice(0, 3);
  const to255 = (x) => Math.round(x <= 1 && v.every((y) => y <= 1) ? x * 255 : x);
  return '#' + v.map((x) => to255(x).toString(16).padStart(2, '0')).join('');
}

/** Straight horizontal/vertical lines printed on a page, in PDF coordinates. */
export async function printedLines(page) {
  const key = page.src + ':' + page.index;
  if (cache.has(key)) return cache.get(key);
  const src = state.doc.sources.find((s) => s.id === page.src);
  const p = await src.pdf.getPage(page.index + 1);
  const ol = await p.getOperatorList({ annotationMode: pdfjsLib.AnnotationMode.DISABLE });
  const O = pdfjsLib.OPS;
  const raw = [];
  let gs = { ctm: [1, 0, 0, 1, 0, 0], lw: 1, fill: '#000000', stroke: '#000000' };
  const stack = [];
  let path = null; // {rects:[[x,y,w,h] in user space corners], segs:[[x1,y1,x2,y2]], curved}
  let skip = 0;
  const addThin = (a, b, thick, color) => raw.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], w: thick, color });
  const paint = (filled, stroked) => {
    if (!path || path.curved) return;
    const scale = Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) || 1;
    for (const r of path.rects) {
      const xs = r.map((q) => q[0]);
      const ys = r.map((q) => q[1]);
      const x1 = Math.min(...xs);
      const x2 = Math.max(...xs);
      const y1 = Math.min(...ys);
      const y2 = Math.max(...ys);
      const w = x2 - x1;
      const h = y2 - y1;
      if (filled) {
        if (h <= 3 && w >= h) addThin([x1, (y1 + y2) / 2], [x2, (y1 + y2) / 2], Math.max(0.3, h), gs.fill);
        else if (w <= 3) addThin([(x1 + x2) / 2, y1], [(x1 + x2) / 2, y2], Math.max(0.3, w), gs.fill);
      }
      if (stroked) {
        const t = Math.max(0.3, gs.lw * scale);
        addThin([x1, y1], [x2, y1], t, gs.stroke);
        addThin([x1, y2], [x2, y2], t, gs.stroke);
        addThin([x1, y1], [x1, y2], t, gs.stroke);
        addThin([x2, y1], [x2, y2], t, gs.stroke);
      }
    }
    if (stroked) for (const s of path.segs) addThin([s[0], s[1]], [s[2], s[3]], Math.max(0.3, gs.lw * scale), gs.stroke);
  };
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    const args = ol.argsArray[i];
    if (fn === O.beginAnnotation) skip++;
    else if (fn === O.endAnnotation) skip = Math.max(0, skip - 1);
    if (skip) continue;
    switch (fn) {
      case O.save:
        stack.push({ ...gs });
        break;
      case O.restore:
        gs = stack.pop() || gs;
        break;
      case O.transform:
        gs.ctm = mul(gs.ctm, args);
        break;
      case O.setLineWidth:
        gs.lw = args[0];
        break;
      case O.setFillRGBColor:
      case O.setFillGray:
        gs.fill = hexColor(args);
        break;
      case O.setStrokeRGBColor:
      case O.setStrokeGray:
        gs.stroke = hexColor(args);
        break;
      case O.constructPath: {
        const [ops, coords] = args;
        path = path || { rects: [], segs: [], curved: false };
        let k = 0;
        let cur = null;
        let start = null;
        for (const op of ops) {
          if (op === O.rectangle) {
            const [x, y, w, h] = coords.slice(k, k + 4);
            k += 4;
            path.rects.push([apply(gs.ctm, x, y), apply(gs.ctm, x + w, y), apply(gs.ctm, x + w, y + h), apply(gs.ctm, x, y + h)]);
          } else if (op === O.moveTo) {
            cur = start = apply(gs.ctm, coords[k], coords[k + 1]);
            k += 2;
          } else if (op === O.lineTo) {
            const nxt = apply(gs.ctm, coords[k], coords[k + 1]);
            k += 2;
            if (cur) path.segs.push([cur[0], cur[1], nxt[0], nxt[1]]);
            cur = nxt;
          } else if (op === O.closePath) {
            if (cur && start) path.segs.push([cur[0], cur[1], start[0], start[1]]);
            cur = start;
          } else if (op === O.curveTo) {
            k += 6;
            path.curved = true;
          } else if (op === O.curveTo2 || op === O.curveTo3) {
            k += 4;
            path.curved = true;
          }
        }
        break;
      }
      case O.fill:
      case O.eoFill:
        paint(true, false);
        path = null;
        break;
      case O.stroke:
      case O.closeStroke:
        paint(false, true);
        path = null;
        break;
      case O.fillStroke:
      case O.eoFillStroke:
      case O.closeFillStroke:
      case O.closeEOFillStroke:
        paint(true, true);
        path = null;
        break;
      case O.endPath:
      case O.clip:
      case O.eoClip:
        if (fn === O.endPath) path = null;
        break;
      default:
    }
  }
  // Keep straight lines only, and join the pieces of each line (Word draws tables as many short pieces).
  const H = [];
  const V = [];
  for (const s of raw) {
    const dx = Math.abs(s.x2 - s.x1);
    const dy = Math.abs(s.y2 - s.y1);
    if (dx < 1.5 && dy < 1.5) continue; // corner dots
    if (dy <= 0.6) H.push({ a: Math.min(s.x1, s.x2), b: Math.max(s.x1, s.x2), c: (s.y1 + s.y2) / 2, w: s.w, color: s.color });
    else if (dx <= 0.6) V.push({ a: Math.min(s.y1, s.y2), b: Math.max(s.y1, s.y2), c: (s.x1 + s.x2) / 2, w: s.w, color: s.color });
  }
  const join = (list) => {
    list.sort((p, q) => p.c - q.c || p.a - q.a);
    const out = [];
    for (const s of list) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.c - s.c) <= 0.8 && s.a <= last.b + 1.6 && last.color === s.color) {
        last.b = Math.max(last.b, s.b);
        last.w = Math.max(last.w, s.w);
      } else out.push({ ...s });
    }
    return out.filter((s) => s.b - s.a >= 6);
  };
  const lines = [
    ...join(H).map((s) => ({ id: uid(), horiz: true, x1: s.a, y1: s.c, x2: s.b, y2: s.c, w: s.w, color: s.color })),
    ...join(V).map((s) => ({ id: uid(), horiz: false, x1: s.c, y1: s.a, x2: s.c, y2: s.b, w: s.w, color: s.color })),
  ];
  // Stable short names (L1, L2, ...) top to bottom, left to right, so people and the AI can point at one.
  lines.sort((p, q) => Math.max(q.y1, q.y2) - Math.max(p.y1, p.y2) || p.x1 - q.x1);
  lines.forEach((l, i) => (l.ref = 'L' + (i + 1)));
  cache.set(key, lines);
  return lines;
}

/** A printed line by its short name ("L12"). */
export async function lineByRef(page, ref) {
  const all = await printedLines(page);
  return all.find((l) => l.ref.toLowerCase() === String(ref).toLowerCase()) || null;
}

/** Printed lines on a page that haven't been taken over already. */
export async function movableLines(page) {
  const all = await printedLines(page);
  // Taken over (moved/restyled) or deleted: a deleted line leaves its white cover behind.
  const taken = new Set(page.annots.flatMap((a) => [a.printedLine, a.coverFor]).filter(Boolean));
  return all.filter((l) => !taken.has(l.id));
}

/** Distance from a PDF point to a line (in PDF units). */
export function distanceTo(l, x, y) {
  const cx = Math.max(Math.min(x, Math.max(l.x1, l.x2)), Math.min(l.x1, l.x2));
  const cy = Math.max(Math.min(y, Math.max(l.y1, l.y2)), Math.min(l.y1, l.y2));
  return Math.hypot(x - cx, y - cy);
}

/**
 * Cover a printed line and put a movable copy on top. Returns the new line item.
 * (Undo restores the original.)
 */
export async function takeOverLine(page, l, { record = true } = {}) {
  if (record) checkpoint();
  const all = await printedLines(page);
  const pad = l.w / 2 + 0.7;
  const cover = l.horiz
    ? { x1: l.x1 - 0.6, x2: l.x2 + 0.6, y1: l.y1 - pad, y2: l.y1 + pad }
    : { x1: l.x1 - pad, x2: l.x1 + pad, y1: l.y1 - 0.6, y2: l.y2 + 0.6 };
  // White-outs and patches go underneath everything else, so they never hide a line moved earlier.
  const under = [];
  under.push({ id: uid(), type: 'rect', ...cover, stroke: null, fill: '#ffffff', width: 0, opacity: 1, fixed: true, coverFor: l.id });
  // Put back the bits of crossing lines that the white strip would cut (unless those were moved or deleted too).
  const gone = new Set(page.annots.filter((a) => a.coverFor && a.type === 'rect').map((a) => a.coverFor));
  for (const o of all) {
    if (o.id === l.id || o.horiz === l.horiz || gone.has(o.id)) continue;
    if (l.horiz && o.x1 >= cover.x1 && o.x1 <= cover.x2 && o.y1 <= cover.y2 && o.y2 >= cover.y1) {
      under.push({ id: uid(), type: 'line', pts: [[o.x1, Math.max(o.y1, cover.y1)], [o.x1, Math.min(o.y2, cover.y2)]], stroke: o.color, width: o.w, butt: true, fixed: true, coverFor: l.id });
    } else if (!l.horiz && o.y1 >= cover.y1 && o.y1 <= cover.y2 && o.x1 <= cover.x2 && o.x2 >= cover.x1) {
      under.push({ id: uid(), type: 'line', pts: [[Math.max(o.x1, cover.x1), o.y1], [Math.min(o.x2, cover.x2), o.y1]], stroke: o.color, width: o.w, butt: true, fixed: true, coverFor: l.id });
    }
  }
  // After earlier white-outs/patches (and OCR text layers), before anything the user added.
  let at = 0;
  while (at < page.annots.length && (page.annots[at].coverFor || page.annots[at].type === 'ocrtext')) at++;
  page.annots.splice(at, 0, ...under);
  const line = { id: uid(), type: 'line', pts: [[l.x1, l.y1], [l.x2, l.y2]], stroke: l.color || '#000000', width: l.w, butt: true, printedLine: l.id };
  page.annots.push(line);
  if (record) changed();
  return line;
}

/** Find the printed line meant by "the line under Comments", "the line above Signature", "the top line". */
export async function printedLineNear(page, hit, position = 'below') {
  const lines = await movableLines(page);
  const midX = (hit.x1 + hit.x2) / 2;
  let best = null;
  let bestD = Infinity;
  for (const l of lines) {
    if (l.horiz) {
      const overlapX = Math.min(l.x2, hit.x2) - Math.max(l.x1, hit.x1);
      if (overlapX <= 0 && Math.abs(midX - (l.x1 + l.x2) / 2) > (l.x2 - l.x1) / 2 + 30) continue;
      const d = position === 'above' ? l.y1 - hit.y2 : hit.y1 - l.y1;
      if (d < -2) continue;
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    } else if (position === 'left' || position === 'right') {
      if (l.y1 > hit.y2 || l.y2 < hit.y1) continue;
      const d = position === 'left' ? hit.x1 - l.x1 : l.x1 - hit.x2;
      if (d < -2) continue;
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
  }
  return bestD < 120 ? best : null;
}

export function clearLineCache() {
  cache.clear();
}

export function emitLines() {
  emit('annots');
}
