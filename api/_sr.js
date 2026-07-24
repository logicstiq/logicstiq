// Shared Shiprocket helper — SERVER-SIDE ONLY. Not a public route (the leading
// underscore tells Vercel not to expose it as an endpoint), so your login token
// is created here and never reaches the browser — same pattern as distance.js / tms-ai.js.
//
// Set these in Vercel → Project → Settings → Environment Variables (both optional —
// the whole TMS keeps working on its built-in data until you add them):
//   SHIPROCKET_EMAIL      your Shiprocket account email
//   SHIPROCKET_PASSWORD   your Shiprocket account password
//
// A Shiprocket account is free to create; browsing rates/serviceability needs no card.
// The auth token is long-lived (~10 days); we cache it in warm-instance memory.
const BASE = "https://apiv2.shiprocket.in/v1/external/";
const TOKEN_TTL = 8 * 864e5; // ~8 days (tokens last ~10; we refresh comfortably early)
let cachedToken = null, tokenAt = 0;

function isConfigured() {
  return !!(process.env.SHIPROCKET_EMAIL && process.env.SHIPROCKET_PASSWORD);
}

async function login() {
  const r = await fetch(BASE + "auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: process.env.SHIPROCKET_EMAIL,
      password: process.env.SHIPROCKET_PASSWORD,
    }),
  });
  const d = await r.json().catch(() => ({}));
  return d && d.token ? d.token : null;
}

async function getToken(force) {
  if (!isConfigured()) return null;
  if (!force && cachedToken && Date.now() - tokenAt < TOKEN_TTL) return cachedToken;
  cachedToken = await login();
  tokenAt = cachedToken ? Date.now() : 0;
  return cachedToken;
}

// GET a Shiprocket path (relative to BASE). Retries once on 401 with a fresh token.
async function srGet(path) {
  let token = await getToken();
  if (!token) return { ok: false, unconfigured: true };
  const call = (t) =>
    fetch(BASE + path, { headers: { Authorization: "Bearer " + t } });
  let r = await call(token);
  if (r.status === 401) {
    token = await getToken(true);
    if (token) r = await call(token);
  }
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

module.exports = { BASE, isConfigured, getToken, srGet };
