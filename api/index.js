require("dotenv").config();

const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();

app.use(cors()); // Allow GitHub Pages to call this backend
app.use(express.json());

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "openai/gpt-4o-mini";

/* ── HELPER ─────────────────────────────────────────────── */
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
        { role: "user",   content: userMessage  }
      ]
    })
  });

  const data = await response.json();

  // OpenRouter wraps reply here
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("No response from AI: " + JSON.stringify(data));
  return text;
}

/* ── ROOT ───────────────────────────────────────────────── */
app.get("/", (req, res) => {
  res.send("Genesis Vault AI Backend Running ✅");
});

/* ── ROUTE 1: REPORT WRITER ─────────────────────────────── */
app.post("/report", async (req, res) => {
  const { vulnType, target, severity, findings, steps } = req.body;
  const apiKey = process.env.OPENROUTER_KEY;

  if (!vulnType || !findings) {
    return res.status(400).json({ error: "vulnType and findings are required" });
  }

  const system = `You are an elite bug bounty report writer for HackerOne.
Write professional, detailed vulnerability reports that get triaged quickly and paid well.
Use these exact markdown sections:
## Summary
## Vulnerability Details
## Steps to Reproduce
## Impact
## Proof of Concept
## Remediation
Be specific, technical, and concise. No filler.`;

  const user = `Write a complete HackerOne bug report:
- Vulnerability Type: ${vulnType}
- Target: ${target || "Not specified"}
- Severity: ${severity || "Medium"}
- My Findings: ${findings}
- Steps to Reproduce: ${steps || "Not provided"}`;

  try {
    const result = await askAI(system, user, apiKey);
    res.json({ result });
  } catch (err) {
    console.error("Report error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── ROUTE 2: XSS TRIAGE ────────────────────────────────── */
app.post("/xss-triage", async (req, res) => {
  const { target, urls } = req.body;
  const apiKey = process.env.OPENROUTER_KEY;

  if (!urls) {
    return res.status(400).json({ error: "urls field is required" });
  }

  const system = `You are an expert XSS hunter analyzing URLs for injection points.
For each URL identify:
1. Reflected parameters likely vulnerable to XSS
2. Best payload to test first
3. Context: HTML body / attribute / JS / URL
4. Risk level: HIGH / MEDIUM / LOW
5. Exact dalfox command to run in Termux

Format: table summary first, then detailed breakdown per URL.
Be direct and technical. Only actionable intel.`;

  const user = `Target: ${target || "Unknown"}
Analyze these URLs for XSS attack surface:
${urls}`;

  try {
    const result = await askAI(system, user, apiKey);
    res.json({ result });
  } catch (err) {
    console.error("XSS triage error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── ROUTE 3: RECON ANALYZER ────────────────────────────── */
app.post("/recon", async (req, res) => {
  const { domain, reconData } = req.body;
  const apiKey = process.env.OPENROUTER_KEY;

  if (!reconData) {
    return res.status(400).json({ error: "reconData is required" });
  }

  const system = `You are a senior bug bounty recon analyst.
Analyze subfinder/httpx output and identify highest-value targets.

Output format:
## 🎯 High Priority Targets
## 🔍 Interesting Subdomains
## ⚠️ Potential Vulnerabilities to Test
## 📋 Next Steps (exact Termux commands)

Focus on: admin panels, APIs, staging environments, login pages, unusual ports.
Give exact commands using subfinder, httpx, ffuf, dalfox, waybackurls.`;

  const user = `Target domain: ${domain || "Unknown"}
Recon output:
${reconData}`;

  try {
    const result = await askAI(system, user, apiKey);
    res.json({ result });
  } catch (err) {
    console.error("Recon error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── SERVER ─────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Genesis Vault AI running on port " + PORT);
});
