/**
 * Structured coach memory for every LLM turn — no scripted multi-step flows.
 * COACH_MEMORY_CONTEXT is the single source of truth sent to Python.
 */

const { DOMAIN_LABELS } = require("../../../constants/domains");
const { buildActiveGoalContext } = require("../../../helpers/stage1GoalContext");
const { listCoachHistory } = require("../persistence/history");
const { listProofLogs } = require("../../../helpers/stage1Proof");
const { serializeCoachingMemoryForCoach } = require("./coachingMemory");
const { resolveLastGreenRep } = require("../legacy/checkInFlow");
const { humanizePattern } = require("./naturalLanguage");
const { searchCoachSessions } = require("../persistence/vectorMemory");
const { gatherSessionContinuity } = require("./sessionContinuity");
const { buildActiveCoachingThread } = require("./memberContinuity");
const {
  resolvePersistentBarriers,
  annotateProofsForCoach,
} = require("../signals/barriers");
const { buildStructuralAwareness } = require("../../../helpers/stage1StructuralFramework");
const { buildSuggestedTraining } = require("../../../helpers/stage1TrainingRecommendation");

const pickFailureRule = (map) => {
  const fs = map?.failure_strategy;
  if (typeof fs === "string") return fs;
  return fs?.rule || fs?.title || null;
};

const pickSuccessRule = (map) => {
  const ss = map?.success_strategy;
  if (typeof ss === "string") return ss;
  return ss?.behaviour || ss?.success_rule || ss?.title || null;
};

const buildDiagnosticExcerpt = (map, memory) => {
  const report =
    map?.diagnostic_report ||
    memory?.initial_diagnostic?.report ||
    memory?.initial_diagnostic;
  if (typeof report === "string" && report.trim()) {
    return report.trim().slice(0, 600);
  }
  if (report && typeof report === "object") {
    const parts = [report.summary, report.failure_strategy, report.pattern]
      .filter(Boolean)
      .map(String);
    if (parts.length) return parts.join(" — ").slice(0, 600);
  }
  const fallback = [pickFailureRule(map), map?.flip_belief, map?.protector_rule]
    .filter(Boolean)
    .join(" — ");
  return fallback.trim().slice(0, 600) || null;
};

const recentResistancePatterns = (memory, map) => {
  const seen = new Set();
  const out = [];
  const add = (label) => {
    const h = humanizePattern(label);
    if (!h || seen.has(h.toLowerCase())) return;
    seen.add(h.toLowerCase());
    out.push(h);
  };
  for (const r of memory?.resistance_history || []) {
    add(r.resistance);
    add(r.fear);
    add(r.avoidance);
  }
  for (const s of (memory?.coaching_sessions || []).slice(-5)) {
    add(s.current_resistance);
    add(s.current_fear);
    for (const a of s.current_avoidance_behaviours || []) add(a);
  }
  for (const a of map?.top_3_avoidance_behaviours || []) add(a);
  return out.slice(0, 6);
};

const lastFiveSessions = (stage1, domain) =>
  listCoachHistory(stage1, { domain })
    .slice(0, 5)
    .map((s) => ({
      id: s.id,
      started_at: s.started_at,
      ended_at: s.ended_at,
      summary: s.preview || s.session_summary || null,
      green_rep: s.green_rep_last?.name || null,
      state: s.state_last,
    }));

const buildCoachingSummary = (memory, stage1, domain) => {
  const summaries = memory?.coaching_summaries || [];
  if (summaries.length) {
    return summaries[summaries.length - 1]?.summary || null;
  }
  const sessions = listCoachHistory(stage1, { domain }).slice(0, 3);
  const parts = sessions
    .map((s) => s.preview)
    .filter(Boolean)
    .slice(0, 2);
  return parts.length ? parts.join(" | ") : null;
};

/**
 * @param {object} opts
 * @param {object} opts.user
 * @param {object} opts.stage1
 * @param {object} opts.map
 * @param {string} opts.domain
 * @param {string} [opts.semanticQuery] — current user message for vector retrieval
 */
