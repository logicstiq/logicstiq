// ═══════════════════════════════════════════════════════════════════════════════════════════
// ai.mjs — LogistiQ — SHARED GEMINI ENDPOINT (God-mode add-on v1)
// ─────────────────────────────────────────────────────────────────────────────
// ONE endpoint that powers AI narrative/drafting/extraction across Sourcing, Paperwork Hub and
// the planners — instead of one function per tool (keeps us under Vercel's 12-function cap).
// Uses the SAME GEMINI_API_KEY (env only, never in the browser) and the same gemini-2.5-flash model.
//
// HARD GUARDRAIL (critical for a tax/compliance product): Gemini may DRAFT, EXPLAIN, SUMMARIZE,
// EXTRACT and SUGGEST (clearly labelled) — it must NEVER invent authoritative numbers, GSTINs,
// HSN codes, tax rates or legal text as fact. Deterministic engines remain the source of truth.
//
// POST /api/ai  { task, data?, text? }  →  { ok, task, result }  (result: string, or {items|suggestions})
// ─────────────────────────────────────────────────────────────────────────────

const MODEL = 'gemini-2.5-flash';
const SYSTEM = `You are LogistiQ's procurement & paperwork assistant for Indian e-commerce sellers.
RULES: Never invent or assert authoritative numbers, GSTINs, HSN codes, tax rates, prices or legal/statutory text as fact. You may draft communications, explain requirements, summarise, extract structured data from text the user pasted, and offer clearly-labelled SUGGESTIONS the user must verify. Use ONLY the data provided; do not fabricate figures. Be concise, practical and India-aware (GST, RTO, marketplaces).`;

// Task registry: prompt builder + whether we want strict JSON back. Exported for testing.
export function buildPrompt(task, { data = null, text = '' } = {}) {
  const d = data != null ? JSON.stringify(data) : '';
  switch (task) {
    case 'supplier-review':
      return { wantJson: false, prompt: `Given this COMPUTED supplier scorecard, write 3-4 crisp sentences: the verdict, the biggest risk, and one negotiation ask. Do not invent numbers beyond those given.\nSCORECARD: ${d}` };
    case 'landed-cost-explain':
      return { wantJson: false, prompt: `Given these COMPUTED landed-cost quotes (already ranked), explain in 2-3 sentences why the best pick wins on landed cost (not sticker price) and one negotiation lever. Use only these numbers.\nQUOTES: ${d}` };
    case 'rfq-email':
      return { wantJson: false, prompt: `Draft a short, professional RFQ (request-for-quote) email to a supplier for these items. Leave prices blank for them to fill. Neutral, courteous tone.\nCONTEXT: ${d}${text ? '\nNOTES: ' + text : ''}` };
    case 'po-email':
      return { wantJson: false, prompt: `Draft a short, professional purchase-order cover email to a supplier confirming this order. Reference the quantities/dates given; do not add new figures.\nPO: ${d}` };
    case 'extract-line-items':
      return { wantJson: true, prompt: `Extract line items from the text below into JSON {"items":[{"description":"","hsn":"","qty":0,"rate":0}]}. Only use values present in the text; leave hsn "" if absent; never guess prices. Return ONLY JSON.\nTEXT:\n${text}` };
    case 'hsn-suggest':
      return { wantJson: true, prompt: `Suggest up to 3 likely Indian HSN codes for this product as JSON {"suggestions":[{"hsn":"","label":"","note":"verify with your CA"}]}. These are SUGGESTIONS to verify, not authoritative. Return ONLY JSON.\nPRODUCT: ${text || d}` };
    case 'qa':
      return { wantJson: false, prompt: `Answer this procurement/EXIM/paperwork question for an Indian seller in 2-4 sentences, practically. If it needs statutory certainty, say "verify with your CA/CHA". ${d ? 'CONTEXT: ' + d : ''}\nQUESTION: ${text}` };
    default:
      return { wantJson: false, prompt: `${text || d}` };
  }
}

async function callGemini(apiKey, prompt, wantJson) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const gen = { temperature: 0.3, maxOutputTokens: 1200, thinkingConfig: { thinkingBudget: 0 } };
  if (wantJson) gen.responseMimeType = 'application/json';
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ parts: [{ text: prompt }] }], generationConfig: gen }) });
  const j = await r.json();
  return (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const apiKey = process.env.GEMINI_API_KEY;
  const { task, data, text } = req.body || {};
  if (!task) return res.status(400).json({ error: 'Missing task.' });
  if (!apiKey) return res.status(503).json({ ok: false, reason: 'no-key', error: 'AI is not configured on this deployment.' });

  const { prompt, wantJson } = buildPrompt(task, { data, text });
  try {
    const raw = await callGemini(apiKey, prompt, wantJson);
    if (wantJson) {
      let parsed = null; try { parsed = JSON.parse((raw || '').replace(/```json|```/g, '').trim()); } catch { /* keep raw */ }
      return res.status(200).json({ ok: true, task, result: parsed || { raw } });
    }
    return res.status(200).json({ ok: true, task, result: (raw || '').trim() });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'AI request failed: ' + e.message });
  }
}
