// ═══════════════════════════════════════════════════════════════════════════════════════════
// buyplan.js — LogicstIQ AI Demand Planner — ACTION LAYER (God-mode add-on v1)
// ─────────────────────────────────────────────────────────────────────────────
// Turns the reorder TABLE into a DECISION:
//   1) budgetConstrainedPlan() — "with ₹X this cycle, buy THESE SKUs to protect the most
//      contribution." Greedy knapsack on protected-contribution-per-rupee. This is the
//      feature a cash-strapped seller screenshots.
//   2) groupPurchaseOrders() — supplier-grouped, MOQ / order-multiple-aware purchase orders
//      ready to render / export / email. For QUICK COMMERCE, group by dark-store / city to
//      produce per-store replenishment plans instead of supplier POs.
//
// 100% ADDITIVE, self-contained, no imports, no visual/copy changes. Feed it the engine's
// reorderPlan (optionally enriched by econ.js).
// ─────────────────────────────────────────────────────────────────────────────

const PRIORITY_RANK = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const r0 = x => Math.round(x);

function num(v) {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[₹$£€,\s]/g, '').replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// Per-unit true contribution, preferring econ.js output, then explicit field, then price−cost.
function unitContribution(it) {
  if (it.econ && it.econ.ok && it.econ.trueContribution != null) return it.econ.trueContribution;
  if (it.trueContribution != null) return num(it.trueContribution);
  const price = num(it.price), cost = num(it.unitCost) || num(it.cost);
  return price > 0 ? price - cost : 0;
}

// Round an order quantity up to the order multiple, then enforce MOQ.
function normalizeQty(qty, moq, mult) {
  let q = Math.max(0, Math.ceil(num(qty)));
  if (mult && mult > 1) q = Math.ceil(q / mult) * mult;
  if (moq && q > 0 && q < moq) q = moq;
  return q;
}

/**
 * budgetConstrainedPlan(items, budget, opts)
 *   items: engine reorderPlan rows (ideally econ-enriched). Uses orderQty, unitCost,
 *          stockoutProb, priority, moq, orderMultiple, econ.trueContribution.
 *   budget: cash available for this PO cycle (₹). If falsy/≤0 → everything funded (no constraint).
 * Ranks by protected-contribution-per-rupee and greedily fills the budget (whole-line, so
 * spend never exceeds budget). Returns funded + deferred with the risk of deferring.
 */
export function budgetConstrainedPlan(items = [], budget = 0, opts = {}) {
  const moqKey = opts.moqKey || 'moq';
  const multKey = opts.orderMultipleKey || 'orderMultiple';

  const scored = items.map(it => {
    const qty = normalizeQty(it.orderQty, num(it[moqKey]), num(it[multKey]));
    const unitCost = num(it.unitCost) || num(it.cost);
    const orderCost = r0(qty * unitCost);
    const tc = Math.max(0, unitContribution(it));
    const stockoutP = Math.min(1, Math.max(0, num(it.stockoutProb) / 100));
    // Expected contribution PROTECTED by placing this order = P(stockout) × contribution × qty.
    const protectedContribution = r0(stockoutP * tc * qty);
    const roi = orderCost > 0 ? protectedContribution / orderCost : (protectedContribution > 0 ? Infinity : 0);
    return { ...it, _qty: qty, _orderCost: orderCost, _protected: protectedContribution, _roi: roi };
  }).filter(it => it._qty > 0 && it._orderCost > 0);

  // Rank: highest protected-contribution-per-rupee first, then business priority.
  scored.sort((a, b) => (b._roi - a._roi) || ((PRIORITY_RANK[a.priority] ?? 3) - (PRIORITY_RANK[b.priority] ?? 3)) || (b._protected - a._protected));

  const noConstraint = !budget || budget <= 0;
  const funded = [], deferred = [];
  let spent = 0;

  // Whole-line greedy: pack the highest-ROI orders that fit.
  for (const it of scored) {
    if (noConstraint || spent + it._orderCost <= budget) { funded.push(it); spent += it._orderCost; }
    else deferred.push(it);
  }

  // Partial-fill: units are divisible, so spend leftover budget on the top-ROI deferred SKU
  // (buy as many units as the budget allows, respecting MOQ / order multiple). This is what
  // makes the plan actionable for cash-strapped sellers instead of funding nothing.
  if (!noConstraint) {
    const remaining = budget - spent;
    for (let i = 0; i < deferred.length; i++) {
      const it = deferred[i];
      const unitCost = num(it.unitCost) || num(it.cost);
      if (it._roi > 0 && unitCost > 0) {
        const moq = num(it[moqKey]), mult = num(it[multKey]);
        let units = Math.floor(remaining / unitCost);
        if (mult > 1) units = Math.floor(units / mult) * mult;
        if (units >= Math.max(moq, 1) && units >= 1 && units < it._qty) {
          const tc = Math.max(0, unitContribution(it));
          const stockoutP = Math.min(1, Math.max(0, num(it.stockoutProb) / 100));
          it._fullQty = it._qty; it._qty = units; it._orderCost = Math.floor(units * unitCost);
          it._protected = r0(stockoutP * tc * units); it._partial = true;
          funded.push(it); spent += it._orderCost; deferred.splice(i, 1);
          break;
        }
      }
    }
  }

  // Totals from the final allocation (single source of truth — no incremental drift).
  const protectedTotal = funded.reduce((a, it) => a + it._protected, 0);
  const deferredRisk = deferred.reduce((a, it) => a + it._protected, 0);

  const shape = it => ({
    sku: it.sku, product: it.product, category: it.category, brand: it.brand,
    supplier: it.supplier || null, channel: it.channel || null, warehouse: it.warehouse || null,
    orderQty: it._qty, unitCost: num(it.unitCost) || num(it.cost), orderCost: it._orderCost,
    partiallyFunded: !!it._partial, fullOrderQty: it._partial ? it._fullQty : it._qty,
    priority: it.priority, stockoutProb: num(it.stockoutProb),
    trueContributionPerUnit: Math.round(unitContribution(it) * 100) / 100,
    protectedContribution: it._protected, roiPerRupee: it._roi === Infinity ? null : Math.round(it._roi * 100) / 100,
    reorderBy: it.reorderBy || null, leadTimeDays: num(it.leadTimeDays) || null,
  });

  return {
    budget: noConstraint ? null : r0(budget),
    spent: r0(spent), remaining: noConstraint ? null : r0(budget - spent),
    fundedCount: funded.length, deferredCount: deferred.length,
    protectedContribution: r0(protectedTotal), deferredContributionAtRisk: r0(deferredRisk),
    funded: funded.map(shape), deferred: deferred.map(shape),
  };
}

