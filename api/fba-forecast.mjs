// ═══════════════════════════════════════════════════════════════════════════════════════════
// fba-forecast.mjs — LogicstIQ FBA Planner — FORECASTING & DEMAND-PLANNING ENGINE (v2)
// ─────────────────────────────────────────────────────────────────────────────
// Consumes the four Amazon reports the FBA Planner page uploads (Restock, Inventory, Trend, ASP):
//
//   • FORECAST   — per-ASIN model on a regular calendar (smoothing / damped trend / intermittent),
//                  chosen by a hold-out test, seasonality learned from your own portfolio, blended
//                  with the fresh 30-day sales in the Restock report.
//   • SEND PLAN  — order-up-to (lead time + days-of-supply target + safety stock), capped by FBA
//                  RESTOCK LIMITS, prioritised.
//   • ECONOMICS  — true FBA contribution = price − referral − fulfilment − storage − LTSF − landed cost.
//   • STORAGE    — monthly storage-fee forecast incl. the Q4 (Oct–Dec) peak multiplier.
//   • LTSF/AGED  — aged-inventory (365+/271-365) long-term-storage-fee risk + keep-vs-remove decision.
//   • IPI HEALTH — excess / aged / stranded (unsellable) classification that drives IPI.
//
// v2 — ACCURACY BUILD (2026-10-01). Changes are tagged "FIX(v2)" inline. Measured with a hold-out
// test (forecast at a cut-off, scored on the 30/60/90 days after it) on 64 synthetic ASINs × 3 seeds
// × 2 cut-offs (late May and early October), four trend-file shapes, with and without shared
// seasonality. Response JSON shape is unchanged; new fields are additive.
//   1. The lead time typed on the page (body.leadTime) was ignored — every ASIN used 45 days.
//   2. A trend file that included the current, unfinished month treated it as a full month, so the
//      newest point was tiny and every forecast collapsed (−33% to −46% bias in early-month runs).
//      Part periods at the end are now dropped.
//   3. Months with no sales were missing from the series instead of being zero, and an ASIN that
//      stopped selling kept being forecast from its last good month. Every ASIN is now placed on
//      one calendar; a long run of zeros with stock on hand means demand has stopped.
//   4. Daily / order-level trend files were squashed into calendar months; they now become weeks
//      ending on the last full day, so the model sees ~4× more points and reacts faster.
//   5. A zero run in the middle of a series that is too long to be chance is a stockout, not zero
//      demand; it is filled from the neighbouring periods instead of dragging the level down.
//   6. The marketplace-level trend dashboard (Marketplace / Start Date / Units — the format the page
//      asks for) has no ASIN column, so the engine silently ignored it. It now supplies the
//      seasonal profile. Per-ASIN trend files supply it too. The profile is switched on only when it
//      beats a flat forecast on your own last few months.
//   7. Model choice is by the error on 30-day totals in a rolling hold-out (newest data unseen),
//      not by one-step error, with a margin before leaving simple smoothing.
//   8. The 30-day sales in the Restock report — the freshest number in any upload — is blended
//      with the trend-file model instead of being thrown away.
//   9. Safety stock used the spread of monthly sales (which counts trend and seasonality as noise)
//      or a flat 40% of velocity. It now uses the measured forecast error, calibrated so that the
//      reorder point covers lead-time demand at the chosen service level, plus the sampling error
//      of a 30-day snapshot; small sellers use a count distribution.
//  10. "Reorder now" fired only once stock fell below plain lead-time demand (no safety stock), so
//      ~half of the flagged ASINs would already stock out. It now fires at the reorder point.
//  11. Days of supply and send quantities walk the day-by-day forecast (season-aware) instead of
//      multiplying one velocity.
//  12. The headline accuracy was a simple average of one-step errors; it is now the volume-weighted
//      error on 30-day totals, the number a planner actually lives with.
//  13. Trend rows are matched to Restock rows by ASIN, FNSKU or SKU (was ASIN-first only); Business
//      Report "(Child) ASIN" is preferred over "(Parent) ASIN"; Excel dates that arrive as
//      "Sun Jun 01 2026 … GMT+0530" strings keep their local calendar date.
//  14. Realised ASP (Sales last 30 days ÷ Units) and the ASP report's Revenue ÷ Units are used for
//      price when present.
//  15. ASINs that are out of stock with no recent sales but that Amazon still recommends
//      replenishing are flagged (demand hidden by the stockout) instead of shown as "No demand".
//
// SELF-CONTAINED: imports only probabilistic.mjs. Runs in plain Node with no config.
// All fee figures are INDICATIVE India FBA defaults, seller-overridable, and superseded by report values.
// ─────────────────────────────────────────────────────────────────────────────
import { probit } from './_lib/probabilistic.mjs';

// ═══ CONFIG — India FBA fee defaults (directional; report values win when present) ═══════════
export const FBA_DEFAULTS = {
  currency: '₹',
  referralByCategory: { mobiles: 0.06, electronics: 0.09, appliances: 0.12, jewellery: 0.18, footwear: 0.16, fashion: 0.18, beauty: 0.18, fmcg: 0.12, gifting: 0.15, home: 0.15, default: 0.15 },
  fulfilmentBySize: { small: 33, standard: 55, heavyStandard: 90, smallOversize: 140, largeOversize: 220, default: 60 }, // ₹/unit
  storagePerUnitMonth: 20,        // ₹/unit/month (standard) — directional
  peakMonths: [10, 11, 12],       // Oct–Dec storage peak
  peakStorageMultiplier: 2.4,
  ltsfPerUnit365: 150,            // ₹/unit aged-inventory surcharge (365+ days)
  ltsfPerUnit271: 60,             // approaching-LTSF (271–365 days)
  removalFeePerUnit: 30,
  targetDaysOfSupply: 60,         // default DoS target for send quantity
  minReorderDoS: 30,              // reorder trigger
  serviceLevel: 0.95,
  leadTimeDays: 45,               // manufacture + inbound to FC
  leadTimeStdDays: 0,             // optional: spread of the lead time (days) — adds to safety stock
};

// Tuning constants (see FIX(v2) notes). Measured on the hold-out harness, not guessed.
const SEASON_SHRINK = 0.2;   // a calendar month seen once keeps 1/(1+0.2)=83% of its measured effect (hold-out gate guards against noise)
const DRIFT_DEFAULT = 0.15;  // relative forecast error assumed when there is no history to calibrate on
const W_SERIES = 0.4;        // weight on the trend-file model vs the Restock 30-day rate

const SIZE_TIERS = ['small', 'standard', 'heavyStandard', 'smallOversize', 'largeOversize'];
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r2 = x => Math.round(x * 100) / 100;
const r0 = x => Math.round(x);

