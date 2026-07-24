/**
 * First coach session — map-aware opening and investigate → follow-up flow.
 */

const { resolveFailureStrategyForMap } = require("../../../helpers/stage1MapStructure");
const { detectStruggleSetback } = require("./discovery");
const { isSetbackOrGapReport } = require("./setback");
const { formatOutcomeDirective } = require("./directive");

const INVESTIGATE_MARKER = "Before I assign anything";
const GAP_TRACKING_MARKER = "gap we're tracking";

const pickFailureLabel = (map) => {
  const fs = resolveFailureStrategyForMap(map);
  if (typeof fs === "string") return fs.trim();
  return (fs?.rule || fs?.title || map?.protector_rule || null)?.trim() || null;
};

const pickMapHook = (map) => {
  const contradiction = map?.contradiction_statement?.trim();
  if (contradiction && contradiction.length > 20) {
    return contradiction.length > 200 ? `${contradiction.slice(0, 197)}…` : contradiction;
  }
  const failure = pickFailureLabel(map);
  const protector = map?.protector_rule?.trim();
  if (failure && protector) {
    return `${failure} — driven by "${protector.slice(0, 100)}".`;
  }
  if (failure) return failure;
  const avoid = (map?.top_3_avoidance_behaviours || [])[0];
  if (avoid) return `avoidance like ${avoid}`;
  return "the resistance pattern from your Map Resistance";
};

const countUserTurns = (messages = []) =>
  (messages || []).filter((m) => m?.role === "user" && String(m.content || "").trim()).length;

const lastAssistantText = (messages = []) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return String(messages[i].content || "");
  }
  return "";
};

const isFirstCoachSession = (continuity = null, coachContext = null, memory = null) => {
  const priorSessions = (
    coachContext?.coaching_sessions ||
    memory?.coaching_sessions ||
    []
  ).filter((s) => s.ended_at || (s.turn_count || 0) > 1);
  return (
    !continuity?.is_returning_member &&
    priorSessions.length === 0 &&
    !continuity?.last_session_ended_at &&
    !continuity?.had_proof &&
    !continuity?.session_summary
  );
};

/** True only for the first user message in this open session (messages exclude current). */
const isFirstUserReply = (messages = []) => countUserTurns(messages) === 0;

const reportsSetback = (text) => {
  const t = String(text || "").trim();
  if (!t) return false;
  return isSetbackOrGapReport(t) || detectStruggleSetback(t);
};

const investigateWasAsked = (messages = [], openSession = null) => {
  if (openSession?.first_session_flow?.investigate_asked) return true;
  const assistant = (messages || [])
    .filter((m) => m?.role === "assistant")
    .map((m) => String(m.content || ""))
    .join("\n");
  return assistant.includes(INVESTIGATE_MARKER) || assistant.includes(GAP_TRACKING_MARKER);
};

const isSubstantiveInvestigateAnswer = (text) => {
  const t = String(text || "").trim();
  if (t.length < 8) return false;
  if (/^(yes|yup|yeah|no|nope|ok|okay)\s*\.?$/i.test(t)) return false;
  return true;
};

/**
 * First coach session after Map Resistance.
 * Map fields stay internal — never read protector/failure/contradiction aloud.
 * Active goal is lightly named; session starts with today.
 */
const buildFirstSessionOpening = ({ firstName, goalPhrase }) => {
  const name = firstName?.trim() || "there";
  const goal = String(goalPhrase || "").trim() || "your goal";
  return (
    `Hey ${name}.\n\n` +
    `Everything you share here is confidential — this is your space to be honest.\n\n` +
    `We're working on ${goal}.\n\n` +
    `Good to see you.\n\n` +
    `How are you today?\n\n` +
    `What brought you here today — and what do you want from this session?`
  );
};

const buildInvestigateQuestion = ({ map, activeGoalContext }) => {
  const milestone =
    activeGoalContext?.current_milestone ||
    activeGoalContext?.milestones?.day_7 ||
    activeGoalContext?.goal_name ||
    map?.goal_title ||
    "your milestone";
  const failure = pickFailureLabel(map) || "your failure strategy";
  const protector = map?.protector_rule?.trim() || "staying safe by not taking visible action";

  return (
    `That's the gap we're tracking — nothing landed toward ${milestone} yet.\n\n` +
    `From your map, ${failure} tends to run when income requires action. ` +
    `The protector underneath: ${protector}\n\n` +
    `${INVESTIGATE_MARKER} — what actually happened? ` +
    `Be specific: outreach, pricing, follow-up, or shutdown?`
  );
};

