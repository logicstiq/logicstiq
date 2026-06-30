// /api/forecast.js — LogicstIQ AI Demand Planner v8 (India edition)
// v8 adds: a baked-in INDIA festive-sale demand calendar (Big Billion Days,
// Great Indian Festival, Diwali/Dhanteras, Navratri/Dussehra, Myntra EORS,
// Raksha Bandhan, Holi, Republic/Independence-Day sales) applied as a
// category-aware, date-windowed seasonal index over the forecast horizon, and a
// Quick-Commerce mode (Blinkit/Zepto/Instamart/BigBasket/Flipkart Minutes/Amazon
// Fresh) with daily velocity, weekend uplift, short lead times and a 98% service
// level. All v7 logic retained: best-header detection, period-granularity scaling,
// consistent multi-horizon forecasts, real methods + back-test (MAPE),
// multi-warehouse summing, statistical safety stock & stockout probability.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set in Vercel Environment Variables.' });

  let { csvText, csvGz, horizon, currency, region, channels, planLevel, erpSource, method, salesWindowDays, festivalMode, commerceType } = req.body || {};
  if (!csvText && csvGz) {
    try { const zlib = await import('node:zlib'); csvText = zlib.gunzipSync(Buffer.from(csvGz, 'base64')).toString('utf8'); }
    catch (e) { return res.status(400).json({ error: 'Could not read the compressed file. Please try a smaller or different export.' }); }
  }
  if (!csvText || csvText.trim().length < 10) return res.status(400).json({ error: 'No data received. Please upload a valid file.' });

  const sym = currency || '₹';
  const horizDays = parseInt(horizon) || 90;
  const fcMethod = (method || 'Auto').toString();
  const salesWindow = Math.max(1, parseInt(salesWindowDays) || 30);
  const level = (planLevel || 'SKU').toString();
  const isIndia = (region == null) || /india/i.test(region.toString());
  const qcom = /quick|q-?com/i.test((commerceType || '').toString()) || (Array.isArray(channels) && channels.length > 0 && channels.every(c => QCOM_CHANNELS.includes(c)));
  const applyFestival = (festivalMode !== false && festivalMode !== 'off') && isIndia;

  const rows = parseCSVSmart(csvText, erpSource || 'auto');
  if (!rows || rows.length < 2) return res.status(400).json({ error: 'Could not read your file. Make sure it has at least 2 rows of data.' });

  const headers = rows[0];
  const dataRows = rows.slice(1).filter(r => r.some(c => c && c.trim()));
  if (!dataRows.length) return res.status(400).json({ error: 'No data rows found after the header row.' });

  const map = mapColumns(headers, erpSource || 'auto');
  const { skuMap, isTS } = buildSkuMap(dataRows, map);
  const skuList = Object.values(skuMap);
  if (!skuList.length) return res.status(400).json({ error: 'No valid SKUs found. Ensure your file has a product name or SKU column.' });

  const today = new Date();
  const indiaEvents = applyFestival ? upcomingIndiaEvents(today) : [];
  const results = skuList.map(s => computeSKU(s, isTS, today, sym, horizDays, fcMethod, salesWindow, map, { applyFestival, qcom }));

  const dataQuality = [];
  if (!isTS) {
    if (map.velocity === undefined && map.unitsSold !== undefined)
      dataQuality.push(`Snapshot file: "Units sold" is treated as a ${salesWindow}-day figure. If it's a different period, set the Data Sales Period or daily forecasts will be off.`);
    if (map.unitsSold === undefined && map.velocity === undefined)
      dataQuality.push('No sales/velocity column found — demand forecasts cannot be computed. Add a units-sold or daily-velocity column.');
    if (map.seasonalIndex !== undefined || map.momTrend !== undefined)
      dataQuality.push('Applied your file’s ' + [map.momTrend !== undefined ? 'MoM-Trend' : null, map.seasonalIndex !== undefined ? 'Seasonal-Index' : null].filter(Boolean).join(' & ') + ' columns to make the snapshot trend/season-aware.');
  }
  if (map.price === undefined && map.cost === undefined) dataQuality.push('No price/cost column found — revenue-at-risk, margins and inventory value are shown as 0.');
  else if (map.cost === undefined) dataQuality.push('No separate cost column — inventory value is calculated at selling price. Add a unit-cost column for true cost valuation and margins.');
  if (map.leadTime === undefined) dataQuality.push(qcom ? 'No lead-time column found — a 2-day quick-commerce replenishment lead time is assumed for reorder timing.' : 'No lead-time column found — a default of 30 days is used for reorder timing.');
  if (applyFestival) dataQuality.push('India festive-sale calendar applied: forecasts, days-of-cover and reorder dates are uplifted for the Big Billion Days / Great Indian Festival / Diwali window and other category-relevant events that fall inside your horizon.');
  const multiWh = results.filter(r => r.warehouseCount > 1).length;
  if (multiWh) dataQuality.push(`${multiWh} SKU(s) span multiple warehouses — on-hand stock and sales were summed across locations.`);

  const active = results.filter(s => s.isActive);
  const pOrd = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

  const demandForecast = results.filter(s => s.isActive).sort((a, b) => b.avgMonthlyDemand - a.avgMonthlyDemand).slice(0, 100);
  const reorderPlan = results.filter(s => s.needsReorder).sort((a, b) => (pOrd[a.priority] || 3) - (pOrd[b.priority] || 3)).slice(0, 60);
  const slowMoversAll = results.filter(s => s.isSlowMover || s.isDead).sort((a, b) => b.invValue - a.invValue).slice(0, 50);
  const stockoutRisk = results.filter(s => s.stockoutProb > 30).sort((a, b) => b.stockoutProb - a.stockoutProb).slice(0, 30);
  const groupedForecast = buildGroups(results, level);

  const mapeArr = active.filter(s => s.mape != null);
  const avgMape = mapeArr.length ? Math.round(mapeArr.reduce((a, r) => a + r.mape, 0) / mapeArr.length) : null;

  const summary = {
    totalSKUs: results.length, activeSKUs: active.length,
    healthySKUs: results.filter(s => s.isHealthy).length,
    deadSKUs: results.filter(s => s.isDead).length,
    overstockSKUs: results.filter(s => s.isOverstock).length,
    slowMoverSKUs: results.filter(s => s.isSlowMover && !s.isDead).length,
    urgentSKUs: results.filter(s => s.priority === 'URGENT' || s.priority === 'HIGH').length,
    totalInvValue: results.reduce((a, r) => a + r.invValue, 0),
    totalAtRisk: results.reduce((a, r) => a + r.revenueAtRisk, 0),
    totalExcess: results.reduce((a, r) => a + r.excessValue, 0),
    totalMargin: results.reduce((a, r) => a + (r.marginPerUnit > 0 ? r.marginPerUnit * r.avgMonthlyDemand : 0), 0),
    avgDoC: active.length ? Math.round(active.reduce((a, r) => a + Math.min(r.daysOfCover, 365), 0) / active.length) : 0,
    isTS, erpSource: erpSource || 'auto', planLevel: level,
    region: region || 'India', commerceType: qcom ? 'Quick Commerce' : 'E-Commerce', festivalMode: applyFestival,
    seasonalPeakEvent: (results.find(r => r.peakEvent) || {}).peakEvent || null,
    avgSeasonalUplift: active.length ? Math.round((active.reduce((a, r) => a + (r.seasonalUplift || 1), 0) / active.length) * 100) / 100 : 1,
    forecastMethod: fcMethod, periodGranularity: results.find(r => r.periodGranularity)?.periodGranularity || (isTS ? 'unknown' : 'snapshot'),
    forecastAccuracyMape: avgMape, usedFileTrend: map.momTrend !== undefined, usedFileSeasonality: map.seasonalIndex !== undefined,
    hasCost: map.cost !== undefined, dataQuality,
    detectedColumns: Object.keys(map).join(', '),
  };

  const narrativePrompt = `You are a world-class supply chain AI analyst. Write ONLY the insights JSON.

RULES:
1. Use ONLY numbers from the JSON below — do not invent anything.
2. Return ONLY valid JSON — no markdown, no backticks.
3. Write exactly 6 insights: stockout urgency, dead stock, working capital, data quality / forecast confidence, seasonality or planning-level opportunity, strategic recommendation.
4. Each insight: specific, data-backed, one sentence.
5. type: green/orange/red/blue/purple.

REPORT: ${JSON.stringify({ totalSKUs: summary.totalSKUs, activeSKUs: summary.activeSKUs, healthySKUs: summary.healthySKUs, deadSKUs: summary.deadSKUs, overstockSKUs: summary.overstockSKUs, urgentSKUs: summary.urgentSKUs, totalInventoryValue: sym + Math.round(summary.totalInvValue).toLocaleString(), revenueAtRisk: sym + Math.round(summary.totalAtRisk).toLocaleString(), excessCapitalTied: sym + Math.round(summary.totalExcess).toLocaleString(), avgDaysOfCover: summary.avgDoC + ' days', forecastMethod: summary.forecastMethod, forecastAccuracyMape: summary.forecastAccuracyMape, periodGranularity: summary.periodGranularity, planLevel: level, dataQuality: summary.dataQuality, channels: (channels || []).join(', '), region, horizon, erpSource })}

TOP 5 URGENT: ${JSON.stringify(reorderPlan.slice(0, 5).map(r => ({ product: r.product, stock: r.currentStock, priority: r.priority, reorderBy: r.reorderBy })))}
TOP 3 DEAD: ${JSON.stringify(slowMoversAll.filter(r => r.isDead).slice(0, 3).map(r => ({ product: r.product, value: sym + Math.round(r.invValue).toLocaleString() })))}

Return EXACTLY: {"insights":[{"type":"green|orange|red|blue|purple","icon":"emoji","text":"sentence"}]}`;

  let insights = [
    { type: 'red', icon: '🚨', text: `${summary.urgentSKUs} SKUs need immediate reorders — act now to prevent stockouts and lost revenue.` },
    { type: 'orange', icon: '📦', text: `${summary.deadSKUs} dead-stock SKUs are tying up capital — consider markdowns or liquidation.` },
    { type: 'blue', icon: '📊', text: `Average days of cover is ${summary.avgDoC} days across ${summary.activeSKUs} active SKUs. Healthy target: 30–90 days.` },
    { type: summary.forecastAccuracyMape != null && summary.forecastAccuracyMape <= 25 ? 'green' : 'orange', icon: '🎯', text: summary.forecastAccuracyMape != null ? `Forecast back-test error (MAPE) is ~${summary.forecastAccuracyMape}% using ${summary.forecastMethod} — ${summary.forecastAccuracyMape <= 15 ? 'high' : summary.forecastAccuracyMape <= 25 ? 'usable' : 'low'} confidence.` : `Forecasts use the ${summary.forecastMethod} method on a ${summary.periodGranularity} dataset. ${summary.dataQuality[0] || ''}` },
    { type: 'orange', icon: '⚠️', text: `${summary.overstockSKUs} overstocked SKUs are locking up ${sym}${Math.round(summary.totalExcess).toLocaleString()} in excess working capital.` },
    { type: 'purple', icon: '🎯', text: `Revenue at risk from potential stockouts: ${sym}${Math.round(summary.totalAtRisk).toLocaleString()} over the next ${horizon}.` },
  ];

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    const aiRes = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: narrativePrompt }] }], generationConfig: { temperature: 0.3, maxOutputTokens: 1200, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } } }) });
    const aiData = await aiRes.json();
    const aiText = (aiData?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    if (aiText && aiText.trim().length > 5) {
      const parsed = JSON.parse(aiText.replace(/```json|```/g, '').trim());
      if (parsed?.insights?.length) insights = parsed.insights;
    }
  } catch (e) { /* fallback insights used */ }

  return res.status(200).json({ summary, demandForecast, reorderPlan, slowMoversAll, stockoutRisk, allSKUs: results, groupedForecast, insights, upcomingEvents: indiaEvents });
}

