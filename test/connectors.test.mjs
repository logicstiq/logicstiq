// ═══════════════════════════════════════════════════════════════════════════════════════════
// connectors.test.mjs — LogistiQ connectors + saved history — tests
// Run:  node test/connectors.test.mjs        (plain Node ≥18, no deps)
// ═══════════════════════════════════════════════════════════════════════════════════════════
import crypto from 'node:crypto';
import { canonicalFromShopify, canonicalFromAmazon, toForecastCsv } from '../api/connectors/normalize.mjs';
import { buildInstallUrl, verifyOauthHmac } from '../api/connect/shopify.mjs';
import { mergeHistory, reconcileForecastVsActual, factsToMonthly } from '../api/history.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', m); } };
const section = s => console.log('\n── ' + s);

// ── Shopify normalizer ────────────────────────────────────────────────────────
section('normalize.mjs — Shopify');
const shopify = {
  orders: [
    { created_at: '2026-05-10T09:00:00Z', financial_status: 'paid', line_items: [{ sku: 'TSHIRT-M', quantity: 3, price: '499' }, { sku: 'MUG-1', quantity: 1, price: '199' }] },
    { created_at: '2026-05-11T09:00:00Z', financial_status: 'paid', line_items: [{ sku: 'TSHIRT-M', quantity: 2, price: '499' }], refunds: [{ created_at: '2026-05-12T09:00:00Z', refund_line_items: [{ quantity: 1, line_item: { sku: 'TSHIRT-M' } }] }] },
    { created_at: '2026-06-01T09:00:00Z', cancelled_at: '2026-06-01T10:00:00Z', line_items: [{ sku: 'TSHIRT-M', quantity: 5, price: '499' }] },
  ],
  products: [
    { title: 'Cotton Tee', product_type: 'Fashion', vendor: 'Weave', variants: [{ sku: 'TSHIRT-M', price: '499', inventory_quantity: 40 }] },
    { title: 'Ceramic Mug', product_type: 'Home', vendor: 'ClayCo', variants: [{ sku: 'MUG-1', price: '199', inventory_quantity: 12 }] },
    { title: 'Deadstock Cap', product_type: 'Fashion', vendor: 'Weave', variants: [{ sku: 'CAP-1', price: '299', inventory_quantity: 100 }] },
  ],
};
const sr = canonicalFromShopify(shopify);
const tshirt = sr.filter(r => r.sku === 'TSHIRT-M');
const tsUnits = tshirt.reduce((a, r) => a + r.unitsSold, 0);
const tsReturns = tshirt.reduce((a, r) => a + r.returns, 0);
ok(tsUnits === 5, `TSHIRT-M units = 3+2 (cancelled 5 excluded) → 5 (got ${tsUnits})`);
ok(tsReturns === 1, `TSHIRT-M returns from refund = 1 (got ${tsReturns})`);
ok(tshirt.every(r => r.available === 40), 'TSHIRT-M carries stock snapshot 40');
ok(tshirt.every(r => r.channel === 'Shopify'), 'channel tagged Shopify');
ok(sr.some(r => r.sku === 'CAP-1' && r.unitsSold === 0 && r.available === 100), 'no-sales SKU (CAP-1) still appears as snapshot');
const csv = toForecastCsv(sr);
ok(/^SKU,Product,Category,Brand,Channel,Date,Units Sold,Returns,Available,Inbound,Reserved,Price,Warehouse/.test(csv), 'CSV headers match engine synonyms');
ok(csv.split('\n').length >= 4, 'CSV has data rows');

// ── Amazon normalizer ───────────────────────────────────────────────────────
section('normalize.mjs — Amazon SP-API');
const amazon = {
  orders: [
    { PurchaseDate: '2026-05-05T00:00:00Z', OrderStatus: 'Shipped', OrderItems: [{ SellerSKU: 'AZ-1', QuantityOrdered: 4, ItemPrice: { Amount: '1200' } }] },
    { PurchaseDate: '2026-05-06T00:00:00Z', OrderStatus: 'Canceled', OrderItems: [{ SellerSKU: 'AZ-1', QuantityOrdered: 2, ItemPrice: { Amount: '600' } }] },
  ],
  fbaInventory: [{ 'seller-sku': 'AZ-1', asin: 'B01', 'afn-fulfillable-quantity': 50, 'afn-reserved-quantity': 3, 'afn-inbound-shipped-quantity': 10, 'your-price': 1200 }],
};
const ar = canonicalFromAmazon(amazon);
const az = ar.filter(r => r.sku === 'AZ-1');
ok(az.reduce((a, r) => a + r.unitsSold, 0) === 4, 'AZ-1 units = 4 (canceled order excluded)');
ok(az.some(r => r.available === 50 && r.reserved === 3 && r.inbound === 10), 'AZ-1 stock/reserved/inbound from FBA inventory');
ok(az.some(r => r.price === 300), 'AZ-1 unit price = 1200/4 = 300');
ok(az.every(r => r.channel === 'Amazon.in'), 'channel tagged Amazon.in');

