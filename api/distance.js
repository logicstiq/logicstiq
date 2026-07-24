// Vercel serverless function — real road distances via OpenRouteService (ORS).
// ORS is free and needs NO credit card — just a free API key from openrouteservice.org.
// Your key stays here (server-side), never in the browser.
// Set ORS_TOKEN in Vercel → Settings → Environment Variables.
//
// Input:  { points: [ { name:"Mumbai", ll:"19.076,72.8777" }, ... ] }   // ll is "lat,lng"
// Output: { matrix: { "Mumbai|Delhi": { km, min }, ... }, source:"ors" }
//
// The free matrix handles well over 25 stops; we cap at 25 to stay comfortably in limits.
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { points = [] } = req.body || {};
  const token = process.env.ORS_TOKEN;
  if (!token) return res.status(500).json({ error: "ORS_TOKEN not set" });
  if (points.length < 2) return res.status(200).json({ matrix: {}, source: "ors" });
  if (points.length > 25) points.length = 25;

  const names = points.map((p) => p.name);
  // ORS expects [lng, lat] pairs (the reverse of our "lat,lng" input).
  const locations = points.map((p) => {
    const [lat, lng] = p.ll.split(",").map(Number);
    return [lng, lat];
  });

  try {
    const r = await fetch("https://api.openrouteservice.org/v2/matrix/driving-car", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: token },
      body: JSON.stringify({ locations, metrics: ["distance", "duration"] }),
    });
    const data = await r.json();
    if (!data.distances) return res.status(500).json({ error: "ORS error", detail: data.error || data });

    const matrix = {};
    data.distances.forEach((row, i) => {
      row.forEach((meters, j) => {
        if (i === j || meters == null) return;
        matrix[names[i] + "|" + names[j]] = {
          km: Math.round(meters / 1000),
          min: Math.round((data.durations?.[i]?.[j] || 0) / 60),
        };
      });
    });
    res.status(200).json({ matrix, source: "ors" });
  } catch (e) {
    res.status(500).json({ error: "Distance lookup failed" });
  }
};
