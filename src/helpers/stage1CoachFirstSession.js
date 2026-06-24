/**
 * First coach session — map-aware opening and investigate → follow-up flow.
 */

const { resolveFailureStrategyForMap } = require("./stage1MapStructure");
const { detectStruggleSetback } = require("./stage1CoachDiscovery");
const { formatGoalPhrase } = require("./stage1CoachNaturalLanguage");
const { isSetbackOrGapReport } = require("./stage1CoachSetback");

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

const buildFirstSessionOpening = ({ firstName, map, activeGoalContext }) => {
  const name = firstName?.trim() || "there";
  const goal =
    activeGoalContext?.goal_name ||
    activeGoalContext?.specific_goal ||
    map?.goal_title ||
    "your goal";
  const milestone =
    activeGoalContext?.current_milestone ||
    activeGoalContext?.milestones?.day_7 ||
    null;
  const goalPhrase = formatGoalPhrase(goal, milestone);
  const mapHook = pickMapHook(map);

  return (
    `Hey ${name}.\n\n` +
    `We finished mapping ${goalPhrase}. From that map: ${mapHook}\n\n` +
    `This coach is here to interrupt that pattern — not motivate you around it.\n\n` +
    `What's been true since the map — any real move toward ${milestone || goal}, or did the old structure run the week?`
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

const buildInvestigateFollowUp = ({ map, userMessage, activeGoalContext }) => {
  const milestone =
    activeGoalContext?.current_milestone ||
    activeGoalContext?.milestones?.day_7 ||
    map?.goal_title ||
    "your goal";
  const failure = pickFailureLabel(map) || "staying invisible";
  const t = String(userMessage || "").trim();

  let whatHappened = "that's what ran today";
  if (/\blazy\b/i.test(t)) whatHappened = "the lazy pull won — action didn't start";
  if (/\bdidn'?t\s+reach|no\s+client|no\s+one|reach\s+anyone/i.test(t)) {
    whatHappened = "no outreach to clients happened";
  }
  if (/\bavoid|procrastinat|scroll|nothing\b/i.test(t)) {
    whatHappened = "avoidance ran the day";
  }

  const flip = map?.flip_belief?.trim() || map?.success_strategy?.behaviour?.trim();

  return (
    `Got it — ${whatHappened}. That's ${failure} doing its job: keeping you invisible so judgment can't land.\n\n` +
    `That's evidence, not failure — now we know exactly where the structure stops you.\n\n` +
    `One disrupt move for ${milestone}: reach out to ONE person with a clear rate or offer — one message sent, not prep. ` +
    `Who is the lowest-friction person you could message tomorrow?` +
    (flip ? `\n\n(Flip we're installing: "${flip.slice(0, 90)}")` : "")
  );
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
    assign_green_rep: false,
    is_first_session: false,
    is_first_turn: false,
    first_session_flow: openSession?.first_session_flow || null,
  };

  if (!map?.map_resistance_complete) return base;
  if (proofCycleFlow?.skip_llm) return base;

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
      skip_llm: true,
      assistant_override: buildInvestigateFollowUp({ map, userMessage, activeGoalContext }),
      coaching_directive:
        "User answered investigate question — acknowledge specifically, name pattern as evidence. " +
        "ONE outreach/disrupt question. Do NOT repeat gap-tracking or protector lecture. No generic visibility essay.",
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
      skip_llm: true,
      is_first_session: firstSession,
      is_first_turn: true,
      assistant_override: buildInvestigateQuestion({ map, activeGoalContext }),
      coaching_directive:
        "FIRST SETBACK — investigate only. Do NOT assign a rep. Do NOT lecture about visibility strategy.",
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
  buildInvestigateFollowUp,
  resolveFirstSessionTurnFlow,
  pickMapHook,
};
