// Vercel serverless function — proxies the TMS AI to Google Gemini.
// Your Gemini key stays here (server-side), never in the browser.
// Set GEMINI_API_KEY in Vercel → Project → Settings → Environment Variables.
// Uses Gemini 2.5 Flash (same model your Demand Planner uses).
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ text: "POST only" });
  const { system = "", userText = "" } = req.body || {};
  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + process.env.GEMINI_API_KEY,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: userText }] }],
          generationConfig: {
            maxOutputTokens: 1024,
            temperature: 0.4,
            // Disable "thinking" so short prompts always return visible text
            // (2.5 models can otherwise spend the token budget thinking and reply empty).
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
    const data = await r.json();
    const text =
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") ||
      (data?.error?.message ? "AI error: " + data.error.message : "No response.");
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ text: "AI temporarily unavailable." });
  }
};
