const { normalizeDomain } = require("../constants/domains");
const { DEFAULT_PROGRESS_METRICS, resolvePrimaryDomain } = require("./stage1State");
const { enrichProgressMetricsFromMap } = require("./stage1ProgressMetrics");
const {
  appendProofToCoachingMemory,
  appendProgressLog,
} = require("../stage1/coach/context/coachingMemory");

const PROOF_TYPES = new Set(["action", "resistance", "recovery"]);
const MAX_PROOF_LOGS = 200;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const newProofId = () =>
  `proof-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const normalizeProofType = (type) => {
  const t = String(type || "action").toLowerCase();
  return PROOF_TYPES.has(t) ? t : "action";
};

const listProofLogs = (stage1, { domain = null, limit = 50 } = {}) => {
  const logs = Array.isArray(stage1?.proof_logs) ? stage1.proof_logs : [];
  let filtered = logs;
  if (domain) {
    const d = normalizeDomain(domain);
    filtered = logs.filter((p) => p.domain === d);
  }
  return filtered
    .slice()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
};

const proofsInWindow = (logs, domain, { types = ["action"], days = 7 } = {}) => {
  const d = normalizeDomain(domain);
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return logs.filter((p) => {
    if (d && p.domain !== d) return false;
    if (!types.includes(p.type)) return false;
    const at = new Date(p.created_at).getTime();
    return Number.isFinite(at) && at >= since;
  });
};

/** Rep completion = share of last 7 days with at least one action proof (0–1). */
const computeRepCompletionRate = (logs, domain) => {
  const d = normalizeDomain(domain);
  const all = Array.isArray(logs) ? logs : [];
  const actionProofs = proofsInWindow(all, d, { types: ["action"], days: 7 });
  const daysWithProof = new Set(
    actionProofs.map((p) => new Date(p.created_at).toISOString().slice(0, 10)),
  );
  return Math.min(1, daysWithProof.size / 7);
};

const buildWeeklyRepCompletion = (logs, domain) => {
  const d = normalizeDomain(domain);
  const labels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const day = new Date(now);
    day.setDate(day.getDate() - i);
    const key = day.toISOString().slice(0, 10);
    const hasProof = proofsInWindow(logs, d, { types: ["action"], days: 7 }).some(
      (p) => new Date(p.created_at).toISOString().slice(0, 10) === key,
    );
    days.push({
      date: key,
      label: labels[day.getDay()],
      completed: hasProof,
    });
  }
  const completed = days.filter((x) => x.completed).length;
  return { completed, total: 7, days };
};

const applyProofMetricsToMap = (map, proofLogs) => {
  const base =
    map.progress_metrics && typeof map.progress_metrics === "object"
      ? { ...map.progress_metrics }
      : typeof DEFAULT_PROGRESS_METRICS === "function"
        ? DEFAULT_PROGRESS_METRICS()
        : { ...DEFAULT_PROGRESS_METRICS };

  const domainLogs = proofLogs.filter((p) => p.domain === map.domain);
  const rate = computeRepCompletionRate(domainLogs, map.domain);
  const proofOfChange = domainLogs
    .filter((p) => p.type === "action")
    .slice(-20)
    .map((p) => ({
      at: p.created_at,
      action: p.action,
      id: p.id,
    }));

  const metrics = enrichProgressMetricsFromMap(map, {
    ...base,
    rep_completion_rate: rate,
    proof_of_change: proofOfChange,
    proof_logged_count: domainLogs.filter((p) => p.type === "action").length,
    last_proof_at: domainLogs[0]?.created_at || base.last_proof_at || null,
  });

  return { ...map, progress_metrics: metrics };
};

/**
 * Append proof log and refresh progress_metrics on the domain map.
 */
const recordProof = (stage1, payload) => {
  const domain =
    normalizeDomain(payload.domain) || resolvePrimaryDomain(stage1);
  if (!domain) {
    return { ok: false, error: "No domain. Activate a domain first.", status: 400 };
  }

  const action = String(payload.action || "").trim();
  if (action.length < 3) {
    return {
      ok: false,
      error: "Describe what you did (at least 3 characters).",
      status: 400,
    };
  }

  const maps = stage1.domain_maps || [];
  const mapIdx = maps.findIndex((m) => m.domain === domain);
  if (mapIdx < 0) {
    return { ok: false, error: "Domain map not found. Save goals first.", status: 404 };
  }

  const map = maps[mapIdx];
  if (!map.map_resistance_complete && !map.goals_complete) {
    return {
      ok: false,
      error: "Complete goals or Map Resistance before logging proof.",
      status: 400,
    };
  }

  const logs = Array.isArray(stage1.proof_logs) ? [...stage1.proof_logs] : [];
  const entry = {
    id: newProofId(),
    domain,
    action,
    type: normalizeProofType(payload.type),
    green_rep_name: payload.green_rep_name?.trim() || null,
    created_at: new Date().toISOString(),
    source:
      payload.source === "coach" || payload.source === "coaching"
        ? "coach"
        : "user",
  };

  logs.unshift(entry);
  const proof_logs = logs.slice(0, MAX_PROOF_LOGS);

  const nextMaps = [...maps];
  let updatedMap = applyProofMetricsToMap(map, proof_logs);
  updatedMap = appendProofToCoachingMemory(updatedMap, entry);
  updatedMap = appendProgressLog(updatedMap, {
    id: `prog-proof-${entry.id}`,
    type: "proof_logged",
    note: entry.action,
    proof_id: entry.id,
    green_rep_name: entry.green_rep_name,
  });
  nextMaps[mapIdx] = updatedMap;

  const nextStage1 = {
    ...stage1,
    proof_logs,
    domain_maps: nextMaps,
  };

  return {
    ok: true,
    proof: entry,
    progress_metrics: nextMaps[mapIdx].progress_metrics,
    stage1: nextStage1,
  };
};

const buildProgressPayload = (stage1, domain) => {
  const d = normalizeDomain(domain) || resolvePrimaryDomain(stage1);
  const map = (stage1.domain_maps || []).find((m) => m.domain === d);
  const allLogs = stage1.proof_logs || [];
  const proof_logs = listProofLogs(stage1, { domain: d, limit: 30 });
  const weekly_rep_completion = buildWeeklyRepCompletion(allLogs, d);

  const mapWithMetrics = map ? applyProofMetricsToMap({ ...map }, allLogs) : null;

  return {
    domain: d,
    progress_metrics: mapWithMetrics?.progress_metrics || null,
    proof_logs,
    weekly_rep_completion,
    daily_rep: map?.daily_rep || null,
    win_condition: map?.win_condition || null,
  };
};

module.exports = {
  PROOF_TYPES,
  listProofLogs,
  computeRepCompletionRate,
  buildWeeklyRepCompletion,
  recordProof,
  buildProgressPayload,
  applyProofMetricsToMap,
};
