// server.js

import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { verifyReceipt } from "node-apple-receipt-verify"; // npm install node-apple-receipt-verify

dotenv.config();
const app = express();
app.use(express.json());

// Ensure required environment variables are present
if (!process.env.APPLE_SHARED_SECRET) {
  console.error("❌ Missing APPLE_SHARED_SECRET in environment variables!");
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY in environment variables!");
  process.exit(1);
}

// In-memory usage tracker (keyed by originalTransactionId)
// Structure: { "<originalTransactionId>": { "gpt-3.5-turbo": count, "gpt-4": count } }
const usageTracker = new Map();

/**
 * POST /chat
 * Body: { "receipt": "<Base64 receipt>", "prompt":"<text>", "model":"gpt-3.5-turbo"|"gpt-4" }
 * Returns: { "reply": "<AI text>" } or HTTP 4xx/5xx with { "error":"<message>" }.
 */
app.post("/chat", async (req, res) => {
  try {
    const { receipt, prompt, model } = req.body;

    // 1) Validate request fields
    if (typeof receipt !== "string" || receipt.trim() === "") {
      return res.status(400).json({ error: "Missing or invalid receipt." });
    }
    if (typeof prompt !== "string" || prompt.trim() === "") {
      return res.status(400).json({ error: "Missing or empty prompt." });
    }
    if (!["gpt-3.5-turbo", "gpt-4"].includes(model)) {
      return res.status(400).json({ error: "Invalid model requested." });
    }

    // 2) Verify the receipt with Apple
    const validationOptions = {
      secret: process.env.APPLE_SHARED_SECRET,
      environment: process.env.NODE_ENV === "production" ? "Production" : "Sandbox"
    };

    let appleResponse;
    try {
      appleResponse = await verifyReceipt(receipt, validationOptions);
    } catch (err) {
      console.error("❌ Apple receipt verification error:", err);
      return res.status(403).json({ error: "Failed to verify receipt." });
    }

    // 3) Inspect latest_receipt_info array for the matching subscription product
    const productID = model === "gpt-4" ? "com.omegaai.chat4" : "com.omegaai.chat3";
    const inApp = appleResponse.latest_receipt_info || [];
    // Sort descending by purchase_date_ms
    inApp.sort((a, b) => parseInt(b.purchase_date_ms) - parseInt(a.purchase_date_ms));

    let validTransaction = null;
    for (const entry of inApp) {
      if (entry.product_id === productID) {
        const expiresMs = parseInt(entry.expires_date_ms);
        const nowMs = Date.now();
        if (expiresMs > nowMs) {
          validTransaction = entry;
          break;
        }
      }
    }

    if (!validTransaction) {
      return res.status(403).json({ error: "No active subscription for requested model." });
    }

    // 4) Quota enforcement
    const originalTransactionId = validTransaction.original_transaction_id;
    if (!usageTracker.has(originalTransactionId)) {
      usageTracker.set(originalTransactionId, { "gpt-3.5-turbo": 0, "gpt-4": 0 });
    }
    const userUsage = usageTracker.get(originalTransactionId);

    // Define monthly quotas
    const quotas = {
      "gpt-3.5-turbo": 5000,
      "gpt-4": 800
    };
    if (userUsage[model] >= quotas[model]) {
      return res.status(403).json({ error: "Monthly quota exceeded for this model." });
    }

    // 5) Forward to OpenAI with detailed logging
    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: prompt.trim() }
        ]
      })
    });

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      console.error("🛑 OpenAI returned non-200:", openaiResponse.status, errorText);
      return res.status(500).json({ error: "Error communicating with OpenAI." });
    }

    const openaiJson = await openaiResponse.json();
    const replyText = openaiJson.choices?.[0]?.message?.content?.trim();
    if (!replyText) {
      console.error("🛑 OpenAI returned malformed response:", openaiJson);
      return res.status(500).json({ error: "Malformed response from OpenAI." });
    }

    // 6) Increment usage counter for this user
    usageTracker.get(originalTransactionId)[model] += 1;

    // 7) Return the AI reply
    return res.json({ reply: replyText });

  } catch (err) {
    console.error("❌ Unexpected /chat error:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

/**
 * Root GET route (health check).
 */
app.get("/", (req, res) => {
  res.json({ status: "OmegaAI proxy server is running." });
});

// Start server on dynamic port (Render) or 3000 locally
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ OmegaAI proxy server running on port ${PORT}`);
});