/**
 * groupPurchaseOrders(items, opts)
 *   opts.groupBy: 'supplier' (default, e-commerce POs) | 'warehouse' | 'city' (q-commerce
 *                 dark-store replenishment) | 'channel'
 * Produces ready-to-render PO / replenishment documents: MOQ + order-multiple normalized
 * quantities, line values, PO value, earliest reorder-by date, max lead time per group.
 */
export function groupPurchaseOrders(items = [], opts = {}) {
  const groupBy = opts.groupBy || 'supplier';
  const moqKey = opts.moqKey || 'moq';
  const multKey = opts.orderMultipleKey || 'orderMultiple';
  const isReplen = groupBy === 'warehouse' || groupBy === 'city';

  const groups = {};
  for (const it of items) {
    const qty = normalizeQty(it.orderQty, num(it[moqKey]), num(it[multKey]));
    if (qty <= 0) continue;
    const key = (it[groupBy] && String(it[groupBy]).trim()) || (groupBy === 'supplier' ? 'Unassigned supplier' : 'Unspecified');
    const unitCost = num(it.unitCost) || num(it.cost);
    const line = {
      sku: it.sku, product: it.product, category: it.category, brand: it.brand,
      qty, unitCost, lineValue: r0(qty * unitCost),
      reorderBy: it.reorderBy || null, leadTimeDays: num(it.leadTimeDays) || null, priority: it.priority || null,
    };
    (groups[key] = groups[key] || { key, groupType: groupBy, lines: [], units: 0, poValue: 0, leadTimeDays: 0 });
    const g = groups[key];
    g.lines.push(line); g.units += qty; g.poValue += line.lineValue;
    if (line.leadTimeDays && line.leadTimeDays > g.leadTimeDays) g.leadTimeDays = line.leadTimeDays;
  }

  return Object.values(groups).map(g => {
    g.lines.sort((a, b) => b.lineValue - a.lineValue);
    const dates = g.lines.map(l => parseReorderBy(l.reorderBy)).filter(Boolean).sort((a, b) => a - b);
    return {
      documentType: isReplen ? 'Replenishment Plan' : 'Purchase Order',
      groupType: g.groupType, name: g.key,
      lineCount: g.lines.length, totalUnits: g.units, poValue: r0(g.poValue),
      leadTimeDays: g.leadTimeDays || null,
      earliestReorderBy: dates.length ? fmtDate(dates[0]) : null,
      lines: g.lines,
    };
  }).sort((a, b) => b.poValue - a.poValue);
}

// Accepts en-GB (dd/mm/yyyy) — what the engine emits — plus ISO. Returns Date or null.
function parseReorderBy(s) {
  if (!s || /now|week|ok/i.test(String(s))) return null;
  const dmy = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (dmy) { const y = dmy[3].length === 2 ? '20' + dmy[3] : dmy[3]; const d = new Date(+y, +dmy[2] - 1, +dmy[1]); return isNaN(d) ? null : d; }
  const d = new Date(s); return isNaN(d) ? null : d;
}
function fmtDate(d) { return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
