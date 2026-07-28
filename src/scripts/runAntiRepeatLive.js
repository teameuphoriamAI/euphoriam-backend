#!/usr/bin/env node
/**
 * Live anti-repeat test against Docker stack (backend :4000 + ai-worker :8000).
 *
 * Usage:
 *   node src/scripts/runAntiRepeatLive.js
 *   BACKEND_URL=http://localhost:4000 node src/scripts/runAntiRepeatLive.js
 */

require("dotenv").config();

const BACKEND = (process.env.BACKEND_URL || "http://localhost:4000").replace(/\/$/, "");
const TEST_EMAIL = process.env.ANTI_REPEAT_TEST_EMAIL || "anti-repeat-test@euphoriam.local";

const THEME_RE =
  /\b(fear of rejection|protective mechanism|being seen as too much|reach out|schedule (?:a|time to) catch up)\b/i;
const PRESCRIPTIVE_RE =
  /(?:^\s*\d+\.|try this|write down|close your eyes|take a deep breath|send (?:them|a message)|step-by-step|small action|concrete step)/im;

const tokenOverlap = (a, b) => {
  const ta = new Set(
    String(a || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  const tb = new Set(
    String(b || "")
      .toLowerCase()
      .replace(/[^\w\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared += 1;
  return shared / Math.max(ta.size, tb.size);
};

const userTurns = [
  "I want to build healthier relationships, but I keep pulling away when I start getting close. I want to understand why.",
  "Reaching out isn't the problem. I want to understand what's driving the pattern instead of just getting something to do.",
  "The first thing I notice is anxiety. Part of me wants closeness, but another part protects me and I create distance.",
  "I'm not sure a small action is what I need. I'd like to understand why pulling away feels safer than staying connected.",
  "I don't want an exercise. Can we stay with the feeling instead of moving to an action step?",
  "I notice we're moving into another exercise, but I want to understand what's underneath before trying to change behavior.",
];

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function ensureTestDomain(token) {
  const domain = "relationships";
  let { res, data } = await jsonFetch(`${BACKEND}/api/stage1/domains`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      domain,
      goal_title: "Build healthier relationships",
      desired_outcome: "Understand why I pull away when closeness grows",
      milestones: [{ title: "Identify key relationships", completed: false }],
    }),
  });
  if (!res.ok && res.status !== 400) {
    throw new Error(`create domain failed (${res.status}): ${data?.message || JSON.stringify(data)}`);
  }

  ({ res, data } = await jsonFetch(`${BACKEND}/api/stage1/domains/${domain}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      goal_title: "Build healthier relationships",
      desired_outcome: "Understand why I pull away when closeness grows",
    }),
  }));

  // Bootstrap map resistance via internal persistence (API does not expose complete flag on PATCH).
  require("dotenv").config();
  const jwt = require("jsonwebtoken");
  const decoded = jwt.decode(token);
  const userId = decoded?.sub || decoded?.userId;
  if (!userId) throw new Error("Could not decode user id from token");

  const { loadStage1ForUser, persistStage1ForUser } = require("../helpers/stage1Repository");
  const { upsertDomainMap } = require("../helpers/stage1State");
  let stage1 = await loadStage1ForUser({ id: userId });
  stage1 = upsertDomainMap(stage1, domain, {
    goals_complete: true,
    map_resistance_complete: true,
    goal_title: "Build healthier relationships",
    desired_outcome: "Understand why I pull away when closeness grows",
    signature_id: "NE+S+R",
    failure_strategy: { rule: "Pull away when closeness increases" },
    success_strategy: { behaviour: "Stay present in meaningful connection" },
    flip_belief: "I can be close and still be safe",
    protector_rule: "Create distance before hurt",
    core_fear: "Being abandoned",
    coaching_memory: {
      initial_diagnostic: { q1: "Pull away pattern in relationships" },
    },
  });
  await persistStage1ForUser(userId, stage1);
  return domain;
}

async function getToken() {
  // Existing users: email only (name triggers "Account already created").
  let { res, data } = await jsonFetch(`${BACKEND}/api/diagnostics/checkUser`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: TEST_EMAIL }),
  });
  let token = data?.result?.token || data?.data?.token;
  if (!token && data?.message === "Account not found") {
    ({ res, data } = await jsonFetch(`${BACKEND}/api/diagnostics/checkUser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL, name: "Anti Repeat Test" }),
    }));
    token = data?.result?.token || data?.data?.token;
  }
  if (!res.ok || !token) {
    throw new Error(`checkUser failed (${res.status}): ${data?.message || JSON.stringify(data)}`);
  }
  return token;
}

