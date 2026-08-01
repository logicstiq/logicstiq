/* liq-shell.js — theme toggle and mobile menu for the shared nav.
 *
 * Replaces the per-page inline theme script the old pages each carried. Those
 * bound their own click handler to #liqTheme, so we clone the button before
 * binding: two handlers would toggle twice per click and appear to do nothing.
 */
(function () {
  'use strict';

  var root = document.documentElement;

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    try { localStorage.setItem('liq-theme', theme); } catch (e) {}
    label();
  }

  function label() {
    var b = document.getElementById('liqTheme');
    if (!b) return;
    var dark = root.getAttribute('data-theme') === 'dark';
    b.textContent = dark ? '☀' : '◐';
    b.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }

  function initTheme() {
    var btn = document.getElementById('liqTheme');
    if (!btn) return;

    /* Clone and replace, so exactly one click listener survives. */
    var fresh = btn.cloneNode(true);
    btn.parentNode.replaceChild(fresh, btn);

    fresh.addEventListener('click', function () {
      apply(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });
    label();
  }

  function initMenu() {
    var nav = document.getElementById('lnav');
    var burger = document.getElementById('lnavBurger');
    if (!nav || !burger) return;

    var fresh = burger.cloneNode(true);
    burger.parentNode.replaceChild(fresh, burger);

    fresh.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      fresh.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    /* Close on Escape, and when a menu link is followed. */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('open')) {
        nav.classList.remove('open');
        fresh.setAttribute('aria-expanded', 'false');
      }
    });
    nav.addEventListener('click', function (e) {
      if (e.target.closest('.lnav-panel a, .lnav-top[href]:not([href="#"])')) {
        nav.classList.remove('open');
        fresh.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function init() { initTheme(); initMenu(); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
