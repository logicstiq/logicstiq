/* liq-live.js — calculators recompute on input instead of on a button press.
 *
 * Reuses each page's existing calc function (found via the .btn-calc onclick
 * attribute) so the maths is untouched and new calculators are picked up for free.
 *
 * Those functions were written for a button, so during an auto-run we mute
 * alert() (they warn on incomplete fields) and scrollIntoView() (the page would
 * jump while typing), and swallow throws on partial input.
 *
 * The Calculate button is only hidden once a function has been wired, so if this
 * file fails to load the page still works exactly as before.
 */
(function () {
  'use strict';

  var DEBOUNCE_MS = 180;

  /* Never treat these as calculator fields. */
  var SKIP = [
    'nav', 'footer', '.lnav', '.lfoot',
    '#liqReview',            /* the feedback form */
    '.liqa-ov', '#liqaChip', /* the auth modal + account chip */
    '#liqCookie',            /* cookie banner */
    '.liq-copilot', '#liqCopilot'
  ].join(',');

  function inSkipZone(el) {
    return !!(el.closest && el.closest(SKIP));
  }

  /* Find the calculate buttons.
   *
   * We trigger them with .click() rather than looking the function up on window.
   * Several calculators declare theirs with const or inside an IIFE, so it is
   * never a window property and a name lookup silently finds nothing. Clicking
   * runs the page's own handler whatever scope it lives in.
   *
   * Only bare zero-argument calls qualify, which excludes the FAQ accordions
   * (toggleFaq(this)), tab switchers (switchTab('simple', this)) and inline
   * this.parentElement toggles.
   */
  function findTargets() {
    var out = [];
    var seen = {};
    var buttons = document.querySelectorAll('button[onclick], .btn-calc[onclick], .calc-btn[onclick]');

    Array.prototype.forEach.call(buttons, function (btn) {
      if (inSkipZone(btn)) return;
      var attr = btn.getAttribute('onclick') || '';
      var m = attr.match(/^\s*(?:return\s+)?([A-Za-z_$][\w$]*)\s*\(\s*\)\s*;?\s*$/);
      if (!m) return;
      if (seen[m[1]]) return;
      seen[m[1]] = true;
      /* A submit button would post the form instead of calculating. */
      btn.type = 'button';
      out.push({ name: m[1], btn: btn });
    });

    return out;
  }

  /* Trigger a calculation without letting it alert or scroll. */
  function runQuietly(btn) {
    var realAlert = window.alert;
    var realConfirm = window.confirm;
    var realScroll = Element.prototype.scrollIntoView;

    window.alert = function () {};
    window.confirm = function () { return false; };
    Element.prototype.scrollIntoView = function () {};

    try {
      btn.click();
    } catch (e) {
      /* Partial input: leave the previous result on screen. */
    } finally {
      window.alert = realAlert;
      window.confirm = realConfirm;
      Element.prototype.scrollIntoView = realScroll;
    }
  }

  /* Replace the Calculate button with a status line. */
  function markLive(btn) {
    if (!btn || btn.dataset.liqLive === '1') return;
    btn.dataset.liqLive = '1';
    /* Kept in the DOM (and clickable by us) for any code that looks it up. */
    btn.style.display = 'none';
    btn.setAttribute('aria-hidden', 'true');
    btn.tabIndex = -1;

    var note = document.createElement('p');
    note.className = 'liq-live-note';
    note.setAttribute('role', 'status');
    note.textContent = 'Results update as you type';
    if (btn.parentNode) btn.parentNode.insertBefore(note, btn);
  }

  /* Wire up. */
  function init() {
    var targets = findTargets();
    if (!targets.length) return;

    var timer = null;
    function recalc() {
      clearTimeout(timer);
      timer = setTimeout(function () {
        targets.forEach(function (t) { runQuietly(t.btn); });
      }, DEBOUNCE_MS);
    }

    var fields = document.querySelectorAll('input, select, textarea');
    var wired = 0;

    Array.prototype.forEach.call(fields, function (el) {
      if (inSkipZone(el)) return;
      var type = (el.type || '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'hidden' || type === 'file') return;

      /* input: typing, paste, spinners, range drags. change: selects. */
      el.addEventListener('input', recalc);
      el.addEventListener('change', recalc);
      wired++;
    });

    if (!wired) return;

    targets.forEach(function (t) { markLive(t.btn); });

    /* Back button, autofill or a prefilled link: show the result now. */
    recalc();

    /* Some pages bind Enter, some don't. Harmless either way. */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') recalc();
    });
  }

  /* Inline calc functions have already run by DOMContentLoaded. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
