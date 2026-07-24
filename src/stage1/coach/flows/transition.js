/**
 * Code-level coaching phase — stop discovery when resistance/pattern is already known.
 * Prompts alone cannot prevent endless interviewing; Node sets coaching_mode every turn.
 */

const { detectStruggleSetback } = require("../signals/discovery");
const { buildCoachConversationSignals } = require("../signals/conversation");
const { resolvePersistentBarriers } = require("../signals/barriers");
const { humanizePattern } = require("../context/naturalLanguage");
const { buildStructuralCoachBlock } = require("../../../helpers/stage1StructuralFramework");
const {
  buildMilestoneAlignedRep,
  buildMilestonePriorityDirective,
} = require("../utils/milestoneRep");

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

const buildCoachingBrief = (map, memoryCtx, userMessage, { messages = [], stage1 = null, domain = null, proofCycleFlow = null, openSession = null, firstSessionFlow = null, investigationFlow = null, goalContext = null } = {}) => {
  const failure = pickFailureRule(map, memoryCtx);
  const success = pickSuccessRule(map, memoryCtx);
  const protector = map?.protector_rule || memoryCtx?.protector_rule || null;
  const patternLabel = buildPatternLabel(map, memoryCtx, userMessage);
  const msg = String(userMessage || "");
  const isFirstUserTurn = !messages.some((m) => m?.role === "user");
  const persistentBarriers = resolvePersistentBarriers({
    map,
    stage1,
    domain,
    messages,
    userMessage: msg,
  });
  const activeGoalContext =
    goalContext ||
    (domain && map
      ? (() => {
          try {
            const { buildActiveGoalContext } = require("../../../helpers/stage1GoalContext");
            return buildActiveGoalContext(map, domain);
          } catch {
            return null;
          }
        })()
      : null);
  const conversation = buildCoachConversationSignals({
    messages,
    userMessage: msg,
    map,
    memoryCtx,
    persistentBarriers,
    openSession,
    goalContext: activeGoalContext,
    proofCycleFlow,
  });
  const hasActiveRep = Boolean(memoryCtx?.last_green_rep);
  const repCompletedThisTurn = conversation.user_completed_current_rep;
  const userAsksDirectQuestion = /\?/.test(msg);
  const avoidance = reportsAvoidanceOrSetback(msg);

  let assign_green_rep = Boolean(conversation.assign_new_rep);
  // Explicit "how do I start / what next" with no rep active THIS session must
  // break the advice loop by assigning a concrete rep — even when repetition was
  // just detected, and even if a stale rep is carried in memory from a prior
  // session (that historical rep must not lock the member out of a fresh action).
  const explicitWhatNextNoRep =
    conversation.user_asked_what_next &&
    !conversation.has_active_session_rep &&
    !repCompletedThisTurn;
  if (explicitWhatNextNoRep) {
    assign_green_rep = true;
  } else if (conversation.discovery_only_mode || conversation.anti_repeat_active) {
    assign_green_rep = false;
  } else if (
    conversation.reports_stagnation ||
    conversation.solo_ladder_complete ||
    conversation.coaching_repeat_complaint ||
    conversation.repeated_assistant_advice
  ) {
    assign_green_rep = false;
  } else if (conversation.block_rep_reassign) {
    assign_green_rep = false;
  } else if (repCompletedThisTurn) {
    assign_green_rep = false;
  } else if (conversation.needs_solo_rep_adaptation) {
    assign_green_rep = true;
  } else if (
    conversation.user_asked_what_next &&
    repCompletedThisTurn &&
    conversation.has_active_session_rep
  ) {
    assign_green_rep = false;
  } else if (conversation.user_asked_what_next && !hasActiveRep) {
    assign_green_rep = true;
  } else if (isFirstUserTurn && avoidance && !hasActiveRep) {
    assign_green_rep = true;
  } else if (!userAsksDirectQuestion && avoidance && !hasActiveRep && isFirstUserTurn) {
    assign_green_rep = true;
  }

  if (proofCycleFlow) {
    if (
      proofCycleFlow.awaiting_proof_log ||
      proofCycleFlow.proof_integration_mode ||
      proofCycleFlow.suggest_session_end
    ) {
      assign_green_rep = false;
    } else if (proofCycleFlow.assign_green_rep) {
      assign_green_rep = true;
    }
  }

  if (investigationFlow?.active) {
    assign_green_rep = false;
  }

  const allowSoloFallback = Boolean(
    conversation.no_trusted_person &&
      activeGoalContext?.active_domain &&
      !["income", "wealth", "money"].includes(String(activeGoalContext.active_domain).toLowerCase()),
  );

  const suggested_milestone_rep =
    assign_green_rep && map?.map_resistance_complete
      ? buildMilestoneAlignedRep({
          map,
          goalContext: activeGoalContext,
          memoryCtx: memoryCtx,
          allowSoloFallback,
        })
      : null;

  if (conversation.block_clarity_rep || conversation.clarity_saturation || conversation.user_showing_hope_depletion) {
    assign_green_rep = false;
  } else if (conversation.assign_green_rep && conversation.suggested_green_rep) {
    assign_green_rep = true;
  }

  let instruction =
    "Coach conversationally — respond to what they said this turn. " +
    "Use internal_coaching_steps for thinking only; NEVER output labeled template blocks in assistant_message. " +
    "Put Green Rep in green_rep JSON only when assign_green_rep is true; set writeback_hints.assign_new_green_rep accordingly. " +
    "COMPLETED REPS CANNOT BE REASSIGNED: if user_completed_current_rep is true, never repeat the same Green Rep, flip, or diagnosis unless new evidence reactivates it. " +
    "MEMBER SHOULD FEEL REMEMBERED: do not re-explain protector, pattern, hidden prediction, or flip every turn — assume known unless evidence says revisit. " +
    "After proof integration, ask what the NEXT obstacle is — not 'what happened this week' or a full re-diagnosis. " +
    "When assign_green_rep is true, use a DIFFERENT rep than last_green_rep. " +
    "SELF-GENERATED CLARITY: if user already named bottleneck + next action, synthesize with 'Agreed', assign Green Rep — do NOT ask what the next obstacle is. " +
    "EXECUTION MODE: if user confirmed bottleneck + rep + proof, do NOT restate — reinforce focus, completion criteria, review threshold, sample-size rules. " +
    "EXECUTION SUSTAINABILITY: if user knows strategy but reports discouragement/delayed results, acknowledge transition — coach adherence and scoreboard, do NOT reassign rep. " +
    "HOPE DEPLETION: if user questions whether effort will pay off — distinguish from motivation loss. Do NOT repeat rep/scoreboard/plan. Acknowledge fear evolution and investigate emotional cost. " +
    "CONVERT INSIGHT INTO EXECUTION: Insight → Execution Plan → Green Rep → Proof — no more questions unless info is genuinely missing. " +
    "Do NOT ask discovery or hollow reflective questions. " +
    "Lead with goal and milestone — resistance is context, not the headline. " +
    "EVIDENCE OVERRIDES DIAGNOSIS: when user behavior contradicts the active pattern (e.g. outreach sent while diagnosis says invisible), update the pattern — do not coach the old diagnosis. " +
    "DO NOT MISLABEL ACTION AS AVOIDANCE: if user sent outreach/offers/contacts, acknowledge action first — never say 'avoidance ran the day'. " +
    "FUNNEL AWARENESS: do not assign find-prospect or reach-out reps when those funnel stages are already complete. " +
    "NO DIAGNOSIS LOOPS: if same diagnosis repeated without supporting evidence, search for a more accurate bottleneck. " +
    "DIAGNOSIS UPDATE: when user gives proof, compare it to current_failure_strategy. " +
    "If evidence contradicts the diagnosis, refine it and name the next funnel bottleneck — " +
    "never repeat the old pattern or assign backwards funnel steps (e.g. do not re-assign outreach after outreach is done). " +
    "If proof is vague, investigate (how many, what offer, what message, what response) before assigning a new rep.";
  if (proofCycleFlow?.awaiting_proof_log) {
    instruction +=
      " AWAITING PROOF LOG — guide logging only; no new rep, no re-diagnosis.";
  }
  if (proofCycleFlow?.proof_integration_mode) {
    instruction +=
      " PROOF INTEGRATION MODE — one integration question per turn. No protector/flip lecture. No rep assignment.";
  }
  if (conversation.coaching_directive) {
    instruction += ` ${conversation.coaching_directive}`;
  }
  if (proofCycleFlow?.coaching_directive) {
    instruction += ` ${proofCycleFlow.coaching_directive}`;
  }
  if (firstSessionFlow?.coaching_directive) {
    instruction += ` ${firstSessionFlow.coaching_directive}`;
  }
  if (investigationFlow?.coaching_directive) {
    instruction += ` ${investigationFlow.coaching_directive}`;
  }
  if (proofCycleFlow?.intervention_advice_loop) {
    instruction +=
      " ANTI-LOOP: Stop repeating the same intervention family. Ask what is not changing and find the missing leverage point.";
  }
  if (conversation.has_active_session_rep === false && memoryCtx?.member_continuity?.is_returning_member) {
    instruction +=
      " RETURNING MEMBER in ongoing session — do not re-introduce goal or act like first chat. Continue from member_continuity.";
  } else if (memoryCtx?.member_continuity?.is_returning_member) {
    instruction +=
      " RETURNING MEMBER — use COACH_MEMORY_CONTEXT.member_continuity and prior proof/sessions. No first-time discovery.";
  }
  if (assign_green_rep && suggested_milestone_rep) {
    instruction += ` ${buildMilestonePriorityDirective({
      map,
      goalContext: activeGoalContext,
      milestoneRep: suggested_milestone_rep,
    })}`;
  } else if (map?.map_resistance_complete) {
    instruction += ` ${buildMilestonePriorityDirective({ map, goalContext: activeGoalContext })}`;
  }
  if (conversation.suggested_green_rep && assign_green_rep && allowSoloFallback) {
    instruction +=
      " Use conversation_signals.suggested_green_rep in green_rep JSON — not the previous rep.";
  }

  const structural_framework = buildStructuralCoachBlock({
    map,
    memoryCtx,
    userMessage,
    proofCycleFlow,
    transition: {
      coaching_phase: inferSessionPhase(messages, userMessage),
      coaching_brief: { assign_green_rep },
      conversation_signals: conversation,
    },
  });
  if (structural_framework.current_step === "disrupt") {
    instruction +=
      " STRUCTURAL STEP: DISRUPT — tie interrupt to the milestone's next visible action; name resistance only as what blocks THAT action.";
    if (structural_framework.example_coaching_line) {
      instruction += ` Example tone (do not copy verbatim): ${structural_framework.example_coaching_line}`;
    }
  } else if (structural_framework.current_step === "install") {
    instruction +=
      " STRUCTURAL STEP: INSTALL — green rep must embody the discovered flip and advance the active milestone; proof required.";
  }

  if (conversation.coaching_directive && !instruction.includes("SIGNAL:")) {
    instruction += ` ${conversation.coaching_directive}`;
  }

  if (conversation.coaching_context) {
    instruction +=
      " Use conversation_signals.coaching_context for bottleneck/rep/funnel hints — generate fresh wording; do not paste templates.";
  }

  // #region agent log
  try {
    require("../../../helpers/debugIngest").debugIngest(
      "transition.js:assignGate",
      "assign_green_rep gate inputs",
      {
        assign_green_rep,
        conv_assign_new_rep: Boolean(conversation.assign_new_rep),
        conv_suggested_green_rep: Boolean(conversation.suggested_green_rep),
        block_clarity_rep: Boolean(conversation.block_clarity_rep),
        clarity_saturation: Boolean(conversation.clarity_saturation),
        execution_confirmed: Boolean(conversation.execution_confirmed),
        self_generated_clarity: Boolean(conversation.self_generated_clarity),
        user_asked_what_next: Boolean(conversation.user_asked_what_next),
        user_completed_current_rep: Boolean(conversation.user_completed_current_rep),
        has_active_session_rep: Boolean(conversation.has_active_session_rep),
        hasActiveRep_memory: hasActiveRep,
        memory_last_green_rep: memoryCtx?.last_green_rep?.name || memoryCtx?.last_green_rep || null,
        explicitWhatNextNoRep,
        reports_stagnation: Boolean(conversation.reports_stagnation),
        repeated_assistant_advice: Boolean(conversation.repeated_assistant_advice),
        assistant_advice_loop: Boolean(conversation.assistant_advice_loop),
        proof_awaiting: Boolean(proofCycleFlow?.awaiting_proof_log),
        proof_integration: Boolean(proofCycleFlow?.proof_integration_mode),
        investigation_active: Boolean(investigationFlow?.active),
        map_complete: Boolean(map?.map_resistance_complete),
        suggested_milestone_rep: suggested_milestone_rep?.name || null,
        structural_step: structural_framework?.current_step || null,
      },
      "H13",
    );
  } catch {
    /* ignore */
  }
  // #endregion

  return {
    discovery_complete: true,
    pattern_label: patternLabel,
    failure_strategy: failure,
    success_strategy: success,
    protector_rule: protector,
    structural_framework,
    cost_of_pattern:
      "When this pattern runs, proof does not count, motivation collapses, and the goal keeps drifting.",
    internal_coaching_steps: [
      "Current goal and active milestone (lead with these)",
      "Fastest visible action that advances the milestone",
      "Resistance blocking THAT specific action",
      "Failure strategy + success strategy as supporting context only",
      "ONE Green Rep that interrupts resistance AND advances the milestone",
      "Observable proof tied to milestone movement",
    ],
    /** @deprecated alias for Python prompt compatibility */
    required_structure: [
      "Name the pattern in plain language (conversational — not a labeled section)",
      "Explain the cost of repeating it",
      "Reference failure and success strategy in plain words",
      "Assign ONE Green Rep in green_rep JSON only when assign_green_rep is true",
    ],
    assign_green_rep,
    must_assign_green_rep: assign_green_rep,
    suggested_milestone_rep,
    no_reflective_questions: true,
    conversation_signals: conversation,
    instruction,
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
  stage1 = null,
  domain = null,
  proofCycleFlow = null,
  openSession = null,
  firstSessionFlow = null,
  investigationFlow = null,
  goalContext = null,
}) => {
  const persistentBarriers = resolvePersistentBarriers({
    map,
    stage1,
    domain,
    messages,
    userMessage,
  });
  const conversation = buildCoachConversationSignals({
    messages,
    userMessage,
    map,
    memoryCtx: coachMemoryContext,
    persistentBarriers,
    openSession,
    goalContext,
    proofCycleFlow,
  });

  const sessionPhase = inferSessionPhase(messages, userMessage);
  const avoidance = reportsAvoidanceOrSetback(userMessage);
  const known = hasKnownResistance(map, coachMemoryContext);
  const enough = hasEnoughStoredContext(map, coachMemoryContext);
  const patternCount = countPatternOccurrences(coachMemoryContext);
  const lastPattern = coachMemoryContext?.last_ended_session?.detected_pattern;

  const reasons = [];
  const withSignals = (result) => ({ ...result, conversation_signals: conversation });

  const needsConversationalCoaching =
    known &&
    enough &&
    (conversation.no_trusted_person ||
      conversation.user_asked_what_next ||
      conversation.user_repeated_same_point ||
      conversation.user_completed_current_rep ||
      conversation.assistant_advice_loop ||
      conversation.reports_stagnation ||
      conversation.solo_ladder_complete ||
      conversation.user_showing_hope_depletion ||
      conversation.execution_sustainability_issue ||
      conversation.clarity_saturation ||
      conversation.self_generated_clarity ||
      conversation.evidence_contradicts_diagnosis ||
      conversation.stop_discovery ||
      conversation.execution_clarity_established ||
      conversation.insufficient_data_for_analysis ||
      coachMemoryContext?.member_continuity?.is_returning_member);

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

  const discoveryOnly = Boolean(
    conversation.discovery_only_mode || conversation.anti_repeat_active,
  );

  if (discoveryOnly) {
    return withSignals({
      coaching_phase: "explore",
      coaching_mode: "discovery",
      discovery_complete: false,
      stop_discovery: false,
      reasons: ["anti_repeat_discovery_only"],
      coaching_brief: null,
    });
  }

  if (shouldExecute) {
    if (known) reasons.push("resistance_already_mapped");
    if (patternEstablished) reasons.push("pattern_repeated");
    if (avoidance) reasons.push("avoidance_reported");
    if (enough) reasons.push("stored_context_sufficient");

    return withSignals({
      coaching_phase: "execute",
      coaching_mode: "execute",
      discovery_complete: true,
      stop_discovery: true,
      reasons,
      coaching_brief: buildCoachingBrief(map, coachMemoryContext, userMessage, {
        messages,
        stage1,
        domain,
        proofCycleFlow,
        openSession,
        firstSessionFlow,
        investigationFlow,
        goalContext,
      }),
    });
  }

  if (needsConversationalCoaching) {
    return withSignals({
      coaching_phase: conversation.user_repeated_same_point ? "execute" : "directive",
      coaching_mode: "coaching",
      discovery_complete: true,
      stop_discovery: true,
      reasons: ["conversation_barrier_or_repeat"],
      coaching_brief: buildCoachingBrief(map, coachMemoryContext, userMessage, {
        messages,
        stage1,
        domain,
        proofCycleFlow,
        openSession,
        firstSessionFlow,
        investigationFlow,
        goalContext,
      }),
    });
  }

  if (sessionPhase === "directive" || (known && enough && avoidance && lastPattern)) {
    return withSignals({
      coaching_phase: "directive",
      coaching_mode: "coaching",
      discovery_complete: true,
      stop_discovery: true,
      reasons: ["session_story_complete"],
      coaching_brief: buildCoachingBrief(map, coachMemoryContext, userMessage, {
        messages,
        stage1,
        domain,
        proofCycleFlow,
        openSession,
        firstSessionFlow,
        investigationFlow,
        goalContext,
      }),
    });
  }

  if (sessionPhase === "transitioning") {
    return withSignals({
      coaching_phase: "transitioning",
      coaching_mode: "discovery",
      discovery_complete: false,
      stop_discovery: false,
      reasons: ["partial_session_context"],
      coaching_brief: null,
    });
  }

  const missingInfo = !known || !enough;
  return withSignals({
    coaching_phase: "explore",
    coaching_mode: missingInfo ? "discovery" : "coaching",
    discovery_complete: !missingInfo && !avoidance,
    stop_discovery: !missingInfo && known && !avoidance,
    reasons: missingInfo ? ["resistance_or_history_missing"] : ["gathering_first_detail"],
    coaching_brief: null,
  });
};

