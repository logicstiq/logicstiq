// Live shipment tracking by AWB via Shiprocket (on-demand — the free half of the
// roadmap's tracking phase; no webhook or database needed). Read-only.
//
// Free to run with a Shiprocket account. If credentials aren't set we return
// {source:"unconfigured"} and the front-end keeps showing its milestone timeline.
//
// Input  (POST { awb }  or  GET ?awb=...)
// Output (200 JSON): { source, awb, status, courier, origin, destination, etd, scans:[{date,activity,location}] }
const { srGet, isConfigured } = require("./_sr");

module.exports = async (req, res) => {
  const awb = String(
    (req.method === "POST" ? (req.body || {}).awb : (req.query || {}).awb) || ""
  ).trim();

  if (!isConfigured()) {
    return res.status(200).json({
      source: "unconfigured",
      note: "Set SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD in Vercel to switch on live tracking.",
    });
  }
  if (!awb) return res.status(400).json({ error: "awb is required" });

  try {
    const out = await srGet("courier/track/awb/" + encodeURIComponent(awb));
    if (out.unconfigured) return res.status(200).json({ source: "unconfigured" });
    if (!out.ok) return res.status(200).json({ source: "error", note: "Tracking lookup failed." });

    // Shiprocket shape: { tracking_data: { shipment_track:[{...}], shipment_track_activities:[{...}] } }
    const td = (out.data && out.data.tracking_data) || {};
    const head = (Array.isArray(td.shipment_track) && td.shipment_track[0]) || {};
    const acts = Array.isArray(td.shipment_track_activities) ? td.shipment_track_activities : [];
    const scans = acts.map((a) => ({
      date: a.date || a.updated_at || "",
      activity: a.activity || a["sr-status-label"] || a.status || "",
      location: a.location || "",
    }));
    return res.status(200).json({
      source: "shiprocket",
      awb,
      status: head.current_status || td.shipment_status_text || (scans[0] && scans[0].activity) || "Unknown",
      courier: head.courier_name || "",
      origin: head.origin || "",
      destination: head.destination || "",
      etd: head.edd || td.etd || "",
      scans,
    });
  } catch (e) {
    return res.status(200).json({ source: "error", note: "Tracking lookup failed." });
  }
};
