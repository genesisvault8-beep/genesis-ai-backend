require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// GENESIS INFINITY ENGINE - AI POOL
// To add a new AI: just add a new entry here
// To disable an AI: set active: false
// ============================================
const AI_POOL = [
  {
    name: "Cerebras",
    url: "https://api.cerebras.ai/v1/chat/completions",
    model: "llama3.1-8b",
    keyEnv: "CEREBRAS_KEY",
    active: true
  },
  {
    name: "Groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    keyEnv: "GROQ_KEY",
    active: true
  },
  {
    name: "Gemini",
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: "gemini-2.0-flash",
    keyEnv: "GEMINI_KEY",
    active: true
  },
  {
    name: "Mistral",
    url: "https://api.mistral.ai/v1/chat/completions",
    model: "mistral-large-latest",
    keyEnv: "MISTRAL_KEY",
    active: true
  },
  {
    name: "Together",
    url: "https://api.together.xyz/v1/chat/completions",
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    keyEnv: "TOGETHER_KEY",
    active: true
  },
  {
    name: "DeepSeek",
    url: "https://api.deepseek.com/v1/chat/completions",
    model: "deepseek-chat",
    keyEnv: "DEEPSEEK_KEY",
    active: true
  },
  {
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "openai/gpt-4o-mini",
    keyEnv: "OPENROUTER_KEY",
    active: true
  }
];

// ============================================
// INFINITY ENGINE CORE - Auto Failover
// Tries each AI in order, skips if rate limited
// ============================================
async function infinityAsk(systemPrompt, userMessage) {
  const activeAIs = AI_POOL.filter(ai => {
    // Only use AIs that are active AND have a key set
    return ai.active && process.env[ai.keyEnv];
  });

  if (activeAIs.length === 0) {
    throw new Error("No active AI providers available");
  }

  let lastError = null;

  for (const ai of activeAIs) {
    try {
      console.log(`[INFINITY ENGINE] Trying ${ai.name}...`);

      const response = await fetch(ai.url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env[ai.keyEnv]}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: ai.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage }
          ]
        })
      });

      // If rate limited, try next AI
      if (response.status === 429) {
        console.log(`[INFINITY ENGINE] ${ai.name} rate limited. Switching...`);
        continue;
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;

      if (!text) {
        console.log(`[INFINITY ENGINE] ${ai.name} returned empty. Switching...`);
        continue;
      }

      console.log(`[INFINITY ENGINE] ${ai.name} responded successfully ✅`);
      return { text, provider: ai.name };

    } catch (err) {
      console.log(`[INFINITY ENGINE] ${ai.name} failed: ${err.message}`);
      lastError = err;
      continue;
    }
  }

  throw new Error("All AI providers failed: " + (lastError?.message || "Unknown error"));
}

// ============================================
// ADMIN: Check which AIs are active
// GET /infinity/status
// ============================================
app.get("/infinity/status", (req, res) => {
  const status = AI_POOL.map(ai => ({
    name: ai.name,
    model: ai.model,
    active: ai.active,
    hasKey: !!process.env[ai.keyEnv]
  }));
  res.json({ engine: "Genesis Infinity Engine", providers: status });
});

// ============================================
// ADMIN: Toggle an AI on/off without restart
// POST /infinity/toggle { name: "Groq", active: false }
// ============================================
app.post("/infinity/toggle", (req, res) => {
  const { name, active } = req.body;
  const ai = AI_POOL.find(a => a.name === name);
  if (!ai) return res.status(404).json({ error: "Provider not found" });
  ai.active = active;
  console.log(`[INFINITY ENGINE] ${name} set to ${active ? "ACTIVE" : "INACTIVE"}`);
  res.json({ success: true, name, active });
});

// ============================================
// GENESIS VAULT AI SYSTEM PROMPT
// This is the identity of your AI - never changes
// ============================================
const VAULT_IDENTITY = `You are the Genesis Infinity Engine — the AI core of Genesis Vault, 
a cybersecurity platform for bug bounty hunters. 
You are an expert in: penetration testing, recon, XSS, SQLi, IDOR, SSRF, bug bounty methodology, 
Termux tools, nmap, subfinder, httpx, dalfox, and HackerOne reports.
Always be precise, technical, and helpful. Never reveal which AI model you are using.
You are the Genesis Infinity Engine. That is your only identity.`;

