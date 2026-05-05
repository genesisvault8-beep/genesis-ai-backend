require("dotenv").config();
const functions = require("firebase-functions");

exports.generateReport = functions.https.onRequest(async (req, res) => {
  const fetch = (await import("node-fetch")).default;

  const apiKey = process.env.OPENROUTER_KEY;
  const input = req.body.input;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: "You are a professional bug bounty report writer. Format clear reports with title, severity, steps, impact, and fix."
          },
          {
            role: "user",
            content: input
          }
        ]
      })
    });

    const data = await response.json();
    res.json(data);

  } catch (err) {
    res.status(500).send("Error generating report");
  }
});
