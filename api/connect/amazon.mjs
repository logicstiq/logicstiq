// ═══════════════════════════════════════════════════════════════════════════════════════════
// connect/amazon.mjs — LogistiQ — AMAZON SP-API CONNECTOR (God-mode add-on v1)
// ─────────────────────────────────────────────────────────────────────────────
// Official Amazon Selling Partner API only (NOT Seller Central scraping — that gets accounts
// banned and violates Amazon's terms). Flow: LWA refresh-token → access token → pull Orders +
// FBA Inventory → normalize into the engine CSV.
//
// SECRETS from environment ONLY (never hard-coded / returned to client):
//   LWA_CLIENT_ID, LWA_CLIENT_SECRET, SPAPI_REFRESH_TOKEN, SPAPI_HOST
//   (India → SPAPI_HOST=sellingpartnerapi-eu.amazon.com, marketplaceId A21TJRUUN4KGV)
//
// Since 2023 SP-API needs only the LWA token (no AWS SigV4/IAM role). Requires a registered SP-API
// app + seller authorization; live calls must be tested against a real seller account.
// The normalizer is fully unit-tested; the pull functions follow the documented endpoints.
// ─────────────────────────────────────────────────────────────────────────────
import { canonicalFromAmazon, toForecastCsv } from '../../lib/normalize.mjs';

const IN_MARKETPLACE = 'A21TJRUUN4KGV';   // Amazon.in
function env(k, d) { return (typeof process !== 'undefined' && process.env && process.env[k]) || d; }

// LWA: exchange the long-lived refresh token for a short-lived access token.
export async function lwaAccessToken({ refreshToken, clientId, clientSecret } = {}) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken || env('SPAPI_REFRESH_TOKEN'),
    client_id: clientId || env('LWA_CLIENT_ID'),
    client_secret: clientSecret || env('LWA_CLIENT_SECRET'),
  });
  const r = await fetch('https://api.amazon.com/auth/o2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error('LWA token exchange failed: ' + r.status);
  return (await r.json()).access_token;
}

async function spGet(host, path, token, params = {}) {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`https://${host}${path}${q ? '?' + q : ''}`, { headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error('SP-API ' + r.status + ' on ' + path);
  return r.json();
}

// Pull orders + line items (Orders API v0). Paginated via NextToken, capped for the serverless window.
export async function fetchOrders(host, token, { marketplaceId = IN_MARKETPLACE, sinceDays = 120, maxPages = 8 } = {}) {
  const createdAfter = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const out = []; let next = null, pages = 0;
  do {
    const p = next ? { NextToken: next, MarketplaceIds: marketplaceId } : { MarketplaceIds: marketplaceId, CreatedAfter: createdAfter };
    const j = await spGet(host, '/orders/v0/orders', token, p);
    const list = (j.payload && j.payload.Orders) || [];
    for (const o of list) {
      const items = await spGet(host, `/orders/v0/orders/${o.AmazonOrderId}/orderItems`, token);
      o.OrderItems = (items.payload && items.payload.OrderItems) || [];
    }
    out.push(...list); next = j.payload && j.payload.NextToken; pages++;
  } while (next && pages < maxPages);
  return out;
}

// Pull FBA inventory summaries (FBA Inventory API v1).
export async function fetchFbaInventory(host, token, { marketplaceId = IN_MARKETPLACE } = {}) {
  const j = await spGet(host, '/fba/inventory/v1/summaries', token, { granularityType: 'Marketplace', granularityId: marketplaceId, marketplaceIds: marketplaceId, details: 'true' });
  const list = (j.payload && j.payload.inventorySummaries) || [];
  return list.map(s => ({
    'seller-sku': s.sellerSku, asin: s.asin, 'product-name': s.productName,
    'afn-fulfillable-quantity': s.inventoryDetails ? s.inventoryDetails.fulfillableQuantity : s.totalQuantity,
    'afn-reserved-quantity': s.inventoryDetails && s.inventoryDetails.reservedQuantity ? s.inventoryDetails.reservedQuantity.totalReservedQuantity : 0,
    'afn-inbound-shipped-quantity': s.inventoryDetails ? s.inventoryDetails.inboundShippedQuantity : 0,
  }));
}

// One-shot: pull + normalize → engine CSV.
export async function syncAmazon(opts = {}) {
  const host = opts.host || env('SPAPI_HOST', 'sellingpartnerapi-eu.amazon.com');
  const token = await lwaAccessToken(opts);
  const [orders, fbaInventory] = await Promise.all([fetchOrders(host, token, opts), fetchFbaInventory(host, token, opts)]);
  return { csv: toForecastCsv(canonicalFromAmazon({ orders, fbaInventory })), counts: { orders: orders.length, skus: fbaInventory.length } };
}

// ── Serverless handler: /api/connect/amazon (POST) ────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  if (!env('LWA_CLIENT_ID') || !env('SPAPI_REFRESH_TOKEN')) return res.status(500).json({ error: 'SP-API credentials not configured (LWA_CLIENT_ID / SPAPI_REFRESH_TOKEN).' });
  try { return res.status(200).json({ ok: true, ...(await syncAmazon(req.body || {})) }); }
  catch (e) { return res.status(400).json({ error: e.message }); }
}
