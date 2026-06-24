/**
 * Structural map metrics for /map.
 * - Baseline from Map Resistance (stored fields + proof/progress)
 * - Updated each coaching turn via structural_map_history snapshots
 */

const { calculateSignal } = require("../utils/euphoriamMatrix");
const { ensureCoachingMemory } = require("../stage1/coach/context/coachingMemory");
const { mergeCoachingSessions } = require("../stage1/coach/legacy/homeOverlay");

const pickMetric = (sources, keys) => {
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    for (const key of keys) {
      const v = src[key];
      if (v !== undefined && v !== null && v !== "") return v;
    }
  }
  return null;
};

const toNumber = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, Math.round(n)));

const normalizeClDisplay = (raw) => {
  const n = toNumber(raw);
  if (n == null) return null;
  if (n >= 1 && n <= 5) return Math.round((n / 5) * 100);
  return clamp(n, 0, 100);
};

const normalizeClLevel = (raw) => {
  const n = toNumber(raw);
  if (n == null) return null;
  if (n >= 1 && n <= 5) return n;
  if (n > 5) {
    const cl = n / 20;
    return Math.max(1, Math.min(5, Math.round(cl * 10) / 10));
  }
  return null;
};

/** Normalize stored diagnostic metrics (CL is 1.0–5.0; AI sometimes saves 0–100). */
const normalizeDiagnosticMetrics = (metrics = {}) => {
  if (!metrics || typeof metrics !== "object") return metrics;
  const out = { ...metrics };
  const cl = normalizeClLevel(out.consciousnessLevel);
  if (cl != null) out.consciousnessLevel = cl;
  return out;
};

/** CL as 0–100 display % for gauge bar fill only (not the printed CL label). */
const consciousnessLevelToDisplayPct = (raw) => {
  const cl = normalizeClLevel(raw);
  if (cl == null) return null;
  return normalizeClDisplay(cl);
};

/** CL label on the original 1.0–5.0 scale (e.g. 2.0, 2.5) — not a percentage. */
const formatConsciousnessLevel = (raw) => {
  const cl = normalizeClLevel(raw);
  if (cl == null) return null;
  return Number.isInteger(cl) ? `${cl}.0` : cl.toFixed(1);
};

const repCompletionPct = (progressMetrics) => {
  const rate = toNumber(progressMetrics?.rep_completion_rate);
  if (rate == null) return null;
  const pct = rate <= 1 ? rate * 100 : rate;
  return clamp(pct, 0, 100);
};

const inferGravityDepth = (map) => {
  const stored = toNumber(pickMetric([map], ["gravity_depth", "gravityDepth"]));
  if (stored != null && stored >= 1 && stored <= 3) return stored;

  const recovery = String(map?.recovery_speed || "").toLowerCase();
  if (recovery.includes("slow")) return 2;
  if (recovery.includes("fast")) return 1;
  if (recovery.includes("moderate")) return 2;

  const orbit = String(map?.orbit_pattern || "").toLowerCase();
  if (/collapse|template|subatomic/.test(orbit)) return 3;
  if (/avoid|delay|orbit/.test(orbit)) return 2;
  return map?.map_resistance_complete ? 2 : null;
};

const inferClLevel = (map) => {
  const stored = normalizeClLevel(
    pickMetric([map], ["CL_estimate", "cl_estimate", "CL", "consciousness_level"]),
  );
  if (stored != null) return stored;

  const recovery = String(map?.recovery_speed || "").toLowerCase();
  if (recovery.includes("slow")) return 2;
  if (recovery.includes("fast")) return 3.5;
  if (recovery.includes("moderate")) return 2.5;
  return map?.map_resistance_complete ? 2.5 : null;
};

const countProofMix = (map, proofLogs = []) => {
  const domain = map?.domain;
  const memoryProofs = ensureCoachingMemory(map).proof_logs || [];
  const stageProofs = (proofLogs || []).filter((p) => p?.domain === domain);
  const all = [...memoryProofs, ...stageProofs];
  const byId = new Map();
  for (const p of all) {
    if (p?.id) byId.set(p.id, p);
    else if (p?.action) byId.set(`${p.created_at}-${p.action}`, p);
  }
  const proofs = [...byId.values()];
  const action = proofs.filter((p) => p.type !== "resistance").length;
  const resistance = proofs.filter((p) => p.type === "resistance").length;
  return { action, resistance, total: proofs.length };
};

