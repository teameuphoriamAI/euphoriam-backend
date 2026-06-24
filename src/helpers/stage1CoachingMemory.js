const { buildActiveGoalContext } = require("./stage1GoalContext");
const { resolveFailureStrategyForMap, resolveSuccessStrategyForMap } = require("./stage1MapStructure");

const MAX_COACHING_HISTORY = 60;
const MAX_PROOF_IN_MEMORY = 100;
const MAX_PROGRESS_LOGS = 80;
const MAX_OBSERVATIONS = 40;

const emptyCoachingMemory = () => ({
  initial_diagnostic: null,
  coaching_sessions: [],
  coaching_summaries: [],
  resistance_history: [],
  green_rep_history: [],
  proof_logs: [],
  progress_logs: [],
  diagnostic_observations: [],
  /** @deprecated alias — kept in sync with coaching_sessions */
  coaching_history: [],
});

const buildResistanceHistoryFromSessions = (sessions) => {
  const out = [];
  for (const s of sessions) {
    if (s.current_fear || s.current_resistance) {
      out.push({
        at: s.updated_at || s.started_at,
        session_id: s.session_id || s.id,
        fear: s.current_fear || null,
        resistance: s.current_resistance || null,
        avoidance: (s.current_avoidance_behaviours || [])[0] || null,
      });
    }
  }
  return out;
};

const buildGreenRepHistoryFromSessions = (sessions) => {
  const out = [];
  for (const s of sessions) {
    const rep = s.green_rep_assigned;
    if (rep?.name) {
      out.push({
        at: s.updated_at || s.started_at,
        session_id: s.session_id || s.id,
        name: rep.name,
        win_condition: rep.win_condition || null,
        completed: Boolean(s.green_rep_completed),
      });
    }
  }
  return out;
};

const ensureCoachingMemory = (map) => {
  const raw = map?.coaching_memory;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyCoachingMemory();
  }

  const sessions = Array.isArray(raw.coaching_sessions) && raw.coaching_sessions.length
    ? raw.coaching_sessions
    : Array.isArray(raw.coaching_history)
      ? raw.coaching_history
      : [];

  let resistance_history = Array.isArray(raw.resistance_history)
    ? raw.resistance_history
    : [];
  if (!resistance_history.length) {
    resistance_history = buildResistanceHistoryFromSessions(sessions);
  }

  let green_rep_history = Array.isArray(raw.green_rep_history) ? raw.green_rep_history : [];
  if (!green_rep_history.length) {
    green_rep_history = buildGreenRepHistoryFromSessions(sessions);
  }

  return {
    ...emptyCoachingMemory(),
    ...raw,
    initial_diagnostic:
      raw.initial_diagnostic && typeof raw.initial_diagnostic === "object"
        ? raw.initial_diagnostic
        : null,
    coaching_sessions: sessions,
    coaching_history: sessions,
    coaching_summaries: Array.isArray(raw.coaching_summaries) ? raw.coaching_summaries : [],
    resistance_history: resistance_history.slice(-80),
    green_rep_history: green_rep_history.slice(-80),
    proof_logs: Array.isArray(raw.proof_logs) ? raw.proof_logs : [],
    progress_logs: Array.isArray(raw.progress_logs) ? raw.progress_logs : [],
    diagnostic_observations: Array.isArray(raw.diagnostic_observations)
      ? raw.diagnostic_observations
      : [],
  };
};

const appendResistanceHistory = (memory, entry) => {
  if (!entry?.fear && !entry?.resistance && !entry?.avoidance) return memory;
  const row = {
    id: `res-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    at: entry.at || new Date().toISOString(),
    session_id: entry.session_id || null,
    fear: entry.fear || null,
    resistance: entry.resistance || null,
    avoidance: entry.avoidance || null,
  };
  return {
    ...memory,
    resistance_history: [...memory.resistance_history, row].slice(-80),
  };
};

const { isPlausibleGreenRepName } = require("./stage1CoachGreenRepUtils");

const appendGreenRepHistory = (memory, entry) => {
  if (!entry?.name || !isPlausibleGreenRepName(entry.name)) return memory;
  const row = {
    id: `grep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    at: entry.at || new Date().toISOString(),
    session_id: entry.session_id || null,
    name: entry.name,
    win_condition: entry.win_condition || null,
    completed: Boolean(entry.completed),
  };
  return {
    ...memory,
    green_rep_history: [...memory.green_rep_history, row].slice(-80),
  };
};

