(function () {
  'use strict';
  var root = document.documentElement;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Non-Mac / mobile note (the download link stays in place).
  try {
    var ua = navigator.userAgent || '';
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    var isMobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || (navigator.userAgentData && navigator.userAgentData.mobile);
    var isMac = /mac/i.test(platform) || /Macintosh/.test(ua);
    var note = document.getElementById('platform-note');
    if (note && (isMobile || !isMac)) note.hidden = false;
  } catch {}

  // Latest release version (progressive enhancement).
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

  // Scroll reveals.
  try {
    var items = document.querySelectorAll('.reveal');
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

  // Hero image scales up gently as the page scrolls.
  try {
    var hero = document.getElementById('hero-img');
    if (hero && !reduce) {
      var ticking = false;
      var update = function () {
        ticking = false;
        var p = Math.min(Math.max(window.scrollY / (window.innerHeight * 0.7), 0), 1);
        hero.style.transform = 'scale(' + (0.92 + 0.08 * p).toFixed(4) + ')';
      };
      hero.style.transform = 'scale(0.92)';
      window.addEventListener('scroll', function () {
        if (!ticking) { ticking = true; window.requestAnimationFrame(update); }
      }, { passive: true });
      window.addEventListener('resize', update);
      update();
    }
  } catch {}

  // Gallery prev/next.
  try {
    var strip = document.getElementById('gallery-strip');
    var btns = document.querySelectorAll('.gal-btns .arrow');
    var sync = function () {
      if (!strip || btns.length < 2) return;
      btns[0].disabled = strip.scrollLeft <= 4;
      btns[1].disabled = strip.scrollLeft >= strip.scrollWidth - strip.clientWidth - 4;
    };
    if (strip) {
      btns.forEach(function (b) {
        b.addEventListener('click', function () {
          var slide = strip.querySelector('.slide');
          var step = slide ? slide.getBoundingClientRect().width + 20 : strip.clientWidth * 0.8;
          strip.scrollBy({ left: step * Number(b.getAttribute('data-dir')), behavior: reduce ? 'auto' : 'smooth' });
        });
      });
      strip.addEventListener('scroll', function () { window.requestAnimationFrame(sync); }, { passive: true });
      strip.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          strip.scrollBy({ left: (e.key === 'ArrowRight' ? 1 : -1) * strip.clientWidth * 0.6, behavior: reduce ? 'auto' : 'smooth' });
        }
      });
      window.addEventListener('resize', sync);
      sync();
    }
  } catch {}
})();