function num(v) {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[₹$£€,\s%]/g, '').replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}
function meanA(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function stdA(a) { if (a.length < 2) return 0; const m = meanA(a); return Math.sqrt(a.map(x => (x - m) ** 2).reduce((x, y) => x + y, 0) / (a.length - 1)); }
function linreg(y) { const n = y.length; if (n < 2) return { a: y[0] || 0, b: 0 }; let sx = 0, sy = 0, sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sx += i; sy += y[i]; sxx += i * i; sxy += i * y[i]; } const d = n * sxx - sx * sx; const b = d ? (n * sxy - sx * sy) / d : 0; return { a: (sy - b * sx) / n, b }; }
function median(a) { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

// Count-distribution quantiles (small volumes): Poisson, or Negative-Binomial when over-dispersed.
function poissonQuantile(m, level) {
  if (m <= 0) return 0;
  let pmf = Math.exp(-m), cdf = pmf, k = 0; const cap = Math.ceil(m + 12 * Math.sqrt(m + 1) + 20);
  while (cdf < level && k < cap) { k++; pmf *= m / k; cdf += pmf; }
  return k;
}
function countQuantile(m, v, level) {
  if (m <= 0) return 0;
  if (v <= m * 1.05) return poissonQuantile(m, level);
  const r = (m * m) / (v - m), p = r / (r + m);
  let pmf = Math.pow(p, r), cdf = pmf, k = 0; const cap = Math.ceil(m + 14 * Math.sqrt(v) + 30);
  if (!(pmf > 0)) return Math.ceil(m + probit(level) * Math.sqrt(v));
  while (cdf < level && k < cap) { k++; pmf *= ((k - 1 + r) / k) * (1 - p); cdf += pmf; }
  return k;
}
function demandQuantile(m, v, level) {
  if (m <= 0) return 0;
  if (m < 30) return countQuantile(m, Math.max(v, m), level);
  return Math.ceil(m + probit(level) * Math.sqrt(Math.max(v, m)));
}

// ═══ CALENDAR — FIX(v2) #2 #3 #4 #13 ═════════════════════════════════════════
const DAYMS = 86400000;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const dnum = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / DAYMS);
const ymd = dn => { const t = new Date(dn * DAYMS); return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()]; };
const monthIdxOf = dn => { const [y, m] = ymd(dn); return y * 12 + m - 1; };
const monthStart = mi => dnum(Math.floor(mi / 12), (mi % 12) + 1, 1);
const monthLen = mi => monthStart(mi + 1) - monthStart(mi);
const isoDay = dn => new Date(dn * DAYMS).toISOString().slice(0, 10);
function okD(y, m, d, monthOnly = false) { if (!(y > 1990 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null; return { d: dnum(y, m, d), monthOnly }; }
/** Parse a report date into a UTC day number. order: 'dmy' (default) or 'mdy' for 01/02/2026 style. */
export function parseDay(v, order = 'dmy') {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v) ? null : { d: dnum(v.getFullYear(), v.getMonth() + 1, v.getDate()), monthOnly: false };
  const s = String(v).trim(); if (!s) return null;
  let m;
  if (/^\d{5}(\.\d+)?$/.test(s)) { const n = Math.floor(+s); if (n > 20000 && n < 80000) return { d: n - 25569, monthOnly: false }; }  // Excel serial
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?/))) return okD(+m[1], +m[2], m[3] ? +m[3] : 1, !m[3]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/))) { let y = +m[3]; if (y < 100) y += 2000; const a = +m[1], b = +m[2]; return (order === 'mdy' || b > 12) && a <= 12 ? okD(y, a, b) : okD(y, b, a); }
  if ((m = s.match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/)) && MONTHS[m[1].toLowerCase()]) return okD(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);   // "Jun 01 2026", "Sun Jun 01 2026 … GMT+0530"
  if ((m = s.match(/\b(\d{1,2})[\s\-]+([A-Za-z]{3})[a-z]*[\s\-,]+(\d{2,4})\b/)) && MONTHS[m[2].toLowerCase()]) { let y = +m[3]; if (y < 100) y += 2000; return okD(y, MONTHS[m[2].toLowerCase()], +m[1]); }
  if ((m = s.match(/\b([A-Za-z]{3})[a-z]*[\s\-'’]+(\d{4}|\d{2})\b/)) && MONTHS[m[1].toLowerCase()]) { let y = +m[2]; if (y < 100) y += 2000; return okD(y, MONTHS[m[1].toLowerCase()], 1, true); }
  const t = Date.parse(s); if (!isNaN(t)) { const x = new Date(t); return { d: dnum(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()), monthOnly: false }; }
  return null;
}
const minOf = a => { let m = Infinity; for (const v of a) if (v < m) m = v; return m; };
const maxOf = a => { let m = -Infinity; for (const v of a) if (v > m) m = v; return m; };
function pickCol(headers, names, exclude) {
  const H = headers.filter(h => !(exclude && exclude.test(h)));
  for (const nm of names) { const h = H.find(k => k === nm); if (h) return h; }
  for (const nm of names) { const h = H.find(k => k.includes(nm)); if (h) return h; }
  return null;
}

/**
 * Turn a trend / business report into (a) one regular-calendar series per ASIN and (b) a portfolio
 * monthly total for the seasonal profile. Works for per-ASIN files (daily, weekly or monthly rows)
 * and for marketplace-level dashboards with no ASIN column.
 */
export function analyseTrend(rows, asOfDay) {
  const out = { kind: null, gran: null, periods: [], series: {}, monthly: [], notes: [] };
  if (!rows || !rows.length) return out;
  const H = Object.keys(rows[0]);
  const cAsin = pickCol(H, ['(child) asin', 'child asin', 'asin'], /parent/);
  const cFn = pickCol(H, ['fnsku']);
  const cSku = pickCol(H, ['merchant sku', 'seller-sku', 'seller sku', 'msku', 'sku'], /fnsku|parent/);
  const cStart = pickCol(H, ['start date', 'from date', 'period start']);
  const cEnd = pickCol(H, ['end date', 'to date', 'period end']);
  const cDate = cStart || pickCol(H, ['date', 'month', 'order date', 'purchase date', 'sale date', 'period', 'week'], /end date|to date/);
  const cUnits = pickCol(H, ['units ordered', 'units sold', 'ordered units', 'total units', 'quantity', 'qty', 'units'], /b2b|%|session|price|revenue|sales\b|refund|return/);
  const cMkt = pickCol(H, ['marketplace', 'sales channel', 'channel']);
  if (!cDate || !cUnits) { out.notes.push('Trend file: no date or units column found — forecast uses the Restock 30-day sales only.'); return out; }
  out.kind = (cAsin || cFn || cSku) ? 'asin' : 'market';

  // day/month order for 01/02/2026-style dates, decided once for the whole file
  let a12 = 0, b12 = 0;
  for (let i = 0; i < Math.min(rows.length, 3000); i++) { const m = String(rows[i][cDate] || '').trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/); if (m) { if (+m[1] > 12) a12++; if (+m[2] > 12) b12++; } }
  const order = b12 > a12 ? 'mdy' : 'dmy';

  // marketplace filter for dashboards: Amazon aggregate row if present, else all Amazon rows, else all rows
  let keepMkt = null;
  if (out.kind === 'market' && cMkt) {
    const vals = [...new Set(rows.map(o => String(o[cMkt] || '').trim().toLowerCase()))];
    const amz = vals.filter(v => /amazon/.test(v));
    const agg = amz.find(v => /^amazon(\s*\(all\)|\s*all|\s*total)?$/.test(v));
    keepMkt = new Set(agg ? [agg] : amz.length ? amz : vals);
  }

  const recs = []; let monthOnly = true, spans = [];
  const dCache = new Map(); const pd = v => { const k = String(v); let r = dCache.get(k); if (r === undefined) { r = parseDay(v, order); dCache.set(k, r); } return r; };
  const miCache = new Map(); const monthOf = dn => { let m = miCache.get(dn); if (m === undefined) { m = monthIdxOf(dn); miCache.set(dn, m); } return m; };
  for (const o of rows) {
    if (keepMkt && !keepMkt.has(String(o[cMkt] || '').trim().toLowerCase())) continue;
    const p = pd(o[cDate]); if (!p) continue;
    let d = p.d, e = null;
    if (cStart && cEnd) { const q = pd(o[cEnd]); if (q && q.d >= p.d) { e = q.d; spans.push(q.d - p.d + 1); d = Math.floor((p.d + q.d) / 2); } }
    if (!p.monthOnly) monthOnly = false;
    const u = Math.max(0, num(o[cUnits]));
    const ids = out.kind === 'asin' ? [cAsin && o[cAsin], cFn && o[cFn], cSku && o[cSku]].map(x => String(x || '').trim().toLowerCase()).filter(Boolean) : [];
    if (out.kind === 'asin' && !ids.length) continue;
    recs.push({ d, s: p.d, e, u, ids, monthOnly: p.monthOnly });
  }
  if (!recs.length) { out.kind = null; out.notes.push('Trend file: no readable dated rows.'); return out; }

  // granularity
  let gran;
  if (monthOnly) gran = 'monthly';
  else if (spans.length) { const sp = median(spans); gran = sp >= 25 ? 'monthly' : sp >= 6 ? 'weekly' : 'daily'; }
  else {
    const days = [...new Set(recs.map(r => r.d))].sort((x, y) => x - y);
    const diffs = []; for (let i = 1; i < days.length; i++) diffs.push(days[i] - days[i - 1]);
    const g = diffs.length ? median(diffs) : 30;
    gran = g <= 1.5 ? 'daily' : g <= 8 ? 'weekly' : 'monthly';
  }
  out.gran = gran;
  const minDay = minOf(recs.map(r => r.s));
  const maxDay = maxOf(recs.map(r => r.e != null ? r.e : r.d));

  // regular periods [s, e] (inclusive day numbers), ascending; part periods at either end dropped
  const periods = [];
  let pidOf;
  if (gran === 'monthly') {
    const mis = recs.map(r => monthOf(r.d));
    let lo = minOf(mis), hi = maxOf(mis);
    if (monthStart(hi + 1) > asOfDay) { hi--; out.notes.push(`Trend file: the unfinished month (${isoDay(monthStart(hi + 1)).slice(0, 7)}) was left out — a part month reads as a sales collapse.`); }
    for (let mi = lo; mi <= hi; mi++) periods.push({ s: monthStart(mi), e: monthStart(mi + 1) - 1, mi });
    pidOf = r => { const k = monthOf(r.d) - lo; return k >= 0 && k < periods.length ? k : -1; };
  } else if (gran === 'weekly') {
    const starts = recs.map(r => r.s);
    const anchor = maxOf(starts);
    let hiEnd = anchor + 6;
    let nWeeks = Math.floor((anchor - minOf(starts)) / 7) + 1;
    let dropLast = hiEnd >= asOfDay;
    if (dropLast) out.notes.push('Trend file: the unfinished latest week was left out.');
    for (let k = nWeeks - 1; k >= (dropLast ? 1 : 0); k--) periods.push({ s: anchor - 7 * k, e: anchor - 7 * k + 6 });
    pidOf = r => { const k = Math.round((anchor - r.s) / 7); const idx = nWeeks - 1 - k; return idx >= 0 && idx < periods.length ? idx : -1; };
  } else {
    const end = Math.min(maxDay, asOfDay - 1);
    const nW = Math.floor((end - minDay + 1) / 7);              // whole weeks only
    for (let k = nW - 1; k >= 0; k--) periods.push({ s: end - 7 * k - 6, e: end - 7 * k });
    pidOf = r => { if (r.d > end) return -1; const k = Math.floor((end - r.d) / 7); const idx = nW - 1 - k; return idx >= 0 && idx < nW ? idx : -1; };
    if (maxDay >= asOfDay) out.notes.push('Trend file: today\'s part day was left out.');
    out.notes.push(`Trend file: daily rows grouped into ${nW} weeks ending ${isoDay(end)}.`);
  }
  out.periods = periods;
  if (periods.length < 2) { out.kind = out.kind === 'asin' ? 'asin' : null; }

  // per-ASIN series (zero-filled), indexed by every id the row carries
  if (out.kind === 'asin') {
    const acc = new Map();   // primary id -> {ids:Set, y:Float64Array}
    const alias = new Map();
    for (const r of recs) {
      const pi = pidOf(r); if (pi < 0) continue;
      let key = r.ids.map(i => alias.get(i)).find(Boolean) || r.ids[0];
      let e = acc.get(key); if (!e) { e = { ids: new Set(), y: new Float64Array(periods.length) }; acc.set(key, e); }
      for (const i of r.ids) { e.ids.add(i); if (!alias.has(i)) alias.set(i, key); }
      e.y[pi] += r.u;
    }
    for (const [, e] of acc) {
      let first = 0; while (first < e.y.length && e.y[first] <= 0) first++;
      const s = { y: Array.from(e.y.slice(first)), p0: first };
      for (const i of e.ids) out.series[i] = s;
    }
  }

  // portfolio monthly totals over COMPLETE months (seasonal profile)
  const byM = new Map();
  for (const r of recs) { if (gran !== 'monthly' && r.d > Math.min(maxDay, asOfDay - 1)) continue; const mi = monthOf(r.d); byM.set(mi, (byM.get(mi) || 0) + r.u); }
  let mis = [...byM.keys()].sort((x, y) => x - y);
  if (mis.length) {
    const lastFull = gran === 'monthly' ? (periods.length ? periods[periods.length - 1].mi : -1) : monthIdxOf(Math.min(maxDay, asOfDay - 1) + 1) - 1;
    const firstFull = gran === 'monthly' ? mis[0] : (ymd(minDay)[2] === 1 ? monthIdxOf(minDay) : monthIdxOf(minDay) + 1);
    for (let mi = firstFull; mi <= lastFull; mi++) out.monthly.push({ mi, u: byM.get(mi) || 0 });
  }
  return out;
}

// ═══ SEASONAL PROFILE — FIX(v2) #6 ═══════════════════════════════════════════
// log(daily rate) = level + trend·t + month effect, fitted by back-fitting with the month effects
// shrunk toward zero (a month seen once is weak evidence). Returns 12 factors averaging 1.
export function fitSeasonProfile(ms) {
  const n = ms.length; if (n < 12) return null;
  if (meanA(ms.map(o => o.u)) < 30 || ms.filter(o => o.u <= 0).length > 1) return null;   // too thin to read seasonality
  const r = ms.map(o => Math.log(Math.max(o.u, 0.5) / monthLen(o.mi)));
  let s = Array(12).fill(0);
  for (let it = 0; it < 12; it++) {
    const { a, b } = linreg(r.map((v, i) => v - s[ms[i].mi % 12]));
    const sum = Array(12).fill(0), cnt = Array(12).fill(0);
    r.forEach((v, i) => { const k = ms[i].mi % 12; sum[k] += v - (a + b * i); cnt[k]++; });
    s = sum.map((v, k) => cnt[k] ? (v / cnt[k]) * cnt[k] / (cnt[k] + SEASON_SHRINK) : 0);
    const mu = meanA(s); s = s.map(v => v - mu);
  }
  const F = s.map(v => clamp(Math.exp(v), 0.4, 2.5)); const m = meanA(F);
  return F.map(v => v / m);
}
// Hold-out check: does the profile beat a flat forecast on the last few months of the portfolio?
function validateSeason(ms) {
  const n = ms.length; if (n < 15) return { ok: false, why: `needs 15+ complete months (have ${n})` };
  let eF = 0, eS = 0, A = 0;
  for (let o = Math.max(12, n - 5); o <= n - 3; o++) {
    const F = fitSeasonProfile(ms.slice(0, o)); if (!F) return { ok: false, why: 'needs 12+ complete months with steady volume' };
    const base = [o - 2, o - 1];
    const flat = meanA(base.map(i => ms[i].u / monthLen(ms[i].mi)));
    const des = meanA(base.map(i => ms[i].u / monthLen(ms[i].mi) / F[ms[i].mi % 12]));
    for (let k = o; k < o + 3; k++) { const L = monthLen(ms[k].mi); eF += Math.abs(flat * L - ms[k].u); eS += Math.abs(des * F[ms[k].mi % 12] * L - ms[k].u); A += ms[k].u; }
  }
  return { ok: eS <= 0.9 * eF, errFlat: A ? Math.round(100 * eF / A) : null, errSeasonal: A ? Math.round(100 * eS / A) : null };
}
// Day-level factor: monthly factors interpolated between month mid-points.
function makeSeasonFn(F) {
  const cache = new Map();
  const at = dn => {
    if (!F) return 1;
    let v = cache.get(dn); if (v != null) return v;
    const [y, m, d] = ymd(dn); const L = monthLen(y * 12 + m - 1); const f = (d - 0.5) / L; const k = m - 1;
    v = f < 0.5 ? F[(k + 11) % 12] * (0.5 - f) + F[k] * (f + 0.5) : F[k] * (1.5 - f) + F[(k + 1) % 12] * (f - 0.5);
    cache.set(dn, v); return v;
  };
  const meanOver = (d0, d1) => { if (!F) return 1; let s = 0; for (let d = d0; d < d1; d++) s += at(d); return d1 > d0 ? s / (d1 - d0) : 1; };
  return { at, meanOver, F };
}

// ═══ PER-ASIN SERIES FORECASTER — FIX(v2) #3 #5 #7 ═══════════════════════════
function tsb(x, a = 0.2, b = 0.1) {
  const nz = x.filter(d => d > 0);
  let p = nz.length / x.length || 0.1, z = meanA(nz) || 0;
  for (const d of x) { if (d > 0) { z += a * (d - z); p += b * (1 - p); } else { p += b * (0 - p); } }
  return Math.max(0, p * z);
}
// Models on a deseasonalised daily-rate series x. Each returns g(k): rate k periods after the end.
function fitModels(x, phi, intermittent) {
  const n = x.length, M = {};
  let alpha = 0.3;
  if (n >= 6) { let best = Infinity; for (const a0 of [0.1, 0.2, 0.3, 0.5, 0.7]) { let l = x[0], e = 0; for (let i = 1; i < n; i++) { e += (x[i] - l) ** 2; l = a0 * x[i] + (1 - a0) * l; } if (e < best - 1e-12) { best = e; alpha = a0; } } }
  let l = x[0]; for (let i = 1; i < n; i++) l = alpha * x[i] + (1 - alpha) * l;
  const ses = Math.max(0, l); M.ses = () => ses;
  if (n >= 6 && !intermittent) {
    const W = Math.min(n, Math.max(6, Math.ceil(n / 2))); const w = x.slice(-W); const { a, b } = linreg(w); const L0 = Math.max(0, a + b * (W - 1));
    M.holt = k => { let s = 0, p = 1; for (let i = 1; i <= k; i++) { p *= phi; s += p; } return clamp(L0 + b * s, 0, 3 * Math.max(L0, ses) + 1e-9); };
    M.blend = k => 0.5 * (ses + M.holt(k));
  }
  if (intermittent) { const t = tsb(x); M.tsb = () => t; }
  return M;
}

/**
 * Forecast one ASIN from its trend-file series.
 *   s: { y:[units per period], p0 } on the calendar ctx.periods
 * Returns a daily-rate function on the deseasonalised scale plus back-test samples.
 */
function seriesForecast(s, ctx, rec) {
  const P = ctx.periods.slice(s.p0, s.p0 + s.y.length);
  let y = s.y.slice(); const n0 = y.length;
  const len = P.map(p => p.e - p.s + 1);
  const Sbar = P.map(p => ctx.season.meanOver(p.s, p.e + 1));
  const gapAvg = meanA(len);
  const phi = gapAvg > 20 ? 0.85 : 0.96;
  const notes = [];
  let hidden = false, stopped = false, stockoutPeriods = 0;

  // zero runs: chance or stockout/stop?
  const zeroFrac = y.filter(v => v <= 0).length / n0;
  const runs = []; for (let i = 0; i < n0; i++) if (y[i] <= 0) { let j = i; while (j + 1 < n0 && y[j + 1] <= 0) j++; runs.push([i, j]); i = j; }
  const x = y.map((v, i) => v / len[i] / Sbar[i]);
  const missing = new Array(n0).fill(false);
  const unlikely = (i, j) => {
    const r = j - i + 1, out = y.filter((v, k) => k < i || k > j);
    if (!out.length) return false;
    const pz = Math.max(out.filter(v => v <= 0).length / out.length, Math.exp(-meanA(out)));
    return Math.pow(pz, r) < 1 / (20 * n0);
  };
  for (const [i, j] of runs) {
    if (j === n0 - 1) {
      if (!unlikely(i, j)) continue;
      const days = P[j].e - P[i].s + 1;
      if (rec.fulfillable <= 0 && !(rec.unitsSold30 > 0) && days <= 92) { hidden = true; for (let k = i; k <= j; k++) missing[k] = true; }
      else if (!(rec.unitsSold30 > 0)) stopped = true;
    } else if (i > 0 && unlikely(i, j)) { for (let k = i; k <= j; k++) missing[k] = true; stockoutPeriods += j - i + 1; }
  }
  // fill mid-series stockouts from neighbours; cut a hidden-demand run off the end
  let end = n0; if (hidden) { end = n0; while (end > 0 && missing[end - 1]) end--; }
  for (let i = 0; i < end; i++) if (missing[i]) { const nb = []; for (let k = i - 1; k >= 0 && nb.length < 2; k--) if (!missing[k]) nb.push(x[k]); for (let k = i + 1, c = 0; k < end && c < 2; k++) if (!missing[k]) { nb.push(x[k]); c++; } x[i] = nb.length ? meanA(nb) : 0; }
  const xs = x.slice(0, end), ys = y.slice(0, end), Ls = len.slice(0, end), Ss = Sbar.slice(0, end), Ps = P.slice(0, end);
  const n = xs.length;
  if (stockoutPeriods) notes.push(`${stockoutPeriods} period(s) of zero sales treated as stockout`);
  if (n < 2) return null;
  const intermittent = zeroFrac >= 0.3 || meanA(ys) < 1;

  // rolling hold-out on ~30-day totals (newest origin = the most recent data the model never saw)
  const Hp = Math.max(1, Math.round(30 / gapAvg));
  const minTrain = Math.min(6, Math.max(3, n - Hp - 1));
  const methods = Object.keys(fitModels(xs, phi, intermittent));
  const err = Object.fromEntries(methods.map(m => [m, 0]));
  const samples = Object.fromEntries(methods.map(m => [m, []]));
  for (let o = Math.max(minTrain, n - Hp - 7); o <= n - Hp; o++) {
    const M = fitModels(xs.slice(0, o), phi, intermittent);
    for (const m of methods) {
      if (!M[m]) continue;
      let F = 0, A = 0, D = 0;
      for (let k = 0; k < Hp; k++) { F += M[m](k + 1) * Ss[o + k] * Ls[o + k]; A += ys[o + k]; D += Ls[o + k]; }
      err[m] += Math.abs(F - A); samples[m].push({ F, A, D, newest: o === n - Hp });
    }
  }
  const def = intermittent ? 'tsb' : 'ses';
  let method = def;
  for (const m of methods) if (samples[m].length && err[m] < 0.9 * err[method] - 1e-9) method = m;
  const M = fitModels(xs, phi, intermittent);
  const g = M[method] || M.ses;
  // overdispersion of intermittent / lumpy demand (units arrive in clumps)
  let disp = 1;
  if (intermittent) { const mu = meanA(ys); if (mu > 0) disp = clamp((meanA(ys.map(v => v * v)) - mu * mu) / mu, 1, 30); }
  const lastDay = Ps[Ps.length - 1].e;
  return {
    g, gapAvg, lastDay, method: { ses: 'Exponential smoothing', holt: 'Damped trend', blend: 'Smoothing + trend', tsb: 'Intermittent (TSB)' }[method],
    pattern: stopped ? 'stopped selling' : intermittent ? (disp > 3 ? 'lumpy' : 'intermittent') : 'smooth', hidden, stopped, disp,
    bt: samples[method] || [], periods: n, notes,
  };
}

// ═══ PER-ASIN COMPUTE ════════════════════════════════════════════════════════
function computeAsin(rec, cfg, ctx) {
  const d = cfg.defaults;
  const lead = rec.leadTime > 0 ? rec.leadTime : cfg.leadTime;            // FIX(v2) #1
  const sl = cfg.serviceLevel || d.serviceLevel;
  const asOf = ctx.asOfDay, S = ctx.season;
  const notes = [];

  // ── Forecast → rate(t) = expected units on day asOf+t
  let pattern = 'snapshot', method = 'Restock 30-day rate', src = 'snapshot', wSnap = 1, disp = 1, bt = [], hidden = false;
  let base = rec.unitsSold30 > 0 ? rec.unitsSold30 / 30 : 0;
  if (rec.inStockRate > 0 && rec.inStockRate < 1 && base > 0) base = base / Math.max(0.3, rec.inStockRate); // lost-sales unconstraining
  const snapDes = base / S.meanOver(asOf - 30, asOf);                      // FIX(v2) #8: deseasonalised fresh rate
  let g = () => snapDes, gapAvg = 30, lastDay = asOf - 1;
  const sf = rec._sf !== undefined ? rec._sf : (rec.series ? seriesForecast(rec.series, ctx, rec) : null);
  if (sf) {
    src = 'series'; pattern = sf.pattern; method = sf.method; disp = sf.disp; bt = sf.bt; hidden = sf.hidden; notes.push(...sf.notes);
    gapAvg = sf.gapAvg; lastDay = sf.lastDay;
    const k0 = Math.max(1, Math.ceil((asOf - lastDay) / gapAvg));
    // a 30-day figure taken while the ASIN is out of stock is censored — don't let it drag the model down
    const censored = rec.hasSnapshot && rec.fulfillable <= 0 && snapDes < 0.5 * sf.g(k0);
    if (censored && !(rec.unitsSold30 > 0) && !sf.stopped) hidden = true;
    if (sf.stopped) { g = () => 0; wSnap = 0; }
    else if (rec.hasSnapshot && !sf.hidden && !censored) {
      const shift = (1 - W_SERIES) * (snapDes - sf.g(k0)); wSnap = 1 - W_SERIES;
      g = k => Math.max(0, sf.g(k) + shift);
    } else { g = sf.g; wSnap = 0; }
    if (hidden) notes.push('out of stock with no recent sales — forecast uses demand from before the stockout');
    else if (censored) notes.push('out of stock now — the 30-day sales figure is understated, so the trend history is used on its own');
  } else if (rec.unitsSold30 <= 0) {
    pattern = 'no-demand';
    if (rec.fulfillable <= 0 && (rec.amzRecQty > 0 || /out.?of.?stock/i.test(rec.amzAlert || ''))) { hidden = true; notes.push('out of stock — Amazon still recommends replenishing, demand hidden'); }
  }
  const kOf = t => Math.max(1, Math.ceil((asOf + t - lastDay) / gapAvg));
  const rate = t => g(kOf(t)) * S.at(asOf + t);
  const demand = (a, b) => { let s = 0; for (let t = a; t < b; t++) s += rate(t); return s; };

  const D30 = demand(0, 30), D60 = demand(30, 60) + D30, D90 = demand(60, 90) + D60;
  const h = cfg.horizonDays || 90;
  const horizon = { next30: r0(D30), next60: r0(D60), next90: r0(D90), nextH: r0(h === 90 ? D90 : demand(0, h)) };
  const dailyVel = D30 / 30;                                                 // FIX(v2) #11: average of the next 30 days

  // ── Uncertainty: Poisson-type noise × dispersion + calibrated relative drift + 30-day sampling error
  const variance = (mu, days) => disp * mu + (ctx.drift * mu) ** 2 + (wSnap > 0 ? wSnap * wSnap * disp * mu * days / 30 : 0) + (d.leadTimeStdDays > 0 ? (dailyVel * d.leadTimeStdDays) ** 2 : 0);
  const quant = D30 > 0 ? (() => { const v = variance(D30, 30); return { p50: r0(D30), p90: demandQuantile(D30, v, 0.9), p95: demandQuantile(D30, v, 0.95), dist: D30 < 30 ? (v > D30 * 1.05 ? 'nb' : 'poisson') : 'normal' }; })() : null;
  if (quant) { quant.p90 = Math.max(quant.p50, quant.p90); quant.p95 = Math.max(quant.p90, quant.p95); }
  let wAbs = 0, wAct = 0; for (const s of bt) { wAbs += Math.abs(s.F - s.A); wAct += s.A; }
  const wmape = wAct > 0 ? Math.round(100 * wAbs / wAct) : null;

  // ── Inventory position
  const fulfillable = rec.fulfillable, inbound = rec.inbound, reserved = rec.reserved, unsellable = rec.unsellable;
  const onHand = fulfillable + reserved, position = fulfillable + inbound;
  let daysOfSupply;
  if (dailyVel > 0) { let cum = 0, t = 0; while (t < 999) { cum += rate(t); if (cum > position) break; t++; } daysOfSupply = t; }
  else daysOfSupply = position > 0 ? 999 : 0;

  // ── Reorder point = service-level quantile of lead-time demand — FIX(v2) #9
  const muLT = demand(0, lead);
  const reorderPoint = muLT > 0 ? demandQuantile(muLT, variance(muLT, lead), sl) : 0;
  const safetyStock = Math.max(0, reorderPoint - r0(muLT));

  // ── Order-up-to SEND quantity (before restock-limit cap)
  const targetDoS = cfg.targetDaysOfSupply || d.targetDaysOfSupply;
  const cover = demand(0, lead + targetDoS);
  let sendQtyUncapped = Math.max(0, Math.ceil(cover + safetyStock - position));
  if (hidden && rec.amzRecQty > 0) sendQtyUncapped = Math.max(sendQtyUncapped, Math.round(rec.amzRecQty));

  // ── FBA economics (true contribution)
  const fees = fbaFees(rec, cfg);
  const monthsToSell = clamp((dailyVel > 0 ? (fulfillable / dailyVel) / 30 : 6), 0.25, 12);
  const storageOverHold = fees.storagePerMonth * monthsToSell;
  const netProceeds = rec.price - fees.referral - fees.fulfilment - storageOverHold;
  const landed = rec.cost > 0 ? rec.cost : 0;
  const contributionPerUnit = r2(netProceeds - landed);

  // ── Aged inventory / LTSF risk
  const aged365 = rec.aged365, aged271 = rec.aged271;
  const ltsfExposure = r0(aged365 * d.ltsfPerUnit365 + aged271 * d.ltsfPerUnit271);
  const excessUnits = Math.max(0, fulfillable - Math.ceil(demand(0, targetDoS)));
  const trueContribution = r2(contributionPerUnit - (fulfillable > 0 ? ltsfExposure / fulfillable : 0));
  const isProfitDrain = rec.price > 0 && trueContribution <= 0 && rec.unitsSold30 > 0;

  // ── Status / IPI health — FIX(v2) #10: trigger at the reorder point, not at bare lead-time demand
  let status, priority = 'LOW';
  const softLine = reorderPoint + demand(lead, lead + Math.round(targetDoS * 0.5));
  if (unsellable > 0 && fulfillable === 0) { status = 'Stranded (unsellable)'; priority = 'HIGH'; }
  else if (hidden && position <= 0) { status = 'Reorder now'; priority = 'HIGH'; }
  else if (dailyVel > 0 && position <= reorderPoint) { status = 'Reorder now'; priority = 'URGENT'; }
  else if (dailyVel > 0 && position <= softLine) { status = 'Send soon'; priority = 'HIGH'; }
  else if (aged365 > 0 || (excessUnits > 0 && daysOfSupply > 270)) { status = 'Aged / LTSF risk'; priority = 'MEDIUM'; }
  else if (excessUnits > 0 && daysOfSupply > 120) { status = 'Excess'; priority = 'LOW'; }
  else status = dailyVel > 0 ? 'Healthy' : 'No demand';

  // ── Keep vs remove (excess/aged): remove if carrying+LTSF outweighs expected recovery
  let removeRecommended = false, removeUnits = 0, removeReason = '';
  const projStorage6mo = fees.storagePerMonth * 6;
  if (aged365 > 0 && (trueContribution <= 0 || daysOfSupply > 365)) { removeRecommended = true; removeUnits = aged365; removeReason = '365+ aged, LTSF each month, weak/negative margin'; }
  else if (excessUnits > 0 && daysOfSupply > 270 && (projStorage6mo > contributionPerUnit)) { removeRecommended = true; removeUnits = excessUnits; removeReason = 'Deep overstock — 6-mo storage exceeds unit margin'; }

  return {
    asin: rec.asin, fnsku: rec.fnsku, sku: rec.sku, name: rec.name, category: rec.category, categoryBucket: rec.categoryBucket,
    sizeTier: rec.sizeTier, price: r2(rec.price), cost: r2(rec.cost),
    dailyVelocity: r2(dailyVel), pattern, forecastMethod: method, forecastSource: src, forecastWmape: wmape, forecastQuantiles: quant, ...horizon,
    seasonalFactor: S.F ? r2(S.meanOver(asOf, asOf + 30) / S.meanOver(asOf - 30, asOf)) : 1,
    fulfillable, inbound, reserved, unsellable, onHand, daysOfSupply,
    leadTimeDemand: r0(muLT), safetyStock, reorderPoint, targetDaysOfSupply: targetDoS, sendQty: sendQtyUncapped, sendQtyFinal: sendQtyUncapped,
    fees, storageOverHold: r2(storageOverHold), netProceeds: r2(netProceeds),
    contributionPerUnit, trueContribution, isProfitDrain,
    aged271, aged365, ltsfExposure, excessUnits,
    status, priority, removeRecommended, removeUnits, removeReason, demandHidden: hidden, notes,
    leadTimeDays: lead, serviceLevel: Math.round(sl * 100),
    _bt: bt, _disp: disp, _wSnap: wSnap,
  };
}

// ═══ SAFETY-STOCK CALIBRATION — FIX(v2) #9 ═══════════════════════════════════
// Pick the smallest relative drift c at which "forecast + z·σ" covers the hold-out actuals at the
// chosen service level on older origins; report coverage on the newest (unseen) origin.
function calibrateDrift(samplesByAsin, sl) {
  const fit = [], chk = [];
  for (const { bt, disp } of samplesByAsin) for (const s of bt) if (s.F > 0) (s.newest ? chk : fit).push({ ...s, disp });
  if (fit.length < 30) return { drift: DRIFT_DEFAULT, calibrated: false, samples: fit.length };
  const covers = (arr, c) => arr.filter(s => s.A <= demandQuantile(s.F, s.disp * s.F + (c * s.F) ** 2, sl)).length / arr.length;
  let drift = 0.6;
  for (let c = 0.02; c <= 0.6 + 1e-9; c += 0.02) if (covers(fit, c) >= sl) { drift = r2(c); break; }
  return { drift, calibrated: true, samples: fit.length, coverageFit: r2(covers(fit, drift)), coverageCheck: chk.length ? r2(covers(chk, drift)) : null };
}
// ═══ REPORT PARSING (tolerant; Amazon report headers) ════════════════════════
// FIX(v2): character-level CSV/TSV parser — a quoted product name containing a line break used to
// split one row into two and shift every column after it.
function rowsToObjects(csvText) {
  if (!csvText || !csvText.trim()) return [];
  const text = csvText.replace(/^﻿/, '');
  const first = (text.split(/\r?\n/).find(l => l.trim()) || '');
  const D = (first.split('\t').length - 1) > (first.split(',').length - 1) ? '\t' : ',';
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; continue; }
    if (ch === '"' && f === '') q = true;
    else if (ch === D) { row.push(f); f = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some(c => c.trim() !== '')) rows.push(row); row = []; }
    else f += ch;
  }
  row.push(f); if (row.some(c => c.trim() !== '')) rows.push(row);
  if (rows.length < 2) return [];
  const headers = rows[0].map(h => h.toLowerCase().trim());
  return rows.slice(1).map(c => { const o = {}; headers.forEach((h, i) => { if (h && !(h in o && o[h] !== '')) o[h] = (c[i] == null ? '' : String(c[i]).trim()); }); return o; });
}
// exact header first, then "contains" — so "sku" never grabs "fnsku" when a real "sku" column exists
function pick(o, names, exclude) {
  for (const nm of names) if (o[nm] != null && o[nm] !== '') return o[nm];
  for (const nm of names) { for (const k in o) { if (k.includes(nm) && !(exclude && exclude.test(k))) { if (o[k] !== '') return o[k]; } } }
  return '';
}
function idOf(o) { return { asin: pick(o, ['asin', '(child) asin', 'child asin'], /parent/), fnsku: pick(o, ['fnsku']), sku: pick(o, ['merchant sku', 'seller-sku', 'seller sku', 'msku', 'sku'], /fnsku/) }; }
function keyOf(id) { return (id.asin || id.fnsku || id.sku || '').toLowerCase(); }

