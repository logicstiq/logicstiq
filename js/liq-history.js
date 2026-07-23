/* ============================================================================
   LogistiQ — Saved History + Forecast-vs-Actual (God-mode add-on v1)
   ----------------------------------------------------------------------------
   Reuses the seller's EXISTING Firestore account (window.LIQ from liq-auth.js) —
   no new config, no new secrets. Works with zero page edits: it observes calls to
   /api/forecast, saves each run's forecasts to the user's private account, and when
   a later run's uploaded actuals cover a month we previously predicted, it scores
   the old forecast and shows an accuracy badge ("we predicted 214, you sold 227").

   Load once (defer):  <script src="/js/liq-history.js" defer></script>
   Everything is wrapped in try/catch — it can never break the planner.
============================================================================ */
(function () {
  "use strict";
  var SUB = "demandRuns";            // Firestore subcollection under users/{uid}/
  var MAXRUNS = 24;                  // how many past runs to consider

  function whenLIQ(cb, n) { n = n || 0; if (window.LIQ && window.LIQ.onReady) return cb(); if (n > 60) return; setTimeout(function () { whenLIQ(cb, n + 1); }, 200); }
  function num(v) { if (v == null || v === "") return 0; var n = typeof v === "number" ? v : parseFloat(String(v).replace(/[₹$£€,\s]/g, "")); return isNaN(n) ? 0 : n; }
  function monthOf(s) { return (s == null ? "" : String(s)).slice(0, 7); }
  function nextMonth(d) { var x = new Date(d); x.setMonth(x.getMonth() + 1); return x.toISOString().slice(0, 7); }

  // Parse the uploaded CSV body → monthly actual units per SKU { 'sku|YYYY-MM': units }
  function actualsFromCsv(csv) {
    var out = {}; if (!csv) return out;
    var lines = String(csv).replace(/\r/g, "").split("\n").filter(function (l) { return l.trim(); });
    if (lines.length < 2) return out;
    var split = function (l) { return (l.indexOf("\t") >= 0 && l.indexOf(",") < 0) ? l.split("\t") : l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(function (c) { return c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"').trim(); }).slice(0, -1); };
    var H = split(lines[0]).map(function (h) { return h.toLowerCase().trim(); });
    function idx(names) { for (var i = 0; i < H.length; i++) for (var j = 0; j < names.length; j++) if (H[i] === names[j] || H[i].indexOf(names[j]) >= 0) return i; return -1; }
    var iS = idx(["sku", "asin", "item", "product code"]), iD = idx(["date", "month", "period"]), iU = idx(["units sold", "qty sold", "units", "quantity", "sales"]), iR = idx(["returns", "rto"]);
    if (iS < 0 || iD < 0 || iU < 0) return out;
    for (var k = 1; k < lines.length; k++) {
      var c = split(lines[k]); var sku = (c[iS] || "").toLowerCase().trim(); var m = monthOf(c[iD]); if (!sku || !m) continue;
      var key = sku + "|" + m; out[key] = (out[key] || 0) + Math.max(0, num(c[iU]) - (iR >= 0 ? num(c[iR]) : 0));
    }
    return out;
  }

  // Reconcile past saved forecasts against these fresh actuals → accuracy.
  function reconcile(pastRuns, actuals) {
    var sAbs = 0, sAct = 0, sErr = 0, n = 0, examples = [];
    (pastRuns || []).forEach(function (run) {
      (run.forecasts || []).forEach(function (f) {
        var key = (f.sku || "").toLowerCase() + "|" + f.period;
        if (!(key in actuals)) return;
        var a = actuals[key], p = num(f.forecast);
        sAbs += Math.abs(p - a); sAct += Math.abs(a); sErr += (p - a); n++;
        if (examples.length < 3 && a > 0) examples.push({ sku: f.sku, period: f.period, forecast: Math.round(p), actual: Math.round(a) });
      });
    });
    if (!n || sAct <= 0) return null;
    return { wmape: Math.round(sAbs / sAct * 100), bias: Math.round(sErr / sAct * 100), accuracy: Math.max(0, 100 - Math.round(sAbs / sAct * 100)), samples: n, examples: examples };
  }

  function renderBadge(acc) {
    try {
      if (!acc) return;
      var host = document.getElementById("liq-results"); if (!host) return;
      var id = "liq-accuracy-badge"; var el = document.getElementById(id);
      if (!el) { el = document.createElement("div"); el.id = id; el.style.cssText = "margin:14px 0;padding:12px 16px;border:1px solid #C7D2FE;background:#EEF2FF;border-radius:12px;font-size:13px;color:#1E293B"; host.insertBefore(el, host.firstChild); }
      var ex = acc.examples.map(function (e) { return e.sku + ": predicted " + e.forecast.toLocaleString() + ", sold " + e.actual.toLocaleString() + " (" + e.period + ")"; }).join(" · ");
      el.innerHTML = "🎯 <strong>Forecast accuracy on your history:</strong> ~" + acc.accuracy + "% (WMAPE " + acc.wmape + "%, bias " + (acc.bias >= 0 ? "+" : "") + acc.bias + "%) across " + acc.samples + " SKU-months." + (ex ? '<div style="color:#475569;margin-top:5px;font-size:11px">' + ex + "</div>" : "");
    } catch (e) { }
  }

  // Save this run's per-SKU next-30-day forecast, attributed to next calendar month.
  function saveRun(data) {
    try {
      if (!window.LIQ || !window.LIQ.saveDoc) return;
      var fcs = (data.demandForecast || []).slice(0, 500).map(function (s) { return { sku: s.sku, period: nextMonth(new Date()), forecast: num(s.next30) }; });
      if (!fcs.length) return;
      window.LIQ.saveDoc(SUB, { at: Date.now(), horizon: (data.summary && data.summary.horizon) || null, forecasts: fcs });
    } catch (e) { }
  }

  function onForecast(reqBody, respData) {
    whenLIQ(function () {
      window.LIQ.onReady(function (user) {
        if (!user) return;                     // only for signed-in sellers
        try {
          var csv = "";
          try { csv = (JSON.parse(reqBody) || {}).csvText || ""; } catch (e) { }
          var actuals = actualsFromCsv(csv);
          if (window.LIQ.listDocs) {
            window.LIQ.listDocs(SUB).then(function (runs) {
              renderBadge(reconcile((runs || []).slice(0, MAXRUNS), actuals));
            }).catch(function () { });
          }
          saveRun(respData || {});
        } catch (e) { }
      });
    });
  }

  // Non-invasive: observe /api/forecast without any page edits.
  try {
    var _fetch = window.fetch;
    window.fetch = function (input, init) {
      var url = (typeof input === "string") ? input : (input && input.url) || "";
      var body = init && init.body;
      var p = _fetch.apply(this, arguments);
      if (/\/api\/forecast\b/.test(url) && init && init.method === "POST") {
        p.then(function (res) { try { res.clone().json().then(function (d) { if (d && d.demandForecast) onForecast(body, d); }).catch(function () { }); } catch (e) { } });
      }
      return p;
    };
  } catch (e) { }

  // Public API for explicit wiring if preferred.
  window.LIQHistory = { saveRun: saveRun, _reconcile: reconcile, _actualsFromCsv: actualsFromCsv };
})();
