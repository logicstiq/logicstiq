// ═══════════════════════════════════════════════════════════════════════════════════════════
// v13 — ACCURACY + SPEED BUILD (2026-10-01). Every change is tagged "FIX(v13)" inline.
// Measured with a hold-out test (forecast made at a cut-off, scored on the 30/60/90 days after it)
// on 64 synthetic SKUs × 3 seeds with a known generating process, plus 135 realistic SKUs with
// stockouts and promo shocks. Response JSON shape is unchanged; new fields are additive.
//  (1) one regular calendar per file: daily rows summed into weeks ending on the last date, missing
//      days = zero sales (order reports omit them), stockout periods filled from neighbours;
//  (2) dead SKUs in order reports are now detected (their series used to stop at the last sale);
//  (3) long no-sale gaps that chance can't explain are treated as stockouts when there is no stock column;
//  (4) Auto picks the method on horizon-TOTAL error over several past cut-offs, newest one kept unseen;
//  (5) smoothing weight fitted per SKU on weekly/monthly series;
//  (6) daily velocity = average of the next 4 weeks (not "next period ÷ gap");
//  (7) safety stock calibrated on the file's own back-test (reorder point covered lead-time demand
//      77% of the time at a 95% target on daily data; now ~95%), floored at pure-chance variability;
//  (8) reorder point and target use the same forecast (incl. festive days) the dashboard shows;
//  (9) return rows are netted in dated files (they were floored to zero row by row);
// (10) headline accuracy = volume-weighted horizon error on unseen data (was a simple mean of
//      next-day errors, which read ~60% error on daily files that were ~90% right at 60 days);
// (11) weekly/monthly files no longer flagged as stale because of their period label;
// (12) ~17× faster on daily files (back-test no longer refits every model once per day).
// ═══════════════════════════════════════════════════════════════════════════════════════════
// forecast.js — LogicstIQ AI Demand Planner — AUDIT-CORRECTED BUILD (v10)
// Patched 2026-07-10 after a full correctness audit. Every change is tagged "FIX(v10)" inline.
// Fixes: (1) 'day' period-synonym hijack of sales cols (e.g. "Units Sold Last 30 Days");
//        (2) safety-stock sigma uses /sqrt(gap) not /gap; (3) damped trend (phi=0.9);
//        (4) seasonal period tied to data granularity; (5) multi-warehouse repeated-total guard;
//        (6) real MAPE reported (was WMAPE relabelled); (7) Tally "Outwards" + Myntra "Style ID" synonyms;
//        (8) whole-word matching for <=3-char synonyms; (9) service-level z hardening; (10) US mm/dd dates.
// Documented-but-not-changed (see report): cold-start vs dead-stock, Excel multi-sheet column-order merge,
//        overstock 120d-vs-UI-180d copy, festival 2028+ fallback. Original behaviour preserved elsewhere.
// ═══════════════════════════════════════════════════════════════════════════════════════════
// /api/forecast.js — LogicstIQ AI Demand Planner v9 (India edition)
// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGED vs v8 (all fixes traceable to observed bugs on messy exports):
//  1. ORDER-LINE AGGREGATION — v8 kept only the first row per SKU/warehouse and
//     dropped subsequent lines, undercounting demand. v9 SUMS sales across every
//     line for a SKU, sums stock across DISTINCT warehouses only, and de-dupes
//     SKUs case/whitespace-insensitively.
//  2. RETURNS / STATUS — cancelled & returned lines were silently counted as
//     sales. v9 excludes cancelled/failed rows and SUBTRACTS returns/RTO and
//     negative quantities from net demand.
//  3. STOCKOUT UNCONSTRAINING — a zero-sales or out-of-stock row was read as
//     "dead / no demand". v9 detects an availability signal (stockout flag,
//     in-stock days, avail-minutes) and reconstructs censored demand, flagging
//     SKUs whose true demand is unknown instead of calling them dead.
//  4. FOOTER JUNK — "Grand Total / *** End of report ***" rows became fake SKUs.
//     v9 strips total/subtotal/footer rows.
//  5. INTERMITTENT DEMAND — added TSB (Teunter–Syntetos–Babai) + Syntetos–Boylan
//     pattern classification (smooth/erratic/intermittent/lumpy) so sparse
//     long-tail SKUs are forecast correctly instead of with a trend line.
//  6. ACCURACY — back-test now reports WMAPE (primary), bias/MPE and MASE, not
//     just MAPE (which explodes on zeros).
//  7. SAFETY STOCK — proper combined demand + lead-time variability formula and
//     a service-level→z table.
//  8. FESTIVAL CALENDAR — replaced fixed Gregorian windows with PER-YEAR lunar
//     dates (2025/2026/2027 verified) incl. the Pitru-Paksha demand DIP for
//     muhurat-sensitive categories, and a two-wave festive-sale model.
//  9. COLD START — new SKUs with no history seed from category-median velocity.
// Gemini 2.5 Flash is used ONLY to write the narrative insights from computed
// numbers — it never produces a forecast figure.
// ─────────────────────────────────────────────────────────────────────────────
// GOD-MODE ADD-ONS (v11, additive — no change to existing behaviour, visuals or copy):
//   • econ.mjs         — India unit economics (fees, GST, RTO) → true contribution per SKU
//   • probabilistic.mjs — P50/P90/P95 quantile band around each horizon forecast
//   • buyplan.mjs      — budget-constrained buy plan + supplier/dark-store purchase orders
// These only ADD fields to the JSON the engine returns; the existing UI ignores them until wired.
// ─────────────────────────────────────────────────────────────────────────────
import { enrichWithEconomics, profitLeaks } from './_lib/econ.mjs';
import { quantileForecast } from './_lib/probabilistic.mjs';
import { budgetConstrainedPlan, groupPurchaseOrders } from './_lib/buyplan.mjs';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const apiKey = process.env.GEMINI_API_KEY;

  let { csvText, csvGz, horizon, currency, region, channels, planLevel, erpSource, method, salesWindowDays, festivalMode, commerceType, serviceLevel, codShare, poBudget, econOverrides } = req.body || {};
  if (!csvText && csvGz) {
    try { const zlib = await import('node:zlib'); csvText = zlib.gunzipSync(Buffer.from(csvGz, 'base64')).toString('utf8'); }
    catch (e) { return res.status(400).json({ error: 'Could not read the compressed file.' }); }
  }
  if (!csvText || csvText.trim().length < 10) return res.status(400).json({ error: 'No data received. Please upload a valid file.' });

  const cfg = {
    sym: currency || '₹',
    horizDays: parseInt(horizon) || 90,
    method: (method || 'Auto').toString(),
    salesWindow: Math.max(1, parseInt(salesWindowDays) || 30),
    level: (planLevel || 'SKU').toString(),
    region: region || 'India',
    channels: Array.isArray(channels) ? channels : [],
    erpSource: erpSource || 'auto',
    serviceLevel: serviceLevel != null ? parseFloat(serviceLevel) : null,
    codShare: codShare != null ? parseFloat(codShare) : null,       // God-mode: COD share for RTO economics
    poBudget: poBudget != null ? parseFloat(poBudget) : 0,          // God-mode: cash budget for this PO cycle
    econOverrides: (econOverrides && typeof econOverrides === 'object') ? econOverrides : {},
  };
  cfg.isIndia = (region == null) || /india/i.test(cfg.region.toString());
  cfg.qcom = /quick|q-?com/i.test((commerceType || '').toString()) ||
    (cfg.channels.length > 0 && cfg.channels.every(c => QCOM_CHANNELS.includes(c)));
  cfg.applyFestival = (festivalMode !== false && festivalMode !== 'off') && cfg.isIndia;

  let out;
  try { out = runForecast(csvText, cfg); }
  catch (e) { return res.status(400).json({ error: 'Could not process your file: ' + e.message }); }
  if (out.error) return res.status(400).json(out);

  const [insights, plainSummary] = await Promise.all([
    generateInsights(out.summary, out.reorderPlan, out.slowMoversAll, cfg, apiKey),
    generatePlainSummary(out, cfg, apiKey),
  ]);
  out.insights = insights; out.plainSummary = plainSummary;
  return res.status(200).json(out);
}

// ═══ PIPELINE ════════════════════════════════════════════════════════════════
export function runForecast(csvText, cfg) {
  const rows = parseCSVSmart(csvText);
  if (!rows || rows.length < 2) return { error: 'Could not read your file. Ensure it has a header and at least one data row.' };

  const headers = rows[0];
  const map = mapColumns(headers);
  if (map.sku === undefined && map.product === undefined)
    return { error: 'No SKU or product column found. Add a column such as "SKU" or "Product Name".' };
  // q-commerce (or store/city planning) forecasts each location separately; e-commerce merges locations into one SKU.
  cfg.splitWh = (cfg.splitWh != null) ? cfg.splitWh : (cfg.qcom || /dark ?store|city|store/i.test(String(cfg.level || '')));

  const dataRows = rows.slice(1)
    .filter(r => r.some(c => c && c.trim()))
    .filter(r => !isJunkRow(r, map));

  const { skuMap, isTS, catStats } = buildSkuMap(dataRows, map, cfg);
  // FIX(v12): the forecast origin is TODAY, but nothing checked how old the file is.
  // Upload a history ending two months ago with festival mode on and the engine happily
  // applies a festive-sale uplift for a window the data has never seen, with no warning.
  let dataEnd = null;
  for (const s of Object.values(skuMap)) for (const p of (s.periods || [])) {
    const d = new Date(p.period); if (!isNaN(d) && (!dataEnd || d > dataEnd)) dataEnd = d;
  }
  const skuList = Object.values(skuMap);
  if (!skuList.length) return { error: 'No valid SKUs found after cleaning the file.' };

  const today = cfg.today ? new Date(cfg.today) : new Date();
  // FIX(v13): put every dated SKU on ONE regular calendar before forecasting (see prepSeries).
  cfg._grid = isTS ? detectGrid(skuMap, today) : null;
  cfg._ltMult = 1;
  // FIX(v13): a weekly or monthly row is labelled with one date but covers a whole week or month,
  // so a perfectly fresh weekly file was flagged "data ends 13 days ago". Use the period's end.
  if (cfg._grid && dataEnd) {
    if (cfg._grid.kind === 'week') dataEnd = new Date((cfg._grid.endDay + 6) * 86400000);
    else if (cfg._grid.kind === 'month') { const m = cfg._grid.endMonth + 1; dataEnd = new Date(Date.UTC(Math.floor(m / 12), m % 12, 0)); }
  }
  if (cfg._grid) {
    for (const s of skuList) if (s.periods.length >= 1) s._ts = prepSeries(s, cfg._grid, cfg, map);
    cfg._calib = calibrateSafetyStock(skuList, cfg);
    if (cfg._calib) cfg._ltMult = cfg._calib.mult;
  }
  let results = skuList.map(s => computeSKU(s, isTS, today, cfg, map, catStats));
  // GOD-MODE: enrich every SKU with India unit economics (additive — original fields untouched).
  results = enrichWithEconomics(results, { codShare: cfg.codShare, overrides: cfg.econOverrides || {} });

  const originGapDays = dataEnd ? Math.max(0, Math.round((today - dataEnd) / 86400000)) : null;
  const summary = buildSummary(results, isTS, cfg, map, { dataEnd, originGapDays });
  const active = results.filter(s => s.isActive);
  const pOrd = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const reorderPlanArr = results.filter(s => s.needsReorder).sort((a, b) => (pOrd[a.priority] || 3) - (pOrd[b.priority] || 3)).slice(0, 60);

  return {
    summary,
    demandForecast: active.slice().sort((a, b) => b.avgMonthlyDemand - a.avgMonthlyDemand).slice(0, 100),
    reorderPlan: reorderPlanArr,
    slowMoversAll: results.filter(s => s.isSlowMover || s.isDead).sort((a, b) => b.invValue - a.invValue).slice(0, 50),
    stockoutRisk: results.filter(s => s.stockoutProb > 30).sort((a, b) => b.stockoutProb - a.stockoutProb).slice(0, 30),
    allSKUs: results,
    groupedForecast: buildGroups(results, cfg.level),
    upcomingEvents: cfg.applyFestival ? upcomingIndiaEvents(today) : [],
    // GOD-MODE additive outputs (existing UI ignores these until wired):
    buyPlan: budgetConstrainedPlan(reorderPlanArr, cfg.poBudget || 0),
    purchaseOrders: groupPurchaseOrders(reorderPlanArr, { groupBy: cfg.qcom ? 'warehouse' : 'brand' }),
    profitLeaks: profitLeaks(results).slice(0, 50),
    insights: [],
  };
}

