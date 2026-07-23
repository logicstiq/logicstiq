// ═══════════════════════════════════════════════════════════════════════════════════════════
// fba-forecast.mjs — LogicstIQ FBA Planner — TOP-GRADE FORECASTING & DEMAND-PLANNING ENGINE (v1)
// ─────────────────────────────────────────────────────────────────────────────
// Transforms the FBA Planner from a client-side heuristic into a rigorous demand-planning brain,
// consuming the SAME four Amazon reports the tool already uploads (Restock, Inventory, Trend, ASP):
//
//   • FORECAST   — auto model per ASIN (damped-trend / exp-smoothing / seasonal / TSB-intermittent),
//                  lost-sales corrected, back-tested (WMAPE), with P50/P90/P95 probabilistic band.
//   • SEND PLAN  — days-of-supply target send qty, capped by FBA RESTOCK LIMITS, prioritised.
//   • ECONOMICS  — true FBA contribution = price − referral − fulfilment − storage − LTSF − landed cost.
//                  Prefers real fee/storage values from the reports; India defaults otherwise.
//   • STORAGE    — monthly storage-fee forecast incl. the Q4 (Oct–Dec) peak multiplier.
//   • LTSF/AGED  — aged-inventory (365+/271-365) long-term-storage-fee risk + keep-vs-remove decision.
//   • IPI HEALTH — excess / aged / stranded (unsellable) classification that drives IPI.
//
// SELF-CONTAINED: imports only probabilistic.mjs (a clean .mjs). Runs in plain Node with no config.
// All fee figures are INDICATIVE India FBA defaults, seller-overridable, and superseded by report values.
// ─────────────────────────────────────────────────────────────────────────────
import { quantileForecast, newsvendorReorderPoint } from '../lib/probabilistic.mjs';

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
};

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

// ═══ COMPACT FORECASTING CORE (self-contained) ═══════════════════════════════
function classifyDemand(demands) {
  const nz = demands.filter(d => d > 0);
  if (nz.length < 2) return { pattern: nz.length ? 'new' : 'no-demand', adi: Infinity, cv2: 0 };
  let gaps = [], last = -1;
  demands.forEach((d, i) => { if (d > 0) { if (last >= 0) gaps.push(i - last); last = i; } });
  const adi = gaps.length ? meanA(gaps) : demands.length / nz.length;
  const cv2 = (stdA(nz) / meanA(nz)) ** 2;
  let pattern = adi < 1.32 && cv2 < 0.49 ? 'smooth' : adi < 1.32 ? 'erratic' : cv2 < 0.49 ? 'intermittent' : 'lumpy';
  return { pattern, adi: r2(adi), cv2: r2(cv2) };
}
function tsb(demands, a = 0.2, b = 0.1) {
  let p = demands.filter(d => d > 0).length / demands.length || 0.1;
  let z = meanA(demands.filter(d => d > 0)) || 0;
  for (const d of demands) { if (d > 0) { z += a * (d - z); p += b * (1 - p); } else { p += b * (0 - p); } }
  return Math.max(0, p * z);
}
function seasonalIndices(y, m) {
  if (y.length < 2 * m) return null; const o = meanA(y); if (o <= 0) return null;
  const idx = Array(m).fill(0), cnt = Array(m).fill(0);
  for (let i = 0; i < y.length; i++) { idx[i % m] += y[i]; cnt[i % m]++; }
  const s = idx.map((v, i) => cnt[i] ? (v / cnt[i]) / o : 1); const avg = meanA(s);
  return s.map(v => avg ? v / avg : 1);
}
// Returns a per-period forecaster f(k) plus pattern; damped-trend auto vs level, seasonal overlay, TSB for intermittent.
function buildForecaster(demands, gap) {
  const n = demands.length, cls = classifyDemand(demands);
  const ma = meanA(demands.slice(-Math.min(3, n)));
  let lvl = demands[0]; for (let i = 1; i < n; i++) lvl = 0.4 * demands[i] + 0.6 * lvl;
  const { a, b } = linreg(demands); const last = n - 1, phi = 0.9;
  const trendSum = k => { let s = 0; for (let i = 1; i <= k; i++) s += Math.pow(phi, i); return s; };
  const holt = k => Math.max(0, (a + b * last) + b * trendSum(k));
  const seasCands = gap < 2 ? [7] : gap < 45 ? [12] : gap < 135 ? [4] : [];
  let season = null, m = 0; for (const c of seasCands) { const s = seasonalIndices(demands, c); if (s) { season = s; m = c; break; } }
  if ((cls.pattern === 'intermittent' || cls.pattern === 'lumpy')) { const t = tsb(demands); return { f: () => t, pattern: cls.pattern, seasonal: false }; }
  const slopeShare = ma > 0 ? Math.abs(b) / ma : 0;
  let fn = (n >= 4 && slopeShare > 0.03) ? holt : (n >= 3 ? () => Math.max(0, lvl) : () => ma);
  if (season) { const bf = fn; fn = k => bf(k) * season[(last + k) % m]; }
  return { f: k => Math.max(0, fn(k)), pattern: cls.pattern, seasonal: !!season };
}
function backtestWmape(demands, gap) {
  const n = demands.length; if (n < 4) return null;
  let sAbs = 0, sAct = 0; const start = Math.max(3, Math.floor(n / 2));
  for (let t = start; t < n; t++) { const f = buildForecaster(demands.slice(0, t), gap).f(1); sAbs += Math.abs(f - demands[t]); sAct += Math.abs(demands[t]); }
  return sAct > 0 ? Math.round((sAbs / sAct) * 100) : null;
}
function horizonTotal(fc, gap, days) { let total = 0, used = 0, k = 1; while (used < days && k < 5000) { const seg = Math.min(gap, days - used); total += fc.f(k) * (seg / gap); used += seg; k++; } return Math.max(0, total); }

