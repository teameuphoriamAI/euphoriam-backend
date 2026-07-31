const { DOMAIN_LABELS } = require("../../../constants/domains");
const { buildActiveGoalContext } = require("../../../helpers/stage1GoalContext");
const { listCoachHistory } = require("../persistence/history");
const { listProofLogs } = require("../../../helpers/stage1Proof");
const { getAllUserSessions } = require("../../../helpers/euphoriamChatbot");
const { serializeCoachingMemoryForCoach } = require("./coachingMemory");
const { buildResistanceEvolutionNarrative } = require("./naturalLanguage");

const MAX_TRANSCRIPT_MESSAGES = 16;
const MAX_COACH_AI_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 600;
const MAX_PROOF_ACTION_CHARS = 400;
const MAX_USER_SESSIONS_1ON1 = 3;

const excerptTranscript = (transcript, maxMessages = MAX_TRANSCRIPT_MESSAGES) => {
  if (!Array.isArray(transcript)) return [];
  return transcript.slice(-maxMessages).map((m) => ({
    role: m?.role,
    content: String(m?.content || "").slice(0, MAX_MESSAGE_CHARS),
  }));
};

/** Cap live coach thread sent to Python — full history stays in DB. */
const excerptCoachMessages = (messages, maxMessages = MAX_COACH_AI_MESSAGES) =>
  excerptTranscript(messages, maxMessages);

const normalizeCoachMessage = (message) => {
  if (!message?.role || message.content == null) return null;
  const role = String(message.role).trim();
  if (role !== "user" && role !== "assistant") return null;
  const content = String(message.content).trim();
  if (!content) return null;
  return { role, content };
};

const normalizeCoachTranscript = (messages = []) =>
  (Array.isArray(messages) ? messages : [])
    .map(normalizeCoachMessage)
    .filter(Boolean);

/** Prefer the longer transcript; fall back to stored open-session history when client sends none. */
const reconcileCoachTranscript = (clientMessages = [], openSession = null, userMessage = "") => {
  const client = normalizeCoachTranscript(clientMessages);
  const stored = normalizeCoachTranscript(openSession?.messages);
  const trimmedUser = String(userMessage || "").trim();

  let base =
    client.length >= stored.length && client.length > 0
      ? client
      : stored.length > 0
        ? stored
        : client;

  if (!trimmedUser) return base;

  const last = base[base.length - 1];
  if (last?.role === "user" && last.content === trimmedUser) return base;
  return [...base, { role: "user", content: trimmedUser }];
};

/** Strip bloated fields duplicated in USER_COACH_CONTEXT / COACH_MEMORY_CONTEXT. */
const slimDomainMapForCoach = (map) => {
  if (!map || typeof map !== "object") return {};
  const {
    coaching_memory: _coachingMemory,
    map_resistance_transcript: _transcript,
    structural_map: _structuralMap,
    structural_map_history: _structuralHistory,
    ...rest
  } = map;
  return rest;
};

const trimProofAction = (action) => String(action || "").slice(0, MAX_PROOF_ACTION_CHARS);

const serializeUserSessions = (sessions) =>
  (sessions || []).slice(0, MAX_USER_SESSIONS_1ON1).map((s) => ({
    id: s.id,
    session_date: s.sessionDate || s.createdAt,
    summary: s.summery || null,
    transcript_excerpt: excerptTranscript(s.transcript, 12),
    metadata:
      s.metadata && typeof s.metadata === "object" && Object.keys(s.metadata).length
        ? s.metadata
        : null,
  }));

const serializeCoachHistory = (stage1, domain) =>
  listCoachHistory(stage1, { domain })
    .slice(0, 6)
    .map((sess) => ({
      id: sess.id,
      started_at: sess.started_at,
      ended_at: sess.ended_at,
      in_progress: sess.in_progress,
      state: sess.state_last,
      preview: sess.preview,
      green_rep_last: sess.green_rep_last?.name || null,
      messages_excerpt: excerptTranscript(sess.messages, 10),
    }));

