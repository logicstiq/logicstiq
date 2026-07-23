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
import { enrichWithEconomics, profitLeaks } from './econ.mjs';
import { quantileForecast } from './probabilistic.mjs';
import { budgetConstrainedPlan, groupPurchaseOrders } from './buyplan.mjs';

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

  out.insights = await generateInsights(out.summary, out.reorderPlan, out.slowMoversAll, cfg, apiKey);
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
  const skuList = Object.values(skuMap);
  if (!skuList.length) return { error: 'No valid SKUs found after cleaning the file.' };

  const today = new Date();
  let results = skuList.map(s => computeSKU(s, isTS, today, cfg, map, catStats));
  // GOD-MODE: enrich every SKU with India unit economics (additive — original fields untouched).
  results = enrichWithEconomics(results, { codShare: cfg.codShare, overrides: cfg.econOverrides || {} });

  const summary = buildSummary(results, isTS, cfg, map);
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
  available: ['available', 'on hand', 'qty available', 'stock', 'in stock', 'current stock', 'closing stock', 'closing balance', 'closing qty', 'sellable units', 'fulfillable qty', 'warehouse stock', 'physical stock', 'net stock', 'usable stock', 'free stock', 'available quantity', 'godown stock', 'stock in hand', 'quantity on hand', 'quantity available', 'on hand quantity', 'inventory on hand', 'available inventory', 'sellable inventory', 'fulfillable quantity', 'afn sellable quantity', 'inventory quantity', 'qty on hand'],
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
    const availFrac = rowAvailability(row, get, map, period);   // 0..1 or null

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

    // STOCK: snapshot per warehouse — keep the max seen per distinct wh (dedupe repeats), sum across wh
    const prev = e._wh[wh] || { avail: 0, inbound: 0, reserved: 0 };
    e._wh[wh] = { avail: Math.max(prev.avail, avail), inbound: Math.max(prev.inbound, inbound), reserved: Math.max(prev.reserved, reserved) };

    // TIME SERIES: one net observation per dated row (unconstrained for stockout)
    if (period) {
      const net = Math.max(0, grossAdd - returnAdd);
      const fullyOut = availFrac != null && availFrac <= 0.05;
      const trueDemand = (availFrac != null && availFrac > 0.05 && availFrac < 1) ? net / Math.max(0.2, availFrac) : net;
      e.periods.push({ period: normalisePeriod(period), units: Math.round(trueDemand * 100) / 100, raw: net, availFrac, stockout: fullyOut });
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
    delete e._salesByWh; delete e._retByWh; delete e._velByWh;
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
  return Math.max(0, p * z);
}
function seasonalIndices(y, m) {
  if (y.length < 2 * m) return null; const o = mean(y); if (o <= 0) return null;
  const idx = Array(m).fill(0), cnt = Array(m).fill(0);
  for (let i = 0; i < y.length; i++) { idx[i % m] += y[i]; cnt[i % m]++; }
  const s = idx.map((v, i) => cnt[i] ? (v / cnt[i]) / o : 1); const avg = mean(s);
  return s.map(v => avg ? v / avg : 1);
}
export function buildForecaster(demands, method, gap) {
  const n = demands.length;
  const cls = classifyDemand(demands);
  const ma = mean(demands.slice(-Math.min(3, n)));
  let lvl = demands[0]; for (let i = 1; i < n; i++) lvl = 0.4 * demands[i] + 0.6 * lvl;
  const { a, b } = linreg(demands); const last = n - 1;
  const phi = 0.9;   // FIX(v10): damped trend bounds runaway long-horizon extrapolation
  const trendSum = k => { let s = 0; for (let i = 1; i <= k; i++) s += Math.pow(phi, i); return s; };
  const holt = k => Math.max(0, (a + b * last) + b * trendSum(k));
  const seasCands = gap == null ? [12, 7, 4] : (gap < 2 ? [7] : gap < 10 ? [] : gap < 45 ? [12] : gap < 135 ? [4] : []);   // FIX(v10): seasonal period tied to granularity
  let season = null, m = 0; for (const c of seasCands) { const s = seasonalIndices(demands, c); if (s) { season = s; m = c; break; } }

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
    const slopeShare = ma > 0 ? Math.abs(b) / ma : 0;
    fn = (n >= 4 && slopeShare > 0.03) ? holt : (n >= 3 ? () => Math.max(0, lvl) : () => ma);
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

  if (isTS && s.periods.length >= 2) {
    const usable = s.periods.filter(p => !p.stockout);            // stockout days excluded so they don't deflate demand
    const demands = (usable.length >= 2 ? usable : s.periods).map(p => p.units).filter(d => d >= 0);
    if (s.periods.some(p => p.stockout)) censored = true;
    tsDemands = demands;   // GOD-MODE: retained for probabilistic quantile band
    const n = demands.length; gap = detectGapDays(usable.length >= 2 ? usable : s.periods); periodGranularity = gapLabel(gap);
    const pm = mean(demands);
    avgMonthly = Math.round(pm * (30 / gap) * 10) / 10;
    if (n >= 4) { const { b } = linreg(demands); const pct = pm > 0 ? (b * (n - 1) / pm) * 100 : 0; trend = pct > 8 ? 'up' : pct < -8 ? 'down' : 'flat'; trendPct = (pct >= 0 ? '+' : '') + Math.round(pct) + '%'; }
    fc = buildForecaster(demands, cfg.method, gap); pattern = fc.pattern;
    const bt = backtest(demands, cfg.method, gap); mape = bt.mape; wmape = bt.wmape; bias = bt.bias; mase = bt.mase;
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
      else { const cm = catStats[catBucket]; if (cm > 0) { baseDaily = cm * 0.5; coldStart = true; } }
    }
    const base30 = baseDaily * 30;
    const g = (s.momTrend != null && isFinite(s.momTrend)) ? Math.max(-0.3, Math.min(0.3, s.momTrend)) : 0;
    const seas = (s.seasonalIndex != null && s.seasonalIndex > 0) ? Math.max(0.4, Math.min(2.5, s.seasonalIndex)) : 1;
    fc = { f: k => base30 * seas * Math.min(3, Math.pow(1 + g, Math.min(k - 1, 6))) };
    avgMonthly = Math.round(base30 * 10) / 10;
    dailyVel = fc.f(1) / 30; sigmaDaily = dailyVel * 0.4;
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
  const sigmaLT = s.leadTimeVar > 0 ? s.leadTimeVar : 0;
  const ssCalc = Math.ceil(z * Math.sqrt(lt * sigmaDaily ** 2 + (effVel ** 2) * (sigmaLT ** 2)));
  const safetyStock = s.safetyStock > 0 ? s.safetyStock : ssCalc;
  const reorderPoint = s.reorderPoint > 0 ? s.reorderPoint : Math.ceil(effVel * lt + safetyStock);
  const target = Math.ceil(effVel * (cfg.horizDays + lt) + safetyStock);
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
  if (dailyVel > 0) { const muLT = effVel * lt, sdLT = Math.max(1e-6, sigmaDaily * Math.sqrt(lt)); stockoutProb = Math.max(0, Math.min(100, Math.round(100 * (1 - normalCdf((Math.max(0, netStock) - muLT) / sdLT))))); }
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
    periodGranularity, forecastMethod: cfg.method,
    daysOfCover, weeksOfSupply: Math.round(daysOfCover / 7 * 10) / 10, safetyStock, reorderPoint,
    eoq: orderQty, orderQty, reorderBy, priority, leadTimeDays: lt, serviceLevel: Math.round(sl * 100),
    needsReorder: orderQty > 0 && isActive, stockoutDays, stockoutProb, revenueAtRisk, invValue,
    isSlowMover, isDead, isOverstock, isHealthy, isActive, invTurnover, fillRate, excessValue,
    slowMoverRisk: invValue > 5000 ? 'HIGH' : invValue > 1000 ? 'MEDIUM' : 'LOW',
    slowAction: invValue > 5000 ? 'Markdown / Bundle / Liquidate' : invValue > 1000 ? 'Hold — avoid reorder' : 'Monitor',
  };
}