const inferResistanceLoad = (map) => {
  const stored = toNumber(pickMetric([map], ["gravity_load", "gravityLoad"]));
  if (stored != null && stored > 3) return clamp(stored, 0, 100);

  let load = 52;
  const recovery = String(map?.recovery_speed || "").toLowerCase();
  if (recovery.includes("slow")) load += 12;
  else if (recovery.includes("moderate")) load += 6;

  const orbit = String(map?.orbit_pattern || "").toLowerCase();
  if (/avoid|delay|postpone/.test(orbit)) load += 8;
  if (/collapse|overthink/.test(orbit)) load += 6;

  const avoidCount = Array.isArray(map?.top_3_avoidance_behaviours)
    ? map.top_3_avoidance_behaviours.filter(Boolean).length
    : 0;
  load += avoidCount * 2;

  if (map?.protector_rule?.trim()) load += 4;
  return clamp(load, 35, 92);
};

const inferSuccessPull = (map, progressMetrics, proofMix) => {
  const integrationPct = repCompletionPct(progressMetrics) ?? 0;
  const repsDone = Number(progressMetrics?.green_reps_completed ?? 0);
  let pull = 18 + proofMix.action * 10 + repsDone * 8 + integrationPct * 0.35;
  pull -= proofMix.resistance * 4;
  return clamp(pull, 12, 88);
};

const inferGravityFromCoachState = (state) => {
  const s = String(state || "").toLowerCase();
  if (s === "abducted") return 9;
  if (s === "high_gravity") return 8;
  if (s === "progress") return 4;
  if (s === "clear") return 5;
  return null;
};

/** Baseline snapshot captured at Map Resistance finalize (or backfilled). */
const buildMapResistanceBaseline = (map, opts = {}) => {
  if (!map?.map_resistance_complete) return null;

  const pm = map.progress_metrics || {};
  const proofMix = countProofMix(map, opts.proof_logs);
  const depth = inferGravityDepth(map);
  const clLevel = inferClLevel(map);
  const load = inferResistanceLoad(map);
  const integrationPct = repCompletionPct(pm) ?? 0;
  const successPull = inferSuccessPull(map, pm, proofMix);

  const lack = clamp(load + 2);
  const avoid = clamp(load + 5);
  const protector = clamp(load + (map?.protector_rule ? 8 : 4));
  const integration = clamp((load + successPull) / 2);
  const behaviour = clamp(successPull + 4);
  const belief = clamp(successPull + 8);
  const proof = clamp(successPull + proofMix.action * 3);

  let dominantZone = "current";
  if (successPull > load + 10) dominantZone = "future";
  else if (Math.abs(load - successPull) < 10) dominantZone = "balanced";

  const qgc = clamp(38 + (map.goals_complete ? 8 : 0) + proofMix.action * 4, 30, 75);

  return {
    source: "map_resistance_baseline",
    captured_at: map.map_resistance_completed_at || map.updatedAt || new Date().toISOString(),
    gravity_depth: depth,
    gravity_load: load,
    gravity_rating: null,
    cl_estimate: normalizeClDisplay(clLevel),
    cl_level: clLevel,
    qgc_activation: qgc,
    gravity_score: load,
    integration_pct: integrationPct,
    signal_output: null,
    dominant_zone: dominantZone,
    pillars: {
      current_lack: { gravity: lack },
      current_avoid: { gravity: avoid },
      current_protector: { gravity: protector },
      vortex: { gravity: integration },
      future_behaviour: { gravity: behaviour },
      future_belief: { gravity: belief },
      future_proof: { gravity: proof },
    },
    has_live_gravity: true,
  };
};

const ensureStructuralMapBaseline = (map, opts = {}) => {
  if (map?.structural_map_baseline?.pillars) return map.structural_map_baseline;
  return buildMapResistanceBaseline(map, opts);
};

const allCoachingSessions = (map, coachSessionLog = []) => {
  const memory = ensureCoachingMemory(map);
  return mergeCoachingSessions(
    memory.coaching_sessions || memory.coaching_history || [],
    coachSessionLog,
    map?.domain,
  );
};

const latestCoachingSession = (map, coachSessionLog = []) => {
  const sessions = allCoachingSessions(map, coachSessionLog);
  return sessions.length ? sessions[sessions.length - 1] : null;
};

const mergePillarGravity = (baseline, override) => {
  const ids = [
    "current_lack",
    "current_avoid",
    "current_protector",
    "vortex",
    "future_behaviour",
    "future_belief",
    "future_proof",
  ];
  const pillars = {};
  for (const id of ids) {
    const o = override?.pillars?.[id]?.gravity;
    const b = baseline?.pillars?.[id]?.gravity;
    pillars[id] = { gravity: o != null ? o : b ?? null };
  }
  return pillars;
};