// ── Shopify OAuth (verifiable pieces) ─────────────────────────────────────────
section('connect/shopify.mjs — OAuth install URL + HMAC');
const url = buildInstallUrl('mystore.myshopify.com', { apiKey: 'KEY123', scopes: 'read_orders,read_products', redirectUri: 'https://app/cb', state: 'xyz' });
ok(/mystore\.myshopify\.com\/admin\/oauth\/authorize/.test(url), 'install URL points to the shop authorize endpoint');
ok(/client_id=KEY123/.test(url) && /scope=read_orders/.test(url) && /state=xyz/.test(url), 'install URL carries client_id, scope, state');
let threw = false; try { buildInstallUrl('not-a-shop', { apiKey: 'K' }); } catch (e) { threw = true; }
ok(threw, 'rejects an invalid shop domain');

const secret = 'shpss_secret';
const q = { code: 'abc123', shop: 'mystore.myshopify.com', state: 'xyz', timestamp: '1700000000' };
const msg = Object.keys(q).sort().map(k => `${k}=${q[k]}`).join('&');
const goodHmac = crypto.createHmac('sha256', secret).update(msg).digest('hex');
ok(verifyOauthHmac({ ...q, hmac: goodHmac }, secret) === true, 'valid HMAC verifies');
ok(verifyOauthHmac({ ...q, code: 'TAMPERED', hmac: goodHmac }, secret) === false, 'tampered query fails HMAC');

// ── Saved history + forecast-vs-actual ────────────────────────────────────────
section('history.mjs — merge + forecast-vs-actual');
const merged = mergeHistory(
  [{ sku: 'A', date: '2026-01-15', unitsSold: 10 }, { sku: 'A', date: '2026-02-15', unitsSold: 7 }],
  [{ sku: 'A', date: '2026-02-15', unitsSold: 9 }, { sku: 'A', date: '2026-03-15', unitsSold: 8 }, { sku: 'B', date: '2026-03-15', unitsSold: 4 }],
);
ok(merged.length === 4, `merge dedupes + lengthens series (got ${merged.length} rows)`);
ok(merged.find(r => r.sku === 'A' && r.date === '2026-02-15').unitsSold === 9, 'incoming (fresher) value wins on conflict');
ok(merged.some(r => r.sku === 'A' && r.date === '2026-03-15') && merged.some(r => r.sku === 'B'), 'new months + SKUs added');

const monthly = factsToMonthly([{ sku: 'A', date: '2026-02-05', unitsSold: 5, returns: 1 }, { sku: 'A', date: '2026-02-20', unitsSold: 8 }]);
ok(monthly['a|2026-02'] === 12, `monthly net units = (5-1)+8 = 12 (got ${monthly['a|2026-02']})`);

const rec = reconcileForecastVsActual(
  [{ sku: 'A', period: '2026-02', forecast: 10 }, { sku: 'A', period: '2026-99', forecast: 999 }],
  [{ sku: 'A', date: '2026-02-10', unitsSold: 12 }],
);
ok(rec.overall.samples === 1, 'only scores months with actuals (future/unknown ignored)');
ok(rec.overall.wmape === 17 && rec.overall.accuracy === 83, `WMAPE |10-12|/12 = 17%, accuracy 83% (got ${rec.overall.wmape}/${rec.overall.accuracy})`);
ok(rec.overall.bias < 0, 'bias negative (under-forecast)');
ok(rec.perSku[0].forecast === 10 && rec.perSku[0].actual === 12, 'per-SKU forecast-vs-actual captured');

console.log(`\n═══ CONNECTORS RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
