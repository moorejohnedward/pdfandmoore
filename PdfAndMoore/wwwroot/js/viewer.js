// Page view: renders pages, the selectable text layer, annotations, form fields,
// and handles every drawing / editing tool on the page.
import { pdfjsLib, totalRotation, boxInView, rightVec, downVec } from './doc.js';
import { state, emit, on, checkpoint, changed, findPage, findAnnot } from './state.js';
import { el, icon, $, uid, clamp, toast } from './util.js';
import * as printed from './lines.js';

const CSS_DPI = 96 / 72; // 100% zoom shows a page at its real printed size
const views = new Map(); // pageId -> PageView
let observer;
let container;
let pendingPlacement = null; // { kind:'image', dataUrl, w, h } waiting for a click on the page
let regionCallback = null; // called with { page, rect } for the "grab text from area" tool

export function cssScale() {
  return state.zoom * CSS_DPI;
}

const FONT_CSS = {
  Helvetica: 'Arial, Helvetica, sans-serif',
  Times: '"Times New Roman", Times, serif',
  Courier: '"Courier New", Courier, monospace',
};

// ---------------------------------------------------------------------------
// Page view objects
// ---------------------------------------------------------------------------
class PageView {
  constructor(page) {
    this.page = page;
    this.rendered = false;
    this.renderTask = null;
    this.textLayer = null;
    this.viewport = null;
    this.div = el('div', { class: 'page', 'data-page-id': page.id });
    this.canvas = el('canvas', { class: 'page-canvas' });
    this.textDiv = el('div', { class: 'textLayer' });
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('annot-svg');
    this.htmlLayer = el('div', { class: 'annot-html' });
    this.formLayer = el('div', { class: 'form-layer' });
    this.interact = el('div', { class: 'interact-layer' });
    this.label = el('div', { class: 'page-label' });
    this.div.append(this.canvas, this.textDiv, this.svg, this.formLayer, this.htmlLayer, this.interact, this.label);
    attachPageHandlers(this);
  }

  get source() {
    return state.doc.sources.find((s) => s.id === this.page.src);
  }

  async ensureViewport() {
    const p = await this.source.pdf.getPage(this.page.index + 1);
    this.pdfPage = p;
    this.viewport = p.getViewport({ scale: cssScale(), rotation: totalRotation(this.page) });
    return this.viewport;
  }

  /** Set the page box size without rendering (cheap; used for every page). */
  layout() {
    const rot = totalRotation(this.page);
    const w = (rot % 180 === 0 ? this.page.w : this.page.h) * cssScale();
    const h = (rot % 180 === 0 ? this.page.h : this.page.w) * cssScale();
    this.div.style.width = w + 'px';
    this.div.style.height = h + 'px';
    const n = state.doc.pages.indexOf(this.page) + 1;
    this.label.textContent = `${n}`;
  }

