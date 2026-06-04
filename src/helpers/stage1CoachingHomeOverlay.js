/**
 * Coaching progress for Home / domain detail — separate from Map Resistance (25 Q&A) baseline.
 */

const { ensureCoachingMemory } = require("./stage1CoachingMemory");
const { isPlausibleGreenRepName } = require("./stage1CoachGreenRepUtils");
const { buildSessionSummaryFromCoachLog } = require("./stage1CoachSessionContinuity");
const { deriveCoachingWritebackFromProgress } = require("./stage1CoachWriteback");

const strategyRule = (block) => {
  if (!block) return null;
  if (typeof block === "string") return block.trim() || null;
  return block.rule?.trim() || block.behaviour?.trim() || null;
};

const normalizeRep = (rep) => {
  if (!rep) return null;
  if (typeof rep === "string") {
    const name = rep.trim();
    return isPlausibleGreenRepName(name) ? { name, win_condition: null, completed: false } : null;
  }
  const name = String(rep.name || "").trim();
  if (!isPlausibleGreenRepName(name)) return null;
  return {
    name,
    win_condition: rep.win_condition || rep.winCondition || null,
    completed: Boolean(rep.completed),
  };
};

/** Map coach_session_log row → coaching_memory session shape */
const logEntryToSessionShape = (log) => {
  if (!log) return null;
  const int = log.progress_integration;
  const answers = int?.answers || {};
  let failure = null;
  let success = null;
  if (answers.avoidance_rule) failure = { rule: String(answers.avoidance_rule).slice(0, 240) };
  else if (answers.active_core_wound) {
    failure = { rule: `Protecting wound: ${answers.active_core_wound}` };
  } else if (answers.devaluation_note) {
    failure = { rule: String(answers.devaluation_note).slice(0, 200) };
  }
  if (answers.leverage_note) success = { behaviour: String(answers.leverage_note).slice(0, 240) };
  else if (answers.meaning_reflection) {
    success = { behaviour: String(answers.meaning_reflection).slice(0, 200) };
  }

  return {
    id: log.id,
    session_id: log.id,
    domain: log.domain,
    started_at: log.started_at,
    updated_at: log.updated_at,
    ended_at: log.ended_at || null,
    session_summary: buildSessionSummaryFromCoachLog(log),
    current_failure_strategy: failure,
    current_success_strategy: success,
    green_rep_assigned: normalizeRep(log.green_rep_last),
    green_rep_completed: Boolean(int?.signals?.repCompleted),
    turn_count: log.turn_count || 0,
    messages: log.messages || [],
    progress_integration: int || null,
  };
};

