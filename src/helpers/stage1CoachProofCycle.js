/**
 * Proof-gated rep cycle: Rep → Proof Log → Brief Integration → Next Rep.
 * Only applies when a structured Green Rep was assigned this session.
 */

const { listProofLogs } = require("./stage1Proof");
const {
  detectRepCompletion,
  REP_STAGNATION_PATTERN,
  SOLO_REP_PROGRESSION,
} = require("./stage1CoachConversationSignals");

const PROOF_CYCLE_STEPS = Object.freeze({
  IDLE: "idle",
  AWAITING_PROOF_LOG: "awaiting_proof_log",
  INTEGRATION_QUESTION: "integration_question",
  REFLECTION: "reflection",
});

const {
  detectVagueStuck,
  detectUserActionReport,
  hasCoachActionThisSession,
  buildInvestigateStuckMessage,
  buildStructuralReflectionOpen,
  buildPatternExposureFollowUp,
  buildReflectionCompleteDirective,
  recordCompletedAction,
  isActionFamilyBlocked,
  classifyActionFamily,
} = require("./stage1CoachStructuralReflection");

const INTEGRATION_QUESTIONS = Object.freeze({
  progress: "What do you think made the biggest difference?",
  no_change: "What were you expecting to be different that didn't change?",
  resistance: "What part felt hardest?",
});

const INTERVENTION_LOOP_PHRASES = [
  /your voice matters/i,
  /express your truth/i,
  /be visible/i,
  /challenge the belief/i,
  /perfect to be accepted/i,
];

const PROOF_LOG_HELP_PATTERN =
  /\b(what\s+(?:to|should\s+i)\s+log|what\s+did\s+i\s+complete|what\s+should\s+i\s+(?:exactly\s+)?type|how\s+(?:do\s+i|to)\s+log|what\s+to\s+put|example\s+of\s+(?:a\s+)?log)\b/i;

const PROOF_LOG_CLAIM_PATTERN =
  /\b(logged\s+it|added\s+(?:a\s+)?log|added\s+proof|i\s+have\s+added|have\s+logged|proof\s+log(?:ged)?|i\s+logged)\b/i;

const PROOF_DEFERRAL_PATTERN =
  /\b(later|tomorrow|not\s+now|will\s+do\s+(?:that\s+)?later|do\s+it\s+later)\b/i;

const REP_NAME_IN_CHAT =
  /\b(solo\s+truth\s+hold|feeling\s+stay|mirror\s+stay|one\s+line\s+out|green\s+rep)\b/i;

const normalizeProofCycle = (raw) => {
  if (!raw || typeof raw !== "object") {
    return {
      step: PROOF_CYCLE_STEPS.IDLE,
      rep_name: null,
      awaiting_since: null,
      rep_assigned_at: null,
      integration_question: null,
      integration_question_asked: false,
      known_proof_ids: [],
      last_proof_id: null,
      reflection_phase: null,
      reflection_question_asked: false,
      reflection_prior_answer: null,
      completed_actions: [],
    };
  }
  const step = Object.values(PROOF_CYCLE_STEPS).includes(raw.step)
    ? raw.step
    : PROOF_CYCLE_STEPS.IDLE;
  return {
    step,
    rep_name: raw.rep_name || null,
    awaiting_since: raw.awaiting_since || null,
    rep_assigned_at: raw.rep_assigned_at || null,
    integration_question: raw.integration_question || null,
    integration_question_asked: Boolean(raw.integration_question_asked),
    known_proof_ids: Array.isArray(raw.known_proof_ids) ? raw.known_proof_ids : [],
    last_proof_id: raw.last_proof_id || null,
    reflection_phase: raw.reflection_phase || null,
    reflection_question_asked: Boolean(raw.reflection_question_asked),
    reflection_prior_answer: raw.reflection_prior_answer || null,
    completed_actions: Array.isArray(raw.completed_actions) ? raw.completed_actions : [],
  };
};

