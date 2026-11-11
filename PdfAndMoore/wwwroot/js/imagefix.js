// Image clean-up for old, faded, stained or photographed documents.
// All functions take and return canvases. Nothing here needs the internet.

function ctx(c) {
  return c.getContext('2d', { willReadFrequently: true });
}
function newCanvas(w, h, fill = null) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  if (fill) {
    const g = ctx(c);
    g.fillStyle = fill;
    g.fillRect(0, 0, c.width, c.height);
  }
  return c;
}
export function copyCanvas(src) {
  const c = newCanvas(src.width, src.height, '#fff');
  ctx(c).drawImage(src, 0, 0);
  return c;
}

/**
 * The paper's own color at every pixel (stains, yellowing, shadows, uneven light),
 * found by shrinking the image, taking the brightest nearby value (which removes the ink)
 * and blurring. Returns ImageData the size of the image.
 */
function paperBackground(src) {
  const step = Math.max(4, Math.round(Math.max(src.width, src.height) / 160));
  const sw = Math.ceil(src.width / step);
  const sh = Math.ceil(src.height / step);
  const small = newCanvas(sw, sh, '#fff');
  const g = ctx(small);
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, sw, sh);
  const d = g.getImageData(0, 0, sw, sh);
  const a = d.data;
  // Brightest value nearby (removes the ink), per color channel.
  const r = 3;
  const out = new Uint8ClampedArray(a.length);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      let m0 = 0;
      let m1 = 0;
      let m2 = 0;
      for (let yy = Math.max(0, y - r); yy <= Math.min(sh - 1, y + r); yy++)
        for (let xx = Math.max(0, x - r); xx <= Math.min(sw - 1, x + r); xx++) {
          const k = (yy * sw + xx) * 4;
          if (a[k] > m0) m0 = a[k];
          if (a[k + 1] > m1) m1 = a[k + 1];
          if (a[k + 2] > m2) m2 = a[k + 2];
        }
      const k = (y * sw + x) * 4;
      out[k] = m0;
      out[k + 1] = m1;
      out[k + 2] = m2;
      out[k + 3] = 255;
    }
  g.putImageData(new ImageData(out, sw, sh), 0, 0);
  const big = newCanvas(src.width, src.height, '#fff');
  const bg = ctx(big);
  bg.filter = `blur(${Math.max(2, step)}px)`;
  bg.imageSmoothingQuality = 'high';
  bg.drawImage(small, 0, 0, src.width, src.height);
  return bg.getImageData(0, 0, src.width, src.height);
}

/** Lighten the paper to white everywhere (removes yellowing, stains and shadows). */
function flatten(src, { keepColor = false } = {}) {
  const bg = paperBackground(src).data;
  const c = copyCanvas(src);
  const g = ctx(c);
  const d = g.getImageData(0, 0, c.width, c.height);
  const a = d.data;
  for (let i = 0; i < a.length; i += 4) {
    if (keepColor) {
      for (let ch = 0; ch < 3; ch++) a[i + ch] = Math.min(255, (a[i + ch] * 255) / Math.max(40, bg[i + ch]));
    } else {
      const v = (a[i] * 77 + a[i + 1] * 151 + a[i + 2] * 28) >> 8;
      const b = (bg[i] * 77 + bg[i + 1] * 151 + bg[i + 2] * 28) >> 8;
      const n = Math.min(255, (v * 255) / Math.max(40, b));
      a[i] = a[i + 1] = a[i + 2] = n;
    }
  }
  g.putImageData(d, 0, 0);
  return c;
}

/** Stretch contrast so the faintest ink becomes dark and the paper stays white. gamma > 1 darkens ink. */
function stretch(c, { lowPct = 0.004, gamma = 1.5, keepColor = false } = {}) {
  const g = ctx(c);
  const d = g.getImageData(0, 0, c.width, c.height);
  const a = d.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < a.length; i += 4) hist[(a[i] * 77 + a[i + 1] * 151 + a[i + 2] * 28) >> 8]++;
  const n = a.length / 4;
  let lo = 0;
  for (let s = 0; lo < 255 && s + hist[lo] < n * lowPct; lo++) s += hist[lo];
  // Paper is near white after flattening; anything above ~92% of white becomes white.
  const hi = 235;
  lo = Math.min(lo, 150);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const t = Math.max(0, Math.min(1, (v - lo) / Math.max(1, hi - lo)));
    lut[v] = Math.round(255 * Math.pow(t, gamma));
  }
  for (let i = 0; i < a.length; i += 4) {
    if (keepColor) {
      for (let ch = 0; ch < 3; ch++) a[i + ch] = lut[a[i + ch]];
    } else a[i] = a[i + 1] = a[i + 2] = lut[a[i]];
  }
  g.putImageData(d, 0, 0);
  return c;
}

