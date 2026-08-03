/**
 * Single coach turn-mode arbiter.
 *
 * Modes: DISCOVER | ASSIGN | HOLD | INTEGRATE
 * Only this module should decide assign_green_rep for the LLM turn.
 * Other flows are inputs (votes/blocks), not parallel writers.
 */

const {
  isMechanismReady,
  MECHANISM_EXIT_DIRECTIVE,
  DISCOVERY_ONLY_DIRECTIVE,
  EXPLORE_FIRST_DIRECTIVE,
  detectSessionWantsNextStep,
  USER_WANTS_ACTION_PATTERN,
  MECHANISM_READY_MIN_TURNS,
  countUserTurns,
  isDiscoveryOnlyQuestion,
} = require("../signals/antiRepeat");
const {
  isSessionRepLocked,
  extractSessionRepFromMessages,
} = require("../utils/repLatch");
const { buildMilestoneAlignedRep } = require("../utils/milestoneRep");

const COACH_TURN_MODES = Object.freeze({
  DISCOVER: "DISCOVER",
  ASSIGN: "ASSIGN",
  HOLD: "HOLD",
  INTEGRATE: "INTEGRATE",
});

const MONEY_DOMAINS = new Set(["income", "wealth", "money"]);

const HOLD_DIRECTIVE =
  "HOLD — a Green Rep is already assigned this session. " +
  "Support that existing rep in 1-3 short sentences. " +
  "Do NOT assign a new Green Rep, do NOT restate MECHANISM CLEAR / pattern speech, " +
  "do NOT ask 'before assigning' cost questions. green_rep may restate the same rep or be null.";

const INTEGRATE_DIRECTIVE =
  "INTEGRATE — proof / progress path is active. " +
  "Stay with integration, logging, or session close. Do NOT assign a new Green Rep.";

const isMoneyDomain = (domain) =>
  MONEY_DOMAINS.has(String(domain || "").toLowerCase());

/**
 * Sticky latch: once a rep was given this open session, stay in HOLD.
 */
const isSessionRepLockedForTurn = (openSession = null, messages = []) =>
  isSessionRepLocked(openSession, messages);

const wantsActionThisSession = ({
  userMessage = "",
  messages = [],
  conversationSignals = {},
  sessionIntakeFlow = {},
} = {}) => {
  if (conversationSignals.session_wants_next_step) return true;
  if (conversationSignals.user_asked_what_next) return true;
  if (USER_WANTS_ACTION_PATTERN.test(String(userMessage || ""))) return true;
  const userTexts = (messages || [])
    .filter((m) => m?.role === "user")
    .map((m) => String(m.content || ""));
  if (userMessage) userTexts.push(String(userMessage));
  if (detectSessionWantsNextStep(userTexts)) return true;
  if (sessionIntakeFlow.session_phase === "insight_integration") return true;
  return false;
};

const instructionForMode = (mode, { lockedRepName = null, exploreFirst = false } = {}) => {
  if (mode === COACH_TURN_MODES.HOLD) {
    const named = lockedRepName
      ? ` Existing rep: "${lockedRepName}".`
      : "";
    return `${HOLD_DIRECTIVE}${named}`;
  }
  if (mode === COACH_TURN_MODES.ASSIGN) {
    return MECHANISM_EXIT_DIRECTIVE;
  }
  if (mode === COACH_TURN_MODES.INTEGRATE) {
    return INTEGRATE_DIRECTIVE;
  }
  if (exploreFirst) return EXPLORE_FIRST_DIRECTIVE;
  return DISCOVERY_ONLY_DIRECTIVE;
};

/**
 * Resolve the single turn mode for this coach check-in.
 */
