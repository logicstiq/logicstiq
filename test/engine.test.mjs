// ═══════════════════════════════════════════════════════════════════════════════════════════
// engine.test.mjs — LogicstIQ God-mode add-ons — unit + scenario tests
// Run:  node test/engine.test.mjs        (plain Node ≥18, no deps, no package.json needed)
// Covers: econ.mjs (India unit economics), probabilistic.mjs (quantiles/newsvendor),
//         buyplan.mjs (budget knapsack + PO/replenishment grouping), incl. a QUICK-COMMERCE scenario.
// ═══════════════════════════════════════════════════════════════════════════════════════════
import { computeUnitEconomics, enrichWithEconomics, profitLeaks } from '../lib/econ.mjs';
import { quantileForecast, coverage, newsvendorReorderPoint, probit } from '../lib/probabilistic.mjs';
import { budgetConstrainedPlan, groupPurchaseOrders } from '../lib/buyplan.mjs';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL:', msg); } };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ~${b}±${tol})`);
const section = s => console.log('\n── ' + s);

// ───────────────────────────────────────────────────────────────────────────
section('econ.mjs — India unit economics');

// (1) Healthy prepaid Amazon electronics SKU → profitable, RTO trims but doesn't kill.
const amz = computeUnitEconomics(
  { price: 1200, unitCost: 500, category: 'electronics', channel: 'Amazon.in', returnRate: 3, grossUnits: 400, daysOfCover: 30 },
  { codShare: 0.2 });
ok(amz.ok, 'Amazon SKU computes');
ok(amz.contributionPerUnit > 0, 'Amazon contribution positive');
ok(amz.trueContribution > 0 && amz.trueContribution < amz.contributionPerUnit, 'RTO reduces but does not kill Amazon contribution');
ok(amz.commissionPct === 0.09, `electronics category commission applied (got ${amz.commissionPct})`);
ok(!amz.isProfitDrain, 'Amazon SKU is not a profit drain');

// (2) Meesho COD fashion SKU with heavy returns → TRUE contribution flips negative (the moat).
const meesho = computeUnitEconomics(
  { price: 450, unitCost: 330, category: 'fashion', channel: 'Meesho', returnRate: 38, grossUnits: 500, daysOfCover: 30 },
  { codShare: 0.7 });
ok(meesho.commissionPct === 0, `Meesho commission forced to 0% (got ${meesho.commissionPct})`);
ok(meesho.contributionPerUnit > 0, 'Meesho looks OK per delivered unit...');
ok(meesho.trueContribution < 0, '...but TRUE (RTO-adjusted) contribution is negative');
ok(meesho.isProfitDrain === true, 'Meesho SKU flagged as profit drain');
ok(meesho.rtoIsDecisive === true, 'RTO is the decisive factor');

// (3) Quick-commerce Blinkit FMCG SKU → platform commission, NO RTO drag.
const blinkit = computeUnitEconomics(
  { price: 200, unitCost: 120, category: 'fmcg', channel: 'Blinkit', returnRate: 2, grossUnits: 900, daysOfCover: 20 });
ok(blinkit.commissionPct === 0.22, `Blinkit platform commission applied (got ${blinkit.commissionPct})`);
ok(blinkit.rtoCostPerOrder === 0, 'q-comm has zero seller RTO cost (platform-fulfilled)');
ok(blinkit.reverseProb <= 2, 'q-comm reverse-logistics probability ~0');
ok(blinkit.trueContribution > 0 && Math.abs(blinkit.trueContribution - blinkit.contributionPerUnit) < blinkit.contributionPerUnit * 0.2,
   'q-comm true contribution ≈ delivered contribution (no RTO drag)');

// (4) Guard: no price → not ok.
ok(computeUnitEconomics({ price: 0, unitCost: 50 }).ok === false, 'no-price SKU returns ok:false');

// (5) profitLeaks surfaces the Meesho drain.
const enriched = enrichWithEconomics([
  { sku: 'AMZ1', price: 1200, unitCost: 500, category: 'electronics', channel: 'Amazon.in', returnRate: 3, grossUnits: 400, daysOfCover: 30 },
  { sku: 'MEE1', product: 'Cheap Kurti', price: 450, unitCost: 330, category: 'fashion', channel: 'Meesho', returnRate: 38, grossUnits: 500, daysOfCover: 30 },
], { codShare: 0.7 });
const leaks = profitLeaks(enriched);
ok(leaks.length === 1 && leaks[0].sku === 'MEE1', 'profitLeaks isolates the loss-making SKU');