const pickMetric = (map, keys) => {
  for (const key of keys) {
    const v = map?.[key];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  const pm = map?.progress_metrics;
  if (pm && typeof pm === "object") {
    for (const key of keys) {
      const v = pm[key];
      if (v !== undefined && v !== null && v !== "") return v;
    }
  }
  return null;
};

/**
 * Frozen snapshot from Map Resistance finalize — never overwritten by coaching or re-extract.
 */
const buildInitialDiagnosticSnapshot = (map, activeGoalContext, domain) => {
  const { baselineMetricsForDiagnostic } = require("./stage1StructuralMap");
  const metrics = baselineMetricsForDiagnostic(map) || {};
  return {
    captured_at: new Date().toISOString(),
    domain,
    source: "map_resistance_25q",
    active_goal_context: activeGoalContext || null,
    EO: map?.EO ?? null,
    lack_channel: map?.lack_channel ?? null,
    avoid_type: map?.avoid_type ?? null,
    signature_id: map?.signature_id ?? null,
    orbit_pattern: map?.orbit_pattern ?? null,
    QGC: metrics.QGC ?? pickMetric(map, ["QGC", "qgc_activation", "qgcActivation"]),
    CL: metrics.CL ?? pickMetric(map, ["CL", "consciousness_level", "consciousnessLevel"]),
    CL_estimate: metrics.CL_estimate ?? pickMetric(map, ["CL_estimate", "cl_estimate"]),
    gravity: metrics.gravity ?? pickMetric(map, ["gravity", "gravity_depth", "gravityDepth"]),
    gravity_depth: metrics.gravity_depth ?? pickMetric(map, ["gravity_depth", "gravityDepth"]),
    gravity_load: metrics.gravity_load ?? pickMetric(map, ["gravity_load", "gravityLoad"]),
  failure_strategy:
    map?.failure_strategy || resolveFailureStrategyForMap(map) || null,
  success_strategy:
    map?.success_strategy || resolveSuccessStrategyForMap(map) || null,
  top_3_avoidance_behaviours: Array.isArray(map?.top_3_avoidance_behaviours)
    ? map.top_3_avoidance_behaviours
    : [],
  protector_rule: map?.protector_rule ?? null,
  core_fear: map?.core_fear ?? null,
  perceived_risk: map?.perceived_risk ?? null,
  past_pattern: map?.past_pattern ?? null,
  required_role: map?.required_role ?? null,
  recovery_speed: map?.recovery_speed ?? null,
    daily_rep: map?.daily_rep ?? null,
    win_condition: map?.win_condition ?? null,
  };
};

/** Set initial_diagnostic once when Map Resistance completes (or backfill if missing). */
const captureInitialDiagnosticIfNeeded = (map, activeGoalContext, domain) => {
  const memory = ensureCoachingMemory(map);
  if (memory.initial_diagnostic?.captured_at) {
    return map;
  }
  if (!map?.map_resistance_complete) {
    return map;
  }
  return {
    ...map,
    coaching_memory: {
      ...memory,
      initial_diagnostic: buildInitialDiagnosticSnapshot(
        map,
        activeGoalContext || buildActiveGoalContext(map, domain),
        domain,
      ),
    },
  };
};

const normalizeGreenRep = (greenRep) => {
  if (!greenRep) return null;
  if (typeof greenRep === "string") {
    return { name: greenRep.trim(), steps: [], win_condition: null, completed: false };
  }
  if (typeof greenRep === "object" && greenRep.name?.trim()) {
    return {
      name: greenRep.name.trim(),
      steps: Array.isArray(greenRep.steps) ? greenRep.steps : [],
      win_condition: greenRep.win_condition?.trim() || null,
      completed: Boolean(greenRep.completed),
    };
  }
  return null;
};

const findHistoryEntryBySession = (sessions, sessionId) => {
  if (!sessionId) return null;
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    if (sessions[i].session_id === sessionId) return sessions[i];
  }
  return null;
};