const { SESSION_PHASES: INTAKE_PHASES } = require("./sessionIntake");

/**
 * Cert v1 + Nathan depth directives — body echo, map reference, edge/cost, training, insight rep.
 */
const applyCertTurnDirectives = ({
  transition,
  sessionIntakeFlow = {},
  proofCycleFlow = null,
  coachMemoryContext = {},
  map = null,
  userMessage = "",
  messages = [],
  goalContext = null,
  openSession = null,
  stage1 = null,
  domain = null,
}) => {
  const next = { ...transition };
  const phase = sessionIntakeFlow.session_phase;
  const signals = {
    ...(next.conversation_signals || next.coaching_brief?.conversation_signals || {}),
  };
  const proofIntegrationActive = Boolean(
    proofCycleFlow?.proof_integration_mode ||
      proofCycleFlow?.session_phase === "proof_integration",
  );

  if (!next.coaching_brief && phase === INTAKE_PHASES.INSIGHT_INTEGRATION) {
    next.coaching_mode = "coaching";
    next.stop_discovery = true;
    next.discovery_complete = true;
    next.coaching_brief = buildCoachingBrief(map, coachMemoryContext, userMessage, {
      messages,
      stage1,
      domain,
      proofCycleFlow,
      openSession,
      goalContext,
    });
  }

  if (signals.discovery_only_mode || signals.anti_repeat_active) {
    next.coaching_mode = "discovery";
    next.stop_discovery = false;
    next.discovery_complete = false;
    next.coaching_phase = "explore";
    if (next.coaching_brief) {
      next.coaching_brief.assign_green_rep = false;
      next.coaching_brief.must_assign_green_rep = false;
      next.coaching_brief.suggested_milestone_rep = null;
      next.coaching_brief.instruction =
        `${signals.coaching_directive || ""} Do NOT assign Green Rep or numbered homework while anti-repeat is active.`.trim();
    } else {
      next.coaching_brief = {
        instruction: signals.coaching_directive,
        assign_green_rep: false,
        must_assign_green_rep: false,
        conversation_signals: signals,
      };
    }
  }

  if (sessionIntakeFlow.body_echo_required && next.coaching_brief && !signals.discovery_only_mode) {
    signals.body_echo_required = true;
    signals.smallest_step_mode = Boolean(sessionIntakeFlow.smallest_step_mode);
    const bodyWords = String(sessionIntakeFlow.felt_sensation || "").trim();
    const intention = String(sessionIntakeFlow.session_intention || "").trim();
    next.coaching_brief.instruction =
      `${next.coaching_brief.instruction || ""} BODY ECHO REQUIRED: echo member body words verbatim once (${bodyWords || "their sensation"}). Link to old pattern in plain language (no vortex jargon). Ask smallest step in the next hour tied to session intention (${intention || "their goal"}) — not generic break advice unless they chose that.`.trim();
  }

  if (
    (phase === INTAKE_PHASES.EXPLORE || phase === INTAKE_PHASES.INSIGHT_INTEGRATION) &&
    !proofIntegrationActive &&
    !signals.discovery_only_mode
  ) {
    signals.map_reference_required = true;
    if (next.coaching_brief) {
      next.coaching_brief.instruction =
        `${next.coaching_brief.instruction || ""} MAP REFERENCE REQUIRED: link one plain-language line to their failure_strategy / flip_belief / active milestone from COACH_MEMORY_CONTEXT before advice or rep.`.trim();
    }
  }

  const edgeFromProof = Boolean(
    proofCycleFlow?.coaching_context?.next_edge_inquiry ||
      proofCycleFlow?.coaching_context?.edge_inquiry_required ||
      signals.edge_inquiry_required,
  );
  const exploreEdgeNeeded =
    (phase === INTAKE_PHASES.EXPLORE || phase === INTAKE_PHASES.INSIGHT_INTEGRATION) &&
    !sessionIntakeFlow.session_intake_update?.edge_inquiry_complete &&
    !proofIntegrationActive;

  if ((edgeFromProof || exploreEdgeNeeded || signals.reports_stagnation) && !signals.discovery_only_mode) {
    signals.edge_inquiry_required = true;
    if (next.coaching_brief) {
      next.coaching_brief.instruction =
        `${next.coaching_brief.instruction || ""} EDGE/COST: Ask ONE plain-language question about what is holding them back OR what moving forward would cost — honour the protective part's good intention — before prescribing action or assigning rep.`.trim();
    }
  }

  const trainingPick =
    coachMemoryContext?.suggested_training?.primary_masterclass ||
    coachMemoryContext?.suggested_training?.picks?.[0] ||
    null;
  const suggestTraining =
    Boolean(phase === INTAKE_PHASES.RESISTANCE_PROBE) ||
    Boolean(sessionIntakeFlow.felt_sensation && (coachMemoryContext?.gravity_rating ?? 0) >= 7) ||
    Boolean(signals.reports_stagnation);
  if (suggestTraining && trainingPick?.title) {
    signals.suggest_training = true;
    signals.suggested_training_pick = trainingPick;
    if (next.coaching_brief) {
      next.coaching_brief.instruction =
        `${next.coaching_brief.instruction || ""} Optionally mention ONE suggested training (${trainingPick.title}) with why_chosen — no lecture.`.trim();
    }
  }

  if (phase === INTAKE_PHASES.INSIGHT_INTEGRATION && !proofIntegrationActive && !signals.discovery_only_mode) {
    signals.insight_integration = true;
    if (next.coaching_brief) {
      next.coaching_brief.assign_green_rep = true;
      next.coaching_brief.must_assign_green_rep = true;
      next.coaching_brief.instruction =
        `${next.coaching_brief.instruction || ""} INSIGHT INTEGRATION: summarize insight in member's words → assign ONE Green Rep → surface proof criteria.`.trim();
    }
    next.stop_discovery = true;
    next.discovery_complete = true;
    next.coaching_mode = "coaching";
  }

  next.conversation_signals = signals;
  if (next.coaching_brief) {
    next.coaching_brief.conversation_signals = signals;
  }
  return next;
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
  applyCertTurnDirectives,
  AVOIDANCE_MESSAGE,
};
