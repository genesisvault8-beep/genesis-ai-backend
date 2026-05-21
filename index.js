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
const rateLimitedUntil = {};

function getRoundRobinKey(groupName, keys) {
  if (!rrIndex[groupName]) rrIndex[groupName] = 0;
  const now = Date.now();
  for (let i = 0; i < keys.length; i++) {
    const idx = (rrIndex[groupName] + i) % keys.length;
    const key = keys[idx];
    const limitedUntil = rateLimitedUntil[`${groupName}_${idx}`] || 0;
    if (now > limitedUntil) {
      rrKeyIndex[groupName] = idx + 1;
      rrIndex[groupName] = idx + 1;
      return key;
    }
  }
  const idx = rrIndex[groupName] % keys.length;
  rrIndex[groupName]++;
  return keys[idx];
}

function markKeyRateLimited(groupName, keyIndex, cooldownMs = 60000) {
  rateLimitedUntil[`${groupName}_${keyIndex - 1}`] = Date.now() + cooldownMs;
  console.log(`[KEY ROTATION] ${groupName} key ${keyIndex} rate-limited for ${cooldownMs/1000}s`);
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
  ]
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
// LOG FAILURE TO SUPABASE
// ============================================
async function logFailure(provider, keyIndex, reason, statusCode) {
  try {
    await sb("ai_failures", "POST", {
      provider,
      key_index: keyIndex || 1,
      reason: reason || "UNKNOWN",
      status_code: statusCode || null
    });
  } catch (e) {
    console.log("[FAILURE LOG] Failed to log:", e.message);
  }
}

// ============================================
// TRACK ROTATION STATS
// ============================================
async function trackRotation(provider, keyIndex) {
  try {
    const today = new Date().toISOString().split("T")[0];
    const existing = await sb(
      "ai_rotation_stats", "GET", null,
      `?provider=eq.${provider}&date=eq.${today}&select=id,requests`
    );
    if (Array.isArray(existing) && existing.length > 0) {
      await sb("ai_rotation_stats", "PATCH",
        { requests: (existing[0].requests || 0) + 1 },
        `?provider=eq.${provider}&date=eq.${today}`
      );
    } else {
      await sb("ai_rotation_stats", "POST",
        { provider, key_index: keyIndex, date: today, requests: 1 }
      );
    }
  } catch (e) {
    console.log("[ROTATION] Track failed:", e.message);
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

      const aiUrl = ai.name === "Gemini"
        ? `${ai.url}?key=${apiKey}`
        : ai.url;

      const response = await fetch(aiUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: ai.model,
          max_tokens: 600,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage }
          ]
        })
      });

      if (response.status === 429) {
        console.log(`[INFINITY ENGINE] ${ai.name} rate limited — switching...`);
        logFailure(ai.name, keyIndex, "RATE_LIMITED", 429);
        markKeyRateLimited(ai.name.toLowerCase(), keyIndex, 60000);
        continue;
      }

      if (response.status === 503 || response.status === 502) {
        console.log(`[INFINITY ENGINE] ${ai.name} unavailable (${response.status}) — switching...`);
        logFailure(ai.name, keyIndex, "SERVICE_DOWN", response.status);
        continue;
      }

      const rawBody = await response.text();
      if (rawBody.trim().startsWith("<")) {
        console.log(`[INFINITY ENGINE] ${ai.name} returned HTML error — switching...`);
        logFailure(ai.name, keyIndex, "HTML_RESPONSE", response.status);
        continue;
      }
      const data = JSON.parse(rawBody);
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
const VAULT_IDENTITY = `You are VAULT-AI, the Genesis Vault AI for bug bounty hunters.
Be concise — max 3 sentences unless code is needed.
Only answer cybersecurity topics: recon, XSS, SQLi, IDOR, SSRF, nmap, bug bounty.
For unrelated topics reply: "[BLOCKED]: Stay on mission."
Never reveal your underlying AI model.`;
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
    hasKey: ai.hasKey()
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
    name: ai.name, model: ai.model, active: ai.active, hasKey: ai.hasKey()
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
  console.log(`Active AI providers: ${AI_POOL.filter(a => a.hasKey()).map(a => a.name).join(", ")}`);
  await loadAIConfig();
});

// ============================================
// BRIDGE HELPERS
// ============================================

