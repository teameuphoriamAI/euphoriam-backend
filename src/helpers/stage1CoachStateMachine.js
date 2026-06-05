const {
  normalizeProgress: normalizeCheckInProgress,
  advanceCheckInConversation,
  isCheckInActive,
  resolveLastGreenRep,
  CHECK_IN_STEPS,
  questionForStep,
} = require("./stage1CoachCheckInFlow");
const {
  initProgressIntegration,
  normalizeProgressIntegration,
  detectProgressSignals,
  mergeSessionProofSignals,
  advanceProgressIntegration,
  isProgressIntegrationActive,
  maybeAutoLogProof,
  sanitizeCoachGreenRep,
  buildProgressCoachingInstructions,
  buildProgressClosing,
  isPostProofDevaluationActive,
  isWoundFlipActive,
  detectPostProofDevaluation,
  buildProgressIntegrationFromContinuity,
  COACH_SUBSTATE,
} = require("./stage1CoachProgress");

const {
  detectStruggleSetback,
  startDiscovery,
  advanceDiscovery,
  isDiscoveryActive,
  discoveryContextForAi,
  pickDiscoveryQuestion,
  briefAck,
} = require("./stage1CoachDiscovery");

const COACH_STATE = Object.freeze({
  CHECK_IN: "check_in",
  DISCOVERY: "discovery",
  PROGRESS: "progress",
  POST_PROOF_DEVALUATION: "post_proof_devaluation",
  WOUND_EDGE: "wound_edge",
  FLIP_INSTALL: "flip_install",
  COACHING: "coaching",
});

const normalizeQuestionKey = (q) =>
  String(q || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

const extractAssistantQuestions = (messages) => {
  const asked = [];
  for (const m of messages || []) {
    if (m?.role !== "assistant") continue;
    const content = String(m.content || "");
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.endsWith("?")) asked.push(normalizeQuestionKey(line));
    }
    if (content.includes("?") && !asked.length) {
      asked.push(normalizeQuestionKey(content.split("?")[0]));
    }
  }
  return asked;
};

const scanTranscriptForProof = (messages, context = {}) => {
  const users = (messages || []).filter((m) => m?.role === "user");
  for (let i = users.length - 1; i >= 0 && i >= users.length - 4; i -= 1) {
    const sig = detectProgressSignals(users[i].content, context);
    if (sig.isStrong || sig.hasProof) return sig;
  }
  return { isStrong: false, hasProof: false };
};

const proofPriorityOverride = (userMessage, messages, context = {}) => {
  const current = detectProgressSignals(userMessage, context);
  if (current.isStrong || current.hasProof) {
    return { override: true, signals: current, reason: "current_message" };
  }
  const fromTranscript = scanTranscriptForProof(messages, context);
  if (fromTranscript.isStrong || fromTranscript.hasProof) {
    return { override: true, signals: fromTranscript, reason: "transcript" };
  }
  if (context.checkInAnswers?.green_rep_completed === true) {
    return { override: true, signals: current, reason: "check_in_rep_done" };
  }
  if (isProgressIntegrationActive(context.progressIntegration)) {
    return { override: true, signals: current, reason: "active_progress_integration" };
  }
  return { override: false, signals: current };
};

const forceCheckInComplete = (checkInProgress, userMessage, signals) => {
  const prev = checkInProgress?.answers || {};
  return {
    step: "complete",
    answers: {
      ...prev,
      since_last_session:
        prev.since_last_session || (signals?.isStrong ? userMessage : null) || null,
      green_rep_completed:
        prev.green_rep_completed ?? signals?.repCompleted ?? false,
      green_rep_completed_note: prev.green_rep_completed_note || null,
      current_blocker: prev.current_blocker || null,
    },
  };
};