function grayOf(c) {
  const d = ctx(c).getImageData(0, 0, c.width, c.height).data;
  const g = new Uint8Array(c.width * c.height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 151 + d[j + 2] * 28) >> 8;
  return g;
}

/**
 * Black-and-white with a threshold that adapts to each area (Sauvola), so faint
 * strokes next to dark ones both survive. Returns a Uint8Array mask (1 = ink).
 */
export function inkMask(c, { k = 0.18, window = 0 } = {}) {
  const W = c.width;
  const H = c.height;
  const gray = grayOf(c);
  const win = window || Math.max(15, Math.round(Math.min(W, H) / 45) | 1);
  const r = win >> 1;
  const I = new Float64Array((W + 1) * (H + 1));
  const I2 = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let s = 0;
    let s2 = 0;
    for (let x = 0; x < W; x++) {
      const v = gray[y * W + x];
      s += v;
      s2 += v * v;
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + s;
      I2[(y + 1) * (W + 1) + x + 1] = I2[y * (W + 1) + x + 1] + s2;
    }
  }
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(W, x + r + 1);
      const n = (y1 - y0) * (x1 - x0);
      const s = I[y1 * (W + 1) + x1] - I[y0 * (W + 1) + x1] - I[y1 * (W + 1) + x0] + I[y0 * (W + 1) + x0];
      const s2 = I2[y1 * (W + 1) + x1] - I2[y0 * (W + 1) + x1] - I2[y1 * (W + 1) + x0] + I2[y0 * (W + 1) + x0];
      const m = s / n;
      const sd = Math.sqrt(Math.max(0, s2 / n - m * m));
      const t = m * (1 + k * (sd / 128 - 1));
      const v = gray[y * W + x];
      out[y * W + x] = v < t && v < 225 ? 1 : 0;
    }
  }
  return out;
}

/** Remove specks: ink pixels with almost no ink around them. */
function despeckle(mask, W, H, passes = 2) {
  for (let p = 0; p < passes; p++) {
    const copy = mask.slice();
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        let n = 0;
        n += copy[i - W - 1] + copy[i - W] + copy[i - W + 1] + copy[i - 1] + copy[i + 1] + copy[i + W - 1] + copy[i + W] + copy[i + W + 1];
        if (copy[i] && n <= 1) mask[i] = 0;
        else if (!copy[i] && n >= 6) mask[i] = 1; // fill small gaps in worn strokes
      }
  }
  return mask;
}

/** Dark shadows and table edges along the border of a photo are not part of the document. */
function clearBorderInk(mask, W, H) {
  // A thin margin is always blank on a clean page.
  const mx = Math.round(W * 0.01);
  const my = Math.round(H * 0.01);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) if (x < mx || y < my || x >= W - mx || y >= H - my) mask[y * W + x] = 0;
  const seen = new Uint8Array(W * H);
  const limit = W * H * 0.0004;
  const starts = [];
  for (let x = 0; x < W; x++) starts.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) starts.push(y * W, y * W + W - 1);
  for (const s of starts) {
    if (!mask[s] || seen[s]) continue;
    const comp = [s];
    seen[s] = 1;
    for (let k = 0; k < comp.length; k++) {
      const i = comp[k];
      const x = i % W;
      for (const j of [i - 1, i + 1, i - W, i + W]) {
        if (j < 0 || j >= W * H || seen[j] || !mask[j]) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === W - 1)) continue;
        seen[j] = 1;
        comp.push(j);
      }
    }
    if (comp.length > limit) for (const i of comp) mask[i] = 0;
  }
  return mask;
}

function maskToCanvas(mask, W, H) {
  const c = newCanvas(W, H);
  const g = ctx(c);
  const d = g.createImageData(W, H);
  const a = d.data;
  for (let i = 0, j = 0; i < mask.length; i++, j += 4) {
    const v = mask[i] ? 0 : 255;
    a[j] = a[j + 1] = a[j + 2] = v;
    a[j + 3] = 255;
  }
  g.putImageData(d, 0, 0);
  // Soften the stair-steps a little so it looks printed, not pixelated.
  const out = newCanvas(W, H, '#fff');
  const og = ctx(out);
  og.filter = 'blur(0.45px)';
  og.drawImage(c, 0, 0);
  return out;
}

/** Make text easier for OCR to read: even paper, darker faint strokes. */
export function enhanceForOcr(src) {
  return stretch(flatten(src), { gamma: 1.6 });
}

/** Black-and-white version for OCR of very faded text. */
export function binarizeForOcr(src) {
  const flat = stretch(flatten(src), { gamma: 1.3 });
  const m = despeckle(inkMask(flat, { k: 0.12 }), flat.width, flat.height, 1);
  return maskToCanvas(m, flat.width, flat.height);
}