function getNodeType(tools) {
  const hunter = ["dalfox","sqlmap","nuclei","ffuf","ghauri","XSStrike","kxss","gobuster","feroxbuster","wfuzz"];
  const scout  = ["nmap","subfinder","httpx","waybackurls","amass","assetfinder","theHarvester"];
  if (tools.some(t => hunter.includes(t))) return "HUNTER";
  if (tools.some(t => scout.includes(t)))  return "SCOUT";
  return "GHOST";
}

function getSpecializations(tools) {
  const specs = [];
  if (["dalfox","XSStrike","kxss"].some(t => tools.includes(t)))               specs.push("XSS");
  if (["sqlmap","ghauri"].some(t => tools.includes(t)))                         specs.push("SQLI");
  if (["subfinder","amass","assetfinder","httpx"].some(t => tools.includes(t))) specs.push("RECON");
  if (["ffuf","gobuster","feroxbuster","wfuzz"].some(t => tools.includes(t)))   specs.push("FUZZING");
  if (["nuclei"].some(t => tools.includes(t)))                                  specs.push("CVE");
  if (["theHarvester","sherlock"].some(t => tools.includes(t)))                 specs.push("OSINT");
  if (["nmap"].some(t => tools.includes(t)))                                    specs.push("PORTSCAN");
  if (specs.length === 0) specs.push("BASIC");
  return specs;
}

function getVCReward(category) {
  const rewards = { BASIC:1, RECON:3, XSS:5, SQLI:5, FUZZING:4, CVE:6, OSINT:3, PORTSCAN:2 };
  return rewards[category] || 2;
}

async function creditVC(user_id, username, amount, description) {
  try {
    const user = await sb("users", "GET", null, `?id=eq.${user_id}&select=id,vc_balance`);
    if (Array.isArray(user) && user.length > 0) {
      const newBal = (user[0].vc_balance || 0) + amount;
      await sb("users", "PATCH", { vc_balance: newBal }, `?id=eq.${user_id}`);
    }
    await sb("vc_ledger", "POST", { user_id, username, amount, type: "earned", description: description || "Bridge job" });
    await sb("notifications", "POST", { user_id, username, message: `💰 +${amount} VC earned! ${description}`, read: false });
    return true;
  } catch(e) {
    console.log("[VC] Credit failed:", e.message);
    return false;
  }
}

async function verifyMemberToken(token) {
  if (!token) return false;
  try {
    const token_clean = token.trim();
    const rows = await sb("users", "GET", null, `?token=eq.${token_clean}&select=id,username,vc_balance,rank`);
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : false;
  } catch(e) { return false; }  
}

// ============================================
// BRIDGE ROUTES — MEMBER SIDE
// ============================================