const buildCoachMemoryContext = async ({
  user,
  stage1,
  map,
  domain,
  semanticQuery = null,
}) => {
  const memory = serializeCoachingMemoryForCoach(map, stage1, domain);
  const activeGoal = buildActiveGoalContext(map, domain);
  const lastRep = resolveLastGreenRep(memory, map);
  const continuity = gatherSessionContinuity(stage1, map, domain, memory);
  const memberContinuity = buildActiveCoachingThread({
    stage1,
    map,
    domain,
    memory,
    continuity,
  });
  const barriers = resolvePersistentBarriers({ map, stage1, domain });
  const proofs = annotateProofsForCoach(
    listProofLogs(stage1, { domain, limit: 8 }).map((p) => ({
      action: p.action,
      type: p.type,
      at: p.created_at,
      green_rep_name: p.green_rep_name || null,
    })),
    barriers,
  );

  let semantic_matches = [];
  if (semanticQuery?.trim()) {
    try {
      semantic_matches = await searchCoachSessions({
        userId: user.id,
        email: user.email,
        domain,
        query: semanticQuery,
        topK: 3,
      });
    } catch (err) {
      console.warn("[buildCoachMemoryContext] vector search skipped:", err.message);
    }
  }

  const {
    inferFunnelStageFromContext,
    buildFunnelStatusLines,
    hasOutcomePending,
  } = require("../signals/evidence");
  const funnelStage = inferFunnelStageFromContext({
    userMessage: semanticQuery,
    memoryCtx: { recent_proofs: proofs },
  });
  const funnelStatus = buildFunnelStatusLines(funnelStage, {
    outcomePending: hasOutcomePending(semanticQuery),
  });

  return {
    member: {
      first_name: (user?.name || "Member").split(/\s+/)[0],
      name: user?.name?.trim() || "Member",
    },
    active_domain: domain,
    active_domain_label: DOMAIN_LABELS[domain] || domain,
    goal: activeGoal.goal_name || map?.goal_title || null,
    milestone: activeGoal.current_milestone || null,
    measurable_outcome: activeGoal.measurable_outcome || map?.desired_outcome || null,
    flip_belief: map?.flip_belief || null,
    flip_rule: map?.flip_rule || null,
    funnel_stage: funnelStage,
    funnel_status: funnelStatus,
    failure_strategy: pickFailureRule(map),
    success_strategy: pickSuccessRule(map),
    protector_rule: map?.protector_rule || null,
    core_fear: map?.core_fear || null,
    last_green_rep: lastRep?.name || memory?.last_green_rep_assigned?.name || null,
    last_green_rep_win: lastRep?.win_condition || null,
    recent_proofs: proofs,
    recent_resistance_patterns: recentResistancePatterns(memory, map),
    initial_diagnostic: memory.initial_diagnostic || null,
    diagnostic_report_excerpt: buildDiagnosticExcerpt(map, memory),
    coaching_directive_map_reference:
      "Before advice or rep assignment, link one plain-language line to failure_strategy, flip_belief, or active milestone from this context.",
    last_five_sessions: lastFiveSessions(stage1, domain),
    coaching_summary: buildCoachingSummary(memory, stage1, domain) || continuity.session_summary,
    last_ended_session: {
      ended_at: continuity.last_session_ended_at,
      summary: continuity.session_summary,
      narrative: continuity.last_session_narrative,
      detected_pattern: continuity.detected_pattern,
      devaluation_notes: continuity.devaluation_notes || [],
    },
    semantic_session_matches: semantic_matches,
    member_continuity: memberContinuity,
    member_barriers: barriers.no_trusted_person
      ? {
          no_trusted_person: true,
          instruction:
            "Member has stated they have no one to talk to — permanent for this domain until they say otherwise. Ignore proof logs that mention trusting someone; those are rep labels not social proof.",
        }
      : null,
    structural_awareness: buildStructuralAwareness(map),
    suggested_training:
      map?.suggested_training ||
      buildSuggestedTraining({ map, domain, user }) ||
      null,
    llm_instructions: memberContinuity.is_returning_member
      ? "RETURNING MEMBER — prior sessions, proof logs, and map resistance are in COACH_MEMORY_CONTEXT. " +
        "Continue the active thread in member_continuity.thread_summary. " +
        "Do NOT greet like a first meeting. Do NOT re-ask discovery questions already answered. " +
        "Do NOT re-explain the goal from scratch. Reference what you already know and ask what changed. " +
        "Use structural_awareness (failure strategy, protector, flip) — milestone-first coaching. " +
        "Every Green Rep must embody the discovered flip and advance the active milestone — real-world behavior, not mirror/voice/generic truth exercises. " +
        "When user asks what to do: one concrete external action (outreach, offer, follow-up) before internal exercises unless stabilization/overwhelm/no external action possible. " +
        "Obey COACH_CHECKIN.structural_framework.current_step (disrupt vs install). " +
        "Obey COACH_CHECKIN flags (coaching_mode, stop_discovery, assign_green_rep, conversation_signals, suggested_milestone_rep)."
      :         "Use structural_awareness every turn — lead with goal, milestone, and flip; resistance supports, never replaces, milestone action. " +
        "FLIP-EMBODIMENT REPS: every Green Rep physically practices the discovered flip toward the active milestone. " +
        "GREEN REP TEST: does this rep directly strengthen the flip and advance the milestone? If not, choose a different rep. " +
        "Green Reps must advance the active milestone (outbound/client/income moves for income goals — not private rate exercises). " +
        "When user asks what to do: give ONE concrete next action — prefer prospecting, outreach, offers, follow-up, proposals, conversations for business/income goals. " +
        "Avoid abstract exercises unless stabilization required, overwhelm is high, or no external action is possible. " +
        "No generic encouragement. Obey COACH_CHECKIN flags (coaching_mode, stop_discovery, assign_green_rep, conversation_signals, suggested_milestone_rep). " +
        "Product coaching voice is in Coach Brain Prompt.",
  };
};

module.exports = {
  buildCoachMemoryContext,
  recentResistancePatterns,
  lastFiveSessions,
};
