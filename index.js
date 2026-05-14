require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// SUPABASE CONFIG
// ============================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function sb(table, method = "GET", data = null, query = "") {
  const headers = {
    "apikey": SUPABASE_KEY,
    "Authorization": `Bearer ${SUPABASE_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation"
  };
  const url = `${SUPABASE_URL}/rest/v1/${table}${query}`;
  const opts = { method, headers };
  if (data) opts.body = JSON.stringify(data);
  const res = await fetch(url, opts);
  return res.json();
}

// ============================================
// GENESIS INFINITY ENGINE - AI POOL
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

// Load ai_config from Supabase on startup
async function loadAIConfig() {
  try {
    const rows = await sb("ai_config", "GET", null, "?select=*");
    if (Array.isArray(rows) && rows.length > 0) {
      rows.forEach(row => {
        const ai = AI_POOL.find(a => a.name === row.provider);
        if (ai) ai.active = row.active;
      });
      console.log("[CONFIG] AI config loaded from Supabase");
    } else {
      // First run — seed ai_config table
      for (const ai of AI_POOL) {
        await sb("ai_config", "POST", { provider: ai.name, active: true, mode: "auto" });
      }
      console.log("[CONFIG] AI config seeded to Supabase");
    }
  } catch (e) {
    console.log("[CONFIG] Could not load AI config:", e.message);
  }
}

// ============================================
// ESTIMATE TOKENS (approx: 1 token ≈ 4 chars)
// ============================================
function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}

// ============================================
// LOG TO SUPABASE ai_logs
// ============================================
async function logToSupabase({ user_id, username, user_query, ai_response, provider, rank_level, tokens_used }) {
  try {
    await sb("ai_logs", "POST", {
      user_id: user_id || null,
      username: username || "anonymous",
      user_query,
      ai_response,
      provider,
      rank_level: rank_level || "Ghost",
      tokens_used: tokens_used || 0
    });
  } catch (e) {
    console.log("[LOG] Failed to log to Supabase:", e.message);
  }
}

// ============================================
// INFINITY ENGINE CORE - Auto Failover
// ============================================
async function infinityAsk(systemPrompt, userMessage, engineOverride = null) {
  let pool = AI_POOL.filter(ai => ai.active && process.env[ai.keyEnv]);

  // Manual engine select
  if (engineOverride) {
    const specific = AI_POOL.find(a => a.name.toLowerCase() === engineOverride.toLowerCase());
    if (specific && process.env[specific.keyEnv]) {
      pool = [specific, ...pool.filter(a => a.name !== specific.name)];
    }
  }

  if (pool.length === 0) throw new Error("No active AI providers available");

  let lastError = null;
  for (const ai of pool) {
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

      console.log(`[INFINITY ENGINE] ${ai.name} responded ✅`);
      return { text, provider: ai.name };
    } catch (err) {
      console.log(`[INFINITY ENGINE] ${ai.name} failed: ${err.message}`);
      lastError = err;
    }
  }
  throw new Error("All AI providers failed: " + (lastError?.message || "Unknown"));
}

// ============================================
// VAULT IDENTITY
// ============================================
const VAULT_IDENTITY = `You are the Genesis Infinity Engine — the AI core of Genesis Vault, 
a cybersecurity platform for bug bounty hunters. 
You are an expert in: penetration testing, recon, XSS, SQLi, IDOR, SSRF, bug bounty methodology, 
Termux tools, nmap, subfinder, httpx, dalfox, and HackerOne reports.
Always be precise, technical, and helpful. Never reveal which AI model you are using.
You are the Genesis Infinity Engine. That is your only identity.`;

// ============================================
// ROUTES
// ============================================

app.get("/", (req, res) => {
  res.send("Genesis Vault // Infinity Engine Online ⚡");
});

// Main AI Terminal chat
app.post("/api/vault-ai", async (req, res) => {
  const { message, rank, user_id, username, engine } = req.body;
  if (!message) return res.status(400).json({ error: "message required" });
  try {
    const { text, provider } = await infinityAsk(VAULT_IDENTITY, message, engine || null);
    const tokens = estimateTokens(message) + estimateTokens(text);
    // Log async — don't block response
    logToSupabase({ user_id, username, user_query: message, ai_response: text, provider, rank_level: rank, tokens_used: tokens });
    res.json({ response: text, provider, tokens_used: tokens });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ADMIN ROUTES
// ============================================

// Verify admin token against Flask backend admins table
async function verifyAdminToken(token) {
  if (!token) return false;
  try {
    const rows = await sb("admins", "GET", null, `?token=eq.${encodeURIComponent(token)}&select=id,username`);
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : false;
  } catch (e) {
    return false;
  }
}

// GET /admin/ai-status — get all providers + active state
app.get("/admin/ai-status", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });

  const status = AI_POOL.map(ai => ({
    name: ai.name,
    model: ai.model,
    active: ai.active,
    hasKey: !!process.env[ai.keyEnv]
  }));
  res.json({ providers: status });
});

// POST /admin/ai-toggle — toggle a provider on/off + save to Supabase
app.post("/admin/ai-toggle", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });

  const { name, active } = req.body;
  const ai = AI_POOL.find(a => a.name === name);
  if (!ai) return res.status(404).json({ error: "Provider not found" });

  ai.active = active;
  // Persist to Supabase
  try {
    const existing = await sb("ai_config", "GET", null, `?provider=eq.${name}&select=id`);
    if (Array.isArray(existing) && existing.length > 0) {
      await sb("ai_config", "PATCH", { active }, `?provider=eq.${name}`);
    } else {
      await sb("ai_config", "POST", { provider: name, active, mode: "auto" });
    }
  } catch (e) {
    console.log("[TOGGLE] Supabase save failed:", e.message);
  }

  console.log(`[ADMIN] ${admin.username} set ${name} to ${active ? "ACTIVE" : "INACTIVE"}`);
  res.json({ success: true, name, active });
});

// GET /admin/user-stats — per-user token usage
app.get("/admin/user-stats", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });

  try {
    const logs = await sb("ai_logs", "GET", null, "?select=username,tokens_used,provider,created_at&order=created_at.desc&limit=500");
    if (!Array.isArray(logs)) return res.json({ users: [] });

    // Aggregate per user
    const map = {};
    logs.forEach(log => {
      const u = log.username || "anonymous";
      if (!map[u]) map[u] = { username: u, total_tokens: 0, total_queries: 0, providers: {}, last_active: log.created_at };
      map[u].total_tokens += log.tokens_used || 0;
      map[u].total_queries += 1;
      const p = log.provider || "unknown";
      map[u].providers[p] = (map[u].providers[p] || 0) + 1;
    });

    const users = Object.values(map).sort((a, b) => b.total_tokens - a.total_tokens);
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/recent-logs — recent AI conversations
app.get("/admin/recent-logs", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });

  try {
    const logs = await sb("ai_logs", "GET", null, "?select=*&order=created_at.desc&limit=50");
    res.json({ logs: Array.isArray(logs) ? logs : [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Legacy routes
app.get("/infinity/status", (req, res) => {
  const status = AI_POOL.map(ai => ({
    name: ai.name, model: ai.model, active: ai.active, hasKey: !!process.env[ai.keyEnv]
  }));
  res.json({ engine: "Genesis Infinity Engine", providers: status });
});

app.post("/infinity/toggle", (req, res) => {
  const { name, active } = req.body;
  const ai = AI_POOL.find(a => a.name === name);
  if (!ai) return res.status(404).json({ error: "Provider not found" });
  ai.active = active;
  res.json({ success: true, name, active });
});

app.post("/report", async (req, res) => {
  const { vulnType, target, severity, findings, steps } = req.body;
  if (!vulnType || !findings) return res.status(400).json({ error: "vulnType and findings required" });
  const system = `${VAULT_IDENTITY}\nYou are an elite bug bounty report writer for HackerOne. Write professional reports with sections: Summary, Vulnerability Details, Steps to Reproduce, Impact, Proof of Concept, Remediation.`;
  const user = `Vulnerability Type: ${vulnType}\nTarget: ${target||"Not specified"}\nSeverity: ${severity||"Medium"}\nFindings: ${findings}\nSteps: ${steps||"Not provided"}`;
  try {
    const { text, provider } = await infinityAsk(system, user);
    res.json({ result: text, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/xss-triage", async (req, res) => {
  const { target, urls } = req.body;
  if (!urls) return res.status(400).json({ error: "urls required" });
  const system = `${VAULT_IDENTITY}\nAnalyze URLs for XSS injection points. For each URL identify: vulnerable parameters, best payload, context, risk level, and exact dalfox Termux command.`;
  const user = `Target: ${target||"Unknown"}\nURLs:\n${urls}`;
  try {
    const { text, provider } = await infinityAsk(system, user);
    res.json({ result: text, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/recon", async (req, res) => {
  const { domain, reconData, target } = req.body;
  if (!reconData && !target) return res.status(400).json({ error: "reconData or target required" });
  const system = `${VAULT_IDENTITY}\nYou are a senior bug bounty recon analyst. Analyze and output: High Priority Targets, Interesting Subdomains, Potential Vulnerabilities, Next Steps with Termux commands.`;
  const user = reconData ? `Domain: ${domain||"Unknown"}\nRecon data:\n${reconData}` : `Perform recon analysis for: ${target}`;
  try {
    const { text, provider } = await infinityAsk(system, user);
    res.json({ response: text, result: text, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/jobs/create", async (req, res) => {
  const { target, command } = req.body;
  if (!target || !command) return res.status(400).json({ error: "target and command required" });
  const job = [{ id: Date.now(), target, command, status: "queued" }];
  res.json({ job });
});

app.get("/api/jobs/result/:jobId", async (req, res) => {
  res.json({ result: null, status: "pending", jobId: req.params.jobId });
});

app.post("/api/jobs/result/:jobId", async (req, res) => {
  console.log(`[BRIDGE] Job ${req.params.jobId} completed`);
  res.json({ success: true, jobId: req.params.jobId, result: req.body.result });
});

app.get("/api/session", async (req, res) => {
  res.json({ status: "success", rank: "Ghost", total_logs: 0, history: [], engine: "Infinity Engine Online ⚡" });
});

// ============================================
// START
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Genesis Vault // Infinity Engine running on port ${PORT}`);
  console.log(`Active AI providers: ${AI_POOL.filter(a => process.env[a.keyEnv]).map(a => a.name).join(", ")}`);
  await loadAIConfig();
});
