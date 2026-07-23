// ═══════════════════════════════════════════════════════════════════════════════════════════
// econ.js — LogicstIQ AI Demand Planner — INDIA UNIT-ECONOMICS LAYER (God-mode add-on v1)
// ─────────────────────────────────────────────────────────────────────────────
// Purpose: forecast the RUPEES, not just the units. Every SKU already carries price,
// unitCost and returnRate from computeSKU(); this module turns those into the numbers
// that actually decide profit for an Indian marketplace seller:
//   net realization  = price − commission − fixed/closing fee − fulfilment/ship − gateway
//                       − GST-on-fees (net of ITC)
//   contribution     = net realization − landed cost − carrying cost
//   TRUE contribution = RTO-adjusted expected contribution  ← the number nobody else shows
//
// 100% ADDITIVE. Imports nothing from forecast.js, changes no visuals, no copy.
// All fee/commission/RTO figures are INDICATIVE India defaults and are seller-overridable
// (pass `overrides`). They are directional planning inputs, not billed rates.
// ─────────────────────────────────────────────────────────────────────────────

// Per-channel default economics. commissionPct is a fallback; category-level commission
// (categoryCommission map below) overrides it when the SKU's category is known.
export const CHANNEL_PROFILES = {
  'Amazon.in':        { commissionPct: 0.15, fixedFee: 25, shipPerOrder: 70, gatewayPct: 0.02, codFee: 30, rtoPrepaid: 0.03, rtoCod: 0.18, reverseShip: 65, handling: 20 },
  'Flipkart':         { commissionPct: 0.15, fixedFee: 20, shipPerOrder: 65, gatewayPct: 0.02, codFee: 30, rtoPrepaid: 0.04, rtoCod: 0.22, reverseShip: 60, handling: 20 },
  'Meesho':           { commissionPct: 0.00, fixedFee: 0,  shipPerOrder: 55, gatewayPct: 0.02, codFee: 25, rtoPrepaid: 0.05, rtoCod: 0.28, reverseShip: 55, handling: 18, _forceChannelCommission: true }, // 0% commission, but RTO-heavy
  'Myntra':           { commissionPct: 0.18, fixedFee: 30, shipPerOrder: 70, gatewayPct: 0.02, codFee: 30, rtoPrepaid: 0.04, rtoCod: 0.20, reverseShip: 65, handling: 22 },
  'Nykaa':            { commissionPct: 0.20, fixedFee: 30, shipPerOrder: 70, gatewayPct: 0.02, codFee: 30, rtoPrepaid: 0.03, rtoCod: 0.18, reverseShip: 65, handling: 22 },
  'Ajio':             { commissionPct: 0.18, fixedFee: 25, shipPerOrder: 70, gatewayPct: 0.02, codFee: 30, rtoPrepaid: 0.04, rtoCod: 0.20, reverseShip: 65, handling: 22 },
  'Shopify':          { commissionPct: 0.00, fixedFee: 0,  shipPerOrder: 60, gatewayPct: 0.02, codFee: 25, rtoPrepaid: 0.03, rtoCod: 0.20, reverseShip: 55, handling: 18, _forceChannelCommission: true }, // own site: gateway + shipping only, no marketplace commission
  // Quick-commerce: seller sells INTO the platform (B2B2C); platform margin, warehoused → ~no RTO. Platform commission overrides category.
  'Blinkit':          { commissionPct: 0.22, fixedFee: 0,  shipPerOrder: 0,  gatewayPct: 0.00, codFee: 0,  rtoPrepaid: 0.01, rtoCod: 0.01, reverseShip: 0,  handling: 0, _forceChannelCommission: true },
  'Zepto':            { commissionPct: 0.22, fixedFee: 0,  shipPerOrder: 0,  gatewayPct: 0.00, codFee: 0,  rtoPrepaid: 0.01, rtoCod: 0.01, reverseShip: 0,  handling: 0, _forceChannelCommission: true },
  'Swiggy Instamart': { commissionPct: 0.23, fixedFee: 0,  shipPerOrder: 0,  gatewayPct: 0.00, codFee: 0,  rtoPrepaid: 0.01, rtoCod: 0.01, reverseShip: 0,  handling: 0, _forceChannelCommission: true },
  'default':          { commissionPct: 0.15, fixedFee: 20, shipPerOrder: 65, gatewayPct: 0.02, codFee: 30, rtoPrepaid: 0.04, rtoCod: 0.20, reverseShip: 60, handling: 20 },
};

