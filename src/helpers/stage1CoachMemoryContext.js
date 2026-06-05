/**
 * Structured coach memory for every LLM turn — no scripted multi-step flows.
 * COACH_MEMORY_CONTEXT is the single source of truth sent to Python.
 */

const { DOMAIN_LABELS } = require("../constants/domains");
const { buildActiveGoalContext } = require("./stage1GoalContext");
const { listCoachHistory } = require("./stage1CoachHistory");
const { listProofLogs } = require("./stage1Proof");
const { serializeCoachingMemoryForCoach } = require("./stage1CoachingMemory");
const { resolveLastGreenRep } = require("./stage1CoachCheckInFlow");
const { humanizePattern } = require("./stage1CoachNaturalLanguage");
const { searchCoachSessions } = require("./stage1CoachVectorMemory");
const { gatherSessionContinuity } = require("./stage1CoachSessionContinuity");

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
  const proofs = listProofLogs(stage1, { domain, limit: 8 }).map((p) => ({
    action: p.action,
    type: p.type,
    at: p.created_at,
    green_rep_name: p.green_rep_name || null,
  }));

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
    failure_strategy: pickFailureRule(map),
    success_strategy: pickSuccessRule(map),
    protector_rule: map?.protector_rule || null,
    core_fear: map?.core_fear || null,
    last_green_rep: lastRep?.name || memory?.last_green_rep_assigned?.name || null,
    last_green_rep_win: lastRep?.win_condition || null,
    recent_proofs: proofs,
    recent_resistance_patterns: recentResistancePatterns(memory, map),
    initial_diagnostic: memory.initial_diagnostic || null,
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
    llm_instructions:
      "Obey COACH_CHECKIN.coaching_mode and stop_discovery from Node — not generic curiosity ratios. " +
      "execute mode: name pattern, cost, failure/success strategy, assign ONE Green Rep with proof — NO reflective questions. " +
      "Do NOT start turns with Hey {name}. Celebrate proof only when reported in THIS message.",
  };
};

module.exports = {
  buildCoachMemoryContext,
  recentResistancePatterns,
  lastFiveSessions,
};
