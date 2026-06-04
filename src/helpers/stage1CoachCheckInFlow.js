const collectRecentPatterns = (map, memory, coachContext) => {
  const seen = new Set();
  const patterns = [];
  const add = (label) => {
    const t = String(label || "").trim();
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    patterns.push(t);
  };
  for (const s of memory.resistance_history || []) {
    add(s.fear);
    add(s.resistance);
    add(s.avoidance);
  }
  for (const s of (memory.coaching_sessions || memory.coaching_history || []).slice(-5)) {
    add(s.current_fear);
    add(s.current_resistance);
    for (const a of s.current_avoidance_behaviours || []) add(a);
  }
  for (const a of map?.top_3_avoidance_behaviours || []) add(a);
  for (const b of map?.failure_strategy?.behaviours || []) add(b);
  if (map?.orbit_pattern) add(map.orbit_pattern);
  for (const r of coachContext?.resistance_evolution || []) {
    add(r.fear);
    add(r.resistance);
  }
  return patterns.slice(0, 6);
};

const { isPlausibleGreenRepName } = require("./stage1CoachGreenRepUtils");

const resolveLastGreenRep = (memory, map, continuity = null) => {
  if (continuity?.last_green_rep?.name && isPlausibleGreenRepName(continuity.last_green_rep.name)) {
    return continuity.last_green_rep;
  }
  const fromHistory = [...(memory.green_rep_history || [])]
    .reverse()
    .find((g) => isPlausibleGreenRepName(g?.name));
  if (fromHistory?.name) return fromHistory;
  const lastAssigned = memory.last_green_rep_assigned;
  if (lastAssigned?.name && isPlausibleGreenRepName(lastAssigned.name)) return lastAssigned;
  const diagRep = memory.initial_diagnostic?.daily_rep;
  if (diagRep?.name && isPlausibleGreenRepName(diagRep.name)) return diagRep;
  const mapRep = map?.daily_rep;
  if (mapRep && typeof mapRep === "object" && isPlausibleGreenRepName(mapRep.name)) {
    return mapRep;
  }
  return null;
};

const CHECK_IN_STEPS = Object.freeze({
  SINCE_LAST: "since_last_session",
  GREEN_REP: "green_rep_completed",
  BLOCKER: "current_blocker",
  COMPLETE: "complete",
});

const emptyCheckInProgress = () => ({
  step: CHECK_IN_STEPS.SINCE_LAST,
  answers: {
    since_last_session: null,
    green_rep_completed: null,
    green_rep_completed_note: null,
    current_blocker: null,
  },
});

const initCheckInProgress = (continuity = null) => ({
  ...emptyCheckInProgress(),
  continuity: continuity && typeof continuity === "object" ? continuity : null,
});

const normalizeProgress = (raw) => {
  if (!raw || typeof raw !== "object") return initCheckInProgress();
  const answers = {
    ...emptyCheckInProgress().answers,
    ...(raw.answers && typeof raw.answers === "object" ? raw.answers : {}),
  };
  const step = Object.values(CHECK_IN_STEPS).includes(raw.step)
    ? raw.step
    : CHECK_IN_STEPS.SINCE_LAST;
  return {
    step,
    answers,
    continuity: raw.continuity && typeof raw.continuity === "object" ? raw.continuity : null,
  };
};