// ═══ CSV PARSER (best-header detection; skips metadata rows) ══════════════════
export function parseCSVSmart(text) {
  const allRows = [];
  for (const line of text.split('\n')) {
    const t = line.replace(/\r$/, '');
    if (!t.trim()) continue;
    allRows.push(t.includes('\t') && !t.includes(',') ? t.split('\t').map(x => x.trim()) : parseCSVLine(t));
  }
  if (!allRows.length) return [];
  const KW = ['sku', 'asin', 'product', 'item', 'stock', 'qty', 'quantity', 'units', 'sales', 'sold', 'available', 'inbound', 'price', 'cost', 'category', 'brand', 'description', 'material', 'part', 'code', 'name', 'article', 'variant', 'closing', 'opening', 'velocity', 'demand', 'warehouse', 'location', 'date', 'status', 'order'];
  let headerIdx = 0, best = -1;
  for (let i = 0; i < Math.min(allRows.length, 15); i++) {
    const cells = allRows[i].map(c => (c || '').toString().toLowerCase().trim());
    const filled = cells.filter(Boolean).length;
    const matches = KW.filter(k => cells.some(c => c.includes(k))).length;
    if (filled < 2 || matches < 2) continue;
    const score = matches * 10 + filled;
    if (score > best) { best = score; headerIdx = i; }
  }
  return allRows.slice(headerIdx).filter(r => r.some(c => c && c.trim()));
}
function parseCSVLine(line) {
  const cells = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if ((ch === ',' || ch === '\t') && !inQ) { cells.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  cells.push(cur.trim()); return cells;
}
// footer / total / separator rows must not become SKUs
export function isJunkRow(row, map) {
  const key = ((map.sku !== undefined ? row[map.sku] : '') || (map.product !== undefined ? row[map.product] : '') || '').toString().trim().toLowerCase();
  if (!key) return false;
  return /^(grand\s*total|sub\s*total|total|net total|report total|\*+|-{3,}|end of report|figures? )/.test(key)
    || /\*\*\*/.test(key);
}

// ═══ COLUMN MAPPER ═══════════════════════════════════════════════════════════
const SYN = {
  sku: ['sku', 'sku id', 'sku code', 'seller sku', 'merchant sku', 'item id', 'item code', 'item number', 'product code', 'product id', 'part no', 'part number', 'article no', 'article code', 'stock code', 'stock id', 'material code', 'material number', 'asin', 'fnsku', 'fsn', 'barcode', 'upc', 'ean', 'isbn', 'material', 'matnr', 'stock item', 'stock item name', 'internal id', 'variant sku', 'skucode', 'sku_code', 'item_code', 'style code', 'style id', 'listing id', 'product sku', 'vendor sku', 'variant id', 'default code'],
  product: ['product name', 'product title', 'product', 'title', 'item name', 'item description', 'product description', 'description', 'display name', 'item', 'goods', 'material description', 'stock item name', 'particulars', 'released product', 'channel product name', 'article name', 'style name'],
  period: ['date', 'order date', 'order dt', 'sale date', 'sales date', 'txn date', 'transaction date', 'invoice date', 'billing date', 'posting date', 'document date', 'dispatch date', 'shipment date', 'movement date', 'month', 'week', 'period', 'sales month', 'sales period', 'reporting period', 'fiscal period', 'accounting period', 'fy', 'month year', 'yyyy-mm-dd', 'dd-mm-yyyy'],
  price: ['selling price', 'sale price', 'sell price', 'unit price', 'price', 'mrp', 'asp', 'rate', 'item price', 'online price', 'sales price', 'your price', 'buy box price', 'your selling price', 'discounted price', 'net price', 'retail price'],
  cost: ['unit cost', 'cost price', 'standard cost', 'purchase price', 'purchase rate', 'landed cost', 'cogs', 'cost of goods', 'buy price', 'moving average price', 'valuation price', 'cost', 'avg cost', 'average cost', 'wac'],
  unitsSold: ['units sold', 'qty sold', 'quantity sold', 'sales qty', 'sales quantity', 'units sold last 30 days', 'units', 'qty', 'quantity', 'demand', 'monthly demand', 'monthly sales', 'daily sales', 'sales units', 'sold qty', 'items sold', 'pieces sold', 'qty dispatched', 'dispatched qty', 'delivery quantity', 'billed quantity', 'issued quantity', 'outward qty', 'outward quantity', 'outwards', 'outward', 'shipped quantity', 'invoiced quantity', 'total sold', 'units ordered', 'order quantity', 'fulfilled quantity', 'net quantity', 'total sales', 'sales'],
  returns: ['returns', 'return qty', 'returned qty', 'returned units', 'return/rto qty', 'rto qty', 'rto', 'refunded qty', 'refund qty', 'returns qty', 'return units', 'customer returns', 'rto/return', 'returned quantity'],
  status: ['order status', 'status', 'order state', 'fulfilment status', 'fulfillment status', 'shipment status', 'delivery status'],
  velocity: ['daily velocity', 'velocity 7d', 'velocity 30d', 'velocity', 'daily demand', 'avg daily sales', 'daily run rate', 'run rate', 'units per day', 'sales per day', 'average daily demand', 'adu', 'average daily usage', 'daily avg'],
  available: ['available', 'on hand', 'on-hand', 'qty available', 'stock', 'in stock', 'current stock', 'closing stock', 'closing balance', 'closing qty', 'sellable units', 'fulfillable qty', 'warehouse stock', 'physical stock', 'net stock', 'usable stock', 'free stock', 'available quantity', 'godown stock', 'stock in hand', 'quantity on hand', 'quantity available', 'on hand quantity', 'inventory on hand', 'available inventory', 'sellable inventory', 'fulfillable quantity', 'afn sellable quantity', 'inventory quantity', 'qty on hand', 'inventory level', 'inventory', 'stock level', 'stock on hand', 'soh', 'opening stock', 'ending inventory', 'closing inventory', 'inventory on-hand', 'balance qty', 'balance quantity'],
  inbound: ['inbound', 'on order', 'in transit', 'po qty', 'incoming', 'ordered qty', 'open po', 'purchase order qty', 'po quantity', 'receiving', 'fc transfer', 'inbound qty', 'scheduled receipts', 'quantity on order', 'quantity in transit', 'due in', 'incoming quantity'],
  reserved: ['reserved', 'customer order', 'unfulfilled', 'pending dispatch', 'committed', 'allocated', 'reserved stock', 'quantity committed', 'reserved physical'],
  leadTime: ['lead time', 'lead time (days)', 'lt', 'lead time days', 'supplier lead time', 'replenishment lead time', 'procurement lead time', 'days to receive', 'delivery days', 'planned delivery time', 'vendor lead time'],
  leadTimeVar: ['lead time std', 'lead time variability', 'lead time sd', 'lt std', 'lt variability', 'lead time deviation'],
  reorderQty: ['reorder qty', 'reorder quantity', 'suggested reorder qty', 'suggested order qty', 'min order qty', 'moq', 'economic order quantity', 'eoq', 'recommended order qty', 'minimum order quantity'],
  reorderPoint: ['reorder point', 'rop', 'reorder level', 'minimum stock level', 'min stock level'],
  safetyStock: ['safety stock', 'buffer stock', 'minimum stock', 'reserve stock', 'safety inventory'],
  momTrend: ['mom trend', 'm-o-m', 'month over month', 'month-over-month', 'mom growth', 'mom', 'momentum', 'growth rate'],
  seasonalIndex: ['seasonal index', 'seasonality index', 'seasonal factor', 'season index', 'seasonality'],
  // availability / stockout signals for censored-demand correction:
  stockoutFlag: ['stockout flag', 'stockout', 'out of stock', 'oos', 'oos flag', 'is oos', 'was oos', 'availability flag'],
  daysOutOfStock: ['days out of stock', 'oos days', 'stockout days', 'days oos', 'lost sales days'],
  inStockDays: ['in stock days', 'days in stock', 'available days', 'instock days'],
  availMins: ['avail_mins', 'availability minutes', 'available minutes', 'minutes available', 'uptime mins', 'avail mins'],
  alert: ['alert', 'alerts', 'fba alert', 'inventory alert', 'health alert', 'stranded reason', 'condition alert'],
  recommendedAction: ['recommended action', 'recommended replenishment action', 'suggested action'],
  category: ['category', 'department', 'product type', 'product category', 'item type', 'item category', 'product class', 'sub category', 'product group', 'item group', 'material group', 'product hierarchy', 'stock group', 'sub-category', 'vertical', 'browse node'],
  brand: ['brand', 'brand name', 'manufacturer', 'vendor', 'supplier', 'make', 'label', 'party name'],
  warehouse: ['warehouse', 'fc', 'fulfillment center', 'dc', 'distribution center', 'storage location', 'godown', 'plant', 'site', 'warehouse code', 'fc name', 'dark store', 'darkstore', 'store', 'store id', 'facility'],
  city: ['city', 'town', 'metro', 'delivery city'],
  channel: ['channel', 'platform', 'sales channel', 'order source', 'fulfillment channel', 'marketplace'],
  uom: ['uom', 'unit of measure', 'unit', 'base unit', 'sales unit'],
};
// FIX(v10): short synonyms (<=3 chars: 'day','ean','lt','fc',...) must match a whole word, not a substring.
function matchHeader(h, name) {
  if (h === name) return true;
  if (name.length <= 3) return new RegExp('(^|[^a-z0-9])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z0-9]|$)').test(h);
  return h.includes(name) || (name.length > 4 && name.includes(h) && h.length > 3);
}
export function mapColumns(headers) {
  const map = {};
  const lh = headers.map(h => (h || '').toString().toLowerCase().trim().replace(/[_\-]/g, ' ').replace(/\s+/g, ' '));
  for (const [field, names] of Object.entries(SYN)) {
    for (const name of names) {
      const idx = lh.findIndex(h => matchHeader(h, name));
      if (idx !== -1 && map[field] === undefined && !Object.values(map).includes(idx)) { map[field] = idx; break; }
    }
  }
  return map;
}

// ═══ SKU MAP (aggregation + returns + censoring) ═════════════════════════════
const DEAD_STATUS = /cancel|fail|lost|void|reject|declin/i;
const RETURN_STATUS = /return|rto|refund|rejected by customer/i;
export function buildSkuMap(dataRows, map, cfg) {
  const get = (row, f) => { const i = map[f]; return (i !== undefined && row[i] != null) ? row[i].toString().trim() : ''; };
  const skuMap = {}; let auto = 0;

  for (const row of dataRows) {
    const status = get(row, 'status');
    if (status && DEAD_STATUS.test(status)) continue;          // drop cancelled/failed lines entirely

    const prod = get(row, 'product');
    const rawSku = get(row, 'sku') || prod || ('item_' + (++auto));
    const wh = get(row, 'warehouse') || get(row, 'city') || '—';
    const baseKey = rawSku.toLowerCase().replace(/\s+/g, ' ').trim().substring(0, 60);  // case/space-insensitive
    if (!baseKey) continue;
    const key = (cfg.splitWh && wh !== '—') ? (baseKey + ' § ' + wh.toLowerCase()) : baseKey;

    const qtySigned = pSignedNum(get(row, 'unitsSold'));       // may be negative (a reversal)
    const explicitReturns = pNum(get(row, 'returns'));
    const isReturnRow = status && RETURN_STATUS.test(status);

    let grossAdd = 0, returnAdd = 0;
    if (isReturnRow) returnAdd += Math.max(Math.abs(qtySigned || 0), explicitReturns);   // one return, described once
    else if (qtySigned < 0) returnAdd += Math.max(Math.abs(qtySigned), explicitReturns);  // negative qty = return
    else { grossAdd += (qtySigned || 0); returnAdd += explicitReturns; }                   // returns booked vs this sale

    const avail = pNum(get(row, 'available'));
    const inbound = pNum(get(row, 'inbound'));
    const reserved = pNum(get(row, 'reserved'));
    const price = pNum(get(row, 'price'));
    const cost = pNum(get(row, 'cost'));
    const vel = pNum(get(row, 'velocity'));
    const lt = pNum(get(row, 'leadTime'));
    const ltVar = pNum(get(row, 'leadTimeVar'));
    const period = get(row, 'period');
    const mom = map.momTrend !== undefined ? pSignedNum(get(row, 'momTrend')) : null;
    const seas = map.seasonalIndex !== undefined ? pNum(get(row, 'seasonalIndex')) : null;
    let availFrac = rowAvailability(row, get, map, period);   // 0..1 or null

    if (!skuMap[key]) {
      skuMap[key] = {
        sku: (rawSku).substring(0, 60), product: (prod || rawSku).substring(0, 80),
        grossUnits: 0, returnUnits: 0, dailyVelocity: 0,
        available: 0, inbound: 0, reserved: 0,
        price: 0, cost: 0, leadTime: 0, leadTimeVar: 0,
        reorderQty: pNum(get(row, 'reorderQty')), safetyStock: pNum(get(row, 'safetyStock')), reorderPoint: pNum(get(row, 'reorderPoint')),
        momTrend: mom, seasonalIndex: seas,
        category: get(row, 'category') || 'General', brand: get(row, 'brand') || '—',
        warehouse: wh, city: get(row, 'city') || '', channel: get(row, 'channel') || '—', uom: get(row, 'uom') || 'Units',
        periods: [], _wh: {}, _salesByWh: {}, _retByWh: {}, _velByWh: {}, _rows: 0, _hasPeriod: false, censoredObs: 0, totalObs: 0, oosFlag: false,
      };
    }
    const e = skuMap[key];
    if (!e.product && prod) e.product = prod.substring(0, 80);
    if (price > 0 && e.price === 0) e.price = price;
    if (cost > 0 && e.cost === 0) e.cost = cost;
    if (lt > 0 && e.leadTime === 0) e.leadTime = lt;
    if (ltVar > 0 && e.leadTimeVar === 0) e.leadTimeVar = ltVar;
    if (mom != null && e.momTrend == null) e.momTrend = mom;
    if (seas != null && e.seasonalIndex == null) e.seasonalIndex = seas;
    if (e.category === 'General' && get(row, 'category')) e.category = get(row, 'category');
    // Amazon-style point-in-time stock alert (e.g. Alert = "out_of_stock"): flag, do NOT inflate demand
    const alertV = ((map.alert !== undefined ? get(row, 'alert') : '') + ' ' + (map.recommendedAction !== undefined ? get(row, 'recommendedAction') : '')).toLowerCase();
    if (/out.?of.?stock|stranded|no.?inventory|restock/.test(alertV)) e.oosFlag = true;

    // SALES: always accumulate across every line (order-line data)
    e.grossUnits += grossAdd;
    e.returnUnits += returnAdd;
    e.dailyVelocity += vel;
    e._rows++; if (period) e._hasPeriod = true;   // FIX(v10): track per-wh sales to catch repeated account-level totals
    e._salesByWh[wh] = (e._salesByWh[wh] || 0) + grossAdd;
    e._retByWh[wh] = (e._retByWh[wh] || 0) + returnAdd;
    e._velByWh[wh] = (e._velByWh[wh] || 0) + vel;

    // STOCK per warehouse: for DATED data keep the LATEST date's snapshot (on-hand changes over time,
    // so the most recent reading is the real position); for undated exports keep the max seen (dedupe
    // repeated rows). Summed across distinct warehouses in the finalise step.
    const prev = e._wh[wh] || { avail: 0, inbound: 0, reserved: 0, _d: '' };
    if (period) {
      const _d = normalisePeriod(period);
      e._wh[wh] = (_d >= (prev._d || '')) ? { avail, inbound, reserved, _d } : prev;
    } else {
      e._wh[wh] = { avail: Math.max(prev.avail, avail), inbound: Math.max(prev.inbound, inbound), reserved: Math.max(prev.reserved, reserved), _d: prev._d };
    }

    // TIME SERIES: one net observation per DATE. Multiple rows sharing the same (SKU, date) —
    // e.g. the same product across several stores/warehouses in a panel export — are SUMMED into a
    // single daily observation, so the series is one clean demand line per SKU (huge accuracy win on
    // multi-store daily data, and always correct: a SKU can't have two different sales for one date).
    if (period) {
      const np = normalisePeriod(period);
      // FIX(v13): returns usually arrive as their OWN rows (status "Returned", or a negative qty).
      // Flooring each row at zero threw every return row away, so dated files were never net of
      // returns. Keep the signed value here; it is floored once per period after summing.
      const net = grossAdd - returnAdd;
      // FIX(v12): most marketplace exports carry an on-hand quantity and no stockout
      // flag, so rowAvailability() returned null and censored demand was read as real
      // zero demand. A dated row with zero sales AND zero sellable stock is a stockout.
      if (availFrac == null && map.available !== undefined && net <= 0 && returnAdd === 0) {
        const onHand = pNum(get(row, 'available'));
        if (isFinite(onHand) && onHand <= 0) availFrac = 0;
      }
      const fullyOut = availFrac != null && availFrac <= 0.05;
      const trueDemand = (availFrac != null && availFrac > 0.05 && availFrac < 1) ? net / Math.max(0.2, availFrac) : net;
      if (!e._pidx) e._pidx = {};
      const ex = e._pidx[np];
      if (ex) {
        ex.units = Math.round((ex.units + trueDemand) * 100) / 100;
        ex.raw += net;
        if (availFrac != null) ex.availFrac = (ex.availFrac == null) ? availFrac : Math.max(ex.availFrac, availFrac);
        ex.stockout = ex.stockout && fullyOut;   // a date is only "out" if every row that day was out
      } else {
        const o = { period: np, units: Math.round(trueDemand * 100) / 100, raw: net, availFrac, stockout: fullyOut };
        e._pidx[np] = o; e.periods.push(o);
      }
    }
    if (availFrac != null) { e.totalObs++; if (availFrac < 0.95) e.censoredObs++; }
  }

  // finalise stock rollup across warehouses
  for (const e of Object.values(skuMap)) {
    const whs = Object.keys(e._wh);
    e.warehouseCount = whs.length;
    e.available = whs.reduce((a, w) => a + e._wh[w].avail, 0);
    e.inbound = whs.reduce((a, w) => a + e._wh[w].inbound, 0);
    e.reserved = whs.reduce((a, w) => a + e._wh[w].reserved, 0);
    // FIX(v10): snapshot repeated-total guard — one row per distinct warehouse all carrying the SAME sales figure is
    // an account-level total copied per FC, not additive order lines; collapse instead of multiplying demand.
    const _sv = Object.values(e._salesByWh);
    if (!e._hasPeriod && e.warehouseCount > 1 && e._rows === e.warehouseCount && _sv.length === e.warehouseCount && _sv.every(v => v === _sv[0]) && _sv[0] > 0) {
      e.grossUnits = _sv[0];
      const _rv = Object.values(e._retByWh); if (_rv.length) e.returnUnits = _rv[0];
      const _vv = Object.values(e._velByWh); if (_vv.length && _vv.every(v => v === _vv[0])) e.dailyVelocity = _vv[0];
      e.collapsedWhTotal = true;
    }
    delete e._salesByWh; delete e._retByWh; delete e._velByWh; delete e._pidx;
    e.netUnits = Math.max(0, e.grossUnits - e.returnUnits);
    e.returnRate = e.grossUnits > 0 ? e.returnUnits / e.grossUnits : 0;
    if (e.leadTime === 0) e.leadTime = cfg.qcom ? 2 : 30;
    delete e._wh;
    if (e.periods.length >= 2) e.periods.sort((a, b) => (new Date(a.period) - new Date(b.period)) || a.period.localeCompare(b.period));
  }

  const isTS = Object.values(skuMap).some(s => s.periods.length >= 2);

  // category-median daily velocity for cold-start seeding
  const catStats = {};
  for (const e of Object.values(skuMap)) {
    const cat = classifyCategory(e.category);
    const dv = isTS && e.periods.length >= 2
      ? mean(e.periods.map(p => p.units)) / (detectGapDays(e.periods) || 30)
      : (e.dailyVelocity > 0 ? e.dailyVelocity : e.netUnits / cfg.salesWindow);
    (catStats[cat] = catStats[cat] || []).push(dv);
  }
  for (const k in catStats) catStats[k] = median(catStats[k].filter(v => v > 0));
  return { skuMap, isTS, catStats };
}

// availability fraction for a row (1 = fully in stock, 0 = fully out). null if unknown.
function rowAvailability(row, get, map, period) {
  if (map.stockoutFlag !== undefined) {
    const v = get(row, 'stockoutFlag').toLowerCase();
    if (/^(y|yes|true|1|oos|out)/.test(v)) return 0.0;
    if (/partial/.test(v)) return 0.5;
    if (/^(n|no|false|0|in)/.test(v) || v === '') { /* fall through to other signals */ }
    else return null;
  }
  if (map.availMins !== undefined) { const m = pNum(get(row, 'availMins')); if (m >= 0) return Math.min(1, m / 1440); }
  if (map.inStockDays !== undefined) { const d = pNum(get(row, 'inStockDays')); const P = 30; if (d >= 0) return Math.min(1, d / P); }
  if (map.daysOutOfStock !== undefined) { const d = pNum(get(row, 'daysOutOfStock')); const P = 30; return Math.max(0, 1 - Math.min(1, d / P)); }
  if (map.stockoutFlag !== undefined) return 1.0; // flag existed and was "in stock"
  return null;
}

function normalisePeriod(raw) {
  if (!raw) return raw;
  const s = raw.toString().trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  // Excel serial date
  if (/^\d{5}(\.\d+)?$/.test(s)) { const n = parseInt(s, 10); const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000); return d.toISOString().substring(0, 10); }
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) { let day = +dmy[1], mo = +dmy[2]; if (mo > 12 && day <= 12) { const t = day; day = mo; mo = t; } const y = dmy[3].length === 2 ? '20' + dmy[3] : dmy[3]; return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }
  const my = s.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (my) return `${my[2]}-${my[1].padStart(2, '0')}-01`;
  const M = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  const mon = s.match(/^(\d{1,2})\s*([A-Za-z]{3,})\s*(\d{2,4})$/); // 5 Sep 2024
  if (mon) { const m = M[mon[2].slice(0, 3).toLowerCase()]; if (m) { const y = mon[3].length === 2 ? '20' + mon[3] : mon[3]; return `${y}-${m}-${mon[1].padStart(2, '0')}`; } }
  const mony = s.match(/^([A-Za-z]{3,})[\s\-'](\d{2,4})$/);         // Sep 2024
  if (mony) { const m = M[mony[1].slice(0, 3).toLowerCase()]; if (m) { const y = mony[2].length === 2 ? '20' + mony[2] : mony[2]; return `${y}-${m}-01`; } }
  return s;
}

// ═══ FORECASTING CORE ════════════════════════════════════════════════════════
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function median(a) { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function std(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.map(x => (x - m) ** 2).reduce((x, y) => x + y, 0) / (a.length - 1)); }
function linreg(y) { const n = y.length; if (n < 2) return { a: y[0] || 0, b: 0 }; let sx = 0, sy = 0, sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sx += i; sy += y[i]; sxx += i * i; sxy += i * y[i]; } const d = n * sxx - sx * sx; const b = d ? (n * sxy - sx * sy) / d : 0; return { a: (sy - b * sx) / n, b }; }
function detectGapDays(periods) {
  const ds = periods.map(p => new Date(p.period)).filter(d => !isNaN(d));
  if (ds.length >= 2) { const g = []; for (let i = 1; i < ds.length; i++) { const x = (ds[i] - ds[i - 1]) / 86400000; if (x > 0) g.push(x); } if (g.length) { g.sort((a, b) => a - b); const med = g[Math.floor(g.length / 2)]; if (med >= 0.5) return med; } }
  return 30;
}
function gapLabel(g) { return g < 2 ? 'daily' : g < 10 ? 'weekly' : g < 45 ? 'monthly' : g < 135 ? 'quarterly' : 'yearly'; }