const excerptMessages = (messages, max = 24) => {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m?.role && m?.content)
    .slice(-max)
    .map((m) => ({
      role: m.role,
      content: String(m.content).slice(0, 900),
    }));
};

/**
 * Record one coach turn into coaching_history (linked to coach_session_log session_id).
 */
const _appendStructuralSnapshot = (map, opts = {}) => {
  try {
    const { appendStructuralMapSnapshot } = require("./stage1StructuralMap");
    return appendStructuralMapSnapshot(map, opts);
  } catch {
    return map;
  }
};

const recordCoachingMemoryTurn = (
  map,
  {
    session_id,
    domain,
    state,
    messages = [],
    user_message,
    assistant_message,
    green_rep,
    gravity_rating,
    writeback_hints = {},
    detected_failure_strategy,
    active_goal_context,
    opening_checkin = false,
  },
) => {
  const memory = ensureCoachingMemory(map);
  const history = [...memory.coaching_sessions];
  const now = new Date().toISOString();
  const hints =
    writeback_hints && typeof writeback_hints === "object" ? writeback_hints : {};

  let entry = findHistoryEntryBySession(history, session_id);
  if (!entry) {
    entry = {
      id: `cm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      session_id: session_id || null,
      domain,
      started_at: now,
      updated_at: now,
      ended_at: null,
      state_at_start: state,
      state_last: state,
      session_summary: null,
      current_resistance: null,
      current_fear: null,
      current_avoidance_behaviours: [],
      current_failure_strategy: null,
      current_success_strategy: null,
      green_rep_assigned: null,
      green_rep_completed: false,
      gravity_rating_last: null,
      coaching_insights: [],
      cl_estimate: null,
      milestone_focus: null,
      messages: [],
      turn_count: 0,
      opening_checkin: Boolean(opening_checkin),
      phase: opening_checkin ? "check_in" : "coaching",
    };
    history.push(entry);
  }

  if (opening_checkin) entry.opening_checkin = true;
  if (user_message?.trim()) entry.phase = "coaching";

  if (Array.isArray(messages) && messages.length) {
    const incoming = excerptMessages(messages, 40);
    if (incoming.length > 0) {
      entry.messages = incoming;
    }
  } else if (user_message?.trim()) {
    entry.messages.push({ role: "user", content: user_message.trim() });
  }

  if (assistant_message?.trim()) {
    const trimmed = assistant_message.trim();
    const last = entry.messages[entry.messages.length - 1];
    if (!last || last.role !== "assistant" || last.content !== trimmed) {
      entry.messages.push({ role: "assistant", content: trimmed });
    }
  }
  entry.messages = excerptMessages(entry.messages, 40);

  entry.updated_at = now;
  entry.state_last = state;
  entry.turn_count = (entry.turn_count || 0) + 1;
  if (gravity_rating != null) entry.gravity_rating_last = gravity_rating;

  const failure =
    hints.current_failure_strategy ||
    detected_failure_strategy ||
    hints.failure_strategy ||
    null;
  const success = hints.current_success_strategy || hints.success_strategy || null;

  if (hints.current_resistance) entry.current_resistance = String(hints.current_resistance);
  if (hints.current_fear) entry.current_fear = String(hints.current_fear);
  if (Array.isArray(hints.current_avoidance_behaviours)) {
    entry.current_avoidance_behaviours = hints.current_avoidance_behaviours
      .map(String)
      .slice(0, 5);
  }
  if (failure) {
    entry.current_failure_strategy =
      typeof failure === "object" ? failure : { rule: String(failure) };
  }
  if (success) {
    entry.current_success_strategy =
      typeof success === "object" ? success : { behaviour: String(success) };
  }
  if (hints.active_bottleneck) entry.active_bottleneck = hints.active_bottleneck;
  if (hints.progression_stage) entry.progression_stage = hints.progression_stage;
  if (hints.removed_bottleneck) entry.removed_bottleneck = String(hints.removed_bottleneck);
  if (hints.session_summary) entry.session_summary = String(hints.session_summary);
  if (hints.coaching_insights) {
    const insights = Array.isArray(hints.coaching_insights)
      ? hints.coaching_insights
      : [hints.coaching_insights];
    entry.coaching_insights = [
      ...new Set([...(entry.coaching_insights || []), ...insights.map(String)]),
    ].slice(-12);
  }
  if (hints.emotional_themes) {
    const themes = Array.isArray(hints.emotional_themes)
      ? hints.emotional_themes
      : [hints.emotional_themes];
    entry.emotional_themes = [
      ...new Set([...(entry.emotional_themes || []), ...themes.map(String)]),
    ].slice(-10);
  }
  if (hints.coach_notes) {
    const notes = Array.isArray(hints.coach_notes) ? hints.coach_notes : [hints.coach_notes];
    entry.coach_notes = [...(entry.coach_notes || []), ...notes.map(String)].slice(-20);
  }
  if (hints.cl_estimate != null) entry.cl_estimate = hints.cl_estimate;
  if (hints.gravity_rating != null) {
    const g = Number(hints.gravity_rating);
    if (Number.isFinite(g)) entry.gravity_rating_last = g;
  }
  if (hints.milestone_focus || hints.milestone_update) {
    entry.milestone_focus = String(hints.milestone_focus || hints.milestone_update);
  }
  if (hints.green_rep_completed === true) entry.green_rep_completed = true;

  const assigned = normalizeGreenRep(green_rep || hints.green_rep_assigned);
  if (assigned?.name && !isPlausibleGreenRepName(assigned.name)) {
    // Do not store proof sentences as Green Rep names
  } else if (assigned && !opening_checkin) {
    entry.green_rep_assigned = assigned;
  }

  if (active_goal_context?.current_milestone) {
    entry.milestone_focus =
      entry.milestone_focus || active_goal_context.current_milestone;
  }

  if (entry.messages.length >= 2 && (entry.turn_count || 0) >= 2) {
    try {
      const { buildSessionSummaryFromCoachLog } = require("./stage1CoachSessionContinuity");
      const rolling = buildSessionSummaryFromCoachLog({
        messages: entry.messages,
        green_rep_last: entry.green_rep_assigned,
        progress_integration: null,
      });
      if (rolling) entry.session_summary = rolling;
    } catch {
      /* optional */
    }
  }

  let observations = [...memory.diagnostic_observations];
  const obsRaw =
    hints.diagnostic_observation ||
    hints.diagnostic_refinement ||
    hints.diagnostic_observations;
  if (obsRaw) {
    const items = Array.isArray(obsRaw) ? obsRaw : [obsRaw];
    for (const text of items) {
      if (!text) continue;
      observations.push({
        id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        at: now,
        session_id: session_id || null,
        observation: String(text),
        field: hints.diagnostic_field || null,
      });
    }
    observations = observations.slice(-MAX_OBSERVATIONS);
  }

  let progress_logs = [...memory.progress_logs];
  if (hints.progress_note || hints.green_rep_completed) {
    progress_logs.push({
      id: `prog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      at: now,
      type: hints.green_rep_completed ? "green_rep_completed" : "coaching_note",
      note: hints.progress_note
        ? String(hints.progress_note)
        : hints.green_rep_completed
          ? "Green rep marked completed"
          : null,
      session_id: session_id || null,
    });
    progress_logs = progress_logs.slice(-MAX_PROGRESS_LOGS);
  }

  const trimmedHistory = history.slice(-MAX_COACHING_HISTORY);
  const idx = trimmedHistory.findIndex((e) => e.id === entry.id);
  if (idx >= 0) trimmedHistory[idx] = entry;

  let nextMemory = {
    ...memory,
    coaching_sessions: trimmedHistory,
    coaching_history: trimmedHistory,
    diagnostic_observations: observations,
    progress_logs,
  };

  if (entry.current_fear || entry.current_resistance) {
    nextMemory = appendResistanceHistory(nextMemory, {
      at: now,
      session_id,
      fear: entry.current_fear,
      resistance: entry.current_resistance,
      avoidance: (entry.current_avoidance_behaviours || [])[0],
    });
  }

  if (entry.green_rep_assigned?.name && !opening_checkin) {
    nextMemory = appendGreenRepHistory(nextMemory, {
      at: now,
      session_id,
      name: entry.green_rep_assigned.name,
      win_condition: entry.green_rep_assigned.win_condition,
      completed: entry.green_rep_completed,
    });
  }

  if (hints.session_summary?.trim()) {
    nextMemory = {
      ...nextMemory,
      coaching_summaries: [
        ...nextMemory.coaching_summaries,
        {
          id: `sum-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          at: now,
          session_id,
          summary: String(hints.session_summary).trim(),
        },
      ].slice(-40),
    };
  }

  let nextMap = {
    ...map,
    coaching_memory: nextMemory,
  };

  if (map?.map_resistance_complete) {
    nextMap = _appendStructuralSnapshot(nextMap, {});
  }

  return nextMap;
};

const _finalizeStructuralSnapshot = (map, opts = {}) => {
  try {
    const { appendStructuralMapSnapshot } = require("./stage1StructuralMap");
    return appendStructuralMapSnapshot(map, opts);
  } catch {
    return map;
  }
};

/** Close a coaching_history entry when the in-app coach session ends. */
const finalizeCoachingMemorySession = (map, { domain, session_id, session_summary }) => {
  const memory = ensureCoachingMemory(map);
  const history = [...memory.coaching_sessions];
  const entry = findHistoryEntryBySession(history, session_id);
  if (!entry) return map;

  const now = new Date().toISOString();
  entry.ended_at = now;
  entry.updated_at = now;
  if (session_summary?.trim()) entry.session_summary = session_summary.trim();

  const idx = history.findIndex((e) => e.id === entry.id);
  if (idx >= 0) history[idx] = entry;

  let nextMemory = { ...memory, coaching_sessions: history, coaching_history: history };
  if (session_summary?.trim()) {
    nextMemory = {
      ...nextMemory,
      coaching_summaries: [
        ...nextMemory.coaching_summaries,
        {
          id: `sum-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          at: now,
          session_id,
          summary: session_summary.trim(),
        },
      ].slice(-40),
    };
  }
  return _finalizeStructuralSnapshot({ ...map, coaching_memory: nextMemory });
};

