const { resolveLastGreenRep } = require("./stage1CoachCheckInFlow");
const { recordProof } = require("./stage1Proof");
const { handleWoundFlipTurn } = require("./stage1CoachWoundFlip");

const PROGRESS_STEPS = Object.freeze({
  ACKNOWLEDGE: "acknowledge",
  REFLECT: "reflect_on_action",
  POST_PROOF_DEVALUATION: "post_proof_devaluation",
  MEANING_REFLECTION: "meaning_reflection",
  WOUND_EDGE: "wound_edge",
  FLIP_LEVERAGE: "flip_leverage",
  INTEGRATION_COMPLETE: "integration_complete",
  COMPLETE: "complete",
});

const COACH_SUBSTATE = Object.freeze({
  PROGRESS: "progress",
  POST_PROOF_DEVALUATION: "post_proof_devaluation",
  POST_PROOF_DEVALUATION_LOOP: "post_proof_devaluation_loop",
  WOUND_EDGE: "wound_edge",
  FLIP_INSTALL: "flip_install",
  COACHING: "coaching",
});

const PROOF_PATTERNS = [
  /\bgenerated\b/i,
  /\bearned\b/i,
  /\bmade\s+\$?\d/i,
  /\$\d+/i,
  /\d+\s*(?:dollar|\/hr|per hour|an hour|an hr|hour)/i,
  /\b\d+\s*(?:dollar|bucks?)\b/i,
  /\ban\s*hr\b/i,
  /\bcompeted\b/i,
  /\bcompleted\b/i,
  /\breached\s+out\b/i,
  /\boutreach\b/i,
  /\bcontacted\b/i,
  /\bclient\b/i,
  /\bsent\s+(?:the\s+)?(?:message|email|proposal)/i,
  /\bbooked\b/i,
  /\bcompleted\s+(?:the\s+)?(?:rep|green\s+rep)/i,
  /\bi\s+completed\s+it\b/i,
  /\bi\s+did\s+it\b/i,
  /\bdid\s+(?:the\s+)?(?:rep|outreach)/i,
  /\bfinished\b/i,
  /\blogged\s+proof\b/i,
  /\bproof\s+logged\b/i,
  /\bmilestone\b/i,
  /\bachieved\b/i,
  /\btook\s+action\b/i,
  /\bvisible\s+action\b/i,
  /\bproof\s+of\b/i,
];

const DEVALUATION_PATTERNS = [
  /\bnot\s+enough\b/i,
  /\bnot\s+good\s+enough\b/i,
  /\bdoesn'?t\s+feel\s+like\s+enough\b/i,
  /\bstill\s+not\b/i,
  /\bshould\s+be\s+more\b/i,
  /\bonly\s+\$/i,
  /\bless\s+money\b/i,
  /\bso+?\s+less\b/i,
  /\btoo\s+less\b/i,
  /\btoo\s+small\b/i,
  /\btoo\s+low\b/i,
  /\bit'?s\s+small\b/i,
  /\bjust\s+\d/i,
  /\bonly\s+\d/i,
  /\bdidn'?t\s+get\s+enough\b/i,
  /\bminor\b/i,
  /\bmeaningless\b/i,
  /\bdoesn'?t\s+count\b/i,
  /\btoo\s+little\b/i,
  /\bworking\s+too\s+little\b/i,
  /\bfelt\s+bad\b/i,
  /\bwon'?t\s+(?:be\s+)?enough\b/i,
  /\bnever\s+enough\b/i,
];

const GROUNDING_QUESTIONS = [
  "What standard are you measuring this against?",
  "What number would this have to hit before it counts in your mind?",
  "Where did the rule come from that a win this size doesn't count?",
];

const REFLECT_QUESTIONS = [
  "What did you notice about yourself when you took that step?",
  "What feels different about you after getting that result?",
];

