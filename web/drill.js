/**
 * Drill panel — shared across the System Design lab family. v2 (spaced repetition)
 * Load AFTER drill-data.js and BEFORE the lab's main inline script:
 *   <script src="drill-data.js"></script><script src="drill.js"></script>
 * Injects its own CSS, builds a `section.phase[data-tab="Drill"]` before the
 * main script wires the sidebar (nav picks it up via TIER_OF 'drill':'Practice'),
 * and renders active-recall Q&A cards with per-card mastery ("Got it" / "Again")
 * persisted in localStorage, a review-only filter, and a mastery counter.
 */
(function () {
  var D = window.DRILL;
  if (!D || !D.cards || !D.cards.length) return;

  // ── CSS ────────────────────────────────────────────────────────────────
  var css = [
    '.drill-card { border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin-bottom:12px; background:var(--panel); border-left-width:4px; }',
    '.drill-card.mastered { border-left-color:var(--good); }',
    '.drill-card.again { border-left-color:var(--amber); }',
    '.drill-q { font-size:14.5px; font-weight:600; display:flex; gap:10px; align-items:baseline; margin-bottom:10px; line-height:1.5; }',
    '.drill-n { font-family:var(--mono); font-size:11px; color:var(--accent); flex:none; min-width:18px; }',
    '.drill-topic { font-family:var(--mono); font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:1px 8px; flex:none; order:2; margin-left:auto; }',
    '.drill-a { font-size:13.5px; color:var(--muted); line-height:1.65; border-left:3px solid var(--accent); padding:6px 0 6px 12px; margin:0 0 10px; background:linear-gradient(90deg, var(--accent-soft), transparent 80%); border-radius:0 8px 8px 0; }',
    '.drill-a b, .drill-a em { color:var(--ink); }',
    '.drill-bar { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:8px; align-items:center; }',
    '.drill-count { font-family:var(--mono); font-size:11.5px; color:var(--muted); margin-left:auto; }',
    '.drill-count b { color:var(--good); }',
    '.drill-cheats ol { margin:0 0 14px; padding-left:20px; font-size:13.5px; line-height:1.9; }',
    '.drill-cheats li { margin-bottom:4px; }',
    '.drill-meta { font-family:var(--mono); font-size:11.5px; color:var(--muted); }',
    '.drill-actions { display:flex; gap:8px; }',
    '.drill-mini { font-family:var(--sans); font-size:12px; border:1px solid var(--line); background:var(--panel-2); color:var(--ink); border-radius:8px; padding:6px 11px; cursor:pointer; }',
    '.drill-mini:hover { border-color:var(--accent); }',
    '.drill-mini.good { color:var(--good); } .drill-mini.good:hover { border-color:var(--good); }',
    '.drill-mini.amber { color:var(--amber); } .drill-mini.amber:hover { border-color:var(--amber); }',
    '.drill-hint { font-family:var(--mono); font-size:10.5px; color:var(--muted); margin-top:2px; }',
  ].join('\n');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── persistence ────────────────────────────────────────────────────────
  var KEY = 'sdlabs-drill:' + (D.module || 'lab');
  var mastery = {};
  try { mastery = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) {}
  function save() { try { localStorage.setItem(KEY, JSON.stringify(mastery)); } catch (e) {} }
  function cardKey(c) { return (c.q || '').slice(0, 64); }

  // ── Section ────────────────────────────────────────────────────────────
  var host = document.querySelector('.main-inner') || document.querySelector('.main') || document.body;
  var sec = document.createElement('section');
  sec.className = 'phase';
  sec.setAttribute('data-tab', 'Drill');
  sec.innerHTML =
    '<h2>Drill — active recall</h2>' +
    '<p class="lede">The study module’s interview questions and cheat-sheet one-liners. Answer <em>out loud</em> before revealing — recall beats re-reading. Mark each card <b>Got it</b> or <b>Again</b>; “Review only” shows what still needs work. <span class="drill-meta" id="drill-meta"></span></p>' +
    '<div class="card">' +
    '  <div class="drill-bar">' +
    '    <button class="act" id="drill-shuffle">⇄ Shuffle</button>' +
    '    <button class="ghost" id="drill-review">↻ Review only</button>' +
    '    <button class="ghost" id="drill-reveal-all">Reveal all</button>' +
    '    <button class="ghost" id="drill-cheats-btn">☰ Cheat-sheet</button>' +
    '    <span class="drill-count" id="drill-count"></span>' +
    '  </div>' +
    '  <div class="drill-cheats" id="drill-cheats" style="display:none"></div>' +
    '  <div id="drill-cards"></div>' +
    '</div>';
  var feet = host.querySelectorAll(':scope > .side-foot');
  var tail = feet.length ? feet[feet.length - 1] : null;
  if (tail) host.insertBefore(sec, tail); else host.appendChild(sec);

  // ── Render ─────────────────────────────────────────────────────────────
  document.getElementById('drill-meta').textContent = '· ' + D.module + ' — ' + D.source;
  document.getElementById('drill-cheats').innerHTML =
    '<ol>' + D.cheats.map(function (c) { return '<li>' + c + '</li>'; }).join('') + '</ol>';

  var order = D.cards.map(function (_, i) { return i; });
  var reviewOnly = false;
  var lastCard = null;          // most recently revealed card (for g / a keys)
  var seed = 7;
  function rnd() { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }

  function counts() {
    var m = 0;
    D.cards.forEach(function (c) { if (mastery[cardKey(c)] === 'ok') m++; });
    return { m: m, n: D.cards.length };
  }
  function paintCount() {
    var c = counts();
    document.getElementById('drill-count').innerHTML = 'mastered <b>' + c.m + '</b>/' + c.n;
  }

  var root = document.getElementById('drill-cards');
  function paint() {
    root.innerHTML = '';
    var shown = 0;
    order.forEach(function (idx, n) {
      var card = D.cards[idx];
      var state = mastery[cardKey(card)];               // 'ok' | 'again' | undefined
      if (reviewOnly && state === 'ok') return;
      shown++;
      var d = document.createElement('div');
      d.className = 'drill-card' + (state === 'ok' ? ' mastered' : state === 'again' ? ' again' : '');
      d.innerHTML =
        '<div class="drill-q"><span class="drill-n">' + shown + '</span><div>' + card.q + '</div>' +
        (card.topic ? '<span class="drill-topic">' + card.topic + '</span>' : '') + '</div>' +
        '<div class="drill-a" style="display:none">' + card.a + '</div>' +
        '<div class="drill-actions">' +
        '  <button class="ghost drill-btn">Reveal answer</button>' +
        '  <button class="drill-mini good" style="display:none">Got it ✓</button>' +
        '  <button class="drill-mini amber" style="display:none">Again ↻</button>' +
        '</div>';
      var a = d.querySelector('.drill-a'), b = d.querySelector('.drill-btn');
      var ok = d.querySelector('.drill-mini.good'), ag = d.querySelector('.drill-mini.amber');
      b.onclick = function () {
        var on = a.style.display === 'none';
        a.style.display = on ? 'block' : 'none';
        b.textContent = on ? 'Hide answer' : 'Reveal answer';
        ok.style.display = ag.style.display = on ? 'inline-block' : 'none';
        if (on) lastCard = d;
      };
      ok.onclick = function () { mastery[cardKey(card)] = 'ok'; save(); paintCount(); d.className = 'drill-card mastered'; };
      ag.onclick = function () { mastery[cardKey(card)] = 'again'; save(); paintCount(); d.className = 'drill-card again'; };
      root.appendChild(d);
    });
    if (!shown) {
      root.innerHTML = '<div class="drill-hint">Everything mastered — turn off “Review only”, or shuffle and run the deck again cold. 🎉</div>';
    }
  }
  document.getElementById('drill-shuffle').onclick = function () {
    for (var i = order.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)); var t = order[i]; order[i] = order[j]; order[j] = t; }
    paint();
  };
  document.getElementById('drill-review').onclick = function () {
    reviewOnly = !reviewOnly;
    this.classList.toggle('sel', reviewOnly);
    paint();
  };
  document.getElementById('drill-reveal-all').onclick = function () {
    root.querySelectorAll('.drill-a').forEach(function (x) { x.style.display = 'block'; });
    root.querySelectorAll('.drill-btn').forEach(function (x) { x.textContent = 'Hide answer'; });
    root.querySelectorAll('.drill-mini').forEach(function (x) { x.style.display = 'inline-block'; });
  };
  document.getElementById('drill-cheats-btn').onclick = function () {
    var el = document.getElementById('drill-cheats');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
  };
  paint(); paintCount();

  // ── keyboard: r reveal-next · g got it · a again (only while Drill is active)
  addEventListener('keydown', function (e) {
    if (!sec.classList.contains('active')) return;
    var t = e.target, tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'r') {
      var btn = null;
      root.querySelectorAll('.drill-btn').forEach(function (b) { if (!btn && b.textContent === 'Reveal answer') btn = b; });
      if (btn) {
        btn.click();
        lastCard = btn.closest('.drill-card');
        lastCard.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
    } else if (e.key === 'g' || e.key === 'a') {
      var d = lastCard && lastCard.isConnected ? lastCard : null;
      if (!d) {
        root.querySelectorAll('.drill-card').forEach(function (c) {
          var ans = c.querySelector('.drill-a');
          if (!d && ans && ans.style.display === 'block') d = c;
        });
      }
      if (d) {
        var m = d.querySelector(e.key === 'g' ? '.drill-mini.good' : '.drill-mini.amber');
        if (m) m.click();
      }
    }
  });
})();
