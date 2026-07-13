// LogicstIQ AI Copilot — Vercel Serverless Function (ES Module)
// -----------------------------------------------------------------------------------------
// WHY .mjs: the .mjs extension forces ES-module mode for THIS FILE ONLY, so it coexists
// with your existing api/forecast.js whatever module style that uses — and requires NO
// change to your package.json. Just drop this file into your /api folder next to forecast.js.
// Endpoint becomes /api/copilot automatically.
//
// WHY A BACKEND AT ALL: the API key must NEVER live in front-end code. Anyone can "View
// Source" on a static site, so the key stays here on the server. The browser calls
// /api/copilot; this function calls Groq.
//
// PROVIDER: Groq (FREE tier, no credit card, no-training privacy policy).
//   - OpenAI-compatible API. Model llama-3.3-70b-versatile: best quality, ~1,000 req/day free.
//   - Swap to llama-3.1-8b-instant for ~14,400 req/day if you need more volume.
// When the free daily cap is hit, Groq returns 429 and the widget shows a friendly
// "the copilot is busy" message — this doubles as automatic cost control.
//
// SET THESE IN VERCEL (Project -> Settings -> Environment Variables), NOT in code:
//   GROQ_API_KEY   = your key from console.groq.com  (free, no card)
//   ALLOWED_ORIGIN = https://www.logicstiq.com       (locks the API to your domain)

const API_URL = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "llama-3.3-70b-versatile"; // quality pick; use "llama-3.1-8b-instant" for higher free volume
const MAX_TOKENS = 900;
const MAX_INPUT_CHARS = 2000; // reject absurdly long inputs (cost + abuse guard)

// --- Domain guardrail: this is what makes the copilot "purely e-commerce supply chain" ---
const SYSTEM_PROMPT = `You are the LogicstIQ Copilot, an expert assistant for END-TO-END E-COMMERCE SUPPLY CHAIN.

SCOPE — you help online sellers, D2C brands, and operations teams (especially in India) with:
- Demand forecasting & demand planning (seasonality: Diwali, Big Billion Days, Prime Day, EOSS)
- Inventory management: safety stock, reorder point, EOQ, ABC analysis, dead stock, days of cover
- Marketplace operations: Amazon (FBA/FBM), Flipkart, Myntra, Nykaa, Ajio, quick-commerce (Blinkit, Zepto, Instamart)
- Warehousing, fulfillment, 3PL, pick-pack, returns/RTO management
- Logistics & transportation: freight, last-mile, shipping cost, OTIF, lead time variability
- Procurement & supplier management: lead times, MOQ, supplier risk
- Order management, listing/catalog ops, and unit economics (contribution margin, CM2/CM3)
- EXIM / cross-border basics: Incoterms, HS codes, IEC, shipping bill vs bill of entry, RoDTEP (high level only)
- Key metrics: fill rate, stockout rate, inventory turnover, GMROI, sell-through, RTO %

STYLE:
- Be practical and specific. Prefer numbers, formulas, and step-by-step actions over theory.
- When a formula applies, show it (e.g., Reorder Point = (avg daily demand x lead time) + safety stock).
- Use India-specific context where relevant. Keep answers concise; use short lists for steps.
- When a LogicstIQ tool fits, point the user to it: the 31 calculators, the AI Demand Planner
  (upload your sales/inventory file for reorder + forecast), or the Documents Generator
  (GST invoices, POs, and EXIM docs). Do not invent tool URLs.

BOUNDARIES:
- If a question is clearly OUTSIDE e-commerce supply chain / operations (e.g., medical, legal,
  coding help, general trivia), politely decline in one line and steer back:
  "I'm focused on e-commerce supply chain — ask me about inventory, forecasting, logistics, or marketplaces."
- For statutory EXIM/GST filing specifics, remind users to validate against current Customs/DGFT/GST rules
  and file on the official portals (ICEGATE/DGFT). You are an assistant, not a customs broker.
- Never invent statistics about specific companies. Never claim to access the user's live data.
- You are an educational assistant, not a substitute for professional financial/legal advice.`;

// --- Very small in-memory rate limiter (per warm instance). ---
// Serverless spins up many instances, so this is only a light guard. For a real global
// cap use a shared store (Upstash Redis) — see the deployment guide.
const HITS = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 12;
function rateLimited(ip) {
  const now = Date.now();
  const rec = HITS.get(ip) || { count: 0, start: now };
  if (now - rec.start > WINDOW_MS) {
    rec.count = 0;
    rec.start = now;
  }
  rec.count += 1;
  HITS.set(ip, rec);
  return rec.count > MAX_PER_WINDOW;
}

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const fwd = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(fwd) ? fwd[0] : (fwd || "unknown")).split(",")[0].trim();
  if (rateLimited(ip)) return res.status(429).json({ error: "Too many requests. Please slow down." });

  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "Server not configured." });

  // Vercel auto-parses JSON bodies; fall back to manual parse just in case.
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body || "{}"); } catch { return res.status(400).json({ error: "Invalid JSON." }); }
  }
  body = body || {};

  // history is an array of {role:"user"|"assistant", content:"..."} — keeps conversation context.
  const history = Array.isArray(body.messages) ? body.messages.slice(-10) : [];
  const latest = history[history.length - 1];
  if (!latest || latest.role !== "user" || typeof latest.content !== "string")
    return res.status(400).json({ error: "No user message." });
  if (latest.content.length > MAX_INPUT_CHARS)
    return res.status(400).json({ error: "Message too long." });

  // OpenAI-compatible format: system prompt is the first message.
  const chatMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_INPUT_CHARS) })),
  ];

  try {
    const resp = await fetch(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0.3,
        messages: chatMessages,
      }),
    });

    if (resp.status === 429)
      return res.status(429).json({ error: "The copilot is busy right now. Please try again shortly." });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("Provider error:", resp.status, errText);
      return res.status(502).json({ error: "Assistant is busy. Try again." });
    }

    const data = await resp.json();
    const reply = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
    return res.status(200).json({ reply });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Unexpected error." });
  }
}