const escapeRegExp = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when a structured rep was named or assigned in assistant messages this session. */
const hasRepAssignedThisSession = (openSession, messages = [], repName = null) => {
  if (!repName) return false;
  const assistantText = (messages || [])
    .filter((m) => m?.role === "assistant")
    .map((m) => String(m.content || ""))
    .join("\n");
  if (!assistantText.trim()) return false;
  if (new RegExp(escapeRegExp(repName), "i").test(assistantText)) return true;
  if (REP_NAME_IN_CHAT.test(assistantText) && /\b(rep|win condition|steps)\b/i.test(assistantText)) {
    return true;
  }
  const cycleRep = openSession?.proof_cycle?.rep_name;
  if (
    cycleRep &&
    String(cycleRep).toLowerCase() === String(repName).toLowerCase() &&
    openSession?.proof_cycle?.rep_assigned_at
  ) {
    return true;
  }
  return false;
};

const findRepDetails = (repName, map = null) => {
  const key = String(repName || "").trim().toLowerCase();
  const fromLadder = SOLO_REP_PROGRESSION.find((r) => r.name.toLowerCase() === key);
  if (fromLadder) return fromLadder;
  const daily = map?.daily_rep;
  if (daily && typeof daily === "object" && String(daily.name || "").toLowerCase() === key) {
    return daily;
  }
  return { name: repName, steps: [], win_condition: null };
};

const buildProofLogGuidance = (repName, map = null, goalContext = null) => {
  const rep = findRepDetails(repName, map);
  const goal = goalContext?.goal_name || map?.goal_title || "your goal";
  const milestone = goalContext?.current_milestone || goalContext?.milestones?.day_7 || null;
  const win = rep.win_condition || "what you actually did";
  const milestoneBit = milestone ? ` Milestone: ${milestone}.` : "";
  const example = buildProofExampleSentence(rep.name || repName, goal);
  return (
    `Tell them to log ONE sentence in + Log Proof describing what they did for "${rep.name}" ` +
    `(win: ${win}) and how it connects to "${goal}".${milestoneBit} ` +
    `Example format: "${example}". Do NOT assign a new Green Rep. Do NOT say "before we move forward".`
  );
};

const PROOF_EXAMPLES = Object.freeze({
  "solo truth hold":
    "Solo Truth Hold: wrote one honest sentence in Notes, read it aloud, did not delete it",
  "feeling stay":
    "Feeling Stay: added one feeling sentence to my truth note and sat with it 60 seconds",
  "mirror stay":
    "Mirror Stay: said my sentence to the mirror, held eye contact 30 sec, noticed tight chest",
  "one line out":
    "One Line Out: wrote one unsent true sentence and saved it for tomorrow",
});

const buildProofExampleSentence = (repName, goal) => {
  const key = String(repName || "").trim().toLowerCase();
  if (PROOF_EXAMPLES[key]) return PROOF_EXAMPLES[key];
  return `${repName}: [what you did in one sentence tied to ${goal}]`;
};

/** Deterministic, copy-paste-ready proof help for the UI. */
const buildProofHelpResponse = (repName, map = null, goalContext = null) => {
  const rep = findRepDetails(repName, map);
  const goal = goalContext?.goal_name || map?.goal_title || "your goal";
  const example = buildProofExampleSentence(rep.name || repName, goal);
  const win = rep.win_condition ? `\nWin condition: ${rep.win_condition}` : "";
  return (
    `Use + Log Proof in Progress and paste something like:\n\n` +
    `"${example}"\n\n` +
    `One sentence — what you did for "${rep.name}" and how it connects to "${goal}".${win}`
  );
};

const domainProofIds = (stage1, domain) =>
  (listProofLogs(stage1, { domain, limit: 30 }) || []).map((p) => p.id);

const detectNewProof = (stage1, domain, knownIds = []) => {
  const proofs = listProofLogs(stage1, { domain, limit: 10 });
  const known = new Set(knownIds);
  return proofs.find((p) => !known.has(p.id)) || null;
};