/**
 * Restore a page picture.
 *  'clean' — keeps the original look (grays), white paper, darker text
 *  'crisp' — like a fresh black-and-white print
 *  'color' — removes yellowing and stains but keeps colored ink, stamps and photos
 */
export function restoreImage(src, mode = 'clean', { strength = 1 } = {}) {
  if (mode === 'color') return stretch(flatten(src, { keepColor: true }), { gamma: 1 + 0.25 * strength, keepColor: true });
  if (mode === 'crisp') {
    const flat = stretch(flatten(src), { gamma: 1.2 });
    const m = despeckle(inkMask(flat, { k: 0.16 + 0.04 * (1 - strength) }), flat.width, flat.height, 2);
    return maskToCanvas(clearBorderInk(m, flat.width, flat.height), flat.width, flat.height);
  }
  return stretch(flatten(src), { gamma: 1.2 + 0.4 * strength });
}

/**
 * For photos of a document lying on a table: find the paper and crop to it.
 * Returns the cropped canvas, or the original if no clear paper edge is found.
 */
export function cropToPaper(src) {
  const scale = Math.min(1, 500 / Math.max(src.width, src.height));
  const w = Math.round(src.width * scale);
  const h = Math.round(src.height * scale);
  const small = newCanvas(w, h, '#fff');
  ctx(small).drawImage(src, 0, 0, w, h);
  const gray = grayOf(small);
  // Otsu threshold: paper is the bright part.
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0;
  let wB = 0;
  let best = 0;
  let thr = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = gray.length - wB;
    if (!wF) break;
    sB += i * hist[i];
    const between = wB * wF * (sB / wB - (sum - sB) / wF) ** 2;
    if (between > best) {
      best = between;
      thr = i;
    }
  }
  const bright = new Uint8Array(w * h);
  for (let i = 0; i < gray.length; i++) bright[i] = gray[i] > thr ? 1 : 0;
  // Largest bright region (flood fill), ignoring the text holes inside it.
  const seen = new Uint8Array(w * h);
  let bestBox = null;
  let bestN = 0;
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (!bright[s] || seen[s]) continue;
    let n = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop();
      n++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (j < 0 || j >= w * h || seen[j] || !bright[j]) continue;
        if ((j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue;
        seen[j] = 1;
        stack.push(j);
      }
    }
    if (n > bestN) {
      bestN = n;
      bestBox = [x0, y0, x1, y1];
    }
  }
  if (!bestBox) return src;
  const [x0, y0, x1, y1] = bestBox;
  const area = ((x1 - x0) * (y1 - y0)) / (w * h);
  // Only crop when there's clearly a background around the page.
  const touches = (x0 <= 1) + (y0 <= 1) + (x1 >= w - 2) + (y1 >= h - 2);
  if (area > 0.93 || area < 0.2 || touches >= 3) return src;
  // The paper's edge pixels: find the tilt that gives the tightest box around them.
  const lab = new Uint8Array(w * h);
  {
    // re-flood the winning region to label it
    const st = [];
    let seed = -1;
    for (let y = y0; y <= y1 && seed < 0; y++) for (let x = x0; x <= x1; x++) if (bright[y * w + x]) { seed = y * w + x; break; }
    if (seed >= 0) {
      st.push(seed);
      lab[seed] = 1;
      while (st.length) {
        const i = st.pop();
        const x = i % w;
        for (const j of [i - 1, i + 1, i - w, i + w]) {
          if (j < 0 || j >= w * h || lab[j] || !bright[j]) continue;
          if ((j === i - 1 && x === 0) || (j === i + 1 && x === w - 1)) continue;
          lab[j] = 1;
          st.push(j);
        }
      }
    }
  }
  const edge = [];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (lab[i] && (!lab[i - 1] || !lab[i + 1] || !lab[i - w] || !lab[i + w])) edge.push(x, y);
    }
  let bestA = 0;
  let bestArea = Infinity;
  let bestRect = null;
  for (let deg = -30; deg <= 30; deg += 0.25) {
    const t = (deg * Math.PI) / 180;
    const c = Math.cos(t);
    const sn = Math.sin(t);
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    for (let k = 0; k < edge.length; k += 2) {
      const u = edge[k] * c + edge[k + 1] * sn;
      const v = -edge[k] * sn + edge[k + 1] * c;
      if (u < a0) a0 = u;
      if (u > a1) a1 = u;
      if (v < b0) b0 = v;
      if (v > b1) b1 = v;
    }
    const ar = (a1 - a0) * (b1 - b0);
    if (ar < bestArea) {
      bestArea = ar;
      bestA = deg;
      bestRect = [a0, b0, a1, b1];
    }
  }
  // Rotate the full picture so the paper is level, then cut out the paper (a little inside its edge).
  const t = (bestA * Math.PI) / 180;
  const [a0, b0, a1, b1] = bestRect.map((v) => v / scale);
  const pw = a1 - a0;
  const ph = b1 - b0;
  const inset = Math.max(pw, ph) * 0.012;
  const out = newCanvas(pw - 2 * inset, ph - 2 * inset, '#fff');
  const g = ctx(out);
  g.imageSmoothingQuality = 'high';
  // Paper coordinates (u, v) -> image: x = u cos t - v sin t, y = u sin t + v cos t
  g.setTransform(Math.cos(t), -Math.sin(t), Math.sin(t), Math.cos(t), 0, 0);
  g.translate(0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.translate(-(a0 + inset), -(b0 + inset));
  g.rotate(-t);
  g.drawImage(src, 0, 0);
  return out;
}