// ═══ REPORT PARSING (tolerant; Amazon report headers) ════════════════════════
function rowsToObjects(csvText) {
  if (!csvText || !csvText.trim()) return [];
  const lines = csvText.replace(/\r/g, '').split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const split = l => (l.includes('\t') && !l.includes(',')) ? l.split('\t') : parseCsvLine(l);
  const headers = split(lines[0]).map(h => h.toLowerCase().trim());
  return lines.slice(1).map(l => { const c = split(l); const o = {}; headers.forEach((h, i) => o[h] = (c[i] == null ? '' : c[i].trim())); return o; });
}
function parseCsvLine(line) { const out = []; let cur = '', q = false; for (let i = 0; i < line.length; i++) { const ch = line[i]; if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; } else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out; }
function pick(o, names) { for (const nm of names) { for (const k in o) { if (k === nm || k.includes(nm)) { if (o[k] !== '') return o[k]; } } } return ''; }
function idOf(o) { return { asin: pick(o, ['asin']), fnsku: pick(o, ['fnsku']), sku: pick(o, ['merchant sku', 'seller-sku', 'seller sku', 'msku', 'sku']) }; }
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

// ═══ PER-ASIN COMPUTE ════════════════════════════════════════════════════════
function computeAsin(rec, cfg) {
  const d = cfg.defaults;
  const lead = rec.leadTime > 0 ? rec.leadTime : d.leadTimeDays;
  const sl = cfg.serviceLevel || d.serviceLevel;

  // ── Forecast: prefer monthly trend series; else fall back to 30-day sales, lost-sales corrected.
  let dailyVel = 0, horizon = {}, pattern = 'snapshot', wmape = null, quant = null, gap = 30;
  const series = rec.monthlySeries && rec.monthlySeries.length >= 2 ? rec.monthlySeries : null;
  if (series) {
    gap = 30; const fc = buildForecaster(series, gap); pattern = fc.pattern;
    dailyVel = fc.f(1) / gap; wmape = backtestWmape(series, gap);
    const h = cfg.horizonDays || 90;
    horizon = { next30: r0(horizonTotal(fc, gap, 30)), next60: r0(horizonTotal(fc, gap, 60)), next90: r0(horizonTotal(fc, gap, 90)), nextH: r0(horizonTotal(fc, gap, h)) };
    const qf = quantileForecast(series, { gap, horizonDays: 30, centre: horizon.next30, pattern });
    quant = { p50: qf.p50, p90: qf.p90, p95: qf.p95, dist: qf.dist };
  } else {
    let base = rec.unitsSold30 > 0 ? rec.unitsSold30 / 30 : 0;
    if (rec.inStockRate > 0 && rec.inStockRate < 1 && base > 0) base = base / Math.max(0.3, rec.inStockRate); // lost-sales unconstraining
    dailyVel = base;
    horizon = { next30: r0(base * 30), next60: r0(base * 60), next90: r0(base * 90), nextH: r0(base * (cfg.horizonDays || 90)) };
    pattern = base > 0 ? 'snapshot' : 'no-demand';
  }
  const sigmaDaily = series ? stdA(series) / Math.sqrt(gap) : dailyVel * 0.4;

  // ── Inventory position
  const fulfillable = rec.fulfillable, inbound = rec.inbound, reserved = rec.reserved, unsellable = rec.unsellable;
  const onHand = fulfillable + reserved;
  const daysOfSupply = dailyVel > 0 ? Math.round((fulfillable + inbound) / dailyVel) : (fulfillable + inbound > 0 ? 999 : 0);

  // ── Safety stock + reorder point (newsvendor at service level)
  const nv = newsvendorReorderPoint({ dailyVelocity: dailyVel, sigmaDaily, leadTimeDays: lead, serviceLevel: sl });
  const safetyStock = Math.max(0, nv.rop - r0(dailyVel * lead));
  const reorderPoint = nv.rop;

  // ── Days-of-supply target SEND quantity (before restock-limit cap)
  const targetDoS = cfg.targetDaysOfSupply || d.targetDaysOfSupply;
  const targetUnits = Math.ceil(dailyVel * (targetDoS + lead) + safetyStock);
  const sendQtyUncapped = Math.max(0, targetUnits - (fulfillable + inbound));

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
  const excessUnits = Math.max(0, fulfillable - Math.ceil(dailyVel * targetDoS));
  const trueContribution = r2(contributionPerUnit - (fulfillable > 0 ? ltsfExposure / fulfillable : 0));
  const isProfitDrain = rec.price > 0 && trueContribution <= 0 && rec.unitsSold30 > 0;

  // ── Status / IPI health
  let status, priority = 'LOW';
  if (unsellable > 0 && fulfillable === 0) { status = 'Stranded (unsellable)'; priority = 'HIGH'; }
  else if (dailyVel > 0 && daysOfSupply <= lead) { status = 'Reorder now'; priority = 'URGENT'; }
  else if (dailyVel > 0 && daysOfSupply <= lead + targetDoS * 0.5) { status = 'Send soon'; priority = 'HIGH'; }
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
    dailyVelocity: r2(dailyVel), pattern, forecastWmape: wmape, forecastQuantiles: quant, ...horizon,
    fulfillable, inbound, reserved, unsellable, onHand, daysOfSupply,
    safetyStock, reorderPoint, targetDaysOfSupply: targetDoS, sendQty: sendQtyUncapped, sendQtyFinal: sendQtyUncapped,
    fees, storageOverHold: r2(storageOverHold), netProceeds: r2(netProceeds),
    contributionPerUnit, trueContribution, isProfitDrain,
    aged271, aged365, ltsfExposure, excessUnits,
    status, priority, removeRecommended, removeUnits, removeReason,
    leadTimeDays: lead, serviceLevel: Math.round(sl * 100),
  };
}