const hasProofForRepCycle = (stage1, domain, repName, { sinceIso } = {}) => {
  const proofs = listProofLogs(stage1, { domain, limit: 30 });
  const since = sinceIso ? new Date(sinceIso).getTime() : 0;
  return proofs.some((p) => {
    const at = new Date(p.created_at).getTime();
    if (!Number.isFinite(at)) return false;
    if (since && at < since) return false;
    if (repName && p.green_rep_name) {
      return p.green_rep_name.toLowerCase() === String(repName).toLowerCase();
    }
    if (since > 0 && at >= since && String(p.action || "").trim().length >= 8) {
      return true;
    }
    return false;
  });
};

const latestProofForRep = (stage1, domain, repName) => {
  const proofs = listProofLogs(stage1, { domain, limit: 10 });
  return (
    proofs.find(
      (p) =>
        repName &&
        p.green_rep_name &&
        p.green_rep_name.toLowerCase() === String(repName).toLowerCase(),
    ) || proofs[0] || null
  );
};

const pickIntegrationQuestion = ({ reports_stagnation, userMessage, proofAction }) => {
  const combined = [userMessage, proofAction].filter(Boolean).join(" ");
  if (/\b(hard|scary|couldn'?t|avoid|froze|shame|anxiety|resist|difficult)\b/i.test(combined)) {
    return { key: "resistance", text: INTEGRATION_QUESTIONS.resistance };
  }
  if (
    reports_stagnation ||
    (REP_STAGNATION_PATTERN && REP_STAGNATION_PATTERN.test(combined)) ||
    /\b(nothing changed|no change|same|didn'?t help|not different)\b/i.test(combined)
  ) {
    return { key: "no_change", text: INTEGRATION_QUESTIONS.no_change };
  }
  return { key: "progress", text: INTEGRATION_QUESTIONS.progress };
};

const buildIntegrationMessage = (q, map = null) => {
  if (q.key === "no_change") {
    return (
      "You completed it and followed through.\n\nThat's useful information — the structure expected a different outcome.\n\n" +
      `${q.text}`
    );
  }
  if (q.key === "resistance") {
    return `You completed it, but the protector still fired.\n\n${q.text}`;
  }
  return `You completed it and logged proof.\n\n${q.text}`;
};

const detectInterventionAdviceLoop = (messages = []) => {
  const assistantTexts = (messages || [])
    .filter((m) => m?.role === "assistant")
    .map((m) => String(m.content || ""));
  if (assistantTexts.length < 2) return false;

  let repeatedFamily = false;
  for (const re of INTERVENTION_LOOP_PHRASES) {
    const hits = assistantTexts.filter((t) => re.test(t)).length;
    if (hits >= 2) repeatedFamily = true;
  }

  let families = 0;
  for (const re of INTERVENTION_LOOP_PHRASES) {
    if (assistantTexts.some((t) => re.test(t))) families += 1;
  }

  return repeatedFamily || (families >= 2 && assistantTexts.length >= 2);
};

const isSubstantiveAnswer = (text) => {
  const t = String(text || "").trim();
  if (t.length < 6) return false;
  if (PROOF_LOG_HELP_PATTERN.test(t)) return false;
  if (PROOF_LOG_CLAIM_PATTERN.test(t) && t.length < 40) return false;
  if (
    detectRepCompletion(t, { hasActiveSessionRep: true }) &&
    t.length < 24 &&
    !/\b(felt|feeling|motivat|harder|easier|different|helped|noticed)\b/i.test(t)
  ) {
    return false;
  }
  return true;
};

const evaluateSessionWrap = ({
  messages = [],
  stage1,
  domain,
  integrationJustCompleted = false,
  proofLoggedThisCycle = false,
}) => {
  const userTurns = (messages || []).filter((m) => m?.role === "user").length;
  const today = new Date().toISOString().slice(0, 10);
  const proofsToday = listProofLogs(stage1, { domain, limit: 20 }).filter((p) =>
    String(p.created_at || "").startsWith(today),
  );
  if (userTurns < 5) return false;
  if (!proofsToday.length && !proofLoggedThisCycle) return false;
  return integrationJustCompleted || userTurns >= 7;
};

const idleProofCycle = (knownIds = []) => ({
  step: PROOF_CYCLE_STEPS.IDLE,
  rep_name: null,
  awaiting_since: null,
  rep_assigned_at: null,
  integration_question: null,
  integration_question_asked: false,
  known_proof_ids: knownIds,
  last_proof_id: null,
  reflection_phase: null,
  reflection_question_asked: false,
  reflection_prior_answer: null,
  completed_actions: [],
});

const resolveProofCycleFlow = ({
  stage1,
  domain,
  messages = [],
  userMessage = "",
  lastRepName = null,
  openSession = null,
  map = null,
  goalContext = null,
  reports_stagnation = false,
  user_completed_current_rep = false,
  rep_assigned_this_session = false,
  coaching_repeat_complaint = false,
} = {}) => {
  const repName = lastRepName || openSession?.green_rep_last?.name || null;
  const sessionRepActive =
    rep_assigned_this_session || hasRepAssignedThisSession(openSession, messages, repName);
  const coachActionActive =
    sessionRepActive || hasCoachActionThisSession(messages, openSession);
  const effectiveRepCompletion = user_completed_current_rep && sessionRepActive;
  const narrativeActionReport =
    detectUserActionReport(userMessage) &&
    coachActionActive &&
    !PROOF_LOG_HELP_PATTERN.test(userMessage);
  const vagueStuck = detectVagueStuck(userMessage);
  const casualCompletionWithCoachAction =
    coachActionActive &&
    !narrativeActionReport &&
    !PROOF_LOG_HELP_PATTERN.test(userMessage) &&
    (effectiveRepCompletion ||
      (!sessionRepActive &&
        /\b(i did that|already did|i did it|done|finished)\b/i.test(userMessage)));

  let cycle = normalizeProofCycle(openSession?.proof_cycle);
  const knownIds =
    cycle.known_proof_ids?.length > 0
      ? cycle.known_proof_ids
      : domainProofIds(stage1, domain);
  const newProof = detectNewProof(stage1, domain, knownIds);
  const repAssignedSince = cycle.rep_assigned_at || openSession?.started_at || null;
  const nextKnownIds = newProof
    ? [newProof.id, ...knownIds.filter((id) => id !== newProof.id)].slice(0, 40)
    : knownIds;

  const base = {
    proof_cycle: { ...cycle, known_proof_ids: nextKnownIds },
    assign_green_rep: false,
    awaiting_proof_log: false,
    proof_integration_mode: false,
    assistant_override: null,
    skip_llm: false,
    coaching_directive: null,
    session_phase: "coaching",
    intervention_advice_loop: detectInterventionAdviceLoop(messages),
    suggest_session_end: false,
    rep_assigned_this_session: sessionRepActive,
  };

  if (vagueStuck) {
    const { buildInvestigationMessage } = require("./stage1CoachInvestigation");
    return {
      ...base,
      skip_llm: true,
      assistant_override: buildInvestigationMessage({
        map,
        activeGoalContext: goalContext,
        userMessage,
        messages,
      }),
      coaching_directive:
        "User expressed uncertainty — INVESTIGATE bottleneck. Do NOT re-diagnose or assign a rep yet.",
      assign_green_rep: false,
    };
  }

  if (!coachActionActive) {
    if (cycle.step !== PROOF_CYCLE_STEPS.IDLE) {
      return { ...base, proof_cycle: idleProofCycle(nextKnownIds) };
    }
    return { ...base, proof_cycle: { ...cycle, known_proof_ids: nextKnownIds } };
  }

  if (coaching_repeat_complaint) {
    return {
      ...base,
      proof_cycle: idleProofCycle(nextKnownIds),
      assign_green_rep: false,
      coaching_directive:
        "User says coaching is repeating. Do NOT assign a rep. Ask what is not changing. No proof log nagging.",
    };
  }

  if (cycle.step === PROOF_CYCLE_STEPS.REFLECTION) {
    const completedActions = cycle.completed_actions || [];
    if (cycle.reflection_question_asked && isSubstantiveAnswer(userMessage)) {
      if (cycle.reflection_phase === "open") {
        const followUp = buildPatternExposureFollowUp({
          map,
          userMessage,
          priorAnswer: cycle.reflection_prior_answer,
        });
        const nextActions = recordCompletedAction(cycle, userMessage, newProof?.action);
        return {
          ...base,
          proof_cycle: {
            ...cycle,
            reflection_phase: "followup",
            reflection_prior_answer: userMessage.trim().slice(0, 500),
            reflection_question_asked: true,
            completed_actions: nextActions,
            known_proof_ids: nextKnownIds,
          },
          proof_integration_mode: true,
          session_phase: "proof_integration",
          skip_llm: true,
          assistant_override: followUp,
          assign_green_rep: false,
          coaching_directive:
            "REFLECTION follow-up — pattern exposure. Do NOT repeat today's action. Do NOT assign a new rep yet. One question only.",
        };
      }

      const suggestEnd =
        evaluateSessionWrap({
          messages,
          stage1,
          domain,
          integrationJustCompleted: true,
          proofLoggedThisCycle: Boolean(newProof),
        }) || coaching_repeat_complaint;
      const nextActions = recordCompletedAction(cycle, userMessage, newProof?.action);
      return {
        ...base,
        proof_cycle: idleProofCycle(nextKnownIds),
        assign_green_rep: false,
        session_phase: "proof_integration_complete",
        suggest_session_end: suggestEnd,
        coaching_directive: suggestEnd
          ? "Reflection complete. Affirm the evidence they gathered against the old prediction. Invite rest — no new rep."
          : "Proof integration complete — evolve failure/success strategy from what changed. " +
            "Do NOT assign a new Green Rep this turn. Next session: disruption → then next-level rep.",
      };
    }

    return {
      ...base,
      proof_cycle: { ...cycle, known_proof_ids: nextKnownIds },
      proof_integration_mode: true,
      session_phase: "proof_integration",
      assign_green_rep: false,
      coaching_directive:
        "Still in structural reflection — wait for their answer. Do NOT repeat the same action recommendation.",
    };
  }

  const actionFamily = classifyActionFamily(userMessage);
  if (
    narrativeActionReport &&
    !cycle.reflection_question_asked &&
    cycle.step !== PROOF_CYCLE_STEPS.AWAITING_PROOF_LOG &&
    !isActionFamilyBlocked(actionFamily, cycle.completed_actions)
  ) {
    const proofAction =
      newProof?.action || latestProofForRep(stage1, domain, repName)?.action || null;
    const openMsg = buildStructuralReflectionOpen({
      map,
      userMessage,
      proofAction,
      lastRepName: repName,
    });
    const nextActions = recordCompletedAction(
      { completed_actions: cycle.completed_actions },
      userMessage,
      proofAction,
    );
    return {
      ...base,
      proof_cycle: {
        ...cycle,
        step: PROOF_CYCLE_STEPS.REFLECTION,
        reflection_phase: "open",
        reflection_question_asked: true,
        reflection_prior_answer: userMessage.trim().slice(0, 500),
        rep_name: repName,
        completed_actions: nextActions,
        known_proof_ids: nextKnownIds,
        last_proof_id: newProof?.id || cycle.last_proof_id,
      },
      proof_integration_mode: true,
      session_phase: "proof_integration",
      skip_llm: true,
      assistant_override: openMsg,
      assign_green_rep: false,
      coaching_directive:
        "STRUCTURAL REFLECTION — acknowledge proof, compare prediction vs reality. Do NOT assign a new rep. Do NOT repeat the same action.",
    };
  }

  const proofSince =
    cycle.awaiting_since || cycle.rep_assigned_at || repAssignedSince || null;
  const proofLoggedForRep =
    Boolean(newProof) ||
    hasProofForRepCycle(stage1, domain, repName, { sinceIso: proofSince });
  const proofHelpQuestion = PROOF_LOG_HELP_PATTERN.test(userMessage);
  const proofClaim = PROOF_LOG_CLAIM_PATTERN.test(userMessage);
  const proofDeferred = PROOF_DEFERRAL_PATTERN.test(userMessage);

  if (
    cycle.step === PROOF_CYCLE_STEPS.INTEGRATION_QUESTION &&
    cycle.integration_question_asked
  ) {
    if (isSubstantiveAnswer(userMessage)) {
      const suggestEnd =
        evaluateSessionWrap({
          messages,
          stage1,
          domain,
          integrationJustCompleted: true,
          proofLoggedThisCycle: true,
        }) || coaching_repeat_complaint;
      return {
        ...base,
        proof_cycle: idleProofCycle(nextKnownIds),
        assign_green_rep: !suggestEnd,
        session_phase: "proof_integration_complete",
        suggest_session_end: suggestEnd,
        coaching_directive: suggestEnd
          ? "Proof integration complete. Reflect their learning in one sentence. They have done enough for today — affirm the win, tell them to rest, and invite them to end the session. Do NOT assign a new Green Rep."
          : "Proof integration complete. Briefly capture what they learned in one sentence, then assign the NEXT Green Rep if appropriate (must differ from last_green_rep).",
      };
    }
    return {
      ...base,
      proof_cycle: { ...cycle, known_proof_ids: nextKnownIds },
      proof_integration_mode: true,
      session_phase: "proof_integration",
      coaching_directive: `Still in proof integration — ask ONE brief question only: "${cycle.integration_question}" Do NOT assign a new Green Rep yet. No lecture.`,
    };
  }

  const shouldEnterIntegration =
    proofLoggedForRep &&
    (cycle.step === PROOF_CYCLE_STEPS.AWAITING_PROOF_LOG ||
      proofClaim ||
      (effectiveRepCompletion && !cycle.integration_question_asked));

  if (shouldEnterIntegration && !cycle.integration_question_asked && !cycle.reflection_question_asked) {
    const proofAction =
      newProof?.action || latestProofForRep(stage1, domain, repName)?.action || null;
    const structuralOpen = buildStructuralReflectionOpen({
      map,
      userMessage,
      proofAction,
      lastRepName: repName,
    });
    const nextActions = recordCompletedAction(cycle, userMessage, proofAction);
    const nextCycle = {
      ...cycle,
      step: PROOF_CYCLE_STEPS.REFLECTION,
      reflection_phase: "open",
      reflection_question_asked: true,
      reflection_prior_answer: userMessage.trim().slice(0, 500),
      integration_question_asked: true,
      integration_question: structuralOpen,
      last_proof_id: newProof?.id || cycle.last_proof_id,
      rep_name: repName,
      completed_actions: nextActions,
      known_proof_ids: nextKnownIds,
    };
    return {
      ...base,
      proof_cycle: nextCycle,
      proof_integration_mode: true,
      session_phase: "proof_integration",
      skip_llm: true,
      assistant_override: structuralOpen,
      coaching_directive:
        "STRUCTURAL REFLECTION after proof — prediction vs reality. Do NOT assign a new rep. Do NOT repeat the same action.",
    };
  }

  if (proofClaim && !proofLoggedForRep) {
    const guidance = buildProofLogGuidance(repName, map, goalContext);
    return {
      ...base,
      proof_cycle: {
        ...cycle,
        step: PROOF_CYCLE_STEPS.AWAITING_PROOF_LOG,
        rep_name: repName,
        awaiting_since: cycle.awaiting_since || new Date().toISOString(),
        known_proof_ids: nextKnownIds,
      },
      awaiting_proof_log: true,
      coaching_directive:
        `User says they logged but no proof entry is in the system yet. ${guidance} ` +
        "Ask them to use + Log Proof in Progress — chatting 'I logged' does not count.",
    };
  }

  if (effectiveRepCompletion && repName && !proofLoggedForRep && !narrativeActionReport) {
    const now = new Date().toISOString();
    const helpText = buildProofHelpResponse(repName, map, goalContext);
    return {
      ...base,
      proof_cycle: {
        ...cycle,
        step: PROOF_CYCLE_STEPS.AWAITING_PROOF_LOG,
        rep_name: repName,
        awaiting_since: cycle.awaiting_since || now,
        rep_assigned_at: cycle.rep_assigned_at || repAssignedSince || now,
        known_proof_ids: nextKnownIds,
      },
      awaiting_proof_log: true,
      skip_llm: true,
      assistant_override: helpText,
      coaching_directive: buildProofLogGuidance(repName, map, goalContext),
    };
  }

  if (cycle.step === PROOF_CYCLE_STEPS.AWAITING_PROOF_LOG && !proofLoggedForRep) {
    if (proofDeferred) {
      return {
        ...base,
        proof_cycle: { ...cycle, known_proof_ids: nextKnownIds },
        awaiting_proof_log: true,
        coaching_directive:
          "User will log later — acknowledge without nagging. Remind them once what to log when they are ready. No new Green Rep.",
      };
    }
    if (proofHelpQuestion) {
      const helpText = buildProofHelpResponse(
        repName || cycle.rep_name,
        map,
        goalContext,
      );
      return {
        ...base,
        proof_cycle: { ...cycle, known_proof_ids: nextKnownIds },
        awaiting_proof_log: true,
        skip_llm: true,
        assistant_override: helpText,
        coaching_directive: buildProofLogGuidance(repName || cycle.rep_name, map, goalContext),
      };
    }
    return {
      ...base,
      proof_cycle: { ...cycle, known_proof_ids: nextKnownIds },
      awaiting_proof_log: true,
      coaching_directive:
        cycle.awaiting_since
          ? buildProofLogGuidance(repName || cycle.rep_name, map, goalContext)
          : "Still waiting for proof log. No new Green Rep.",
    };
  }

  if (
    casualCompletionWithCoachAction &&
    !cycle.reflection_question_asked &&
    !isActionFamilyBlocked(classifyActionFamily(userMessage), cycle.completed_actions)
  ) {
    const openMsg = buildStructuralReflectionOpen({
      map,
      userMessage,
      lastRepName: repName,
    });
    const nextActions = recordCompletedAction(cycle, userMessage);
    return {
      ...base,
      proof_cycle: {
        ...cycle,
        step: PROOF_CYCLE_STEPS.REFLECTION,
        reflection_phase: "open",
        reflection_question_asked: true,
        reflection_prior_answer: userMessage.trim().slice(0, 500),
        completed_actions: nextActions,
        known_proof_ids: nextKnownIds,
      },
      proof_integration_mode: true,
      session_phase: "proof_integration",
      skip_llm: true,
      assistant_override: openMsg,
      assign_green_rep: false,
      coaching_directive:
        "User completed generic coach advice — structural reflection only. Do NOT repeat the same kindness/message action.",
    };
  }

  return base;
};

const onGreenRepAssigned = (proofCycle, repName, knownIds = []) => {
  const cycle = normalizeProofCycle(proofCycle);
  return {
    step: PROOF_CYCLE_STEPS.IDLE,
    rep_name: repName || null,
    rep_assigned_at: new Date().toISOString(),
    awaiting_since: null,
    integration_question: null,
    integration_question_asked: false,
    last_proof_id: null,
    known_proof_ids:
      knownIds.length > 0 ? knownIds : cycle.known_proof_ids || [],
  };
};

module.exports = {
  PROOF_CYCLE_STEPS,
  INTEGRATION_QUESTIONS,
  normalizeProofCycle,
  resolveProofCycleFlow,
  hasProofForRepCycle,
  hasRepAssignedThisSession,
  buildProofLogGuidance,
  buildProofHelpResponse,
  detectInterventionAdviceLoop,
  onGreenRepAssigned,
  PROOF_LOG_HELP_PATTERN,
  PROOF_LOG_CLAIM_PATTERN,
};