const buildSnapshotFromSession = (map, session, baseline, pm) => {
  if (!session) return null;

  const stateRating =
    toNumber(session.gravity_rating_last) ??
    inferGravityFromCoachState(session.state_last || session.state_at_start);
  const resistance =
    stateRating != null
      ? clamp(stateRating * 10, 10, 100)
      : baseline?.gravity_score ?? null;

  const integrationPct = repCompletionPct(pm) ?? baseline?.integration_pct ?? null;
  const proofMix = countProofMix(map);
  const success =
    resistance != null
      ? clamp(
          (baseline?.pillars?.future_behaviour?.gravity ?? 20) +
            proofMix.action * 6 -
            proofMix.resistance * 3 +
            (integrationPct ?? 0) * 0.2,
          12,
          92,
        )
      : null;

  const pillars = mergePillarGravity(baseline, {
    pillars: {
      current_lack: { gravity: resistance != null ? clamp(resistance + 2) : null },
      current_avoid: { gravity: resistance != null ? clamp(resistance + 5) : null },
      current_protector: { gravity: resistance != null ? clamp(resistance + 8) : null },
      vortex: {
        gravity:
          resistance != null && success != null
            ? clamp((resistance + success) / 2)
            : null,
      },
      future_behaviour: { gravity: success },
      future_belief: { gravity: success != null ? clamp(success + 4) : null },
      future_proof: { gravity: success != null ? clamp(success + proofMix.action * 2) : null },
    },
  });

  return {
    at: session.updated_at || session.started_at,
    session_id: session.session_id || session.id,
    source: session.ended_at ? "coaching_session_end" : "coaching_turn",
    gravity_rating: stateRating,
    cl_estimate:
      normalizeClDisplay(session.cl_estimate) ??
      baseline?.cl_estimate ??
      null,
    gravity_score: resistance,
    integration_pct: integrationPct,
    dominant_zone:
      success != null && resistance != null && success > resistance + 8
        ? "future"
        : resistance != null && success != null && resistance > success + 8
          ? "current"
          : "balanced",
    pillars,
    live_failure_strategy:
      session.current_failure_strategy?.rule ||
      session.current_resistance ||
      session.current_fear ||
      null,
    live_success_strategy:
      session.current_success_strategy?.behaviour ||
      session.current_success_strategy?.rule ||
      null,
    session_summary: session.session_summary || null,
  };
};

const buildProgressSeries = (map, baseline, sessions, pm, opts = {}) => {
  const series = [];

  if (baseline) {
    series.push({
      at: baseline.captured_at,
      source: "map_resistance_baseline",
      label: "Map Resistance baseline",
      gravity_score: baseline.gravity_score,
      integration_pct: baseline.integration_pct,
      cl_estimate: baseline.cl_estimate,
      pillars: baseline.pillars,
    });
  }

  for (const session of sessions) {
    const snap = buildSnapshotFromSession(map, session, baseline, pm);
    if (snap) {
      series.push({
        at: snap.at,
        source: snap.source,
        label: snap.session_summary
          ? `Coach: ${String(snap.session_summary).slice(0, 48)}`
          : `Coach session ${snap.session_id || ""}`.trim(),
        gravity_score: snap.gravity_score,
        integration_pct: snap.integration_pct,
        cl_estimate: snap.cl_estimate,
        gravity_rating: snap.gravity_rating,
        pillars: snap.pillars,
        session_id: snap.session_id,
      });
    }
  }

  const proofMix = countProofMix(map, opts.proof_logs);
  const memory = ensureCoachingMemory(map);
  const proofs = [...(memory.proof_logs || []), ...(opts.proof_logs || [])]
    .filter((p) => p?.domain === map?.domain || !p?.domain)
    .sort((a, b) => new Date(a.created_at || a.at) - new Date(b.created_at || b.at));

  for (const proof of proofs.slice(-12)) {
    if (!proof?.action) continue;
    const at = proof.created_at || proof.at;
    const isResistance = proof.type === "resistance";
    series.push({
      at,
      source: isResistance ? "proof_resistance" : "proof_action",
      label: String(proof.action).slice(0, 64),
      gravity_score: isResistance ? clamp((baseline?.gravity_score ?? 60) + 6) : null,
      integration_pct: repCompletionPct(pm),
      proof_type: proof.type || "action",
    });
  }

  return series
    .filter((e) => e.at)
    .sort((a, b) => new Date(a.at) - new Date(b.at))
    .slice(-40);
};

