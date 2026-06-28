// /api/forecast.js — LogicstIQ AI Demand Planner v4
// Supports: All E-Commerce, Quick Commerce + All Major ERPs globally
// Gemini key stays server-side — users never see it
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '25mb',
    },
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not set in Vercel Environment Variables.' });

  const { csvText, horizon, currency, region, channels, planLevel, erpSource } = req.body || {};
  if (!csvText || csvText.trim().length < 10) return res.status(400).json({ error: 'No data received. Please upload a valid file.' });

  const sym = currency || '₹';
  const horizDays = parseInt(horizon) || 90;

  // Parse CSV with smart header detection
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
  const results = skuList.map(s => computeSKU(s, isTS, today, sym, horizDays));

  const active = results.filter(s => s.isActive);
  const pOrd = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

  const demandForecast = results.filter(s => s.isActive).sort((a, b) => b.avgMonthlyDemand - a.avgMonthlyDemand).slice(0, 100);
  const reorderPlan = results.filter(s => s.needsReorder).sort((a, b) => (pOrd[a.priority] || 3) - (pOrd[b.priority] || 3)).slice(0, 60);
  const slowMoversAll = results.filter(s => s.isSlowMover || s.isDead).sort((a, b) => b.invValue - a.invValue).slice(0, 50);
  const stockoutRisk = results.filter(s => s.stockoutProb > 30).sort((a, b) => b.stockoutProb - a.stockoutProb).slice(0, 30);

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
    avgDoC: active.length ? Math.round(active.reduce((a, r) => a + Math.min(r.daysOfCover, 365), 0) / active.length) : 0,
    isTS, erpSource: erpSource || 'auto',
    detectedColumns: Object.keys(map).join(', '),
  };

  // Gemini narrative
  const narrativePrompt = `You are a world-class supply chain AI analyst. Write ONLY the insights JSON.

RULES:
1. Use ONLY numbers from the JSON below — do not invent anything.
2. Return ONLY valid JSON — no markdown, no backticks.
3. Write exactly 6 insights: stockout urgency, dead stock, working capital, ERP data quality observation, quick commerce or seasonality opportunity, strategic recommendation.
4. Each insight: specific, data-backed, one sentence.
5. type: green/orange/red/blue/purple.

REPORT: ${JSON.stringify({ totalSKUs: summary.totalSKUs, activeSKUs: summary.activeSKUs, healthySKUs: summary.healthySKUs, deadSKUs: summary.deadSKUs, overstockSKUs: summary.overstockSKUs, urgentSKUs: summary.urgentSKUs, totalInventoryValue: sym + Math.round(summary.totalInvValue).toLocaleString(), revenueAtRisk: sym + Math.round(summary.totalAtRisk).toLocaleString(), excessCapitalTied: sym + Math.round(summary.totalExcess).toLocaleString(), avgDaysOfCover: summary.avgDoC + ' days', channels: (channels || []).join(', '), region, horizon, erpSource })}

TOP 5 URGENT: ${JSON.stringify(reorderPlan.slice(0, 5).map(r => ({ product: r.product, stock: r.currentStock, priority: r.priority, reorderBy: r.reorderBy })))}
TOP 3 DEAD: ${JSON.stringify(slowMoversAll.filter(r => r.isDead).slice(0, 3).map(r => ({ product: r.product, value: sym + Math.round(r.invValue).toLocaleString() })))}

Return EXACTLY: {"insights":[{"type":"green|orange|red|blue|purple","icon":"emoji","text":"sentence"}]}`;

  let insights = [
    { type: 'red', icon: '🚨', text: `${summary.urgentSKUs} SKUs need immediate reorders — act now to prevent stockouts and lost revenue.` },
    { type: 'orange', icon: '📦', text: `${summary.deadSKUs} dead-stock SKUs are tying up capital — consider markdowns or liquidation.` },
    { type: 'blue', icon: '📊', text: `Average days of cover is ${summary.avgDoC} days across ${summary.activeSKUs} active SKUs. Healthy target: 30–90 days.` },
    { type: 'green', icon: '✅', text: `${summary.healthySKUs} SKUs are in healthy stock range — maintain current replenishment cadence.` },
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

  return res.status(200).json({ summary, demandForecast, reorderPlan, slowMoversAll, stockoutRisk, allSKUs: results, insights });
}

