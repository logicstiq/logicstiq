# LogistiQ Connectors — setup guide

Turn the planner from "upload a CSV" into "connect once, sync forever." Official seller APIs only — **never scraping** (it gets accounts banned and breaks marketplace terms).

## How it flows

```
Marketplace API  →  lib/normalize.mjs  →  engine CSV  →  /api/forecast  →  plan
   (Shopify / Amazon)      (canonical rows)                         (unchanged engine)
```

Every marketplace maps into one canonical row shape, so adding a marketplace = one normalizer; the engine, economics, buy plan and FBA logic all work unchanged. The normalizer + history math are fully unit-tested (`node test/connectors.test.mjs`, 24 assertions). The OAuth handshakes are written to spec but **must be tested live** against a real store/seller account — they can't be exercised without registered apps.

## 1. Shopify (`/api/connect/shopify`)

1. Create an app in the **Shopify Partner dashboard** (custom or public app).
2. Set the **redirect URL** to `https://YOUR_DOMAIN/api/connect/shopify?action=callback`.
3. Request scopes: `read_orders, read_products, read_inventory`.
4. Add these to Vercel → Environment Variables:

```
SHOPIFY_API_KEY=...          # app's API key (client id)
SHOPIFY_API_SECRET=...       # app's API secret  (NEVER commit this)
SHOPIFY_SCOPES=read_orders,read_products,read_inventory
APP_URL=https://YOUR_DOMAIN
```

5. Seller connects by visiting `/api/connect/shopify?action=install&shop=THEIRSTORE.myshopify.com`.
   The callback verifies the HMAC, exchanges the code for a token, pulls ~120 days of orders + products, normalizes to CSV, and returns it so the planner can forecast immediately.

**COGS note:** Shopify orders don't include unit cost. The engine handles this gracefully — it won't show false "profit drain" when cost is unknown (the True ₹/unit column shows "—"). To unlock true economics, pull `InventoryItem.cost` (extra Admin API call) or let sellers map a cost column.

## 2. Amazon (`/api/connect/amazon`)

Uses the official **Selling Partner API** (LWA token → Orders + FBA Inventory). Since 2023 no AWS SigV4/IAM role is needed — just the LWA token.

1. Register an **SP-API app** in Seller Central / Developer Central and complete authorization to get a **refresh token**.
2. Add to Vercel:

```
LWA_CLIENT_ID=...
LWA_CLIENT_SECRET=...         # NEVER commit
SPAPI_REFRESH_TOKEN=...       # NEVER commit
SPAPI_HOST=sellingpartnerapi-eu.amazon.com   # India/EU region
```

3. `POST /api/connect/amazon` → pulls orders + FBA inventory, normalizes to CSV.
   (Amazon.in marketplace id `A21TJRUUN4KGV` is the default.)

## 3. Saved history + forecast accuracy (`js/liq-history.js`)

Already wired into the Demand Planner (one `<script>` tag) and **needs no new secrets** — it reuses the seller's existing Firestore account (`window.LIQ`).

- After each forecast run it saves that run's per-SKU forecast to the user's private account.
- On a later run, when the newly uploaded/synced actuals cover a month it previously predicted, it scores the old forecast and shows an accuracy badge: *"~92% accurate (WMAPE 8%) across N SKU-months — e.g. KURTA-M: predicted 214, sold 227."*
- The pure math (`lib/history.mjs`: `mergeHistory`, `reconcileForecastVsActual`) is unit-tested.

**Next step (optional):** feed merged history back into the upload so each run forecasts on a longer series — `mergeHistory()` is ready; wiring it into the request body is the remaining hook.

## Security

- All tokens/secrets are read from environment variables only. Nothing secret is committed or returned to the browser by the server handlers.
- Keep `SHOPIFY_API_SECRET`, `LWA_CLIENT_SECRET`, and `SPAPI_REFRESH_TOKEN` in Vercel env vars, never in the repo.