function classifyCategory(cat) {
  const c = (cat || '').toString().toLowerCase();
  if (/mobile|smartphone|\bphone\b|tablet/.test(c)) return 'mobiles';
  if (/electronic|laptop|computer|\btv\b|audio|headphone|earbud|camera|gaming/.test(c)) return 'electronics';
  if (/appliance|refrigerator|washing|microwave|\bac\b|cooler|geyser/.test(c)) return 'appliances';
  if (/jewel|gold|silver|diamond/.test(c)) return 'jewellery';
  if (/footwear|shoe|sneaker|sandal|heel/.test(c)) return 'footwear';
  if (/fashion|apparel|cloth|kurta|saree|shirt|dress|ethnic|t-?shirt|jeans/.test(c)) return 'fashion';
  if (/beauty|cosmetic|makeup|skincare|fragrance|perfume|grooming/.test(c)) return 'beauty';
  if (/grocery|food|bever|fmcg|snack|staple|dairy|household/.test(c)) return 'fmcg';
  if (/gift|\btoy\b|stationery|decor|festive|pooja|candle/.test(c)) return 'gifting';
  if (/home|furniture|kitchen|cookware|bedding|utensil/.test(c)) return 'home';
  return 'default';
}
function sizeTierOf(o) {
  const t = pick(o, ['product size tier', 'size tier', 'size-tier', 'product-size-tier']).toLowerCase();
  if (/small.*over|over.*small/.test(t)) return 'smallOversize';
  if (/over/.test(t)) return 'largeOversize';
  if (/heav/.test(t)) return 'heavyStandard';
  if (/small/.test(t)) return 'small';
  if (/standard/.test(t)) return 'standard';
  const w = num(pick(o, ['item-package-weight', 'weight'])); // kg
  if (w && w > 12) return 'largeOversize'; if (w && w > 2) return 'heavyStandard'; if (w && w > 0 && w <= 0.5) return 'small';
  return 'default';
}

