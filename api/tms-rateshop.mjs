// ═══════════════════════════════════════════════════════════════════════════════════════════
// tms-rateshop.mjs — LogistiQ TMS — RTO-AWARE CARRIER RATE-SHOP (God-mode add-on v1)
// ─────────────────────────────────────────────────────────────────────────────
// Complements the existing Shiprocket rate/track functions with a DECISION engine:
//   • rateShop()   — compute delivered cost per carrier on real weight-slab + zone pricing, add
//                    COD fees, then rank by RTO-AWARE landed cost (cheapest sticker price often
//                    isn't cheapest once RTO is priced in — the India reality).
//   • costPerDeliveredOrder() — the number that feeds back into unit economics (econ.mjs), so
//                    shipping cost → true contribution → reorder priority closes the loop.
// SELF-CONTAINED, no imports, plain-Node testable, no visual/copy changes.
// Rates are seller-supplied rate cards or live quotes; defaults are directional only.
// ─────────────────────────────────────────────────────────────────────────────

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r2 = x => Math.round(x * 100) / 100;
function num(v) { if (v == null || v === '') return 0; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[₹$£€,\s%]/g, '')); return isNaN(n) ? 0 : n; }

// Chargeable weight = max(actual, volumetric). Volumetric (kg) = L×B×H(cm) / divisor (India commonly 5000).
export function chargeableWeight(actualKg, dims, divisor = 5000) {
  let vol = 0;
  if (dims && dims.l && dims.b && dims.h) vol = (num(dims.l) * num(dims.b) * num(dims.h)) / divisor;
  return Math.max(num(actualKg), vol);
}

/**
 * rateShop(shipment, carriers, opts) → carriers ranked by RTO-aware delivered cost.
 *   shipment: { actualKg, dims{l,b,h}, zone, mode:'prepaid'|'cod', codAmount, declaredValue }
 *   carriers: [{
 *     carrier, baseSlabKg (e.g. 0.5), baseRate, addlPerKg, addlSlabKg (default 0.5),
 *     zoneMultiplier: { local, regional, metro, roi, special }, codFlat, codPct,
 *     rtoByZone: { ... }, rtoDefault, tatDays
 *   }]
 */
export function rateShop(shipment = {}, carriers = [], opts = {}) {
  const cw = chargeableWeight(shipment.actualKg, shipment.dims, opts.volumetricDivisor || 5000);
  const zone = (shipment.zone || 'regional').toLowerCase();
  const isCod = (shipment.mode || 'prepaid').toLowerCase() === 'cod';

  const quotes = carriers.map(c => {
    const baseSlab = c.baseSlabKg || 0.5;
    const addlSlab = c.addlSlabKg || 0.5;
    const zmult = (c.zoneMultiplier && c.zoneMultiplier[zone] != null) ? c.zoneMultiplier[zone] : 1;
    const extraKg = Math.max(0, cw - baseSlab);
    const addlSteps = Math.ceil(extraKg / addlSlab - 1e-9);
    let freight = (num(c.baseRate) + addlSteps * num(c.addlPerKg)) * zmult;
    // COD collection fee (flat or % of order value, whichever greater)
    let codFee = 0;
    if (isCod) codFee = Math.max(num(c.codFlat), num(shipment.codAmount) * (num(c.codPct) / 100));
    const forward = r2(freight + codFee);
    // RTO-aware: on RTO you pay forward + return leg (~= freight) + often lose COD handling.
    const rtoProb = clamp((c.rtoByZone && c.rtoByZone[zone] != null) ? c.rtoByZone[zone] : (c.rtoDefault != null ? c.rtoDefault : (isCod ? 0.18 : 0.04)), 0, 0.6);
    const returnLeg = freight;                      // reverse shipment cost on RTO
    const expectedRtoCost = rtoProb * (returnLeg + codFee);
    const deliveredCost = r2(forward + expectedRtoCost);
    // Effective cost per DELIVERED order (spread the RTO waste over successful deliveries):
    const costPerDelivered = r2(deliveredCost / Math.max(0.4, 1 - rtoProb));
    return {
      carrier: c.carrier || 'Carrier', chargeableWeightKg: r2(cw), zone,
      forwardCost: forward, codFee: r2(codFee), rtoProbability: Math.round(rtoProb * 100),
      expectedRtoCost: r2(expectedRtoCost), deliveredCost, costPerDeliveredOrder: costPerDelivered,
      tatDays: c.tatDays != null ? c.tatDays : null,
    };
  });

  const byRtoAware = quotes.slice().sort((a, b) => a.costPerDeliveredOrder - b.costPerDeliveredOrder);
  const bySticker = quotes.slice().sort((a, b) => a.forwardCost - b.forwardCost);
  const best = byRtoAware[0] || null;
  const cheapestSticker = bySticker[0] || null;
  return {
    chargeableWeightKg: r2(cw), zone, mode: isCod ? 'cod' : 'prepaid',
    ranked: byRtoAware, best,
    stickerWinnerDiffersFromRtoAware: best && cheapestSticker ? best.carrier !== cheapestSticker.carrier : false,
    cheapestSticker,
  };
}

/** costPerDeliveredOrder(pick) — passes the RTO-aware delivered cost to econ.mjs as shipPerOrder. */
export function costPerDeliveredOrder(pick) { return pick ? pick.costPerDeliveredOrder : null; }

// Directional India carrier rate-card defaults for demos/tests (seller overrides with real cards).
export const SAMPLE_CARRIERS = [
  { carrier: 'Delhivery', baseSlabKg: 0.5, baseRate: 38, addlPerKg: 32, zoneMultiplier: { local: 0.8, regional: 1.0, metro: 1.1, roi: 1.5, special: 2.1 }, codFlat: 30, codPct: 1.5, rtoByZone: { local: 0.06, regional: 0.10, metro: 0.09, roi: 0.20, special: 0.28 }, tatDays: 4 },
  { carrier: 'Blue Dart', baseSlabKg: 0.5, baseRate: 52, addlPerKg: 44, zoneMultiplier: { local: 0.9, regional: 1.0, metro: 1.05, roi: 1.4, special: 1.9 }, codFlat: 35, codPct: 1.5, rtoByZone: { local: 0.04, regional: 0.07, metro: 0.06, roi: 0.14, special: 0.20 }, tatDays: 2 },
  { carrier: 'Ecom Express', baseSlabKg: 0.5, baseRate: 35, addlPerKg: 30, zoneMultiplier: { local: 0.8, regional: 1.0, metro: 1.1, roi: 1.6, special: 2.2 }, codFlat: 28, codPct: 1.6, rtoByZone: { local: 0.07, regional: 0.12, metro: 0.10, roi: 0.24, special: 0.32 }, tatDays: 5 },
];
