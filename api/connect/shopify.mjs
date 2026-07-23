// ═══════════════════════════════════════════════════════════════════════════════════════════
// connect/shopify.mjs — LogistiQ — SHOPIFY CONNECTOR (God-mode add-on v1)
// ─────────────────────────────────────────────────────────────────────────────
// First real connector: OAuth install → token exchange → pull orders + products → normalize into
// the engine CSV (via connectors/normalize.mjs). Once connected, the planner syncs itself instead
// of asking for a manual export.
//
// SECRETS: read ONLY from environment (never hard-coded, never returned to the client):
//   SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_SCOPES (default read_orders,read_products,read_inventory),
//   APP_URL (your deployed origin, e.g. https://www.logicstiq.com)
//
// Pure, verifiable pieces (buildInstallUrl, verifyOauthHmac) are unit-tested. The live OAuth
// handshake requires a Shopify app + a deployed callback URL and must be tested on a real store.
// Official Shopify Admin API only — no scraping.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';
import { canonicalFromShopify, toForecastCsv } from '../../lib/normalize.mjs';

const API_VERSION = '2024-10';
const DEFAULT_SCOPES = 'read_orders,read_products,read_inventory';

function env(k, d) { return (typeof process !== 'undefined' && process.env && process.env[k]) || d; }
function assertShop(shop) { if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shop || '')) throw new Error('Invalid shop domain (expected xxx.myshopify.com)'); return shop; }

// Step 1 — install URL the seller is redirected to, to grant access.
export function buildInstallUrl(shop, { apiKey, scopes, redirectUri, state } = {}) {
  assertShop(shop);
  const key = apiKey || env('SHOPIFY_API_KEY');
  const sc = scopes || env('SHOPIFY_SCOPES', DEFAULT_SCOPES);
  const rc = redirectUri || (env('APP_URL', '') + '/api/connect/shopify?action=callback');
  const q = new URLSearchParams({ client_id: key || '', scope: sc, redirect_uri: rc, state: state || '' });
  return `https://${shop}/admin/oauth/authorize?${q.toString()}`;
}

// Step 2 — verify the OAuth callback HMAC (Shopify signs the query string).
export function verifyOauthHmac(query = {}, secret) {
  const sec = secret || env('SHOPIFY_API_SECRET'); if (!sec) return false;
  const { hmac, signature, ...rest } = query;
  const msg = Object.keys(rest).sort().map(k => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`).join('&');
  const digest = crypto.createHmac('sha256', sec).update(msg).digest('hex');
  try { return !!hmac && crypto.timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(String(hmac), 'utf8')); }
  catch { return false; }
}

// Verify a Shopify webhook (base64 HMAC of the raw body) — for future push sync.
export function verifyWebhookHmac(rawBody, headerHmac, secret) {
  const sec = secret || env('SHOPIFY_API_SECRET'); if (!sec || !headerHmac) return false;
  const digest = crypto.createHmac('sha256', sec).update(rawBody, 'utf8').digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(headerHmac))); } catch { return false; }
}

// Step 3 — exchange the temporary code for a permanent access token.
export async function exchangeCodeForToken(shop, code, { apiKey, apiSecret } = {}) {
  assertShop(shop);
  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: apiKey || env('SHOPIFY_API_KEY'), client_secret: apiSecret || env('SHOPIFY_API_SECRET'), code }),
  });
  if (!r.ok) throw new Error('Shopify token exchange failed: ' + r.status);
  return (await r.json()).access_token;
}

// Step 4 — pull orders + products with the token (paginated, capped for a serverless window).
export async function fetchShopifyData(shop, token, { sinceDays = 120, maxPages = 10 } = {}) {
  assertShop(shop);
  const base = `https://${shop}/admin/api/${API_VERSION}`;
  const hdr = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
  const sinceISO = new Date(Date.now() - sinceDays * 86400000).toISOString();

  async function page(path) {
    const out = []; let url = `${base}${path}`, pages = 0;
    while (url && pages < maxPages) {
      const r = await fetch(url, { headers: hdr }); if (!r.ok) throw new Error('Shopify API ' + r.status + ' on ' + path);
      const j = await r.json(); const key = Object.keys(j)[0]; out.push(...(j[key] || []));
      const link = r.headers.get('link') || ''; const m = link.match(/<([^>]+)>;\s*rel="next"/); url = m ? m[1] : null; pages++;
    }
    return out;
  }
  const orders = await page(`/orders.json?status=any&limit=250&created_at_min=${encodeURIComponent(sinceISO)}`);
  const products = await page(`/products.json?limit=250`);
  return { orders, products };
}

// One-shot: pull + normalize → engine CSV (what the front-end sends to /api/forecast).
export async function syncShopify(shop, token, opts) {
  const data = await fetchShopifyData(shop, token, opts);
  return { csv: toForecastCsv(canonicalFromShopify(data)), counts: { orders: data.orders.length, products: data.products.length } };
}

// ── Serverless handler: /api/connect/shopify?action=install|callback ──────────
export default async function handler(req, res) {
  const action = (req.query && req.query.action) || 'install';
  const shop = req.query && req.query.shop;
  try {
    if (action === 'install') {
      if (!env('SHOPIFY_API_KEY')) return res.status(500).json({ error: 'SHOPIFY_API_KEY not configured' });
      const state = crypto.randomBytes(16).toString('hex');
      res.setHeader('Set-Cookie', `liq_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
      return res.redirect(302, buildInstallUrl(shop, { state }));
    }
    if (action === 'callback') {
      if (!verifyOauthHmac(req.query)) return res.status(401).json({ error: 'HMAC validation failed' });
      const token = await exchangeCodeForToken(shop, req.query.code);
      const { csv, counts } = await syncShopify(shop, token);
      // NOTE: persist `token` in the seller's private store to enable scheduled syncs.
      // Client-side js/liq-history.js saves it to the user's Firestore; server-side persistence
      // would use a datastore + admin credentials (env-based) — intentionally not done here.
      return res.status(200).json({ ok: true, shop, counts, csv });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) { return res.status(400).json({ error: e.message }); }
}