// Category-level referral/commission (fraction of selling price). Buckets match
// forecast.js classifyCategory(). Directional India marketplace averages.
export const CATEGORY_COMMISSION = {
  mobiles: 0.06, electronics: 0.09, appliances: 0.12, jewellery: 0.18, footwear: 0.16,
  fashion: 0.18, beauty: 0.18, fmcg: 0.12, gifting: 0.15, home: 0.15, default: 0.15,
};

const GST_ON_FEES = 0.18;   // 18% GST charged on marketplace fees
const TCS_PCT = 0.01;       // 1% TCS collected by marketplace under GST (creditable → cash-timing, not a P&L cost)
const DEFAULT_COD_SHARE = 0.55;      // India COD share (declining with UPI, still high in tier 2/3)
const DEFAULT_CARRY_ANNUAL = 0.24;   // 24%/yr holding cost (capital + storage + obsolescence)
const DEFAULT_ITC_SHARE = 1.0;       // GST-registered sellers reclaim GST on fees as ITC → net P&L impact ~0

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r2 = x => Math.round(x * 100) / 100;

// Resolve a channel profile with per-call and per-SKU overrides layered on top.
export function resolveProfile(channel, overrides = {}) {
  const base = CHANNEL_PROFILES[channel] || CHANNEL_PROFILES.default;
  return { ...base, ...(overrides.profile || {}), ...(overrides[channel] || {}) };
}

/**
 * computeUnitEconomics(sku, opts) → economics object (all values per unit unless noted).
 *
 * sku fields used (all optional, degrade gracefully):
 *   price, unitCost, category (or categoryBucket), channel, returnRate (percent int),
 *   daysOfCover, grossUnits, revenueAtRisk
 * opts:
 *   channel, codShare, carryAnnualPct, itcShare, overrides, gstRate
 */
