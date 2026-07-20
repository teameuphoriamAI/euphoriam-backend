const { DOMAIN_LABELS } = require("../../../constants/domains");

const SESSION_GAP_MS = 4 * 60 * 60 * 1000;

const newSessionId = () =>
  `coach-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const isSessionOpen = (session) => Boolean(session && !session.ended_at);

const findOpenSessionForDomain = (sessions, domain) => {
  for (let i = sessions.length - 1; i >= 0; i -= 1) {
    const s = sessions[i];
    if (s.domain === domain && isSessionOpen(s)) return s;
  }
  return null;
};

/**
 * Append a coach check-in to structured session log (grouped by domain while session is open).
 */
const recordCoachCheckin = (stage1, payload) => {
  const {
    domain,
    state,
    messages = [],
    user_message,
    assistant_message,
    green_rep,
    gravity_rating,
  } = payload;

  const sessions = Array.isArray(stage1.coach_session_log)
    ? [...stage1.coach_session_log]
    : [];
  const now = new Date().toISOString();

  let current = findOpenSessionForDomain(sessions, domain);

  if (!current) {
    current = {
      id: newSessionId(),
      domain,
      phase: payload.phase || "check_in",
      state_at_start: state,
      state_last: state,
      started_at: now,
      updated_at: now,
      ended_at: null,
      gravity_rating_last: gravity_rating ?? null,
      messages: [],
      turn_count: 0,
      opening_checkin: Boolean(payload.opening_checkin),
      check_in_progress: payload.check_in_progress || null,
    };
    sessions.push(current);
  }

  if (payload.phase) current.phase = payload.phase;
  if (payload.opening_checkin) current.opening_checkin = true;
  if (payload.check_in_progress) {
    current.check_in_progress = payload.check_in_progress;
  }
  if (payload.progress_integration) {
    current.progress_integration = payload.progress_integration;
  }
  if (payload.proof_cycle) {
    current.proof_cycle = payload.proof_cycle;
  }
  if (payload.first_session_flow) {
    current.first_session_flow = {
      ...(current.first_session_flow || {}),
      ...payload.first_session_flow,
    };
  }
  if (payload.investigation_flow) {
    current.investigation_flow = {
      ...(current.investigation_flow || {}),
      ...payload.investigation_flow,
    };
  }
  if (payload.structural_coaching_flow) {
    current.structural_coaching_flow = {
      ...(current.structural_coaching_flow || {}),
      ...payload.structural_coaching_flow,
    };
  }
  if (payload.activation_moment_flow) {
    current.activation_moment_flow = {
      ...(current.activation_moment_flow || {}),
      ...payload.activation_moment_flow,
    };
  }
  if (payload.session_intake && typeof payload.session_intake === "object") {
    current.session_intake = {
      ...(current.session_intake || {}),
      ...payload.session_intake,
    };
  }

  if (Array.isArray(messages) && messages.length > 0) {
    const incoming = messages
      .filter((m) => m?.role && m?.content)
      .map((m) => ({ role: m.role, content: String(m.content) }));
    if (incoming.length > 0) {
      current.messages = incoming;
    }
  } else {
    if (user_message?.trim()) {
      current.messages.push({ role: "user", content: user_message.trim() });
    }
  }

  if (assistant_message?.trim()) {
    const trimmed = assistant_message.trim();
    const last = current.messages[current.messages.length - 1];
    if (!last || last.role !== "assistant" || last.content !== trimmed) {
      current.messages.push({ role: "assistant", content: trimmed });
    }
  }

  current.updated_at = now;
  current.state_last = state;
  current.turn_count = (current.turn_count || 0) + 1;
  if (green_rep) current.green_rep_last = green_rep;
  if (gravity_rating != null) current.gravity_rating_last = gravity_rating;

  return {
    stage1: {
      ...stage1,
      coach_session_log: sessions.slice(-40),
    },
    session_id: current.id,
  };
};

/** Build sessions list from coach_session_log + legacy coach_sessions turns. */
const listCoachHistory = (stage1, { domain = null } = {}) => {
  let sessions = Array.isArray(stage1.coach_session_log)
    ? [...stage1.coach_session_log]
    : [];

  if (!sessions.length && Array.isArray(stage1.coach_sessions)) {
    sessions = migrateLegacyCoachSessions(stage1.coach_sessions);
  }

  let filtered = sessions;
  if (domain) {
    filtered = sessions.filter((s) => s.domain === domain);
  }

  return filtered
    .slice()
    .reverse()
    .map((s) => {
      const msgs = Array.isArray(s.messages) ? s.messages : [];
      const firstUser = msgs.find((m) => m.role === "user");
      const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
      return {
        id: s.id,
        domain: s.domain,
        domain_label: DOMAIN_LABELS[s.domain] || s.domain,
        state_at_start: s.state_at_start,
        state_last: s.state_last,
        started_at: s.started_at,
        updated_at: s.updated_at,
        ended_at: s.ended_at || null,
        in_progress: !s.ended_at,
        turn_count: s.turn_count || msgs.filter((m) => m.role === "user").length,
        message_count: msgs.length,
        messages: msgs,
        preview:
          firstUser?.content?.slice(0, 120) ||
          lastAssistant?.content?.slice(0, 120) ||
          "",
        green_rep_last: s.green_rep_last || null,
      };
    });
};

const migrateLegacyCoachSessions = (turns) => {
  const byDayDomain = new Map();
  for (const t of turns) {
    if (!t?.at || !t?.domain) continue;
    const day = t.at.slice(0, 10);
    const key = `${t.domain}:${day}`;
    if (!byDayDomain.has(key)) {
      byDayDomain.set(key, {
        id: newSessionId(),
        domain: t.domain,
        state_at_start: t.state || "clear",
        state_last: t.state || "clear",
        started_at: t.at,
        updated_at: t.at,
        messages: [],
        turn_count: 0,
      });
    }
    const sess = byDayDomain.get(key);
    if (t.user_message) {
      sess.messages.push({ role: "user", content: String(t.user_message) });
    }
    if (t.assistant_message) {
      sess.messages.push({
        role: "assistant",
        content: String(t.assistant_message),
      });
    }
    sess.updated_at = t.at;
    sess.state_last = t.state || sess.state_last;
    sess.turn_count += 1;
    if (t.green_rep) sess.green_rep_last = t.green_rep;
  }
  return [...byDayDomain.values()].sort(
    (a, b) => new Date(a.started_at) - new Date(b.started_at),
  );
};

/** Resume messages from the latest open session for a domain. */
const getResumableCoachMessages = (stage1, domain) => {
  const sessions = Array.isArray(stage1.coach_session_log)
    ? stage1.coach_session_log
    : [];
  const open = findOpenSessionForDomain(sessions, domain);
  if (!open) return [];
  return Array.isArray(open.messages) ? open.messages : [];
};

/** Mark the open session for a domain as ended. */
const endCoachSession = (stage1, domain) => {
  const sessions = Array.isArray(stage1.coach_session_log)
    ? [...stage1.coach_session_log]
    : [];
  const open = findOpenSessionForDomain(sessions, domain);
  if (!open) {
    return { stage1, ended: false, session_id: null };
  }
  const now = new Date().toISOString();
  open.ended_at = now;
  open.updated_at = now;
  return {
    stage1: {
      ...stage1,
      coach_session_log: sessions,
    },
    ended: true,
    session_id: open.id,
  };
};

/** Open session metadata for coach UI. */
const getOpenCoachSession = (stage1, domain) => {
  const sessions = Array.isArray(stage1.coach_session_log) ? stage1.coach_session_log : [];
  const open = findOpenSessionForDomain(sessions, domain);
  if (!open) return null;
  const msgs = Array.isArray(open.messages) ? open.messages : [];
  const hasUser = msgs.some((m) => m.role === "user" && String(m.content || "").trim());
  const {
    getSessionPhaseFromProgress,
    isCheckInActive,
    inferCheckInProgressFromMessages,
    normalizeProgress,
  } = require("../legacy/checkInFlow");
  let progress = open.check_in_progress
    ? normalizeProgress(open.check_in_progress)
    : null;
  if (!progress && msgs.length) {
    progress = inferCheckInProgressFromMessages(msgs);
  }
  const {
    isProgressIntegrationActive,
    isPostProofDevaluationActive,
    isWoundFlipActive,
  } = require("../utils/progress");
  const devaluationActive = isPostProofDevaluationActive(open.progress_integration);
  const woundFlipActive = isWoundFlipActive(open.progress_integration);
  const integration = open.progress_integration;
  const proofCycle = open.proof_cycle;
  const progressActive =
    isProgressIntegrationActive(open.progress_integration) ||
    devaluationActive ||
    woundFlipActive ||
    proofCycle?.step === "integration_question";
  const checkInActive =
    !progressActive && (progress ? isCheckInActive(progress) : !hasUser);
  const woundStep = integration?.step;
  const coachState =
    open.coach_state_last ||
    (woundFlipActive && woundStep === "flip_leverage"
      ? "flip_install"
      : woundFlipActive
        ? "wound_edge"
        : devaluationActive
          ? "post_proof_devaluation"
          : progressActive
            ? "progress"
            : checkInActive
              ? "check_in"
              : "coaching");
  const phase = woundFlipActive
    ? woundStep === "flip_leverage"
      ? "flip_leverage"
      : "wound_edge"
    : devaluationActive
      ? "post_proof_devaluation"
      : progressActive
        ? "proof_integration"
        : checkInActive
          ? "check_in"
          : open.phase || (hasUser ? "coaching" : "check_in");

  const certPhases = new Set([
    "intention",
    "emotional_checkin",
    "explore",
    "resistance_probe",
    "integration",
  ]);
  const certSessionPhase = certPhases.has(String(open.phase || ""))
    ? open.phase
    : null;

  return {
    id: open.id,
    phase,
    cert_session_phase: certSessionPhase,
    session_intake:
      open.session_intake && typeof open.session_intake === "object"
        ? { ...open.session_intake }
        : null,
    started_at: open.started_at || null,
    updated_at: open.updated_at || null,
    awaiting_user:
      (checkInActive || progressActive) && msgs.some((m) => m.role === "assistant"),
    check_in_progress: progress || null,
    progress_integration: open.progress_integration || null,
    proof_cycle: open.proof_cycle || null,
    awaiting_proof_log: proofCycle?.step === "awaiting_proof_log",
    coach_state: coachState,
    messages: msgs,
  };
};

module.exports = {
  recordCoachCheckin,
  listCoachHistory,
  getResumableCoachMessages,
  getOpenCoachSession,
  endCoachSession,
  findOpenSessionForDomain,
  migrateLegacyCoachSessions,
  SESSION_GAP_MS,
};