/**
 * Long straight ruled lines in a page picture (form lines, table borders).
 * Returns [{x1,y1,x2,y2,w}] in pixels.
 */
export function ruledLines(c, minFrac = 0.06) {
  const W = c.width;
  const H = c.height;
  const flat = stretch(flatten(c), { gamma: 1.2 });
  const m = inkMask(flat, { k: 0.2 });
  const out = [];
  const minH = Math.max(40, Math.round(W * minFrac));
  const minV = Math.max(40, Math.round(H * minFrac));
  // horizontal runs, merged across neighbouring rows
  const rows = [];
  for (let y = 0; y < H; y++) {
    let x = 0;
    while (x < W) {
      if (!m[y * W + x]) {
        x++;
        continue;
      }
      let e = x;
      let gaps = 0;
      while (e < W && (m[y * W + e] || (gaps < 3 && ++gaps))) {
        if (m[y * W + e]) gaps = 0;
        e++;
      }
      if (e - x >= minH) rows.push({ y, x0: x, x1: e });
      x = e + 1;
    }
  }
  rows.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  for (const r of rows) {
    const last = out.find((l) => l.h && r.y - l.yb <= 1 && Math.min(r.x1, l.x2) - Math.max(r.x0, l.x1) > (r.x1 - r.x0) * 0.6);
    if (last) {
      last.yb = r.y;
      last.x1 = Math.min(last.x1, r.x0);
      last.x2 = Math.max(last.x2, r.x1);
    } else out.push({ h: true, x1: r.x0, x2: r.x1, ya: r.y, yb: r.y });
  }
  const horiz = out.filter((l) => l.yb - l.ya <= Math.max(6, H / 300)).map((l) => ({ x1: l.x1, y1: (l.ya + l.yb) / 2, x2: l.x2, y2: (l.ya + l.yb) / 2, w: l.yb - l.ya + 1 }));
  // vertical runs
  const cols = [];
  for (let x = 0; x < W; x++) {
    let y = 0;
    while (y < H) {
      if (!m[y * W + x]) {
        y++;
        continue;
      }
      let e = y;
      let gaps = 0;
      while (e < H && (m[e * W + x] || (gaps < 3 && ++gaps))) {
        if (m[e * W + x]) gaps = 0;
        e++;
      }
      if (e - y >= minV) cols.push({ x, y0: y, y1: e });
      y = e + 1;
    }
  }
  const vout = [];
  cols.sort((a, b) => a.x - b.x || a.y0 - b.y0);
  for (const r of cols) {
    const last = vout.find((l) => r.x - l.xb <= 1 && Math.min(r.y1, l.y2) - Math.max(r.y0, l.y1) > (r.y1 - r.y0) * 0.6);
    if (last) {
      last.xb = r.x;
      last.y1 = Math.min(last.y1, r.y0);
      last.y2 = Math.max(last.y2, r.y1);
    } else vout.push({ xa: r.x, xb: r.x, y1: r.y0, y2: r.y1 });
  }
  const vert = vout.filter((l) => l.xb - l.xa <= Math.max(6, W / 300)).map((l) => ({ x1: (l.xa + l.xb) / 2, y1: l.y1, x2: (l.xa + l.xb) / 2, y2: l.y2, w: l.xb - l.xa + 1 }));
  // Lines hugging the edge of the picture are the paper's edge or shadows, not ruled lines.
  const nearEdge = (l) => Math.min(l.x1, l.x2) < W * 0.02 && Math.max(l.x1, l.x2) < W * 0.02 || Math.max(l.x1, l.x2) > W * 0.98 && Math.min(l.x1, l.x2) > W * 0.98 || Math.min(l.y1, l.y2) < H * 0.015 && Math.max(l.y1, l.y2) < H * 0.015 || Math.min(l.y1, l.y2) > H * 0.985;
  return [...horiz, ...vert].filter((l) => !nearEdge(l));
}