/** Live map resistance fields (may evolve); original 25Q snapshot is in coaching_memory.initial_diagnostic. */
const serializeMapResistance = (map) => {
  if (!map) return null;
  const failure = map.failure_strategy;
  const success = map.success_strategy;
  return {
    completed_at: map.map_resistance_completed_at || null,
    signature_id: map.signature_id || null,
    EO: map.EO || null,
    lack_channel: map.lack_channel || null,
    avoid_type: map.avoid_type || null,
    orbit_pattern: map.orbit_pattern || null,
    protector_rule: map.protector_rule || null,
    core_fear: map.core_fear || null,
    contradiction_statement: map.contradiction_statement || null,
    contradiction_rate: map.contradiction_rate || null,
    flip_belief: map.flip_belief || null,
    flip_rule: map.flip_rule || null,
    failure_strategy: failure || null,
    success_strategy: success || null,
    top_3_avoidance_behaviours: map.top_3_avoidance_behaviours || [],
    daily_rep: map.daily_rep || null,
    win_condition: map.win_condition || null,
    transcript_excerpt: excerptTranscript(map.map_resistance_transcript, 20),
    note: "For the frozen 25Q diagnostic snapshot, use coaching_memory.initial_diagnostic — do not treat this block as the original diagnostic if coaching has refined understanding.",
  };
};

const serializeOtherDomains = (stage1, currentDomain) =>
  (stage1.domain_maps || [])
    .filter(
      (m) =>
        m.domain !== currentDomain &&
        (m.goals_complete || m.goal_title?.trim() || m.map_resistance_complete),
    )
    .map((m) => ({
      domain: m.domain,
      domain_label: DOMAIN_LABELS[m.domain] || m.domain,
      status: m.status,
      goal_title: m.goal_title,
      desired_outcome: m.desired_outcome,
      map_resistance_complete: Boolean(m.map_resistance_complete),
    }));

/**
 * Full user context for Stage 1 daily coach — name, goals, map resistance,
 * proof logs, in-app coach history, and 1:1 UserSession records.
 */
const buildCoachUserContext = async (user, stage1, map, domain) => {
  const userSessions = await getAllUserSessions(user.id, user.email);

  const proofLogs = listProofLogs(stage1, { domain, limit: 12 });
  const coachHistory = serializeCoachHistory(stage1, domain);
  const coaching_memory = serializeCoachingMemoryForCoach(map, stage1, domain);

  const edgeNarrative = buildResistanceEvolutionNarrative(
    coaching_memory.resistance_evolution || [],
  );

  return {
    user_profile: {
      id: user.id,
      name: user.name?.trim() || "Member",
      email: user.email || null,
      first_name: (user.name?.trim() || "Member").split(/\s+/)[0],
    },
    active_domain: domain,
    active_domain_label: DOMAIN_LABELS[domain] || domain,
    active_goal_context: buildActiveGoalContext(map, domain),
    map_resistance: serializeMapResistance(map),
    coaching_memory,
    current_edge_narrative: edgeNarrative,
    coaching_instructions:
      "Obey COACH_CHECKIN flags. Product coaching voice is in Coach Brain Prompt.",
    progress_metrics: map.progress_metrics || null,
    recent_proof_logs: proofLogs.map((p) => ({
      action: trimProofAction(p.action),
      type: p.type,
      created_at: p.created_at,
      green_rep_name: p.green_rep_name || null,
    })),
    stage1_coach_sessions: coachHistory,
    user_sessions_1on1: serializeUserSessions(userSessions),
    other_domain_goals: serializeOtherDomains(stage1, domain),
    coach_load_order: [
      "active_goal_context (current goal + milestone)",
      "coaching_memory.initial_diagnostic (frozen 25Q Map Resistance — never overwrite)",
      "coaching_memory.coaching_history (prior sessions)",
      "coaching_memory.proof_logs",
      "coaching_memory.progress_logs",
      "coaching_memory.diagnostic_observations",
      "recent_proof_logs",
      "stage1_coach_sessions",
    ],
  };
};

module.exports = {
  buildCoachUserContext,
  excerptTranscript,
  excerptCoachMessages,
  reconcileCoachTranscript,
  slimDomainMapForCoach,
  trimProofAction,
  serializeUserSessions,
  serializeCoachHistory,
  serializeMapResistance,
};