// ───────────────────────────────────────────────────────────────────────────
section('probabilistic.mjs — quantile forecasts & newsvendor');

// probit sanity
near(probit(0.5), 0, 1e-6, 'probit(0.5)=0');
near(probit(0.975), 1.96, 0.01, 'probit(0.975)≈1.96');

// (6) High-mean stable monthly series → Normal band, ordered quantiles.
const hi = quantileForecast([100, 110, 95, 105, 100, 108, 98, 102], { gap: 30, horizonDays: 30 });
ok(hi.dist === 'normal', `high-mean uses normal (got ${hi.dist})`);
ok(hi.p50 <= hi.p90 && hi.p90 <= hi.p95, 'quantiles ordered P50≤P90≤P95 (normal)');
ok(hi.p95 >= hi.p50, 'P95 above the median');
near(hi.p50, hi.horizonMean, hi.horizonMean * 0.15 + 5, 'P50 ≈ horizon mean');

// (7) Sparse intermittent series → count distribution, still ordered & non-negative.
const lo = quantileForecast([0, 0, 3, 0, 0, 2, 0, 4, 0, 0], { gap: 30, horizonDays: 30, pattern: 'intermittent' });
ok(lo.dist === 'nb' || lo.dist === 'poisson', `intermittent uses a count dist (got ${lo.dist})`);
ok(lo.p50 <= lo.p90 && lo.p90 <= lo.p95, 'quantiles ordered (count)');
ok(lo.p50 >= 0 && Number.isFinite(lo.p95), 'count quantiles finite & non-negative');

// (8) Coverage helper.
const cov = coverage([10, 20, 30, 40], [0, 15, 25, 50], [15, 25, 35, 60]); // 3 of 4 inside
near(cov, 0.75, 1e-9, 'coverage = 0.75');

// (9) Newsvendor: higher service level ⇒ higher reorder point; zero variance ⇒ ROP≈mean LT demand.
const nvLow = newsvendorReorderPoint({ dailyVelocity: 10, sigmaDaily: 4, leadTimeDays: 7, serviceLevel: 0.90 });
const nvHigh = newsvendorReorderPoint({ dailyVelocity: 10, sigmaDaily: 4, leadTimeDays: 7, serviceLevel: 0.98 });
ok(nvHigh.rop > nvLow.rop, `98% ROP (${nvHigh.rop}) > 90% ROP (${nvLow.rop})`);
const nvFlat = newsvendorReorderPoint({ dailyVelocity: 10, sigmaDaily: 0, leadTimeDays: 7, serviceLevel: 0.95 });
near(nvFlat.rop, 70, 1, 'zero-variance ROP ≈ velocity×leadtime');

// (10) QUICK-COMMERCE probabilistic: daily grain, short horizon, high service level.
const qc = quantileForecast([22, 18, 25, 30, 45, 60, 40], { gap: 1, horizonDays: 7, levels: [0.5, 0.9, 0.98] });
ok(qc.steps === 7, 'q-comm forecasts at daily grain over 7 days');
ok(qc.quantiles.p50 <= qc.quantiles.p90 && qc.quantiles.p90 <= qc.quantiles.p98, 'q-comm quantiles ordered incl. P98');
const qcRop = newsvendorReorderPoint({ dailyVelocity: 34, sigmaDaily: 14, leadTimeDays: 1, serviceLevel: 0.98 });
ok(qcRop.rop >= 34, `q-comm 1-day-lead ROP covers ≥1 day of demand at 98% (got ${qcRop.rop})`);

// ───────────────────────────────────────────────────────────────────────────
section('buyplan.mjs — budget knapsack + PO / replenishment grouping');

const reorderItems = [
  { sku: 'A', product: 'Hero A', supplier: 'Supplier X', unitCost: 100, orderQty: 50, stockoutProb: 80, priority: 'URGENT', trueContribution: 60, reorderBy: '01/08/2026', leadTimeDays: 15 },
  { sku: 'B', product: 'Mid B',  supplier: 'Supplier X', unitCost: 200, orderQty: 20, stockoutProb: 40, priority: 'HIGH',   trueContribution: 40, reorderBy: '10/08/2026', leadTimeDays: 15, moq: 25 },
  { sku: 'C', product: 'Slow C', supplier: 'Supplier Y', unitCost: 50,  orderQty: 12, stockoutProb: 10, priority: 'LOW',    trueContribution: 5,  reorderBy: '20/08/2026', leadTimeDays: 30, orderMultiple: 10 },
];