// ═══ MERGE REPORTS → RECORDS ═════════════════════════════════════════════════
function buildRecords(reports, cfg) {
  const restock = rowsToObjects(reports.restockCsv);
  const inventory = rowsToObjects(reports.inventoryCsv);
  const trend = rowsToObjects(reports.trendCsv);
  const asp = rowsToObjects(reports.aspCsv);

  const invIdx = {}; inventory.forEach(o => { const id = idOf(o); [id.asin, id.fnsku, id.sku].forEach(x => { if (x) invIdx[x.toLowerCase()] = o; }); });
  const aspIdx = {}; asp.forEach(o => { const id = idOf(o); [id.asin, id.fnsku, id.sku].forEach(x => { if (x) aspIdx[x.toLowerCase()] = o; }); });

  // Monthly series per ASIN from the trend report
  const seriesIdx = buildTrendSeries(trend);

  // Primary SKU list = restock report; fall back to inventory report if no restock provided.
  const primary = restock.length ? restock : inventory;
  const records = primary.map(o => {
    const id = idOf(o); const key = keyOf(id);
    const inv = invIdx[key] || {};
    const aspRow = aspIdx[key] || {};
    const price = num(pick(o, ['your-price', 'sales-price', 'price', 'asp'])) || num(pick(inv, ['your-price', 'sales-price'])) || num(pick(aspRow, ['asp', 'average selling price', 'price']));
    const ts = seriesIdx[key];
    return {
      asin: id.asin, fnsku: id.fnsku, sku: id.sku,
      name: pick(o, ['product name', 'product-name', 'title', 'item-name']) || pick(inv, ['product-name']),
      category: pick(o, ['category', 'product category', 'browse node', 'product type']) || pick(inv, ['category']),
      get categoryBucket() { return classifyCategory(this.category); },
      sizeTier: sizeTierOf(o.hasOwnProperty ? { ...o, ...inv } : o),
      price, cost: num(pick(o, ['cost', 'unit cost', 'landed cost', 'cogs'])),
      unitsSold30: num(pick(o, ['units sold last 30 days', 'sales last 30 days', 'units-sold-last-30-days', 'units ordered'])),
      inStockRate: num(pick(o, ['in-stock rate', 'in stock rate', 'instock rate'])) / (String(pick(o, ['in-stock rate', 'in stock rate'])).includes('%') ? 100 : 1) || (ts ? 0 : 0),
      fulfillable: num(pick(inv, ['afn-fulfillable-quantity', 'fulfillable quantity', 'available'])) || num(pick(o, ['available', 'fulfillable quantity'])),
      inbound: num(pick(inv, ['afn-inbound-working-quantity'])) + num(pick(inv, ['afn-inbound-shipped-quantity'])) + num(pick(inv, ['afn-inbound-receiving-quantity'])) || num(pick(o, ['inbound', 'inbound quantity'])),
      reserved: num(pick(inv, ['afn-reserved-quantity', 'reserved quantity'])) || num(pick(o, ['reserved'])),
      unsellable: num(pick(inv, ['afn-unsellable-quantity', 'unfulfillable'])) || num(pick(o, ['unfulfillable', 'unsellable'])),
      reportFulfilFee: num(pick(o, ['estimated fba fee', 'fulfilment fee', 'fulfillment fee', 'expected-fulfillment-fee-per-unit'])) || num(pick(inv, ['estimated-fee-total'])),
      reportStoragePerUnit: perUnitStorage(inv, o),
      aged271: num(pick(inv, ['inv-age-271-to-365-days', 'inv age 271 to 365'])) || num(pick(o, ['inv-age-271-to-365-days'])),
      aged365: num(pick(inv, ['inv-age-365-plus-days', 'inv age 365'])) || num(pick(o, ['inv-age-365-plus-days'])),
      leadTime: num(pick(o, ['lead time', 'lead time (days)', 'lead-time'])),
      monthlySeries: ts || null,
    };
  }).filter(r => r.asin || r.fnsku || r.sku);
  return records;
}