function buildSummary(results, isTS, cfg, map) {
  const active = results.filter(s => s.isActive);
  const w = active.filter(s => s.wmape != null);
  const avgWmape = w.length ? Math.round(w.reduce((a, r) => a + r.wmape, 0) / w.length) : null;
  const avgBias = w.length ? Math.round(w.reduce((a, r) => a + (r.bias || 0), 0) / w.length) : null;
  const mp = active.filter(s => s.mape != null);   // FIX(v10): real average MAPE (was WMAPE relabelled)
  const avgMape = mp.length ? Math.round(mp.reduce((a, r) => a + r.mape, 0) / mp.length) : null;
  const censoredN = results.filter(r => r.censored).length;
  const dataQuality = [];
  if (!isTS) dataQuality.push(`Snapshot file: sales treated as a ${cfg.salesWindow}-day figure. Set the correct Data Sales Period or daily numbers will be off. Upload dated rows for true trend/seasonality and back-tested accuracy.`);
  if (map.status === undefined && map.returns === undefined) dataQuality.push('No order-status or returns column detected — demand is gross of returns. Add one for net-demand accuracy.');
  if (map.stockoutFlag === undefined && map.availMins === undefined && map.inStockDays === undefined && map.daysOutOfStock === undefined && map.alert === undefined) dataQuality.push('No availability/stockout signal — stockout-suppressed demand cannot be reconstructed, so bestsellers that ran out may read low.');
  if (map.alert !== undefined && censoredN) dataQuality.push(`${censoredN} SKU(s) flagged out-of-stock by the file's alert column — labelled demand-unknown rather than dead (add dated history to recover their true demand).`);
  if (censoredN) dataQuality.push(`${censoredN} SKU(s) had stockout-censored sales; their demand was reconstructed or flagged rather than counted as zero.`);
  if (map.price === undefined && map.cost === undefined) dataQuality.push('No price/cost column — revenue-at-risk and inventory value show 0.');
  if (map.leadTime === undefined) dataQuality.push(cfg.qcom ? 'No lead-time column — 2-day q-commerce lead time assumed.' : 'No lead-time column — 30-day lead time assumed.');
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
