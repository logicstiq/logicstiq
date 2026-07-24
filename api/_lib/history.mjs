// ═══════════════════════════════════════════════════════════════════════════════════════════
// history.mjs — LogistiQ — SAVED HISTORY + FORECAST-VS-ACTUAL (God-mode add-on v1)
// ─────────────────────────────────────────────────────────────────────────────
// The trust engine. Two pure functions:
//   • mergeHistory()  — lengthen a seller's demand series by merging previously-saved sales
//                       facts with a fresh upload/sync (dedupe by sku+date, newest wins). Longer
//                       history ⇒ trend/seasonality/back-testing all get sharper each run.
//   • reconcileForecastVsActual() — score PAST forecasts against what actually sold, per SKU and
//                       overall (WMAPE + bias). This is the "we predicted 214, you sold 227 — 94%
//                       accurate" proof that earns a subscription.
//
// Persistence is handled client-side by js/liq-history.js using the seller's existing Firestore
// account (no new secrets). These functions are storage-agnostic and plain-Node testable.
// ─────────────────────────────────────────────────────────────────────────────

function num(v) { if (v == null || v === '') return 0; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[₹$£€,\s]/g, '')); return isNaN(n) ? 0 : n; }
const skuKey = s => (s == null ? '' : String(s)).toLowerCase().trim();
const monthOf = d => (d == null ? '' : String(d)).slice(0, 7);   // YYYY-MM

/**
 * mergeHistory(stored, incoming) → merged fact rows.
 *   Rows: { sku, date(YYYY-MM-DD), unitsSold, returns, available?, price?, ... }
 * Keyed by sku|date; the INCOMING row wins on conflict (fresher data), other fields preserved.
 * Returns a new array sorted by sku then date. Never mutates inputs.
 */
export function mergeHistory(stored = [], incoming = []) {
  const map = new Map();
  const put = (r, fresh) => {
    const k = skuKey(r.sku) + '|' + (r.date || '');
    if (!r.sku || !r.date) return;
    if (!map.has(k)) map.set(k, { ...r });
    else if (fresh) map.set(k, { ...map.get(k), ...r });   // incoming overwrites stored
  };
  stored.forEach(r => put(r, false));
  incoming.forEach(r => put(r, true));
  return [...map.values()].sort((a, b) => skuKey(a.sku).localeCompare(skuKey(b.sku)) || String(a.date).localeCompare(String(b.date)));
}

/** Aggregate fact rows to { 'skuLower|YYYY-MM': totalUnits }. */
export function factsToMonthly(rows = []) {
  const out = {};
  for (const r of rows) {
    const m = monthOf(r.date); if (!r.sku || !m) continue;
    const k = skuKey(r.sku) + '|' + m;
    out[k] = (out[k] || 0) + Math.max(0, num(r.unitsSold) - num(r.returns));
  }
  return out;
}

/**
 * reconcileForecastVsActual(forecasts, actualRows) → accuracy of PAST forecasts.
 *   forecasts:  [{ sku, period:'YYYY-MM', forecast:Number }]  (what we predicted for that month)
 *   actualRows: canonical fact rows that now cover those months
 * Returns { overall:{wmape,bias,samples,accuracy}, perSku:[{sku,period,forecast,actual,errorPct}] }
 */
export function reconcileForecastVsActual(forecasts = [], actualRows = []) {
  const actual = factsToMonthly(actualRows);
  let sAbs = 0, sAct = 0, sErr = 0, n = 0;
  const perSku = [];
  for (const f of forecasts) {
    const k = skuKey(f.sku) + '|' + monthOf(f.period);
    if (!(k in actual)) continue;                          // only score months we now have actuals for
    const a = actual[k], p = num(f.forecast);
    sAbs += Math.abs(p - a); sAct += Math.abs(a); sErr += (p - a); n++;
    perSku.push({ sku: f.sku, period: monthOf(f.period), forecast: Math.round(p), actual: Math.round(a), errorPct: a > 0 ? Math.round(Math.abs(p - a) / a * 100) : (p === 0 ? 0 : null) });
  }
  const wmape = sAct > 0 ? Math.round(sAbs / sAct * 100) : null;
  return {
    overall: { wmape, bias: sAct > 0 ? Math.round(sErr / sAct * 100) : null, samples: n, accuracy: wmape != null ? Math.max(0, 100 - wmape) : null },
    perSku: perSku.sort((a, b) => (b.forecast + b.actual) - (a.forecast + a.actual)),
  };
}

/** Convenience: how much did merging add? For a "history is compounding" nudge in the UI. */
export function historyGrowth(stored = [], merged = []) {
  const months = new Set(merged.map(r => monthOf(r.date)).filter(Boolean));
  return { rows: merged.length, addedRows: merged.length - stored.length, monthsCovered: months.size };
}