function perUnitStorage(inv, o) {
  const est = num(pick(inv, ['estimated-storage-cost-next-month', 'estimated storage cost next month'])) || num(pick(o, ['estimated-storage-cost-next-month']));
  const qty = num(pick(inv, ['afn-fulfillable-quantity', 'quantity-in-stock', 'quantity'])) || 0;
  return est > 0 && qty > 0 ? est / qty : 0;
}

// Build { key: [units per month ascending] } from a trend/business report.
function buildTrendSeries(trend) {
  if (!trend.length) return {};
  const idx = {};
  for (const o of trend) {
    const id = idOf(o); const key = keyOf(id); if (!key) continue;
    const month = monthKey(pick(o, ['date', 'month', 'order date', 'sale date', 'period', 'week']));
    const units = num(pick(o, ['units ordered', 'units sold', 'unitsordered', 'quantity', 'ordered units', 'units']));
    if (!month) continue;
    (idx[key] = idx[key] || {}); idx[key][month] = (idx[key][month] || 0) + units;
  }
  const out = {};
  for (const k in idx) { const months = Object.keys(idx[k]).sort(); if (months.length >= 2) out[k] = months.map(m => idx[k][m]); }
  return out;
}
function monthKey(v) {
  if (!v) return null; const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/); if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}`; }
  const M = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  m = s.match(/([A-Za-z]{3,})[\s\-'](\d{2,4})/); if (m) { const mm = M[m[1].slice(0, 3).toLowerCase()]; if (mm) { const y = m[2].length === 2 ? '20' + m[2] : m[2]; return `${y}-${mm}`; } }
  return null;
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
  const cfg = {
    defaults: { ...FBA_DEFAULTS, ...(cfgIn.defaults || {}) },
    horizonDays: cfgIn.horizonDays || 90,
    serviceLevel: cfgIn.serviceLevel != null ? (cfgIn.serviceLevel > 1 ? cfgIn.serviceLevel / 100 : cfgIn.serviceLevel) : FBA_DEFAULTS.serviceLevel,
    targetDaysOfSupply: cfgIn.targetDaysOfSupply || FBA_DEFAULTS.targetDaysOfSupply,
    referralOverride: cfgIn.referralOverride != null ? cfgIn.referralOverride : null,
    asOf: cfgIn.asOf ? new Date(cfgIn.asOf) : new Date(),
  };
  const records = buildRecords(reports, cfg);
  if (!records.length) return { error: 'No ASIN/SKU rows found. Upload at least the Restock or Inventory report.' };

  const rows = records.map(r => computeAsin(r, cfg));
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

  const summary = {
    skus: rows.length, activeSKUs: active.length,
    reorderNow: rows.filter(r => r.status === 'Reorder now').length,
    sendSoon: rows.filter(r => r.status === 'Send soon').length,
    stranded: rows.filter(r => r.status === 'Stranded (unsellable)').length,
    agedRisk: rows.filter(r => r.status === 'Aged / LTSF risk').length,
    excess: rows.filter(r => r.status === 'Excess').length,
    unitsToSend: sendPlan.unitsPlanned,
    // Inventory status — fulfillable vs unfulfillable (units)
    fulfillableUnits: rows.reduce((a, r) => a + r.fulfillable, 0),
    unfulfillableUnits: rows.reduce((a, r) => a + r.unsellable, 0),
    reservedUnits: rows.reduce((a, r) => a + r.reserved, 0),
    inboundUnits: rows.reduce((a, r) => a + r.inbound, 0),
    profitDrainSKUs: leaks.length,
    avgWmape: (() => { const w = active.filter(r => r.forecastWmape != null); return w.length ? Math.round(w.reduce((a, r) => a + r.forecastWmape, 0) / w.length) : null; })(),
    horizonDays: cfg.horizonDays, serviceLevel: Math.round(cfg.serviceLevel * 100), targetDaysOfSupply: cfg.targetDaysOfSupply,
  };

  const pr = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  return {
    summary,
    forecast: rows.slice().sort((a, b) => b.next30 - a.next30),
    sendPlan,
    reorderPlan: rows.filter(r => r.sendQty > 0).sort((a, b) => (pr[a.priority] - pr[b.priority]) || (b.next30 - a.next30)),
    agedInventory: rows.filter(r => r.aged365 > 0 || r.aged271 > 0).sort((a, b) => b.ltsfExposure - a.ltsfExposure),
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
    { type: s.avgWmape != null && s.avgWmape <= 30 ? 'green' : 'blue', icon: '🎯', text: s.avgWmape != null ? `Back-test WMAPE ~${s.avgWmape}% — ${s.avgWmape <= 20 ? 'high' : s.avgWmape <= 40 ? 'usable' : 'low'} forecast confidence.` : `Upload the Trend report for back-tested accuracy.` },
    { type: 'purple', icon: '💸', text: s.profitDrainSKUs ? `${s.profitDrainSKUs} ASIN(s) lose money after FBA fees — review price/size tier.` : `Trim excess before the Oct–Dec storage peak (2–3× fees).` },
  ];
  if (!apiKey) return fallback;
  const prompt = `You are an Amazon FBA supply-chain analyst. Return ONLY JSON: {"insights":[{"type":"green|orange|red|blue|purple","icon":"emoji","text":"one sentence"}]} with EXACTLY 6 insights (restock urgency, send plan vs restock limit, stranded/unsellable, aged/LTSF risk, forecast confidence via WMAPE, profit-after-fees or Q4 storage strategy). Use ONLY these numbers; invent nothing.
DATA: ${JSON.stringify({ ...s, currency: sym, restockLimit: out.sendPlan.restockLimitUnits, ltsfExposure: out.storageForecast.ltsfExposure, topReorder: out.reorderPlan.slice(0, 5).map(r => ({ p: r.name || r.sku, dos: r.daysOfSupply, send: r.sendQtyFinal })), topLeak: out.profitLeaks.slice(0, 3).map(r => ({ p: r.name || r.sku, tc: r.trueContribution })) })}`;
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
  const { restockCsv, inventoryCsv, trendCsv, aspCsv, ...cfg } = req.body || {};
  if (!restockCsv && !inventoryCsv) return res.status(400).json({ error: 'Upload at least the Restock or Inventory report.' });
  try {
    const out = runFbaForecast({ restockCsv, inventoryCsv, trendCsv, aspCsv }, cfg);
    if (out.error) return res.status(400).json(out);
    out.insights = await generateFbaInsights(out, cfg, process.env.GEMINI_API_KEY);  // same key/pattern as Demand Planner
    return res.status(200).json(out);
  } catch (e) { return res.status(400).json({ error: 'Could not process FBA reports: ' + e.message }); }
}