// ═══ FBA FEE MODEL ═══════════════════════════════════════════════════════════
function fbaFees(rec, cfg) {
  const d = cfg.defaults;
  const price = rec.price;
  const referralPct = (cfg.referralOverride != null) ? cfg.referralOverride : (d.referralByCategory[rec.categoryBucket] ?? d.referralByCategory.default);
  const referral = price * referralPct;
  const fulfilment = rec.reportFulfilFee > 0 ? rec.reportFulfilFee : (d.fulfilmentBySize[rec.sizeTier] ?? d.fulfilmentBySize.default);
  // Monthly storage: prefer the report's estimated storage cost (per unit), else default, peak-adjusted.
  const month = (cfg.asOf ? cfg.asOf.getMonth() + 1 : new Date().getMonth() + 1);
  const peak = d.peakMonths.includes(month) ? d.peakStorageMultiplier : 1;
  const storagePerMonth = rec.reportStoragePerUnit > 0 ? rec.reportStoragePerUnit : d.storagePerUnitMonth * peak;
  return { referralPct, referral: r2(referral), fulfilment: r2(fulfilment), storagePerMonth: r2(storagePerMonth) };
}

// ═══ MERGE REPORTS → RECORDS ═════════════════════════════════════════════════
function buildRecords(reports, cfg, trend) {
  const restock = rowsToObjects(reports.restockCsv);
  const inventory = rowsToObjects(reports.inventoryCsv);
  const asp = rowsToObjects(reports.aspCsv);

  const invIdx = {}; inventory.forEach(o => { const id = idOf(o); [id.asin, id.fnsku, id.sku].forEach(x => { if (x) invIdx[x.toLowerCase()] = o; }); });
  const aspIdx = {}; asp.forEach(o => { const id = idOf(o); [id.asin, id.fnsku, id.sku].forEach(x => { if (x) { const k = x.toLowerCase(); const e = aspIdx[k] || (aspIdx[k] = { u: 0, rev: 0, row: o }); e.u += num(pick(o, ['units', 'units ordered'], /b2b/)); e.rev += num(pick(o, ['revenue', 'ordered product sales', 'sales'], /b2b/)); } }); });

  // Primary SKU list = restock report; fall back to inventory report if no restock provided.
  const primary = restock.length ? restock : inventory;
  const keyCount = {}; primary.forEach(o => { const k = keyOf(idOf(o)); if (k) keyCount[k] = (keyCount[k] || 0) + 1; });
  let dupSeries = 0;
  const records = primary.map(o => {
    const id = idOf(o); const key = keyOf(id);
    const ids = [id.asin, id.fnsku, id.sku].filter(Boolean).map(x => x.toLowerCase());
    const inv = ids.map(k => invIdx[k]).find(Boolean) || {};
    const aspE = ids.map(k => aspIdx[k]).find(Boolean);
    const unitsSold30 = num(pick(o, ['units sold last 30 days', 'units-sold-last-30-days', 'units sold', 'units ordered']));
    const sales30 = num(pick(o, ['sales last 30 days', 'sales-last-30-days']));
    // FIX(v2) #14: realised ASP first, then list price, then the ASP report's revenue ÷ units
    const listPrice = num(pick(o, ['your-price', 'sales-price', 'price', 'asp'], /ship|recommend/)) || num(pick(inv, ['your-price', 'sales-price']));
    const aspPrice = aspE ? (aspE.u > 0 && aspE.rev > 0 ? aspE.rev / aspE.u : num(pick(aspE.row, ['asp', 'average selling price', 'avg selling price', 'price']))) : 0;
    const price = (unitsSold30 > 0 && sales30 > 0 && sales30 / unitsSold30 < 1e6) ? sales30 / unitsSold30 : (listPrice || aspPrice);
    let series = null;
    if (trend && trend.kind === 'asin') { series = ids.map(k => trend.series[k]).find(Boolean) || null; if (series && keyCount[key] > 1) { series = null; dupSeries++; } }
    const isRaw = pick(o, ['in-stock rate', 'in stock rate', 'instock rate']);
    return {
      asin: id.asin, fnsku: id.fnsku, sku: id.sku,
      name: pick(o, ['product name', 'product-name', 'title', 'item-name']) || pick(inv, ['product-name']),
      category: pick(o, ['category', 'product category', 'browse node', 'product type']) || pick(inv, ['category']),
      get categoryBucket() { return classifyCategory(this.category); },
      sizeTier: sizeTierOf({ ...o, ...inv }),
      price, cost: num(pick(o, ['cost', 'unit cost', 'landed cost', 'cogs'])),
      unitsSold30, hasSnapshot: restock.length > 0,
      inStockRate: isRaw ? num(isRaw) / (String(isRaw).includes('%') || num(isRaw) > 1 ? 100 : 1) : 0,
      fulfillable: num(pick(inv, ['afn-fulfillable-quantity', 'fulfillable quantity', 'available'])) || num(pick(o, ['available', 'fulfillable quantity'])),
      inbound: num(pick(inv, ['afn-inbound-working-quantity'])) + num(pick(inv, ['afn-inbound-shipped-quantity'])) + num(pick(inv, ['afn-inbound-receiving-quantity'])) || num(pick(o, ['inbound', 'inbound quantity'])),
      reserved: num(pick(inv, ['afn-reserved-quantity', 'reserved quantity'])) || num(pick(o, ['reserved'])) || (num(pick(o, ['fc transfer'])) + num(pick(o, ['fc processing'])) + num(pick(o, ['customer order']))),
      unsellable: num(pick(inv, ['afn-unsellable-quantity', 'unfulfillable'])) || num(pick(o, ['unfulfillable', 'unsellable'])),
      reportFulfilFee: num(pick(o, ['estimated fba fee', 'fulfilment fee', 'fulfillment fee', 'expected-fulfillment-fee-per-unit'])) || num(pick(inv, ['estimated-fee-total'])),
      reportStoragePerUnit: perUnitStorage(inv, o),
      aged271: num(pick(inv, ['inv-age-271-to-365-days', 'inv age 271 to 365'])) || num(pick(o, ['inv-age-271-to-365-days'])),
      aged365: num(pick(inv, ['inv-age-365-plus-days', 'inv age 365'])) || num(pick(o, ['inv-age-365-plus-days'])),
      leadTime: num(pick(o, ['lead time', 'lead time (days)', 'lead-time'])),
      amzRecQty: num(pick(o, ['recommended replenishment qty', 'recommended ship-in quantity'])),
      amzAlert: pick(o, ['alert']),
      series,
    };
  }).filter(r => r.asin || r.fnsku || r.sku);
  return { records, dupSeries };
}

