// ═══════════════════════════════════════════════════════════════════════════════════════════
// sourcing.mjs — LogistiQ Sourcing & Procurement — DECISION ENGINE (God-mode add-on v1)
// ─────────────────────────────────────────────────────────────────────────────
// Turns the Sourcing tool into the procurement brain that closes the loop with the planner:
//   • scoreSupplier()      — weighted supplier scorecard (OTIF, lead-time reliability, price,
//                            quality/defects, fill rate) → 0–100 composite + A/B/C/D grade.
//   • compareLandedCost()  — landed cost per unit across supplier quotes (price + freight + duty
//                            + other), MOQ/lead-time aware, ranked, best pick.
//   • reorderToPurchaseOrders() — convert a planner reorder plan into supplier POs with expected
//                            receipt dates; the resulting qty flows back as "inbound" to the planner.
// SELF-CONTAINED, no imports, plain-Node testable, no visual/copy changes.
// ─────────────────────────────────────────────────────────────────────────────

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r2 = x => Math.round(x * 100) / 100;
const r0 = x => Math.round(x);
function num(v) { if (v == null || v === '') return 0; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[₹$£€,\s%]/g, '')); return isNaN(n) ? 0 : n; }

const DEFAULT_WEIGHTS = { otif: 0.30, leadReliability: 0.20, price: 0.20, quality: 0.20, fill: 0.10 };

/**
 * scoreSupplier(s, opts) → composite 0–100 score + grade + component breakdown.
 *   s: { supplier, otifPct, leadTimeDays, leadTimeVarDays, priceIndex (1.0 = market),
 *        defectPct, fillRatePct }
 * Higher is better. priceIndex < 1 means cheaper than market (good).
 */
export function scoreSupplier(s = {}, opts = {}) {
  const w = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  const otif = clamp(num(s.otifPct), 0, 100);
  // Lead-time reliability: penalise variability relative to lead time (CV of lead time).
  const lt = Math.max(1, num(s.leadTimeDays));
  const cv = num(s.leadTimeVarDays) / lt;
  const leadReliability = clamp(100 * (1 - clamp(cv, 0, 1)), 0, 100);
  // Price: priceIndex 0.8→100, 1.0→60, 1.2→20 (cheaper scores higher).
  const pi = s.priceIndex != null ? num(s.priceIndex) : 1;
  const price = clamp(160 - 100 * pi, 0, 100);
  const quality = clamp(100 - num(s.defectPct) * 5, 0, 100);   // 20% defects → 0
  const fill = clamp(num(s.fillRatePct), 0, 100);
  const composite = otif * w.otif + leadReliability * w.leadReliability + price * w.price + quality * w.quality + fill * w.fill;
  const score = Math.round(composite);
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D';
  const risks = [];
  if (otif < 85) risks.push('OTIF below 85% — delivery reliability risk');
  if (cv > 0.3) risks.push('High lead-time variability — inflate safety stock');
  if (num(s.defectPct) > 3) risks.push('Elevated defect rate — quality risk');
  if (pi > 1.05) risks.push('Priced above market — renegotiate or dual-source');
  return {
    supplier: s.supplier || 'Unknown', score, grade,
    components: { otif: r0(otif), leadReliability: r0(leadReliability), price: r0(price), quality: r0(quality), fill: r0(fill) },
    leadTimeDays: lt, leadTimeCv: r2(cv), risks,
    recommendation: grade === 'A' ? 'Preferred — consolidate volume here' : grade === 'D' ? 'Replace or dual-source' : 'Approved — monitor and improve weak components',
  };
}

/** rankSuppliers(list, opts) → scored suppliers sorted best-first. */
export function rankSuppliers(list = [], opts = {}) {
  return list.map(s => scoreSupplier(s, opts)).sort((a, b) => b.score - a.score);
}

