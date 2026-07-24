// ═══════════════════════════════════════════════════════════════════════════════════════════
// normalize.mjs — LogistiQ Connectors — CANONICAL NORMALIZER (God-mode add-on v1)
// ─────────────────────────────────────────────────────────────────────────────
// The reusable heart of every connector: map each marketplace's API payload into ONE canonical
// row shape, then serialise to the CSV the existing /api/forecast engine already understands.
// Adding a new marketplace = writing one normalizer that returns canonical rows; the engine,
// economics, buy plan and everything downstream work unchanged.
//
// Canonical row:
//   { sku, product, category, brand, channel, date(YYYY-MM-DD), unitsSold, returns,
//     price, cost, available, inbound, reserved, warehouse }
//
// Official APIs only. SELF-CONTAINED, plain-Node testable.
// ─────────────────────────────────────────────────────────────────────────────

function num(v) { if (v == null || v === '') return 0; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[₹$£€,\s]/g, '')); return isNaN(n) ? 0 : n; }
function dayOf(v) { if (!v) return ''; const d = new Date(v); return isNaN(d) ? String(v).slice(0, 10) : d.toISOString().slice(0, 10); }
function firstOf(o, keys) { for (const k of keys) { if (o && o[k] != null && o[k] !== '') return o[k]; } return ''; }

// ── SHOPIFY ──────────────────────────────────────────────────────────────────
// data: { orders:[...Admin REST order objects], products:[...Admin REST product objects] }
export function canonicalFromShopify(data = {}) {
  const orders = data.orders || [];
  const products = data.products || [];

  // variant/product master keyed by SKU
  const master = {};
  for (const p of products) {
    for (const v of (p.variants || [])) {
      const sku = (v.sku || '').toString().trim(); if (!sku) continue;
      master[sku.toLowerCase()] = {
        sku, product: p.title || v.title || sku, category: p.product_type || '', brand: p.vendor || '',
        price: num(v.price), available: num(v.inventory_quantity),
      };
    }
  }

  // sales + returns per (sku, day)
  const cell = {};
  const bump = (sku, day, f, q) => { const k = sku.toLowerCase() + '|' + day; (cell[k] = cell[k] || { sku, day, unitsSold: 0, returns: 0, price: 0 }); cell[k][f] += q; };
  for (const o of orders) {
    const day = dayOf(o.created_at || o.processed_at);
    const cancelled = !!o.cancelled_at || /void|cancel/i.test(o.financial_status || '');
    for (const li of (o.line_items || [])) {
      const sku = (li.sku || '').toString().trim(); if (!sku || !day) continue;
      if (!cancelled) bump(sku, day, 'unitsSold', num(li.quantity));
      const c = cell[sku.toLowerCase() + '|' + day]; if (c && num(li.price) > 0) c.price = num(li.price);
    }
    for (const rf of (o.refunds || [])) {
      const rday = dayOf(rf.created_at || o.created_at);
      for (const rli of (rf.refund_line_items || [])) {
        const sku = ((rli.line_item && rli.line_item.sku) || rli.sku || '').toString().trim();
        if (sku && rday) bump(sku, rday, 'returns', num(rli.quantity));
      }
    }
  }

  const rows = [];
  const seenSku = new Set();
  for (const k in cell) {
    const c = cell[k], m = master[c.sku.toLowerCase()] || {};
    seenSku.add(c.sku.toLowerCase());
    rows.push(row(c.sku, m.product || c.sku, m.category, m.brand, 'Shopify', c.day, c.unitsSold, c.returns, c.price || m.price, m.available));
  }
  // SKUs with stock but no sales in window → snapshot row so they still appear (dead/OOS detection)
  for (const key in master) {
    if (seenSku.has(key)) continue; const m = master[key];
    rows.push(row(m.sku, m.product, m.category, m.brand, 'Shopify', dayOf(new Date().toISOString()), 0, 0, m.price, m.available));
  }
  return rows;
}