/** Mirror stage1 proof_logs into domain coaching_memory.proof_logs. */
const syncProofLogsToCoachingMemory = (map, stage1ProofLogs = []) => {
  const domain = map?.domain;
  if (!domain) return map;
  const memory = ensureCoachingMemory(map);
  const domainProofs = (Array.isArray(stage1ProofLogs) ? stage1ProofLogs : [])
    .filter((p) => p.domain === domain)
    .map((p) => ({
      id: p.id,
      action: p.action,
      type: p.type,
      green_rep_name: p.green_rep_name || null,
      created_at: p.created_at,
    }));

  const byId = new Map();
  for (const p of [...memory.proof_logs, ...domainProofs]) {
    if (p?.id) byId.set(p.id, p);
  }
  const merged = [...byId.values()]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, MAX_PROOF_IN_MEMORY);

  return {
    ...map,
    coaching_memory: { ...memory, proof_logs: merged },
  };
};

const appendProofToCoachingMemory = (map, proofEntry) => {
  if (!proofEntry) return map;
  return syncProofLogsToCoachingMemory(map, [proofEntry]);
};

const appendProgressLog = (map, entry) => {
  const memory = ensureCoachingMemory(map);
  const logs = [...memory.progress_logs, { ...entry, at: entry.at || new Date().toISOString() }];
  return {
    ...map,
    coaching_memory: {
      ...memory,
      progress_logs: logs.slice(-MAX_PROGRESS_LOGS),
    },
  };
};

