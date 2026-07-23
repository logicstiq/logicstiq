// ═══════════════════════════════════════════════════════════════════════════════════════════
// tools.test.mjs — LogistiQ Sourcing + TMS engines — tests
// Run:  node test/tools.test.mjs        (plain Node ≥18, no deps)
// ═══════════════════════════════════════════════════════════════════════════════════════════
import { scoreSupplier, rankSuppliers, compareLandedCost, reorderToPurchaseOrders } from '../api/sourcing.mjs';
import { chargeableWeight, rateShop, costPerDeliveredOrder, SAMPLE_CARRIERS } from '../api/tms-rateshop.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ FAIL:', m); } };
const section = s => console.log('\n── ' + s);

section('sourcing.mjs — supplier scorecard & landed cost');
const good = scoreSupplier({ supplier: 'Weave Co', otifPct: 98, leadTimeDays: 20, leadTimeVarDays: 2, priceIndex: 0.9, defectPct: 1, fillRatePct: 99 });
const poor = scoreSupplier({ supplier: 'Cheap Source', otifPct: 70, leadTimeDays: 40, leadTimeVarDays: 20, priceIndex: 1.2, defectPct: 8, fillRatePct: 80 });
ok(good.grade === 'A' && good.score >= 85, `strong supplier graded A (got ${good.grade}/${good.score})`);
ok(poor.grade === 'C' || poor.grade === 'D', `weak supplier graded C/D (got ${poor.grade}/${poor.score})`);
ok(good.score > poor.score, 'strong supplier scores above weak one');
ok(poor.risks.length >= 2, 'weak supplier surfaces risk flags');
const ranked = rankSuppliers([{ supplier: 'A', otifPct: 80, leadTimeDays: 30, leadTimeVarDays: 6, priceIndex: 1.0, defectPct: 2, fillRatePct: 90 }, { supplier: 'B', otifPct: 95, leadTimeDays: 15, leadTimeVarDays: 1, priceIndex: 0.95, defectPct: 1, fillRatePct: 97 }]);
ok(ranked[0].supplier === 'B', 'rankSuppliers puts the better supplier first');

const lc = compareLandedCost([
  { supplier: 'Vendor A', unitPrice: 100, freightPerUnit: 10, dutyPct: 5, otherPerUnit: 2, gstPct: 0, moq: 500, leadTimeDays: 30 },
  { supplier: 'Vendor B', unitPrice: 95, freightPerUnit: 22, dutyPct: 10, otherPerUnit: 5, gstPct: 0, moq: 1000, leadTimeDays: 45 },
]);
ok(lc.best.supplier === 'Vendor A', `cheapest landed cost identified (got ${lc.best.supplier})`);
ok(lc.best.landedPerUnit === 117, `Vendor A landed = 100+10+5+2 = 117 (got ${lc.best.landedPerUnit})`);
ok(lc.savingsVsWorstPerUnit > 0, 'landed-cost savings vs worst reported');

const pos = reorderToPurchaseOrders([
  { sku: 'S1', product: 'Kurta', supplier: 'Weave Co', orderQty: 190, unitCost: 200, moq: 200, leadTimeDays: 30 },
  { sku: 'S2', product: 'Scarf', supplier: 'Weave Co', orderQty: 60, unitCost: 90, orderMultiple: 25, leadTimeDays: 30 },
  { sku: 'S3', product: 'Bag', supplier: 'BagMakers', orderQty: 40, unitCost: 300, leadTimeDays: 20 },
], { today: '2026-07-24' });
const weave = pos.find(p => p.supplier === 'Weave Co');
ok(pos.length === 2, `POs grouped by supplier (got ${pos.length})`);
ok(weave.lines.find(l => l.sku === 'S1').qty === 200, 'MOQ enforced (190→200)');
ok(weave.lines.find(l => l.sku === 'S2').qty === 75, 'order multiple enforced (60→75)');
ok(weave.inboundUnits === 275 && weave.expectedReceipt.includes('Aug'), 'inbound units + expected receipt date computed');

section('tms-rateshop.mjs — RTO-aware carrier selection');
ok(chargeableWeight(0.6, { l: 30, b: 20, h: 15 }) === 1.8, `volumetric weight wins: 30×20×15/5000=1.8kg (got ${chargeableWeight(0.6, { l: 30, b: 20, h: 15 })})`);

// COD shipment to a high-RTO 'special' zone: cheapest sticker ≠ RTO-aware winner.
const shop = rateShop({ actualKg: 1, zone: 'special', mode: 'cod', codAmount: 1500 }, SAMPLE_CARRIERS);
ok(shop.ranked[0] === shop.best, 'ranked first equals best');
ok(shop.best.costPerDeliveredOrder <= shop.ranked[shop.ranked.length - 1].costPerDeliveredOrder, 'best has lowest RTO-aware delivered cost');
ok(shop.cheapestSticker.forwardCost <= shop.best.forwardCost, 'a cheaper sticker price exists than the RTO-aware winner');
ok(shop.stickerWinnerDiffersFromRtoAware === true, 'cheapest sticker carrier is NOT the RTO-aware winner (the India reality)');
ok(costPerDeliveredOrder(shop.best) === shop.best.costPerDeliveredOrder, 'costPerDeliveredOrder feeds econ.mjs');

// Prepaid to local zone: RTO drag small, ranking still valid.
const shop2 = rateShop({ actualKg: 0.4, zone: 'local', mode: 'prepaid' }, SAMPLE_CARRIERS);
ok(shop2.best.rtoProbability < 10, 'prepaid+local has low RTO probability');
ok(shop2.ranked.every(q => q.deliveredCost >= q.forwardCost), 'delivered cost ≥ forward cost for every carrier');

console.log(`\n═══ TOOLS RESULT: ${pass} passed, ${fail} failed ═══`);
process.exit(fail ? 1 : 0);
