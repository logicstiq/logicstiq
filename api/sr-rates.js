// Live courier rates via Shiprocket (an aggregator: Delhivery, Blue Dart, Xpressbees,
// DTDC, Ekart and more through one integration). This is roadmap PHASE 1 — read-only
// serviceability + rate comparison. Nothing is ever created, so it is zero-risk.
//
// Free to run: a Shiprocket account is free and rate checks need no card.
// If credentials aren't set, we return {source:"unconfigured"} and the front-end quietly
// keeps showing its built-in benchmark rates — the tool never breaks.
//
// Input  (POST JSON): { pickup, delivery, weightKg, cod }   pincodes are 6-digit
// Output (200 JSON) : { source, pickup, delivery, weightKg, cod, couriers:[{name,rate,etdDays,rating,cod}] }
const { srGet, isConfigured } = require("./_sr");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const b = req.body || {};
  const pickup = String(b.pickup || "").trim();
  const delivery = String(b.delivery || "").trim();
  const weightKg = Number(b.weightKg) > 0 ? Number(b.weightKg) : 0.5;
  const cod = b.cod ? 1 : 0;

  if (!isConfigured()) {
    return res.status(200).json({
      source: "unconfigured", couriers: [],
      note: "Set SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD in Vercel to switch on live rates.",
    });
  }
  if (!/^\d{6}$/.test(pickup) || !/^\d{6}$/.test(delivery)) {
    return res.status(400).json({ error: "pickup and delivery must be 6-digit Indian pincodes" });
  }

  try {
    const q = "courier/serviceability/?pickup_postcode=" + pickup +
      "&delivery_postcode=" + delivery + "&weight=" + weightKg + "&cod=" + cod;
    const out = await srGet(q);
    if (out.unconfigured) return res.status(200).json({ source: "unconfigured", couriers: [] });
    if (!out.ok) {
      const msg = out.data && (out.data.message || out.data.error);
      return res.status(200).json({ source: "error", couriers: [], note: msg || "Shiprocket rate lookup failed." });
    }
    const list = (out.data && out.data.data && out.data.data.available_courier_companies) || [];
    const couriers = list.map((c) => ({
      name: c.courier_name,
      rate: Math.round(Number(c.rate) || 0),
      etdDays: c.estimated_delivery_days || null,
      etd: c.etd || null,
      rating: c.rating != null ? Math.round(Number(c.rating) * 10) / 10 : null,
      cod: c.cod === 1 || c.is_cod_available === 1,
    })).filter((c) => c.rate > 0).sort((a, b) => a.rate - b.rate);
    return res.status(200).json({
      source: "shiprocket", pickup, delivery, weightKg, cod, count: couriers.length, couriers,
    });
  } catch (e) {
    return res.status(200).json({ source: "error", couriers: [], note: "Rate lookup failed." });
  }
};