// ─── SMART CSV PARSER — skips ERP junk header rows ───────────────────────────
function parseCSVSmart(text, erpSource) {
  const allRows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    // Support both comma-delimited and tab-delimited files
    allRows.push(t.includes('\t') && !t.includes(',') ? t.split('\t').map(x=>x.trim()) : parseCSVLine(t));
  }
  if (!allRows.length) return [];

  // Known ERP header keywords to skip
  const junkPatterns = [/^(company|organisation|organization|report|date|time|printed|generated|from|to|period|branch|financial year|fy|gst|gstin|pan|currency|page|sr\.?\s*no\.?$)/i, /^\d{2}[\/\-]\d{2}[\/\-]\d{4}$/, /^(tally|sap|oracle|netsuite|microsoft|dynamics|busy|marg|zoho|quickbooks|odoo|infor)/i];

  // Find the first row that looks like a real header
  let headerIdx = 0;
  const dataKeywords = ['sku', 'asin', 'product', 'item', 'stock', 'qty', 'quantity', 'units', 'sales', 'available', 'inbound', 'price', 'cost', 'category', 'brand', 'description', 'material', 'part', 'code', 'name', 'article', 'variant', 'closing', 'opening', 'velocity', 'demand', 'warehouse', 'location', 'bin', 'batch', 'serial'];

  for (let i = 0; i < Math.min(allRows.length, 15); i++) {
    const rowText = allRows[i].join(' ').toLowerCase();
    const matchCount = dataKeywords.filter(k => rowText.includes(k)).length;
    if (matchCount >= 2) { headerIdx = i; break; }
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

// ─── COMPREHENSIVE COLUMN MAPPER — covers all ERPs + marketplaces ─────────────
function mapColumns(headers, erpSource) {
  const syn = {
    sku: [
      // Generic
      'sku','sku id','sku code','item id','item code','item number','product code','product id',
      'part no','part number','part no.','article no','article code','article number',
      'stock code','stock id','material code','material number','material id',
      // Amazon
      'merchant sku','seller sku','asin','fnsku','barcode','upc','ean','isbn',
      // SAP
      'material','matnr','material number','article','article number',
      // Tally / Busy / Marg
      'stock item','stock item name','item name','godown item','voucher item',
      // NetSuite / Dynamics
      'internal id','item internal id','inventory item','assembly item',
      // Cin7 / Linnworks / Brightpearl
      'product reference','reference','sku reference','variant sku',
      // Unicommerce / Increff
      'skucode','sku_code','item_code','style code','style_code','color size sku',
      // Flipkart / Myntra / Meesho
      'listing id','fsn','product sku','vendor sku','seller article id',
      // Shopify
      'variant id','product variant','shopify sku',
      // Odoo
      'internal reference','default code',
    ],
    product: [
      'product name','product','description','title','item name','item description',
      'product description','product title','name','display name','item','goods',
      // SAP
      'material description','material text','short text','long text',
      // Tally
      'stock item name','item name','particulars','narration',
      // NetSuite
      'display name/code','salesdescription','purchase description',
      // Dynamics
      'product name','item name','released product',
      // Cin7
      'product name','option 1 value','option 2 value',
      // Unicommerce
      'item type name','channel product name','product listing name',
      // Myntra / Meesho
      'product name','article name','style name',
      // Odoo
      'product','product name','internal notes',
    ],
    period: [
      'date','month','week','period','year','quarter',
      'order date','sale date','sales month','sales period','reporting period',
      'posting date','document date','billing date','invoice date',
      'transaction date','movement date','fiscal period','accounting period',
      'dispatch date','shipment date','fy','financial year','month year',
    ],
    price: [
      'price','unit price','selling price','sale price','mrp','asp','rate',
      'item price','cost price','standard cost','moving average price',
      // SAP
      'standard price','moving avg price','valuation price','map',
      // Tally
      'rate','sales rate','purchase rate','selling rate',
      // NetSuite
      'base price','online price','msrp',
      // Dynamics
      'unit cost','sales price','purchase price',
      // Amazon
      'your price','sale price','buy box price',
      // Flipkart / Myntra
      'mrp','selling price','your selling price','discounted price',
      // Shopify
      'price','compare at price','variant price',
    ],
    unitsSold: [
      'units sold','qty sold','quantity sold','sales qty','sales quantity',
      'units sold last 30 days','units sold 30d','sales last 30 days',
      'demand','monthly demand','monthly sales','daily sales','sales units',
      'sold qty','items sold','pieces sold','qty dispatched','dispatched qty',
      // SAP
      'sales quantity','delivery quantity','billed quantity','issued quantity',
      // Tally
      'sales qty','outward qty','consumption qty','issue qty',
      // NetSuite
      'quantity sold','units sold','quantity fulfilled',
      // Dynamics
      'sales quantity','shipped quantity','invoiced quantity',
      // Cin7 / Linnworks
      'quantity sold','total sold','units ordered','order quantity',
      // Unicommerce
      'dispatched quantity','shipped quantity','fulfilled quantity',
      // Shopify
      'net quantity','total sales','units ordered',
    ],
    velocity: [
      'daily velocity','velocity','daily demand','avg daily sales',
      'daily run rate','run rate','units per day','sales per day',
      'average daily demand','add','average daily usage','adu',
      // SAP
      'average consumption','avg consumption','planned consumption',
      // Tally / Busy
      'daily avg','average daily sales',
      // NetSuite
      'average daily demand','daily demand rate',
    ],
    available: [
      'available','on hand','qty available','stock','in stock','current stock',
      'closing stock','closing balance','closing qty','closing quantity',
      'sellable units','fulfillable qty','warehouse stock','physical stock',
      'net stock','usable stock','unrestricted stock','free stock',
      // SAP
      'unrestricted','unrestricted stock','available quantity','mmbe stock',
      'plant stock','storage location stock','shelf stock',
      // Tally / Busy / Marg
      'closing stock','closing balance','current stock','godown stock',
      'current balance','stock in hand',
      // NetSuite
      'quantity on hand','quantity available','available quantity',
      'location qty on hand','preferred location qty on hand',
      // Dynamics
      'on-hand inventory','physical inventory','available physical',
      'on hand quantity','available quantity',
      // Cin7 / Brightpearl
      'available stock','in stock','quantity on hand','warehouse quantity',
      // Unicommerce
      'inventory on hand','available inventory','sellable inventory',
      'good inventory','shelf inventory',
      // Amazon
      'available','fulfillable quantity','afn sellable quantity',
      // Flipkart
      'available inventory','fulfillable inventory',
      // Shopify
      'available','quantity','inventory quantity',
      // Odoo
      'on hand','quantity on hand','qty on hand',
      // QuickBooks
      'quantity on hand','qty on hand',
      // Fishbowl
      'qty on hand','quantity on hand','qty available',
    ],
    inbound: [
      'inbound','on order','in transit','po qty','incoming','ordered qty',
      'open po','open purchase order','purchase order qty','po quantity',
      'receiving','working','shipped','fc transfer','inbound qty',
      // SAP
      'open po quantity','purchase order quantity','goods receipt pending',
      'scheduled receipts','planned receipts','open delivery','in transit qty',
      // Tally / Busy
      'purchase order qty','po quantity','pending po','open po qty',
      // NetSuite
      'quantity on order','quantity in transit','pending receipt quantity',
      'po quantity','purchase order quantity',
      // Dynamics
      'ordered quantity','purchase quantity','inbound quantity',
      // Cin7 / Linnworks
      'on order','incoming stock','purchase order quantity','due in',
      // Unicommerce
      'pending grn','grn pending','inbound quantity','pending receipt',
      // Amazon
      'inbound','working','shipped','receiving','reserved fc transfer',
      // Shopify
      'incoming','on order','committed',
      // Odoo
      'incoming quantity','qty in','quantity in',
    ],
    reserved: [
      'reserved','customer order','unfulfilled','pending dispatch',
      'committed','allocated','reserved stock','pick list qty',
      // SAP
      'sales order stock','delivery pending','wm transfer order',
      // NetSuite
      'quantity committed','quantity on order (sales)',
      // Dynamics
      'reserved ordered','reserved physical',
    ],
    leadTime: [
      'lead time','lt','lead time days','supplier lead time',
      'replenishment lead time','procurement lead time','purchase lead time',
      'days to receive','delivery days','supplier lead days',
      // SAP
      'planned delivery time','goods receipt processing time','total replenishment lead time',
      // Tally / Busy
      'lead time','supplier lead days','order lead days',
      // NetSuite
      'lead time','purchase lead time','reorder lead time',
      // Dynamics
      'lead time','vendor lead time','purchase lead time',
    ],
    reorderQty: [
      'reorder qty','reorder quantity','recommended replenishment qty',
      'suggested order qty','min order qty','moq','economic order quantity',
      'eoq','recommended order qty','amazon recommended qty',
      // SAP
      'reorder point quantity','fixed lot size','minimum lot size',
      // NetSuite
      'reorder point','preferred stock level',
      // Dynamics
      'reorder point','minimum order quantity','order quantity',
    ],
    reorderPoint: [
      'reorder point','rop','reorder level','minimum stock level',
      'safety stock level','minimum reorder level','stock alert level',
      // SAP
      'reorder point','minimum stock level',
      // NetSuite / Dynamics
      'reorder point','reorder level',
    ],
    safetyStock: [
      'safety stock','buffer stock','minimum stock','reserve stock',
      'minimum inventory','safety inventory',
      // SAP
      'safety stock','minimum safety stock',
      // NetSuite
      'safety stock level','minimum stock level',
    ],
    category: [
      'category','department','product type','product category','type',
      'item type','item category','product class','class','sub category',
      'product group','item group','commodity','commodity type',
      // SAP
      'material group','product hierarchy','industry sector',
      // Tally
      'category','item category','stock group','sub group',
      // NetSuite
      'item type','class','department','location',
      // Shopify
      'product type','collection','tags',
      // Amazon
      'product type','browse node','category',
      // Flipkart / Myntra
      'category','sub-category','vertical','department',
    ],
    brand: [
      'brand','brand name','manufacturer','vendor','supplier','make',
      'marque','label',
      // SAP
      'vendor','supplier','manufacturer part number',
      // Tally / Busy
      'party name','vendor name','supplier name',
      // NetSuite / Dynamics
      'vendor','manufacturer','preferred vendor',
      // Shopify / Marketplace
      'vendor','brand','manufacturer',
    ],
    warehouse: [
      'warehouse','location','fulfillment center','fc','dc',
      'distribution center','storage location','godown','store',
      'bin','rack','shelf','zone','aisle','plant','site',
      // SAP
      'plant','storage location','warehouse number','storage type',
      // Tally / Busy
      'godown','branch','location',
      // NetSuite / Dynamics
      'location','warehouse','bin','sublocation',
      // Unicommerce
      'facility','facility name','warehouse code',
      // Amazon
      'fulfillment center','fc name',
    ],
    country: [
      'country','marketplace','region','market','territory','country code',
    ],
    channel: [
      'channel','platform','source','marketplace','sales channel',
      'order source','fulfillment channel','store',
    ],
    batchLot: [
      'batch','lot','batch number','lot number','batch no','lot no',
      'serial number','expiry date','manufacture date','mfg date','exp date',
    ],
    unitOfMeasure: [
      'uom','unit of measure','unit','unit of measurement','base unit',
      'sales unit','purchase unit',
    ],
  };

  const map = {};
  const lh = headers.map(h => (h || '').toLowerCase().trim().replace(/[_\-]/g, ' ').replace(/\s+/g, ' '));

  for (const [field, names] of Object.entries(syn)) {
    for (const name of names) {
      const idx = lh.findIndex(h => h === name || h.includes(name) || (name.length > 4 && name.includes(h) && h.length > 3));
      if (idx !== -1 && map[field] === undefined) { map[field] = idx; break; }
    }
  }
  return map;
}

// ─── SKU MAP BUILDER ──────────────────────────────────────────────────────────
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
    const lt = pNum(get(row, 'leadTime'));
    const period = get(row, 'period');

    if (!skuMap[skuId]) {
      skuMap[skuId] = {
        sku: skuId, product: (prod || skuId).substring(0, 80),
        price, available: avail, inbound, reserved, leadTime: lt || 30,
        unitsSold30: unitsSold, dailyVelocity: vel,
        reorderQty: pNum(get(row, 'reorderQty')),
        safetyStock: pNum(get(row, 'safetyStock')),
        reorderPoint: pNum(get(row, 'reorderPoint')),
        category: get(row, 'category') || 'General',
        brand: get(row, 'brand') || '—',
        warehouse: get(row, 'warehouse') || '—',
        channel: get(row, 'channel') || '—',
        batchLot: get(row, 'batchLot') || '',
        uom: get(row, 'unitOfMeasure') || 'Units',
        periods: [],
      };
    } else {
      if (price > 0 && skuMap[skuId].price === 0) skuMap[skuId].price = price;
      if (avail > 0) skuMap[skuId].available = Math.max(skuMap[skuId].available, avail);
      if (inbound > 0) skuMap[skuId].inbound += inbound;
      if (reserved > 0) skuMap[skuId].reserved += reserved;
    }
    if (period && unitsSold >= 0) skuMap[skuId].periods.push({ period: normalisePeriod(period), unitsSold });
  }

  const isTS = Object.values(skuMap).some(s => s.periods.length >= 2);
  if (isTS) {
    for (const s of Object.values(skuMap)) {
      s.periods.sort((a, b) => (new Date(a.period) || 0) - (new Date(b.period) || 0) || a.period.localeCompare(b.period));
    }
  }
  return { skuMap, isTS };
}