// Syntetos–Boylan demand classification
export function classifyDemand(demands) {
  const nz = demands.filter(d => d > 0);
  if (nz.length < 2) return { pattern: nz.length ? 'new' : 'no-demand', adi: Infinity, cv2: 0 };
  let gaps = [], last = -1, cnt = 0;
  demands.forEach((d, i) => { cnt++; if (d > 0) { if (last >= 0) gaps.push(i - last); last = i; } });
  const adi = gaps.length ? mean(gaps) : demands.length / nz.length;
  const cv2 = (std(nz) / mean(nz)) ** 2;
  let pattern;
  if (adi < 1.32 && cv2 < 0.49) pattern = 'smooth';
  else if (adi < 1.32) pattern = 'erratic';
  else if (cv2 < 0.49) pattern = 'intermittent';
  else pattern = 'lumpy';
  return { pattern, adi: Math.round(adi * 100) / 100, cv2: Math.round(cv2 * 100) / 100 };
}
// TSB (Teunter–Syntetos–Babai) — per-period expected demand for intermittent series
export function tsbForecast(demands, a = 0.2, b = 0.1) {
  let p = demands.filter(d => d > 0).length / demands.length || 0.1;
  let z = mean(demands.filter(d => d > 0)) || 0;
  for (const d of demands) { if (d > 0) { z = z + a * (d - z); p = p + b * (1 - p); } else { p = p + b * (0 - p); } }
  // FIX(v12): the smoothed occurrence rate has an effective window of ~1/b periods,
  // so on lumpy demand it swings on whether the last few days happened to be quiet.
  // Blend it with the long-run rate, which is the better estimator of a 60-day total.
  const nz = demands.filter(d => d > 0);
  const longRun = demands.length ? (nz.length / demands.length) * (mean(nz) || 0) : 0;
  return Math.max(0, 0.5 * (p * z) + 0.5 * longRun);
}
function seasonalIndices(y, m) {
  if (y.length < 2 * m) return null; const o = mean(y); if (o <= 0) return null;
  const idx = Array(m).fill(0), cnt = Array(m).fill(0);
  for (let i = 0; i < y.length; i++) { idx[i % m] += y[i]; cnt[i % m]++; }
  const s = idx.map((v, i) => cnt[i] ? (v / cnt[i]) / o : 1); const avg = mean(s);
  return s.map(v => avg ? v / avg : 1);
}
// Winsorize a series to the [2nd, 95th] percentile — tames promo/outlier spikes so the level and
// trend fit the true baseline instead of chasing one-off days. Robust-stats accuracy win, universal.
function winsorize(a) {
  if (a.length < 5) return a.slice();
  const s = a.slice().sort((x, y) => x - y);
  const q = p => s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
  const lo = q(0.02), hi = q(0.95);
  return a.map(v => Math.max(lo, Math.min(hi, v)));
}
export function buildForecaster(demands, method, gap) {
  const n = demands.length;
  const cls = classifyDemand(demands);
  const w = winsorize(demands);                                  // robust series for level/trend fitting
  const maWin = (gap != null && gap < 2) ? Math.min(n, 14) : (gap != null && gap < 10) ? Math.min(n, 6) : Math.min(n, 3);
  const ma = mean(w.slice(-Math.max(1, maWin)));                 // window widens on noisy daily data
  let alpha = (gap != null && gap < 2) ? 0.25 : 0.4;             // smoother on daily, reactive on coarse
  // FIX(v13): on weekly/monthly series pick the smoothing weight that best predicted this SKU's own
  // history one period ahead, instead of one fixed weight for every SKU.
  if (process.env.LQ_ALPHA !== 'fixed' && gap != null && gap >= 2 && n >= 8) {
    let bestA = alpha, bestE = Infinity;
    for (const a0 of [0.1, 0.2, 0.3, 0.4, 0.6, 0.8]) { let l = w[0], e = 0; for (let i = 1; i < n; i++) { e += (w[i] - l) ** 2; l = a0 * w[i] + (1 - a0) * l; } if (e < bestE - 1e-9) { bestE = e; bestA = a0; } }
    alpha = bestA;
  }
  let lvl = w[0]; for (let i = 1; i < n; i++) lvl = alpha * w[i] + (1 - alpha) * lvl;
  // FIX(v12): anchor the level and slope on the recent regime. Fitting a 500-day
  // history whole puts the regression intercept a year in the past, which lags a
  // trending SKU and over-forecasts a declining one.
  const fitWin = Math.min(n, (gap != null && gap < 2) ? Math.max(56, Math.ceil(n * 0.25)) : Math.max(8, Math.ceil(n * 0.5)));
  const wr = w.slice(-fitWin);
  const { a, b } = linreg(wr); const lastFit = wr.length - 1; const last = n - 1;
  // FIX(v12): phi=0.9 on DAILY data kills the trend inside ~10 days, so a 60-day
  // forecast is effectively flat and a declining SKU never comes down. Tie the damping
  // to granularity: gentle per-day, firmer per-month.
  const phi = (gap != null && gap < 2) ? 0.985 : (gap != null && gap < 10) ? 0.95 : 0.9;
  const trendSum = k => { let s = 0; for (let i = 1; i <= k; i++) s += Math.pow(phi, i); return s; };
  const holt = k => Math.max(0, (a + b * lastFit) + b * trendSum(k));
  const seasCands = gap == null ? [12, 7, 4] : (gap < 2 ? [7] : gap < 10 ? [] : gap < 45 ? [12] : gap < 135 ? [4] : []);   // FIX(v10): seasonal period tied to granularity
  let season = null, m = 0; for (const c of seasCands) { const s = seasonalIndices(w, c); if (s) { season = s; m = c; break; } }

  // intermittent/lumpy → TSB regardless of chosen method (unless user forces one)
  if ((cls.pattern === 'intermittent' || cls.pattern === 'lumpy') && (method === 'Auto' || method === 'ML Ensemble')) {
    const t = tsbForecast(demands);
    return { f: () => t, slope: 0, level: t, ma, seasonal: false, pattern: cls.pattern, adi: cls.adi, cv2: cls.cv2 };
  }
  const base = {
    'Moving Average': () => ma,
    'Exponential Smoothing': () => Math.max(0, lvl),
    'Trend + Seasonality': k => holt(k),
    'ML Ensemble': k => Math.max(0, (ma + Math.max(0, lvl) + holt(k)) / 3),
  };
  let fn;
  if (method === 'Auto' || !base[method]) {
    // FIX(v12): the gate compared a PER-PERIOD slope to the level, so on daily data a
    // genuine 4%/month decline scores 0.0014 and never trips 0.05 — the trend model was
    // unreachable on exactly the granularity most sellers upload. Measure the slope's
    // effect across the fitted window instead.
    const slopeShare = ma > 0 ? Math.abs(b * Math.max(1, wr.length - 1)) / ma : 0;
    // strong sustained trend → damped Holt (weighted with the level); otherwise a robust 3-way ensemble
    // (MA + smoothing level + damped Holt) — ensembling cuts model-selection risk and lowers error.
    // FIX(v12): weight the trend model by how pronounced the trend actually is. A fixed
    // 0.6/0.4 blend held a declining SKU up (the level term carries no trend) and clipped
    // the climb on a growing one. Ramps 0.6 -> 0.85 as the fitted move grows.
    if (n >= 6 && slopeShare > 0.05) {
      const wHolt = Math.min(0.85, 0.6 + 0.5 * Math.min(0.5, slopeShare - 0.05));
      fn = k => Math.max(0, wHolt * holt(k) + (1 - wHolt) * Math.max(0, lvl));
    }
    else if (n >= 4) fn = k => Math.max(0, (ma + Math.max(0, lvl) + holt(k)) / 3);
    else fn = (n >= 2) ? () => Math.max(0, lvl) : () => ma;
  } else fn = base[method];
  if (season) { const bf = fn; fn = k => bf(k) * season[(last + k) % m]; }
  return { f: k => Math.max(0, fn(k)), slope: b, level: Math.max(0, lvl), ma, seasonal: !!season, pattern: cls.pattern, adi: cls.adi, cv2: cls.cv2 };
}
// rolling-origin back-test → WMAPE (primary), bias, MASE
export function backtest(demands, method, gap) {
  const n = demands.length; if (n < 4) return { wmape: null, bias: null, mase: null, mape: null };
  let sAbs = 0, sAct = 0, sErr = 0, naiveAbs = 0, apeSum = 0, apeCnt = 0;
  const start = Math.max(3, Math.floor(n / 2));
  for (let t = start; t < n; t++) {
    const f = buildForecaster(demands.slice(0, t), method, gap).f(1);
    const act = demands[t];
    sAbs += Math.abs(f - act); sAct += Math.abs(act); sErr += (f - act);
    naiveAbs += Math.abs(demands[t - 1] - act);
    if (act > 0) { apeSum += Math.abs(f - act) / act; apeCnt++; }
  }
  return {
    wmape: sAct > 0 ? Math.round((sAbs / sAct) * 100) : null,
    bias: sAct > 0 ? Math.round((sErr / sAct) * 100) : null,
    mase: naiveAbs > 0 ? Math.round((sAbs / naiveAbs) * 100) / 100 : null,
    mape: apeCnt ? Math.round((apeSum / apeCnt) * 100) : null,
  };
}
function demandOverDays(fc, D, gap, dayMult) {
  let total = 0, used = 0, k = 1;
  while (used < D && k < 5000) {
    const days = Math.min(gap, D - used);
    let seg = 1; if (dayMult) { let sm = 0; for (let d = 0; d < days; d++) sm += dayMult(used + d); seg = days ? sm / days : 1; }
    total += fc.f(k) * (days / gap) * seg; used += days; k++;
  }
  return Math.max(0, Math.round(total));
}