  async render() {
    // Only the latest request draws; an older one in progress is cancelled first.
    const seq = (this.renderSeq = (this.renderSeq || 0) + 1);
    if (this.renderTask) {
      try {
        this.renderTask.cancel();
        await this.renderTask.promise;
      } catch {}
      this.renderTask = null;
    }
    const vp = await this.ensureViewport();
    if (seq !== this.renderSeq) return;
    const dpr = window.devicePixelRatio || 1;
    const canvas = this.canvas;
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, vp.width, vp.height);
    this.renderTask = this.pdfPage.render({
      canvasContext: ctx,
      viewport: vp,
      // Fillable fields are drawn by our own form layer, so hide their PDF appearance.
      annotationMode: pdfjsLib.AnnotationMode.ENABLE,
    });
    const task = this.renderTask;
    try {
      await task.promise;
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      throw e;
    }
    if (this.renderTask === task) this.renderTask = null;
    if (seq !== this.renderSeq) return;
    this.rendered = true;
    await this.renderTextLayer();
    this.renderAnnots();
    this.renderForms();
  }

  async renderTextLayer() {
    this.textDiv.replaceChildren();
    this.textDiv.style.setProperty('--scale-factor', this.viewport.scale);
    this.div.style.setProperty('--scale-factor', this.viewport.scale);
    try {
      const tl = new pdfjsLib.TextLayer({
        textContentSource: this.pdfPage.streamTextContent(),
        container: this.textDiv,
        viewport: this.viewport,
      });
      await tl.render();
      this.textLayer = tl;
      applySearchHighlight(this);
    } catch (e) {
      console.warn('text layer', e);
    }
  }

  release() {
    if (!this.rendered) return;
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.textDiv.replaceChildren();
    this.rendered = false;
  }

  // ---- coordinate conversion ----
  toView(x, y) {
    return this.viewport.convertToViewportPoint(x, y);
  }
  toUser(vx, vy) {
    return this.viewport.convertToPdfPoint(vx, vy);
  }
  /** Mouse event -> view coordinates relative to the page box. */
  eventPoint(e) {
    const r = this.div.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  userRectToView(x1, y1, x2, y2) {
    const a = this.toView(x1, y1);
    const b = this.toView(x2, y2);
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
  }

  // ---- annotations ----
  renderAnnots() {
    if (!this.viewport) return;
    const svg = this.svg;
    const vp = this.viewport;
    svg.setAttribute('width', vp.width);
    svg.setAttribute('height', vp.height);
    svg.replaceChildren();
    this.htmlLayer.replaceChildren();
    const s = cssScale();
    const viewRot = totalRotation(this.page);
    const sel = state.selectedAnnot && state.selectedAnnot.pageId === this.page.id ? state.selectedAnnot.annotId : null;

    if (state.tool === 'lines') this.renderLineHints(svg);
    for (const a of this.page.annots) {
      const g = svgEl('g', { 'data-id': a.id, class: 'annot' + (a.id === sel ? ' selected' : '') + (a.fixed ? ' fixed' : '') });
      if (a.type === 'highlight' || a.type === 'underline' || a.type === 'strike') {
        for (const r of a.rects) {
          const v = this.userRectToView(...r);
          if (a.type === 'highlight') {
            g.append(svgEl('rect', { x: v.x, y: v.y, width: v.w, height: v.h, fill: a.color, 'fill-opacity': 0.4, style: 'mix-blend-mode:multiply' }));
          } else {
            const { tl, w, h } = boxInView(...r, a.rot || 0);
            const R = rightVec(a.rot || 0);
            const D = downVec(a.rot || 0);
            const off = a.type === 'underline' ? h * 0.92 : h * 0.55;
            const p0 = [tl[0] + D[0] * off, tl[1] + D[1] * off];
            const p1 = [p0[0] + R[0] * w, p0[1] + R[1] * w];
            const v0 = this.toView(...p0);
            const v1 = this.toView(...p1);
            g.append(svgEl('line', { x1: v0[0], y1: v0[1], x2: v1[0], y2: v1[1], stroke: a.color, 'stroke-width': Math.max(1, h * 0.07 * s) }));
            g.append(svgEl('rect', { x: v.x, y: v.y, width: v.w, height: v.h, fill: 'transparent' }));
          }
        }
      } else if (a.type === 'rect' || a.type === 'ellipse' || a.type === 'field') {
        const v = this.userRectToView(a.x1, a.y1, a.x2, a.y2);
        if (a.type === 'field') {
          if (state.formMode !== 'edit') continue; // shown as a real input by the form layer
          const colors = { text: '#1a73e8', date: '#1a73e8', dropdown: '#1a73e8', checkbox: '#188038', radio: '#188038', signature: '#b06000' };
          const c = colors[a.kind] || '#1a73e8';
          g.append(svgEl('rect', { x: v.x, y: v.y, width: v.w, height: v.h, rx: a.kind === 'radio' ? Math.min(v.w, v.h) / 2 : 2, fill: c + '1f', stroke: c, 'stroke-width': 1.2 }));
          if (v.h >= 9 && v.w >= 44) {
            const fs = Math.max(8, Math.min(11, v.h * 0.7));
            const label = svgEl('text', { x: v.x + 3, y: v.y + v.h / 2 + fs * 0.35, 'font-size': fs, fill: c, class: 'field-name' });
            const prefix = { signature: '✍ ', date: '📅 ', dropdown: '▾ ' }[a.kind] || '';
            label.textContent = prefix + a.name;
            g.append(label);
            const clip = svgEl('clipPath', { id: 'clip-' + a.id });
            clip.append(svgEl('rect', { x: v.x, y: v.y, width: v.w, height: v.h }));
            g.append(clip);
            label.setAttribute('clip-path', `url(#clip-${a.id})`);
          }
          if (a.required) g.append(svgEl('circle', { cx: v.x + v.w - 3, cy: v.y + 3, r: 2.5, fill: '#d93025' }));
        } else {
          const attrs = {
            fill: a.fill || 'transparent',
            stroke: a.stroke || 'none',
            'stroke-width': (a.width || 2) * s,
            opacity: a.opacity ?? 1,
          };
          if (a.type === 'rect') g.append(svgEl('rect', { x: v.x, y: v.y, width: v.w, height: v.h, ...attrs }));
          else g.append(svgEl('ellipse', { cx: v.x + v.w / 2, cy: v.y + v.h / 2, rx: v.w / 2, ry: v.h / 2, ...attrs }));
        }
      } else if (a.type === 'line' || a.type === 'arrow' || a.type === 'ink') {
        const pts = a.pts.map((p) => this.toView(...p));
        const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
        const common = { fill: 'none', stroke: a.stroke, 'stroke-width': (a.width || 2) * s, 'stroke-linecap': a.butt ? 'butt' : 'round', 'stroke-linejoin': 'round', opacity: a.opacity ?? 1 };
        g.append(svgEl('path', { d, ...common }));
        g.append(svgEl('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(12, (a.width || 2) * s + 8) }));
        if (a.type === 'arrow' && pts.length > 1) {
          const [p0, p1] = [pts[0], pts[pts.length - 1]];
          const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
          const len = (6 + (a.width || 2) * 3) * s;
          const head = [-1, 1].map((sg) => [p1[0] + len * Math.cos(ang + Math.PI + (sg * Math.PI) / 7), p1[1] + len * Math.sin(ang + Math.PI + (sg * Math.PI) / 7)]);
          g.append(svgEl('path', { d: `M${head[0][0]} ${head[0][1]} L${p1[0]} ${p1[1]} L${head[1][0]} ${head[1][1]}`, ...common }));
        }
      } else if (a.type === 'text') {
        this.htmlLayer.append(this.textAnnotEl(a, viewRot, a.id === sel));
        continue;
      } else if (a.type === 'image') {
        const { tl, w, h } = boxInView(a.x1, a.y1, a.x2, a.y2, a.rot || 0);
        const p = this.toView(...tl);
        const img = el('img', {
          class: 'annot-img' + (a.id === sel ? ' selected' : ''),
          src: a.dataUrl,
          'data-id': a.id,
          draggable: 'false',
          style: {
            left: p[0] + 'px',
            top: p[1] + 'px',
            width: w * s + 'px',
            height: h * s + 'px',
            transform: `rotate(${viewRot - (a.rot || 0)}deg)`,
          },
        });
        this.htmlLayer.append(img);
        if (a.id === sel) this.htmlLayer.append(this.resizeHandle(a, img));
        continue;
      } else if (a.type === 'note') {
        const p = this.toView(a.x, a.y);
        const n = el(
          'div',
          { class: 'annot-note' + (a.id === sel ? ' selected' : ''), 'data-id': a.id, title: a.text || 'Comment', style: { left: p[0] + 'px', top: p[1] + 'px', background: a.color } },
          icon('chat_bubble')
        );
        this.htmlLayer.append(n);
        continue;
      } else if (a.type === 'ocrtext') {
        continue; // invisible
      } else if (a.type === 'redact') {
        // Marked for redaction: red outline now, solid black once applied.
        const v = this.userRectToView(a.x1, a.y1, a.x2, a.y2);
        g.append(svgEl('rect', { x: v.x, y: v.y, width: v.w, height: v.h, fill: '#d93025', 'fill-opacity': 0.22, stroke: '#d93025', 'stroke-width': 1.5, 'stroke-dasharray': '5 3' }));
        if (v.w > 46 && v.h > 9) {
          const fs = Math.max(7, Math.min(10, v.h * 0.6));
          const t = svgEl('text', { x: v.x + 3, y: v.y + fs + 1, 'font-size': fs, fill: '#a50e0e', 'font-weight': 700 });
          t.textContent = 'REDACT';
          g.append(t);
        }
      }
      svg.append(g);
      if (a.id === sel && ['rect', 'ellipse', 'field', 'redact'].includes(a.type)) {
        const v = this.userRectToView(a.x1, a.y1, a.x2, a.y2);
        svg.append(svgEl('rect', { class: 'sel-outline', x: v.x - 3, y: v.y - 3, width: v.w + 6, height: v.h + 6 }));
        const fake = { getBoundingClientRect: () => null, _v: v };
        this.htmlLayer.append(this.resizeHandle(a, fake));
      } else if (a.id === sel) {
        const bb = g.getBBox ? safeBBox(g) : null;
        if (bb) svg.append(svgEl('rect', { class: 'sel-outline', x: bb.x - 3, y: bb.y - 3, width: bb.width + 6, height: bb.height + 6 }));
      }
    }
  }

  /** "Move lines" tool: show the page's own lines that can be grabbed. */
  renderLineHints(svg) {
    const key = this.page.src + ':' + this.page.index;
    if (this._lines && this._linesKey === key) {
      const taken = new Set(this.page.annots.filter((a) => a.printedLine).map((a) => a.printedLine));
      for (const l of this._lines) {
        if (taken.has(l.id)) continue;
        const a = this.toView(l.x1, l.y1);
        const b = this.toView(l.x2, l.y2);
        svg.append(svgEl('line', { class: 'line-hint', x1: a[0], y1: a[1], x2: b[0], y2: b[1] }));
      }
      return;
    }
    printed.printedLines(this.page).then((lines) => {
      this._lines = lines;
      this._linesKey = key;
      if (state.tool === 'lines') this.renderAnnots();
    });
  }

  textAnnotEl(a, viewRot, selected) {
    const s = cssScale();
    const p = this.toView(a.x, a.y);
    const box = el('div', {
      class: 'annot-text' + (selected ? ' selected' : ''),
      'data-id': a.id,
      style: {
        left: p[0] + 'px',
        top: p[1] + 'px',
        fontSize: (a.size || 12) * s + 'px',
        fontFamily: FONT_CSS[a.font || 'Helvetica'],
        fontWeight: a.bold ? '700' : '400',
        color: a.color,
        opacity: a.opacity ?? 1,
        background: a.bg || 'transparent',
        boxShadow: a.border ? `inset 0 0 0 ${Math.max(1, (a.borderWidth || 1) * s)}px ${a.border}` : null,
        width: a.w ? a.w * s + 'px' : null,
        minWidth: a.minW ? a.minW * s + 'px' : null,
        whiteSpace: a.w ? 'pre-wrap' : 'pre',
        transform: `rotate(${viewRot - (a.rot || 0)}deg)`,
      },
    });
    box.textContent = a.text || '';
    box.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startTextEdit(this, a, box);
    });
    if (selected) {
      const h = el('div', { class: 'text-width-handle', title: 'Drag to set width' });
      h.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        checkpoint();
        const startX = e.clientX;
        const startW = box.getBoundingClientRect().width / s;
        const move = (ev) => {
          a.w = Math.max(20, startW + (ev.clientX - startX) / s);
          box.style.width = a.w * s + 'px';
          box.style.whiteSpace = 'pre-wrap';
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          changed();
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });
      box.append(h);
    }
    return box;
  }

  /** Bottom-right resize handle for box-shaped annotations. */
  resizeHandle(a, node) {
    const s = cssScale();
    let v;
    if (node._v) v = node._v;
    else {
      const { tl, w, h } = boxInView(a.x1, a.y1, a.x2, a.y2, a.rot || 0);
      const p = this.toView(...tl);
      v = { x: p[0], y: p[1], w: w * s, h: h * s };
    }
    const handle = el('div', { class: 'resize-handle', style: { left: v.x + v.w - 6 + 'px', top: v.y + v.h - 6 + 'px' } });
    handle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      checkpoint();
      const startTL = this.toUser(v.x, v.y);
      const aspect = v.w / Math.max(1, v.h);
      const keepAspect = a.type === 'image';
      const move = (ev) => {
        let [px, py] = this.eventPoint(ev);
        px = Math.max(v.x + 8, px);
        py = Math.max(v.y + 8, py);
        if (keepAspect) py = v.y + (px - v.x) / aspect;
        const br = this.toUser(px, py);
        a.x1 = Math.min(startTL[0], br[0]);
        a.x2 = Math.max(startTL[0], br[0]);
        a.y1 = Math.min(startTL[1], br[1]);
        a.y2 = Math.max(startTL[1], br[1]);
        this.renderAnnots();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        changed();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    return handle;
  }

  // ---- fillable form fields ----
  renderForms() {
    this.formLayer.replaceChildren();
    if (!this.viewport) return;
    if (state.formMode !== 'edit') this.renderFieldAnnotInputs();
    const prepared = state.doc.prepared && state.doc.prepared[this.page.src];
    const fields = (!prepared && state.doc.fields && state.doc.fields[this.page.src]) || [];
    if (!fields.length || state.formMode === 'edit') return;
    const values = (state.doc.formValues[this.page.src] = state.doc.formValues[this.page.src] || {});
    const s = cssScale();
    for (const f of fields) {
      f.widgets.forEach((w) => {
        if (w.pageIndex !== this.page.index) return;
        const v = this.userRectToView(...w.rect);
        const style = { left: v.x + 'px', top: v.y + 'px', width: v.w + 'px', height: v.h + 'px', fontSize: Math.max(8, Math.min(v.h * 0.65, 14 * s)) + 'px' };
        const cur = f.name in values ? values[f.name] : f.value;
        let input;
        const set = (val) => {
          checkpoint();
          values[f.name] = val;
          changed();
        };
        if (f.kind === 'text') {
          const multi = v.h > 40 * s;
          input = el(multi ? 'textarea' : 'input', { class: 'form-input', style, title: f.name, disabled: f.readOnly });
          input.value = cur || '';
          input.addEventListener('change', () => set(input.value));
        } else if (f.kind === 'checkbox') {
          input = el('input', { type: 'checkbox', class: 'form-check', style, title: f.name, disabled: f.readOnly });
          input.checked = !!cur;
          input.addEventListener('change', () => set(input.checked));
        } else if (f.kind === 'radio') {
          input = el('input', { type: 'radio', class: 'form-check', name: this.page.id + f.name, style, title: f.name, disabled: f.readOnly });
          input.checked = cur === w.onValue;
          input.addEventListener('change', () => input.checked && set(w.onValue));
        } else if (f.kind === 'dropdown') {
          input = el('select', { class: 'form-input', style, title: f.name, disabled: f.readOnly }, el('option', { value: '' }, ''), f.options.map((o) => el('option', { value: o }, o)));
          input.value = cur || '';
          input.addEventListener('change', () => set(input.value));
        }
        if (input) {
          input.addEventListener('mousedown', (e) => e.stopPropagation());
          input.addEventListener('keydown', (e) => e.stopPropagation());
          this.formLayer.append(input);
        }
      });
    }
  }
}