const resolveCoachTurnMode = ({
  messages = [],
  userMessage = "",
  map = null,
  openSession = null,
  domain = null,
  conversationSignals = {},
  proofCycleFlow = null,
  sessionIntakeFlow = {},
  blockGreenRep = false,
  goalContext = null,
  memoryCtx = null,
} = {}) => {
  const session_rep_locked = isSessionRepLockedForTurn(openSession, messages);
  const extracted = extractSessionRepFromMessages(messages, openSession);
  const lockedRepName =
    openSession?.green_rep_last?.name ||
    openSession?.proof_cycle?.rep_name ||
    extracted?.name ||
    conversationSignals.active_rep_name ||
    null;

  const user_rejects = Boolean(conversationSignals.user_rejects_prescription);
  const hope_depletion = Boolean(conversationSignals.user_showing_hope_depletion);
  const clarity_block = Boolean(conversationSignals.block_clarity_rep);
  const exploreFirst = Boolean(
    conversationSignals.explore_first_mode && !conversationSignals.mechanism_ready,
  );

  const proofBlocking = Boolean(
    proofCycleFlow?.proof_integration_mode ||
      proofCycleFlow?.awaiting_proof_log ||
      proofCycleFlow?.suggest_session_end ||
      proofCycleFlow?.session_phase === "proof_integration",
  );

  if (proofBlocking) {
    return {
      mode: COACH_TURN_MODES.INTEGRATE,
      assign_green_rep: false,
      stop_discovery: true,
      discovery_complete: true,
      coaching_mode: "coaching",
      session_rep_locked,
      instruction: instructionForMode(COACH_TURN_MODES.INTEGRATE),
      suggested_milestone_rep: null,
      allow_solo_fallback: false,
      reason: "proof_integration",
    };
  }

  if (session_rep_locked) {
    return {
      mode: COACH_TURN_MODES.HOLD,
      assign_green_rep: false,
      stop_discovery: true,
      discovery_complete: true,
      coaching_mode: "coaching",
      session_rep_locked: true,
      instruction: instructionForMode(COACH_TURN_MODES.HOLD, { lockedRepName }),
      suggested_milestone_rep: null,
      allow_solo_fallback: false,
      reason: "session_rep_locked",
    };
  }

  const mechanism_ready = Boolean(
    conversationSignals.mechanism_ready ??
      isMechanismReady({ messages, userMessage, map }),
  );
  const userTurns = countUserTurns(messages, userMessage);
  const turnCapExit =
    userTurns >= MECHANISM_READY_MIN_TURNS && Boolean(map?.map_resistance_complete);
  const wantsAction = wantsActionThisSession({
    userMessage,
    messages,
    conversationSignals,
    sessionIntakeFlow,
  });

  // Structural / intake / investigation blocks apply during discovery only —
  // never veto ASSIGN once mechanism is clear and member wants action.
  const assignOverride = mechanism_ready && wantsAction;
  const hardBlock =
    (blockGreenRep && !assignOverride) ||
    user_rejects ||
    hope_depletion ||
    (clarity_block && !assignOverride) ||
    (Boolean(conversationSignals.coaching_repeat_complaint) && !assignOverride);

  if (hardBlock || !mechanism_ready) {
    return {
      mode: COACH_TURN_MODES.DISCOVER,
      assign_green_rep: false,
      stop_discovery: false,
      discovery_complete: false,
      coaching_mode: "discovery",
      session_rep_locked: false,
      instruction: instructionForMode(COACH_TURN_MODES.DISCOVER, { exploreFirst }),
      suggested_milestone_rep: null,
      allow_solo_fallback: false,
      reason: hardBlock ? "blocked_or_reject" : "mechanism_not_ready",
    };
  }

  // ASSIGN: mechanism clear + (member wants next step OR turn-cap exit)
  if (wantsAction || turnCapExit) {
    const allow_solo_fallback =
      !isMoneyDomain(domain) && Boolean(conversationSignals.no_trusted_person);
    const suggested_milestone_rep = map?.map_resistance_complete
      ? buildMilestoneAlignedRep({
          map,
          goalContext: goalContext || { active_domain: domain },
          memoryCtx,
          allowSoloFallback: allow_solo_fallback,
        })
      : null;

    return {
      mode: COACH_TURN_MODES.ASSIGN,
      assign_green_rep: true,
      stop_discovery: true,
      discovery_complete: true,
      coaching_mode: "coaching",
      session_rep_locked: false,
      instruction: instructionForMode(COACH_TURN_MODES.ASSIGN),
      suggested_milestone_rep,
      allow_solo_fallback,
      reason: wantsAction ? "mechanism_ready_wants_action" : "mechanism_ready_turn_cap",
    };
  }

  // Mechanism clear but member still exploring — stay in discover without assign.
  return {
    mode: COACH_TURN_MODES.DISCOVER,
    assign_green_rep: false,
    stop_discovery: false,
    discovery_complete: false,
    coaching_mode: "discovery",
    session_rep_locked: false,
    instruction: instructionForMode(COACH_TURN_MODES.DISCOVER, {
      exploreFirst: true,
    }),
    suggested_milestone_rep: null,
    allow_solo_fallback: false,
    reason: "mechanism_ready_still_exploring",
  };
};