// ═══ v13: REGULAR CALENDAR, HORIZON BACK-TEST, CALIBRATED SAFETY STOCK ════════
// FIX(v13): the forecaster used to run on whatever dates happened to be in the file.
//  • Order reports only contain days WITH orders, so zero-sale days vanished: slow SKUs were
//    forecast from their selling days only (+33% on intermittent items) and a SKU that stopped
//    selling kept being forecast as live, because its series simply ended at its last sale.
//  • Seasonal positions were taken as "array index mod m", which is only right on a gap-free series.
//  • Daily data was modelled day by day, so tomorrow's weekday effect leaked into daily velocity,
//    and the back-test re-fitted every model once per day (a 1,000-SKU file timed out on Vercel).
// Now every dated SKU is placed on one calendar: daily rows are summed into weeks that END on the
// file's last date (no part-week at the end), weekly/monthly rows keep their own step, missing
// periods are zero sales, and stockout periods are filled from neighbours instead of counted as 0.
const DAYMS = 86400000;
function dayNum(iso) { const t = Date.parse(iso); return isNaN(t) ? NaN : Math.round(t / DAYMS); }
function monthIdx(day) { const d = new Date(day * DAYMS); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }

export function detectGrid(skuMap, today) {
  const ds = new Set();
  for (const s of Object.values(skuMap)) for (const p of (s.periods || [])) { const d = dayNum(p.period); if (isFinite(d)) ds.add(d); }
  if (ds.size < 3) return null;
  const arr = [...ds].sort((a, b) => a - b), g = [];
  for (let i = 1; i < arr.length; i++) g.push(arr[i] - arr[i - 1]);
  const med = median(g), endDay = arr[arr.length - 1];
  const todayDay = Math.floor(today.getTime() / DAYMS);
  if (med <= 4) return { kind: 'day', gap: 7, endDay };
  if (med <= 10) return { kind: 'week', gap: 7, endDay };
  if (med >= 25 && med <= 35) return { kind: 'month', gap: 30.4375, endDay, endMonth: monthIdx(endDay), dropLast: monthIdx(endDay) === monthIdx(todayDay) };
  return null;   // quarterly / irregular: keep the original per-SKU path
}

// FIX(v13): files with no stock column (order reports) can't show stockouts, so a fortnight with
// no orders on a SKU that sells 30 a day reads as a fortnight of zero demand. A run of zero
// periods that pure chance would almost never produce anywhere in the history at the surrounding
// sales rate (rate × run length ≥ ln(20 × periods), i.e. < 5% chance over the whole file) is
// treated as "unavailable" instead. Runs touching the
// end of the file are left alone: there, a stockout and a discontinued item look the same.
export function markImpliedStockouts(u, out, win) {
  const n = u.length; let i = 0;
  // a long history has many places a chance gap could appear, so the bar rises with its length
  const thr = Math.max(4.6, Math.log(20 * n));
  while (i < n) {
    if (u[i] > 0 || out[i]) { i++; continue; }
    let j = i; while (j + 1 < n && u[j + 1] === 0 && !out[j + 1]) j++;
    const L = j - i + 1;
    if (j < n - 1 && i > 0 && L >= 2) {
      const ctx = [];
      for (let k = Math.max(0, i - win); k < i; k++) if (!out[k]) ctx.push(u[k]);
      for (let k = j + 1; k <= Math.min(n - 1, j + win); k++) if (!out[k]) ctx.push(u[k]);
      const lam = ctx.length >= 4 ? mean(ctx) : 0;
      if (lam >= 0.5 && lam * L >= thr) for (let k = i; k <= j; k++) out[k] = true;
    }
    i = j + 1;
  }
}

const BT_METHODS = ['Auto', 'Trend + Seasonality', 'ML Ensemble', 'Exponential Smoothing', 'Moving Average'];

