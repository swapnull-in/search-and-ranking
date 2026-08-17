/**
 * Lab enhancements — shared across the System Design Labs family.
 * Load AFTER the lab's main inline script (right before </body>):
 *   <script src="lab.js"></script>
 * Requires the family shell (sections / tabButtons / activate / TIER_OF globals
 * from the main classic script). Degrades to a no-op if the shell is absent.
 *
 * Features:
 *   • theme toggle (dark / light / auto) persisted in localStorage, overriding
 *     the system preference via [data-theme] (CSS injected by the build patch)
 *   • progress tracking — a lesson viewed for ~6s is marked done: ✓ in the nav
 *     + a progress meter in the sidebar (per-lab localStorage)
 *   • prev / next lesson bar at the bottom of every panel (guided path)
 *   • click-to-copy `npm run phaseN` chip on each numbered lesson
 */
(function () {
  // ── shell detection (bare identifiers — script-global consts) ──────────
  var S, TB, ACT;
  try { S = sections; TB = tabButtons; ACT = activate; } catch (e) { return; }
  if (!S || !S.length || !TB || typeof ACT !== 'function') return;

  var LAB = (document.title.split('—')[0] || 'lab').trim();

  // ── CSS ────────────────────────────────────────────────────────────────
  var css = [
    '.theme-btn { margin-left:auto; flex:none; width:28px; height:28px; border-radius:8px; border:1px solid var(--line); background:var(--panel); color:var(--muted); cursor:pointer; font-size:13px; line-height:1; display:grid; place-items:center; }',
    '.theme-btn:hover { color:var(--accent); border-color:var(--accent); }',
    '.done-tick { margin-left:auto; font-size:10px; color:var(--good); flex:none; }',
    '.progress-wrap { padding:12px 11px 0; }',
    '.progress-label { font-family:var(--mono); font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); display:flex; justify-content:space-between; margin-bottom:6px; }',
    '.progress-bar { height:4px; border-radius:99px; background:var(--hover); overflow:hidden; }',
    '.progress-fill { height:100%; border-radius:99px; background:var(--accent); width:0%; transition:width .4s ease; }',
    '.pn-bar { display:flex; justify-content:space-between; gap:10px; margin-top:26px; padding-top:18px; border-top:1px solid var(--line); }',
    '.pn-btn { font-family:var(--sans); font-size:13px; background:var(--panel); color:var(--ink); border:1px solid var(--line); padding:10px 14px; border-radius:10px; cursor:pointer; max-width:46%; text-align:left; line-height:1.35; }',
    '.pn-btn:hover { border-color:var(--accent); color:var(--accent); }',
    '.pn-btn small { display:block; font-family:var(--mono); font-size:9.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); margin-bottom:2px; }',
    '.pn-btn.next { text-align:right; margin-left:auto; }',
    '.npm-chip { font-family:var(--mono); font-size:11px; color:var(--muted); background:var(--panel-2); border:1px solid var(--line); border-radius:7px; padding:3px 9px; cursor:pointer; vertical-align:middle; margin-left:10px; }',
    '.npm-chip:hover { color:var(--accent); border-color:var(--accent); }',
    '.npm-chip.copied { color:var(--good); border-color:var(--good); }',
  ].join('\n');
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  // ── theme toggle ───────────────────────────────────────────────────────
  var THEME_KEY = 'sdlabs-theme';
  function applyTheme(t) {
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  var saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
  applyTheme(saved);
  var brand = document.querySelector('.sidebar .brand');
  if (brand) {
    var tb = document.createElement('button');
    tb.className = 'theme-btn'; tb.title = 'Theme: auto / dark / light';
    tb.setAttribute('aria-label', 'Toggle color theme');
    function icon() { var t = saved; tb.textContent = t === 'dark' ? '☾' : t === 'light' ? '☀' : '◐'; }
    icon();
    tb.onclick = function () {
      saved = saved === null ? 'dark' : saved === 'dark' ? 'light' : null;
      try { saved === null ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, saved); } catch (e) {}
      applyTheme(saved); icon();
    };
    brand.appendChild(tb);
  }

  // ── progress tracking ──────────────────────────────────────────────────
  var PKEY = 'sdlabs-progress:' + LAB;
  var doneSet = {};
  try { doneSet = JSON.parse(localStorage.getItem(PKEY) || '{}'); } catch (e) {}
  var META = { 'Overview': 1, 'Drill': 1 };            // not counted as lessons
  var lessonIdx = [];
  S.forEach(function (sec, i) { if (!META[sec.dataset.tab]) lessonIdx.push(i); });

  var meter = document.createElement('div');
  meter.className = 'progress-wrap';
  meter.innerHTML = '<div class="progress-label"><span>Progress</span><span id="prog-n">0/0</span></div><div class="progress-bar"><div class="progress-fill" id="prog-fill"></div></div>';
  var foot = document.querySelector('.sidebar .side-foot');
  if (foot) foot.parentNode.insertBefore(meter, foot);

  function paintProgress() {
    var done = 0;
    lessonIdx.forEach(function (i) {
      var key = S[i].dataset.tab, btn = TB[i];
      var has = btn.querySelector('.done-tick');
      if (doneSet[key]) { done++; if (!has) { var t = document.createElement('span'); t.className = 'done-tick'; t.textContent = '✓'; btn.appendChild(t); } }
    });
    var n = document.getElementById('prog-n'), f = document.getElementById('prog-fill');
    if (n) n.textContent = done + '/' + lessonIdx.length;
    if (f) f.style.width = (lessonIdx.length ? Math.round(done / lessonIdx.length * 100) : 0) + '%';
  }
  var visitTimer = null;
  function noteActive() {
    var i = S.findIndex(function (s) { return s.classList.contains('active'); });
    if (visitTimer) clearTimeout(visitTimer);
    if (i < 0 || META[S[i].dataset.tab]) return;
    visitTimer = setTimeout(function () {
      if (!S[i].classList.contains('active')) return;
      doneSet[S[i].dataset.tab] = 1;
      try { localStorage.setItem(PKEY, JSON.stringify(doneSet)); } catch (e) {}
      paintProgress();
    }, 6000);
  }
  // wrap activate so every navigation re-arms the visit timer
  var origActivate = ACT;
  try { activate = function (i, push) { origActivate(i, push); noteActive(); paintNextPrev(); }; } catch (e) {}
  paintProgress(); noteActive();

  // ── prev / next bars ───────────────────────────────────────────────────
  function label(i) { var p = S[i].dataset.tab.split('·').map(function (x) { return x.trim(); }); return p.length > 1 ? p[1] : p[0]; }
  S.forEach(function (sec, i) {
    var bar = document.createElement('div'); bar.className = 'pn-bar';
    var prev = i > 0 ? '<button class="pn-btn prev" data-go="' + (i - 1) + '"><small>← previous</small>' + label(i - 1) + '</button>' : '<span></span>';
    var next = i < S.length - 1 ? '<button class="pn-btn next" data-go="' + (i + 1) + '"><small>next →</small>' + label(i + 1) + '</button>' : '';
    bar.innerHTML = prev + next;
    sec.appendChild(bar);
  });
  function paintNextPrev() {}
  document.querySelectorAll('.pn-btn').forEach(function (b) {
    b.onclick = function () { activate(+b.dataset.go, true); };
  });

  // ── npm run chips ──────────────────────────────────────────────────────
  S.forEach(function (sec) {
    var m = /^(\d+)\s*·/.exec(sec.dataset.tab);
    var h2 = sec.querySelector('h2');
    if (!m || !h2) return;
    var cmd = 'npm run phase' + m[1];
    var chip = document.createElement('button');
    chip.className = 'npm-chip'; chip.textContent = cmd + ' ⧉'; chip.title = 'Copy the command that runs this lesson as a script';
    chip.onclick = function () {
      function ok() { chip.classList.add('copied'); chip.textContent = 'copied ✓'; setTimeout(function () { chip.classList.remove('copied'); chip.textContent = cmd + ' ⧉'; }, 1400); }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(cmd).then(ok, ok); else ok();
    };
    h2.appendChild(chip);
  });
})();