// ── AMAZON (SP-API) ──────────────────────────────────────────────────────────
// data: { orders:[{PurchaseDate, OrderStatus, OrderItems:[{SellerSKU, ASIN, QuantityOrdered, ItemPrice:{Amount}}]}],
//         fbaInventory:[{ 'seller-sku'|sku, asin, 'afn-fulfillable-quantity', 'afn-reserved-quantity',
//                         'afn-inbound-shipped-quantity', 'your-price' }] }
// Also accepts flat report rows for orders: [{sku, 'purchase-date', quantity, 'item-price'}].
export function canonicalFromAmazon(data = {}) {
  const orders = data.orders || [];
  const inv = data.fbaInventory || [];
  const CANCELLED = /cancel/i;

  const invBySku = {};
  for (const r of inv) {
    const sku = (firstOf(r, ['seller-sku', 'sku', 'SellerSKU']) || '').toString().trim(); if (!sku) continue;
    invBySku[sku.toLowerCase()] = {
      available: num(firstOf(r, ['afn-fulfillable-quantity', 'available'])),
      reserved: num(firstOf(r, ['afn-reserved-quantity', 'reserved'])),
      inbound: num(firstOf(r, ['afn-inbound-shipped-quantity'])) + num(firstOf(r, ['afn-inbound-working-quantity'])) + num(firstOf(r, ['afn-inbound-receiving-quantity'])),
      price: num(firstOf(r, ['your-price', 'price'])), product: firstOf(r, ['product-name', 'title']), asin: firstOf(r, ['asin']),
    };
  }

  const cell = {};
  const bump = (sku, day, f, q, price) => { const k = sku.toLowerCase() + '|' + day; (cell[k] = cell[k] || { sku, day, unitsSold: 0, returns: 0, price: 0 }); cell[k][f] += q; if (price > 0) cell[k].price = price; };
  for (const o of orders) {
    if (o.OrderItems) {                                   // structured Orders API object
      const day = dayOf(o.PurchaseDate); const cancelled = CANCELLED.test(o.OrderStatus || '');
      for (const it of o.OrderItems) {
        const sku = (it.SellerSKU || '').toString().trim(); if (!sku || !day) continue;
        const price = num(it.ItemPrice && it.ItemPrice.Amount) / Math.max(1, num(it.QuantityOrdered));
        if (!cancelled) bump(sku, day, 'unitsSold', num(it.QuantityOrdered), price);
      }
    } else {                                              // flat report row
      const sku = (firstOf(o, ['sku', 'seller-sku', 'SellerSKU']) || '').toString().trim();
      const day = dayOf(firstOf(o, ['purchase-date', 'PurchaseDate', 'date']));
      const qty = num(firstOf(o, ['quantity', 'quantity-purchased', 'QuantityOrdered']));
      const status = firstOf(o, ['order-status', 'OrderStatus']);
      const price = num(firstOf(o, ['item-price', 'ItemPrice'])) / Math.max(1, qty);
      if (sku && day && !CANCELLED.test(status || '')) bump(sku, day, 'unitsSold', qty, price);
    }
  }

  const rows = []; const seen = new Set();
  for (const k in cell) {
    const c = cell[k], m = invBySku[c.sku.toLowerCase()] || {}; seen.add(c.sku.toLowerCase());
    rows.push(row(c.sku, m.product || c.sku, '', '', 'Amazon.in', c.day, c.unitsSold, c.returns, c.price || m.price, m.available, m.inbound, m.reserved));
  }
  for (const key in invBySku) {
    if (seen.has(key)) continue; const m = invBySku[key];
    rows.push(row(key, m.product || key, '', '', 'Amazon.in', dayOf(new Date().toISOString()), 0, 0, m.price, m.available, m.inbound, m.reserved));
  }
  return rows;
}

function row(sku, product, category, brand, channel, date, unitsSold, returns, price, available, inbound, reserved) {
  return {
    sku, product: product || sku, category: category || '', brand: brand || '', channel, date,
    unitsSold: Math.round(num(unitsSold)), returns: Math.round(num(returns)),
    price: num(price) || '', cost: '', available: num(available) || 0,
    inbound: num(inbound) || 0, reserved: num(reserved) || 0, warehouse: channel,
  };
}

// ── CANONICAL ROWS → ENGINE CSV ───────────────────────────────────────────────
// Headers chosen to match forecast.js column synonyms (SYN): SKU, Product, Category, Brand,
// Channel, Date, Units Sold, Returns, Available, Inbound, Reserved, Price, Warehouse.
const CSV_COLS = [
  ['sku', 'SKU'], ['product', 'Product'], ['category', 'Category'], ['brand', 'Brand'], ['channel', 'Channel'],
  ['date', 'Date'], ['unitsSold', 'Units Sold'], ['returns', 'Returns'], ['available', 'Available'],
  ['inbound', 'Inbound'], ['reserved', 'Reserved'], ['price', 'Price'], ['warehouse', 'Warehouse'],
];
export function toForecastCsv(rows = []) {
  const esc = v => { v = (v == null ? '' : String(v)); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const head = CSV_COLS.map(c => c[1]).join(',');
  const body = rows.map(r => CSV_COLS.map(c => esc(r[c[0]])).join(',')).join('\n');
  return head + '\n' + body;
}

// Convenience: payload → CSV in one call.
export function shopifyToCsv(data) { return toForecastCsv(canonicalFromShopify(data)); }
export function amazonToCsv(data) { return toForecastCsv(canonicalFromAmazon(data)); }
