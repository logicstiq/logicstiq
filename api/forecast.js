// /api/forecast.js — LogicstIQ AI Demand Planner v2
// ─────────────────────────────────────────────────────────────────────────────
// ARCHITECTURE: ALL numbers are computed in pure JavaScript code.
// Gemini is called ONLY to write the insights text bullets.
// If Gemini fails, the report is still 100% complete and correct.
// Same file uploaded twice → identical numbers every time (deterministic).
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not configured in Vercel. Go to Project Settings > Environment Variables, add it, then redeploy.'
    });
  }

  const { prompt } = req.body || {};
  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt in request body.' });
  }

  // ── Detect currency symbol from prompt ────────────────────────────────────
  const currMatch = prompt.match(/Currency:\s*\w+\s*\(([^)]+)\)/);
  const sym = currMatch ? currMatch[1] : '$';

  // ── Extract CSV text from the prompt ─────────────────────────────────────
  const csvText = extractCSV(prompt);
  if (!csvText || csvText.trim().length < 10) {
    return res.status(400).json({
      error: 'Could not find CSV data in your request. Please upload a valid CSV or XLSX file and try again.'
    });
  }

  // ── Parse CSV into rows ───────────────────────────────────────────────────
  const rows = parseCSV(csvText);
  if (!rows || rows.length < 2) {
    return res.status(400).json({
      error: 'Your file has fewer than 2 rows. Please check the file format and re-upload.'
    });
  }

  const headers = rows[0];
  const dataRows = rows.slice(1).filter(r => r.some(c => c && c.trim() !== ''));

  if (dataRows.length === 0) {
    return res.status(400).json({ error: 'No data rows found after the header row. Please check your file.' });
  }

  // ── Map column names to internal schema ──────────────────────────────────
  const mapping = mapColumns(headers);

  // ── Detect data shape (snapshot vs time series) ───────────────────────────
  const shape = detectShape(dataRows, mapping);

  // ── Build SKU map from raw rows ───────────────────────────────────────────
  const skuMap = buildSkuMap(dataRows, mapping, shape);
  const skuList = Object.values(skuMap);

  if (skuList.length === 0) {
    return res.status(400).json({
      error: 'No valid SKUs could be identified. Ensure your file has a SKU, ASIN, or Product Name column.'
    });
  }

  // ── Compute all numbers in code ───────────────────────────────────────────
  const today = new Date();
  const computedSKUs = skuList.map(sku => computeSKU(sku, shape, today, sym));

  // ── Build output sections ─────────────────────────────────────────────────
  const demandForecast = computedSKUs
    .filter(s => s.avgMonthlyDemand > 0)
    .sort((a, b) => b.avgMonthlyDemand - a.avgMonthlyDemand)
    .slice(0, 50)
    .map(s => ({
      sku: s.sku,
      product: s.product,
      avgMonthlyDemand: s.avgMonthlyDemand,
      next30: s.next30,
      next60: s.next60,
      next90: s.next90,
      trend: s.trend,
      trendPct: s.trendPct,
      confidence: s.confidence
    }));

  const reorderPlan = computedSKUs
    .filter(s => s.needsReorder)
    .sort((a, b) => {
      const pOrder = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      return (pOrder[a.priority] || 3) - (pOrder[b.priority] || 3);
    })
    .slice(0, 30)
    .map(s => ({
      sku: s.sku,
      product: s.product,
      currentStock: s.currentStock,
      reorderPoint: s.reorderPoint,
      eoq: s.eoq,
      reorderBy: s.reorderBy,
      leadTimeDays: s.leadTimeDays,
      priority: s.priority
    }));

  const slowMoverObjects = computedSKUs
    .filter(s => s.isSlowMover)
    .sort((a, b) => b.inventoryValueRaw - a.inventoryValueRaw)
    .slice(0, 15);

  const slowMovers = slowMoverObjects.map(s => ({
    sku: s.sku,
    product: s.product,
    daysInStock: s.daysOfCoverInclInbound >= 999 ? 999 : s.daysOfCoverInclInbound,
    monthlyVelocity: s.avgMonthlyDemand,
    inventoryValue: s.inventoryValue,
    action: s.slowMoverAction,
    riskLevel: s.slowMoverRisk
  }));

  // ── Summary (all numbers computed in code) ────────────────────────────────
  const totalSKUs = computedSKUs.length;
  const activeSKUs = computedSKUs.filter(s => s.avgMonthlyDemand > 0);
  const avgMonthlyDemand = activeSKUs.length > 0
    ? Math.round(activeSKUs.reduce((sum, s) => sum + s.avgMonthlyDemand, 0) / activeSKUs.length)
    : 0;
  const totalInventoryValueRaw = computedSKUs.reduce((sum, s) => sum + s.inventoryValueRaw, 0);
  const totalInventoryValue = sym + Math.round(totalInventoryValueRaw).toLocaleString('en');
  const criticalAlerts = computedSKUs.filter(s => s.priority === 'URGENT' || s.priority === 'HIGH').length;
  const slowMoverCount = computedSKUs.filter(s => s.isSlowMover).length;

  const mapeAccuracy = shape === 'timeseries' ? computeBacktestAccuracy(skuList) : null;
  const forecastAccuracy = mapeAccuracy !== null
    ? mapeAccuracy + '% (back-tested)'
    : 'n/a — velocity projection';

  const summary = {
    totalSKUs,
    avgMonthlyDemand,
    totalInventoryValue,
    forecastAccuracy,
    criticalAlerts,
    slowMovers: slowMoverCount
  };

  const engineOutput = { summary, demandForecast, reorderPlan, slowMovers };

  // ── Ask Gemini for NARRATIVE ONLY ─────────────────────────────────────────
  const narrativePrompt = `You are a supply chain analyst reviewing a pre-computed inventory report.

STRICT RULES:
1. Do NOT invent, estimate, or change any number. Every figure was computed by code.
2. Do NOT recalculate anything.
3. Write ONLY the insights array — 5 short actionable bullets for an operations manager.
4. Reference only figures that appear in the JSON below.
5. Return ONLY valid JSON. No markdown, no backticks, no extra text.

PRE-COMPUTED REPORT SUMMARY:
${JSON.stringify(summary)}

TOP URGENT REORDER ITEMS (first 5):
${JSON.stringify(reorderPlan.slice(0, 5).map(r => ({ sku: r.sku, product: r.product, currentStock: r.currentStock, priority: r.priority, reorderBy: r.reorderBy })))}

TOP SLOW MOVERS (first 3):
${JSON.stringify(slowMoverObjects.slice(0, 3).map(s => ({ sku: s.sku, product: s.product, inventoryValue: s.inventoryValue, monthlyVelocity: s.avgMonthlyDemand })))}

Return EXACTLY:
{"insights":[{"type":"green|orange|blue","text":"<one actionable sentence>"}]}`;

  let insights = [
    { type: 'orange', text: criticalAlerts + ' SKU' + (criticalAlerts !== 1 ? 's' : '') + ' require immediate attention — review the Reorder Plan tab and raise purchase orders for URGENT and HIGH priority items.' },
    { type: 'blue', text: 'Total inventory value on hand is ' + totalInventoryValue + '. ' + slowMoverCount + ' slow-moving SKU' + (slowMoverCount !== 1 ? 's' : '') + ' may be tying up working capital.' },
    { type: 'green', text: 'Average monthly demand across ' + activeSKUs.length + ' active SKUs is ' + avgMonthlyDemand.toLocaleString() + ' units. Demand Forecast tab shows top 50 SKUs by volume.' },
    { type: 'blue', text: 'Forecast method: ' + (shape === 'timeseries' ? 'Moving average with trend detection (historical data detected).' : 'Velocity-based projection (snapshot data — upload monthly history for trend analysis).') }
  ];

  try {
    const MODEL = 'gemini-2.5-flash';
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + MODEL + ':generateContent?key=' + apiKey;

    const aiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: narrativePrompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 800,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 }
        }
      })
    });

    const aiData = await aiResponse.json();
    const aiText = aiData && aiData.candidates && aiData.candidates[0] &&
      aiData.candidates[0].content && aiData.candidates[0].content.parts
      ? aiData.candidates[0].content.parts.map(function(p) { return p.text || ''; }).join('')
      : '';

    if (aiText && aiText.trim().length > 5) {
      const parsed = JSON.parse(aiText.replace(/```json|```/g, '').trim());
      if (parsed.insights && Array.isArray(parsed.insights) && parsed.insights.length > 0) {
        insights = parsed.insights;
      }
    }
  } catch (e) {
    // Gemini failed — the computed report above is already 100% complete.
  }

  engineOutput.insights = insights;

  return res.status(200).json({
    content: [{ type: 'text', text: JSON.stringify(engineOutput) }]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTATION ENGINE
// ─────────────────────────────────────────────────────────────────────────────

function computeSKU(sku, shape, today, sym) {
  const s = Object.assign({}, sku);
  const leadTimeDays = s.leadTime > 0 ? s.leadTime : 30;
  let dailyVel = 0;

  if (shape === 'timeseries' && s.periods && s.periods.length > 0) {
    const demands = s.periods.map(function(p) { return p.unitsSold; }).filter(function(d) { return d >= 0; });
    const n = demands.length;
    s.avgMonthlyDemand = n > 0 ? Math.round(demands.reduce(function(a,b){return a+b;},0) / n) : 0;
    dailyVel = s.avgMonthlyDemand / 30;

    if (n >= 4) {
      const mid = Math.floor(n / 2);
      const firstHalfAvg = demands.slice(0, mid).reduce(function(a,b){return a+b;},0) / mid;
      const lastHalfAvg = demands.slice(mid).reduce(function(a,b){return a+b;},0) / (n - mid);
      const pct = firstHalfAvg > 0 ? ((lastHalfAvg - firstHalfAvg) / firstHalfAvg) * 100 : 0;
      s.trend = pct > 5 ? 'up' : pct < -5 ? 'down' : 'flat';
      s.trendPct = (pct >= 0 ? '+' : '') + Math.round(pct) + '%';
    } else {
      s.trend = 'flat';
      s.trendPct = 'n/a';
    }

    const lastDemand = demands[demands.length - 1] || s.avgMonthlyDemand;
    const tf = s.trend === 'up' ? 1.05 : s.trend === 'down' ? 0.97 : 1.0;
    s.next30 = Math.max(0, Math.ceil(lastDemand * tf));
    s.next60 = Math.max(0, Math.ceil(lastDemand * tf * tf * 2));
    s.next90 = Math.max(0, Math.ceil(lastDemand * tf * tf * tf * 3));

    const mean = s.avgMonthlyDemand;
    const demands2 = s.periods.map(function(p) { return p.unitsSold; }).filter(function(d) { return d >= 0; });
    const n2 = demands2.length;
    if (n2 > 1 && mean > 0) {
      const variance = demands2.map(function(d){return Math.pow(d-mean,2);}).reduce(function(a,b){return a+b;},0) / (n2-1);
      const coV = Math.sqrt(variance) / mean;
      s.confidence = coV < 0.15 ? 'High' : coV < 0.35 ? 'Medium' : 'Low';
    } else {
      s.confidence = n2 >= 3 ? 'Medium' : 'Low';
    }
  } else {
    dailyVel = s.dailyVelocity > 0 ? s.dailyVelocity : (s.unitsSold30 > 0 ? s.unitsSold30 / 30 : 0);
    s.avgMonthlyDemand = Math.round(dailyVel * 30);
    s.next30 = s.avgMonthlyDemand;
    s.next60 = Math.round(dailyVel * 60);
    s.next90 = Math.round(dailyVel * 90);
    s.trend = 'flat';
    s.trendPct = 'n/a';
    s.confidence = dailyVel > 0 ? 'Velocity-based' : 'Low (no sales)';
  }

  s.currentStock = s.available || 0;
  const netStock = s.currentStock + (s.inbound || 0);
  s.daysOfCoverInclInbound = dailyVel > 0 ? Math.round(netStock / dailyVel) : (netStock > 0 ? 999 : 0);
  const safetyStock = Math.ceil(dailyVel * 7);
  s.reorderPoint = s.dataReorderPoint > 0 ? s.dataReorderPoint : Math.ceil((dailyVel * leadTimeDays) + safetyStock);
  const target90 = Math.ceil(dailyVel * 90);
  s.eoq = s.dataRecommendedQty > 0 ? s.dataRecommendedQty : Math.max(0, target90 - netStock);

  if (s.eoq > 0 && s.dataReorderDate) {
    s.reorderBy = s.dataReorderDate;
  } else if (s.currentStock === 0 && (s.inbound || 0) === 0) {
    s.reorderBy = 'REORDER NOW';
  } else {
    const daysUntilReorder = Math.max(0, s.daysOfCoverInclInbound - leadTimeDays);
    if (daysUntilReorder <= 0) {
      s.reorderBy = 'REORDER NOW';
    } else {
      const d = new Date(today);
      d.setDate(d.getDate() + daysUntilReorder);
      s.reorderBy = d.toLocaleDateString('en-GB');
    }
  }

  if (s.currentStock === 0 && (s.inbound || 0) === 0 && s.avgMonthlyDemand > 0) {
    s.priority = 'URGENT';
  } else if (s.daysOfCoverInclInbound < 14 && s.avgMonthlyDemand > 0) {
    s.priority = 'HIGH';
  } else if (s.daysOfCoverInclInbound < 30) {
    s.priority = 'MEDIUM';
  } else {
    s.priority = 'LOW';
  }

  s.needsReorder = s.eoq > 0 && s.avgMonthlyDemand > 0;
  s.leadTimeDays = leadTimeDays;
  s.inventoryValueRaw = s.currentStock > 0 && s.price > 0 ? Math.round(s.currentStock * s.price * 100) / 100 : 0;
  s.inventoryValue = sym + Math.round(s.inventoryValueRaw).toLocaleString('en');
  s.isSlowMover = dailyVel < 1 && s.currentStock > 30;
  s.slowMoverAction = s.inventoryValueRaw > 5000 ? 'Consider markdown pricing, bundling, or liquidation to recover capital'
    : s.inventoryValueRaw > 1000 ? 'Monitor closely — avoid reordering until velocity improves'
    : 'Low priority — hold and monitor';
  s.slowMoverRisk = s.inventoryValueRaw > 5000 ? 'HIGH' : s.inventoryValueRaw > 1000 ? 'MEDIUM' : 'LOW';
  return s;
}

function computeBacktestAccuracy(skuList) {
  const eligible = skuList.filter(function(s) { return s.periods && s.periods.length >= 5; });
  if (eligible.length === 0) return null;
  const errors = [];
  for (const sku of eligible) {
    const periods = sku.periods;
    const n = periods.length;
    const trainDemands = periods.slice(0, n - 1).map(function(p){return p.unitsSold;});
    const actual = periods[n - 1].unitsSold;
    if (actual <= 0) continue;
    const predicted = trainDemands.reduce(function(a,b){return a+b;},0) / trainDemands.length;
    errors.push(Math.abs(actual - predicted) / actual * 100);
  }
  if (errors.length === 0) return null;
  const mape = errors.reduce(function(a,b){return a+b;},0) / errors.length;
  return Math.max(0, Math.round(100 - mape));
}

function detectShape(dataRows, mapping) {
  const hasPeriod = mapping.period !== undefined;
  if (!hasPeriod) return 'snapshot';
  const skuIdx = mapping.sku !== undefined ? mapping.sku : mapping.asin !== undefined ? mapping.asin : -1;
  if (skuIdx === -1) return 'snapshot';
  const skuValues = dataRows.map(function(r){return r[skuIdx];}).filter(Boolean);
  const uniqueCount = new Set(skuValues).size;
  return uniqueCount < skuValues.length * 0.8 ? 'timeseries' : 'snapshot';
}

function buildSkuMap(dataRows, mapping, shape) {
  const skuMap = {};
  let rowIdx = 0;
  for (const row of dataRows) {
    const get = function(field) {
      const idx = mapping[field];
      return (idx !== undefined && row[idx] !== undefined) ? row[idx].toString().trim() : '';
    };
    const product = get('product');
    const rawSku = get('sku') || get('asin') || (product ? product.substring(0, 40) : '');
    const skuId = rawSku || ('item_' + rowIdx++);
    if (!skuId) continue;
    const price = parseNum(get('price'));
    const unitsSold = parseNum(get('unitsSold'));
    const dailyVelocity = parseNum(get('velocity'));
    const available = parseNum(get('available') || get('onHand'));
    const inbound = parseNum(get('inbound'));
    const leadTime = parseNum(get('leadTime'));
    const dataRecommendedQty = parseNum(get('amazonRecommendedQty'));
    const dataReorderDate = get('amazonRecommendedDate') || '';
    const alertVal = get('alert').toLowerCase();

    if (!skuMap[skuId]) {
      skuMap[skuId] = {
        sku: (get('sku') || get('asin') || skuId).substring(0, 50),
        asin: get('asin'),
        product: (product || skuId).substring(0, 80),
        country: get('country'),
        price: price || 0,
        available: available || 0,
        inbound: inbound || 0,
        leadTime: leadTime || 30,
        dataReorderPoint: 0,
        dataRecommendedQty: dataRecommendedQty || 0,
        dataReorderDate: dataReorderDate,
        alert: alertVal,
        unitsSold30: unitsSold || 0,
        dailyVelocity: dailyVelocity || 0,
        periods: []
      };
    } else {
      if (price > 0 && skuMap[skuId].price === 0) skuMap[skuId].price = price;
      if (available > 0) skuMap[skuId].available = available;
      if (dataRecommendedQty > 0) skuMap[skuId].dataRecommendedQty = dataRecommendedQty;
      if (dataReorderDate) skuMap[skuId].dataReorderDate = dataReorderDate;
    }
    if (shape === 'timeseries') {
      const period = get('period');
      if (period && unitsSold >= 0) {
        skuMap[skuId].periods.push({ period: period, unitsSold: unitsSold });
      }
    }
  }
  if (shape === 'timeseries') {
    for (const sku of Object.values(skuMap)) {
      sku.periods.sort(function(a,b){
        const da = new Date(a.period).getTime() || 0;
        const db = new Date(b.period).getTime() || 0;
        return da - db || a.period.localeCompare(b.period);
      });
      if (sku.periods.length > 0) {
        sku.unitsSold30 = sku.periods[sku.periods.length - 1].unitsSold;
      }
    }
  }
  return skuMap;
}

function mapColumns(headers) {
  const synonyms = {
    sku: ['merchant sku','sku','item id','product code','part no','part number','item_id','sku id','seller sku','fnsku','barcode','upc','mpn'],
    asin: ['asin'],
    product: ['product name','product','description','title','item','item name','product title','name','product description'],
    period: ['date','month','week','period','order date','sale date','time period','sales month','sales period','reporting period'],
    country: ['country','marketplace','region','market'],
    price: ['price','unit price','selling price','rate','sale price','item price','cost','unit cost','asp'],
    unitsSold: ['units sold last 30 days','units sold 30d','units sold','qty sold','sales 30d','sales last 30 days','demand','units moved','quantity sold','monthly sales','monthly demand','qty','quantity','sales units'],
    velocity: ['daily velocity','velocity','daily demand','avg daily sales','run rate','daily run rate','units per day'],
    available: ['available','on hand','qty available','stock','in stock','onhand','qty on hand','sellable units','sellable','fulfillable qty','warehouse stock'],
    onHand: ['total units','total qty','total inventory','total stock'],
    inbound: ['inbound','on order','in transit','po qty','incoming','ordered qty','receiving','working','shipped','fc transfer','inbound qty'],
    reserved: ['reserved','customer order','pending','customer orders','unfulfilled orders'],
    alert: ['alert','amazon alert','status','inventory alert','replenishment alert','stock status'],
    amazonRecommendedQty: ['recommended replenishment qty','amazon recommended qty','reorder qty','recommended qty','recommended replenishment','suggested order qty','min order qty'],
    amazonRecommendedDate: ['recommended ship date','amazon recommended ship date','reorder date','ship date','suggested ship date'],
    leadTime: ['lead time','lt','supplier lead days','lead time days','replenishment lead time','supplier lead time','days to receive']
  };
  const mapping = {};
  const lowerHeaders = headers.map(function(h){ return (h||'').toLowerCase().trim().replace(/_/g,' ').replace(/\s+/g,' '); });
  for (const field in synonyms) {
    const names = synonyms[field];
    for (const name of names) {
      const idx = lowerHeaders.indexOf(name);
      if (idx !== -1 && mapping[field] === undefined) { mapping[field] = idx; break; }
    }
    if (mapping[field] === undefined) {
      for (const name of names) {
        const idx = lowerHeaders.findIndex(function(h){ return h.includes(name) || (name.length > 4 && name.includes(h)); });
        if (idx !== -1) { mapping[field] = idx; break; }
      }
    }
  }
  return mapping;
}

function extractCSV(prompt) {
  const marker = prompt.indexOf('CSV DATA:');
  if (marker !== -1) {
    const start = prompt.indexOf('\n', marker) + 1;
    const endMarkers = ['\nGenerate demand planning', '\nReturn EXACTLY', '\n\nReturn', '\n\nBe data'];
    let end = prompt.length;
    for (const em of endMarkers) {
      const pos = prompt.indexOf(em, start);
      if (pos !== -1 && pos < end) end = pos;
    }
    const csv = prompt.substring(start, end).trim();
    if (csv.length > 10) return csv;
  }
  const lines = prompt.split('\n');
  const knownHeaders = ['sku','asin','product name','merchant sku','fnsku','product','units sold','daily velocity','available'];
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (lines[i].includes(',') && knownHeaders.some(function(h){ return lower.includes(h); })) {
      return lines.slice(i).join('\n');
    }
  }
  return null;
}

function parseCSV(text) {
  const rows = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('#')) continue;
    rows.push(parseCSVLine(trimmed));
  }
  return rows;
}

function parseCSVLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseNum(val) {
  if (val === undefined || val === null || val === '') return 0;
  const cleaned = val.toString().replace(/[$£€₹,\s]/g,'').replace(/[^\d.-]/g,'');
  const num = parseFloat(cleaned);
  return isNaN(num) || num < 0 ? 0 : num;
}