const parseYesNo = (text) => {
  const t = String(text || "").trim().toLowerCase();
  if (!t) return null;
  if (/^(yes|yeah|yep|yup|done|completed|finished|i did|absolutely|sure)\b/.test(t)) {
    return true;
  }
  if (/^(no|nope|nah|not yet|didn't|did not|haven't|have not|incomplete|partial)\b/.test(t)) {
    return false;
  }
  if (/\b(yes|completed|done|finished)\b/.test(t) && !/\b(not|no|didn't)\b/.test(t)) {
    return true;
  }
  if (/\b(no|not|didn't|haven't|incomplete)\b/.test(t)) return false;
  return null;
};

/**
 * Short opening recap + exactly ONE question (no multi-question form).
 */
const {
  buildContinuityRecapLines,
  buildContinuityOpeningQuestion,
} = require("./stage1CoachSessionContinuity");

const buildCoachOpeningCheckin = ({
  firstName,
  activeGoalContext,
  map,
  memory,
  coachContext,
  continuity = null,
}) => {
  const goal =
    activeGoalContext?.goal_name ||
    activeGoalContext?.specific_goal ||
    map?.goal_title ||
    "your goal";
  const milestone =
    activeGoalContext?.current_milestone ||
    activeGoalContext?.milestones?.day_7 ||
    "—";

  const lastRep = resolveLastGreenRep(memory, map, continuity);
  const patterns = collectRecentPatterns(map, memory, coachContext);
  const recapLines = buildContinuityRecapLines(continuity);

  const lines = [];
  lines.push(firstName ? `Welcome back ${firstName}.` : "Welcome back.");
  lines.push("");
  lines.push("Current Goal:");
  lines.push(goal);
  lines.push("");
  lines.push("Current Milestone:");
  lines.push(milestone);

  if (recapLines.length) {
    lines.push("");
    lines.push(...recapLines);
  }

  if (lastRep?.name) {
    lines.push("");
    lines.push("Last Green Rep:");
    lines.push(lastRep.name);
  }

  if (patterns.length) {
    lines.push("");
    lines.push("Recent Patterns:");
    for (const p of patterns) {
      lines.push(`• ${p}`);
    }
  }

  lines.push("");
  lines.push(buildContinuityOpeningQuestion(continuity));

  return lines.join("\n");
};

const questionForStep = (step, { lastRepName, answers }) => {
  const repName = lastRepName || "your last Green Rep";
  switch (step) {
    case CHECK_IN_STEPS.SINCE_LAST:
      return "What happened since our last session?";
    case CHECK_IN_STEPS.GREEN_REP:
      return `Did you complete the previous Green Rep — ${repName}?`;
    case CHECK_IN_STEPS.BLOCKER:
      if (answers.green_rep_completed === false) {
        return "What stopped you?";
      }
      return "What feels hardest right now?";
    default:
      return null;
  }
};

/** Brief acknowledgment before the next single question. */
const buildAcknowledgment = (stepJustAnswered, userMessage) => {
  const snippet = String(userMessage || "").trim().slice(0, 120);
  switch (stepJustAnswered) {
    case CHECK_IN_STEPS.SINCE_LAST:
      return snippet
        ? `Got it — thanks for sharing.`
        : `Thanks — I'm with you.`;
    case CHECK_IN_STEPS.GREEN_REP:
      return `Thanks for being straight about that.`;
    case CHECK_IN_STEPS.BLOCKER:
      return `I hear you.`;
    default:
      return "Thanks.";
  }
};

/**
 * After user message: save answer, advance step, return next assistant line (one question only).
 */
const advanceCheckInConversation = (progress, userMessage, context = {}) => {
  const state = normalizeProgress(progress);
  const text = String(userMessage || "").trim();
  const lastRepName = context.lastRepName || null;

  if (!text) {
    return {
      progress: state,
      assistant_message: questionForStep(state.step, { lastRepName, answers: state.answers }),
      session_phase: "check_in",
      ready_for_coaching: false,
    };
  }

  if (state.step === CHECK_IN_STEPS.SINCE_LAST) {
    state.answers.since_last_session = text;
    state.step = CHECK_IN_STEPS.GREEN_REP;
    const ack = buildAcknowledgment(CHECK_IN_STEPS.SINCE_LAST, text);
    const q = questionForStep(CHECK_IN_STEPS.GREEN_REP, {
      lastRepName,
      answers: state.answers,
    });
    return {
      progress: state,
      assistant_message: `${ack}\n\n${q}`,
      session_phase: "check_in",
      ready_for_coaching: false,
    };
  }

  if (state.step === CHECK_IN_STEPS.GREEN_REP) {
    const yn = parseYesNo(text);
    state.answers.green_rep_completed = yn;
    state.answers.green_rep_completed_note = text;
    state.step = CHECK_IN_STEPS.BLOCKER;
    const ack = buildAcknowledgment(CHECK_IN_STEPS.GREEN_REP, text);
    const q = questionForStep(CHECK_IN_STEPS.BLOCKER, {
      lastRepName,
      answers: state.answers,
    });
    return {
      progress: state,
      assistant_message: `${ack}\n\n${q}`,
      session_phase: "check_in",
      ready_for_coaching: false,
    };
  }

  if (state.step === CHECK_IN_STEPS.BLOCKER) {
    state.answers.current_blocker = text;
    state.step = CHECK_IN_STEPS.COMPLETE;
    return {
      progress: state,
      assistant_message: null,
      session_phase: "coaching",
      ready_for_coaching: true,
    };
  }

  return {
    progress: state,
    assistant_message: null,
    session_phase: "coaching",
    ready_for_coaching: true,
  };
};

const isCheckInActive = (progress) => {
  const state = normalizeProgress(progress);
  return state.step !== CHECK_IN_STEPS.COMPLETE;
};

const getSessionPhaseFromProgress = (progress) =>
  isCheckInActive(progress) ? "check_in" : "coaching";

/** Legacy sessions without persisted check_in_progress. */
const inferCheckInProgressFromMessages = (messages) => {
  const users = (messages || [])
    .filter((m) => m?.role === "user" && String(m.content || "").trim())
    .map((m) => String(m.content).trim());
  const state = initCheckInProgress();
  if (users[0]) {
    state.answers.since_last_session = users[0];
    state.step = CHECK_IN_STEPS.GREEN_REP;
  }
  if (users[1]) {
    state.answers.green_rep_completed_note = users[1];
    state.answers.green_rep_completed = parseYesNo(users[1]);
    state.step = CHECK_IN_STEPS.BLOCKER;
  }
  if (users[2]) {
    state.answers.current_blocker = users[2];
    state.step = CHECK_IN_STEPS.COMPLETE;
  }
  return state;
};

module.exports = {
  CHECK_IN_STEPS,
  emptyCheckInProgress,
  initCheckInProgress,
  normalizeProgress,
  buildCoachOpeningCheckin,
  advanceCheckInConversation,
  isCheckInActive,
  getSessionPhaseFromProgress,
  questionForStep,
  collectRecentPatterns,
  resolveLastGreenRep,
  inferCheckInProgressFromMessages,
};