// ─── SMART CSV PARSER (best-header detection) ─────────────────────────────────
function parseCSVSmart(text, erpSource) {
  const allRows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    allRows.push(t.includes('\t') && !t.includes(',') ? t.split('\t').map(x => x.trim()) : parseCSVLine(t));
  }
  if (!allRows.length) return [];
  const dataKeywords = ['sku', 'asin', 'product', 'item', 'stock', 'qty', 'quantity', 'units', 'sales', 'available', 'inbound', 'price', 'cost', 'category', 'brand', 'description', 'material', 'part', 'code', 'name', 'article', 'variant', 'closing', 'opening', 'velocity', 'demand', 'warehouse', 'location', 'bin', 'batch', 'serial'];
  let headerIdx = 0, bestScore = -1;
  for (let i = 0; i < Math.min(allRows.length, 15); i++) {
    const cells = allRows[i].map(c => (c || '').toString().toLowerCase().trim());
    const filled = cells.filter(c => c).length;
    const matches = dataKeywords.filter(k => cells.some(c => c.includes(k))).length;
    if (filled < 3 || matches < 2) continue;
    const score = matches * 10 + filled;
    if (score > bestScore) { bestScore = score; headerIdx = i; }
  }
  return allRows.slice(headerIdx).filter(r => r.some(c => c && c.trim()));
}