const VAGUE_ANSWER =
  /^(yes|yeah|yep|yup|idk|i\s+don'?t\s+know|nothing\s+much|not\s+much|not\s+sure|no\s+idea|tho|ok|okay|sure|mm+|hm+)\s*$/i;

const COGNITIVE_BUCKET =
  /standard|enough|count|matter|notice|different|measuring|number|rule|proof|land/;

const normalizeQuestionKey = (q) =>
  String(q || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

const initProgressIntegration = (signals = {}) => ({
  step: PROGRESS_STEPS.ACKNOWLEDGE,
  proof_logged: false,
  devaluation_package_sent: false,
  devaluation_loop_complete: false,
  wound_edge_asked: false,
  flip_complete: false,
  signals: signals || {},
  questions_asked: [],
  last_question_key: null,
  last_question_text: null,
  answers: {
    acknowledge_note: null,
    reflect_note: null,
    devaluation_note: null,
    meaning_reflection: null,
    active_core_wound: null,
    avoidance_rule: null,
    leverage_note: null,
    regression_note: null,
  },
});

const normalizeProgressIntegration = (raw) => {
  if (!raw || typeof raw !== "object") return null;
  let step = raw.step;
  if (step === "explore_what_helped") step = PROGRESS_STEPS.REFLECT;
  if (step === "explore_not_enough") step = PROGRESS_STEPS.POST_PROOF_DEVALUATION;
  if (!Object.values(PROGRESS_STEPS).includes(step)) {
    step = PROGRESS_STEPS.ACKNOWLEDGE;
  }
  const base = initProgressIntegration().answers;
  const rawAnswers = raw.answers && typeof raw.answers === "object" ? raw.answers : {};
  return {
    step,
    proof_logged: Boolean(raw.proof_logged),
    devaluation_package_sent: Boolean(raw.devaluation_package_sent),
    devaluation_loop_complete: Boolean(raw.devaluation_loop_complete),
    wound_edge_asked: Boolean(raw.wound_edge_asked),
    flip_complete: Boolean(raw.flip_complete),
    signals: raw.signals && typeof raw.signals === "object" ? raw.signals : {},
    questions_asked: Array.isArray(raw.questions_asked) ? raw.questions_asked : [],
    last_question_key: raw.last_question_key || null,
    last_question_text: raw.last_question_text || null,
    answers: {
      ...base,
      acknowledge_note: rawAnswers.acknowledge_note ?? null,
      reflect_note: rawAnswers.reflect_note ?? rawAnswers.what_helped ?? null,
      devaluation_note: rawAnswers.devaluation_note ?? rawAnswers.not_enough_feeling ?? null,
      meaning_reflection: rawAnswers.meaning_reflection ?? rawAnswers.forward_note ?? null,
      active_core_wound: rawAnswers.active_core_wound ?? null,
      avoidance_rule: rawAnswers.avoidance_rule ?? null,
      leverage_note: rawAnswers.leverage_note ?? null,
      regression_note: rawAnswers.regression_note ?? null,
    },
  };
};

const detectProgressSignals = (text, context = {}) => {
  const t = String(text || "").trim();
  const lower = t.toLowerCase();
  if (t.length < 3) {
    return { isStrong: false, hasProof: false, repCompleted: false, summary: null };
  }

  const matched = PROOF_PATTERNS.filter((re) => re.test(t));
  const hasIncome =
    /\$|\d+\s*(?:\/hr|per hour|an hour|an hr|hour|dollar)/i.test(t) ||
    /\ban\s*hr\b/i.test(t) ||
    /\d+\s*dollar/i.test(t) ||
    /\bgenerated\b/i.test(t) ||
    /\bearned\b/i.test(t) ||
    /\bmade\b/i.test(t);
  const hasOutreach =
    /\breached\s+out\b/i.test(t) ||
    /\boutreach\b/i.test(t) ||
    /\bclient\b/i.test(t) ||
    /\bcontacted\b/i.test(t);
  const hasCompletion =
    /\b(?:completed|competed|done|finished|worked)\b/i.test(t) ||
    /\bi\s+did\s+it\b/i.test(lower);
  const hasWorkHours =
    /\bworked\b/i.test(t) && /\b\d+\s*(?:hrs?|hours?)\b/i.test(t);
  const hasIncomeBump =
    /\bdouble\b/i.test(t) && /\b(amount|money|pay|income|hour)\b/i.test(t);

  const repCompleted =
    hasCompletion ||
    (hasOutreach && context.lastRepName && /outreach/i.test(context.lastRepName)) ||
    /\b(i did it|i completed|done|finished)\b/i.test(lower);

  const isStrong =
    matched.length >= 1 ||
    hasIncome ||
    hasIncomeBump ||
    hasOutreach ||
    hasCompletion ||
    hasWorkHours ||
    repCompleted ||
    /\bi did it\b/i.test(lower) ||
    /\bi completed\b/i.test(lower);

  return {
    isStrong,
    hasProof: isStrong,
    repCompleted: Boolean(repCompleted || (hasOutreach && hasIncome)),
    hasIncome,
    hasOutreach,
    feelsNotEnough: DEVALUATION_PATTERNS.some((re) => re.test(t)),
    downplaysResult: DEVALUATION_PATTERNS.some((re) => re.test(t)),
    summary: t.slice(0, 280),
    patterns: matched.map(String),
  };
};

const mergeSessionProofSignals = (integration, text, context = {}) => {
  const sessionText = [
    integration?.answers?.acknowledge_note,
    integration?.signals?.summary,
  ]
    .filter(Boolean)
    .join(" ");
  const fromSession = sessionText
    ? detectProgressSignals(sessionText, context)
    : { isStrong: false, hasProof: false };
  const fromTurn = detectProgressSignals(text, context);
  return {
    ...fromSession,
    ...fromTurn,
    isStrong: Boolean(fromTurn.isStrong || fromSession.isStrong),
    hasProof: Boolean(fromTurn.hasProof || fromSession.hasProof),
    hasIncome: Boolean(fromTurn.hasIncome || fromSession.hasIncome),
    hasOutreach: Boolean(fromTurn.hasOutreach || fromSession.hasOutreach),
    repCompleted: Boolean(fromTurn.repCompleted || fromSession.repCompleted),
    feelsNotEnough: Boolean(fromTurn.feelsNotEnough || fromSession.feelsNotEnough),
    downplaysResult: Boolean(fromTurn.downplaysResult || fromSession.downplaysResult),
  };
};

const sessionHasProof = (integration) => {
  const state = normalizeProgressIntegration(integration);
  return Boolean(
    state?.proof_logged ||
      state?.answers?.acknowledge_note ||
      state?.signals?.hasProof ||
      state?.signals?.isStrong,
  );
};

/** Downplay after documented proof → POST_PROOF_DEVALUATION_LOOP */
const detectPostProofDevaluation = (text, signals, integration, continuity = null) => {
  const hasProofContext =
    sessionHasProof(integration) ||
    signals?.isStrong ||
    signals?.hasProof ||
    Boolean(continuity?.had_proof);
  if (!hasProofContext) return false;
  const t = String(text || "").trim();
  if (!t) return false;
  return Boolean(
    signals?.downplaysResult ||
      signals?.feelsNotEnough ||
      DEVALUATION_PATTERNS.some((re) => re.test(t)),
  );
};

/** Seed progress state from prior session so first reply does not reset proof context */
const buildProgressIntegrationFromContinuity = (continuity) => {
  if (!continuity?.had_proof) return null;
  const integration = initProgressIntegration({ isStrong: true, hasProof: true });
  integration.proof_logged = true;
  integration.answers.acknowledge_note =
    continuity.recent_proof?.[0] || continuity.recent_proof?.[1] || null;
  return integration;
};

const shouldEnterProgressMode = (signals, { userState, checkInAnswers } = {}) => {
  if (userState === "progress") return true;
  if (signals?.isStrong || signals?.hasProof) return true;
  if (checkInAnswers?.green_rep_completed === true) return true;
  const since = checkInAnswers?.since_last_session || "";
  if (since && detectProgressSignals(since, {}).isStrong) return true;
  return false;
};

const isVagueAnswer = (text) => {
  const t = String(text || "").trim();
  return !t || VAGUE_ANSWER.test(t);
};

const isDuplicateCognitiveQuestion = (candidate, integration) => {
  const key = normalizeQuestionKey(candidate);
  if (!key) return true;
  if (integration?.last_question_key && integration.last_question_key === key) {
    return true;
  }
  const asked = integration?.questions_asked || [];
  if (asked.includes(key)) return true;
  const last = integration?.last_question_key || "";
  if (last && COGNITIVE_BUCKET.test(key) && COGNITIVE_BUCKET.test(last)) {
    return true;
  }
  return false;
};

const pickProgressQuestion = (candidates, integration) => {
  const asked = Array.isArray(integration)
    ? integration.map(normalizeQuestionKey)
    : (integration?.questions_asked || []).map(normalizeQuestionKey);
  const state = Array.isArray(integration) ? { questions_asked: asked } : integration;
  for (const q of candidates) {
    if (!isDuplicateCognitiveQuestion(q, state)) return q;
  }
  return null;
};

const recordQuestion = (integration, question) => {
  const key = normalizeQuestionKey(question);
  if (!key) return;
  if (!integration.questions_asked.includes(key)) {
    integration.questions_asked.push(key);
  }
  integration.last_question_key = key;
  integration.last_question_text = String(question || "").trim();
};

const proofSummaryLine = (integration, signals) => {
  const note =
    integration?.answers?.acknowledge_note ||
    signals?.summary ||
    "what you just reported";
  if (/dollar|hr|\$|\d/i.test(note)) {
    return `You moved on income (${note}) — that is real-world proof.`;
  }
  if (signals?.hasOutreach) {
    return `You took visible outreach action (${note}) — that is real-world proof.`;
  }
  return `You followed through (${note}) — that is real-world proof.`;
};

const buildProgressAcknowledgment = (signals, context = {}) => {
  const { patterns = [], map } = context;
  const resistanceNote =
    patterns.find((p) => /overthink|delay|avoid|sleep/i.test(p)) ||
    map?.top_3_avoidance_behaviours?.[0] ||
    "delaying action";

  const lines = ["That's important."];
  lines.push("");
  lines.push(`You previously identified ${resistanceNote} as a major resistance.`);
  if (signals.hasIncome || signals.hasOutreach) {
    lines.push("Today you took action toward your goal.");
    if (signals.hasIncome) {
      lines.push("You moved on income — that is proof, not theory.");
    }
  }
  return lines.join("\n");
};

/** POST_PROOF_DEVALUATION_LOOP — each element once only, then STOP after one grounding Q */
const buildPostProofDevaluationPackageOnce = (integration, signals, context = {}) => {
  const { patterns = [], map } = context;
  const distortionLabel =
    patterns.find((p) => /overthink|never|enough|delay/i.test(p)) ||
    map?.top_3_avoidance_behaviours?.find((p) => /overthink/i.test(p)) ||
    "the never-enough loop";

  const groundingQ =
    pickProgressQuestion(GROUNDING_QUESTIONS, integration) || GROUNDING_QUESTIONS[0];

  const ack = proofSummaryLine(integration, signals).replace(
    / — that is real-world proof\.$/,
    " — that counts.",
  );

  return [
    ack,
    `Hearing "not enough" after a win is often ${distortionLabel} — value gets discounted before it lands.`,
    "The action still happened in the real world.",
    groundingQ,
  ].join("\n\n");
};

/** User answered grounding Q (or couldn't) — close loop, no new questions */
const buildPostLoopFollowUp = (text) => {
  const t = String(text || "");
  if (/\b24\s*hrs?|\b7\s*days\b|all\s*day|every\s*day|non.?stop/i.test(t)) {
    return [
      "Working 24/7 rarely satisfies a 'not enough' feeling — it usually deepens it.",
      "",
      "What you already did still counts for this week. We're not adding a bigger grind today.",
    ].join("\n\n");
  }
  return buildDevaluationLoopClose(true);
};

const buildDevaluationLoopClose = (vague = false) => {
  if (vague) {
    return [
      "That's okay — you don't have to answer that cleanly right now.",
      "",
      "Hold that the action happened. We're not pushing the next step today.",
    ].join("\n\n");
  }
  return [
    "Thank you — that matters.",
    "",
    "Let this result count for today. No next action or milestone push from here.",
  ].join("\n\n");
};

const buildPostProofDevaluationMessage = buildPostProofDevaluationPackageOnce;
const buildMeaningIntegrationClose = () => buildDevaluationLoopClose(false);

/** Non-devaluation path: close without pushing next milestone */
const buildProgressClosing = (signals, context = {}) => {
  void context;
  if (signals?.hasIncome) {
    return [
      "You generated income — that's proof you can move in the real world.",
      "",
      "Let that land before we plan anything else.",
    ].join("\n");
  }
  return [
    "You have proof on the board — action happened outside your head.",
    "",
    "Let that land. We can pick up planning when you're ready.",
  ].join("\n");
};

const appendQuestionToAck = (ackBody, question) => {
  const q = String(question || "").trim();
  if (!q) return ackBody;
  return `${ackBody}\n\n${q}`;
};

const appendDevaluationNote = (state, text) => {
  if (!text) return;
  state.answers.devaluation_note = [state.answers.devaluation_note, text]
    .filter(Boolean)
    .join(" | ");
};

/** Enter loop once — never repeat validation package */
const enterPostProofDevaluationLoop = (state, text, signals, context) => {
  if (state.devaluation_package_sent) {
    return finishPostProofDevaluationLoop(state, text);
  }
  appendDevaluationNote(state, text);
  const body = buildPostProofDevaluationPackageOnce(state, signals, context);
  const groundingQ = body.split("\n").find((l) => l.trim().endsWith("?")) || GROUNDING_QUESTIONS[0];
  recordQuestion(state, groundingQ);
  state.devaluation_package_sent = true;
  state.step = PROGRESS_STEPS.MEANING_REFLECTION;
  return {
    assistant_message: body,
    session_phase: "post_proof_devaluation_loop",
    coach_state: COACH_SUBSTATE.POST_PROOF_DEVALUATION_LOOP,
    ready_for_resistance_coaching: false,
  };
};

/** After grounding question — STOP (no re-validation, no second cognitive Q) */
const finishPostProofDevaluationLoop = (state, text) => {
  if (text) state.answers.meaning_reflection = text;
  appendDevaluationNote(state, text);
  state.devaluation_loop_complete = true;
  state.step = PROGRESS_STEPS.WOUND_EDGE;
  return {
    assistant_message: buildDevaluationLoopClose(isVagueAnswer(text)),
    session_phase: "proof_integration_complete",
    coach_state: COACH_SUBSTATE.POST_PROOF_DEVALUATION_LOOP,
    ready_for_resistance_coaching: false,
  };
};

const advanceProgressIntegration = (integration, userMessage, context = {}) => {
  const state =
    normalizeProgressIntegration(integration) || initProgressIntegration(context.signals);
  const text = String(userMessage || "").trim();
  const signals = mergeSessionProofSignals(state, text, context);
  state.signals = { ...state.signals, ...signals };

  const baseReturn = (overrides) => ({
    integration: state,
    session_phase: "proof_integration",
    coach_state: COACH_SUBSTATE.PROGRESS,
    ready_for_resistance_coaching: false,
    should_log_proof: false,
    ...overrides,
  });

  const devaluation = detectPostProofDevaluation(
    text,
    signals,
    state,
    context.continuity,
  );

  if (
    state.step === PROGRESS_STEPS.MEANING_REFLECTION &&
    !state.devaluation_loop_complete
  ) {
    return baseReturn(finishPostProofDevaluationLoop(state, text));
  }

  if (
    state.devaluation_loop_complete ||
    state.step === PROGRESS_STEPS.WOUND_EDGE ||
    state.step === PROGRESS_STEPS.FLIP_LEVERAGE ||
    state.step === PROGRESS_STEPS.INTEGRATION_COMPLETE
  ) {
    const wf = handleWoundFlipTurn(state, text, context);
    if (wf) {
      return baseReturn({
        assistant_message: wf.assistant_message,
        session_phase: wf.session_phase,
        coach_state: wf.coach_state,
        ready_for_resistance_coaching: wf.ready_for_resistance_coaching,
        diagnostic_observation: wf.diagnostic_observation,
      });
    }
  }

  if (state.devaluation_package_sent) {
    return baseReturn(finishPostProofDevaluationLoop(state, text));
  }

  if (devaluation && !state.devaluation_package_sent) {
    if (
      state.step === PROGRESS_STEPS.REFLECT ||
      state.step === PROGRESS_STEPS.COMPLETE ||
      state.step === PROGRESS_STEPS.POST_PROOF_DEVALUATION ||
      state.step === PROGRESS_STEPS.ACKNOWLEDGE
    ) {
      return baseReturn(enterPostProofDevaluationLoop(state, text, signals, context));
    }
  }

  if (state.step === PROGRESS_STEPS.ACKNOWLEDGE) {
    if (!text && !signals.isStrong) {
      const q = pickProgressQuestion(REFLECT_QUESTIONS, state);
      recordQuestion(state, q);
      return baseReturn({
        assistant_message: appendQuestionToAck(
          buildProgressAcknowledgment(signals, context),
          q,
        ),
        should_log_proof: !state.proof_logged && signals.isStrong,
      });
    }

    state.answers.acknowledge_note = state.answers.acknowledge_note || text || signals.summary;

    if (devaluation) {
      return baseReturn(enterPostProofDevaluationLoop(state, text, signals, context));
    }

    state.step = PROGRESS_STEPS.REFLECT;
    const reflectQ = pickProgressQuestion(REFLECT_QUESTIONS, state);
    recordQuestion(state, reflectQ);
    return baseReturn({
      assistant_message: appendQuestionToAck(buildProgressAcknowledgment(signals, context), reflectQ),
      should_log_proof: !state.proof_logged && signals.isStrong,
    });
  }

  if (state.step === PROGRESS_STEPS.REFLECT) {
    if (!text || isVagueAnswer(text)) {
      if (sessionHasProof(state) && !state.devaluation_package_sent) {
        return baseReturn(enterPostProofDevaluationLoop(state, text || "not enough", signals, context));
      }
      if (state.devaluation_package_sent) {
        return baseReturn(finishPostProofDevaluationLoop(state, text));
      }
      const reflectQ = pickProgressQuestion(REFLECT_QUESTIONS, state);
      if (!reflectQ) {
        state.step = PROGRESS_STEPS.COMPLETE;
        return baseReturn({
          assistant_message: buildProgressClosing(signals, context),
          session_phase: "proof_integration_complete",
          coach_state: COACH_SUBSTATE.COACHING,
          ready_for_resistance_coaching: false,
        });
      }
      recordQuestion(state, reflectQ);
      return baseReturn({ assistant_message: reflectQ });
    }

    state.answers.reflect_note = text;
    if (devaluation) {
      return baseReturn(enterPostProofDevaluationLoop(state, text, signals, context));
    }

    state.step = PROGRESS_STEPS.COMPLETE;
    return baseReturn({
      assistant_message: buildProgressClosing(signals, context),
      session_phase: "proof_integration_complete",
      coach_state: COACH_SUBSTATE.COACHING,
      ready_for_resistance_coaching: false,
    });
  }

  if (state.step === PROGRESS_STEPS.COMPLETE) {
    if (state.devaluation_loop_complete && !state.flip_complete) {
      const wf = handleWoundFlipTurn(state, text, context);
      if (wf) {
        return baseReturn({
          assistant_message: wf.assistant_message,
          session_phase: wf.session_phase,
          coach_state: wf.coach_state,
          ready_for_resistance_coaching: wf.ready_for_resistance_coaching,
          diagnostic_observation: wf.diagnostic_observation,
        });
      }
    }
    if (devaluation) {
      return baseReturn(enterPostProofDevaluationLoop(state, text, signals, context));
    }
    return baseReturn({
      assistant_message: buildProgressClosing(signals, context),
      session_phase: "proof_integration_complete",
      coach_state: COACH_SUBSTATE.COACHING,
      ready_for_resistance_coaching: false,
    });
  }

  if (state.step === PROGRESS_STEPS.POST_PROOF_DEVALUATION) {
    if (state.devaluation_package_sent) {
      return baseReturn(finishPostProofDevaluationLoop(state, text));
    }
    return baseReturn(enterPostProofDevaluationLoop(state, text, signals, context));
  }

  return baseReturn({
    assistant_message: buildProgressClosing(signals, context),
    session_phase: "proof_integration_complete",
    coach_state: COACH_SUBSTATE.COACHING,
    ready_for_resistance_coaching: false,
  });
};

const isProgressIntegrationActive = (integration) => {
  const state = normalizeProgressIntegration(integration);
  if (!state) return false;
  if (state.devaluation_loop_complete && !state.flip_complete) return true;
  return (
    state.step !== PROGRESS_STEPS.COMPLETE &&
    state.step !== PROGRESS_STEPS.INTEGRATION_COMPLETE
  );
};

const isWoundFlipActive = (integration) => {
  const state = normalizeProgressIntegration(integration);
  return Boolean(
    state &&
      (state.step === PROGRESS_STEPS.WOUND_EDGE ||
        state.step === PROGRESS_STEPS.FLIP_LEVERAGE ||
        (state.devaluation_loop_complete && !state.flip_complete)),
  );
};

const isPostProofDevaluationActive = (integration) => {
  const state = normalizeProgressIntegration(integration);
  return (
    (state?.step === PROGRESS_STEPS.POST_PROOF_DEVALUATION ||
      state?.step === PROGRESS_STEPS.MEANING_REFLECTION) &&
    !state?.devaluation_loop_complete
  );
};

const sanitizeCoachGreenRep = (
  greenRep,
  {
    progressMode = false,
    proofIntegrationActive = false,
    postProofDevaluation = false,
    lastRepName = null,
    allowNewRep = false,
    userReportedProof = false,
  } = {},
) => {
  if (!greenRep || typeof greenRep !== "object") return null;
  const name = String(greenRep.name || "").trim();
  if (!name) return null;

  if (proofIntegrationActive || postProofDevaluation || context.woundFlipActive) return null;
  if (progressMode && userReportedProof && !allowNewRep) return null;
  if (progressMode && lastRepName && name.toLowerCase() === lastRepName.toLowerCase()) {
    return null;
  }
  return greenRep;
};

const buildProgressCoachingInstructions = (_signals, integration, context = {}) => {
  if (isWoundFlipActive(integration)) {
    return (
      "WOUND_EDGE / FLIP_INSTALL active. Do NOT assign Green Rep. One question per turn. " +
      "No re-validation of proof. No milestone push."
    );
  }
  if (isPostProofDevaluationActive(integration)) {
    return (
      "POST_PROOF_DEVALUATION_LOOP active. Do NOT assign Green Rep. Do NOT repeat validation. " +
      "One grounding question only, then STOP. No repeated reflection loops."
    );
  }
  const repName = context.lastRepName || "the last Green Rep";
  return (
    "Proof integration. Do NOT re-assign " +
    repName +
    ". Do NOT push next milestone. Return green_rep: null."
  );
};

const maybeAutoLogProof = (stage1, domain, userMessage, signals, lastRepName) => {
  if (!signals?.hasProof || String(userMessage || "").trim().length < 8) {
    return { stage1, proof: null };
  }
  const result = recordProof(stage1, {
    domain,
    action: String(userMessage).trim().slice(0, 500),
    type: "action",
    green_rep_name: lastRepName || null,
  });
  if (!result.ok) return { stage1, proof: null };
  return { stage1: result.stage1, proof: result.proof };
};

module.exports = {
  PROGRESS_STEPS,
  COACH_SUBSTATE,
  initProgressIntegration,
  normalizeProgressIntegration,
  detectProgressSignals,
  detectPostProofDevaluation,
  mergeSessionProofSignals,
  shouldEnterProgressMode,
  advanceProgressIntegration,
  isProgressIntegrationActive,
  isWoundFlipActive,
  isPostProofDevaluationActive,
  sanitizeCoachGreenRep,
  buildProgressAcknowledgment,
  buildPostProofDevaluationMessage,
  buildPostProofDevaluationPackageOnce,
  buildProgressIntegrationFromContinuity,
  enterPostProofDevaluationLoop,
  finishPostProofDevaluationLoop,
  buildPostLoopFollowUp,
  isVagueAnswer,
  buildProgressClosing,
  buildProgressCoachingInstructions,
  maybeAutoLogProof,
  normalizeQuestionKey,
  pickProgressQuestion,
  resolveLastGreenRep,
};