// Normalise diverse ERP date formats
function normalisePeriod(raw) {
  if (!raw) return raw;
  const s = raw.toString().trim();
  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (dmy) return `${dmy[3].length === 2 ? '20' + dmy[3] : dmy[3]}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`;
  // MM/YYYY or MM-YYYY
  const my = s.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (my) return `${my[2]}-${my[1].padStart(2,'0')}-01`;
  // Apr-24 or Apr 2024
  const mon = s.match(/^([A-Za-z]{3})[\s\-](\d{2,4})$/);
  if (mon) { const months = {jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12'}; const m = months[mon[1].toLowerCase()]; if (m) return `${mon[2].length===2?'20'+mon[2]:mon[2]}-${m}-01`; }
  // Q1 FY25 or Q1 2024-25
  const qtr = s.match(/Q(\d)\s*(?:FY)?(\d{2,4})/i);
  if (qtr) { const qMonth = { '1':'04', '2':'07', '3':'10', '4':'01' }; return `${qtr[2].length===2?'20'+qtr[2]:qtr[2]}-${qMonth[qtr[1]]||'01'}-01`; }
  return s;
}

// ─── COMPUTE ENGINE ───────────────────────────────────────────────────────────
function computeSKU(s, isTS, today, sym, horizDays) {
  const lt = s.leadTime > 0 ? s.leadTime : 30;
  let dailyVel = 0, avgMonthly = 0, trend = 'flat', trendPct = 'n/a', conf = 'Low';
  let nextH = 0, next30 = 0, next60 = 0, next90 = 0;

  if (isTS && s.periods.length >= 2) {
    const demands = s.periods.map(p => p.unitsSold).filter(d => d >= 0);
    const n = demands.length;
    avgMonthly = n > 0 ? Math.round(demands.reduce((a, b) => a + b, 0) / n) : 0;
    dailyVel = avgMonthly / 30;
    if (n >= 4) {
      const mid = Math.floor(n / 2);
      const f1 = demands.slice(0, mid).reduce((a, b) => a + b, 0) / mid;
      const f2 = demands.slice(mid).reduce((a, b) => a + b, 0) / (n - mid);
      const pct = f1 > 0 ? ((f2 - f1) / f1) * 100 : 0;
      trend = pct > 5 ? 'up' : pct < -5 ? 'down' : 'flat';
      trendPct = (pct >= 0 ? '+' : '') + Math.round(pct) + '%';
    }
    const last = demands[demands.length - 1] || avgMonthly;
    const tf = trend === 'up' ? 1.05 : trend === 'down' ? 0.97 : 1.0;
    nextH = Math.max(0, Math.ceil(last * tf * (horizDays / 30)));
    next30 = Math.max(0, Math.ceil(last * tf));
    next60 = Math.max(0, Math.ceil(last * tf * tf * 2));
    next90 = Math.max(0, Math.ceil(last * tf * tf * tf * 3));
    if (n > 1 && avgMonthly > 0) {
      const vari = demands.map(d => Math.pow(d - avgMonthly, 2)).reduce((a, b) => a + b, 0) / (n - 1);
      conf = Math.sqrt(vari) / avgMonthly < 0.15 ? 'High' : Math.sqrt(vari) / avgMonthly < 0.35 ? 'Medium' : 'Low';
    } else conf = n >= 3 ? 'Medium' : 'Low';
  } else {
    dailyVel = s.dailyVelocity > 0 ? s.dailyVelocity : (s.unitsSold30 > 0 ? s.unitsSold30 / 30 : 0);
    avgMonthly = Math.round(dailyVel * 30);
    nextH = Math.round(dailyVel * horizDays);
    next30 = avgMonthly; next60 = Math.round(dailyVel * 60); next90 = Math.round(dailyVel * 90);
    conf = dailyVel > 0 ? 'Velocity-based' : 'Low (no sales)';
  }

  const currentStock = s.available || 0;
  const netStock = currentStock + (s.inbound || 0) - (s.reserved || 0);
  const daysOfCover = dailyVel > 0 ? Math.round(Math.max(0, netStock) / dailyVel) : (netStock > 0 ? 999 : 0);
  const weeksOfSupply = Math.round(daysOfCover / 7 * 10) / 10;
  const safetyStock = s.safetyStock > 0 ? s.safetyStock : Math.ceil(dailyVel * 7);
  const reorderPoint = s.reorderPoint > 0 ? s.reorderPoint : Math.ceil((dailyVel * lt) + safetyStock);
  const target = Math.ceil(dailyVel * (horizDays + lt));
  const eoq = s.reorderQty > 0 ? s.reorderQty : Math.max(0, target - Math.max(0, netStock));

  let reorderBy = 'OK';
  if (currentStock === 0 && !(s.inbound) && avgMonthly > 0) reorderBy = 'REORDER NOW';
  else {
    const d2r = Math.max(0, daysOfCover - lt);
    if (d2r <= 0) reorderBy = 'REORDER NOW';
    else if (d2r <= 7) reorderBy = 'This Week';
    else { const d = new Date(today); d.setDate(d.getDate() + d2r); reorderBy = d.toLocaleDateString('en-GB'); }
  }

  let priority = 'LOW';
  if (currentStock === 0 && !(s.inbound) && avgMonthly > 0) priority = 'URGENT';
  else if (daysOfCover < lt && avgMonthly > 0) priority = 'HIGH';
  else if (daysOfCover < lt * 2) priority = 'MEDIUM';

  const stockoutDays = dailyVel > 0 ? Math.min(999, Math.round(Math.max(0, netStock) / dailyVel)) : 999;
  const stockoutProb = stockoutDays < 7 ? 95 : stockoutDays < 14 ? 75 : stockoutDays < 30 ? 40 : stockoutDays < 60 ? 15 : 5;
  const revenueAtRisk = dailyVel > 0 && s.price > 0 ? Math.round(Math.max(0, horizDays - stockoutDays) * dailyVel * s.price) : 0;
  const invValue = Math.round(currentStock * (s.price || 0));
  const isSlowMover = dailyVel < 1 && currentStock > 30;
  const isDead = dailyVel === 0 && currentStock > 0;
  const isOverstock = daysOfCover > 180 && avgMonthly > 0;
  const isHealthy = !isDead && !isOverstock && daysOfCover >= 30 && daysOfCover <= 120 && avgMonthly > 0;
  const fillRate = avgMonthly > 0 ? Math.min(100, Math.round((Math.min(currentStock, avgMonthly) / avgMonthly) * 100)) : 0;
  const invTurnover = invValue > 0 ? Math.round((avgMonthly * 12 * (s.price || 0) * 0.7 / invValue) * 10) / 10 : 0;
  const inventoryAge = dailyVel > 0 && currentStock > 0 ? Math.round(currentStock / dailyVel) : 0;
  const excessValue = dailyVel > 0 ? Math.round(Math.max(0, daysOfCover - 90) * dailyVel * (s.price || 0)) : 0;

  return {
    sku: s.sku, product: s.product, category: s.category, brand: s.brand,
    warehouse: s.warehouse, channel: s.channel, uom: s.uom, batchLot: s.batchLot,
    price: s.price, currentStock, inbound: s.inbound || 0, reserved: s.reserved || 0, netStock,
    avgMonthlyDemand: avgMonthly, dailyVelocity: Math.round(dailyVel * 10) / 10,
    nextH, next30, next60, next90, trend, trendPct, confidence: conf,
    daysOfCover, weeksOfSupply, safetyStock, reorderPoint, eoq, reorderBy,
    priority, leadTimeDays: lt, needsReorder: eoq > 0 && avgMonthly > 0,
    stockoutDays, stockoutProb, revenueAtRisk, invValue,
    isSlowMover, isDead, isOverstock, isHealthy, isActive: avgMonthly > 0,
    invTurnover, inventoryAge, fillRate, excessValue,
    slowMoverRisk: invValue > 5000 ? 'HIGH' : invValue > 1000 ? 'MEDIUM' : 'LOW',
    slowAction: invValue > 5000 ? 'Markdown / Bundle / Liquidate' : invValue > 1000 ? 'Hold — avoid reorder' : 'Monitor',
  };
}

function pNum(v) { if (!v && v !== 0) return 0; const n = parseFloat(v.toString().replace(/[$£€₹,\s]/g, '').replace(/[^\d.-]/g, '')); return isNaN(n) || n < 0 ? 0 : n; }
