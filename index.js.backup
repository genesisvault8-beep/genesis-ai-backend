require("dotenv").config();

const express = require("express");
const fetch = require("node-fetch");

const app = express();

app.use(express.json());

/* ROOT */
app.get("/", (req, res) => {
  res.send("AI Backend Running ✅");
});

/* AI ROUTE */
app.post("/generate", async (req, res) => {
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
            content: "You are a professional bug bounty report writer."
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
    console.error(err);
    res.status(500).send("Error generating report");
  }
});

/* SERVER */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
