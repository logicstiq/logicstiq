/* ============================================================================
   LogistiQ — Supplier Intelligence (God-mode add-on v1)
   Adds a supplier SCORECARD + LANDED-COST comparison to both Sourcing pages, plus
   optional Gemini narrative (via /api/ai). Deterministic math mirrors lib/sourcing.mjs
   (the unit-tested source of truth). Additive, guarded — never breaks the page.
   Load: <script src="/js/liq-sourcing.js" defer></script>
============================================================================ */
(function () {
  "use strict";
  var CL = { WEIGHTS: { otif: 0.30, leadReliability: 0.20, price: 0.20, quality: 0.20, fill: 0.10 } };
  var clamp = function (x, lo, hi) { return Math.max(lo, Math.min(hi, x)); };
  var num = function (v) { if (v == null || v === "") return 0; var n = parseFloat(String(v).replace(/[₹$£€,%\s]/g, "")); return isNaN(n) ? 0 : n; };
  var esc = function (v) { return String(v == null ? "" : v).replace(/[<&>]/g, function (c) { return c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"; }); };

  /* ---- pure logic (mirror of lib/sourcing.mjs) ---- */
  function scoreSupplier(s) {
    var w = CL.WEIGHTS;
    var otif = clamp(num(s.otifPct), 0, 100);
    var lt = Math.max(1, num(s.leadTimeDays));
    var cv = num(s.leadTimeVarDays) / lt;
    var leadReliability = clamp(100 * (1 - clamp(cv, 0, 1)), 0, 100);
    var pi = s.priceIndex != null && s.priceIndex !== "" ? num(s.priceIndex) : 1;
    var price = clamp(160 - 100 * pi, 0, 100);
    var quality = clamp(100 - num(s.defectPct) * 5, 0, 100);
    var fill = clamp(num(s.fillRatePct), 0, 100);
    var composite = otif * w.otif + leadReliability * w.leadReliability + price * w.price + quality * w.quality + fill * w.fill;
    var score = Math.round(composite);
    var grade = score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : "D";
    var risks = [];
    if (otif < 85) risks.push("OTIF below 85% — delivery reliability risk");
    if (cv > 0.3) risks.push("High lead-time variability — inflate safety stock");
    if (num(s.defectPct) > 3) risks.push("Elevated defect rate — quality risk");
    if (pi > 1.05) risks.push("Priced above market — renegotiate or dual-source");
    return { supplier: s.supplier || "Supplier", score: score, grade: grade,
      components: { otif: Math.round(otif), leadReliability: Math.round(leadReliability), price: Math.round(price), quality: Math.round(quality), fill: Math.round(fill) },
      leadTimeDays: lt, leadTimeCv: Math.round(cv * 100) / 100, risks: risks,
      recommendation: grade === "A" ? "Preferred — consolidate volume here" : grade === "D" ? "Replace or dual-source" : "Approved — monitor and improve weak components" };
  }
  function compareLandedCost(quotes) {
    var ranked = quotes.map(function (q) {
      var unit = num(q.unitPrice), freight = num(q.freightPerUnit), other = num(q.otherPerUnit);
      var duty = unit * (num(q.dutyPct) / 100);
      var gst = (unit + freight + duty) * (num(q.gstPct) / 100) * (1 - (q.itcShare != null ? q.itcShare : 1));
      var landed = Math.round((unit + freight + other + duty + gst) * 100) / 100;
      return { supplier: q.supplier || "Quote", landedPerUnit: landed, unitPrice: unit, freightPerUnit: freight, duty: Math.round(duty * 100) / 100, gstNet: Math.round(gst * 100) / 100 };
    }).filter(function (q) { return q.landedPerUnit > 0; }).sort(function (a, b) { return a.landedPerUnit - b.landedPerUnit; });
    var best = ranked[0] || null, worst = ranked[ranked.length - 1] || null;
    var save = best && worst ? Math.round((worst.landedPerUnit - best.landedPerUnit) * 100) / 100 : 0;
    return { ranked: ranked, best: best, savingsVsWorstPerUnit: save, savingsPct: best && worst && worst.landedPerUnit ? Math.round(save / worst.landedPerUnit * 100) : 0 };
  }
  window.LIQSourcing = { scoreSupplier: scoreSupplier, compareLandedCost: compareLandedCost };

  /* ---- Gemini bridge (optional; hidden if not configured) ---- */
  async function ai(task, payload) {
    var r = await fetch("/api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ task: task }, payload)) });
    if (r.status === 503) throw new Error("AI not configured");
    var j = await r.json(); if (!j.ok) throw new Error(j.error || "AI error"); return j.result;
  }

  /* ---- UI ---- */
  var IN = 'style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line,#d7dced);border-radius:8px;font:inherit;background:var(--card,#fff);color:inherit"';
  function el(html) { var d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; }
  function field(label, id, ph) { return '<label style="display:block;font-size:12px;color:#64748B;margin:8px 0 2px">' + label + '</label><input id="' + id + '" ' + IN + ' placeholder="' + (ph || "") + '">'; }

  function build() {
    if (document.getElementById("liq-sup-intel")) return;
    var host = document.getElementById("tool") || document.body;
    var sec = el('<div class="wrap" id="liq-sup-intel" style="margin-top:24px"><div class="panel">' +
      '<div class="section-title">🤝 Supplier Intelligence <span style="font-weight:600;color:#94A3B8">— scorecard &amp; true landed cost</span></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px" id="liq-si-grid"></div></div></div>');
    var grid = sec.querySelector("#liq-si-grid");

    // Scorecard
    var sc = el('<div><div class="section-title" style="font-size:14px">Supplier scorecard</div>' +
      field("Supplier name", "si_name", "Weave Co") +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
      '<div>' + field("OTIF %", "si_otif", "95") + '</div><div>' + field("Fill rate %", "si_fill", "97") + '</div>' +
      '<div>' + field("Lead time (days)", "si_lt", "20") + '</div><div>' + field("Lead-time variability (days)", "si_ltv", "3") + '</div>' +
      '<div>' + field("Price index (1.0 = market)", "si_pi", "1.0") + '</div><div>' + field("Defect %", "si_def", "2") + '</div>' +
      '</div><div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-blue" id="si_score">Score supplier</button>' +
      '<button class="btn btn-ghost" id="si_ai" style="display:none">✦ AI: review &amp; negotiation tips</button></div>' +
      '<div id="si_scoreOut" style="margin-top:10px"></div></div>');
    // Landed cost
    var lc = el('<div><div class="section-title" style="font-size:14px">Landed-cost comparison</div>' +
      '<div id="si_quotes"></div><button class="btn btn-ghost btn-add" id="si_addQ" style="margin-top:6px">+ Add quote</button>' +
      '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-blue" id="si_compare">Compare landed cost</button>' +
      '<button class="btn btn-ghost" id="si_lcai" style="display:none">✦ AI: explain the pick</button></div>' +
      '<div id="si_lcOut" style="margin-top:10px"></div></div>');
    grid.appendChild(sc); grid.appendChild(lc);
    if (host && host.id === "tool" && host.insertAdjacentElement) host.insertAdjacentElement("afterend", sec);
    else document.body.appendChild(sec);

    // quote rows
    function quoteRow(i) {
      return '<div style="display:grid;grid-template-columns:1.4fr 1fr 1fr .8fr .8fr;gap:6px;margin-bottom:6px" data-q="' + i + '">' +
        '<input ' + IN + ' data-f="supplier" placeholder="Supplier ' + i + '"><input ' + IN + ' data-f="unitPrice" placeholder="Unit ₹"><input ' + IN + ' data-f="freightPerUnit" placeholder="Freight/u"><input ' + IN + ' data-f="dutyPct" placeholder="Duty%"><input ' + IN + ' data-f="gstPct" placeholder="GST%"></div>';
    }
    var qWrap = sec.querySelector("#si_quotes"); qWrap.innerHTML = quoteRow(1) + quoteRow(2);
    sec.querySelector("#si_addQ").onclick = function () { var n = qWrap.children.length + 1; if (n <= 5) qWrap.appendChild(el(quoteRow(n))); };

    var lastScore = null, lastLc = null;
    function readScore() { return { supplier: val("si_name"), otifPct: val("si_otif"), fillRatePct: val("si_fill"), leadTimeDays: val("si_lt"), leadTimeVarDays: val("si_ltv"), priceIndex: val("si_pi"), defectPct: val("si_def") }; }
    function val(id) { var e = document.getElementById(id); return e ? e.value : ""; }

    sec.querySelector("#si_score").onclick = function () {
      try {
        lastScore = scoreSupplier(readScore());
        var c = lastScore.components;
        var bar = function (l, v) { return '<div style="display:flex;align-items:center;gap:8px;margin:3px 0"><span style="width:120px;font-size:11px;color:#64748B">' + l + '</span><div style="flex:1;height:8px;background:#eef1f7;border-radius:6px;overflow:hidden"><span style="display:block;height:8px;width:' + v + '%;background:' + (v >= 70 ? "#059669" : v >= 50 ? "#D97706" : "#DC2626") + '"></span></div><b style="font-size:11px">' + v + '</b></div>'; };
        var col = lastScore.grade === "A" ? "#059669" : lastScore.grade === "B" ? "#2A40D6" : lastScore.grade === "C" ? "#D97706" : "#DC2626";
        sec.querySelector("#si_scoreOut").innerHTML = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px"><span class="pill" style="background:' + col + ';color:#fff;font-weight:700">Grade ' + lastScore.grade + ' · ' + lastScore.score + '/100</span><span style="font-size:12px;color:#334155">' + esc(lastScore.recommendation) + '</span></div>' +
          bar("OTIF", c.otif) + bar("Lead reliability", c.leadReliability) + bar("Price", c.price) + bar("Quality", c.quality) + bar("Fill", c.fill) +
          (lastScore.risks.length ? '<ul style="margin:8px 0 0;padding-left:18px;color:#B45309;font-size:11px">' + lastScore.risks.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>" : "");
        var aiBtn = sec.querySelector("#si_ai"); aiBtn.style.display = ""; aiBtn.onclick = function () { runAi(aiBtn, "supplier-review", { data: lastScore }, "#si_scoreOut"); };
      } catch (e) { }
    };
    sec.querySelector("#si_compare").onclick = function () {
      try {
        var quotes = [].slice.call(qWrap.children).map(function (row) { var o = {}; [].slice.call(row.querySelectorAll("input")).forEach(function (i) { o[i.dataset.f] = i.value; }); return o; }).filter(function (o) { return num(o.unitPrice) > 0; });
        if (!quotes.length) return;
        lastLc = compareLandedCost(quotes);
        var rows = lastLc.ranked.map(function (q, i) { return '<tr' + (i === 0 ? ' style="font-weight:700;color:#059669"' : "") + '><td style="padding:4px 6px">' + (i === 0 ? "✓ " : "") + esc(q.supplier) + '</td><td style="padding:4px 6px;text-align:right">₹' + q.landedPerUnit.toLocaleString() + "</td></tr>"; }).join("");
        sec.querySelector("#si_lcOut").innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th style="text-align:left;padding:4px 6px;color:#64748B">Supplier</th><th style="text-align:right;padding:4px 6px;color:#64748B">Landed / unit</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          (lastLc.best && lastLc.savingsVsWorstPerUnit > 0 ? '<div style="margin-top:6px;font-size:12px;color:#334155">Best: <b>' + esc(lastLc.best.supplier) + '</b> — saves ₹' + lastLc.savingsVsWorstPerUnit.toLocaleString() + "/unit (" + lastLc.savingsPct + "%) vs the priciest landed.</div>" : "");
        var b = sec.querySelector("#si_lcai"); b.style.display = ""; b.onclick = function () { runAi(b, "landed-cost-explain", { data: lastLc.ranked }, "#si_lcOut"); };
      } catch (e) { }
    };

    // hide AI buttons if endpoint not configured (probe once, lazily on first click handled by catch)
  }

  async function runAi(btn, task, payload, outSel) {
    var old = btn.textContent; btn.textContent = "✦ thinking…"; btn.disabled = true;
    try {
      var out = await ai(task, payload);
      var box = document.querySelector(outSel);
      var note = document.createElement("div");
      note.style.cssText = "margin-top:8px;padding:10px 12px;border:1px solid #C7D2FE;background:#EEF2FF;border-radius:10px;font-size:12px;white-space:pre-wrap;color:#1E293B";
      note.textContent = typeof out === "string" ? out : JSON.stringify(out, null, 2);
      box.appendChild(note);
    } catch (e) {
      if (/not configured/i.test(e.message)) btn.style.display = "none";
      else { btn.textContent = "✦ AI unavailable"; setTimeout(function () { btn.textContent = old; btn.disabled = false; }, 1500); return; }
    }
    btn.textContent = old; btn.disabled = false;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
})();