PageView.prototype.renderFieldAnnotInputs = function () {
  const s = cssScale();
  const radios = {};
  for (const a of this.page.annots) {
    if (a.type !== 'field') continue;
    const v = this.userRectToView(a.x1, a.y1, a.x2, a.y2);
    const style = { left: v.x + 'px', top: v.y + 'px', width: v.w + 'px', height: v.h + 'px', fontSize: (a.fontSize ? a.fontSize * s : Math.max(8, Math.min(v.h * 0.65, 13 * s))) + 'px' };
    const set = (val) => {
      checkpoint();
      a.value = val;
      changed();
    };
    let input;
    if (a.kind === 'text' || a.kind === 'date') {
      input = el(a.multiline ? 'textarea' : 'input', { class: 'form-input' + (a.border ? ' bordered' : ''), style, title: a.name, placeholder: a.kind === 'date' ? 'mm/dd/yyyy' : '' });
      input.value = a.value || '';
      input.addEventListener('change', () => set(input.value));
      if (a.kind === 'date') {
        input.addEventListener('dblclick', () => {
          const t = new Date();
          input.value = `${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')}/${t.getFullYear()}`;
          set(input.value);
        });
        input.title = a.name + ' (double-click for today)';
      }
    } else if (a.kind === 'checkbox') {
      input = el('input', { type: 'checkbox', class: 'form-check', style, title: a.name });
      input.checked = !!a.value;
      input.addEventListener('change', () => set(input.checked));
    } else if (a.kind === 'radio') {
      input = el('input', { type: 'radio', class: 'form-check', name: this.page.id + '|' + a.name, style, title: a.name + ': ' + (a.onValue || '') });
      input.checked = !!a.value;
      radios[a.name] = radios[a.name] || [];
      radios[a.name].push(a);
      input.addEventListener('change', () => {
        if (!input.checked) return;
        checkpoint();
        // One choice per group, across every page.
        state.doc.pages.forEach((p) => p.annots.forEach((b) => b.type === 'field' && b.kind === 'radio' && b.name === a.name && (b.value = b === a)));
        changed();
      });
    } else if (a.kind === 'dropdown') {
      input = el('select', { class: 'form-input' + (a.border ? ' bordered' : ''), style, title: a.name }, el('option', { value: '' }, ''), (a.options || []).map((o) => el('option', { value: o }, o)));
      input.value = a.value || '';
      input.addEventListener('change', () => set(input.value));
    } else if (a.kind === 'signature') {
      input = el('button', { class: 'form-sign' + (a.sig ? ' signed' : ''), style, title: 'Click to sign' });
      if (a.sig) input.append(el('img', { src: a.sig }));
      else input.append(icon('signature'), el('span', {}, 'Sign here'));
      input.addEventListener('click', () => emit('signfield', { page: this.page, annot: a }));
    }
    if (input) {
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      input.addEventListener('keydown', (e) => e.stopPropagation());
      this.formLayer.append(input);
    }
  }
};