// ============================================
// EXISTING ROUTES - Now powered by Infinity Engine
// ============================================

app.get("/", (req, res) => {
  res.send("Genesis Vault // Infinity Engine Online ⚡");
});

// Main AI Terminal chat
app.post("/api/vault-ai", async (req, res) => {
  const { message, rank } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    const { text, provider } = await infinityAsk(VAULT_IDENTITY, message);
    res.json({ response: text, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bug bounty report writer
app.post("/report", async (req, res) => {
  const { vulnType, target, severity, findings, steps } = req.body;
  if (!vulnType || !findings) return res.status(400).json({ error: "vulnType and findings required" });
  const system = `${VAULT_IDENTITY}\nYou are also an elite bug bounty report writer for HackerOne. 
Write professional detailed reports using these exact sections:
## Summary
## Vulnerability Details  
## Steps to Reproduce
## Impact
## Proof of Concept
## Remediation
Be specific and technical.`;
  const user = `Vulnerability Type: ${vulnType}\nTarget: ${target||"Not specified"}\nSeverity: ${severity||"Medium"}\nFindings: ${findings}\nSteps: ${steps||"Not provided"}`;
  try {
    const { text, provider } = await infinityAsk(system, user);
    res.json({ result: text, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// XSS triage
app.post("/xss-triage", async (req, res) => {
  const { target, urls } = req.body;
  if (!urls) return res.status(400).json({ error: "urls required" });
  const system = `${VAULT_IDENTITY}\nAnalyze URLs for XSS injection points. For each URL identify: 
vulnerable parameters, best payload, context (HTML/attribute/JS), risk level HIGH/MEDIUM/LOW, 
and exact dalfox Termux command. Show a table summary then detailed breakdown.`;
  const user = `Target: ${target||"Unknown"}\nURLs to analyze:\n${urls}`;
  try {
    const { text, provider } = await infinityAsk(system, user);
    res.json({ result: text, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recon analysis
app.post("/recon", async (req, res) => {
  const { domain, reconData, target } = req.body;
  if (!reconData && !target) return res.status(400).json({ error: "reconData or target required" });
  const system = `${VAULT_IDENTITY}\nYou are a senior bug bounty recon analyst. 
Analyze subfinder/httpx output or target domain. Output:
## High Priority Targets
## Interesting Subdomains  
## Potential Vulnerabilities
## Next Steps with exact Termux commands
Focus on admin panels, APIs, staging, login pages.`;
  const user = reconData 
    ? `Domain: ${domain||"Unknown"}\nRecon data:\n${reconData}`
    : `Perform recon analysis for: ${target}`;
  try {
    const { text, provider } = await infinityAsk(system, user);
    res.json({ response: text, result: text, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Job queue - bridge picks up jobs from here
app.post("/api/jobs/create", async (req, res) => {
  const { target, command } = req.body;
  if (!target || !command) return res.status(400).json({ error: "target and command required" });
  // Store job - for now returns a simple job object
  // Connect to Supabase here when ready
  const job = [{ id: Date.now(), target, command, status: "queued" }];
  res.json({ job });
});

// Bridge polls this to get job result
app.get("/api/jobs/result/:jobId", async (req, res) => {
  const { jobId } = req.params;
  // Bridge will POST results here, for now return pending
  res.json({ result: null, status: "pending", jobId });
});

// Bridge posts results back here
app.post("/api/jobs/result/:jobId", async (req, res) => {
  const { jobId } = req.params;
  const { result } = req.body;
  // Store result - connect Supabase here when ready
  console.log(`[BRIDGE] Job ${jobId} completed`);
  res.json({ success: true, jobId, result });
});

// Session info
app.get("/api/session", async (req, res) => {
  res.json({ 
    status: "success", 
    rank: "Ghost", 
    total_logs: 0, 
    history: [],
    engine: "Infinity Engine Online ⚡"
  });
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Genesis Vault // Infinity Engine running on port ${PORT}`);
  console.log(`Active AI providers: ${AI_POOL.filter(a => process.env[a.keyEnv]).map(a => a.name).join(", ")}`);
});