const buildStructuralMapForClient = (map, opts = {}) => {
  if (!map || typeof map !== "object") return null;

  const pm = map.progress_metrics || {};
  const baseline = ensureStructuralMapBaseline(map, opts);
  const memory = ensureCoachingMemory(map);
  const sessions = allCoachingSessions(map, opts.coach_session_log || []);
  const latest = sessions.length ? sessions[sessions.length - 1] : null;
  const latestSnap = buildSnapshotFromSession(map, latest, baseline, pm);

  const storedHistory = Array.isArray(memory.structural_map_history)
    ? memory.structural_map_history
    : [];
  const progressSeries =
    storedHistory.length > 0
      ? storedHistory
      : buildProgressSeries(map, baseline, sessions, pm, opts);

  const current = latestSnap || baseline;
  if (!current) return null;

  const clLevel =
    normalizeClLevel(latest?.cl_estimate) ??
    baseline?.cl_level ??
    inferClLevel(map);
  const qgc = toNumber(baseline?.qgc_activation) ?? 42;
  const depth = baseline?.gravity_depth ?? inferGravityDepth(map);
  const load = latestSnap?.gravity_score ?? baseline?.gravity_load ?? inferResistanceLoad(map);

  let signal = null;
  if (qgc != null && clLevel != null && load != null) {
    signal = calculateSignal({
      qgcActivation: qgc,
      cl: clLevel,
      gravityLoad: load,
      gravityDepth: depth || 2,
    });
  }

  const pillars = current.pillars || baseline?.pillars || {};
  if (signal?.signalOutput != null && pillars.future_behaviour) {
    const boosted = clamp(signal.signalOutput + 50, 12, 92);
    pillars.future_behaviour = { gravity: boosted };
    pillars.future_belief = { gravity: clamp(boosted + 4) };
    pillars.future_proof = {
      gravity: clamp(boosted + countProofMix(map, opts.proof_logs).action * 2),
    };
  }

  return {
    gravity_depth: depth,
    gravity_load: load,
    gravity_rating: latestSnap?.gravity_rating ?? null,
    cl_estimate: current.cl_estimate ?? normalizeClDisplay(clLevel),
    cl_level: clLevel,
    qgc_activation: qgc,
    gravity_score: current.gravity_score ?? baseline?.gravity_score ?? null,
    integration_pct: current.integration_pct ?? repCompletionPct(pm),
    signal_output: signal?.signalOutput ?? null,
    dominant_zone: current.dominant_zone ?? baseline?.dominant_zone ?? null,
    pillars,
    has_live_gravity: Boolean(baseline?.has_live_gravity || latestSnap?.gravity_score != null),
    baseline,
    latest_snapshot: latestSnap,
    progress_series: progressSeries,
    live_failure_strategy: latestSnap?.live_failure_strategy ?? null,
    live_success_strategy: latestSnap?.live_success_strategy ?? null,
  };
};

/** Persist a structural map snapshot after each coaching turn. */
const appendStructuralMapSnapshot = (map, opts = {}) => {
  const baseline = ensureStructuralMapBaseline(map, opts);
  const memory = ensureCoachingMemory(map);
  const sessions = allCoachingSessions(map, opts.coach_session_log || []);
  const latest = sessions[sessions.length - 1];
  const snap = buildSnapshotFromSession(map, latest, baseline, map.progress_metrics || {});
  if (!snap) return map;

  const history = [...(memory.structural_map_history || []), snap].slice(-60);
  return {
    ...map,
    structural_map_baseline: baseline,
    coaching_memory: {
      ...memory,
      structural_map_history: history,
    },
  };
};

/** Metrics to freeze into initial_diagnostic at Map Resistance finalize. */
const baselineMetricsForDiagnostic = (map, opts = {}) => {
  const baseline = buildMapResistanceBaseline(map, opts);
  if (!baseline) return {};
  return {
    gravity_depth: baseline.gravity_depth,
    gravity: baseline.gravity_load,
    gravity_load: baseline.gravity_load,
    CL: baseline.cl_level,
    CL_estimate: baseline.cl_estimate,
    QGC: baseline.qgc_activation,
  };
};

module.exports = {
  buildStructuralMapForClient,
  buildMapResistanceBaseline,
  ensureStructuralMapBaseline,
  appendStructuralMapSnapshot,
  baselineMetricsForDiagnostic,
  inferGravityFromCoachState,
  pickMetric,
  normalizeClDisplay,
  normalizeClLevel,
  normalizeDiagnosticMetrics,
  consciousnessLevelToDisplayPct,
  formatConsciousnessLevel,
  inferClLevel,
};