function safeBBox(g) {
  try {
    return g.getBBox();
  } catch {
    return null;
  }
}

function svgEl(tag, attrs) {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, v);
  return n;
}

// ---------------------------------------------------------------------------
// Building / refreshing the page list
// ---------------------------------------------------------------------------
export function initViewer(root) {
  container = root;
  observer = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        const view = views.get(en.target.dataset.pageId);
        if (!view) continue;
        view.visible = en.isIntersecting;
        if (en.isIntersecting && !view.rendered) view.render().catch((e) => console.error(e));
      }
    },
    { root: container, rootMargin: '600px 0px' }
  );
  container.addEventListener('scroll', onScroll, { passive: true });
  container.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey || !state.doc) return;
      e.preventDefault();
      setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), { anchorEvent: e });
    },
    { passive: false }
  );
  on('structure', () => rebuild());
  on('annots', () => views.forEach((v) => v.rendered && v.renderAnnots()));
  on('forms', () => views.forEach((v) => v.rendered && v.renderForms()));
  on('selection', () => views.forEach((v) => v.rendered && v.renderAnnots()));
  on('tool', () => views.forEach((v) => v.rendered && v.renderAnnots()));
  document.addEventListener('mouseup', onTextSelectionEnd);
  window.addEventListener('resize', () => {
    if (state.fitMode) applyFit();
  });
}

let farReleaseTimer;
function onScroll() {
  if (!state.doc) return;
  // Work out which page is in the middle of the screen.
  const mid = container.scrollTop + container.clientHeight / 3;
  let current = 0;
  state.doc.pages.forEach((p, i) => {
    const v = views.get(p.id);
    if (v && v.div.offsetTop <= mid) current = i;
  });
  if (current !== state.currentPage) {
    state.currentPage = current;
    emit('pagechange', current);
  }
  // Free memory used by pages far off screen.
  clearTimeout(farReleaseTimer);
  farReleaseTimer = setTimeout(() => {
    state.doc &&
      state.doc.pages.forEach((p, i) => {
        if (Math.abs(i - state.currentPage) > 12) views.get(p.id)?.release();
      });
  }, 400);
}

/** Rebuild the page list (after open, reorder, rotate, insert, undo...). */
export function rebuild() {
  if (!container) return;
  observer.disconnect();
  const list = $('#pageList');
  list.replaceChildren();
  if (!state.doc) {
    views.clear();
    return;
  }
  const keep = new Map();
  for (const page of state.doc.pages) {
    let v = views.get(page.id);
    if (!v || v.page !== page || v.lastRot !== totalRotation(page)) {
      v = new PageView(page);
    }
    v.page = page;
    v.lastRot = totalRotation(page);
    keep.set(page.id, v);
    v.layout();
    list.append(v.div);
    observer.observe(v.div);
  }
  views.clear();
  keep.forEach((v, k) => views.set(k, v));
  views.forEach((v) => {
    if (v.rendered) {
      v.render();
    }
  });
  state.currentPage = clamp(state.currentPage, 0, state.doc.pages.length - 1);
  emit('pagechange', state.currentPage);
  if (state.fitMode) requestAnimationFrame(() => applyFit());
}

