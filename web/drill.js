/**
 * Drill panel — shared across the System Design lab family.
 * Load AFTER drill-data.js and BEFORE the lab's main inline script:
 *   <script src="drill-data.js"></script><script src="drill.js"></script>
 * It injects its own CSS, builds a `section.phase[data-tab="Drill"]` before the
 * main script wires the sidebar (so the nav picks it up automatically — add
 * 'drill':'Practice' to TIER_OF), and renders active-recall Q&A cards.
 */
(function () {
  var D = window.DRILL;
  if (!D || !D.cards || !D.cards.length) return;

  // ── CSS ────────────────────────────────────────────────────────────────
  var css = [
    '.drill-card { border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:12px; background:var(--panel); }',
    '.drill-q { font-size:14.5px; font-weight:600; display:flex; gap:10px; align-items:baseline; margin-bottom:10px; line-height:1.5; }',
    '.drill-n { font-family:var(--mono); font-size:11px; color:var(--accent); flex:none; min-width:18px; }',
    '.drill-topic { font-family:var(--mono); font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:1px 8px; flex:none; order:2; margin-left:auto; }',
    '.drill-a { font-size:13.5px; color:var(--muted); line-height:1.65; border-left:3px solid var(--accent); padding:6px 0 6px 12px; margin:0 0 10px; background:linear-gradient(90deg, var(--accent-soft), transparent 80%); border-radius:0 8px 8px 0; }',
    '.drill-a b, .drill-a em { color:var(--ink); }',
    '.drill-bar { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; }',
    '.drill-cheats ol { margin:0 0 14px; padding-left:20px; font-size:13.5px; line-height:1.9; }',
    '.drill-cheats li { margin-bottom:4px; }',
    '.drill-meta { font-family:var(--mono); font-size:11.5px; color:var(--muted); }',
  ].join('\n');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── Section (inserted before the trailing footer inside .main-inner) ──
  var host = document.querySelector('.main-inner') || document.querySelector('.main') || document.body;
  var sec = document.createElement('section');
  sec.className = 'phase';
  sec.setAttribute('data-tab', 'Drill');
  sec.innerHTML =
    '<h2>Drill — active recall</h2>' +
    '<p class="lede">The study module’s interview questions and cheat-sheet one-liners. Answer <em>out loud</em> before revealing — recall beats re-reading. <span class="drill-meta" id="drill-meta"></span></p>' +
    '<div class="card">' +
    '  <div class="drill-bar">' +
    '    <button class="act" id="drill-shuffle">⇄ Shuffle</button>' +
    '    <button class="ghost" id="drill-reveal-all">Reveal all</button>' +
    '    <button class="ghost" id="drill-hide-all">Hide all</button>' +
    '    <button class="ghost" id="drill-cheats-btn">☰ Cheat-sheet</button>' +
    '  </div>' +
    '  <div class="drill-cheats" id="drill-cheats" style="display:none"></div>' +
    '  <div id="drill-cards"></div>' +
    '</div>';
  // Place before the trailing side-foot inside the host, if one exists there.
  var feet = host.querySelectorAll(':scope > .side-foot');
  var tail = feet.length ? feet[feet.length - 1] : null;
  if (tail) host.insertBefore(sec, tail); else host.appendChild(sec);

  // ── Render ─────────────────────────────────────────────────────────────
  document.getElementById('drill-meta').textContent = '· ' + D.module + ' — ' + D.source;
  document.getElementById('drill-cheats').innerHTML =
    '<ol>' + D.cheats.map(function (c) { return '<li>' + c + '</li>'; }).join('') + '</ol>';

  var order = D.cards.map(function (_, i) { return i; });
  var seed = 7;
  function rnd() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }

  var root = document.getElementById('drill-cards');
  function paint() {
    root.innerHTML = '';
    order.forEach(function (idx, n) {
      var card = D.cards[idx];
      var d = document.createElement('div');
      d.className = 'drill-card';
      d.innerHTML =
        '<div class="drill-q"><span class="drill-n">' + (n + 1) + '</span><div>' + card.q + '</div>' +
        (card.topic ? '<span class="drill-topic">' + card.topic + '</span>' : '') + '</div>' +
        '<div class="drill-a" style="display:none">' + card.a + '</div>' +
        '<button class="ghost drill-btn">Reveal answer</button>';
      var a = d.querySelector('.drill-a'), b = d.querySelector('.drill-btn');
      b.onclick = function () { var on = a.style.display === 'none'; a.style.display = on ? 'block' : 'none'; b.textContent = on ? 'Hide answer' : 'Reveal answer'; };
      root.appendChild(d);
    });
  }
  document.getElementById('drill-shuffle').onclick = function () {
    for (var i = order.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)); var t = order[i]; order[i] = order[j]; order[j] = t; }
    paint();
  };
  document.getElementById('drill-reveal-all').onclick = function () {
    root.querySelectorAll('.drill-a').forEach(function (x) { x.style.display = 'block'; });
    root.querySelectorAll('.drill-btn').forEach(function (x) { x.textContent = 'Hide answer'; });
  };
  document.getElementById('drill-hide-all').onclick = function () {
    root.querySelectorAll('.drill-a').forEach(function (x) { x.style.display = 'none'; });
    root.querySelectorAll('.drill-btn').forEach(function (x) { x.textContent = 'Reveal answer'; });
  };
  document.getElementById('drill-cheats-btn').onclick = function () {
    var el = document.getElementById('drill-cheats');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  };
  paint();
})();