export function prepSeries(s, grid, cfg, map) {
  const pts = (s.periods || []).map(p => ({ d: dayNum(p.period), units: p.units, out: !!p.stockout })).filter(p => isFinite(p.d)).sort((a, b) => a.d - b.d);
  if (!pts.length) return null;
  const hasStock = map.available !== undefined || map.stockoutFlag !== undefined || map.inStockDays !== undefined || map.availMins !== undefined;
  let units = [], known = [], implied = 0;
  if (grid.kind === 'day') {
    const first = pts[0].d, nB = Math.floor((grid.endDay - first + 1) / 7);   // complete weeks only
    if (nB < 1) return null;
    units = new Array(nB).fill(0); const outDays = new Array(nB).fill(0);
    const byDay = new Map(pts.map(p => [p.d, p]));
    const d0 = grid.endDay - nB * 7 + 1, nD = nB * 7;
    const dayU = new Array(nD).fill(0), dayOut = new Array(nD).fill(false);
    let lastOut = false;
    for (let i = 0; i < nD; i++) {
      const p = byDay.get(d0 + i);
      if (p) { lastOut = p.out; if (p.out) dayOut[i] = true; else dayU[i] = p.units; }
      else if (hasStock && lastOut) dayOut[i] = true;     // no row after a stocked-out day: still out
    }
    if (!hasStock) { const before = dayOut.filter(Boolean).length; markImpliedStockouts(dayU, dayOut, 28); implied = dayOut.filter(Boolean).length - before; }
    for (let i = 0; i < nD; i++) { const b = Math.floor(i / 7); if (dayOut[i]) outDays[b]++; else units[b] += dayU[i]; }
    for (let b = 0; b < nB; b++) units[b] = Math.max(0, units[b]);
    for (let b = 0; b < nB; b++) {
      const inDays = 7 - outDays[b];
      if (inDays < 2.1) { known.push(false); units[b] = 0; }          // < 30% of the week in stock: can't learn from it
      else { known.push(true); if (inDays < 7) units[b] = units[b] * 7 / inDays; }
    }
  } else {
    const idxOf = grid.kind === 'week' ? (d => Math.round((grid.endDay - d) / 7)) : (d => grid.endMonth - monthIdx(d));
    const nB = idxOf(pts[0].d) + 1;
    if (nB < 1) return null;
    units = new Array(nB).fill(0); const out = new Array(nB).fill(null);
    for (const p of pts) { const b = nB - 1 - idxOf(p.d); if (b < 0 || b >= nB) continue; if (p.out) out[b] = out[b] === null ? true : out[b]; else { units[b] += p.units; out[b] = false; } }
    let lastOut = false;
    for (let b = 0; b < nB; b++) { if (out[b] === null) out[b] = hasStock && lastOut; lastOut = out[b]; }
    if (!hasStock) { const o = out.map(Boolean), before = o.filter(Boolean).length; markImpliedStockouts(units, o, grid.kind === 'week' ? 6 : 3); implied = o.filter(Boolean).length - before; for (let b = 0; b < nB; b++) out[b] = o[b]; }
    for (let b = 0; b < nB; b++) { known.push(!out[b]); units[b] = out[b] ? 0 : Math.max(0, units[b]); }
    if (grid.dropLast && units.length > 1) { units.pop(); known.pop(); }   // the current month is not over yet
  }
  // fill unknown (stocked-out) periods with the average of the nearest known ones
  const demands = units.slice();
  for (let i = 0; i < demands.length; i++) {
    if (known[i]) continue;
    const near = []; for (let j = i - 1; j >= 0 && near.length < 4; j--) if (known[j]) near.push(units[j]);
    if (!near.length) for (let j = i + 1; j < demands.length && near.length < 4; j++) if (known[j]) near.push(units[j]);
    demands[i] = near.length ? mean(near) : 0;
  }
  // launch: drop the run of (near-)zero periods before the item really started selling
  let start = 0;
  const fs = demands.findIndex(v => v > 0);
  if (fs < 0) return { kind: grid.kind, gap: grid.gap, demands: [], known: [], dead: true, fc: { f: () => 0 }, implied };
  start = fs;
  const n0 = demands.length - start;
  if (n0 >= 16) {
    const recent = mean(demands.slice(-Math.min(26, n0)));
    for (let t = start; t + 4 <= demands.length; t++) if (mean(demands.slice(t, t + 4)) >= 0.25 * recent) { if (t - start >= 8 && mean(demands.slice(start, t)) < 0.1 * recent) start = t; break; }
  }
  const y = demands.slice(start), kn = known.slice(start);
  const gap = grid.gap, kindM = grid.kind === 'month';
  // dead / no recent demand: nothing sold for a long stretch that was NOT a stockout
  const cls = classifyDemand(y);
  const quiet = Math.max(kindM ? 3 : 8, Math.ceil(3 * (isFinite(cls.adi) ? cls.adi : 1)));
  let tailZero = 0; for (let i = y.length - 1; i >= 0 && y[i] === 0 && kn[i]; i--) tailZero++;
  const dead = y.length > quiet && tailZero >= quiet;
  // method choice + accuracy on horizon TOTALS (what the order is sized on), not next-period error
  const hP = Math.max(1, Math.min(kindM ? 3 : 13, Math.round((cfg.horizDays || 90) / gap)));
  const lt = s.leadTime > 0 ? s.leadTime : (cfg.qcom ? 2 : 30);
  const W = Math.max(1, Math.min(hP, Math.ceil(lt / gap)));
  const minTrain = kindM ? 6 : 8, step = Math.max(1, Math.floor(hP / 3));
  const origins = []; for (let k = 0; k < 6; k++) { const o = y.length - hP - k * step; if (o >= minTrain) origins.push(o); }
  const score = (m, idxs) => { let a = 0, act = 0; for (const i of idxs) { a += m.per[i].abs; act += m.per[i].act; } return act > 0 ? a / act : (a > 0 ? Infinity : 0); };
  let chosen = cfg.method, bt = null;
  const methods = (cfg.method === 'Auto') ? BT_METHODS : [cfg.method];
  if (origins.length && !dead) {
    const res = {};
    for (const m of methods) {
      const per = [], errs = [], cum = [];
      for (let oi = 0; oi < origins.length; oi++) {
        const o = origins[oi], fcm = buildForecaster(y.slice(0, o), m, gap);
        let F = 0, A = 0, ok = true, c = 0, cOk = true;
        for (let h = 1; h <= hP; h++) {
          const f = fcm.f(h), a = y[o + h - 1];
          if (!kn[o + h - 1]) { ok = false; if (h <= W) cOk = false; continue; }
          F += f; A += a; errs.push(f - a); if (h <= W) c += f - a;
        }
        per.push({ abs: ok ? Math.abs(F - A) : 0, act: ok ? A : 0, err: ok ? F - A : 0, naive: ok ? Math.abs(y[o - 1] * hP - A) : 0, ape: ok && A > 0 ? Math.abs(F - A) / A : null });
        if (cOk) cum.push({ e: c, W, oi });
      }
      res[m] = { per, errs, cum };
    }
    const sel = origins.length >= 2 ? origins.map((_, i) => i).slice(1) : [0];
    if (cfg.method === 'Auto') {
      let best = null;
      for (const m of methods) { const w = score(res[m], sel); if (!isFinite(w)) continue; if (!best || w < best.w - 0.005) best = { m, w }; }
      if (best) chosen = best.m;
    }
    const R = res[chosen], all = origins.map((_, i) => i);
    const tot = all.reduce((a, i) => ({ abs: a.abs + R.per[i].abs, act: a.act + R.per[i].act, err: a.err + R.per[i].err, nv: a.nv + R.per[i].naive }), { abs: 0, act: 0, err: 0, nv: 0 });
    const apes = R.per.map(p => p.ape).filter(v => v != null);
    const rmse = R.errs.length ? Math.sqrt(R.errs.reduce((a, e) => a + e * e, 0) / R.errs.length) : null;
    bt = { wmape: tot.act > 0 ? Math.round(100 * tot.abs / tot.act) : null, bias: tot.act > 0 ? Math.round(100 * tot.err / tot.act) : null,
      mase: tot.nv > 0 ? Math.round(100 * tot.abs / tot.nv) / 100 : null, mape: apes.length ? Math.round(100 * mean(apes)) : null,
      honest: R.per[0], rmse, cum: R.cum, hP, origins: origins.length };
  }
  const fc = dead ? { f: () => 0, slope: 0, level: 0, ma: 0, seasonal: false, pattern: 'no recent demand', adi: cls.adi, cv2: cls.cv2 } : buildForecaster(y, chosen, gap);
  return { kind: grid.kind, gap, demands: y, known: kn, dead, method: chosen, fc, bt, W, launched: start > fs, implied };
}

// FIX(v13): safety stock was z·σ(daily demand)·√LT, which assumes every day's error is
// independent. Forecast errors are not: a level that is off stays off for the whole lead time,
// and on test data the reorder point covered lead-time demand only 77% of the time at a 95%
// target. Measure, on this file's own back-test, how large the buffer would have had to be, and
// scale the √LT formula by that factor (fitted on older windows, checked on the newest).
export function calibrateSafetyStock(skuList, cfg) {
  let sl = cfg.serviceLevel || (cfg.qcom ? 0.98 : 0.95); if (sl > 1) sl /= 100;
  const fit = [], chk = [];
  for (const s of skuList) {
    const T = s._ts; if (!T || !T.bt || T.dead) continue;
    const meanF = mean(T.demands.slice(-Math.min(13, T.demands.length)));
    const sig = Math.max(T.bt.rmse || 0, Math.sqrt(Math.max(0, meanF)));
    if (!(sig > 0)) continue;
    for (const c of T.bt.cum) { const k = Math.max(0, -c.e) / (sig * Math.sqrt(c.W)); (c.oi >= 1 ? fit : chk).push(k); }
  }
  if (fit.length < 30) return null;
  const z = Math.max(0.5, zForService(sl));
  const ks = fit.slice().sort((a, b) => a - b);
  const kq = ks[Math.min(ks.length - 1, Math.ceil(sl * ks.length) - 1)];
  const mult = Math.max(1, Math.min(6, (kq / z) ** 2));
  const cover = arr => arr.length ? arr.filter(k => k <= z * Math.sqrt(mult)).length / arr.length : null;
  return { mult, fitSamples: fit.length, checkSamples: chk.length, coverageFit: cover(fit), coverageCheck: cover(chk), serviceLevel: sl };
}

function demandOverDaysRaw(fc, D, gap, dayMult) {
  let total = 0, used = 0, k = 1;
  while (used < D - 1e-9 && k < 5000) {
    const days = Math.min(gap, D - used);
    let seg = 1; if (dayMult) { let sm = 0, cnt = 0; for (let d = 0; d < Math.ceil(days); d++) { sm += dayMult(Math.floor(used) + d); cnt++; } seg = cnt ? sm / cnt : 1; }
    total += fc.f(k) * (days / gap) * seg; used += days; k++;
  }
  return Math.max(0, total);
}

// ═══ SERVICE LEVEL → z ═══════════════════════════════════════════════════════
function zForService(sl) {
  if (sl > 1) sl = sl / 100;   // FIX(v10): accept 95 as 0.95
  const T = [[0.50, 0.00], [0.80, 0.84], [0.85, 1.04], [0.90, 1.28], [0.95, 1.65], [0.97, 1.88], [0.98, 2.05], [0.99, 2.33], [0.995, 2.58]];
  let z = 0; for (const [p, v] of T) if (sl >= p) z = v; return z;   // FIX(v10): sub-0.80 no longer silently 95%
}