export function setZoom(z, { fit = null, anchorEvent = null } = {}) {
  if (!state.doc) return;
  const old = state.zoom;
  state.zoom = clamp(z, 0.25, 5);
  state.fitMode = fit;
  const ratio = state.zoom / old;
  let anchorY = container.clientHeight / 2;
  let anchorX = container.clientWidth / 2;
  if (anchorEvent) {
    const r = container.getBoundingClientRect();
    anchorY = anchorEvent.clientY - r.top;
    anchorX = anchorEvent.clientX - r.left;
  }
  const top = (container.scrollTop + anchorY) * ratio - anchorY;
  const left = (container.scrollLeft + anchorX) * ratio - anchorX;
  views.forEach((v) => {
    v.layout();
    v.rendered = false;
  });
  container.scrollTop = top;
  container.scrollLeft = left;
  views.forEach((v) => {
    if (v.visible) v.render();
  });
  emit('zoom', state.zoom);
}

export function applyFit(mode = state.fitMode) {
  if (!state.doc || !mode) return;
  const page = state.doc.pages[state.currentPage] || state.doc.pages[0];
  const rot = totalRotation(page);
  // Fit the widest page so a landscape page in a portrait document still fits on screen.
  const pw = Math.max(...state.doc.pages.map((p) => (totalRotation(p) % 180 === 0 ? p.w : p.h)));
  const ph = rot % 180 === 0 ? page.h : page.w;
  const availW = container.clientWidth - 64;
  const availH = container.clientHeight - 32;
  const zw = availW / (pw * CSS_DPI);
  const zh = availH / (ph * CSS_DPI);
  setZoom(mode === 'width' ? Math.min(zw, 2) : Math.min(zw, zh), { fit: mode });
}

export function scrollToPage(i, { smooth = true } = {}) {
  const page = state.doc && state.doc.pages[i];
  if (!page) return;
  const v = views.get(page.id);
  if (v) container.scrollTo({ top: v.div.offsetTop - 16, behavior: smooth ? 'smooth' : 'auto' });
}