const mergeCoachingSessions = (memorySessions, coachSessionLog, domain) => {
  const byKey = new Map();
  for (const s of memorySessions || []) {
    const key = s.session_id || s.id;
    if (key) byKey.set(key, s);
  }
  for (const log of coachSessionLog || []) {
    if (log.domain !== domain) continue;
    const key = log.id;
    if (!key) continue;
    const shaped = logEntryToSessionShape(log);
    if (!shaped) continue;
    const existing = byKey.get(key);
    if (!existing || (shaped.turn_count || 0) >= (existing.turn_count || 0)) {
      byKey.set(key, { ...existing, ...shaped });
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      new Date(a.started_at || 0).getTime() - new Date(b.started_at || 0).getTime(),
  );
};

const parseDiagnosticObservation = (text) => {
  const t = String(text || "");
  const pick = (re) => {
    const m = t.match(re);
    return m ? m[1].trim() : null;
  };
  return {
    wound: pick(/Core wound active:\s*([^|]+)/i),
    avoidance: pick(/Avoidance rule:\s*([^|]+)/i),
    leverage: pick(/Flip leverage:\s*([^|]+)/i),
    regression: pick(/Regression noted:\s*([^|]+)/i),
  };
};

const isVagueNote = (text) =>
  /^(yes|yeah|idk|i\s+don'?t\s+know|what\??|ok|okay|sure|mm+|hm+)\s*$/i.test(
    String(text || "").trim(),
  );

/** Resolve live failure/success from sessions, diagnostics, and progress notes */
const resolveLiveStrategies = (memory, sessions, active) => {
  const observations = (memory.diagnostic_observations || [])
    .slice()
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));

  let failureRule =
    strategyRule(active?.current_failure_strategy) ||
    active?.current_fear ||
    active?.current_resistance ||
    null;
  let successRule = strategyRule(active?.current_success_strategy);
  let coreWound = null;
  let avoidanceRule = null;
  let flipLeverage = null;

  for (let i = observations.length - 1; i >= 0; i -= 1) {
    const parsed = parseDiagnosticObservation(observations[i].observation);
    if (!coreWound && parsed.wound) coreWound = parsed.wound;
    if (!avoidanceRule && parsed.avoidance) avoidanceRule = parsed.avoidance;
    if (!flipLeverage && parsed.leverage) flipLeverage = parsed.leverage;
    if (!failureRule && parsed.avoidance) failureRule = parsed.avoidance;
    if (!failureRule && parsed.wound) failureRule = `Protecting wound: ${parsed.wound}`;
    if (!successRule && parsed.leverage) successRule = parsed.leverage;
  }

  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    const s = sessions[i];
    const answers = s.progress_integration?.answers || {};
    if (!failureRule) {
      failureRule =
        strategyRule(s.current_failure_strategy) ||
        (answers.avoidance_rule ? String(answers.avoidance_rule) : null) ||
        (answers.active_core_wound ? `Protecting wound: ${answers.active_core_wound}` : null) ||
        (answers.devaluation_note ? String(answers.devaluation_note).slice(0, 200) : null);
    }
    if (!successRule) {
      successRule =
        strategyRule(s.current_success_strategy) ||
        (answers.leverage_note ? String(answers.leverage_note) : null) ||
        (answers.meaning_reflection ? String(answers.meaning_reflection).slice(0, 200) : null);
    }
    if (!coreWound && answers.active_core_wound) coreWound = answers.active_core_wound;
    if (!avoidanceRule && answers.avoidance_rule) avoidanceRule = String(answers.avoidance_rule);
    if (!flipLeverage && answers.leverage_note) flipLeverage = String(answers.leverage_note);
    if (failureRule && successRule && coreWound) break;
  }

  const progressLogs = memory.progress_logs || [];
  for (let i = progressLogs.length - 1; i >= 0; i -= 1) {
    const note = String(progressLogs[i]?.note || "").trim();
    if (!note || isVagueNote(note)) continue;
    if (
      !failureRule &&
      /\b(earn|less|not enough|grind|24|devaluation|small|won'?t count)\b/i.test(note)
    ) {
      failureRule = note.slice(0, 240);
    }
    if (
      !successRule &&
      /\b(when i|kids|family|must|need|get alot|leverage|flip|possible)\b/i.test(note)
    ) {
      successRule = note.slice(0, 240);
    }
  }

  if (coreWound && failureRule && !failureRule.includes(coreWound)) {
    failureRule = `${failureRule} (wound: ${coreWound})`;
  }

  return {
    failureRule,
    successRule,
    coreWound,
    avoidanceRule,
    flipLeverage,
    behaviours: active?.current_avoidance_behaviours || [],
  };
};

const pickLatestSession = (sessions) => {
  const list = Array.isArray(sessions) ? sessions : [];
  if (!list.length) return { latest: null, open: null };
  let open = null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!list[i].ended_at) {
      open = list[i];
      break;
    }
  }
  return { latest: list[list.length - 1], open };
};