function parseCSVLine(line) {
  const cells = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
    else if ((ch === ',' || ch === '\t') && !inQ) { cells.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  cells.push(cur.trim()); return cells;
}

// ─── COLUMN MAPPER (now with cost, momTrend, seasonalIndex) ───────────────────
function mapColumns(headers, erpSource) {
  const syn = {
    sku: ['sku','sku id','sku code','item id','item code','item number','product code','product id','part no','part number','part no.','article no','article code','article number','stock code','stock id','material code','material number','material id','merchant sku','seller sku','asin','fnsku','barcode','upc','ean','isbn','material','matnr','stock item','stock item name','item name','godown item','voucher item','internal id','item internal id','inventory item','assembly item','product reference','reference','sku reference','variant sku','skucode','sku_code','item_code','style code','style_code','color size sku','listing id','fsn','product sku','vendor sku','seller article id','variant id','product variant','shopify sku','internal reference','default code'],
    product: ['product name','product title','product','description','title','item name','item description','product description','name','display name','item','goods','material description','material text','short text','long text','stock item name','particulars','narration','display name/code','salesdescription','purchase description','released product','option 1 value','option 2 value','item type name','channel product name','product listing name','article name','style name','internal notes'],
    period: ['date','month','week','period','year','quarter','order date','sale date','sales month','sales period','reporting period','posting date','document date','billing date','invoice date','transaction date','movement date','fiscal period','accounting period','dispatch date','shipment date','fy','financial year','month year'],
    price: ['selling price','sale price','sell price','price','unit price','mrp','asp','rate','item price','online price','msrp','sales price','your price','buy box price','your selling price','discounted price','compare at price','variant price','net price','retail price'],
    cost: ['unit cost','cost price','standard cost','purchase price','purchase rate','landed cost','cogs','cost of goods','buy price','moving average price','moving avg price','valuation price','map','cost','avg cost','average cost','wac'],
    unitsSold: ['units sold','qty sold','quantity sold','sales qty','sales quantity','units sold last 30 days','units sold 30d','sales last 30 days','demand','monthly demand','monthly sales','daily sales','sales units','sold qty','items sold','pieces sold','qty dispatched','dispatched qty','delivery quantity','billed quantity','issued quantity','outward qty','consumption qty','issue qty','quantity fulfilled','shipped quantity','invoiced quantity','total sold','units ordered','order quantity','dispatched quantity','fulfilled quantity','net quantity','total sales'],
    velocity: ['daily velocity','velocity 7d','velocity 30d','velocity','daily demand','avg daily sales','daily run rate','run rate','units per day','sales per day','average daily demand','add','average daily usage','adu','average consumption','avg consumption','planned consumption','daily avg','daily demand rate'],
    available: ['available','on hand','qty available','stock','in stock','current stock','closing stock','closing balance','closing qty','closing quantity','sellable units','fulfillable qty','warehouse stock','physical stock','net stock','usable stock','unrestricted stock','free stock','unrestricted','available quantity','mmbe stock','plant stock','storage location stock','shelf stock','godown stock','current balance','stock in hand','quantity on hand','quantity available','location qty on hand','preferred location qty on hand','on-hand inventory','physical inventory','available physical','on hand quantity','warehouse quantity','inventory on hand','available inventory','sellable inventory','good inventory','shelf inventory','fulfillable quantity','afn sellable quantity','fulfillable inventory','inventory quantity','qty on hand'],
    inbound: ['inbound','on order','in transit','po qty','incoming','ordered qty','open po','open purchase order','purchase order qty','po quantity','receiving','working','shipped','fc transfer','inbound qty','open po quantity','goods receipt pending','scheduled receipts','planned receipts','open delivery','in transit qty','pending po','quantity on order','quantity in transit','pending receipt quantity','purchase quantity','inbound quantity','incoming stock','due in','pending grn','grn pending','pending receipt','reserved fc transfer','incoming quantity','qty in','quantity in'],
    reserved: ['reserved','customer order','unfulfilled','pending dispatch','committed','allocated','reserved stock','pick list qty','sales order stock','delivery pending','wm transfer order','quantity committed','quantity on order (sales)','reserved ordered','reserved physical'],
    leadTime: ['lead time','lead time (days)','lt','lead time days','supplier lead time','replenishment lead time','procurement lead time','purchase lead time','days to receive','delivery days','supplier lead days','planned delivery time','goods receipt processing time','total replenishment lead time','order lead days','reorder lead time','vendor lead time'],
    reorderQty: ['reorder qty','reorder quantity','recommended replenishment qty','suggested reorder qty','suggested order qty','min order qty','moq','economic order quantity','eoq','recommended order qty','amazon recommended qty','fixed lot size','minimum lot size','preferred stock level','minimum order quantity'],
    reorderPoint: ['reorder point','rop','reorder level','minimum stock level','safety stock level','minimum reorder level','stock alert level'],
    safetyStock: ['safety stock','buffer stock','minimum stock','reserve stock','minimum inventory','safety inventory','minimum safety stock'],
    momTrend: ['mom trend','m-o-m','month over month','month-over-month','mom growth','mom','momentum','growth rate'],
    seasonalIndex: ['seasonal index','seasonality index','seasonal factor','season index','seasonality'],
    category: ['category','department','product type','product category','type','item type','item category','product class','class','sub category','product group','item group','commodity','commodity type','material group','product hierarchy','industry sector','stock group','sub group','collection','tags','browse node','sub-category','vertical'],
    brand: ['brand','brand name','manufacturer','vendor','supplier','make','marque','label','manufacturer part number','party name','vendor name','supplier name','preferred vendor'],
    warehouse: ['warehouse','fc','location','fulfillment center','dc','distribution center','storage location','godown','store','bin','rack','shelf','zone','aisle','plant','site','warehouse number','storage type','branch','sublocation','facility','facility name','warehouse code','fc name'],
    country: ['country','marketplace','region','market','territory','country code'],
    channel: ['channel','platform','source','sales channel','order source','fulfillment channel'],
    batchLot: ['batch','lot','batch number','lot number','batch no','lot no','serial number','expiry date','manufacture date','mfg date','exp date'],
    unitOfMeasure: ['uom','unit of measure','unit','unit of measurement','base unit','sales unit','purchase unit'],
  };
  const map = {};
  const lh = headers.map(h => (h || '').toLowerCase().trim().replace(/[_\-]/g, ' ').replace(/\s+/g, ' '));
  for (const [field, names] of Object.entries(syn)) {
    for (const name of names) {
      const idx = lh.findIndex(h => h === name || h.includes(name) || (name.length > 4 && name.includes(h) && h.length > 3));
      if (idx !== -1 && map[field] === undefined && !Object.values(map).includes(idx)) { map[field] = idx; break; }
    }
  }
  return map;
}

// ─── SKU MAP BUILDER (sums stock+sales across warehouses; captures cost/trend/season) ──
function buildSkuMap(dataRows, map) {
  const get = (row, field) => { const i = map[field]; return (i !== undefined && row[i] !== undefined) ? row[i].toString().trim() : ''; };
  const skuMap = {}; let ri = 0;

  for (const row of dataRows) {
    const prod = get(row, 'product');
    const rawSku = get(row, 'sku') || prod || ('item_' + ri++);
    const skuId = rawSku.substring(0, 60);
    if (!skuId) continue;

    const unitsSold = pNum(get(row, 'unitsSold'));
    const vel = pNum(get(row, 'velocity'));
    const avail = pNum(get(row, 'available'));
    const inbound = pNum(get(row, 'inbound'));
    const reserved = pNum(get(row, 'reserved'));
    const price = pNum(get(row, 'price'));
    const cost = pNum(get(row, 'cost'));
    const lt = pNum(get(row, 'leadTime'));
    const period = get(row, 'period');
    const wh = get(row, 'warehouse') || '—';
    const mom = map.momTrend !== undefined ? pSigned(get(row, 'momTrend')) : null;
    const seas = map.seasonalIndex !== undefined ? pNum(get(row, 'seasonalIndex')) : null;

    if (!skuMap[skuId]) {
      skuMap[skuId] = {
        sku: skuId, product: (prod || skuId).substring(0, 80),
        price, cost, available: avail, inbound, reserved, leadTime: lt || 30,
        unitsSold30: unitsSold, dailyVelocity: vel,
        reorderQty: pNum(get(row, 'reorderQty')),
        safetyStock: pNum(get(row, 'safetyStock')),
        reorderPoint: pNum(get(row, 'reorderPoint')),
        momTrend: mom, seasonalIndex: seas,
        category: get(row, 'category') || 'General',
        brand: get(row, 'brand') || '—',
        warehouse: wh,
        channel: get(row, 'channel') || '—',
        batchLot: get(row, 'batchLot') || '',
        uom: get(row, 'unitOfMeasure') || 'Units',
        periods: [], _warehouses: new Set([wh]),
      };
    } else {
      const e = skuMap[skuId];
      if (price > 0 && e.price === 0) e.price = price;
      if (cost > 0 && e.cost === 0) e.cost = cost;
      if (lt > 0 && e.leadTime === 30) e.leadTime = lt;
      if (period) { if (avail > 0) e.available = Math.max(e.available, avail); }
      else {
        if (!e._warehouses.has(wh)) { e.available += avail; e.inbound += inbound; e.reserved += reserved; e.unitsSold30 += unitsSold; e.dailyVelocity += vel; e._warehouses.add(wh); }
        else { e.available = Math.max(e.available, avail); }
      }
    }
    if (period && unitsSold >= 0) skuMap[skuId].periods.push({ period: normalisePeriod(period), unitsSold });
  }

  const isTS = Object.values(skuMap).some(s => s.periods.length >= 2);
  if (isTS) for (const s of Object.values(skuMap)) s.periods.sort((a, b) => (new Date(a.period) - new Date(b.period)) || a.period.localeCompare(b.period));
  for (const s of Object.values(skuMap)) { s.warehouseCount = s._warehouses ? s._warehouses.size : 1; delete s._warehouses; }
  return { skuMap, isTS };
}

function normalisePeriod(raw) {
  if (!raw) return raw;
  const s = raw.toString().trim();
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) return `${dmy[3].length === 2 ? '20' + dmy[3] : dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const my = s.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (my) return `${my[2]}-${my[1].padStart(2, '0')}-01`;
  const mon = s.match(/^([A-Za-z]{3})[\s\-](\d{2,4})$/);
  if (mon) { const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' }; const m = months[mon[1].toLowerCase()]; if (m) return `${mon[2].length === 2 ? '20' + mon[2] : mon[2]}-${m}-01`; }
  const qtr = s.match(/Q(\d)\s*(?:FY)?(\d{2,4})/i);
  if (qtr) { const qMonth = { '1': '04', '2': '07', '3': '10', '4': '01' }; return `${qtr[2].length === 2 ? '20' + qtr[2] : qtr[2]}-${qMonth[qtr[1]] || '01'}-01`; }
  return s;
}

// ═══ FORECASTING CORE ════════════════════════════════════════════════════════
function detectGapDays(periods) {
  const ds = periods.map(p => new Date(p.period)).filter(d => !isNaN(d.getTime()));
  if (ds.length >= 2) {
    const gaps = [];
    for (let i = 1; i < ds.length; i++) { const g = (ds[i] - ds[i - 1]) / 86400000; if (g > 0) gaps.push(g); }
    if (gaps.length) { gaps.sort((a, b) => a - b); const med = gaps[Math.floor(gaps.length / 2)]; if (med >= 0.5) return med; }
  }
  if (periods.some(p => /W\d/i.test(p.period))) return 7;
  return 30;
}
function gapLabel(g) { return g < 2 ? 'daily' : g < 10 ? 'weekly' : g < 45 ? 'monthly' : g < 135 ? 'quarterly' : 'yearly'; }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function linreg(y) {
  const n = y.length; if (n < 2) return { a: y[0] || 0, b: 0 };
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += y[i]; sxx += i * i; sxy += i * y[i]; }
  const denom = n * sxx - sx * sx;
  const b = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  return { a: (sy - b * sx) / n, b };
}
function seasonalIndices(y, m) {
  if (y.length < 2 * m) return null;
  const overall = mean(y); if (overall <= 0) return null;
  const idx = Array(m).fill(0), cnt = Array(m).fill(0);
  for (let i = 0; i < y.length; i++) { idx[i % m] += y[i]; cnt[i % m]++; }
  const s = idx.map((v, i) => (cnt[i] ? (v / cnt[i]) / overall : 1));
  const avg = mean(s); return s.map(v => avg ? v / avg : 1);
}
function buildForecaster(demands, method) {
  const n = demands.length;
  const ma = mean(demands.slice(-Math.min(3, n)));
  let lvl = demands[0]; const alpha = 0.4;
  for (let i = 1; i < n; i++) lvl = alpha * demands[i] + (1 - alpha) * lvl;
  const { a, b } = linreg(demands); const lastIdx = n - 1;
  const holt = (k) => Math.max(0, (a + b * (lastIdx + k)));
  let season = null, m = 0;
  for (const cand of [12, 7, 4]) { const s = seasonalIndices(demands, cand); if (s) { season = s; m = cand; break; } }
  const base = {
    'Moving Average': () => ma,
    'Exponential Smoothing': () => Math.max(0, lvl),
    'Trend + Seasonality': (k) => holt(k),
    'ML Ensemble': (k) => Math.max(0, (ma + Math.max(0, lvl) + holt(k)) / 3),
  };
  let fn;
  if (method === 'Auto' || !base[method]) {
    const slopeShare = ma > 0 ? Math.abs(b) / ma : 0;
    fn = (n >= 4 && slopeShare > 0.03) ? holt : (n >= 3 ? () => Math.max(0, lvl) : () => ma);
  } else fn = base[method];
  if (season) { const bf = fn; fn = (k) => bf(k) * season[(lastIdx + k) % m]; }
  return { f: (k) => Math.max(0, fn(k)), slope: b, level: Math.max(0, lvl), ma, seasonal: !!season };
}
function backtestMape(demands, method) {
  const n = demands.length; if (n < 4) return null;
  let errs = 0, cnt = 0;
  for (let t = Math.max(3, Math.floor(n / 2)); t < n; t++) {
    const fc = buildForecaster(demands.slice(0, t), method).f(1);
    const act = demands[t];
    if (act > 0) { errs += Math.abs(fc - act) / act; cnt++; }
  }
  return cnt ? Math.round((errs / cnt) * 100) : null;
}
function demandOverDays(forecaster, D, gap, dayMult) {
  let total = 0, used = 0, k = 1;
  while (used < D && k < 5000) {
    const daysThis = Math.min(gap, D - used);
    let segMult = 1;
    if (dayMult) { let sm = 0; for (let dd = 0; dd < daysThis; dd++) sm += dayMult(used + dd); segMult = daysThis ? sm / daysThis : 1; }
    total += forecaster.f(k) * (daysThis / gap) * segMult;
    used += daysThis; k++;
  }
  return Math.max(0, Math.round(total));
}

// ─── COMPUTE ENGINE ───────────────────────────────────────────────────────────
function computeSKU(s, isTS, today, sym, horizDays, method, salesWindow, map, opts) {
  opts = opts || {};
  const qcom = !!opts.qcom;
  const applyFestival = !!opts.applyFestival;
  const defaultLT = qcom ? 2 : 30;
  const lt = s.leadTime > 0 ? s.leadTime : defaultLT;
  const catBucket = classifyCategory(s.category);
  const dayMult = (off) => applyFestival ? indiaDayMultiplier(addDays(today, off), catBucket, qcom) : 1;
  const unitCost = s.cost > 0 ? s.cost : (s.price || 0);   // valuation basis
  const sellPrice = s.price > 0 ? s.price : unitCost;       // revenue basis
  const marginPerUnit = (s.price > 0 && s.cost > 0) ? Math.round((sellPrice - unitCost) * 100) / 100 : 0;

  let dailyVel = 0, avgMonthly = 0, trend = 'flat', trendPct = 'n/a', conf = 'Low';
  let nextH = 0, next30 = 0, next60 = 0, next90 = 0, mape = null;
  let periodGranularity = isTS ? 'unknown' : 'snapshot';
  let forecaster = null, gap = 30;

  if (isTS && s.periods.length >= 2) {
    const demands = s.periods.map(p => p.unitsSold).filter(d => d >= 0);
    const n = demands.length;
    gap = detectGapDays(s.periods);
    periodGranularity = gapLabel(gap);
    const perPeriodMean = mean(demands);
    avgMonthly = Math.round(perPeriodMean * (30 / gap) * 10) / 10;
    if (n >= 4) {
      const { b } = linreg(demands);
      const pct = perPeriodMean > 0 ? (b * (n - 1) / perPeriodMean) * 100 : 0;
      trend = pct > 8 ? 'up' : pct < -8 ? 'down' : 'flat';
      trendPct = (pct >= 0 ? '+' : '') + Math.round(pct) + '%';
    }
    forecaster = buildForecaster(demands, method);
    mape = backtestMape(demands, method);
    dailyVel = forecaster.f(1) / gap;
    if (mape != null) conf = mape <= 15 ? 'High' : mape <= 30 ? 'Medium' : 'Low';
    else if (n > 1 && perPeriodMean > 0) {
      const variance = demands.map(d => Math.pow(d - perPeriodMean, 2)).reduce((x, y) => x + y, 0) / (n - 1);
      const cv = Math.sqrt(variance) / perPeriodMean; conf = cv < 0.15 ? 'High' : cv < 0.35 ? 'Medium' : 'Low';
    } else conf = n >= 3 ? 'Medium' : 'Low';
  } else {
    // Snapshot: base run-rate, plus optional file-provided MoM trend + seasonal index.
    const baseDaily = s.dailyVelocity > 0 ? s.dailyVelocity : (s.unitsSold30 > 0 ? s.unitsSold30 / salesWindow : 0);
    const base30 = baseDaily * 30;
    const g = (s.momTrend != null && isFinite(s.momTrend)) ? Math.max(-0.3, Math.min(0.3, s.momTrend)) : 0;       // ±30%/mo cap
    const seas = (s.seasonalIndex != null && s.seasonalIndex > 0) ? Math.max(0.4, Math.min(2.5, s.seasonalIndex)) : 1;
    gap = 30;
    forecaster = { f: (k) => base30 * seas * Math.min(3, Math.pow(1 + g, Math.min(k - 1, 6))) };  // capped compounding
    avgMonthly = Math.round(base30 * 10) / 10;
    dailyVel = forecaster.f(1) / 30;
    trend = g > 0.02 ? 'up' : g < -0.02 ? 'down' : 'flat';
    trendPct = s.momTrend != null ? ((g >= 0 ? '+' : '') + Math.round(g * 100) + '%/mo') : 'n/a';
    conf = baseDaily > 0 ? (s.momTrend != null || s.seasonalIndex != null ? 'File trend/season' : 'Velocity-based') : 'Low (no sales)';
  }

  nextH = demandOverDays(forecaster, horizDays, gap, dayMult);
  next30 = demandOverDays(forecaster, 30, gap, dayMult);
  next60 = demandOverDays(forecaster, 60, gap, dayMult);
  next90 = demandOverDays(forecaster, 90, gap, dayMult);

  // ── India seasonal intensity: average uplift over the horizon and the near-term (lead-time) window ──
  let seasonalUplift = 1, nearMult = 1, peakEvent = null;
  if (applyFestival) {
    let hs = 0; for (let d = 0; d < horizDays; d++) hs += dayMult(d); seasonalUplift = horizDays ? hs / horizDays : 1;
    const nearWin = Math.max(lt, qcom ? 7 : 14);
    let ns = 0; for (let d = 0; d < nearWin; d++) ns += dayMult(d); nearMult = nearWin ? ns / nearWin : 1;
    peakEvent = peakEventInWindow(today, horizDays, catBucket, qcom);
    seasonalUplift = Math.round(seasonalUplift * 100) / 100;
    nearMult = Math.round(nearMult * 100) / 100;
  }
  const effVel = dailyVel * nearMult;   // festive-adjusted near-term daily demand (drives cover, reorder, risk)

  const currentStock = s.available || 0;
  const netStock = currentStock + (s.inbound || 0) - (s.reserved || 0);
  const daysOfCover = effVel > 0 ? Math.round(Math.max(0, netStock) / effVel) : (netStock > 0 ? 999 : 0);
  const weeksOfSupply = Math.round(daysOfCover / 7 * 10) / 10;

  let sigmaDaily = 0;
  if (isTS && s.periods.length >= 2) {
    const demands = s.periods.map(p => p.unitsSold); const mu = mean(demands);
    const variance = demands.map(d => Math.pow(d - mu, 2)).reduce((x, y) => x + y, 0) / Math.max(1, demands.length - 1);
    sigmaDaily = Math.sqrt(variance) / gap;
  } else sigmaDaily = dailyVel * 0.4;

  const z = qcom ? 2.05 : 1.65;   // q-commerce holds a higher (98%) service level
  const safetyStock = s.safetyStock > 0 ? s.safetyStock : Math.ceil(z * sigmaDaily * Math.sqrt(lt));
  const reorderPoint = s.reorderPoint > 0 ? s.reorderPoint : Math.ceil(effVel * lt + safetyStock);
  const target = Math.ceil(effVel * (horizDays + lt) + safetyStock);
  const orderQty = s.reorderQty > 0 ? s.reorderQty : Math.max(0, target - Math.max(0, netStock));

  let reorderBy = 'OK';
  if (currentStock === 0 && !(s.inbound) && dailyVel > 0) reorderBy = 'REORDER NOW';
  else { const d2r = Math.max(0, daysOfCover - lt);
    if (d2r <= 0 && dailyVel > 0) reorderBy = 'REORDER NOW';
    else if (d2r <= 7 && dailyVel > 0) reorderBy = 'This Week';
    else if (dailyVel > 0) { const d = new Date(today); d.setDate(d.getDate() + d2r); reorderBy = d.toLocaleDateString('en-GB'); }
  }

  let priority = 'LOW';
  if (currentStock === 0 && !(s.inbound) && dailyVel > 0) priority = 'URGENT';
  else if (daysOfCover < lt && dailyVel > 0) priority = 'HIGH';
  else if (daysOfCover < lt * 2 && dailyVel > 0) priority = 'MEDIUM';

  const stockoutDays = effVel > 0 ? Math.min(999, Math.round(Math.max(0, netStock) / effVel)) : 999;
  let stockoutProb;
  if (dailyVel <= 0) stockoutProb = 0;
  else { const muLT = effVel * lt; const sdLT = Math.max(1e-6, sigmaDaily * Math.sqrt(lt));
    stockoutProb = Math.max(0, Math.min(100, Math.round(100 * (1 - normalCdf((Math.max(0, netStock) - muLT) / sdLT))))); }

  const revenueAtRisk = effVel > 0 && sellPrice > 0 ? Math.round(Math.max(0, horizDays - stockoutDays) * effVel * sellPrice * (stockoutProb / 100)) : 0;
  const invValue = Math.round(currentStock * unitCost);
  const isActive = avgMonthly > 0.05;
  const isSlowMover = dailyVel > 0 && dailyVel < 1 && currentStock > 30;
  const isDead = dailyVel === 0 && currentStock > 0;
  const isOverstock = daysOfCover > 120 && isActive;
  const isHealthy = !isDead && !isOverstock && daysOfCover >= 30 && daysOfCover <= 120 && isActive;
  const fillRate = avgMonthly > 0 ? Math.min(100, Math.round((Math.min(currentStock, avgMonthly) / avgMonthly) * 100)) : (currentStock > 0 ? 100 : 0);
  const invTurnover = currentStock > 0 ? Math.round((avgMonthly * 12 / currentStock) * 10) / 10 : 0;
  const inventoryAge = dailyVel > 0 && currentStock > 0 ? Math.round(currentStock / dailyVel) : 0;
  const excessValue = dailyVel > 0 ? Math.round(Math.max(0, daysOfCover - 90) * dailyVel * unitCost) : 0;

  return {
    sku: s.sku, product: s.product, category: s.category, brand: s.brand,
    warehouse: s.warehouse, warehouseCount: s.warehouseCount || 1, channel: s.channel, uom: s.uom, batchLot: s.batchLot,
    price: sellPrice, unitCost, marginPerUnit, currentStock, inbound: s.inbound || 0, reserved: s.reserved || 0, netStock,
    avgMonthlyDemand: Math.round(avgMonthly), dailyVelocity: Math.round(dailyVel * 100) / 100,
    festiveDailyVelocity: Math.round(effVel * 100) / 100, seasonalUplift, nearTermUplift: nearMult, peakEvent, categoryBucket: catBucket,
    nextH, next30, next60, next90, trend, trendPct, confidence: conf, mape,
    periodGranularity, forecastMethod: method,
    daysOfCover, weeksOfSupply, safetyStock, reorderPoint, eoq: orderQty, orderQty, reorderBy,
    priority, leadTimeDays: lt, needsReorder: orderQty > 0 && isActive,
    stockoutDays, stockoutProb, revenueAtRisk, invValue,
    isSlowMover, isDead, isOverstock, isHealthy, isActive,
    invTurnover, inventoryAge, fillRate, excessValue,
    slowMoverRisk: invValue > 5000 ? 'HIGH' : invValue > 1000 ? 'MEDIUM' : 'LOW',
    slowAction: invValue > 5000 ? 'Markdown / Bundle / Liquidate' : invValue > 1000 ? 'Hold — avoid reorder' : 'Monitor',
  };
}

// ─── PLANNING-LEVEL ROLL-UP ───────────────────────────────────────────────────
function buildGroups(results, level) {
  const keyMap = { Brand: 'brand', Category: 'category', Warehouse: 'warehouse', 'Dark Store': 'warehouse', City: 'warehouse', Marketplace: 'channel', Country: 'channel' };
  const key = keyMap[level];
  if (!key || level === 'SKU') return null;
  const g = {};
  for (const r of results) {
    const k = (r[key] && r[key] !== '—') ? r[key] : 'Unspecified';
    if (!g[k]) g[k] = { group: k, dimension: level, skus: 0, activeSKUs: 0, avgMonthlyDemand: 0, nextH: 0, invValue: 0, revenueAtRisk: 0, urgent: 0 };
    const e = g[k];
    e.skus++; if (r.isActive) e.activeSKUs++;
    e.avgMonthlyDemand += r.avgMonthlyDemand; e.nextH += r.nextH;
    e.invValue += r.invValue; e.revenueAtRisk += r.revenueAtRisk;
    if (r.priority === 'URGENT' || r.priority === 'HIGH') e.urgent++;
  }
  return Object.values(g).map(e => ({ ...e, avgMonthlyDemand: Math.round(e.avgMonthlyDemand), nextH: Math.round(e.nextH), invValue: Math.round(e.invValue), revenueAtRisk: Math.round(e.revenueAtRisk) })).sort((a, b) => b.nextH - a.nextH).slice(0, 60);
}


// ═══ INDIA FESTIVE-SALE DEMAND CALENDAR (baked in — no external API) ═══════════
// Recurring annual sale/festival windows. month is 1-based for readability.
// base = baseline demand multiplier for that window; cats = category overrides.
const QCOM_CHANNELS = ['Blinkit', 'Zepto', 'Swiggy Instamart', 'Instamart', 'BigBasket', 'BBNow', 'Flipkart Minutes', 'Amazon Fresh', 'Zepto Cafe', 'Dunzo', 'JioMart'];
const INDIA_EVENTS = [
  { key: 'republic',  name: 'Republic Day Sale',                          s: [1, 18],  e: [1, 26],  base: 1.6, cats: { electronics: 2.1, appliances: 2.2, mobiles: 2.0, fashion: 1.4 } },
  { key: 'valentine', name: "Valentine's / Spring Sale",                  s: [2, 7],   e: [2, 14],  base: 1.3, cats: { beauty: 1.7, fashion: 1.5, gifting: 1.9 } },
  { key: 'holi',      name: 'Holi',                                       s: [3, 1],   e: [3, 8],   base: 1.3, cats: { beauty: 1.6, fashion: 1.4, fmcg: 1.5 } },
  { key: 'summer',    name: 'Summer / Akshaya Tritiya',                   s: [4, 20],  e: [5, 10],  base: 1.3, cats: { appliances: 1.9, jewellery: 1.8, fashion: 1.4 } },
  { key: 'eors',      name: 'Myntra EORS / Summer Sale',                  s: [5, 28],  e: [6, 14],  base: 1.7, cats: { fashion: 2.3, footwear: 2.1, beauty: 1.8 } },
  { key: 'freedom',   name: 'Independence Day / Freedom Sale',            s: [8, 6],   e: [8, 16],  base: 1.8, cats: { electronics: 2.3, appliances: 2.2, mobiles: 2.2, fashion: 1.5 } },
  { key: 'rakhi',     name: 'Raksha Bandhan / Onam',                      s: [8, 22],  e: [8, 30],  base: 1.5, cats: { gifting: 2.2, fashion: 1.7, fmcg: 1.5, jewellery: 1.8 } },
  { key: 'ganesh',    name: 'Ganesh Chaturthi',                           s: [9, 5],   e: [9, 17],  base: 1.4, cats: { fmcg: 1.6, gifting: 1.7 } },
  { key: 'bbd',       name: 'Big Billion Days / Great Indian Festival',   s: [9, 20],  e: [10, 8],  base: 3.0, cats: { mobiles: 5.0, electronics: 4.5, appliances: 4.0, fashion: 3.0, footwear: 2.8, beauty: 2.5, home: 2.6 } },
  { key: 'navratri',  name: 'Navratri / Dussehra',                        s: [10, 9],  e: [10, 22], base: 2.2, cats: { fashion: 2.7, jewellery: 2.5, footwear: 2.2, appliances: 2.0 } },
  { key: 'diwali',    name: 'Diwali / Dhanteras Festive',                 s: [10, 23], e: [11, 12], base: 3.4, cats: { jewellery: 5.0, appliances: 4.5, electronics: 4.0, mobiles: 4.2, fashion: 3.2, gifting: 4.0, fmcg: 2.6, home: 3.0 } },
  { key: 'wedding',   name: 'Wedding Season',                             s: [11, 13], e: [12, 20], base: 1.6, cats: { jewellery: 2.6, fashion: 2.1, footwear: 1.8, beauty: 1.7 } },
  { key: 'yearend',   name: 'Christmas / New Year',                       s: [12, 21], e: [12, 31], base: 1.5, cats: { gifting: 2.0, fmcg: 1.6, beauty: 1.6 } },
];

function ord(m, d) { return m * 100 + d; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function eventForDate(date) {
  const o = ord(date.getMonth() + 1, date.getDate());
  for (const ev of INDIA_EVENTS) {
    const a = ord(ev.s[0], ev.s[1]), b = ord(ev.e[0], ev.e[1]);
    const inWin = a <= b ? (o >= a && o <= b) : (o >= a || o <= b);
    if (inWin) return ev;
  }
  return null;
}
function classifyCategory(cat) {
  const c = (cat || '').toString().toLowerCase();
  if (/mobile|smartphone|\bphone\b|tablet/.test(c)) return 'mobiles';
  if (/electronic|laptop|computer|\btv\b|television|audio|headphone|earbud|camera|gadget|gaming/.test(c)) return 'electronics';
  if (/appliance|refrigerator|fridge|washing|microwave|\bac\b|air ?cond|cooler|geyser|chimney/.test(c)) return 'appliances';
  if (/jewel|jewellery|jewelry|\bgold\b|silver|diamond/.test(c)) return 'jewellery';
  if (/footwear|shoe|sneaker|sandal|slipper|heel/.test(c)) return 'footwear';
  if (/fashion|apparel|cloth|garment|\bwear\b|kurta|saree|sari|shirt|dress|ethnic|t-?shirt|jeans|lehenga|denim/.test(c)) return 'fashion';
  if (/beauty|cosmetic|makeup|skincare|skin care|personal care|fragrance|perfume|grooming|haircare/.test(c)) return 'beauty';
  if (/grocery|food|bever|fmcg|snack|staple|atta|\brice\b|dairy|household|cleaning|\btea\b|coffee|dry fruit|sweet|masala|oil/.test(c)) return 'fmcg';
  if (/gift|\btoy\b|stationery|decor|festive|pooja|puja|diya|candle|rangoli|cracker/.test(c)) return 'gifting';
  if (/home|furniture|kitchen|cookware|bedding|furnish|utensil|appliance/.test(c)) return 'home';
  return 'default';
}
function indiaDayMultiplier(date, cat, qcom) {
  const ev = eventForDate(date);
  let mult = 1;
  if (ev) mult = (ev.cats && ev.cats[cat] != null) ? ev.cats[cat] : ev.base;
  if (qcom) {
    // Quick commerce (10-min grocery/essentials): festive spikes are real but far smaller
    // than marketplace big-ticket spikes — dampen, but keep grocery/gifting/beauty meaningful.
    const keepHard = (cat === 'fmcg' || cat === 'gifting' || cat === 'beauty');
    mult = 1 + (mult - 1) * (keepHard ? 0.6 : 0.3);
    const dow = date.getDay();                  // strong weekly rhythm
    if (dow === 0 || dow === 6) mult *= 1.22;   // weekend surge
    else if (dow === 5) mult *= 1.08;           // Friday pull-forward
  }
  return mult;
}
function peakEventInWindow(today, horizDays, cat, qcom) {
  let best = null, bestM = 1.0;
  for (let d = 0; d < horizDays; d++) {
    const date = addDays(today, d), ev = eventForDate(date);
    if (!ev) continue;
    const m = indiaDayMultiplier(date, cat, qcom);
    if (m > bestM + 0.01) { bestM = m; best = ev.name; }
  }
  return best;
}
function fmtWin(s, e) { const o = { day: 'numeric', month: 'short' }; return s.toLocaleDateString('en-GB', o) + ' – ' + e.toLocaleDateString('en-GB', o); }
function eventRecommendation(ev, live, daysAway) {
  const big = Math.max(ev.base, ...Object.values(ev.cats || {}));
  if (live) return 'Live now — protect availability: keep buffer stock high, watch fast-movers daily and expedite inbound.';
  if (daysAway <= 20) return 'Final window — place POs for in-stock SKUs now; lock in safety stock and confirm inbound ETAs.';
  if (daysAway <= 45) return 'Pre-build now for ' + (big >= 3 ? 'a 3–5x' : 'a 1.5–2x') + ' demand surge. Raise POs for 30-day-lead suppliers this week.';
  if (daysAway <= 90) return 'Plan POs and negotiate supplier capacity; begin demand sensing for high-velocity SKUs.';
  return "On the radar — review last year's sell-through and shortlist hero SKUs.";
}
function upcomingIndiaEvents(today) {
  const out = [];
  for (const ev of INDIA_EVENTS) {
    let occ = null;
    for (const yr of [today.getFullYear(), today.getFullYear() + 1]) {
      const start = new Date(yr, ev.s[0] - 1, ev.s[1]);
      const end = new Date(yr, ev.e[0] - 1, ev.e[1]);
      if (today <= end) { occ = { start, end }; break; }
    }
    if (!occ) continue;
    const live = today >= occ.start && today <= occ.end;
    const daysAway = live ? 0 : Math.max(0, Math.round((occ.start - today) / 86400000));
    const cats = ev.cats || {};
    const topCats = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]);
    const peak = Math.max(ev.base, ...Object.values(cats));
    out.push({
      event: ev.name,
      window: fmtWin(occ.start, occ.end),
      daysAway, live,
      uplift: '~' + (Math.round(ev.base * 10) / 10) + 'x' + (peak > ev.base ? (' (up to ' + (Math.round(peak * 10) / 10) + 'x ' + (topCats[0] || '') + ')') : ''),
      topCategories: topCats,
      recommendation: eventRecommendation(ev, live, daysAway),
    });
  }
  return out.filter(e => e.live || e.daysAway <= 230).sort((a, b) => a.daysAway - b.daysAway);
}

function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function pNum(v) { if (!v && v !== 0) return 0; const n = parseFloat(v.toString().replace(/[$£€₹,\s]/g, '').replace(/[^\d.-]/g, '')); return isNaN(n) || n < 0 ? 0 : n; }
function pSigned(v) { if (v == null || v === '') return null; const str = v.toString().replace(/[$£€₹,\s%]/g, ''); const n = parseFloat(str.replace(/[^\d.\-]/g, '')); return isNaN(n) ? null : n; }