export function getView(pageId) {
  return views.get(pageId);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const CURSORS = {
  select: '',
  hand: 'grab',
  text: 'text',
  draw: 'crosshair',
  rect: 'crosshair',
  ellipse: 'crosshair',
  line: 'crosshair',
  arrow: 'crosshair',
  whiteout: 'crosshair',
  redact: 'crosshair',
  lines: 'pointer',
  note: 'copy',
  edittext: 'text',
  'field-text': 'crosshair',
  'field-checkbox': 'crosshair',
  'field-radio': 'crosshair',
  'field-dropdown': 'crosshair',
  'field-date': 'crosshair',
  'field-signature': 'crosshair',
  region: 'crosshair',
  place: 'copy',
  highlight: 'text',
  underline: 'text',
  strike: 'text',
};

export function setTool(tool) {
  state.tool = tool;
  if (tool !== 'place') pendingPlacement = null;
  if (tool !== 'region') regionCallback = null;
  document.body.dataset.tool = tool;
  $('#pageList') && ($('#pageList').style.cursor = CURSORS[tool] || '');
  emit('tool', tool);
}

/** Next click on a page places an image (signature, picture). */
export function placeImage(dataUrl, naturalW, naturalH) {
  const maxW = 220;
  const scale = Math.min(1, maxW / naturalW);
  pendingPlacement = { dataUrl, w: naturalW * scale, h: naturalH * scale };
  setTool('place');
  toast('Click on the page where you want to place it.');
}

/** Next drag on a page selects an area; cb({page, view, rect}) receives it. */
export function pickRegion(cb) {
  setTool('region');
  regionCallback = cb;
  toast('Drag a box around the text you want to grab.');
}

function newAnnot(page, a) {
  checkpoint();
  a.id = uid();
  page.annots.push(a);
  state.selectedAnnot = { pageId: page.id, annotId: a.id };
  changed();
  emit('selection');
  return a;
}

function attachPageHandlers(view) {
  view.interact.addEventListener('mousedown', (e) => onPageMouseDown(view, e));
  view.htmlLayer.addEventListener('mousedown', (e) => onAnnotMouseDown(view, e));
  view.svg.addEventListener('mousedown', (e) => onAnnotMouseDown(view, e));
  view.textDiv.addEventListener('mousedown', (e) => {
    if (state.tool === 'edittext') onEditTextClick(view, e);
  });
  // With the Select tool, clicking empty page space clears the selection.
  view.div.addEventListener('mousedown', (e) => {
    if (state.tool !== 'select' || !state.selectedAnnot) return;
    if (e.target.closest('[data-id], .resize-handle, .text-width-handle, .note-popup, .form-layer > *')) return;
    state.selectedAnnot = null;
    emit('selection');
  });
}

function onAnnotMouseDown(view, e) {
  if (state.tool !== 'select' || e.button !== 0) return;
  const target = e.target.closest('[data-id]');
  if (!target) return;
  const id = target.dataset.id;
  const a = view.page.annots.find((x) => x.id === id);
  if (!a || a.fixed) return;
  if (target.isContentEditable) return;
  e.preventDefault();
  e.stopPropagation();
  state.selectedAnnot = { pageId: view.page.id, annotId: id };
  emit('selection');
  emit('annotselected', a);
  if (a.type === 'note') {
    openNoteEditor(view, a);
    return;
  }
  // Drag to move.
  const start = view.eventPoint(e);
  let moved = false;
  const orig = JSON.parse(JSON.stringify(a));
  const move = (ev) => {
    const p = view.eventPoint(ev);
    if (!moved && Math.hypot(p[0] - start[0], p[1] - start[1]) < 3) return;
    if (!moved) {
      checkpoint();
      moved = true;
    }
    const u0 = view.toUser(...start);
    const u1 = view.toUser(...p);
    const dx = u1[0] - u0[0];
    const dy = u1[1] - u0[1];
    moveAnnot(a, orig, dx, dy);
    view.renderAnnots();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (moved) changed();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function moveAnnot(a, orig, dx, dy) {
  if ('x1' in orig) {
    a.x1 = orig.x1 + dx;
    a.x2 = orig.x2 + dx;
    a.y1 = orig.y1 + dy;
    a.y2 = orig.y2 + dy;
  }
  if ('x' in orig) {
    a.x = orig.x + dx;
    a.y = orig.y + dy;
  }
  if (orig.pts) a.pts = orig.pts.map((p) => [p[0] + dx, p[1] + dy]);
  if (orig.rects) a.rects = orig.rects.map((r) => [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]);
}

/**
 * "Move lines" tool: grab any line on the page — one you drew or one printed in the PDF —
 * and drag it. Printed lines keep their direction (hold Shift to move freely).
 */
async function grabLine(view, e, p0) {
  e.preventDefault();
  const page = view.page;
  const [ux, uy] = view.toUser(...p0);
  const s = cssScale();
  const reach = 7 / s; // about 7 screen pixels
  let best = null;
  let bestD = reach;
  for (const a of page.annots) {
    if (a.fixed || !(a.type === 'line' || a.type === 'arrow') || !a.pts) continue;
    const l = { x1: a.pts[0][0], y1: a.pts[0][1], x2: a.pts[a.pts.length - 1][0], y2: a.pts[a.pts.length - 1][1] };
    const d = printed.distanceTo({ x1: Math.min(l.x1, l.x2), x2: Math.max(l.x1, l.x2), y1: Math.min(l.y1, l.y2), y2: Math.max(l.y1, l.y2) }, ux, uy);
    if (d < bestD) {
      bestD = d;
      best = { annot: a };
    }
  }
  if (!best) {
    for (const l of await printed.movableLines(page)) {
      const d = printed.distanceTo(l, ux, uy);
      if (d < bestD) {
        bestD = d;
        best = { line: l };
      }
    }
  }
  if (!best) {
    toast('Click right on a line (the blue ones can be moved).');
    return;
  }
  checkpoint();
  const annot = best.annot || (await printed.takeOverLine(page, best.line, { record: false }));
  state.selectedAnnot = { pageId: page.id, annotId: annot.id };
  const startPts = annot.pts.map((p) => [...p]);
  const horiz = Math.abs(startPts[0][1] - startPts[startPts.length - 1][1]) < 0.5;
  const vert = Math.abs(startPts[0][0] - startPts[startPts.length - 1][0]) < 0.5;
  const lock = !!annot.printedLine;
  const move = (ev) => {
    const [mx, my] = view.toUser(...view.eventPoint(ev));
    let dx = mx - ux;
    let dy = my - uy;
    if (lock && !ev.shiftKey) {
      if (horiz) dx = 0;
      else if (vert) dy = 0;
    }
    annot.pts = startPts.map((p) => [p[0] + dx, p[1] + dy]);
    view.renderAnnots();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    changed();
    emit('selection');
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  view.renderAnnots();
}

function onPageMouseDown(view, e) {
  if (e.button !== 0 || !view.viewport) return;
  // Don't let the page's "click empty space to deselect" handler undo what this tool just did.
  if (state.tool !== 'select') e.stopPropagation();
  const tool = state.tool;
  const p0 = view.eventPoint(e);
  const props = state.props;
  const rot = totalRotation(view.page);

  if (tool === 'lines') {
    grabLine(view, e, p0);
    return;
  }
  if (tool === 'select') {
    // Clicking empty page space clears the selection.
    if (state.selectedAnnot) {
      state.selectedAnnot = null;
      emit('selection');
    }
    return;
  }
  if (tool === 'hand') {
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const st = container.scrollTop;
    const sl = container.scrollLeft;
    const move = (ev) => {
      container.scrollTop = st - (ev.clientY - sy);
      container.scrollLeft = sl - (ev.clientX - sx);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return;
  }
  if (tool === 'text') {
    e.preventDefault();
    const [x, y] = view.toUser(p0[0], p0[1] - props.fontSize * cssScale() * 0.6);
    const a = newAnnot(view.page, { type: 'text', x, y, rot, size: props.fontSize, color: props.color, font: props.font, bold: props.bold, text: '' });
    requestAnimationFrame(() => {
      const box = view.htmlLayer.querySelector(`[data-id="${a.id}"]`);
      if (box) startTextEdit(view, a, box, true);
    });
    setTool('select');
    return;
  }
  if (tool === 'note') {
    e.preventDefault();
    const [x, y] = view.toUser(...p0);
    const a = newAnnot(view.page, { type: 'note', x, y, text: '', color: '#fbbc04', author: 'Me', date: new Date().toISOString() });
    setTool('select');
    openNoteEditor(view, a, true);
    return;
  }
  if (tool === 'place' && pendingPlacement) {
    e.preventDefault();
    const s = cssScale();
    const pl = pendingPlacement;
    const tl = view.toUser(p0[0] - (pl.w * s) / 2, p0[1] - (pl.h * s) / 2);
    const br = view.toUser(p0[0] + (pl.w * s) / 2, p0[1] + (pl.h * s) / 2);
    newAnnot(view.page, {
      type: 'image',
      x1: Math.min(tl[0], br[0]),
      x2: Math.max(tl[0], br[0]),
      y1: Math.min(tl[1], br[1]),
      y2: Math.max(tl[1], br[1]),
      rot,
      dataUrl: pl.dataUrl,
    });
    setTool('select');
    return;
  }

  // Drag-based tools.
  const isField = tool.startsWith('field-');
  const dragTools = ['draw', 'rect', 'ellipse', 'line', 'arrow', 'whiteout', 'region', 'redact'];
  if (!dragTools.includes(tool) && !isField) return;
  e.preventDefault();
  const preview = svgEl(tool === 'draw' ? 'path' : tool === 'ellipse' ? 'ellipse' : tool === 'line' || tool === 'arrow' ? 'line' : 'rect', {
    class: 'drag-preview',
    fill: tool === 'whiteout' ? '#ffffff' : tool === 'redact' ? 'rgba(217,48,37,0.22)' : 'none',
    stroke: tool === 'whiteout' ? '#9aa0a6' : tool === 'redact' ? '#d93025' : tool === 'region' || isField ? '#1a73e8' : props.color,
    'stroke-width': tool === 'draw' || tool === 'line' || tool === 'arrow' || tool === 'rect' || tool === 'ellipse' ? props.stroke * cssScale() : 1.5,
    'stroke-dasharray': tool === 'region' || isField || tool === 'whiteout' || tool === 'redact' ? '5 4' : null,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  });
  view.svg.append(preview);
  const pts = [p0];
  let last = p0;
  const move = (ev) => {
    const p = view.eventPoint(ev);
    last = p;
    if (tool === 'draw') {
      pts.push(p);
      preview.setAttribute('d', pts.map((q, i) => (i ? 'L' : 'M') + q[0] + ' ' + q[1]).join(' '));
    } else if (tool === 'line' || tool === 'arrow') {
      preview.setAttribute('x1', p0[0]);
      preview.setAttribute('y1', p0[1]);
      preview.setAttribute('x2', p[0]);
      preview.setAttribute('y2', p[1]);
    } else {
      const x = Math.min(p0[0], p[0]);
      const y = Math.min(p0[1], p[1]);
      const w = Math.abs(p[0] - p0[0]);
      const h = Math.abs(p[1] - p0[1]);
      if (tool === 'ellipse') {
        preview.setAttribute('cx', x + w / 2);
        preview.setAttribute('cy', y + h / 2);
        preview.setAttribute('rx', w / 2);
        preview.setAttribute('ry', h / 2);
      } else {
        preview.setAttribute('x', x);
        preview.setAttribute('y', y);
        preview.setAttribute('width', w);
        preview.setAttribute('height', h);
      }
    }
  };
  const up = async () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    preview.remove();
    const p = last;
    const tiny = Math.hypot(p[0] - p0[0], p[1] - p0[1]) < 4;
    if (isField) {
      const kind = tool.slice(6);
      if (tiny) {
        const [ux, uy] = view.toUser(...p0);
        emit('addfield', { page: view.page, kind, box: { x1: ux, y1: uy, x2: ux, y2: uy }, dragged: false });
      } else {
        const u0 = view.toUser(...p0);
        const u1 = view.toUser(...p);
        emit('addfield', { page: view.page, kind, box: { x1: Math.min(u0[0], u1[0]), x2: Math.max(u0[0], u1[0]), y1: Math.min(u0[1], u1[1]), y2: Math.max(u0[1], u1[1]) }, dragged: true });
      }
      return;
    }
    if (tool === 'draw') {
      if (pts.length < 2) return;
      newAnnot(view.page, { type: 'ink', pts: simplify(pts).map((q) => view.toUser(...q)), stroke: props.color, width: props.stroke, opacity: props.opacity });
      return;
    }
    if (tiny) return;
    if (tool === 'line' || tool === 'arrow') {
      newAnnot(view.page, { type: tool, pts: [view.toUser(...p0), view.toUser(...p)], stroke: props.color, width: props.stroke });
      return;
    }
    const u0 = view.toUser(...p0);
    const u1 = view.toUser(...p);
    const box = { x1: Math.min(u0[0], u1[0]), x2: Math.max(u0[0], u1[0]), y1: Math.min(u0[1], u1[1]), y2: Math.max(u0[1], u1[1]) };
    if (tool === 'region') {
      const cb = regionCallback;
      setTool('select');
      if (cb) cb({ page: view.page, view, rect: box });
      return;
    }
    if (tool === 'rect' || tool === 'ellipse') {
      newAnnot(view.page, { type: tool, ...box, stroke: props.color, fill: null, width: props.stroke, opacity: props.opacity });
    } else if (tool === 'whiteout') {
      newAnnot(view.page, { type: 'rect', ...box, stroke: null, fill: '#ffffff', width: 0, opacity: 1 });
    } else if (tool === 'redact') {
      newAnnot(view.page, { type: 'redact', ...box });
      emit('redactmarked');
    }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function simplify(pts) {
  const out = [pts[0]];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= 1.5) out.push(p);
  }
  if (out.length === 1) out.push(pts[pts.length - 1]);
  return out;
}

// ---------- text annotations ----------
function startTextEdit(view, a, box, isNew = false) {
  box.contentEditable = 'plaintext-only';
  box.classList.add('editing');
  box.focus();
  const range = document.createRange();
  range.selectNodeContents(box);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const before = a.text;
  const finish = () => {
    box.removeEventListener('blur', finish);
    box.contentEditable = 'false';
    box.classList.remove('editing');
    const text = box.innerText.replace(/\n$/, '');
    if (!text.trim()) {
      // Empty text box: remove it.
      const i = view.page.annots.indexOf(a);
      if (i >= 0) view.page.annots.splice(i, 1);
      if (isNew) state.history.pop();
      state.selectedAnnot = null;
      changed();
      emit('selection');
      return;
    }
    if (text !== before) {
      if (!isNew) checkpoint();
      a.text = text;
      changed();
    } else view.renderAnnots();
  };
  box.addEventListener('blur', finish);
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') box.blur();
  });
}

function openNoteEditor(view, a, isNew = false) {
  const p = view.toView(a.x, a.y);
  view.htmlLayer.querySelectorAll('.note-popup').forEach((n) => n.remove());
  const ta = el('textarea', { class: 'field', rows: 4, placeholder: 'Add a comment…' });
  ta.value = a.text || '';
  const popup = el(
    'div',
    { class: 'note-popup', style: { left: p[0] + 26 + 'px', top: p[1] + 'px' } },
    el('div', { class: 'note-head' }, icon('chat_bubble'), el('span', {}, 'Comment')),
    ta,
    el(
      'div',
      { class: 'note-actions' },
      el(
        'button',
        {
          class: 'btn btn-text',
          onclick: () => {
            checkpoint();
            view.page.annots.splice(view.page.annots.indexOf(a), 1);
            popup.remove();
            changed();
          },
        },
        'Delete'
      ),
      el(
        'button',
        {
          class: 'btn btn-primary',
          onclick: () => {
            if (!isNew) checkpoint();
            a.text = ta.value;
            popup.remove();
            changed();
            emit('comments');
          },
        },
        'Save'
      )
    )
  );
  popup.addEventListener('mousedown', (e) => e.stopPropagation());
  popup.addEventListener('keydown', (e) => e.stopPropagation());
  view.htmlLayer.append(popup);
  setTimeout(() => ta.focus(), 20);
}

// ---------- edit existing text ----------
function onEditTextClick(view, e) {
  const span = e.target.closest('span');
  if (!span || !span.textContent.trim()) return;
  e.preventDefault();
  e.stopPropagation();
  const s = cssScale();
  const pr = view.div.getBoundingClientRect();
  const r = span.getBoundingClientRect();
  const rot = totalRotation(view.page);
  const vx = r.left - pr.left;
  const vy = r.top - pr.top;
  const fontPx = parseFloat(getComputedStyle(span).fontSize) || r.height;
  const size = Math.max(4, Math.round((fontPx / s) * 10) / 10);
  const [x, y] = view.toUser(vx, vy - size * s * 0.05);
  const a = newAnnot(view.page, {
    type: 'text',
    x,
    y,
    rot,
    size,
    color: '#000000',
    font: /serif|times/i.test(span.style.fontFamily) && !/sans/i.test(span.style.fontFamily) ? 'Times' : 'Helvetica',
    bold: false,
    text: span.textContent.replace(/[\u200B-\u200F\uFEFF\u00AD]/g, ''),
    bg: '#ffffff',
    minW: r.width / s + 2, // keep covering the old text even if the new text is shorter
  });
  setTool('select');
  requestAnimationFrame(() => {
    const box = view.htmlLayer.querySelector(`[data-id="${a.id}"]`);
    if (box) startTextEdit(view, a, box);
  });
}

// ---------- text selection -> highlight / underline / strike ----------
function selectionRectsByPage() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const out = new Map();
  for (const v of views.values()) {
    if (!v.rendered || !range.intersectsNode(v.textDiv)) continue;
    const pr = v.div.getBoundingClientRect();
    const rects = [];
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      const x = r.left - pr.left;
      const y = r.top - pr.top;
      if (x > pr.width || y > pr.height || x + r.width < 0 || y + r.height < 0) continue;
      // Merge with a rect on the same line.
      const prev = rects.find((q) => Math.abs(q.y - y) < r.height * 0.5 && x <= q.x + q.w + 4 && x + r.width >= q.x - 4);
      if (prev) {
        const nx = Math.min(prev.x, x);
        prev.w = Math.max(prev.x + prev.w, x + r.width) - nx;
        prev.x = nx;
        prev.h = Math.max(prev.h, r.height);
      } else rects.push({ x, y, w: r.width, h: r.height });
    }
    if (rects.length) out.set(v, rects);
  }
  return out.size ? { map: out, text: sel.toString() } : null;
}