/**
 * compareLandedCost(quotes, opts) → landed cost per unit for each quote, ranked cheapest-first.
 *   quotes: [{ supplier, unitPrice, freightPerUnit, dutyPct, otherPerUnit, moq, leadTimeDays, gstPct, itcShare }]
 * Landed = unitPrice + freightPerUnit + otherPerUnit + duty + non-creditable GST.
 */
export function compareLandedCost(quotes = [], opts = {}) {
  const itcShare = opts.itcShare != null ? opts.itcShare : 1;   // registered sellers reclaim GST
  const ranked = quotes.map(q => {
    const unit = num(q.unitPrice), freight = num(q.freightPerUnit), other = num(q.otherPerUnit);
    const duty = unit * (num(q.dutyPct) / 100);
    const gst = (unit + freight + duty) * (num(q.gstPct) / 100) * (1 - (q.itcShare != null ? q.itcShare : itcShare));
    const landed = r2(unit + freight + other + duty + gst);
    return { supplier: q.supplier || 'Quote', unitPrice: r2(unit), freightPerUnit: r2(freight), duty: r2(duty), gstNet: r2(gst), otherPerUnit: r2(other), landedPerUnit: landed, moq: num(q.moq) || null, leadTimeDays: num(q.leadTimeDays) || null };
  }).sort((a, b) => a.landedPerUnit - b.landedPerUnit);
  const best = ranked[0] || null;
  const worst = ranked[ranked.length - 1] || null;
  const savingsVsWorst = best && worst ? r2(worst.landedPerUnit - best.landedPerUnit) : 0;
  return { ranked, best, savingsVsWorstPerUnit: savingsVsWorst, savingsPct: best && worst && worst.landedPerUnit ? Math.round((savingsVsWorst / worst.landedPerUnit) * 100) : 0 };
}

/**
 * reorderToPurchaseOrders(items, opts) → supplier-grouped POs with expected receipt dates.
 *   items: planner reorder rows { sku, product, supplier|brand, orderQty, unitCost, moq, orderMultiple, leadTimeDays }
 * The resulting per-PO quantity is what the planner should treat as INBOUND once placed.
 */
export function reorderToPurchaseOrders(items = [], opts = {}) {
  const supplierKey = opts.supplierKey || 'supplier';
  const today = opts.today ? new Date(opts.today) : new Date();
  const groups = {};
  for (const it of items) {
    let qty = Math.max(0, Math.ceil(num(it.orderQty)));
    const mult = num(it.orderMultiple); if (mult > 1) qty = Math.ceil(qty / mult) * mult;
    const moq = num(it.moq); if (moq && qty > 0 && qty < moq) qty = moq;
    if (qty <= 0) continue;
    const name = (it[supplierKey] || it.supplier || it.brand || 'Unassigned supplier');
    const unitCost = num(it.unitCost) || num(it.cost);
    const lt = num(it.leadTimeDays) || opts.defaultLeadTime || 30;
    const g = (groups[name] = groups[name] || { supplier: name, lines: [], poValue: 0, maxLeadTime: 0 });
    g.lines.push({ sku: it.sku, product: it.product, qty, unitCost: r2(unitCost), lineValue: r0(qty * unitCost), leadTimeDays: lt });
    g.poValue += r0(qty * unitCost);
    if (lt > g.maxLeadTime) g.maxLeadTime = lt;
  }
  return Object.values(groups).map(g => {
    const eta = new Date(today); eta.setDate(eta.getDate() + g.maxLeadTime);
    g.lines.sort((a, b) => b.lineValue - a.lineValue);
    return {
      supplier: g.supplier, lineCount: g.lines.length,
      totalUnits: g.lines.reduce((a, l) => a + l.qty, 0), poValue: r0(g.poValue),
      leadTimeDays: g.maxLeadTime, expectedReceipt: eta.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
      inboundUnits: g.lines.reduce((a, l) => a + l.qty, 0),   // feeds back to the planner as inbound
      lines: g.lines,
    };
  }).sort((a, b) => b.poValue - a.poValue);
}
