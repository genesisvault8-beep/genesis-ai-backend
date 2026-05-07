require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openai/gpt-4o-mini";

async function askAI(systemPrompt, userMessage, apiKey) {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ]
    })
  });
  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("No AI response: " + JSON.stringify(data));
  return text;
}

app.get("/", (req, res) => {
  res.send("Genesis Vault AI Backend Running ✅");
});

app.post("/report", async (req, res) => {
  const { vulnType, target, severity, findings, steps } = req.body;
  const apiKey = process.env.OPENROUTER_KEY;
  if (!vulnType || !findings) return res.status(400).json({ error: "vulnType and findings required" });
  const system = "You are an elite bug bounty report writer for HackerOne. Write professional detailed reports using these exact sections:\n## Summary\n## Vulnerability Details\n## Steps to Reproduce\n## Impact\n## Proof of Concept\n## Remediation\nBe specific and technical.";
  const user = `Vulnerability Type: ${vulnType}\nTarget: ${target||"Not specified"}\nSeverity: ${severity||"Medium"}\nFindings: ${findings}\nSteps: ${steps||"Not provided"}`;
  try {
    const result = await askAI(system, user, apiKey);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/xss-triage", async (req, res) => {
  const { target, urls } = req.body;
  const apiKey = process.env.OPENROUTER_KEY;
  if (!urls) return res.status(400).json({ error: "urls required" });
  const system = "You are an expert XSS hunter. Analyze URLs for XSS injection points. For each URL identify: vulnerable parameters, best payload, context (HTML/attribute/JS), risk level HIGH/MEDIUM/LOW, and exact dalfox Termux command. Show a table summary then detailed breakdown.";
  const user = `Target: ${target||"Unknown"}\nURLs to analyze:\n${urls}`;
  try {
    const result = await askAI(system, user, apiKey);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/recon", async (req, res) => {
  const { domain, reconData } = req.body;
  const apiKey = process.env.OPENROUTER_KEY;
  if (!reconData) return res.status(400).json({ error: "reconData required" });
  const system = "You are a senior bug bounty recon analyst. Analyze subfinder/httpx output. Output:\n## High Priority Targets\n## Interesting Subdomains\n## Potential Vulnerabilities\n## Next Steps with exact Termux commands\nFocus on admin panels, APIs, staging, login pages.";
  const user = `Domain: ${domain||"Unknown"}\nRecon data:\n${reconData}`;
  try {
    const result = await askAI(system, user, apiKey);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Genesis Vault AI running on port " + PORT));
