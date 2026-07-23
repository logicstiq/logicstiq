/* ============================================================================
   LogistiQ — Paperwork intelligence (God-mode add-on v1)
   1) GSTIN validation (format + checksum) on any GSTIN field — deterministic, offline.
   2) Optional Gemini assist (via /api/ai): paste-to-fill line items, HSN suggestions,
      and an EXIM/procurement Q&A box. AI never asserts authoritative values — it drafts,
      extracts and SUGGESTS (verify). Additive, guarded — never breaks the page.
   Mirrors lib/gstin.mjs (the unit-tested source of truth).
   Load: <script src="/js/liq-paperwork.js" defer></script>
============================================================================ */
(function () {
  "use strict";
  var CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  var FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  function isValidGstin(g) {
    var s = (g == null ? "" : String(g)).trim().toUpperCase();
    if (!s) return { valid: false, reason: "empty" };
    if (!FORMAT.test(s)) return { valid: false, reason: "format" };
    var sum = 0;
    for (var i = 0; i < 14; i++) { var cp = CHARS.indexOf(s[i]); var f = (i % 2 === 0) ? 1 : 2; var p = cp * f; p = Math.floor(p / 36) + (p % 36); sum += p; }
    var expected = CHARS[(36 - (sum % 36)) % 36];
    return { valid: expected === s[14], reason: expected === s[14] ? "ok" : "checksum", expected: expected };
  }
  window.LIQPaperwork = { isValidGstin: isValidGstin };

  var esc = function (v) { return String(v == null ? "" : v).replace(/[<&>]/g, function (c) { return c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"; }); };

  /* ---- 1) GSTIN validation on any GSTIN-ish input ---- */
  function looksGstin(inp) {
    var h = ((inp.id || "") + " " + (inp.name || "") + " " + (inp.placeholder || "")).toLowerCase();
    return /gstin|gst no|gst number|gst in/.test(h);
  }
  function attachGstin(inp) {
    if (inp.__liqGst) return; inp.__liqGst = true;
    var note = document.createElement("span");
    note.style.cssText = "display:block;font-size:11px;margin-top:3px;min-height:14px";
    if (inp.parentNode) inp.parentNode.insertBefore(note, inp.nextSibling);
    function check() {
      var v = (inp.value || "").trim();
      if (!v) { note.textContent = ""; return; }
      if (v.length < 15) { note.textContent = "…" + v.length + "/15"; note.style.color = "#94A3B8"; return; }
      var r = isValidGstin(v);
      note.textContent = r.valid ? "✓ valid GSTIN" : (r.reason === "format" ? "✗ invalid format" : "✗ checksum fails (did you mistype?)");
      note.style.color = r.valid ? "#059669" : "#DC2626";
    }
    inp.addEventListener("input", check); inp.addEventListener("blur", check); check();
  }
  function scanGstin() { [].slice.call(document.querySelectorAll("input")).forEach(function (i) { if (looksGstin(i)) attachGstin(i); }); }

  /* ---- Gemini bridge ---- */
  async function ai(task, payload) {
    var r = await fetch("/api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ task: task }, payload)) });
    if (r.status === 503) throw new Error("AI not configured");
    var j = await r.json(); if (!j.ok) throw new Error(j.error || "AI error"); return j.result;
  }
  var IN = 'style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line,#d7dced);border-radius:8px;font:inherit;background:var(--card,#fff);color:inherit"';
  function elFrom(html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }

  /* ---- 2) AI assist panel (skipped where the sourcing intel panel already exists) ---- */
  function buildPanel() {
    if (document.getElementById("liq-sup-intel")) return;      // avoid a duplicate AI panel on sourcing pages
    if (document.getElementById("liq-pw-ai")) return;
    var sec = elFrom('<div class="wrap" id="liq-pw-ai" style="margin-top:24px"><div class="panel">' +
      '<div class="section-title">✦ Paperwork AI <span style="font-weight:600;color:#94A3B8">— assist only; verify before filing</span></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">' +
      '<div><div class="section-title" style="font-size:14px">Paste → line items</div>' +
      '<textarea id="pw_paste" rows="5" ' + IN + ' placeholder="Paste an order email / list… e.g. 10x Cotton Kurta @ 499, 5x Steel Bottle @ 250"></textarea>' +
      '<div style="margin-top:8px"><button class="btn btn-blue" id="pw_extract">✦ Extract line items</button></div><div id="pw_extractOut" style="margin-top:8px"></div></div>' +
      '<div><div class="section-title" style="font-size:14px">HSN suggestion &amp; EXIM Q&amp;A</div>' +
      '<input id="pw_hsn" ' + IN + ' placeholder="Product (e.g. cotton t-shirt) → HSN"><div style="margin-top:6px"><button class="btn btn-ghost" id="pw_hsnBtn">✦ Suggest HSN</button></div><div id="pw_hsnOut" style="margin:6px 0"></div>' +
      '<input id="pw_q" ' + IN + ' placeholder="Ask: do I need an e-way bill for ₹40k intra-state?"><div style="margin-top:6px"><button class="btn btn-ghost" id="pw_qBtn">✦ Ask</button></div><div id="pw_qOut" style="margin-top:6px"></div></div>' +
      '</div><div style="font-size:11px;color:#94A3B8;margin-top:10px">AI suggestions are drafts to verify with your CA/CHA — LogistiQ never files or asserts statutory values for you.</div></div></div>');
    document.body.appendChild(sec);

    bindAi(sec.querySelector("#pw_extract"), function () { return ai("extract-line-items", { text: val("pw_paste") }); }, "#pw_extractOut", renderItems);
    bindAi(sec.querySelector("#pw_hsnBtn"), function () { return ai("hsn-suggest", { text: val("pw_hsn") }); }, "#pw_hsnOut", renderHsn);
    bindAi(sec.querySelector("#pw_qBtn"), function () { return ai("qa", { text: val("pw_q") }); }, "#pw_qOut", renderText);
  }
  function val(id) { var e = document.getElementById(id); return e ? e.value : ""; }
  function renderText(o) { return typeof o === "string" ? esc(o) : esc(JSON.stringify(o)); }
  function renderItems(o) {
    var items = (o && o.items) || []; if (!items.length) return "No line items detected — try clearer text.";
    return '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th style="text-align:left;padding:3px 5px;color:#64748B">Item</th><th style="text-align:right;padding:3px 5px;color:#64748B">Qty</th><th style="text-align:right;padding:3px 5px;color:#64748B">Rate</th></tr></thead><tbody>' +
      items.map(function (it) { return "<tr><td style='padding:3px 5px'>" + esc(it.description || "") + (it.hsn ? " <span style='color:#94A3B8'>HSN " + esc(it.hsn) + "</span>" : "") + "</td><td style='padding:3px 5px;text-align:right'>" + esc(it.qty || "") + "</td><td style='padding:3px 5px;text-align:right'>" + esc(it.rate || "") + "</td></tr>"; }).join("") +
      "</tbody></table><div style='font-size:11px;color:#94A3B8;margin-top:4px'>Copy these into the document above — verify before generating.</div>";
  }
  function renderHsn(o) {
    var s = (o && o.suggestions) || []; if (!s.length) return "No suggestion — describe the product more specifically.";
    return s.map(function (x) { return "<div style='font-size:12px;margin:2px 0'><b>HSN " + esc(x.hsn || "?") + "</b> — " + esc(x.label || "") + " <span style='color:#94A3B8'>(" + esc(x.note || "verify") + ")</span></div>"; }).join("");
  }
  function bindAi(btn, fn, outSel, render) {
    if (!btn) return;
    btn.onclick = async function () {
      var old = btn.textContent; btn.textContent = "✦ thinking…"; btn.disabled = true;
      try {
        var out = await fn();
        var box = document.querySelector(outSel);
        box.innerHTML = '<div style="padding:10px 12px;border:1px solid #C7D2FE;background:#EEF2FF;border-radius:10px;color:#1E293B">' + render(out) + '</div>';
      } catch (e) {
        if (/not configured/i.test(e.message)) { hideAiPanel(); return; }
        btn.textContent = "✦ AI unavailable"; setTimeout(function () { btn.textContent = old; btn.disabled = false; }, 1500); return;
      }
      btn.textContent = old; btn.disabled = false;
    };
  }
  function hideAiPanel() { var p = document.getElementById("liq-pw-ai"); if (p) p.style.display = "none"; }

  function boot() { try { scanGstin(); } catch (e) { } try { buildPanel(); } catch (e) { } }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