// ═══ COMPUTE ENGINE ══════════════════════════════════════════════════════════
export function computeSKU(s, isTS, today, cfg, map, catStats) {
  const qcom = cfg.qcom, applyFestival = cfg.applyFestival;
  const lt = s.leadTime > 0 ? s.leadTime : (qcom ? 2 : 30);
  const catBucket = classifyCategory(s.category);
  const dayMult = off => applyFestival ? indiaDayMultiplier(addDays(today, off), catBucket, qcom) : 1;
  const unitCost = s.cost > 0 ? s.cost : (s.price || 0);
  const sellPrice = s.price > 0 ? s.price : unitCost;
  const marginPerUnit = (s.price > 0 && s.cost > 0) ? Math.round((sellPrice - unitCost) * 100) / 100 : 0;
  const sl = cfg.serviceLevel || (qcom ? 0.98 : 0.95);
  const z = zForService(sl);

  let dailyVel = 0, avgMonthly = 0, trend = 'flat', trendPct = 'n/a', conf = 'Low';
  let mape = null, wmape = null, bias = null, mase = null, sigmaDaily = 0;
  let periodGranularity = isTS ? 'unknown' : 'snapshot';
  let pattern = 'n/a', fc = null, gap = 30, censored = false, tsDemands = null;

  const censorShare = s.totalObs > 0 ? s.censoredObs / s.totalObs : 0;

  if (s._ts && s._ts.demands) {
    // FIX(v13): regular-calendar path (see prepSeries). Velocity is the average of the next four
    // weeks, not "next period ÷ gap", so one weekday's or month's effect can't swing every number.
    const T = s._ts;
    gap = T.gap; fc = T.fc; tsDemands = T.demands.length ? T.demands : null;
    periodGranularity = T.kind === 'day' ? 'daily' : gapLabel(gap);
    if (s.periods.some(p => p.stockout) || T.known.some(k => !k)) censored = true;
    const demands = T.demands, n = demands.length, pm = mean(demands);
    avgMonthly = T.dead ? 0 : Math.round(pm * (30 / gap) * 10) / 10;
    if (n >= 4) { const { b } = linreg(demands); const pct = pm > 0 ? (b * (n - 1) / pm) * 100 : 0; trend = pct > 8 ? 'up' : pct < -8 ? 'down' : 'flat'; trendPct = (pct >= 0 ? '+' : '') + Math.round(pct) + '%'; }
    pattern = T.dead ? 'no recent demand' : (fc.pattern || 'n/a');
    if (cfg.method === 'Auto' && T.method && T.method !== 'Auto' && !T.dead) pattern = pattern + ' · ' + T.method;
    if (T.bt) { wmape = T.bt.wmape; bias = T.bt.bias; mase = T.bt.mase; mape = T.bt.mape; }
    dailyVel = demandOverDaysRaw(fc, 28, gap, null) / 28;
    const perPeriod = dailyVel * gap;
    const sigP = Math.max(T.bt && T.bt.rmse ? T.bt.rmse : std(demands), Math.sqrt(Math.max(0, perPeriod)));   // never below pure chance
    sigmaDaily = T.dead ? 0 : sigP / Math.sqrt(gap);
    conf = T.dead ? 'Low (no recent sales)' : (wmape != null ? (wmape <= 20 ? 'High' : wmape <= 40 ? 'Medium' : 'Low') : (n >= 4 ? 'Medium' : 'Low'));
  } else if (isTS && s.periods.length >= 2) {
    const usable = s.periods.filter(p => !p.stockout);            // stockout days excluded so they don't deflate demand
    const demands0 = (usable.length >= 2 ? usable : s.periods).map(p => Math.max(0, p.units));
    // FIX(v12): LAUNCH DETECTION. A SKU that went live part-way through the export
    // carries a long run of leading zeros. Left in place the series classifies as
    // 'intermittent' and TSB forecasts ~0, so a newly launched product is told to
    // stock nothing. Trim the pre-launch zeros when demand has been sustained since.
    let preLaunchZeros = 0, launched = false;
    {
      const fsIdx = demands0.findIndex(v => v > 0);
      if (fsIdx > 0) {
        const tail = demands0.slice(fsIdx);
        const nzShare = tail.length ? tail.filter(v => v > 0).length / tail.length : 0;
        if (nzShare >= 0.5 && fsIdx >= Math.max(5, 0.08 * demands0.length)) { preLaunchZeros = fsIdx; launched = true; }
      }
    }
    const demands = launched ? demands0.slice(preLaunchZeros) : demands0;
    if (s.periods.some(p => p.stockout)) censored = true;
    tsDemands = demands;   // GOD-MODE: retained for probabilistic quantile band
    const n = demands.length; gap = detectGapDays(usable.length >= 2 ? usable : s.periods); periodGranularity = gapLabel(gap);
    const pm = mean(demands);
    avgMonthly = Math.round(pm * (30 / gap) * 10) / 10;
    if (n >= 4) { const { b } = linreg(demands); const pct = pm > 0 ? (b * (n - 1) / pm) * 100 : 0; trend = pct > 8 ? 'up' : pct < -8 ? 'down' : 'flat'; trendPct = (pct >= 0 ? '+' : '') + Math.round(pct) + '%'; }
    // FIX(v12): "Auto (AI selects best)" was a hand-written heuristic on the slope, and it
    // lost to plain "Trend + Seasonality" on ordinary daily data. The rolling-origin
    // back-test already in this file is a better judge, so let Auto actually select:
    // score every candidate out-of-sample and keep the lowest WMAPE.
    let chosenMethod = cfg.method;
    if (cfg.method === 'Auto' && demands.length >= 12) {
      const cands = ['Auto', 'Trend + Seasonality', 'ML Ensemble', 'Exponential Smoothing', 'Moving Average'];
      let best = null;
      for (const m of cands) {
        const r = backtest(demands, m, gap);
        if (r.wmape == null) continue;
        if (!best || r.wmape < best.wmape - 0.5) best = { m, wmape: r.wmape };
      }
      if (best) chosenMethod = best.m;
    }
    fc = buildForecaster(demands, chosenMethod, gap); pattern = fc.pattern;
    const bt = backtest(demands, chosenMethod, gap); mape = bt.mape; wmape = bt.wmape; bias = bt.bias; mase = bt.mase;
    if (cfg.method === 'Auto' && chosenMethod !== 'Auto') pattern = pattern + ' · ' + chosenMethod;
    dailyVel = fc.f(1) / gap;
    sigmaDaily = std(demands) / Math.sqrt(gap);   // FIX(v10): period sigma -> daily scales by sqrt(gap), not gap
    conf = wmape != null ? (wmape <= 20 ? 'High' : wmape <= 40 ? 'Medium' : 'Low') : (n >= 4 ? 'Medium' : 'Low');
  } else {
    // snapshot mode
    let baseDaily = s.dailyVelocity > 0 ? s.dailyVelocity : (s.netUnits > 0 ? s.netUnits / cfg.salesWindow : 0);
    // stockout unconstraining for snapshot (netUnits already net of returns)
    if (censorShare > 0.05 && baseDaily > 0) baseDaily = baseDaily / Math.max(0.2, 1 - censorShare);
    // cold-start: no sales but known category → seed from category median
    let coldStart = false;
    if (baseDaily <= 0) {
      if (s.oosFlag) { censored = true; }                         // out of stock → demand unknown (not new, not dead)
      else {
        // FIX(v12): don't seed a dead SKU as a new one. In snapshot mode there is no
        // history to tell them apart, but stock on hand does: a product sitting on
        // inventory that sold nothing is dead, and seeding it from the category median
        // tells the seller to reorder a product that is not moving.
        const looksDead = (s.available > 0 || s.stock > 0) && !s.oosFlag;
        const cm = catStats[catBucket];
        if (cm > 0 && !looksDead) { baseDaily = cm * 0.5; coldStart = true; }
      }
    }
    const base30 = baseDaily * 30;
    const g = (s.momTrend != null && isFinite(s.momTrend)) ? Math.max(-0.3, Math.min(0.3, s.momTrend)) : 0;
    const seas = (s.seasonalIndex != null && s.seasonalIndex > 0) ? Math.max(0.4, Math.min(2.5, s.seasonalIndex)) : 1;
    fc = { f: k => base30 * seas * Math.min(3, Math.pow(1 + g, Math.min(k - 1, 6))) };
    avgMonthly = Math.round(base30 * 10) / 10;
    dailyVel = fc.f(1) / 30; sigmaDaily = Math.max(dailyVel * 0.4, Math.sqrt(dailyVel));   // FIX(v13): not below pure chance
    trend = g > 0.02 ? 'up' : g < -0.02 ? 'down' : 'flat';
    trendPct = s.momTrend != null ? ((g >= 0 ? '+' : '') + Math.round(g * 100) + '%/mo') : 'n/a';
    censored = censored || censorShare > 0.05 || (baseDaily === 0 && censorShare > 0);
    conf = coldStart ? 'Cold-start (category est.)' : (baseDaily > 0 ? (s.momTrend != null || s.seasonalIndex != null ? 'File trend/season' : 'Velocity-based') : (censored ? 'Stockout-censored (out of stock)' : 'Low (no sales)'));
    pattern = baseDaily > 0 ? 'snapshot' : 'no-demand';
  }

  const nextH = demandOverDays(fc, cfg.horizDays, gap, dayMult);
  const next30 = demandOverDays(fc, 30, gap, dayMult);
  const next60 = demandOverDays(fc, 60, gap, dayMult);
  const next90 = demandOverDays(fc, 90, gap, dayMult);
  // GOD-MODE: probabilistic band (P50/P90/P95) around the horizon point forecast, centred on nextH.
  let forecastQuantiles = null;
  if (tsDemands && tsDemands.length >= 3) {
    const _qf = quantileForecast(tsDemands, { gap, horizonDays: cfg.horizDays, centre: nextH, pattern });
    forecastQuantiles = { p50: _qf.p50, p90: _qf.p90, p95: _qf.p95, dist: _qf.dist };
  }

  let seasonalUplift = 1, nearMult = 1, peakEvent = null;
  if (applyFestival) {
    let hs = 0; for (let d = 0; d < cfg.horizDays; d++) hs += dayMult(d); seasonalUplift = cfg.horizDays ? Math.round(hs / cfg.horizDays * 100) / 100 : 1;
    const win = Math.max(lt, qcom ? 7 : 14); let ns = 0; for (let d = 0; d < win; d++) ns += dayMult(d); nearMult = win ? Math.round(ns / win * 100) / 100 : 1;
    peakEvent = peakEventInWindow(today, cfg.horizDays, catBucket, qcom);
  }
  const effVel = dailyVel * nearMult;

  const currentStock = s.available || 0;
  const netStock = currentStock + (s.inbound || 0) - (s.reserved || 0);
  const daysOfCover = effVel > 0 ? Math.round(Math.max(0, netStock) / effVel) : (netStock > 0 ? 999 : 0);

  // safety stock with demand + lead-time variability
  // FIX(v13): the demand term is scaled by the calibration factor measured on this file
  // (cfg._ltMult, see calibrateSafetyStock), and lead-time and horizon demand now come from the
  // same forecast (incl. festive days) the dashboard shows, instead of near-term velocity × days.
  const sigmaLT = s.leadTimeVar > 0 ? s.leadTimeVar : 0;
  const ltM = s._ts ? (cfg._ltMult || 1) : 1;
  const ssCalc = Math.ceil(z * Math.sqrt(lt * sigmaDaily ** 2 * ltM + (effVel ** 2) * (sigmaLT ** 2)));
  const safetyStock = s.safetyStock > 0 ? s.safetyStock : ssCalc;
  const ltDemand = s._ts ? demandOverDaysRaw(fc, lt, gap, dayMult) : effVel * lt;
  const reorderPoint = s.reorderPoint > 0 ? s.reorderPoint : Math.ceil(ltDemand + safetyStock);
  const target = s._ts ? Math.ceil(demandOverDaysRaw(fc, cfg.horizDays + lt, gap, dayMult) + safetyStock) : Math.ceil(effVel * (cfg.horizDays + lt) + safetyStock);
  const orderQty = s.reorderQty > 0 ? s.reorderQty : Math.max(0, target - Math.max(0, netStock));

  let reorderBy = 'OK';
  if (currentStock === 0 && !s.inbound && dailyVel > 0) reorderBy = 'REORDER NOW';
  else { const d2r = Math.max(0, daysOfCover - lt);
    if (d2r <= 0 && dailyVel > 0) reorderBy = 'REORDER NOW';
    else if (d2r <= 7 && dailyVel > 0) reorderBy = 'This Week';
    else if (dailyVel > 0) { const d = addDays(today, d2r); reorderBy = d.toLocaleDateString('en-GB'); }
  }
  let priority = 'LOW';
  if (currentStock === 0 && !s.inbound && dailyVel > 0) priority = 'URGENT';
  else if (daysOfCover < lt && dailyVel > 0) priority = 'HIGH';
  else if (daysOfCover < lt * 2 && dailyVel > 0) priority = 'MEDIUM';

  const stockoutDays = effVel > 0 ? Math.min(999, Math.round(Math.max(0, netStock) / effVel)) : 999;
  let stockoutProb = 0;
  if (dailyVel > 0) { const muLT = ltDemand, sdLT = Math.max(1e-6, Math.sqrt(lt * sigmaDaily ** 2 * ltM + (effVel ** 2) * (sigmaLT ** 2))); stockoutProb = Math.max(0, Math.min(100, Math.round(100 * (1 - normalCdf((Math.max(0, netStock) - muLT) / sdLT))))); }
  const revenueAtRisk = effVel > 0 && sellPrice > 0 ? Math.round(Math.max(0, cfg.horizDays - stockoutDays) * effVel * sellPrice * (stockoutProb / 100)) : 0;
  const invValue = Math.round(currentStock * unitCost);

  const isActive = avgMonthly > 0.05;
  const isSlowMover = dailyVel > 0 && dailyVel < 1 && currentStock > 30;
  const isDead = dailyVel === 0 && currentStock > 0 && !censored;   // censored ≠ dead
  const isOverstock = daysOfCover > 120 && isActive;
  const isHealthy = !isDead && !isOverstock && daysOfCover >= 30 && daysOfCover <= 120 && isActive;
  const fillRate = avgMonthly > 0 ? Math.min(100, Math.round((Math.min(currentStock, avgMonthly) / avgMonthly) * 100)) : (currentStock > 0 ? 100 : 0);
  const invTurnover = currentStock > 0 ? Math.round((avgMonthly * 12 / currentStock) * 10) / 10 : 0;
  const excessValue = dailyVel > 0 ? Math.round(Math.max(0, daysOfCover - 90) * dailyVel * unitCost) : 0;

  return {
    sku: s.sku, product: s.product, category: s.category, brand: s.brand,
    warehouse: s.warehouse, warehouseCount: s.warehouseCount || 1, channel: s.channel, city: s.city, uom: s.uom,
    price: sellPrice, unitCost, marginPerUnit, currentStock, inbound: s.inbound || 0, reserved: s.reserved || 0, netStock,
    grossUnits: Math.round(s.grossUnits), returnUnits: Math.round(s.returnUnits), returnRate: Math.round(s.returnRate * 100),
    avgMonthlyDemand: Math.round(avgMonthly), dailyVelocity: Math.round(dailyVel * 100) / 100,
    festiveDailyVelocity: Math.round(effVel * 100) / 100, seasonalUplift, nearTermUplift: nearMult, peakEvent, categoryBucket: catBucket,
    nextH, next30, next60, next90, forecastQuantiles, trend, trendPct, confidence: conf,
    demandPattern: pattern, censored, mape, wmape, bias, mase,
    impliedStockoutPeriods: s._ts ? (s._ts.implied || 0) : 0,
    btAbs: s._ts && s._ts.bt && s._ts.bt.honest ? Math.round(s._ts.bt.honest.abs * 100) / 100 : 0,
    btAct: s._ts && s._ts.bt && s._ts.bt.honest ? Math.round(s._ts.bt.honest.act * 100) / 100 : 0,
    btErr: s._ts && s._ts.bt && s._ts.bt.honest ? Math.round(s._ts.bt.honest.err * 100) / 100 : 0,
    periodGranularity, forecastMethod: cfg.method,
    daysOfCover, weeksOfSupply: Math.round(daysOfCover / 7 * 10) / 10, safetyStock, reorderPoint,
    eoq: orderQty, orderQty, reorderBy, priority, leadTimeDays: lt, serviceLevel: Math.round(sl * 100),
    needsReorder: orderQty > 0 && isActive, stockoutDays, stockoutProb, revenueAtRisk, invValue,
    isSlowMover, isDead, isOverstock, isHealthy, isActive, invTurnover, fillRate, excessValue,
    slowMoverRisk: invValue > 5000 ? 'HIGH' : invValue > 1000 ? 'MEDIUM' : 'LOW',
    slowAction: invValue > 5000 ? 'Markdown / Bundle / Liquidate' : invValue > 1000 ? 'Hold — avoid reorder' : 'Monitor',
  };
}

