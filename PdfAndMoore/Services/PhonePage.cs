namespace PdfAndMoore.Services;

/// <summary>
/// The page the phone opens to sign (v9.6). Full screen, works with a finger or a stylus (S Pen, Apple Pencil,
/// any active pen): pen pressure makes the line thicker, and once a pen touches the screen your palm is ignored.
/// "Done" trims the signature and sends it back to the PC as a see-through PNG.
/// </summary>
internal static class PhonePage
{
    public const string Html = """
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#0f1b2d">
<title>Sign · PDF and Moore</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; overflow: hidden; overscroll-behavior: none; background: #0f1b2d; color: #eaf1f8;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
  body { display: flex; flex-direction: column; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
  header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; font-size: 16px; }
  header b { font-size: 17px; }
  header .tip { margin-left: auto; color: #8fa6bd; font-size: 13px; text-align: right; }
  #wrap { position: relative; flex: 1; margin: 0 10px; border-radius: 14px; background: #ffffff; overflow: hidden; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
  #line { position: absolute; left: 7%; right: 7%; bottom: 26%; border-bottom: 2px solid #b8c2cc; pointer-events: none; }
  #x { position: absolute; left: 7%; bottom: calc(26% + 6px); color: #9aa5b1; font-size: 28px; pointer-events: none; }
  #hint { position: absolute; left: 0; right: 0; bottom: calc(26% - 30px); text-align: center; color: #9aa5b1; font-size: 15px; pointer-events: none; }
  footer { display: flex; gap: 10px; padding: 10px; align-items: center; }
  button { font: inherit; font-size: 17px; border: 0; border-radius: 12px; padding: 14px 18px; color: #eaf1f8; background: #1e3150; }
  button:active { filter: brightness(1.2); }
  #done { margin-left: auto; background: linear-gradient(135deg, #ff7a59, #ff5fa2); font-weight: 700; padding: 14px 28px; }
  .ink { width: 34px; height: 34px; border-radius: 50%; padding: 0; border: 3px solid transparent; }
  .ink.on { border-color: #eaf1f8; }
  #msg { position: fixed; inset: 0; display: none; place-items: center; text-align: center; background: rgba(15,27,45,.96); font-size: 20px; padding: 30px; line-height: 1.5; }
  #msg.show { display: grid; }
  #msg .big { font-size: 64px; }
  header .app { color: #8fa6bd; }
  @media (orientation: portrait) { header .tip::after { content: "Turn sideways for more room"; } header .app { display: none; } }
</style>
</head>
<body>
<header><b>Sign here</b><span class="app">· PDF and Moore</span><span class="tip"></span></header>
<div id="wrap">
  <div id="line"></div><div id="x">✕</div><div id="hint">Sign above the line with your stylus or finger</div>
  <canvas id="pad"></canvas>
</div>
<footer>
  <button id="clear">Clear</button>
  <button id="undo">Undo</button>
  <button class="ink on" data-c="#0b1f4d" style="background:#0b1f4d" aria-label="Dark blue ink"></button>
  <button class="ink" data-c="#111111" style="background:#111111" aria-label="Black ink"></button>
  <button id="done">Done</button>
</footer>
<div id="msg"><div id="msgText"></div></div>
<script>
(function () {
  var pad = document.getElementById('pad'), wrap = document.getElementById('wrap'), hint = document.getElementById('hint');
  var g = pad.getContext('2d');
  var strokes = [], cur = null, penSeen = false, ink = '#0b1f4d', dpr = 1;
  var BASE = 3.2; // line width in screen pixels at normal pressure

  function size() {
    dpr = window.devicePixelRatio || 1;
    var r = wrap.getBoundingClientRect();
    pad.width = Math.round(r.width * dpr);
    pad.height = Math.round(r.height * dpr);
    redraw();
  }
  function widthFor(p, type) {
    if (type === 'pen' && p > 0) return BASE * (0.45 + p * 1.1);
    return BASE;
  }
  function seg(ctx, s, i, scale, ox, oy) {
    var a = s.pts[i - 1], b = s.pts[i];
    ctx.strokeStyle = s.color;
    ctx.lineWidth = ((a.w + b.w) / 2) * scale;
    ctx.beginPath();
    if (i >= 2) {
      var z = s.pts[i - 2];
      ctx.moveTo(((z.x + a.x) / 2 - ox) * scale, ((z.y + a.y) / 2 - oy) * scale);
      ctx.quadraticCurveTo((a.x - ox) * scale, (a.y - oy) * scale, ((a.x + b.x) / 2 - ox) * scale, ((a.y + b.y) / 2 - oy) * scale);
    } else {
      ctx.moveTo((a.x - ox) * scale, (a.y - oy) * scale);
      ctx.lineTo(((a.x + b.x) / 2 - ox) * scale, ((a.y + b.y) / 2 - oy) * scale);
    }
    ctx.stroke();
  }
  function drawStroke(ctx, s, scale, ox, oy) {
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (s.pts.length === 1) {
      var p = s.pts[0];
      ctx.fillStyle = s.color; ctx.beginPath();
      ctx.arc((p.x - ox) * scale, (p.y - oy) * scale, (p.w / 2) * scale, 0, Math.PI * 2); ctx.fill();
      return;
    }
    for (var i = 1; i < s.pts.length; i++) seg(ctx, s, i, scale, ox, oy);
  }
  function redraw() {
    g.clearRect(0, 0, pad.width, pad.height);
    strokes.forEach(function (s) { drawStroke(g, s, dpr, 0, 0); });
    hint.style.display = strokes.length ? 'none' : '';
  }
  function point(e) {
    var r = pad.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: widthFor(e.pressure, e.pointerType) };
  }
  pad.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'pen') penSeen = true;
    if (penSeen && e.pointerType === 'touch') return; // palm rejection once a stylus is in use
    e.preventDefault();
    pad.setPointerCapture(e.pointerId);
    cur = { id: e.pointerId, color: ink, pts: [point(e)] };
    strokes.push(cur);
    redraw();
  });
  pad.addEventListener('pointermove', function (e) {
    if (!cur || e.pointerId !== cur.id) return;
    e.preventDefault();
    var list = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    if (!list.length) list = [e];
    g.lineCap = 'round'; g.lineJoin = 'round';
    list.forEach(function (ev) {
      cur.pts.push(point(ev));
      seg(g, cur, cur.pts.length - 1, dpr, 0, 0);
    });
  });
  function end(e) { if (cur && e.pointerId === cur.id) cur = null; }
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
  document.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });

  document.getElementById('clear').onclick = function () { strokes = []; redraw(); };
  document.getElementById('undo').onclick = function () { strokes.pop(); redraw(); };
  Array.prototype.forEach.call(document.querySelectorAll('.ink'), function (b) {
    b.onclick = function () {
      ink = b.getAttribute('data-c');
      Array.prototype.forEach.call(document.querySelectorAll('.ink'), function (x) { x.classList.toggle('on', x === b); });
    };
  });

  function show(text) {
    document.getElementById('msgText').innerHTML = text;
    document.getElementById('msg').classList.add('show');
  }

  document.getElementById('done').onclick = function () {
    if (!strokes.length) return show('Sign above the line first.<br><br><button onclick="this.closest(\'#msg\').classList.remove(\'show\')">OK</button>');
    // Trim to the ink and draw it at 3x for a crisp signature on paper.
    var x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    strokes.forEach(function (s) { s.pts.forEach(function (p) {
      x1 = Math.min(x1, p.x - p.w); y1 = Math.min(y1, p.y - p.w); x2 = Math.max(x2, p.x + p.w); y2 = Math.max(y2, p.y + p.w);
    }); });
    var m = 6, scale = 3;
    var out = document.createElement('canvas');
    out.width = Math.max(1, Math.round((x2 - x1 + m * 2) * scale));
    out.height = Math.max(1, Math.round((y2 - y1 + m * 2) * scale));
    var o = out.getContext('2d');
    strokes.forEach(function (s) { drawStroke(o, s, scale, x1 - m, y1 - m); });
    var data = out.toDataURL('image/png');
    show('Sending…');
    fetch(location.pathname, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: data })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status === 404 ? 'This link has ended. Open Sign › Phone on your PC for a new QR code.' : 'The PC said no (' + r.status + ').');
        show('<div class="big">✅</div>Sent! Look at your PC.<br><small style="color:#8fa6bd">You can close this page.</small>');
      })
      .catch(function (err) {
        show('Couldn\'t send it: ' + (err.message || err) + '<br><br><button onclick="this.closest(\'#msg\').classList.remove(\'show\')">Try again</button>');
      });
  };

  window.addEventListener('resize', size);
  size();
})();
</script>
</body>
</html>
""";
}