function perUnitStorage(inv, o) {
  const est = num(pick(inv, ['estimated-storage-cost-next-month', 'estimated storage cost next month'])) || num(pick(o, ['estimated-storage-cost-next-month']));
  const qty = num(pick(inv, ['afn-fulfillable-quantity', 'quantity-in-stock', 'quantity'])) || 0;
  return est > 0 && qty > 0 ? est / qty : 0;
}

// ═══ RESTOCK-LIMIT-CONSTRAINED SEND PLAN ═════════════════════════════════════
// Amazon caps how many units you can send (restock limit). Allocate the limit to the
// highest-priority, fastest-moving ASINs first; cap each ASIN's send at its need.
export function buildSendPlan(rows, restockLimitUnits) {
  const pr = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const candidates = rows.filter(r => r.sendQty > 0)
    .sort((a, b) => (pr[a.priority] - pr[b.priority]) || (b.dailyVelocity - a.dailyVelocity));
  const cap = restockLimitUnits && restockLimitUnits > 0 ? restockLimitUnits : Infinity;
  let used = 0; const plan = [];
  for (const r of candidates) {
    const room = cap - used; if (room <= 0) { r.sendQtyFinal = 0; continue; }
    const send = Math.min(r.sendQty, room); r.sendQtyFinal = send; used += send;
    plan.push({ asin: r.asin, sku: r.sku, name: r.name, need: r.sendQty, send, capped: send < r.sendQty, priority: r.priority, daysOfSupply: r.daysOfSupply });
  }
  return { restockLimitUnits: cap === Infinity ? null : cap, unitsPlanned: used, skusPlanned: plan.length, capped: cap !== Infinity && used >= cap, lines: plan };
}