export function computeUnitEconomics(sku = {}, opts = {}) {
  const channel = opts.channel || sku.channel || 'default';
  const p = resolveProfile(channel, opts.overrides || {});
  const codShare = clamp(opts.codShare != null ? opts.codShare : DEFAULT_COD_SHARE, 0, 1);
  const carryAnnual = opts.carryAnnualPct != null ? opts.carryAnnualPct : DEFAULT_CARRY_ANNUAL;
  const itcShare = opts.itcShare != null ? opts.itcShare : DEFAULT_ITC_SHARE;

  const price = num(sku.price);
  const cost = num(sku.unitCost) || num(sku.cost);
  const cat = (sku.categoryBucket || sku.category || 'default');
  const catKey = CATEGORY_COMMISSION[cat] != null ? cat : 'default';

  if (price <= 0) {
    return { ok: false, reason: 'no-price', channel, netRealization: null, contributionPerUnit: null, trueContribution: null };
  }
  // The engine falls back to unitCost = price when no cost column exists. Detect that so we don't
  // cry "profit drain" on SKUs whose COGS is simply unknown (e.g. Shopify orders carry no cost).
  const costKnown = cost > 0 && cost < price * 0.999;

  // ── Fees ──────────────────────────────────────────────────────────────────
  const commissionPct = opts.commissionPct != null ? opts.commissionPct
    : (CATEGORY_COMMISSION[catKey] != null && !p._forceChannelCommission ? CATEGORY_COMMISSION[catKey] : p.commissionPct);
  const commission = price * commissionPct;
  const fixedFee = p.fixedFee;
  const shipFee = p.shipPerOrder;
  // Gateway: prepaid share pays a % gateway fee; COD share pays a flat COD collection fee.
  const gateway = price * p.gatewayPct * (1 - codShare) + p.codFee * codShare;
  const feeSubtotal = commission + fixedFee + shipFee + gateway;
  const gstOnFeesGross = feeSubtotal * (opts.gstRate != null ? opts.gstRate : GST_ON_FEES);
  const gstOnFeesNet = gstOnFeesGross * (1 - itcShare);   // creditable portion removed
  const tcs = price * TCS_PCT;                            // shown for cash reconciliation only

  const netRealization = price - feeSubtotal - gstOnFeesNet;

  // ── Carrying cost while the unit sits in stock ──────────────────────────────
  const doc = clamp(num(sku.daysOfCover) || 30, 0, 180);
  const carryPerUnit = cost * (carryAnnual / 365) * doc;

  // Contribution on a DELIVERED unit (before RTO drag)
  const contributionPerUnit = netRealization - cost - carryPerUnit;

  // ── RTO / reverse-logistics drag (the killer) ───────────────────────────────
  const observed = num(sku.grossUnits) > 0 && sku.returnRate != null ? clamp(num(sku.returnRate) / 100, 0, 0.9) : null;
  const estimated = codShare * p.rtoCod + (1 - codShare) * p.rtoPrepaid;
  // Observed returns are a hard floor; channel COD-RTO captures refusals a returns column may miss.
  const reverseProb = clamp(observed != null ? Math.max(observed, estimated) : estimated, 0, 0.6);
  const rtoCostPerOrder = shipFee + p.reverseShip + p.handling;   // forward + reverse leg + handling; unit itself comes back
  const expectedRtoLoss = reverseProb * rtoCostPerOrder;

  // Expected contribution per ATTEMPTED order (assume ~1 unit/order):
  //   delivered w.p. (1−rtoProb): earn (netRealization − cost)
  //   RTO       w.p. rtoProb:     lose rtoCostPerOrder (unit recovered, so COGS not lost)
  //   carrying cost applies regardless
  const trueContribution = (1 - reverseProb) * (netRealization - cost) - reverseProb * rtoCostPerOrder - carryPerUnit;

  const marginPct = price > 0 ? contributionPerUnit / price : 0;
  const trueMarginPct = price > 0 ? trueContribution / price : 0;
  const isProfitDrain = costKnown && trueContribution <= 0 && num(sku.grossUnits) > 0;   // only when COGS is known
  const rtoIsDecisive = costKnown && contributionPerUnit > 0 && trueContribution <= 0;   // profitable until RTO flips it

  // Contribution at risk = engine's revenue-at-risk re-expressed in TRUE contribution terms.
  const contributionAtRisk = num(sku.revenueAtRisk) > 0 ? Math.round(num(sku.revenueAtRisk) * clamp(trueMarginPct, 0, 1)) : 0;

  return {
    ok: true, channel, commissionPct: r2(commissionPct),
    commission: r2(commission), fixedFee: r2(fixedFee), shipFee: r2(shipFee), gateway: r2(gateway),
    feeSubtotal: r2(feeSubtotal), gstOnFees: r2(gstOnFeesNet), tcs: r2(tcs),
    netRealization: r2(netRealization),
    landedCost: r2(cost), carryPerUnit: r2(carryPerUnit),
    contributionPerUnit: r2(contributionPerUnit), marginPct: Math.round(marginPct * 100),
    reverseProb: Math.round(reverseProb * 100), rtoCostPerOrder: r2(rtoCostPerOrder), expectedRtoLoss: r2(expectedRtoLoss),
    trueContribution: r2(trueContribution), trueMarginPct: Math.round(trueMarginPct * 100),
    costKnown, isProfitDrain, rtoIsDecisive, contributionAtRisk,
    codShare: Math.round(codShare * 100),
  };
}

/**
 * enrichWithEconomics(results, opts) — map computeUnitEconomics over an array of SKU
 * result objects and merge the econ fields onto each (additive; original fields kept).
 * Feed this the engine's `allSKUs` or `reorderPlan` array. Zero side effects.
 */
export function enrichWithEconomics(results = [], opts = {}) {
  return results.map(s => {
    const e = computeUnitEconomics(s, opts);
    return e.ok ? { ...s, econ: e, trueContribution: e.trueContribution, isProfitDrain: e.isProfitDrain } : { ...s, econ: e };
  });
}

/** profitLeaks(results) — SKUs that sell but drain cash after RTO/fees. The upsell moment. */
export function profitLeaks(enriched = []) {
  return enriched
    .filter(s => s.econ && s.econ.ok && s.econ.isProfitDrain)
    .sort((a, b) => (a.econ.trueContribution - b.econ.trueContribution))   // most negative first
    .map(s => ({
      sku: s.sku, product: s.product, channel: s.econ.channel, category: s.category,
      price: s.price, trueContribution: s.econ.trueContribution, reverseProb: s.econ.reverseProb,
      why: s.econ.rtoIsDecisive ? 'RTO flips it to a loss' : 'Fees + cost exceed realization',
      action: s.econ.rtoIsDecisive ? 'Push prepaid, cut COD, or raise price' : 'Renegotiate cost / raise price / delist',
    }));
}

function num(v) {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[₹$£€,\s]/g, '').replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}