function buildSummary(results, isTS, cfg, map, freshness = {}) {
  const active = results.filter(s => s.isActive);
  const w = active.filter(s => s.wmape != null);
  // FIX(v13): the headline accuracy was a SIMPLE average of per-SKU one-step (next-day) WMAPE.
  // On daily data that reads ~60% error even when the 60-day total is ~90% right, and a few tiny
  // SKUs dominate it. Report the volume-weighted error of horizon totals on the most recent
  // back-test window, which the method choice never saw. Falls back to the old average.
  const hw = results.filter(r => r.btAct > 0);
  const sAbs = hw.reduce((a, r) => a + r.btAbs, 0), sAct = hw.reduce((a, r) => a + r.btAct, 0), sErr = hw.reduce((a, r) => a + r.btErr, 0);
  const avgWmape = sAct > 0 ? Math.round(100 * sAbs / sAct) : (w.length ? Math.round(w.reduce((a, r) => a + r.wmape, 0) / w.length) : null);
  const avgBias = sAct > 0 ? Math.round(100 * sErr / sAct) : (w.length ? Math.round(w.reduce((a, r) => a + (r.bias || 0), 0) / w.length) : null);
  const mp = active.filter(s => s.mape != null);   // FIX(v10): real average MAPE (was WMAPE relabelled)
  const avgMape = mp.length ? Math.round(mp.reduce((a, r) => a + r.mape, 0) / mp.length) : null;
  const censoredN = results.filter(r => r.censored).length;
  const dataQuality = [];
  // FIX(v12): surface a stale file before anything else — it is the single biggest
  // silent source of a wrong forecast, and it looks like a model error to the user.
  if (freshness.originGapDays != null && freshness.originGapDays > 7) {
    const upTo = freshness.dataEnd ? freshness.dataEnd.toISOString().slice(0, 10) : 'unknown';
    dataQuality.unshift(`Your data ends ${upTo}, ${freshness.originGapDays} days ago, but the forecast starts today. The gap is not modelled${cfg.applyFestival ? ', and festive-sale uplift is being applied to a window your history has never seen' : ''}. Upload data up to yesterday, or expect the forecast to describe a different period than your file.`);
  }
  if (!isTS) dataQuality.push(`Snapshot file: sales treated as a ${cfg.salesWindow}-day figure. Set the correct Data Sales Period or daily numbers will be off. Upload dated rows for true trend/seasonality and back-tested accuracy.`);
  if (map.status === undefined && map.returns === undefined) dataQuality.push('No order-status or returns column detected — demand is gross of returns. Add one for net-demand accuracy.');
  if (map.stockoutFlag === undefined && map.availMins === undefined && map.inStockDays === undefined && map.daysOutOfStock === undefined && map.alert === undefined) {
    // FIX(v12): an on-hand quantity column is now used to infer stockouts on dated rows,
    // so only warn when there is genuinely nothing to go on.
    if (isTS && cfg._grid && map.available === undefined) dataQuality.push('No stock or stockout column — only gaps too long to be chance could be recognised as stockouts; shorter stockouts still read as low sales. Add a stock column for exact stockout handling.');
    else if (map.available === undefined || !isTS) dataQuality.push('No availability/stockout signal — stockout-suppressed demand cannot be reconstructed, so bestsellers that ran out may read low.');
    else dataQuality.push('No explicit stockout column — stockouts were inferred from dated rows where sellable stock was zero and nothing sold. Add a stockout flag for a firmer signal.');
  }
  if (map.alert !== undefined && censoredN) dataQuality.push(`${censoredN} SKU(s) flagged out-of-stock by the file's alert column — labelled demand-unknown rather than dead (add dated history to recover their true demand).`);
  if (censoredN) dataQuality.push(`${censoredN} SKU(s) had stockout-censored sales; their demand was reconstructed or flagged rather than counted as zero.`);
  if (map.price === undefined && map.cost === undefined) dataQuality.push('No price/cost column — revenue-at-risk and inventory value show 0.');
  if (map.leadTime === undefined) dataQuality.push(cfg.qcom ? 'No lead-time column — 2-day q-commerce lead time assumed.' : 'No lead-time column — 30-day lead time assumed.');
  if (cfg._grid && cfg._grid.kind === 'day') dataQuality.push(`Daily rows were grouped into weeks ending ${new Date(cfg._grid.endDay * 86400000).toISOString().slice(0, 10)} (a day with no rows counts as zero sales); weekly totals forecast far more reliably than single days.`);
  const impliedN = results.filter(r => r.impliedStockoutPeriods > 0).length;
  if (impliedN) dataQuality.push(`${impliedN} SKU(s) had long gaps with no sales that are very unlikely by chance at their normal rate; those gaps were treated as stockouts, not as zero demand. Add a stock column to make this exact.`);
  if (cfg._calib) dataQuality.push(`Safety stock is calibrated on your own history: across ${cfg._calib.fitSamples} past lead-time windows, the textbook buffer had to be ×${Math.sqrt(cfg._calib.mult).toFixed(2)} to reach ${Math.round(cfg._calib.serviceLevel * 100)}% service${cfg._calib.coverageCheck != null ? `; on the most recent windows it covered ${Math.round(cfg._calib.coverageCheck * 100)}%` : ''}.`);
  if (cfg.applyFestival) dataQuality.push('India festive calendar applied (per-year lunar dates incl. the Pitru-Paksha dip for muhurat categories).');
  const multiWh = results.filter(r => r.warehouseCount > 1).length;
  if (multiWh) dataQuality.push(`${multiWh} SKU(s) span multiple warehouses — stock summed across locations, sales summed across order lines.`);

  return {
    totalSKUs: results.length, activeSKUs: active.length,
    healthySKUs: results.filter(s => s.isHealthy).length,
    deadSKUs: results.filter(s => s.isDead).length,
    overstockSKUs: results.filter(s => s.isOverstock).length,
    slowMoverSKUs: results.filter(s => s.isSlowMover && !s.isDead).length,
    urgentSKUs: results.filter(s => s.priority === 'URGENT' || s.priority === 'HIGH').length,
    censoredSKUs: censoredN,
    // FIX(v12): expose the file's last date and how far the forecast origin sits from it,
    // so the UI can show which period the forecast actually describes.
    dataEndDate: freshness.dataEnd ? freshness.dataEnd.toISOString().slice(0, 10) : null,
    forecastOriginGapDays: freshness.originGapDays != null ? freshness.originGapDays : null,
    totalInvValue: results.reduce((a, r) => a + r.invValue, 0),
    totalAtRisk: results.reduce((a, r) => a + r.revenueAtRisk, 0),
    totalExcess: results.reduce((a, r) => a + r.excessValue, 0),
    avgDoC: active.length ? Math.round(active.reduce((a, r) => a + Math.min(r.daysOfCover, 365), 0) / active.length) : 0,
    isTS, erpSource: cfg.erpSource, planLevel: cfg.level, region: cfg.region,
    commerceType: cfg.qcom ? 'Quick Commerce' : 'E-Commerce', festivalMode: cfg.applyFestival,
    forecastMethod: cfg.method, periodGranularity: results.find(r => r.periodGranularity)?.periodGranularity || (isTS ? 'unknown' : 'snapshot'),
    forecastAccuracyWmape: avgWmape, forecastAccuracyMape: avgMape, forecastBias: avgBias,
    dataQuality, detectedColumns: Object.keys(map).join(', '),
  };
}

function buildGroups(results, level) {
  const keyMap = { Brand: 'brand', Category: 'category', Warehouse: 'warehouse', 'Dark Store': 'warehouse', City: 'city', Marketplace: 'channel', Country: 'channel' };
  const key = keyMap[level]; if (!key || level === 'SKU') return null;
  const g = {};
  for (const r of results) {
    const k = (r[key] && r[key] !== '—') ? r[key] : 'Unspecified';
    (g[k] = g[k] || { group: k, dimension: level, skus: 0, activeSKUs: 0, avgMonthlyDemand: 0, nextH: 0, invValue: 0, revenueAtRisk: 0, urgent: 0 });
    const e = g[k]; e.skus++; if (r.isActive) e.activeSKUs++; e.avgMonthlyDemand += r.avgMonthlyDemand; e.nextH += r.nextH; e.invValue += r.invValue; e.revenueAtRisk += r.revenueAtRisk; if (r.priority === 'URGENT' || r.priority === 'HIGH') e.urgent++;
  }
  return Object.values(g).map(e => ({ ...e, avgMonthlyDemand: Math.round(e.avgMonthlyDemand), nextH: Math.round(e.nextH), invValue: Math.round(e.invValue), revenueAtRisk: Math.round(e.revenueAtRisk) })).sort((a, b) => b.nextH - a.nextH).slice(0, 60);
}