// ═══ PIPELINE ════════════════════════════════════════════════════════════════
export function runFbaForecast(reports, cfgIn = {}) {
  const defaults = { ...FBA_DEFAULTS, ...(cfgIn.defaults || {}) };
  if (cfgIn.leadTimeStdDays != null) defaults.leadTimeStdDays = num(cfgIn.leadTimeStdDays);
  const cfg = {
    defaults,
    horizonDays: cfgIn.horizonDays || 90,
    serviceLevel: cfgIn.serviceLevel != null ? (cfgIn.serviceLevel > 1 ? cfgIn.serviceLevel / 100 : cfgIn.serviceLevel) : FBA_DEFAULTS.serviceLevel,
    targetDaysOfSupply: num(cfgIn.targetDaysOfSupply) || FBA_DEFAULTS.targetDaysOfSupply,
    leadTime: num(cfgIn.leadTime) || num(cfgIn.leadTimeDays) || defaults.leadTimeDays,          // FIX(v2) #1
    referralOverride: cfgIn.referralOverride != null ? cfgIn.referralOverride : null,
    asOf: cfgIn.asOf ? new Date(cfgIn.asOf) : new Date(),
  };
  if (isNaN(cfg.asOf)) cfg.asOf = new Date();
  const asOfDay = dnum(cfg.asOf.getUTCFullYear(), cfg.asOf.getUTCMonth() + 1, cfg.asOf.getUTCDate());

  const trend = analyseTrend(rowsToObjects(reports.trendCsv), asOfDay);
  const notes = [...trend.notes];
  // seasonal profile from the portfolio's own complete months, kept only if it wins a hold-out test
  let F = null, seasonality = { source: trend.kind ? (trend.kind === 'market' ? 'marketplace trend file' : 'per-ASIN trend file') : 'none', months: trend.monthly.length, enabled: false };
  if (trend.monthly.length) {
    const v = validateSeason(trend.monthly);
    const prof = fitSeasonProfile(trend.monthly);
    if (prof && v.ok) {
      F = prof; const pk = F.indexOf(Math.max(...F)), lo = F.indexOf(Math.min(...F));
      const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      seasonality = { ...seasonality, enabled: true, peakMonth: MN[pk], peakIndex: r2(F[pk]), lowMonth: MN[lo], lowIndex: r2(F[lo]), factors: F.map(r2), holdoutErrorFlat: v.errFlat, holdoutErrorSeasonal: v.errSeasonal };
      notes.push(`Seasonality on: ${MN[pk]} runs ${Math.round(100 * (F[pk] - 1))}% above an average month, ${MN[lo]} ${Math.round(100 * (1 - F[lo]))}% below (hold-out error ${v.errFlat}% → ${v.errSeasonal}%).`);
    } else if (trend.monthly.length) {
      seasonality = { ...seasonality, why: prof ? (v.why || `did not beat a flat forecast on your last months (${v.errFlat}% vs ${v.errSeasonal}%)`) : 'needs 12+ complete months with steady volume' };
      notes.push(`Seasonality off: ${seasonality.why}.`);
    }
  }
  const ctx = { asOfDay, periods: trend.periods, season: makeSeasonFn(F), drift: DRIFT_DEFAULT };

  const { records, dupSeries } = buildRecords(reports, cfg, trend);
  if (!records.length) return { error: 'No ASIN/SKU rows found. Upload at least the Restock or Inventory report.' };
  if (dupSeries) notes.push(`${dupSeries} ASIN(s) appear in several Restock rows (e.g. countries); their trend history was not split, so they use the 30-day rate.`);
  if (trend.kind === 'asin') { const matched = records.filter(r => r.series).length; notes.push(`Trend history matched for ${matched} of ${records.length} ASINs.`); }

  // per-ASIN series models first, so safety stock can be calibrated on their hold-out errors
  for (const r of records) r._sf = r.series ? seriesForecast(r.series, ctx, r) : null;
  const cal = calibrateDrift(records.filter(r => r._sf).map(r => ({ bt: r._sf.bt, disp: r._sf.disp })), cfg.serviceLevel);
  ctx.drift = cal.drift;

  const rows = records.map(r => computeAsin(r, cfg, ctx));
  const sendPlan = buildSendPlan(rows, cfgIn.restockLimitUnits);

  const active = rows.filter(r => r.dailyVelocity > 0);
  const storageForecast = {
    monthlyStorageFee: r0(rows.reduce((a, r) => a + r.fees.storagePerMonth * r.fulfillable, 0)),
    ltsfExposure: r0(rows.reduce((a, r) => a + r.ltsfExposure, 0)),
    peakNote: 'Storage fees typically 2–3× in Oct–Dec (Q4). Trim excess before the peak window.',
  };
  const removalRecommendations = rows.filter(r => r.removeRecommended)
    .map(r => ({ asin: r.asin, sku: r.sku, name: r.name, units: r.removeUnits, reason: r.removeReason, daysOfSupply: r.daysOfSupply, trueContribution: r.trueContribution }))
    .sort((a, b) => b.units - a.units);
  const leaks = rows.filter(r => r.isProfitDrain)
    .sort((a, b) => a.trueContribution - b.trueContribution)
    .map(r => ({ asin: r.asin, sku: r.sku, name: r.name, price: r.price, trueContribution: r.trueContribution, fees: r.fees, why: r.fees.fulfilment + r.fees.referral > r.price * 0.4 ? 'FBA fees + referral too high vs price' : 'Storage/cost exceed net proceeds' }));

  // FIX(v2) #12: volume-weighted error on 30-day totals across every hold-out window
  let eAbs = 0, eAct = 0, eSum = 0; for (const r of rows) for (const s of r._bt) { eAbs += Math.abs(s.F - s.A); eAct += s.A; eSum += s.F - s.A; }
  for (const r of rows) { delete r._bt; delete r._disp; delete r._wSnap; }

  const summary = {
    skus: rows.length, activeSKUs: active.length,
    reorderNow: rows.filter(r => r.status === 'Reorder now').length,
    sendSoon: rows.filter(r => r.status === 'Send soon').length,
    stranded: rows.filter(r => r.status === 'Stranded (unsellable)').length,
    agedRisk: rows.filter(r => r.status === 'Aged / LTSF risk').length,
    excess: rows.filter(r => r.status === 'Excess').length,
    demandHidden: rows.filter(r => r.demandHidden).length,
    unitsToSend: sendPlan.unitsPlanned,
    // Inventory status — fulfillable vs unfulfillable (units)
    fulfillableUnits: rows.reduce((a, r) => a + r.fulfillable, 0),
    unfulfillableUnits: rows.reduce((a, r) => a + r.unsellable, 0),
    reservedUnits: rows.reduce((a, r) => a + r.reserved, 0),
    inboundUnits: rows.reduce((a, r) => a + r.inbound, 0),
    profitDrainSKUs: leaks.length,
    avgWmape: eAct > 0 ? Math.round(100 * eAbs / eAct) : null,
    forecastBias: eAct > 0 ? Math.round(100 * eSum / eAct) : null,
    accuracyBasis: eAct > 0 ? 'volume-weighted error on 30-day totals, rolling hold-out on your trend file' : 'no trend history — upload a Trend report to measure accuracy',
    forecastSources: { trendHistory: rows.filter(r => r.forecastSource === 'series').length, restock30Day: rows.filter(r => r.forecastSource === 'snapshot').length },
    trendGranularity: trend.gran, seasonality,
    safetyStockCalibration: cal,
    leadTimeDays: cfg.leadTime, asOf: isoDay(asOfDay),
    horizonDays: cfg.horizonDays, serviceLevel: Math.round(cfg.serviceLevel * 100), targetDaysOfSupply: cfg.targetDaysOfSupply,
    notes,
  };

  const pr = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  // FIX(v2): Vercel caps a function response at 4.5 MB. The three ranked lists repeat every row of
  // allSKUs, so a ~1,700-ASIN account used to fail outright. Ranked copies are cut to the top 300;
  // allSKUs still carries every ASIN.
  const TOP = 300, top = a => (a.length > TOP ? (summary.listsTrimmedTo = TOP, a.slice(0, TOP)) : a);
  return {
    summary,
    forecast: top(rows.slice().sort((a, b) => b.next30 - a.next30)),
    sendPlan,
    reorderPlan: top(rows.filter(r => r.sendQty > 0).sort((a, b) => (pr[a.priority] - pr[b.priority]) || (b.next30 - a.next30))),
    agedInventory: top(rows.filter(r => r.aged365 > 0 || r.aged271 > 0).sort((a, b) => b.ltsfExposure - a.ltsfExposure)),
    removalRecommendations, storageForecast, profitLeaks: leaks,
    allSKUs: rows,
    insights: [],
  };
}