/**
 * Apply arbiter result onto transition — replaces assign flags and instruction.
 */
const applyCoachTurnMode = (transition = {}, turnMode = {}) => {
  const next = { ...(transition || {}) };
  const brief = { ...(next.coaching_brief || {}) };

  brief.assign_green_rep = Boolean(turnMode.assign_green_rep);
  brief.must_assign_green_rep = Boolean(turnMode.assign_green_rep);
  brief.instruction = String(turnMode.instruction || "").trim();
  if (
    turnMode.mode === COACH_TURN_MODES.ASSIGN &&
    turnMode.suggested_milestone_rep?.name
  ) {
    const rep = turnMode.suggested_milestone_rep;
    const stepLine =
      Array.isArray(rep.steps) && rep.steps[0]
        ? rep.steps[0]
        : rep.win_condition || "one visible step today";
    brief.instruction =
      `${brief.instruction} REQUIRED Green Rep: "${rep.name}" — ${stepLine}. Put full rep in green_rep JSON.`.trim();
    brief.suggested_milestone_rep = rep;
  } else if (turnMode.suggested_milestone_rep) {
    brief.suggested_milestone_rep = turnMode.suggested_milestone_rep;
  } else if (!turnMode.assign_green_rep) {
    // HOLD/DISCOVER/INTEGRATE: do not keep a stale suggested rep that invites re-assign.
    if (turnMode.mode === COACH_TURN_MODES.HOLD || turnMode.mode === COACH_TURN_MODES.INTEGRATE) {
      brief.suggested_milestone_rep = null;
    }
  }

  const signals = {
    ...(next.conversation_signals || brief.conversation_signals || {}),
    coach_turn_mode: turnMode.mode,
    assign_green_rep: Boolean(turnMode.assign_green_rep),
    assign_new_rep: Boolean(turnMode.assign_green_rep),
    session_rep_locked: Boolean(turnMode.session_rep_locked),
    turn_mode_reason: turnMode.reason || null,
    allow_solo_fallback: Boolean(turnMode.allow_solo_fallback),
  };
  if (!turnMode.assign_green_rep) {
    signals.block_green_rep =
      turnMode.mode === COACH_TURN_MODES.HOLD ||
      turnMode.mode === COACH_TURN_MODES.INTEGRATE ||
      Boolean(signals.block_green_rep);
  }

  brief.conversation_signals = signals;
  next.coaching_brief = brief;
  next.conversation_signals = signals;
  next.coach_turn_mode = turnMode.mode;
  next.stop_discovery = Boolean(turnMode.stop_discovery);
  next.discovery_complete = Boolean(turnMode.discovery_complete);
  if (turnMode.coaching_mode) {
    next.coaching_mode = turnMode.coaching_mode;
  }
  if (turnMode.mode === COACH_TURN_MODES.DISCOVER) {
    next.coaching_phase = "explore";
  } else if (turnMode.mode === COACH_TURN_MODES.ASSIGN) {
    next.coaching_phase = "execute";
  }

  return next;
};

module.exports = {
  COACH_TURN_MODES,
  isSessionRepLocked: isSessionRepLockedForTurn,
  resolveCoachTurnMode,
  applyCoachTurnMode,
  wantsActionThisSession,
};
