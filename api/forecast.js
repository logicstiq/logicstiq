// /api/forecast.js
// This is a Vercel Serverless Function.
// It runs on Vercel's server (not the visitor's browser),
// so your Gemini API key stays secret and safe.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'GEMINI_API_KEY is not configured in Vercel. Go to Project Settings > Environment Variables, add it, then redeploy.'
    });
  }

  const { prompt } = req.body || {};
  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt in request body.' });
  }

  const MODEL = 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 3000,
          responseMimeType: 'application/json',
          responseSchema: {
            type: "OBJECT",
            properties: {
              summary: {
                type: "OBJECT",
                properties: {
                  totalSKUs: { type: "INTEGER" },
                  avgMonthlyDemand: { type: "INTEGER" },
                  totalInventoryValue: { type: "STRING" },
                  forecastAccuracy: { type: "STRING" },
                  criticalAlerts: { type: "INTEGER" },
                  slowMovers: { type: "INTEGER" }
                },
                required: ["totalSKUs","avgMonthlyDemand","totalInventoryValue","forecastAccuracy","criticalAlerts","slowMovers"]
              },
              demandForecast: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    sku: { type: "STRING" },
                    product: { type: "STRING" },
                    avgMonthlyDemand: { type: "INTEGER" },
                    next30: { type: "INTEGER" },
                    next60: { type: "INTEGER" },
                    next90: { type: "INTEGER" },
                    trend: { type: "STRING", enum: ["up","down","flat"] },
                    trendPct: { type: "STRING" },
                    confidence: { type: "STRING" }
                  },
                  required: ["sku","product","avgMonthlyDemand","next30","next60","next90","trend","trendPct","confidence"]
                }
              },
              reorderPlan: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    sku: { type: "STRING" },
                    product: { type: "STRING" },
                    currentStock: { type: "INTEGER" },
                    reorderPoint: { type: "INTEGER" },
                    eoq: { type: "INTEGER" },
                    reorderBy: { type: "STRING" },
                    leadTimeDays: { type: "INTEGER" },
                    priority: { type: "STRING", enum: ["URGENT","HIGH","MEDIUM","LOW"] }
                  },
                  required: ["sku","product","currentStock","reorderPoint","eoq","reorderBy","leadTimeDays","priority"]
                }
              },
              slowMovers: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    sku: { type: "STRING" },
                    product: { type: "STRING" },
                    daysInStock: { type: "INTEGER" },
                    monthlyVelocity: { type: "INTEGER" },
                    inventoryValue: { type: "STRING" },
                    action: { type: "STRING" },
                    riskLevel: { type: "STRING", enum: ["HIGH","MEDIUM","LOW"] }
                  },
                  required: ["sku","product","daysInStock","monthlyVelocity","inventoryValue","action","riskLevel"]
                }
              },
              insights: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    type: { type: "STRING", enum: ["green","orange","blue"] },
                    text: { type: "STRING" }
                  },
                  required: ["type","text"]
                }
              }
            },
            required: ["summary","demandForecast","reorderPlan","slowMovers","insights"]
          }
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || 'Gemini API error'
      });
    }

    const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';

    if (!text) {
      return res.status(500).json({
        error: 'Gemini returned an empty response. Try again or check your API quota.'
      });
    }

    return res.status(200).json({
      content: [{ type: 'text', text }]
    });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unknown server error' });
  }
}