// ═══ INDIA FESTIVE CALENDAR — PER-YEAR LUNAR DATES ═══════════════════════════
// Verified for 2026 (this build). Update the movable dates each year from a
// panchang; civic dates are added automatically for every year.
const QCOM_CHANNELS = ['Blinkit', 'Zepto', 'Swiggy Instamart', 'Instamart', 'BigBasket', 'BBNow', 'Flipkart Minutes', 'Amazon Fresh', 'Zepto Cafe', 'Dunzo', 'JioMart'];
// direction: +1 uplift, -1 dip. cats override base for a category bucket.
const MOVABLE = {
  2025: [
    { key: 'rakhi', name: 'Raksha Bandhan', s: [8, 5], e: [8, 9], base: 1.5, cats: { gifting: 2.2, fashion: 1.7, jewellery: 1.8 } },
    { key: 'onam', name: 'Onam', s: [8, 26], e: [9, 5], base: 1.4, cats: { fashion: 1.8, home: 1.7, fmcg: 1.5, jewellery: 1.9 } },
    { key: 'ganesh', name: 'Ganesh Chaturthi', s: [8, 27], e: [9, 6], base: 1.4, cats: { fmcg: 1.6, gifting: 1.7 } },
    { key: 'pitru', name: 'Pitru Paksha (inauspicious)', s: [9, 7], e: [9, 21], base: 0.9, dip: true, cats: { jewellery: 0.7, appliances: 0.8, home: 0.85, mobiles: 0.9 } },
    { key: 'bbd', name: 'Big Billion Days / Great Indian Festival', s: [9, 22], e: [10, 5], base: 3.0, cats: { mobiles: 5.0, electronics: 4.5, appliances: 4.0, fashion: 3.0, footwear: 2.8, beauty: 2.5, home: 2.6 } },
    { key: 'navratri', name: 'Navratri / Dussehra', s: [9, 22], e: [10, 2], base: 2.2, cats: { fashion: 2.7, jewellery: 2.5, footwear: 2.2, appliances: 2.0 } },
    { key: 'diwali', name: 'Diwali / Dhanteras', s: [10, 15], e: [10, 23], base: 3.4, cats: { jewellery: 5.0, appliances: 4.5, electronics: 4.0, mobiles: 4.2, fashion: 3.2, gifting: 4.0, fmcg: 2.6, home: 3.0 } },
  ],
  2026: [
    { key: 'rakhi', name: 'Raksha Bandhan', s: [8, 24], e: [8, 28], base: 1.5, cats: { gifting: 2.2, fashion: 1.7, jewellery: 1.8 } },
    { key: 'onam', name: 'Onam', s: [8, 16], e: [8, 26], base: 1.4, cats: { fashion: 1.8, home: 1.7, fmcg: 1.5, jewellery: 1.9 } },
    { key: 'ganesh', name: 'Ganesh Chaturthi', s: [9, 12], e: [9, 23], base: 1.4, cats: { fmcg: 1.6, gifting: 1.7 } },
    { key: 'pitru', name: 'Pitru Paksha (inauspicious)', s: [9, 27], e: [10, 10], base: 0.9, dip: true, cats: { jewellery: 0.7, appliances: 0.8, home: 0.85, mobiles: 0.9, electronics: 0.9 } },
    { key: 'bbd', name: 'Big Billion Days / Great Indian Festival', s: [9, 24], e: [10, 8], base: 3.0, cats: { mobiles: 5.0, electronics: 4.5, appliances: 4.0, fashion: 3.0, footwear: 2.8, beauty: 2.5, home: 2.6 } },
    { key: 'navratri', name: 'Navratri / Dussehra', s: [10, 11], e: [10, 20], base: 2.2, cats: { fashion: 2.7, jewellery: 2.5, footwear: 2.2, appliances: 2.0 } },
    { key: 'diwali', name: 'Diwali / Dhanteras', s: [11, 6], e: [11, 12], base: 3.4, cats: { jewellery: 5.0, appliances: 4.5, electronics: 4.0, mobiles: 4.2, fashion: 3.2, gifting: 4.0, fmcg: 2.6, home: 3.0 } },
  ],
  2027: [
    { key: 'rakhi', name: 'Raksha Bandhan', s: [8, 15], e: [8, 19], base: 1.5, cats: { gifting: 2.2, fashion: 1.7, jewellery: 1.8 } },
    { key: 'onam', name: 'Onam', s: [9, 4], e: [9, 14], base: 1.4, cats: { fashion: 1.8, home: 1.7, fmcg: 1.5, jewellery: 1.9 } },
    { key: 'ganesh', name: 'Ganesh Chaturthi', s: [9, 4], e: [9, 15], base: 1.4, cats: { fmcg: 1.6, gifting: 1.7 } },
    { key: 'pitru', name: 'Pitru Paksha (inauspicious)', s: [9, 16], e: [9, 30], base: 0.9, dip: true, cats: { jewellery: 0.7, appliances: 0.8, home: 0.85, mobiles: 0.9 } },
    { key: 'bbd', name: 'Big Billion Days / Great Indian Festival', s: [9, 20], e: [10, 5], base: 3.0, cats: { mobiles: 5.0, electronics: 4.5, appliances: 4.0, fashion: 3.0, footwear: 2.8, beauty: 2.5, home: 2.6 } },
    { key: 'navratri', name: 'Navratri / Dussehra', s: [10, 1], e: [10, 9], base: 2.2, cats: { fashion: 2.7, jewellery: 2.5, footwear: 2.2, appliances: 2.0 } },
    { key: 'diwali', name: 'Diwali / Dhanteras', s: [10, 27], e: [11, 2], base: 3.4, cats: { jewellery: 5.0, appliances: 4.5, electronics: 4.0, mobiles: 4.2, fashion: 3.2, gifting: 4.0, fmcg: 2.6, home: 3.0 } },
  ],
};
const CIVIC = [ // fixed Gregorian each year
  { key: 'republic', name: 'Republic Day Sale', s: [1, 18], e: [1, 26], base: 1.6, cats: { electronics: 2.1, appliances: 2.2, mobiles: 2.0, fashion: 1.4 } },
  { key: 'valentine', name: "Valentine's / Spring Sale", s: [2, 7], e: [2, 14], base: 1.3, cats: { beauty: 1.7, fashion: 1.5, gifting: 1.9 } },
  { key: 'freedom', name: 'Independence Day / Freedom Sale', s: [8, 6], e: [8, 16], base: 1.8, cats: { electronics: 2.3, appliances: 2.2, mobiles: 2.2, fashion: 1.5 } },
  { key: 'wedding', name: 'Wedding Season', s: [11, 13], e: [12, 20], base: 1.6, cats: { jewellery: 2.6, fashion: 2.1, footwear: 1.8, beauty: 1.7 } },
  { key: 'yearend', name: 'Christmas / New Year', s: [12, 21], e: [12, 31], base: 1.5, cats: { gifting: 2.0, fmcg: 1.6, beauty: 1.6 } },
];
function eventsForYear(y) { return [...(MOVABLE[y] || MOVABLE[2026]), ...CIVIC]; }
function ord(m, d) { return m * 100 + d; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function eventsOnDate(date) {
  const y = date.getFullYear(), o = ord(date.getMonth() + 1, date.getDate());
  return eventsForYear(y).filter(ev => { const a = ord(ev.s[0], ev.s[1]), b = ord(ev.e[0], ev.e[1]); return a <= b ? (o >= a && o <= b) : (o >= a || o <= b); });
}
export function classifyCategory(cat) {
  const c = (cat || '').toString().toLowerCase();
  if (/mobile|smartphone|\bphone\b|tablet/.test(c)) return 'mobiles';
  if (/electronic|laptop|computer|\btv\b|television|audio|headphone|earbud|camera|gadget|gaming/.test(c)) return 'electronics';
  if (/appliance|refrigerator|fridge|washing|microwave|\bac\b|air ?cond|cooler|geyser|chimney/.test(c)) return 'appliances';
  if (/jewel|jewellery|jewelry|\bgold\b|silver|diamond/.test(c)) return 'jewellery';
  if (/footwear|shoe|sneaker|sandal|slipper|heel/.test(c)) return 'footwear';
  if (/fashion|apparel|cloth|garment|\bwear\b|kurta|saree|sari|shirt|dress|ethnic|t-?shirt|jeans|lehenga|denim/.test(c)) return 'fashion';
  if (/beauty|cosmetic|makeup|skincare|skin care|personal care|fragrance|perfume|grooming|haircare|lipstick/.test(c)) return 'beauty';
  if (/grocery|food|bever|fmcg|snack|staple|atta|\brice\b|dairy|milk|household|cleaning|\btea\b|coffee|dry fruit|sweet|masala|oil|noodle/.test(c)) return 'fmcg';
  if (/gift|\btoy\b|stationery|decor|festive|pooja|puja|diya|candle|rangoli|cracker/.test(c)) return 'gifting';
  if (/home|furniture|kitchen|cookware|bedding|bedsheet|furnish|utensil|kadai/.test(c)) return 'home';
  return 'default';
}
export function indiaDayMultiplier(date, cat, qcom) {
  const evs = eventsOnDate(date);
  let up = 1, dip = 1;
  for (const ev of evs) {
    const m = (ev.cats && ev.cats[cat] != null) ? ev.cats[cat] : ev.base;
    if (ev.dip) dip = Math.min(dip, m); else up = Math.max(up, m);
  }
  let mult = up * dip;   // festive surge layered with any inauspicious-period dip
  if (qcom) {
    const keepHard = (cat === 'fmcg' || cat === 'gifting' || cat === 'beauty');
    mult = 1 + (mult - 1) * (keepHard ? 0.6 : 0.3);
    const dow = date.getDay();
    if (dow === 0 || dow === 6) mult *= 1.22; else if (dow === 5) mult *= 1.08;
  }
  return mult;
}
function peakEventInWindow(today, horizDays, cat, qcom) {
  let best = null, bestM = 1.0;
  for (let d = 0; d < horizDays; d++) { const date = addDays(today, d); const evs = eventsOnDate(date); if (!evs.length) continue; const m = indiaDayMultiplier(date, cat, qcom); if (m > bestM + 0.01) { bestM = m; best = evs.find(e => !e.dip)?.name || evs[0].name; } }
  return best;
}
function fmtWin(s, e) { const o = { day: 'numeric', month: 'short' }; return s.toLocaleDateString('en-GB', o) + ' – ' + e.toLocaleDateString('en-GB', o); }
function eventRec(ev, live, daysAway) {
  if (ev.dip) return 'Inauspicious window — muhurat-sensitive categories (gold, appliances, big-ticket) typically dip; avoid over-ordering these, then pre-build for the Navratri–Diwali surge right after.';
  const big = Math.max(ev.base, ...Object.values(ev.cats || {}));
  if (live) return 'Live now — protect availability, keep buffers high, expedite inbound on fast movers.';
  if (daysAway <= 20) return 'Final window — place POs now; lock safety stock and confirm inbound ETAs.';
  if (daysAway <= 45) return 'Pre-build for ' + (big >= 3 ? 'a 3–5x' : 'a 1.5–2x') + ' surge; raise POs for 30-day-lead suppliers this week.';
  if (daysAway <= 90) return 'Plan POs and negotiate supplier capacity; start demand sensing on hero SKUs.';
  return "On the radar — review last year's sell-through and shortlist hero SKUs.";
}
export function upcomingIndiaEvents(today) {
  const out = [], seen = new Set();
  for (const yr of [today.getFullYear(), today.getFullYear() + 1]) {
    for (const ev of eventsForYear(yr)) {
      if (seen.has(ev.key + yr)) continue; seen.add(ev.key + yr);
      const start = new Date(yr, ev.s[0] - 1, ev.s[1]), end = new Date(yr, ev.e[0] - 1, ev.e[1]);
      if (today > end) continue;
      const live = today >= start && today <= end;
      const daysAway = live ? 0 : Math.max(0, Math.round((start - today) / 86400000));
      const cats = ev.cats || {}; const topCats = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
      const peak = ev.dip ? Math.min(ev.base, ...Object.values(cats)) : Math.max(ev.base, ...Object.values(cats));
      out.push({ event: ev.name, window: fmtWin(start, end), daysAway, live, dip: !!ev.dip,
        uplift: ev.dip ? ('~' + peak + 'x (dip)') : ('~' + (Math.round(ev.base * 10) / 10) + 'x' + (peak > ev.base ? ` (up to ${Math.round(peak * 10) / 10}x ${topCats[0] || ''})` : '')),
        topCategories: topCats, recommendation: eventRec(ev, live, daysAway) });
    }
  }
  return out.filter(e => e.live || e.daysAway <= 300).sort((a, b) => a.daysAway - b.daysAway);
}

// ═══ GEMINI: narrative insights only (never numbers) ═════════════════════════
// Plain-language one-liner shown at the top of the results — "explain it simply". Deterministic by
// default; Gemini rephrases it more naturally when a key is set (uses only the computed numbers).
export async function generatePlainSummary(out, cfg, apiKey) {
  const s = out.summary || {}, sym = cfg.sym || '';
  const fN = n => Math.round(n || 0).toLocaleString();
  const horizon = (cfg.horizDays || 90) + ' days';
  const nextTotal = Math.round((out.allSKUs || []).reduce((a, r) => a + (r.nextH || 0), 0));
  const acc = s.forecastAccuracyWmape != null ? Math.max(0, 100 - s.forecastAccuracyWmape) : null;
  const parts = [`You have ${fN(s.totalSKUs)} products; expected demand is about ${fN(nextTotal)} units over the next ${horizon}.`];
  const acts = [];
  if (s.urgentSKUs) acts.push(`${s.urgentSKUs} need reordering now`);
  const slowDead = (s.slowMoverSKUs || 0) + (s.deadSKUs || 0); if (slowDead) acts.push(`${slowDead} slow or dead`);
  if (s.overstockSKUs) acts.push(`${s.overstockSKUs} overstocked`);
  if (acts.length) parts.push(acts.join(', ') + '.');
  if (s.totalExcess > 0) parts.push(`About ${sym}${fN(s.totalExcess)} is tied up in excess stock you can free.`);
  if (acc != null) parts.push(`Forecasts back-test at ~${acc}% accuracy on your history.`);
  const deterministic = parts.join(' ');
  if (!apiKey) return deterministic;
  const prompt = `Rewrite this inventory summary as ONE friendly, plain-English sentence (max 45 words) for a non-technical shop owner. Use ONLY these facts and numbers; invent nothing; no jargon. Return just the sentence.\nFACTS: ${deterministic}`;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 160, thinkingConfig: { thinkingBudget: 0 } } }) });
    const j = await r.json();
    const txt = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (txt && txt.length > 10) return txt.replace(/^["']+|["']+$/g, '');
  } catch (e) { /* fall through */ }
  return deterministic;
}
async function generateInsights(summary, reorderPlan, slowMoversAll, cfg, apiKey) {
  const fallback = [
    { type: 'red', icon: '🚨', text: `${summary.urgentSKUs} SKUs need immediate reorders to prevent stockouts.` },
    { type: 'orange', icon: '📦', text: `${summary.deadSKUs} dead-stock SKUs are tying up capital — consider markdowns.` },
    { type: 'blue', icon: '📊', text: `Average days of cover is ${summary.avgDoC} across ${summary.activeSKUs} active SKUs (healthy: 30–90).` },
    { type: summary.forecastAccuracyWmape != null && summary.forecastAccuracyWmape <= 30 ? 'green' : 'orange', icon: '🎯', text: summary.forecastAccuracyWmape != null ? `Back-test WMAPE ~${summary.forecastAccuracyWmape}% (bias ${summary.forecastBias >= 0 ? '+' : ''}${summary.forecastBias}%) — ${summary.forecastAccuracyWmape <= 20 ? 'high' : summary.forecastAccuracyWmape <= 40 ? 'usable' : 'low'} confidence.` : `Snapshot data — upload dated history for back-tested accuracy.` },
    { type: 'purple', icon: '🪔', text: summary.festivalMode ? `Festive calendar applied; ${summary.censoredSKUs} stockout-censored SKU(s) were demand-corrected.` : `Festival intelligence off.` },
    { type: 'orange', icon: '💸', text: `Revenue at risk from stockouts: ${cfg.sym}${Math.round(summary.totalAtRisk).toLocaleString()}.` },
  ];
  if (!apiKey) return fallback;
  const prompt = `You are a supply-chain analyst. Return ONLY JSON: {"insights":[{"type":"green|orange|red|blue|purple","icon":"emoji","text":"one sentence"}]} with EXACTLY 6 insights (stockout urgency, dead stock, working capital, forecast confidence using WMAPE, festive/seasonality, strategic reco). Use ONLY these numbers; invent nothing.
DATA: ${JSON.stringify({ ...summary, currency: cfg.sym, horizon: cfg.horizDays + 'd', topUrgent: reorderPlan.slice(0, 5).map(r => ({ p: r.product, stock: r.currentStock, by: r.reorderBy })), topDead: slowMoversAll.filter(r => r.isDead).slice(0, 3).map(r => ({ p: r.product, v: r.invValue })) })}`;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1200, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } } }) });
    const j = await r.json();
    const txt = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (txt && txt.trim().length > 5) { const parsed = JSON.parse(txt.replace(/```json|```/g, '').trim()); if (parsed?.insights?.length) return parsed.insights; }
  } catch (e) { /* fall through */ }
  return fallback;
}

// ═══ NUMERIC HELPERS ═════════════════════════════════════════════════════════
function normalCdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }
// non-negative numeric parse (₹, commas incl. Indian lakh grouping, symbols stripped)
export function pNum(v) { if (v == null || v === '') return 0; const n = parseFloat(v.toString().replace(/rs\.?|inr|usd/gi, '').replace(/[$£€₹,\s]/g, '').replace(/[^\d.\-]/g, '')); return isNaN(n) || n < 0 ? 0 : n; }
// signed numeric parse (keeps negatives; returns 0 for junk like "-", "NA", "#N/A")
export function pSignedNum(v) { if (v == null) return 0; const s = v.toString().trim(); if (s === '' || /^(na|n\/a|#n\/a|-|—|null)$/i.test(s)) return 0; const n = parseFloat(s.replace(/rs\.?|inr|usd/gi, '').replace(/[$£€₹,\s]/g, '').replace(/[^\d.\-]/g, '')); return isNaN(n) ? 0 : n; }