const handleProgressStateTurn = ({
  userMessage,
  messages = [],
  openSession,
  stage1,
  domain,
  map,
  lastRep,
  checkInProgress,
}) => {
  const text = String(userMessage || "").trim();
  const ctx = {
    lastRepName: lastRep?.name,
    patterns: map?.top_3_avoidance_behaviours || [],
    map,
  };

  let integration =
    normalizeProgressIntegration(openSession?.progress_integration) ||
    buildProgressIntegrationFromContinuity(checkInProgress?.continuity) ||
    initProgressIntegration(detectProgressSignals(text, ctx));

  integration.questions_asked = [
    ...new Set([
      ...(integration.questions_asked || []),
      ...extractAssistantQuestions(messages),
    ]),
  ];

  const pFlow = advanceProgressIntegration(integration, userMessage, {
    ...ctx,
    continuity: checkInProgress?.continuity,
  });
  const signals = mergeSessionProofSignals(pFlow.integration, text, ctx);

  let workingStage1 = stage1;
  if (pFlow.should_log_proof && !pFlow.integration.proof_logged) {
    const proofText = pFlow.integration.answers?.acknowledge_note || text;
    const logged = maybeAutoLogProof(workingStage1, domain, proofText, signals, lastRep?.name);
    workingStage1 = logged.stage1;
    pFlow.integration.proof_logged = Boolean(logged.proof);
  }

  let coachState = COACH_STATE.PROGRESS;
  if (pFlow.coach_state === COACH_SUBSTATE.COACHING) {
    coachState = COACH_STATE.COACHING;
  } else if (pFlow.coach_state === COACH_SUBSTATE.WOUND_EDGE) {
    coachState = COACH_STATE.WOUND_EDGE;
  } else if (pFlow.coach_state === COACH_SUBSTATE.FLIP_INSTALL) {
    coachState = COACH_STATE.FLIP_INSTALL;
  } else if (
    pFlow.coach_state === COACH_SUBSTATE.POST_PROOF_DEVALUATION ||
    pFlow.coach_state === COACH_SUBSTATE.POST_PROOF_DEVALUATION_LOOP
  ) {
    coachState = COACH_STATE.POST_PROOF_DEVALUATION;
  }

  let assistant_message = pFlow.assistant_message;
  if (!assistant_message?.trim()) {
    assistant_message = isPostProofDevaluationActive(pFlow.integration)
      ? buildProgressClosing(signals, ctx)
      : buildProgressClosing(signals, ctx);
  }

  return {
    coach_state: coachState,
    session_phase: pFlow.session_phase,
    assistant_message,
    green_rep: null,
    ready_for_coaching: pFlow.ready_for_resistance_coaching,
    progress_integration: pFlow.integration,
    proof_signals: signals,
    check_in_progress: forceCheckInComplete(checkInProgress, text, signals),
    stage1: workingStage1,
    diagnostic_observation: pFlow.diagnostic_observation || null,
  };
};

const bumpCheckInStep = (progress) => {
  const state = normalizeCheckInProgress(progress);
  if (state.step === CHECK_IN_STEPS.SINCE_LAST) {
    state.step = CHECK_IN_STEPS.FOLLOW_UP;
  } else if (
    state.step === CHECK_IN_STEPS.FOLLOW_UP ||
    state.step === CHECK_IN_STEPS.GREEN_REP ||
    state.step === CHECK_IN_STEPS.BLOCKER
  ) {
    state.step = CHECK_IN_STEPS.COMPLETE;
  }
  return state;
};

const nextQuestionWouldRepeat = (assistantMessage, messages) => {
  const asked = extractAssistantQuestions(messages);
  const lines = String(assistantMessage || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith("?"));
  for (const line of lines) {
    const key = normalizeQuestionKey(line);
    if (key && asked.includes(key)) return true;
  }
  return false;
};

const handleDiscoveryTurn = ({ userMessage, checkInProgress }) => {
  const discovery = checkInProgress?.discovery;
  if (!isDiscoveryActive(discovery)) {
    const started = startDiscovery(userMessage);
    const q = pickDiscoveryQuestion(started, userMessage);
    started.questions_asked = [q];
    started.step = 1;
    return {
      coach_state: COACH_STATE.DISCOVERY,
      session_phase: "discovery",
      assistant_message: `${briefAck(userMessage)}\n\n${q}`,
      ready_for_coaching: false,
      check_in_progress: {
        ...checkInProgress,
        discovery: started,
        step: CHECK_IN_STEPS.COMPLETE,
      },
      progress_integration: null,
      green_rep: null,
    };
  }

  const flow = advanceDiscovery(discovery, userMessage);
  const nextDiscovery = flow.discovery;
  const check_in_progress = {
    ...checkInProgress,
    discovery: nextDiscovery,
    step: CHECK_IN_STEPS.COMPLETE,
  };

  if (flow.ready_for_coaching) {
    check_in_progress.discovery_context = discoveryContextForAi(nextDiscovery);
  }

  return {
    coach_state: flow.ready_for_coaching ? COACH_STATE.COACHING : COACH_STATE.DISCOVERY,
    session_phase: flow.session_phase || "discovery",
    assistant_message: flow.assistant_message,
    ready_for_coaching: Boolean(flow.ready_for_coaching),
    check_in_progress,
    progress_integration: null,
    green_rep: null,
  };
};

