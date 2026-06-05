/**
 * Code-level coaching phase — stop discovery when resistance/pattern is already known.
 * Prompts alone cannot prevent endless interviewing; Node sets coaching_mode every turn.
 */

const { detectStruggleSetback } = require("./stage1CoachDiscovery");
const { humanizePattern } = require("./stage1CoachNaturalLanguage");

const AVOIDANCE_MESSAGE =
  /\b(slept|sleep(?:ing|y)?|whole day|procrastinat|lazy|avoid(?:ed|ing)?|scrolled|did nothing|didn't do|did not do|no progress|wasted|unproductive|no motivation|no earning|fell off|off track|bum(?:med)? out)\b/i;

const DEVALUATION_HINT =
  /\b(not enough|too little|less money|did too little|feels its not enough)\b/i;

const pickFailureRule = (map, memoryCtx) => {
  const fs = map?.failure_strategy;
  if (typeof fs === "string") return fs;
  const fromMap = fs?.rule || fs?.title || null;
  return fromMap || memoryCtx?.failure_strategy || null;
};

const pickSuccessRule = (map, memoryCtx) => {
  const ss = map?.success_strategy;
  if (typeof ss === "string") return ss;
  const fromMap = ss?.behaviour || ss?.success_rule || ss?.title || null;
  return fromMap || memoryCtx?.success_strategy || null;
};

const hasKnownResistance = (map, memoryCtx = {}) => {
  const failure = pickFailureRule(map, memoryCtx);
  const protector = map?.protector_rule || memoryCtx?.protector_rule;
  const coreFear = map?.core_fear || memoryCtx?.core_fear;
  const patterns = memoryCtx?.recent_resistance_patterns || [];
  return Boolean(
    map?.map_resistance_complete &&
      failure &&
      (protector || coreFear || patterns.length >= 1),
  );
};

const countPatternOccurrences = (memoryCtx = {}) => {
  let n = 0;
  if (memoryCtx.last_ended_session?.detected_pattern) n += 1;
  if (memoryCtx.last_ended_session?.narrative) n += 1;
  if ((memoryCtx.recent_resistance_patterns || []).length >= 2) n += 1;
  if ((memoryCtx.recent_proofs || []).length >= 2) n += 1;
  if (DEVALUATION_HINT.test(String(memoryCtx.coaching_summary || ""))) n += 1;
  for (const s of memoryCtx.last_five_sessions || []) {
    if (s?.summary && DEVALUATION_HINT.test(String(s.summary))) n += 1;
  }
  return n;
};

const hasEnoughStoredContext = (map, memoryCtx = {}) =>
  Boolean(
    map?.map_resistance_complete &&
      (memoryCtx.last_ended_session?.narrative ||
        memoryCtx.last_ended_session?.summary ||
        memoryCtx.coaching_summary ||
        (memoryCtx.recent_proofs || []).length >= 1 ||
        memoryCtx.initial_diagnostic),
  );

const reportsAvoidanceOrSetback = (text) => {
  const t = String(text || "").trim();
  if (!t) return false;
  return AVOIDANCE_MESSAGE.test(t) || detectStruggleSetback(t);
};

const inferSessionPhase = (messages = [], currentMessage = "") => {
  const userTexts = [
    ...messages.filter((m) => m?.role === "user").map((m) => String(m.content || "")),
    String(currentMessage || ""),
  ].filter((t) => t.trim());

  const substantiveCount = userTexts.filter((t) => t.trim().length >= 12).length;
  const combined = userTexts.join(" ").toLowerCase();

  const hasWin =
    /\b(earned|made|generated|completed|finished|reached out|got a client|worked|\$\d+|\d+\s*(?:hrs?|hours?|hr|hour|dollar))/i.test(
      combined,
    );
  const hasCollapse =
    /\b(too little|not enough|nothing|didn't do|did not|gave up|no motivation|collapsed|quit trying|bad day|lazy|no earning|did nothing|slept|procrastinat)/i.test(
      combined,
    );
  const hasOutcomeChain = hasWin && hasCollapse;

  const hasSetbackDetail =
    substantiveCount >= 2 &&
    /\b(stuck|avoid|nothing|didn't|failed|no progress|did nothing|slept|lazy)/i.test(combined);

  if (hasOutcomeChain || substantiveCount >= 3 || (substantiveCount >= 2 && hasSetbackDetail)) {
    return "directive";
  }
  if (substantiveCount >= 2 || userTexts.length >= 2) {
    return "transitioning";
  }
  return "explore";
};

const buildPatternLabel = (map, memoryCtx, userMessage) => {
  const narrative = memoryCtx?.last_ended_session?.narrative;
  if (narrative) return narrative;
  const pattern = (memoryCtx?.recent_resistance_patterns || [])[0];
  if (pattern) return humanizePattern(pattern) || pattern;
  if (DEVALUATION_HINT.test(String(userMessage))) {
    return "effort happens, then gets judged as not enough, then action stops";
  }
  if (AVOIDANCE_MESSAGE.test(String(userMessage))) {
    return "avoidance and shutdown instead of goal-aligned action";
  }
  return pickFailureRule(map, memoryCtx) || "repeating resistance to the goal";
};

const buildCoachingBrief = (map, memoryCtx, userMessage) => {
  const failure = pickFailureRule(map, memoryCtx);
  const success = pickSuccessRule(map, memoryCtx);
  const protector = map?.protector_rule || memoryCtx?.protector_rule || null;
  const patternLabel = buildPatternLabel(map, memoryCtx, userMessage);

  return {
    discovery_complete: true,
    pattern_label: patternLabel,
    failure_strategy: failure,
    success_strategy: success,
    protector_rule: protector,
    cost_of_pattern:
      "When this pattern runs, proof does not count, motivation collapses, and the goal keeps drifting.",
    required_structure: [
      "Name the pattern in plain language",
      "Explain the cost of repeating it",
      "Identify the failure strategy (how protection shows up)",
      "Identify the success strategy (what forward action looks like)",
      "Assign exactly ONE Green Rep in JSON with clear steps",
      "Define concrete proof for that rep",
    ],
    must_assign_green_rep: true,
    no_reflective_questions: true,
    instruction:
      "Do NOT ask discovery or reflective questions. Coach directly using stored context. " +
      "Return green_rep in JSON and set writeback_hints.assign_new_green_rep true.",
  };
};

/**
 * @returns {{
 *   coaching_phase: 'explore'|'transitioning'|'directive'|'execute',
 *   coaching_mode: 'discovery'|'coaching'|'execute',
 *   discovery_complete: boolean,
 *   stop_discovery: boolean,
 *   reasons: string[],
 *   coaching_brief: object|null,
 * }}
 */
const resolveCoachingTransition = ({
  messages = [],
  userMessage = "",
  map = null,
  coachMemoryContext = {},
}) => {
  const sessionPhase = inferSessionPhase(messages, userMessage);
  const avoidance = reportsAvoidanceOrSetback(userMessage);
  const known = hasKnownResistance(map, coachMemoryContext);
  const enough = hasEnoughStoredContext(map, coachMemoryContext);
  const patternCount = countPatternOccurrences(coachMemoryContext);
  const lastPattern = coachMemoryContext?.last_ended_session?.detected_pattern;

  const reasons = [];

  const patternEstablished =
    patternCount >= 2 ||
    (lastPattern && avoidance) ||
    (known &&
      (coachMemoryContext.recent_resistance_patterns || []).length >= 1 &&
      ((coachMemoryContext.recent_proofs || []).length >= 1 ||
        coachMemoryContext.last_ended_session?.narrative ||
        coachMemoryContext.last_ended_session?.detected_pattern));

  const shouldExecute =
    known &&
    enough &&
    avoidance &&
    patternEstablished;

  if (shouldExecute) {
    if (known) reasons.push("resistance_already_mapped");
    if (patternEstablished) reasons.push("pattern_repeated");
    if (avoidance) reasons.push("avoidance_reported");
    if (enough) reasons.push("stored_context_sufficient");

    return {
      coaching_phase: "execute",
      coaching_mode: "execute",
      discovery_complete: true,
      stop_discovery: true,
      reasons,
      coaching_brief: buildCoachingBrief(map, coachMemoryContext, userMessage),
    };
  }

  if (sessionPhase === "directive" || (known && enough && avoidance && lastPattern)) {
    return {
      coaching_phase: "directive",
      coaching_mode: "coaching",
      discovery_complete: true,
      stop_discovery: true,
      reasons: ["session_story_complete"],
      coaching_brief: buildCoachingBrief(map, coachMemoryContext, userMessage),
    };
  }

  if (sessionPhase === "transitioning") {
    return {
      coaching_phase: "transitioning",
      coaching_mode: "discovery",
      discovery_complete: false,
      stop_discovery: false,
      reasons: ["partial_session_context"],
      coaching_brief: null,
    };
  }

  const missingInfo = !known || !enough;
  return {
    coaching_phase: "explore",
    coaching_mode: missingInfo ? "discovery" : "coaching",
    discovery_complete: !missingInfo && !avoidance,
    stop_discovery: !missingInfo && known && !avoidance,
    reasons: missingInfo ? ["resistance_or_history_missing"] : ["gathering_first_detail"],
    coaching_brief: null,
  };
};

/** @deprecated use resolveCoachingTransition */
const inferCoachingPhase = (messages, userMessage) =>
  resolveCoachingTransition({ messages, userMessage }).coaching_phase;

module.exports = {
  resolveCoachingTransition,
  inferCoachingPhase,
  inferSessionPhase,
  reportsAvoidanceOrSetback,
  hasKnownResistance,
  hasEnoughStoredContext,
  countPatternOccurrences,
  buildCoachingBrief,
  AVOIDANCE_MESSAGE,
};
