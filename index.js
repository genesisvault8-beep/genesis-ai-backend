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
const rrIndex = {};
const rrKeyIndex = {};

function getRoundRobinKey(groupName, keys) {
  if (!rrIndex[groupName]) rrIndex[groupName] = 0;
  const idx = rrIndex[groupName] % keys.length;
  const key = keys[idx];
  rrKeyIndex[groupName] = idx + 1;
  rrIndex[groupName]++;
  return key;
}

function buildPool() {
  return [
    {
      name: "Groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      model: "llama-3.3-70b-versatile",
      getKey: () => getRoundRobinKey("groq", [
        process.env.GROQ_KEY1,
        process.env.GROQ_KEY2,
        process.env.GROQ_KEY3
      ].filter(Boolean)),
      hasKey: () => !!(process.env.GROQ_KEY1 || process.env.GROQ_KEY2 || process.env.GROQ_KEY3),
      active: true
    },
    {
      name: "Gemini",
      url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      model: "gemini-2.0-flash",
      getKey: () => getRoundRobinKey("gemini", [
        process.env.GEMINI_KEY,
        process.env.GEMINI_KEY2,
        process.env.GEMINI_KEY3
      ].filter(Boolean)),
      hasKey: () => !!(process.env.GEMINI_KEY || process.env.GEMINI_KEY2 || process.env.GEMINI_KEY3),
      active: true
    },
    {
      name: "OpenRouter",
      url: "https://openrouter.ai/api/v1/chat/completions",
      model: "openai/gpt-4o-mini",
      getKey: () => getRoundRobinKey("openrouter", [
        process.env.OPENROUTER_KEY,
        process.env.OPENROUTER_KEY2,
        process.env.OPENROUTER_KEY3
      ].filter(Boolean)),
      hasKey: () => !!(process.env.OPENROUTER_KEY || process.env.OPENROUTER_KEY2 || process.env.OPENROUTER_KEY3),
      active: true
    },
    {
      name: "Cerebras",
      url: "https://api.cerebras.ai/v1/chat/completions",
      model: "llama3.1-8b",
      getKey: () => process.env.CEREBRAS_KEY,
      hasKey: () => !!process.env.CEREBRAS_KEY,
      active: true
    },
    {
      name: "Mistral",
      url: "https://api.mistral.ai/v1/chat/completions",
      model: "mistral-large-latest",
      getKey: () => process.env.MISTRAL_KEY,
      hasKey: () => !!process.env.MISTRAL_KEY,
      active: true
    },
    {
      name: "SambaNova",
      url: "https://api.sambanova.ai/v1/chat/completions",
      model: "Meta-Llama-3.3-70B-Instruct",
      getKey: () => process.env.SAMBANOVA_KEY,
      hasKey: () => !!process.env.SAMBANOVA_KEY,
      active: true
    },
    {
      name: "HuggingFace",
      url: "https://api-inference.huggingface.co/models/Qwen/Qwen2.5-72B-Instruct/v1/chat/completions",
      model: "Qwen2.5-72B-Instruct",
      getKey: () => process.env.HUGGINGFACE_KEY,
      hasKey: () => !!process.env.HUGGINGFACE_KEY,
      active: true
    }
  ];
}

let AI_POOL = buildPool();

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
  let pool = AI_POOL.filter(ai => ai.active && ai.hasKey());
  if (pool.length === 0) throw new Error("No active AI providers available");

  if (engineOverride) {
    const specific = pool.find(a => a.name.toLowerCase() === engineOverride.toLowerCase());
    if (specific) {
      pool = [specific, ...pool.filter(a => a.name !== specific.name)];
    }
  }

  let lastError = null;

  for (const ai of pool) {
    const apiKey = ai.getKey();
    if (!apiKey) continue;

    // Track which key index is being used
    const keyIndex = rrIndex[ai.name.toLowerCase()] || 1;

    try {
      console.log(`[INFINITY ENGINE] Trying ${ai.name} (${ai.model})...`);

      // Track rotation stat
      trackRotation(ai.name, keyIndex);

      const response = await fetch(ai.url, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: ai.model,
          max_tokens: 2048,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage }
          ]
        })
      });

      if (response.status === 429) {
        console.log(`[INFINITY ENGINE] ${ai.name} rate limited — switching...`);
        logFailure(ai.name, keyIndex, "RATE_LIMITED", 429);
        continue;
      }

      if (response.status === 503 || response.status === 502) {
        console.log(`[INFINITY ENGINE] ${ai.name} unavailable (${response.status}) — switching...`);
        logFailure(ai.name, keyIndex, "SERVICE_DOWN", response.status);
        continue;
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;

      if (!text) {
        console.log(`[INFINITY ENGINE] ${ai.name} returned empty — switching...`);
        logFailure(ai.name, keyIndex, "EMPTY_RESPONSE", response.status);
        continue;
      }

      console.log(`[INFINITY ENGINE] ${ai.name} responded ✅`);
      return { text, provider: ai.name };

    } catch(err) {
      console.log(`[INFINITY ENGINE] ${ai.name} failed: ${err.message}`);
      logFailure(ai.name, keyIndex, "TIMEOUT", null);
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
    logToSupabase({ user_id, username, user_query: message, ai_response: text, provider, rank_level: rank, tokens_used: tokens });
    res.json({ response: text, provider, tokens_used: tokens });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// ADMIN ROUTES
// ============================================

async function verifyAdminToken(token) {
  if (!token) return false;
  try {
    const rows = await sb("admins", "GET", null, `?token=eq.${encodeURIComponent(token)}&select=id,username`);
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : false;
  } catch (e) {
    return false;
  }
}
// Failure log
app.get("/admin/failures", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });

  try {
    const failures = await sb(
      "ai_failures",
      "GET",
      null,
      "?select=*&order=created_at.desc&limit=100"
    );
    res.json({ failures: Array.isArray(failures) ? failures : [] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Rotation stats (today only)
app.get("/admin/rotation-stats", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });

  try {
    const today = new Date().toISOString().split('T')[0];
    const stats = await sb(
      "ai_rotation_stats",
      "GET",
      null,
      `?date=eq.${today}&select=*&order=provider.asc`
    );
    res.json({ stats: Array.isArray(stats) ? stats : [], date: today });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

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

app.post("/admin/ai-toggle", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });

  const { name, active } = req.body;
  const ai = AI_POOL.find(a => a.name === name);
  if (!ai) return res.status(404).json({ error: "Provider not found" });

  ai.active = active;
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

app.get("/admin/user-stats", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });

  try {
    const logs = await sb("ai_logs", "GET", null, "?select=username,tokens_used,provider,created_at&order=created_at.desc&limit=500");
    if (!Array.isArray(logs)) return res.json({ users: [] });

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