// ═══ GEMINI: narrative FBA insights only (computed numbers only — never raw report data) ═════
// Same model & privacy model as the Demand Planner. Key is read from process.env.GEMINI_API_KEY
// (set it in Vercel env vars — never hard-code a key). Falls back to deterministic insights offline.
export async function generateFbaInsights(out, cfg, apiKey) {
  const s = out.summary, sym = (cfg && cfg.currency) || '₹';
  const fallback = [
    { type: 'red', icon: '🚨', text: `${s.reorderNow} ASIN(s) need restocking now to avoid FBA stockouts.` },
    { type: 'orange', icon: '📦', text: `${s.unitsToSend.toLocaleString()} units planned to send${out.sendPlan.capped ? ' (restock-limit capped)' : ''} across ${s.sendSoon + s.reorderNow} ASIN(s).` },
    { type: s.stranded ? 'red' : 'green', icon: '🧯', text: s.stranded ? `${s.stranded} stranded (unsellable) ASIN(s) — fix listings to recover units.` : `No stranded inventory detected.` },
    { type: s.agedRisk ? 'orange' : 'green', icon: '⏳', text: s.agedRisk ? `${s.agedRisk} ASIN(s) at long-term-storage-fee risk; LTSF exposure ~${sym}${out.storageForecast.ltsfExposure.toLocaleString()}.` : `No 365-day LTSF risk right now.` },
    { type: s.avgWmape != null && s.avgWmape <= 30 ? 'green' : 'blue', icon: '🎯', text: s.avgWmape != null ? `Hold-out error on 30-day totals ~${s.avgWmape}% (volume-weighted) — ${s.avgWmape <= 20 ? 'high' : s.avgWmape <= 40 ? 'usable' : 'low'} forecast confidence.` : (s.seasonality && s.seasonality.enabled ? `Seasonality from your trend file is on (${s.seasonality.peakMonth} peak ${Math.round(100 * (s.seasonality.peakIndex - 1))}% above average). Add ASIN-level history (ASIN + date + units) to measure per-ASIN accuracy.` : `Upload a Trend report (ASIN + date + units, or the marketplace dashboard) for seasonality and back-tested accuracy.`) },
    { type: 'purple', icon: '💸', text: s.profitDrainSKUs ? `${s.profitDrainSKUs} ASIN(s) lose money after FBA fees — review price/size tier.` : `Trim excess before the Oct–Dec storage peak (2–3× fees).` },
  ];
  if (!apiKey) return fallback;
  const prompt = `You are an Amazon FBA supply-chain analyst. Return ONLY JSON: {"insights":[{"type":"green|orange|red|blue|purple","icon":"emoji","text":"one sentence"}]} with EXACTLY 6 insights (restock urgency, send plan vs restock limit, stranded/unsellable, aged/LTSF risk, forecast confidence via avgWmape (hold-out error on 30-day totals), profit-after-fees or Q4 storage strategy). Use ONLY these numbers; invent nothing.
DATA: ${JSON.stringify({ ...s, notes: undefined, safetyStockCalibration: undefined, seasonality: s.seasonality ? { enabled: s.seasonality.enabled, peakMonth: s.seasonality.peakMonth, peakIndex: s.seasonality.peakIndex } : undefined, currency: sym, restockLimit: out.sendPlan.restockLimitUnits, ltsfExposure: out.storageForecast.ltsfExposure, topReorder: out.reorderPlan.slice(0, 5).map(r => ({ p: r.name || r.sku, dos: r.daysOfSupply, send: r.sendQtyFinal })), topLeak: out.profitLeaks.slice(0, 3).map(r => ({ p: r.name || r.sku, tc: r.trueContribution })) })}`;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1200, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } } }) });
    const j = await r.json();
    const txt = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (txt && txt.trim().length > 5) { const parsed = JSON.parse(txt.replace(/```json|```/g, '').trim()); if (parsed?.insights?.length) return parsed.insights; }
  } catch (e) { /* fall through to deterministic insights */ }
  return fallback;
}

