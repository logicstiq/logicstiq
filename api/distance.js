// Vercel serverless function — real road distances via the Mapbox Matrix API.
// Mapbox has a generous free tier and needs NO billing card to start.
// Your token stays here (server-side), never in the browser.
// Set MAPBOX_TOKEN in Vercel → Settings → Environment Variables.
//
// Input:  { points: [ { name:"Mumbai", ll:"19.076,72.8777" }, ... ] }   // ll is "lat,lng"
// Output: { matrix: { "Mumbai|Delhi": { km, min }, ... }, source:"mapbox" }
//
// Note: the Matrix API takes up to 25 coordinates per request — plenty for a route plan.
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const { points = [] } = req.body || {};
  const token = process.env.MAPBOX_TOKEN;
  if (!token) return res.status(500).json({ error: "MAPBOX_TOKEN not set" });
  if (points.length < 2) return res.status(200).json({ matrix: {}, source: "mapbox" });
  if (points.length > 25) points.length = 25; // Matrix API coordinate cap

  const names = points.map((p) => p.name);
  // Mapbox expects "lng,lat" (the reverse of Google); our input is "lat,lng".
  const coords = points
    .map((p) => { const [lat, lng] = p.ll.split(","); return lng + "," + lat; })
    .join(";");

  try {
    const url =
      "https://api.mapbox.com/directions-matrix/v1/mapbox/driving/" +
      coords +
      "?annotations=distance,duration&access_token=" + token;
    const r = await fetch(url);
    const data = await r.json();
    if (data.code !== "Ok")
      return res.status(500).json({ error: "Mapbox: " + data.code, detail: data.message });

    const matrix = {};
    (data.distances || []).forEach((row, i) => {
      row.forEach((meters, j) => {
        if (i === j || meters == null) return;
        matrix[names[i] + "|" + names[j]] = {
          km: Math.round(meters / 1000),
          min: Math.round((data.durations?.[i]?.[j] || 0) / 60),
        };
      });
    });
    res.status(200).json({ matrix, source: "mapbox" });
  } catch (e) {
    res.status(500).json({ error: "Distance lookup failed" });
  }
};
