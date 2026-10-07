(function () {
  'use strict';
  var root = document.documentElement;

  // Non-Mac / mobile note (the download link stays in place).
  try {
    var ua = navigator.userAgent || '';
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    var isMobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (navigator.userAgentData && navigator.userAgentData.mobile);
    var isMac = /mac/i.test(platform) || /Macintosh/.test(ua);
    var note = document.getElementById('platform-note');
    if (note && (isMobile || !isMac)) note.hidden = false;
  } catch {}

  // Latest release version.
  try {
    var out = document.getElementById('release-info');
    if (out && window.fetch) {
      fetch('https://api.github.com/repos/MagnusOlstad/folio/releases/latest', { headers: { Accept: 'application/vnd.github+json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !d.tag_name) return;
          var text = 'Latest version ' + d.tag_name;
          if (d.published_at) {
            var date = new Date(d.published_at);
            if (!isNaN(date)) text += ' · ' + date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
          }
          out.textContent = text + ' ·';
          out.hidden = false;
        })
        .catch(function () {});
    }
  } catch {}

  // Scroll reveal, skipped for reduced motion.
  try {
    var items = document.querySelectorAll('.reveal');
    var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduce && 'IntersectionObserver' in window && items.length) {
      root.classList.add('js');
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
        });
      }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
      items.forEach(function (el) { io.observe(el); });
    }
  } catch {}
})();