// ═══ SERVERLESS HANDLER (Vercel) ═════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  let { restockCsv, inventoryCsv, trendCsv, aspCsv, restockGz, inventoryGz, trendGz, aspGz, ...cfg } = req.body || {};
  // Reports are gzip-compressed client-side to stay under the request-size limit; gunzip here.
  if (restockGz || inventoryGz || trendGz || aspGz) {
    try {
      const zlib = await import('node:zlib');
      const un = b => b ? zlib.gunzipSync(Buffer.from(b, 'base64')).toString('utf8') : '';
      restockCsv = restockCsv || un(restockGz); inventoryCsv = inventoryCsv || un(inventoryGz);
      trendCsv = trendCsv || un(trendGz); aspCsv = aspCsv || un(aspGz);
    } catch (e) { return res.status(400).json({ error: 'Could not read the compressed reports.' }); }
  }
  if (!restockCsv && !inventoryCsv) return res.status(400).json({ error: 'Upload at least the Restock or Inventory report.' });
  try {
    const out = runFbaForecast({ restockCsv, inventoryCsv, trendCsv, aspCsv }, cfg);
    if (out.error) return res.status(400).json(out);
    out.insights = await generateFbaInsights(out, cfg, process.env.GEMINI_API_KEY);  // same key/pattern as Demand Planner
    return res.status(200).json(out);
  } catch (e) { return res.status(400).json({ error: 'Could not process FBA reports: ' + e.message }); }
}