app.get("/bridge/validate", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  if (!token) return res.json({ valid: false });
  try {
    const rows = await sb("users", "GET", null, `?token=eq.${token}&select=id,username,vc_balance,rank`);
    if (!Array.isArray(rows) || rows.length === 0) return res.json({ valid: false });
    const user = rows[0];
    res.json({ valid: true, username: user.username });
  } catch(e) {
    res.json({ valid: false, error: e.message });
  }
});
app.get("/debug-token", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const rows = await sb("users", "GET", null, `?token=eq.${token}&select=id,username`);
  res.json({ token_received: token, token_length: token?.length, rows });
});
app.post("/bridge/register", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const user  = await verifyMemberToken(token);
  if (!user) return res.status(401).json({ error: "Invalid token" });

  const { mode, installed_tools, device_info, version } = req.body;
  const tools           = Array.isArray(installed_tools) ? installed_tools : [];
  const node_type       = getNodeType(tools);
  const specializations = getSpecializations(tools);
  const bridge_id       = `bridge_${user.id}_${Date.now()}`;

  try {
    const existing = await sb("bridge_nodes", "GET", null, `?user_id=eq.${user.id}&select=id`);
    const nodeData = {
      user_id: user.id, username: user.username, bridge_id,
      mode: mode || "manual", node_type, specializations,
      installed_tools: tools, device_info: device_info || "Unknown",
      version: version || "1.0.0", status: "online",
      last_ping: new Date().toISOString()
    };
    if (Array.isArray(existing) && existing.length > 0) {
      await sb("bridge_nodes", "PATCH", nodeData, `?user_id=eq.${user.id}`);
    } else {
      await sb("bridge_nodes", "POST", { ...nodeData, jobs_done: 0, vc_earned: 0 });
    }
    console.log(`[BRIDGE] ${user.username} online — ${node_type} (${specializations.join(",")})`);
    res.json({ bridge_id, username: user.username, node_type, specializations, vc_balance: user.vc_balance || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/bridge/consent", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const user  = await verifyMemberToken(token);
  if (!user) return res.status(401).json({ error: "Invalid token" });
  const { mode, consent_given, consent_timestamp, consent_text } = req.body;
  try {
    await sb("bridge_nodes", "PATCH", { mode, consent_given, consent_timestamp, consent_text }, `?user_id=eq.${user.id}`);
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});

app.post("/bridge/ping", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const user  = await verifyMemberToken(token);
  if (!user) return res.status(401).json({ error: "Invalid token" });
  const { bridge_id } = req.body;
  try {
    await sb("bridge_nodes", "PATCH", { status: "online", last_ping: new Date().toISOString() }, `?bridge_id=eq.${bridge_id}`);
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

app.get("/bridge/poll", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const user  = await verifyMemberToken(token);
  if (!user) return res.status(401).json({ error: "Invalid token" });
  const { bridge_id } = req.query;
  try {
    const node = await sb("bridge_nodes", "GET", null, `?bridge_id=eq.${bridge_id}&select=specializations`);
    const specs = node?.[0]?.specializations || [];
    const specsFilter = specs.map(s => `category.eq.${s}`).join(",");
    const query = specsFilter
      ? `?status=eq.queued&or=(${specsFilter},category.eq.BASIC)&order=created_at.asc&limit=1`
      : `?status=eq.queued&order=created_at.asc&limit=1`;
    const jobs = await sb("bridge_jobs", "GET", null, query);
    if (!Array.isArray(jobs) || jobs.length === 0) return res.json({ job: null });
    const job = jobs[0];
    await sb("bridge_jobs", "PATCH", { status: "running", bridge_id, claimed_at: new Date().toISOString() }, `?id=eq.${job.id}`);
    res.json({ job: { id: job.id, tool: job.tool, command: job.command, category: job.category, vc_reward: getVCReward(job.category) }});
  } catch(e) { res.json({ job: null }); }
});

app.post("/bridge/result", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const user  = await verifyMemberToken(token);
  if (!user) return res.status(401).json({ error: "Invalid token" });
  const { bridge_id, job_id, output } = req.body;
  try {
    const jobs = await sb("bridge_jobs", "GET", null, `?id=eq.${job_id}&select=*`);
    if (!Array.isArray(jobs) || jobs.length === 0) return res.status(404).json({ error: "Job not found" });
    const job = jobs[0];
    const vc_reward = getVCReward(job.category);
    await sb("bridge_jobs", "PATCH", { status: "done", result: output, completed_at: new Date().toISOString(), vc_reward }, `?id=eq.${job_id}`);
    const node = await sb("bridge_nodes", "GET", null, `?bridge_id=eq.${bridge_id}&select=jobs_done,vc_earned`);
    if (Array.isArray(node) && node.length > 0) {
      await sb("bridge_nodes", "PATCH", { jobs_done: (node[0].jobs_done||0)+1, vc_earned: (node[0].vc_earned||0)+vc_reward }, `?bridge_id=eq.${bridge_id}`);
    }
    const credited = await creditVC(user.id, user.username, vc_reward, `Bridge job: ${job.tool}`);
    const updated  = await sb("users", "GET", null, `?id=eq.${user.id}&select=vc_balance`);
    res.json({ success: true, vc_credited: credited, vc_reward, new_balance: updated?.[0]?.vc_balance || 0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/bridge/disconnect", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const user  = await verifyMemberToken(token);
  if (!user) return res.status(401).json({ error: "Invalid token" });
  const { bridge_id } = req.body;
  try {
    await sb("bridge_nodes", "PATCH", { status: "offline", last_ping: new Date().toISOString() }, `?bridge_id=eq.${bridge_id}`);
    console.log(`[BRIDGE] ${user.username} disconnected`);
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});

app.post("/bridge/auto-install", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const user  = await verifyMemberToken(token);
  if (!user) return res.status(401).json({ error: "Invalid token" });
  const { installed_tools } = req.body;
  try {
    const registry = await sb("tool_registry", "GET", null, "?approved=eq.true&select=*");
    if (!Array.isArray(registry)) return res.json({ tools: [] });
    const toInstall = registry.filter(t => !installed_tools.includes(t.name));
    res.json({ tools: toInstall });
  } catch(e) { res.json({ tools: [] }); }
});

app.post("/bridge/tool-installed", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const user  = await verifyMemberToken(token);
  if (!user) return res.status(401).json({ error: "Invalid token" });
  const { tool } = req.body;
  try {
    const node = await sb("bridge_nodes", "GET", null, `?user_id=eq.${user.id}&select=installed_tools`);
    if (Array.isArray(node) && node.length > 0) {
      const tools = [...(node[0].installed_tools||[]), tool];
      await sb("bridge_nodes", "PATCH", { installed_tools: tools, node_type: getNodeType(tools), specializations: getSpecializations(tools) }, `?user_id=eq.${user.id}`);
    }
    res.json({ success: true });
  } catch(e) { res.json({ success: false }); }
});

app.get("/bridge/install", async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send("# Missing token");
  const user = await verifyMemberToken(token);
  if (!user) return res.status(401).send("# Invalid token. Get your token from your dashboard.");
  const fs = require("fs");
  const path = require("path");
  const filePath = path.join(__dirname, "bridge.py");
  if (!fs.existsSync(filePath)) return res.status(404).send("# Bridge script not available yet.");
  res.setHeader("Content-Type", "text/plain");
  fs.createReadStream(filePath).pipe(res);
});

// ============================================
// BRIDGE ROUTES — ADMIN SIDE
// ============================================

app.get("/admin/bridges", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });
  try {
    const nodes = await sb("bridge_nodes", "GET", null, "?select=*&order=last_ping.desc");
    const now = Date.now();
    const processed = (nodes||[]).map(n => ({
      ...n,
      status: (now - new Date(n.last_ping).getTime()) > 60000 ? "offline" : n.status
    }));
    res.json({ bridges: processed });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/bridge-dispatch", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });
  const { tool, command, category, target } = req.body;
  if (!tool || !command) return res.status(400).json({ error: "tool and command required" });
  try {
    const job = await sb("bridge_jobs", "POST", {
      tool, command, category: category||"BASIC", target: target||"",
      status: "queued", dispatched_by: admin.username, vc_reward: getVCReward(category||"BASIC")
    });
    console.log(`[ADMIN] ${admin.username} dispatched ${tool} job`);
    res.json({ success: true, job: job?.[0]||{} });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/bridge-jobs", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });
  try {
    const jobs = await sb("bridge_jobs", "GET", null, "?select=*&order=created_at.desc&limit=50");
    res.json({ jobs: Array.isArray(jobs) ? jobs : [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get("/admin/tool-registry", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });
  try {
    const tools = await sb("tool_registry", "GET", null, "?select=*&order=category.asc");
    res.json({ tools: Array.isArray(tools) ? tools : [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post("/admin/tool-registry", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });
  const { name, github_url, install_cmd, category, description } = req.body;
  if (!name || !install_cmd || !category) return res.status(400).json({ error: "name, install_cmd, category required" });
  try {
    const tool = await sb("tool_registry", "POST", {
      name, github_url: github_url||"", install_cmd, category,
      description: description||"", approved: true, added_by: admin.username
    });
    res.json({ success: true, tool: tool?.[0]||{} });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/admin/tool-registry/:id", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "").trim();
  const admin = await verifyAdminToken(token);
  if (!admin) return res.status(401).json({ error: "Unauthorized" });
  const { approved } = req.body;
  try {
    await sb("tool_registry", "PATCH", { approved }, `?id=eq.${req.params.id}`);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// ============================================
// AI ANALYZE — Called by bridge backend
// ============================================
app.post("/ai/analyze", async (req, res) => {
  const { tool, command, output } = req.body;
  if (!output) return res.json({ analysis: null });

  const messages = [{
    role: "user",
    content: `You are a cybersecurity analyst reviewing tool output.
Tool: ${tool}
Command: ${command}
Output:
${output}

Provide a concise analysis:
1. Key findings
2. Risk level (LOW/MEDIUM/HIGH/CRITICAL)
3. Recommended next steps`
  }];

  try {
    const analysis = await callAI(messages, "Ghost", null);
    res.json({ analysis });
  } catch(e) {
    res.json({ analysis: null, error: e.message });
  }
});