async function coachCheckin(token, body) {
  const { res, data } = await jsonFetch(`${BACKEND}/api/stage1/coach/checkin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const assistant =
    data?.result?.assistant_message ||
    data?.data?.assistant_message ||
    data?.assistant_message ||
    "";
  const signals =
    data?.result?.conversation_signals ||
    data?.result?.checkin?.conversation_signals ||
    data?.data?.conversation_signals ||
    data?.data?.checkin?.conversation_signals ||
    data?.conversation_signals ||
    {};
  if (!res.ok) {
    throw new Error(`coachCheckin failed (${res.status}): ${data?.message || JSON.stringify(data)}`);
  }
  return { assistant: String(assistant).trim(), signals, raw: data };
}

function analyzeReply(assistant, priorAssistants, turnIndex) {
  const issues = [];
  if (!assistant) issues.push("empty reply");

  for (const prior of priorAssistants) {
    if (prior.trim() === assistant.trim()) {
      issues.push("EXACT duplicate of prior reply");
    }
    const overlap = tokenOverlap(assistant, prior);
    if (overlap >= 0.85) issues.push(`near-exact overlap ${(overlap * 100).toFixed(0)}%`);
    else if (overlap >= 0.38) issues.push(`high overlap ${(overlap * 100).toFixed(0)}%`);
  }

  if (turnIndex >= 3 && PRESCRIPTIVE_RE.test(assistant)) {
    issues.push("prescriptive exercise/action detected");
  }
  if (turnIndex >= 2 && THEME_RE.test(assistant)) {
    const themeCount = priorAssistants.filter((p) => THEME_RE.test(p)).length;
    if (themeCount >= 1) issues.push("repeated diagnosis/action theme");
  }
  if (assistant.split(/\s+/).length > 80) {
    issues.push("reply too long for discovery-only");
  }

  return issues;
}

(async () => {
  console.log(`Anti-repeat live test → ${BACKEND}\n`);

  const health = await fetch(`${BACKEND}/api/health`).catch(() => null);
  if (!health?.ok) {
    console.error("Backend not reachable. Run: docker compose up --build -d");
    process.exit(1);
  }

  const token = await getToken();
  const domain = await ensureTestDomain(token);
  const messages = [];
  const assistantHistory = [];
  let failed = 0;

  for (let i = 0; i < userTurns.length; i += 1) {
    const userMessage = userTurns[i];
    messages.push({ role: "user", content: userMessage });

    const { assistant, signals } = await coachCheckin(token, {
      domain,
      state: "coaching",
      message: userMessage,
      messages: messages.slice(0, -1),
      session_intention: "Understand why I pull away in relationships",
      gravity_rating: 4,
    });

    messages.push({ role: "assistant", content: assistant });
    const issues = analyzeReply(assistant, assistantHistory, i);
    assistantHistory.push(assistant);

    const discovery = signals.discovery_only_mode || signals.anti_repeat_active || signals.explore_first_mode;
    console.log(`--- Turn ${i + 1} ---`);
    console.log(`User: ${userMessage.slice(0, 90)}...`);
    console.log(`Discovery mode: ${discovery ? "YES" : "no"}`);
    console.log(`Coach: ${assistant.slice(0, 220)}${assistant.length > 220 ? "..." : ""}`);

    if (issues.length) {
      failed += 1;
      console.log(`FAIL  ${issues.join("; ")}`);
    } else {
      console.log("PASS  no repeat issues detected");
    }
    console.log("");
  }

  console.log(`${userTurns.length - failed}/${userTurns.length} turns passed anti-repeat checks`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