const collectRecentPatternsFromMemory = (memory) => {
  const seen = new Set();
  const out = [];
  const add = (label) => {
    const t = String(label || "").trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };
  for (const r of memory.resistance_history || []) {
    add(r.fear);
    add(r.resistance);
    add(r.avoidance);
  }
  for (const s of (memory.coaching_sessions || []).slice(-4)) {
    add(s.current_fear);
    add(s.current_resistance);
    for (const a of s.current_avoidance_behaviours || []) add(a);
  }
  return out.slice(0, 6);
};

const listResistanceEvolution = (memory) => {
  const fears = [];
  for (const row of memory.resistance_history || []) {
    if (row.fear || row.resistance) {
      fears.push({
        at: row.at,
        fear: row.fear,
        resistance: row.resistance,
        session_id: row.session_id,
      });
    }
  }
  for (const sess of memory.coaching_sessions || memory.coaching_history || []) {
    if (sess.current_fear) {
      fears.push({
        at: sess.started_at || sess.updated_at,
        fear: sess.current_fear,
        resistance: sess.current_resistance || null,
        session_id: sess.session_id,
      });
    }
  }
  return fears.slice(-20);
};

const serializeCoachingMemoryForCoach = (map, stage1, domain) => {
  let withMemory = captureInitialDiagnosticIfNeeded(
    map,
    buildActiveGoalContext(map, domain),
    domain,
  );
  withMemory = syncProofLogsToCoachingMemory(withMemory, stage1?.proof_logs || []);
  const memory = ensureCoachingMemory(withMemory);

  const history = (memory.coaching_sessions || memory.coaching_history || [])
    .filter((s) => !domain || s.domain === domain)
    .slice(-12)
    .map((s) => ({
      id: s.id,
      session_id: s.session_id,
      started_at: s.started_at,
      ended_at: s.ended_at,
      in_progress: !s.ended_at,
      session_summary: s.session_summary,
      state: s.state_last,
      current_resistance: s.current_resistance,
      current_fear: s.current_fear,
      current_avoidance_behaviours: s.current_avoidance_behaviours || [],
      current_failure_strategy: s.current_failure_strategy,
      current_success_strategy: s.current_success_strategy,
      green_rep_assigned: s.green_rep_assigned,
      green_rep_completed: s.green_rep_completed,
      coaching_insights: s.coaching_insights || [],
      emotional_themes: s.emotional_themes || [],
      coach_notes: s.coach_notes || [],
      cl_estimate: s.cl_estimate,
      milestone_focus: s.milestone_focus,
      turn_count: s.turn_count,
      messages_excerpt: excerptMessages(s.messages, 10),
    }));

  const lastSession = history.length ? history[history.length - 1] : null;
  const openSession = [...history].reverse().find((s) => s.in_progress);

  return {
    initial_diagnostic: memory.initial_diagnostic,
    coaching_sessions: history,
    coaching_history: history,
    coaching_summaries: (memory.coaching_summaries || []).slice(-8),
    resistance_history: (memory.resistance_history || []).slice(-12),
    green_rep_history: (memory.green_rep_history || []).slice(-12),
    proof_logs: (memory.proof_logs || []).slice(0, 15),
    progress_logs: (memory.progress_logs || []).slice(-15),
    diagnostic_observations: (memory.diagnostic_observations || []).slice(-10),
    resistance_evolution: listResistanceEvolution(memory),
    recent_patterns: collectRecentPatternsFromMemory(memory),
    last_session_summary: lastSession?.session_summary || openSession?.session_summary || null,
    last_session_fear: lastSession?.current_fear || null,
    last_green_rep_assigned: lastSession?.green_rep_assigned || openSession?.green_rep_assigned || null,
    last_green_rep_completed: Boolean(
      lastSession?.green_rep_completed || openSession?.green_rep_completed,
    ),
  };
};

/** Backfill and persist initial_diagnostic for completed maps that pre-date coaching memory. */
const ensureInitialDiagnosticOnStage1 = (stage1, domain) => {
  const d = domain;
  const maps = [...(stage1.domain_maps || [])];
  const idx = maps.findIndex((m) => m.domain === d);
  if (idx < 0) return { stage1, changed: false };

  const updated = captureInitialDiagnosticIfNeeded(
    maps[idx],
    buildActiveGoalContext(maps[idx], d),
    d,
  );
  if (updated === maps[idx]) return { stage1, changed: false };

  maps[idx] = updated;
  return { stage1: { ...stage1, domain_maps: maps }, changed: true };
};

module.exports = {
  emptyCoachingMemory,
  ensureCoachingMemory,
  buildInitialDiagnosticSnapshot,
  captureInitialDiagnosticIfNeeded,
  ensureInitialDiagnosticOnStage1,
  recordCoachingMemoryTurn,
  finalizeCoachingMemorySession,
  syncProofLogsToCoachingMemory,
  appendProofToCoachingMemory,
  appendProgressLog,
  serializeCoachingMemoryForCoach,
  listResistanceEvolution,
};