export function markupSelection(type) {
  const res = selectionRectsByPage();
  if (!res) return false;
  checkpoint();
  for (const [v, rects] of res.map) {
    const userRects = rects.map((r) => {
      const a = v.toUser(r.x, r.y);
      const b = v.toUser(r.x + r.w, r.y + r.h);
      return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    });
    if (type === 'redact') {
      for (const r of userRects) v.page.annots.push({ id: uid(), type: 'redact', x1: r[0] - 1, y1: r[1] - 1, x2: r[2] + 1, y2: r[3] + 1 });
      continue;
    }
    v.page.annots.push({
      id: uid(),
      type,
      rects: userRects,
      rot: totalRotation(v.page),
      color: type === 'highlight' ? state.props.highlight : type === 'underline' ? '#1a73e8' : '#d93025',
      text: res.text,
    });
  }
  window.getSelection().removeAllRanges();
  hideSelectionMenu();
  changed();
  return true;
}

export function getSelectedText() {
  const sel = window.getSelection();
  return sel ? sel.toString() : '';
}

function onTextSelectionEnd(e) {
  if (!state.doc) return;
  if (e.target.closest && e.target.closest('#selMenu')) return;
  setTimeout(() => {
    const tool = state.tool;
    if (tool === 'highlight' || tool === 'underline' || tool === 'strike') {
      markupSelection(tool);
      return;
    }
    const res = tool === 'select' ? selectionRectsByPage() : null;
    if (!res) {
      hideSelectionMenu();
      return;
    }
    const sel = window.getSelection();
    const r = sel.getRangeAt(0).getBoundingClientRect();
    const menu = $('#selMenu');
    menu.style.left = clamp(r.left + r.width / 2 - 130, 8, window.innerWidth - 280) + 'px';
    menu.style.top = Math.max(60, r.top - 48) + 'px';
    menu.classList.add('show');
  }, 10);
}

