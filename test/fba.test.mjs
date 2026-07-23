// ═══════════════════════════════════════════════════════════════════════════════════════════
// fba.test.mjs — LogistiQ FBA forecasting engine — scenario tests
// Run:  node test/fba.test.mjs        (plain Node ≥18, no deps)
// Feeds synthetic Amazon-style Restock / Inventory / Trend reports and asserts the full pipeline:
// forecast + quantiles, restock-limit-capped send plan, aged/LTSF risk, removal reco,
// profit-after-fees drain detection, stranded inventory, storage forecast.
// ═══════════════════════════════════════════════════════════════════════════════════════════
import { runFbaForecast, buildSendPlan, generateFbaInsights } from '../api/fba-forecast.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', m); } };
const section = s => console.log('\n── ' + s);

// ── Synthetic reports ───────────────────────────────────────────────────────
const restockCsv = [
  'Merchant SKU,ASIN,FNSKU,Product Name,Category,Units Sold Last 30 Days,Available,Inbound,Lead Time (days),your-price,cost',
  'FAST1,B001,X001,Fast Mover Tee,Fashion,300,50,0,45,599,200',
  'SLOW1,B002,X002,Slow Decor Piece,Home,3,400,0,45,899,300',
  'DRAIN1,B003,X003,Cheap Gadget,Electronics,120,30,0,30,249,210',
  'STRAND1,B004,X004,Stranded Item,Home,0,0,0,45,499,150',
].join('\n');

const inventoryCsv = [
  'seller-sku,asin,fnsku,product-name,afn-fulfillable-quantity,afn-inbound-shipped-quantity,afn-reserved-quantity,afn-unsellable-quantity,inv-age-271-to-365-days,inv-age-365-plus-days,estimated-storage-cost-next-month,your-price',
  'FAST1,B001,X001,Fast Mover Tee,50,0,2,0,0,0,40,599',
  'SLOW1,B002,X002,Slow Decor Piece,400,0,0,0,50,120,900,899',
  'DRAIN1,B003,X003,Cheap Gadget,30,0,0,5,0,0,30,249',
  'STRAND1,B004,X004,Stranded Item,0,0,0,20,0,0,10,499',
].join('\n');

// Only FAST1 has a monthly trend series (tests the time-series path; others use 30-day fallback).
const trendCsv = [
  'ASIN,Month,Units Ordered',
  'B001,2026-01,250', 'B001,2026-02,270', 'B001,2026-03,285', 'B001,2026-04,300', 'B001,2026-05,310', 'B001,2026-06,320',
].join('\n');

const out = runFbaForecast({ restockCsv, inventoryCsv, trendCsv }, { horizonDays: 90, serviceLevel: 0.95, restockLimitUnits: 200, asOf: '2026-07-24' });

section('FBA engine — pipeline & forecast');
ok(!out.error, 'engine returns without error');
ok(out.allSKUs.length === 4, `all 4 ASINs processed (got ${out.allSKUs.length})`);
const fast = out.allSKUs.find(r => r.sku === 'FAST1');
ok(fast.forecastQuantiles && fast.forecastQuantiles.p50 <= fast.forecastQuantiles.p90 && fast.forecastQuantiles.p90 <= fast.forecastQuantiles.p95, 'FAST1 probabilistic band ordered P50≤P90≤P95');
ok(fast.forecastWmape != null, 'FAST1 has a back-tested WMAPE (used its trend series)');
ok(fast.dailyVelocity > 8 && fast.dailyVelocity < 13, `FAST1 daily velocity ~10 (got ${fast.dailyVelocity})`);
ok(fast.status === 'Reorder now' && fast.priority === 'URGENT', `FAST1 flagged reorder-now/urgent (got ${fast.status}/${fast.priority})`);

section('FBA engine — restock-limit-constrained send plan');
ok(out.sendPlan.unitsPlanned === 200, `send plan capped to restock limit 200 (got ${out.sendPlan.unitsPlanned})`);
ok(out.sendPlan.capped === true, 'send plan reports it was capped');
ok(out.sendPlan.lines[0].sku === 'FAST1' && out.sendPlan.lines[0].capped === true, 'fastest URGENT SKU funded first and capped');
// direct buildSendPlan unit check: no limit → full need sent
const uncapped = buildSendPlan(out.allSKUs.map(r => ({ ...r })), 0);
ok(uncapped.unitsPlanned >= 200, 'with no restock limit, more units are planned than the capped case');

section('FBA engine — aged inventory / LTSF risk & removal');
const slow = out.allSKUs.find(r => r.sku === 'SLOW1');
ok(slow.aged365 === 120 && slow.aged271 === 50, 'SLOW1 aged buckets read from inventory report');
ok(slow.ltsfExposure === 120 * 150 + 50 * 60, `SLOW1 LTSF exposure computed (got ${slow.ltsfExposure})`);
ok(slow.status === 'Aged / LTSF risk' || slow.removeRecommended, 'SLOW1 flagged aged/LTSF risk');
ok(out.removalRecommendations.some(r => r.sku === 'SLOW1' && r.units === 120), 'removal recommended for the 365+ aged units');
ok(out.storageForecast.ltsfExposure >= 21000, `storage forecast aggregates LTSF exposure (got ${out.storageForecast.ltsfExposure})`);

section('FBA engine — profit-after-fees & stranded');
const drain = out.allSKUs.find(r => r.sku === 'DRAIN1');
ok(drain.trueContribution < 0 && drain.isProfitDrain, `DRAIN1 loses money after FBA fees (true ₹${drain.trueContribution})`);
ok(out.profitLeaks.some(r => r.sku === 'DRAIN1'), 'DRAIN1 surfaced in profit leaks');
const strand = out.allSKUs.find(r => r.sku === 'STRAND1');
ok(strand.status === 'Stranded (unsellable)', `STRAND1 flagged stranded (got ${strand.status})`);
ok(out.summary.stranded === 1 && out.summary.reorderNow >= 1, 'summary counts stranded + reorder-now');

section('FBA engine — Gemini insights fallback (no key)');
const ins = await generateFbaInsights(out, { currency: '₹' }, null);
ok(Array.isArray(ins) && ins.length === 6, `deterministic fallback returns 6 insights offline (got ${ins.length})`);

console.log(`\n═══ FBA RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