const handleCheckInStateTurn = ({ userMessage, checkInProgress, lastRep, messages, map }) => {
  let flow = advanceCheckInConversation(checkInProgress, userMessage, {
    lastRepName: lastRep?.name,
    map,
  });

  let guard = 0;
  while (
    guard < 3 &&
    !flow.ready_for_coaching &&
    flow.assistant_message &&
    nextQuestionWouldRepeat(flow.assistant_message, messages)
  ) {
    const bumped = bumpCheckInStep(flow.progress);
    flow = advanceCheckInConversation(bumped, userMessage, {
      lastRepName: lastRep?.name,
      map,
    });
    guard += 1;
  }

  if (
    !flow.ready_for_coaching &&
    !flow.assistant_message &&
    isCheckInActive(flow.progress)
  ) {
    const q = questionForStep(flow.progress.step, {
      lastRepName: lastRep?.name,
      answers: flow.progress.answers,
    });
    if (q && !nextQuestionWouldRepeat(q, messages)) {
      flow = { ...flow, assistant_message: q, session_phase: "check_in" };
    }
  }

  return {
    coach_state: COACH_STATE.CHECK_IN,
    session_phase: flow.session_phase,
    assistant_message: flow.assistant_message,
    ready_for_coaching: flow.ready_for_coaching,
    check_in_progress: flow.progress,
    progress_integration: null,
    green_rep: null,
  };
};

const resolveCoachTurn = ({
  userMessage,
  messages = [],
  openSession = null,
  checkInProgress: rawCheckIn,
  stage1,
  domain,
  map,
  userSelectedState: _userSelectedState = "clear",
}) => {
  const checkInProgress = normalizeCheckInProgress(rawCheckIn);
  const memoryForRep = map?.coaching_memory || map;
  const lastRep = resolveLastGreenRep(memoryForRep, map, checkInProgress?.continuity);
  const savedProgress = normalizeProgressIntegration(openSession?.progress_integration);

  const proof = proofPriorityOverride(userMessage, messages, {
    lastRepName: lastRep?.name,
    checkInAnswers: checkInProgress?.answers,
    progressIntegration: openSession?.progress_integration,
    continuity: checkInProgress?.continuity,
  });

  const inProgressIntegration =
    isProgressIntegrationActive(openSession?.progress_integration) ||
    openSession?.coach_state_last === COACH_STATE.PROGRESS ||
    openSession?.coach_state_last === COACH_STATE.POST_PROOF_DEVALUATION ||
    openSession?.coach_state_last === COACH_STATE.WOUND_EDGE ||
    openSession?.coach_state_last === COACH_STATE.FLIP_INSTALL ||
    isWoundFlipActive(openSession?.progress_integration) ||
    Boolean(savedProgress?.proof_logged || savedProgress?.answers?.acknowledge_note);

  if (proof.override || inProgressIntegration) {
    return handleProgressStateTurn({
      userMessage,
      messages,
      openSession,
      stage1,
      domain,
      map,
      lastRep,
      checkInProgress,
    });
  }

  if (isDiscoveryActive(checkInProgress?.discovery)) {
    return { ...handleDiscoveryTurn({ userMessage, checkInProgress }), stage1 };
  }

  const turnSignals = detectProgressSignals(userMessage, { lastRepName: lastRep?.name });
  if (
    detectStruggleSetback(userMessage) &&
    !turnSignals.isStrong &&
    !turnSignals.hasProof
  ) {
    return { ...handleDiscoveryTurn({ userMessage, checkInProgress }), stage1 };
  }

  if (isCheckInActive(checkInProgress)) {
    const downplayAfterProof = detectPostProofDevaluation(
      userMessage,
      turnSignals,
      savedProgress,
    );
    if (turnSignals.isStrong && downplayAfterProof) {
      return handleProgressStateTurn({
        userMessage,
        messages,
        openSession,
        stage1,
        domain,
        map,
        lastRep,
        checkInProgress,
      });
    }

    const checkIn = handleCheckInStateTurn({
      userMessage,
      checkInProgress,
      lastRep,
      messages,
      map,
    });
    if (!checkIn.ready_for_coaching) return { ...checkIn, stage1 };

    const proofAfterCheckin = detectProgressSignals(userMessage, { lastRepName: lastRep?.name });
    if (proofAfterCheckin.isStrong || downplayAfterProof) {
      return handleProgressStateTurn({
        userMessage,
        messages,
        openSession,
        stage1,
        domain,
        map,
        lastRep,
        checkInProgress: checkIn.check_in_progress,
      });
    }
    return { ...checkIn, stage1 };
  }

  if (savedProgress?.answers?.acknowledge_note || savedProgress?.proof_logged) {
    return handleProgressStateTurn({
      userMessage,
      messages,
      openSession,
      stage1,
      domain,
      map,
      lastRep,
      checkInProgress,
    });
  }

  return {
    coach_state: COACH_STATE.COACHING,
    session_phase: "coaching",
    assistant_message: null,
    ready_for_coaching: true,
    check_in_progress: checkInProgress,
    progress_integration: openSession?.progress_integration || null,
    green_rep: null,
    proof_signals: proof.signals,
    stage1,
  };
};

module.exports = {
  COACH_STATE,
  COACH_SUBSTATE,
  resolveCoachTurn,
  proofPriorityOverride,
  detectProgressSignals,
  scanTranscriptForProof,
  handleProgressStateTurn,
  sanitizeCoachGreenRep,
  buildProgressCoachingInstructions,
  maybeAutoLogProof,
};