// (11) No budget → everything funded.
const full = budgetConstrainedPlan(reorderItems, 0);
ok(full.fundedCount === 3 && full.deferredCount === 0, 'no-budget funds everything');

// (12) Tight budget → spend never exceeds budget, and the deferred item has the weakest ROI.
const tight = budgetConstrainedPlan(reorderItems, 6000);
ok(tight.spent <= 6000, `spend within budget (spent ${tight.spent} ≤ 6000)`);
ok(tight.deferredCount >= 1, 'at least one SKU deferred under tight budget');
ok(tight.funded[0].sku === 'A', `highest protected-₹/rupee funded first (got ${tight.funded[0].sku})`);
ok(tight.deferred.some(d => d.sku === 'B'), 'the SKU that no longer fits (B) is deferred, cheap C packed into leftover budget');
ok(tight.protectedContribution >= tight.deferredContributionAtRisk, 'funded set protects more contribution than it defers');

// (12b) Partial-fill: budget too small for any whole order → top-ROI SKU partially funded.
const partial = budgetConstrainedPlan([
  { sku: 'BIG', unitCost: 100, orderQty: 1000, stockoutProb: 90, priority: 'URGENT', trueContribution: 50 },
], 25000);
ok(partial.fundedCount === 1 && partial.funded[0].partiallyFunded === true, 'top SKU partially funded when no whole order fits');
ok(partial.funded[0].orderQty === 250, `partial qty = floor(budget/unitCost) (got ${partial.funded[0].orderQty})`);
ok(partial.spent <= 25000, 'partial spend within budget');
ok(partial.funded[0].fullOrderQty === 1000, 'full requirement preserved for reference');

// (13) MOQ + order-multiple normalization.
const grp = groupPurchaseOrders(reorderItems, { groupBy: 'supplier' });
const bLine = grp.flatMap(g => g.lines).find(l => l.sku === 'B');
const cLine = grp.flatMap(g => g.lines).find(l => l.sku === 'C');
ok(bLine.qty === 25, `MOQ enforced: B ordered 25 not 20 (got ${bLine.qty})`);
ok(cLine.qty === 20, `order-multiple enforced: C rounded 12→20 (got ${cLine.qty})`);

// (14) PO grouping reconciles: poValue == Σ lineValue, sorted by value desc.
const supX = grp.find(g => g.name === 'Supplier X');
const sumX = supX.lines.reduce((a, l) => a + l.lineValue, 0);
ok(supX.poValue === sumX, `Supplier X PO value reconciles (${supX.poValue} == ${sumX})`);
ok(grp[0].poValue >= grp[grp.length - 1].poValue, 'POs sorted by value desc');
ok(grp.every(g => g.documentType === 'Purchase Order'), 'supplier grouping → Purchase Order docs');

// (15) QUICK-COMMERCE replenishment: group by dark-store, not supplier.
const qcItems = [
  { sku: 'MILK1', warehouse: 'Blinkit-BLR-Koramangala', unitCost: 40, orderQty: 120, stockoutProb: 70, priority: 'URGENT', trueContribution: 8, leadTimeDays: 1 },
  { sku: 'MILK1', warehouse: 'Blinkit-BLR-Indiranagar', unitCost: 40, orderQty: 90,  stockoutProb: 60, priority: 'HIGH',   trueContribution: 8, leadTimeDays: 1 },
  { sku: 'BREAD1', warehouse: 'Blinkit-BLR-Koramangala', unitCost: 25, orderQty: 60,  stockoutProb: 50, priority: 'HIGH',  trueContribution: 5, leadTimeDays: 1 },
];
const replen = groupPurchaseOrders(qcItems, { groupBy: 'warehouse' });
ok(replen.length === 2, `two dark-store replenishment plans (got ${replen.length})`);
ok(replen.every(g => g.documentType === 'Replenishment Plan'), 'warehouse grouping → Replenishment Plan docs');
const kora = replen.find(g => g.name === 'Blinkit-BLR-Koramangala');
ok(kora.lineCount === 2 && kora.totalUnits === 180, `Koramangala store: 2 SKUs, 180 units (got ${kora.lineCount}/${kora.totalUnits})`);

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