const buildCoachingHomeOverlay = (map, opts = {}) => {
  const domain = map?.domain;
  const memory = ensureCoachingMemory(map);
  const coachSessionLog = opts.coach_session_log || [];
  const sessions = mergeCoachingSessions(
    memory.coaching_sessions || memory.coaching_history || [],
    coachSessionLog,
    domain,
  );
  const { latest, open } = pickLatestSession(sessions);
  const active = open || latest;

  const stage1Proofs = (opts.proof_logs || []).filter((p) => p?.domain === domain);
  const memoryProofs = memory.proof_logs || [];
  const proofIds = new Set();
  const proof = [];
  for (const p of [...stage1Proofs, ...memoryProofs]) {
    const id = p?.id || `${p?.created_at}-${p?.action}`;
    if (proofIds.has(id)) continue;
    proofIds.add(id);
    if (p?.action) {
      proof.push({
        id: p.id || null,
        action: String(p.action).slice(0, 200),
        at: p.created_at || p.at || null,
        green_rep_name: p.green_rep_name || null,
      });
    }
  }
  for (const s of sessions) {
    const note =
      s.progress_integration?.answers?.acknowledge_note ||
      (Array.isArray(s.messages)
        ? s.messages
            .filter((m) => m.role === "user")
            .map((m) => m.content)
            .find((t) => looksLikeProofText(t))
        : null);
    if (note && looksLikeProofText(note)) {
      const id = `sess-${s.session_id}-proof`;
      if (!proofIds.has(id)) {
        proofIds.add(id);
        proof.push({ id, action: String(note).slice(0, 200), at: s.updated_at, green_rep_name: null });
      }
    }
  }
  proof.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));

  const greenRepHistory = (memory.green_rep_history || []).filter((g) =>
    isPlausibleGreenRepName(g?.name),
  );
  const greenReps = [];
  const repKeys = new Set();
  for (const g of greenRepHistory) {
    const key = g.name.toLowerCase();
    if (repKeys.has(key)) continue;
    repKeys.add(key);
    greenReps.push({
      name: g.name,
      win_condition: g.win_condition || null,
      completed: Boolean(g.completed),
      at: g.at || null,
    });
  }
  for (const s of sessions) {
    const rep = normalizeRep(s.green_rep_assigned);
    if (rep && !repKeys.has(rep.name.toLowerCase())) {
      repKeys.add(rep.name.toLowerCase());
      greenReps.push({
        ...rep,
        at: s.updated_at || s.started_at,
      });
    }
  }

  const observations = (memory.diagnostic_observations || []).slice(-8).map((o) => ({
    at: o.at,
    observation: o.observation,
    session_id: o.session_id || null,
  }));

  const live = resolveLiveStrategies(memory, sessions, active);
  const failureRule = live.failureRule;
  const successRule = live.successRule;

  const progressLogs = memory.progress_logs || [];
  const sessionsEnded = sessions.filter((s) => s.ended_at).length;
  const hasActivity =
    sessions.some((s) => (s.turn_count || 0) > 0) ||
    proof.length > 0 ||
    progressLogs.length > 0 ||
    observations.length > 0 ||
    greenReps.length > 0;

  return {
    source: "coaching_sessions",
    baseline_locked: Boolean(memory.initial_diagnostic?.captured_at),
    baseline_label: "Map Resistance (25 Q&A)",
    has_coaching_activity: hasActivity,
    sessions_total: sessions.length,
    sessions_ended: sessionsEnded,
    open_session: Boolean(open),
    last_session_at: active?.updated_at || active?.started_at || null,
    last_session_summary:
      active?.session_summary ||
      (memory.coaching_summaries || []).slice(-1)[0]?.summary ||
      null,
    failure_strategy: {
      rule: failureRule,
      behaviours: live.behaviours,
      core_wound: live.coreWound,
      avoidance_rule: live.avoidanceRule,
    },
    success_strategy: {
      behaviour: successRule,
      belief: live.coreWound ? `Wound to loosen: ${live.coreWound}` : null,
      success_rule: live.flipLeverage,
      flip_leverage: live.flipLeverage,
    },
    green_reps: greenReps,
    proof,
    progress_tracking: {
      sessions_total: sessions.length,
      sessions_ended: sessionsEnded,
      progress_notes_count: progressLogs.length,
      proof_logged_count: proof.length,
      green_reps_completed: greenReps.filter((g) => g.completed).length,
      recent_progress_notes: progressLogs.slice(-5).map((p) => ({
        at: p.at,
        type: p.type,
        note: p.note,
      })),
      diagnostic_observations: observations,
    },
    live_failure_strategy: failureRule,
    live_success_strategy: successRule,
    live_green_rep: greenReps.length ? greenReps[greenReps.length - 1] : null,
    green_reps_assigned_count: greenReps.length,
    green_reps_completed_count: greenReps.filter((g) => g.completed).length,
    proof_logged_count: proof.length,
    recent_proof: proof.slice(0, 8),
    progress_notes_count: progressLogs.length,
    diagnostic_observations: observations,
    current_fear: active?.current_fear || live.coreWound || null,
    current_resistance: active?.current_resistance || live.avoidanceRule || null,
    core_wound: live.coreWound,
    avoidance_rule: live.avoidanceRule,
    flip_leverage: live.flipLeverage,
  };
};

function looksLikeProofText(text) {
  const t = String(text || "");
  return (
    /\$|\d+\s*(?:\/hr|hr|hour)|generated|earned|competed|outreach|reached out/i.test(t) ||
    /\b(i did it|completed)\b/i.test(t)
  );
}

const applyCoachingToProgressMetrics = (progress_metrics, overlay) => {
  const pm = { ...(progress_metrics || {}) };
  if (!overlay?.has_coaching_activity) return pm;

  const proofCount = Math.max(
    Number(pm.proof_logged_count ?? 0),
    Number(overlay.proof_logged_count ?? overlay.proof?.length ?? 0),
  );
  const sessionBoost = Math.min(15, (overlay.sessions_ended || 0) * 3);
  const repRate = Number(pm.rep_completion_rate ?? 0);
  const ratePct = repRate <= 1 ? repRate * 100 : repRate;
  const blended = Math.min(100, Math.round(ratePct + sessionBoost));

  return {
    ...pm,
    proof_logged_count: proofCount,
    coaching_sessions_total: overlay.sessions_total,
    coaching_sessions_ended: overlay.sessions_ended,
    coaching_open_session: overlay.open_session,
    rep_completion_rate: blended / 100,
  };
};

module.exports = {
  buildCoachingHomeOverlay,
  applyCoachingToProgressMetrics,
  mergeCoachingSessions,
  resolveLiveStrategies,
  parseDiagnosticObservation,
  deriveCoachingWritebackFromProgress,
};