const buildFirstSessionSetbackContext = ({ map, activeGoalContext }) => ({
  first_session_setback: true,
  milestone:
    activeGoalContext?.current_milestone ||
    activeGoalContext?.milestones?.day_7 ||
    activeGoalContext?.goal_name ||
    map?.goal_title ||
    "milestone",
  failure_strategy: pickFailureLabel(map),
  protector_rule: map?.protector_rule?.trim() || null,
  investigate_only: true,
});

const buildFirstSessionFollowUpContext = ({ map, userMessage, activeGoalContext }) => {
  const {
    hasVisibilityAction,
    isPureGapNoAction,
    shouldNotLabelAsAvoidance,
  } = require("./evidence");
  const t = String(userMessage || "").trim();
  return {
    first_session_investigate_complete: true,
    user_answer_snippet: t.slice(0, 300),
    visibility_action: shouldNotLabelAsAvoidance(t) || hasVisibilityAction(t),
    pure_gap_no_action: isPureGapNoAction(t) && !/\blazy\b/i.test(t),
    milestone:
      activeGoalContext?.current_milestone ||
      activeGoalContext?.milestones?.day_7 ||
      map?.goal_title ||
      "goal",
    flip: map?.flip_belief?.trim() || map?.success_strategy?.behaviour?.trim() || null,
  };
};

const resolveFirstSessionTurnFlow = ({
  messages = [],
  userMessage = "",
  map = null,
  activeGoalContext = null,
  continuity = null,
  coachContext = null,
  memory = null,
  proofCycleFlow = null,
  openSession = null,
} = {}) => {
  const base = {
    skip_llm: false,
    assistant_override: null,
    coaching_directive: null,
    coaching_context: null,
    conversation_signals: null,
    assign_green_rep: false,
    active: false,
    is_first_session: false,
    is_first_turn: false,
    first_session_flow: openSession?.first_session_flow || null,
  };

  if (!map?.map_resistance_complete) return base;
  if (proofCycleFlow?.proof_integration_mode) return base;

  const firstSession = isFirstCoachSession(continuity, coachContext, memory);
  const firstReply = isFirstUserReply(messages);
  const investigateAsked = investigateWasAsked(messages, openSession);
  const investigateComplete = Boolean(openSession?.first_session_flow?.investigate_complete);

  if (investigateComplete) {
    return {
      ...base,
      coaching_directive:
        "Investigation complete — do NOT repeat the gap-tracking block. " +
        "Coach from their specific answers. One disrupt action or Green Rep only.",
      assign_green_rep: false,
    };
  }

  if (investigateAsked && isSubstantiveInvestigateAnswer(userMessage)) {
    return {
      ...base,
      active: true,
      coaching_directive: formatOutcomeDirective("first_session_followup", {
        goal: "Acknowledge specific setback answer and move to one disrupt action.",
        yourJob: [
          "name what happened without avoidance mislabel",
          "one outreach or disrupt question",
        ],
        avoid: ["gap-tracking block repeat", "protector lecture"],
      }),
      coaching_context: buildFirstSessionFollowUpContext({ map, userMessage, activeGoalContext }),
      conversation_signals: { first_session_investigate_complete: true },
      assign_green_rep: false,
      first_session_flow: {
        investigate_asked: true,
        investigate_complete: true,
        last_answer: userMessage.trim().slice(0, 300),
      },
    };
  }

  if (firstReply && reportsSetback(userMessage) && !investigateAsked) {
    return {
      ...base,
      active: true,
      is_first_session: firstSession,
      is_first_turn: true,
      coaching_directive: formatOutcomeDirective("first_session_setback", {
        goal: "Investigate first setback before assigning rep.",
        yourJob: ["reference map gap", "ask what specifically happened"],
        avoid: ["rep assignment", "visibility strategy lecture"],
      }),
      coaching_context: buildFirstSessionSetbackContext({ map, activeGoalContext }),
      conversation_signals: { first_session_setback: true },
      assign_green_rep: false,
      first_session_flow: { investigate_asked: true, investigate_complete: false },
    };
  }

  if (firstReply && firstSession) {
    return {
      ...base,
      is_first_session: true,
      is_first_turn: true,
      coaching_directive:
        "FIRST COACH SESSION — reference map; investigate reality before assigning reps.",
      assign_green_rep: false,
    };
  }

  return { ...base, is_first_turn: firstReply, is_first_session: firstSession };
};

module.exports = {
  INVESTIGATE_MARKER,
  isFirstCoachSession,
  isFirstUserReply,
  reportsSetback,
  investigateWasAsked,
  buildFirstSessionOpening,
  buildInvestigateQuestion,
  buildFirstSessionSetbackContext,
  buildFirstSessionFollowUpContext,
  resolveFirstSessionTurnFlow,
  pickMapHook,
};
