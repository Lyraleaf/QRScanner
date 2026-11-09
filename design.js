/* Look and feel helpers: light/dark switch (shell, login and Manual Prechecking), avatar letters, summary tiles. */
(function () {
  'use strict';
  var root = document.documentElement;
  function paintBtn() {
    var b = document.getElementById('theme-btn');
    if (!b) return;
    var dark = root.getAttribute('data-theme') === 'dark';
    b.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
    b.classList.toggle('is-dark', dark);
  }
  function setTheme(t) {
    if (t === 'dark') root.setAttribute('data-theme', 'dark'); else root.removeAttribute('data-theme');
    try { localStorage.setItem('rsTheme', t); } catch (e) { /* ignore */ }
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t === 'dark' ? '#0B1220' : '#2F5BEA');
    paintBtn();
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#theme-btn');
    if (b) setTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });
  paintBtn();

  // first letters of the signed-in name in the round avatar
  function paintAvatar() {
    var n = document.getElementById('current-user'), a = document.getElementById('user-avatar');
    if (!n || !a) return;
    var t = (n.textContent || '').trim();
    a.textContent = t ? t.split(/\s+/).slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join('') : '';
  }
  var cu = document.getElementById('current-user');
  if (cu && window.MutationObserver) new MutationObserver(paintAvatar).observe(cu, { childList: true, characterData: true, subtree: true });
  paintAvatar();

  // tiles: [{label, value, tone}]  tone = amber | blue | violet | red | green
  window.Design = {
    stats: function (id, tiles) {
      var el = document.getElementById(id);
      if (!el) return;
      var key = tiles.map(function (t) { return t.label + ':' + t.value; }).join('|');
      if (el.getAttribute('data-key') === key) return;
      el.setAttribute('data-key', key);
      el.innerHTML = '';
      tiles.forEach(function (t) {
        var d = document.createElement('div');
        d.className = 'dash-tile tone-' + t.tone;
        var l = document.createElement('div'); l.className = 'dash-label'; l.textContent = t.label;
        var v = document.createElement('div'); v.className = 'dash-value'; v.textContent = t.value;
        d.appendChild(l); d.appendChild(v); el.appendChild(d);
      });
    }
  };
})();