export function hideSelectionMenu() {
  $('#selMenu') && $('#selMenu').classList.remove('show');
}

// ---------- search highlighting ----------
function applySearchHighlight(view) {
  const q = state.searchQuery.trim().toLowerCase();
  view.textDiv.querySelectorAll('span.search-hit').forEach((s) => s.classList.remove('search-hit'));
  if (!q) return;
  view.textDiv.querySelectorAll('span').forEach((s) => {
    if (s.textContent.toLowerCase().includes(q)) s.classList.add('search-hit');
  });
}
export function refreshSearchHighlights() {
  views.forEach((v) => v.rendered && applySearchHighlight(v));
}

// ---------- delete / nudge selected annotation ----------
export function deleteSelectedAnnot() {
  const f = findAnnot();
  if (!f) return false;
  checkpoint();
  f.page.annots.splice(f.page.annots.indexOf(f.annot), 1);
  state.selectedAnnot = null;
  changed();
  emit('selection');
  return true;
}

export function updateSelectedAnnot(patch) {
  const f = findAnnot();
  if (!f) return false;
  checkpoint();
  const a = f.annot;
  if ('color' in patch) {
    if (a.type === 'text' || a.type === 'highlight' || a.type === 'underline' || a.type === 'strike' || a.type === 'note') a.color = patch.color;
    else if (a.stroke !== undefined && a.stroke !== null) a.stroke = patch.color;
    else if (a.fill && a.type !== 'rect') a.fill = patch.color;
  }
  if ('stroke' in patch && 'width' in a) a.width = patch.stroke;
  if ('fontSize' in patch && a.type === 'text') a.size = patch.fontSize;
  if ('font' in patch && a.type === 'text') a.font = patch.font;
  if ('bold' in patch && a.type === 'text') a.bold = patch.bold;
  changed();
  return true;
}

export function nudgeSelected(dxView, dyView) {
  const f = findAnnot();
  if (!f) return false;
  const v = views.get(f.page.id);
  if (!v || !v.viewport) return false;
  checkpoint();
  const u0 = v.toUser(0, 0);
  const u1 = v.toUser(dxView, dyView);
  moveAnnot(f.annot, JSON.parse(JSON.stringify(f.annot)), u1[0] - u0[0], u1[1] - u0[1]);
  changed();
  return true;
}

export { findPage };
