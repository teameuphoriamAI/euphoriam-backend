/**
 * Self-generated clarity → synthesis → Green Rep → proof.
 * Execution mode → reinforce focus when user already confirmed the plan.
 */

const evidenceHelpers = () => require("./evidence");

const IDENTIFIED_BOTTLENECK_PATTERN =
  /\b(bottleneck|current gap|the gap is|gap is (?:still )?execution|not (?:that )?i'?m waiting|lack of (?:market|feedback|data|information)|not enough (?:information|feedback|data|responses|outreach)|market feedback|outreach (?:hasn'?t|has not) produced|no response (?:also )?isn'?t|don'?t have enough information|insufficient|sample size|execution (?:volume|consistency|gap)|consistent outreach)\b/i;

const EXECUTION_GAP_STATED_PATTERN =
  /\b(gap is (?:still )?execution|problem is (?:still )?execution|immediate problem isn'?t|isn'?t (?:strategy|analyzing)|not (?:strategy|analyzing)|understand what the next action|know what the next action|rebuilding consistent|execution volume|consistent outreach|enough (?:market )?(?:data|feedback|sample)|don'?t have enough (?:recent )?(?:outreach )?(?:data|feedback)|not enough (?:recent )?outreach|lack(?:s|ing)? (?:sufficient )?sample|isn'?t identifying a pattern|not identifying a pattern|getting back into consistent execution)\b/i;

const INSUFFICIENT_DATA_STATED_PATTERN =
  /\b(don'?t have enough|not enough|insufficient|can'?t (?:honestly )?point to|no (?:meaningful|clear) (?:pattern|data)|less data than i need|haven'?t (?:rebuilt|generated|taken enough|completed enough)|volume dropped|consistency dropped|pull(?:ed)? back|less execution|not much happened)\b/i;

const ACTION_KNOWN_PATTERN =
  /\b(understand what the next action|know what the next action|know what to do|next action is|increase market sample|active rep)\b/i;

const PROPOSED_ACTION_PATTERN =
  /\b(i could|i would|i will|i should|i plan to|i'?ll send|for example, i|send (?:\d+|more |outreach)|follow[\s-]?up(?: with)?|10\s*[-–]\s*20|\d+\s*(?:new )?prospects?|clear offer|(?:named?|state) (?:my )?rate|increase (?:the )?(?:amount|volume|number) of)\b/i;

const LEARNING_PATTERN =
  /\b(reality didn'?t|didn'?t fully match|no one judged|nobody judged|not evidence that|learn what|collect real|goal wouldn'?t be|market is willing|milder than the fear|wasn'?t evidence)\b/i;

const LEVERAGE_QUESTION_PATTERN =
  /\b(highest[\s-]?(?:leverage|chance)|what (?:would be the |action creates the )(?:best|highest)|which (?:should|would) i|more outreach|follow[\s-]?ups?|improving the offer|changing the prospects|targeting different)\b/i;

const PROOF_CRITERIA_PATTERN =
  /\b(proof|track(?:ing)?|log|number of|replies|conversations|messages sent|follow[\s-]?ups? sent|success is|win condition)\b/i;

const EXECUTION_CONFIRM_PATTERN =
  /\b(understood|got it|agreed|sounds good|will do|tomorrow i'?ll|i'?ll focus|next rep:|current bottleneck|my next rep)\b/i;

const EXECUTION_RECAP_PATTERN =
  /\b(next rep|green rep|win:|proof|bottleneck|market data|sample size|track|log|outreach messages|follow[\s-]?ups?)\b/i;

const REP_ASSIGNMENT_PATTERN =
  /\b(Green Rep:|Next rep:|Increase Market Sample Size|Start Client Conversation|Win:)\b/i;

const EXECUTION_THREAT_PATTERN =
  /\b(discourag(?:ed|ement|ing)?|demotivat|loss of momentum|losing momentum|lost momentum|frustrat(?:ed|ion)?|delayed (?:result|outcome|feedback|response)s?|no (?:immediate|instant) (?:reward|result|feedback)|nothing(?:'s| is) (?:happening|working)|want to (?:quit|stop|give up)|hard to keep going|hard to continue|isn'?t strategy|not strategy|not the (?:bottleneck|obstacle|problem|issue)|brain wants proof|motivation drops?|give up on|tempted to (?:stop|quit|change)|pressure (?:of|from) needing|needing income|income pressure|pull(?:ed)? back|less execution)\b/i;

const HOPE_DEPLETION_PATTERN =
  /\b(don'?t know if (?:it|this) matters|doesn'?t matter(?: anymore)?|nothing(?:'ll| will) change|keep trying and nothing|emotional energy|enough energy to keep|effort will (?:ever )?pay off|evidence that it'?s working|without evidence|waste(?:d|ing)? (?:my )?(?:time|effort)|what'?s the point|giving up (?:on )?(?:belief|hope)|lose hope|lost hope|hope (?:is )?(?:gone|fading)|keep investing|continued investment|emotionally sustainable|worth(?:while)? if|worth(?:while)? to keep|pointless to keep)\b/i;

const MOTIVATION_LOSS_PATTERN =
  /\b(don'?t feel like(?: doing)?|not feel like(?: doing)?|hard to (?:start|begin|get going)|low motivation|feeling lazy|procrastinat|can'?t bring myself)\b/i;

const STRATEGY_ALREADY_CLEAR_PATTERN =
  /\b(isn'?t strategy|not strategy|not the (?:bottleneck|obstacle|problem|issue)|know what to do|already (?:know|accepted|have (?:the )?(?:plan|rep))|obstacle isn'?t|understand what the next action|know what the next action|gap is (?:still )?execution|problem is execution)\b/i;

const userTextsFromMessages = (messages = [], current = "") => {
  const prior = (messages || [])
    .filter((m) => m?.role === "user")
    .map((m) => String(m.content || "").trim())
    .filter(Boolean);
  const cur = String(current || "").trim();
  return cur ? [...prior, cur] : prior;
};

const detectSelfGeneratedClarity = (userMessage = "", messages = []) => {
  const t = String(userMessage || "").trim();
  if (t.length < 24) return { clear: false, level: null };

  const combined = userTextsFromMessages(messages, t).join(" ");
  const hasBottleneck =
    IDENTIFIED_BOTTLENECK_PATTERN.test(t) ||
    IDENTIFIED_BOTTLENECK_PATTERN.test(combined) ||
    EXECUTION_GAP_STATED_PATTERN.test(t) ||
    EXECUTION_GAP_STATED_PATTERN.test(combined);
  const hasAction = PROPOSED_ACTION_PATTERN.test(t) || ACTION_KNOWN_PATTERN.test(t);
  const hasLearning = LEARNING_PATTERN.test(t) || LEARNING_PATTERN.test(combined);
  const hasInsufficientData =
    INSUFFICIENT_DATA_STATED_PATTERN.test(t) || INSUFFICIENT_DATA_STATED_PATTERN.test(combined);

  if (hasBottleneck && hasAction && t.length >= 50) {
    return { clear: true, level: hasLearning ? "full" : "action", hasBottleneck, hasAction, hasLearning };
  }

  if (hasBottleneck && hasInsufficientData && EXECUTION_GAP_STATED_PATTERN.test(t)) {
    return { clear: true, level: "execution_gap", hasBottleneck, hasAction, hasLearning };
  }

  if (hasAction && hasLearning && t.length >= 60) {
    return { clear: true, level: "action", hasBottleneck: hasBottleneck || hasLearning, hasAction, hasLearning };
  }

  return { clear: false, level: null, hasBottleneck, hasAction, hasLearning };
};

const countExecutionClarityStatements = (texts = []) =>
  texts.filter((text) => {
    const t = String(text || "").trim();
    if (t.length < 30) return false;
    return (
      EXECUTION_GAP_STATED_PATTERN.test(t) ||
      (IDENTIFIED_BOTTLENECK_PATTERN.test(t) && INSUFFICIENT_DATA_STATED_PATTERN.test(t)) ||
      (ACTION_KNOWN_PATTERN.test(t) && INSUFFICIENT_DATA_STATED_PATTERN.test(t))
    );
  }).length;

const detectEstablishedExecutionClarity = (userMessage = "", messages = [], openSession = null) => {
  const texts = userTextsFromMessages(messages, userMessage);
  const combined = texts.join(" ");
  const t = String(userMessage || "").trim();
  const executionClarityTurns = countExecutionClarityStatements(texts);

  const hasBottleneck =
    IDENTIFIED_BOTTLENECK_PATTERN.test(combined) || EXECUTION_GAP_STATED_PATTERN.test(combined);
  const hasActionKnown =
    ACTION_KNOWN_PATTERN.test(combined) || hasRecentRepAssignment(messages, openSession);
  const hasMissingProof =
    INSUFFICIENT_DATA_STATED_PATTERN.test(combined) ||
    /\b(sample size|market (?:data|feedback)|enough outreach|enough volume)\b/i.test(combined);
  const hasStallReason =
    EXECUTION_THREAT_PATTERN.test(combined) ||
    /\b(pressure|discourag|consistency|execution volume|pull(?:ed)? back|less execution)\b/i.test(
      combined,
    );

  const currentTurnEstablished =
    EXECUTION_GAP_STATED_PATTERN.test(t) &&
    (INSUFFICIENT_DATA_STATED_PATTERN.test(t) || ACTION_KNOWN_PATTERN.test(t));

  const established =
    (hasBottleneck && hasActionKnown && hasMissingProof) ||
    (currentTurnEstablished && hasMissingProof) ||
    executionClarityTurns >= 2;

  return {
    established,
    hasBottleneck,
    hasActionKnown,
    hasMissingProof,
    hasStallReason,
    executionClarityTurns,
    stop_discovery: established,
  };
};

const detectSeekingLeverageDirection = (userMessage = "", messages = []) => {
  const t = String(userMessage || "").trim();
  if (!LEVERAGE_QUESTION_PATTERN.test(t)) return false;
  if (detectSelfGeneratedClarity(t, messages).clear) return false;
  return (
    /\b(outreach|feedback|repl|response|client|prospect|offer|market)\b/i.test(t) &&
    t.length >= 40
  );
};

const detectUserDefinedExecution = (userMessage = "", messages = []) => {
  const t = String(userMessage || "").trim();
  const clarity = detectSelfGeneratedClarity(userMessage, messages);
  const hasProof = PROOF_CRITERIA_PATTERN.test(t);
  const hasCommitment = EXECUTION_CONFIRM_PATTERN.test(t) || PROPOSED_ACTION_PATTERN.test(t);
  const hasRecap = EXECUTION_RECAP_PATTERN.test(t);

  return {
    complete:
      (clarity.clear || (clarity.hasBottleneck && hasCommitment)) &&
      hasProof &&
      (hasCommitment || hasRecap) &&
      t.length >= 40,
    hasProof,
    hasCommitment,
    hasRecap,
    clarity,
  };
};

const hasRecentRepAssignment = (messages = [], openSession = null) => {
  if (openSession?.structural_coaching_flow?.clarity_execution) return true;
  if (openSession?.structural_coaching_flow?.execution_mode) return true;
  if (openSession?.green_rep_last?.name) return true;

  const recentAssistant = (messages || []).filter((m) => m?.role === "assistant").slice(-3);
  return recentAssistant.some((m) => REP_ASSIGNMENT_PATTERN.test(String(m.content || "")));
};

const detectAgreementLoop = (messages = []) => {
  const assistants = (messages || []).filter((m) => m?.role === "assistant").slice(-2);
  if (assistants.length < 2) return false;

  const normalize = (text) =>
    String(text || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160);

  const prev = normalize(assistants[0]?.content);
  const last = normalize(assistants[1]?.content);
  if (!prev || !last) return false;

  const bothAgreed = /\bagreed\b/.test(prev) && /\bagreed\b/.test(last);
  const bothLeverage = /highest leverage/.test(prev) && /highest leverage/.test(last);
  const nearDuplicate = prev.slice(0, 100) === last.slice(0, 100);

  return bothAgreed || bothLeverage || nearDuplicate;
};

const detectExecutionConfirmation = (userMessage = "", messages = [], openSession = null) => {
  const t = String(userMessage || "").trim();
  if (t.length < 30) return false;
  if (/\?/.test(t) && LEVERAGE_QUESTION_PATTERN.test(t)) return false;
  if (detectExecutionThreat(userMessage, messages, openSession).active) return false;
  if (detectHopeDepletion(userMessage, messages, openSession).active) return false;

  const userExec = detectUserDefinedExecution(userMessage, messages);
  const confirming =
    EXECUTION_CONFIRM_PATTERN.test(t) ||
    (userExec.hasRecap && userExec.hasProof && userExec.hasCommitment);

  if (!confirming) return false;
  return hasRecentRepAssignment(messages, openSession);
};

const pickEarlyFear = (map = null) => {
  const fear =
    map?.core_fear?.trim() ||
    map?.protector_rule?.trim() ||
    map?.failure_strategy?.rule?.trim() ||
    null;
  if (fear) return fear;
  return "If I try, I'll be judged or rejected";
};

const isStrategyContextClear = (userMessage = "", messages = [], openSession = null) =>
  STRATEGY_ALREADY_CLEAR_PATTERN.test(String(userMessage || "")) ||
  hasRecentRepAssignment(messages, openSession) ||
  openSession?.structural_coaching_flow?.execution_mode ||
  openSession?.structural_coaching_flow?.execution_sustainability_mode ||
  /\b(keep executing|executing without|already accepted|the rep|sample size logic)\b/i.test(
    String(userMessage || ""),
  );

const detectHopeDepletion = (userMessage = "", messages = [], openSession = null) => {
  const t = String(userMessage || "").trim();
  if (t.length < 20) return { active: false };

  const hasHopeDepletion = HOPE_DEPLETION_PATTERN.test(t);
  if (!hasHopeDepletion) return { active: false };

  const strategyClear = isStrategyContextClear(userMessage, messages, openSession);
  return {
    active: strategyClear,
    hasHopeDepletion,
    strategyClear,
    type: "hope_depletion",
    isMotivationLoss: MOTIVATION_LOSS_PATTERN.test(t) && !hasHopeDepletion,
  };
};

const detectExecutionThreat = (userMessage = "", messages = [], openSession = null) => {
  const t = String(userMessage || "").trim();
  if (t.length < 20) return { active: false };

  if (detectHopeDepletion(userMessage, messages, openSession).active) {
    return { active: false };
  }

  const hasMotivationLoss = MOTIVATION_LOSS_PATTERN.test(t);
  const hasThreat = EXECUTION_THREAT_PATTERN.test(t) || hasMotivationLoss;
  if (!hasThreat) return { active: false };

  const strategyClear = isStrategyContextClear(userMessage, messages, openSession);

  return {
    active: strategyClear,
    hasThreat,
    strategyClear,
    type: hasMotivationLoss ? "motivation_loss" : "delayed_feedback_discouragement",
  };
};

const buildHopeDepletionWriteback = ({ map, userMessage, funnelStage }) => {
  const earlyFear = pickEarlyFear(map);
  const label = "Hope depletion — questioning whether effort will ever pay off";
  return {
    diagnosis_refined: true,
    progression_stage: funnelStage,
    active_bottleneck: {
      type: "hope_depletion",
      label,
      stage: funnelStage,
    },
    current_resistance: label,
    current_failure_strategy: {
      rule: "Withdraw belief before the market answers — protect from wasted effort by stopping hope early",
    },
    current_success_strategy: {
      behaviour: "Stay with the process long enough for data to exist — separate belief from immediate proof",
    },
    fear_evolution: {
      from: earlyFear,
      to: "What if I keep trying and nothing changes?",
    },
    emotional_themes: ["hope depletion", "delayed evidence", "emotional sustainability"],
    coaching_insights:
      "Hope depletion detected — coach emotional cost of delayed results, not task list. Fear evolved past judgment.",
    progress_note: String(userMessage || "").slice(0, 200),
    assign_new_green_rep: false,
    execution_mode: false,
    execution_sustainability_mode: false,
    hope_depletion_mode: true,
  };
};

const buildExecutionSustainabilityWriteback = ({ rep, map, journey, userMessage, funnelStage }) => {
  const label = "Execution sustainability — discouragement from delayed feedback";
  const hints = {
    diagnosis_refined: true,
    progression_stage: funnelStage,
    active_bottleneck: {
      type: "execution_threat",
      label,
      stage: funnelStage,
    },
    current_resistance: label,
    current_failure_strategy: {
      rule: "Quit or pivot when no immediate reward — brain demands proof before continuing",
    },
    current_success_strategy: {
      behaviour: "Score executions completed, not replies received — stay consistent through delayed feedback",
    },
    coaching_insights: `Execution threat detected: delayed feedback → discouragement. Strategy clear; coach sustainability.`,
    progress_note: String(userMessage || "").slice(0, 200),
    assign_new_green_rep: false,
    execution_mode: false,
    execution_sustainability_mode: true,
  };

  const successBase =
    journey?.evolved_success?.behaviour || map?.success_strategy?.behaviour || map?.flip_rule;
  if (successBase && !hints.current_success_strategy) {
    hints.current_success_strategy = { behaviour: successBase };
  }
  if (rep?.name) {
    hints.green_rep_hold = rep.name;
  }
  return hints;
};

const isMarketDataBottleneck = (userMessage = "", bottleneckLabel = "") => {
  const t = String(userMessage || "").toLowerCase();
  const label = String(bottleneckLabel || "").toLowerCase();
  return (
    /\b(market feedback|market data|sample size|lack of (?:market|feedback|data)|not enough information|gather enough data)\b/i.test(
      t,
    ) || /\bmarket data|sample size|feedback volume\b/i.test(label)
  );
};

const inferOutreachTargetCount = (userMessage = "", messages = []) => {
  const combined = userTextsFromMessages(messages, userMessage).join(" ");
  const targets = [...combined.matchAll(/\b(\d{1,3})\s*(?:outbound|outreach|messages?|prospects?|new contacts?)\b/gi)];
  if (targets.length === 0) return 0;
  return Math.max(...targets.map((m) => parseInt(m[1], 10)));
};

const buildSampleSizeGuidance = (outreachCount = 0) => {
  if (outreachCount < 20) {
    return (
      "**Sample size rule:** Under 20 outreach attempts, you have **insufficient data** — " +
      "no conclusions on offer, targeting, or messaging yet. Execute volume only."
    );
  }
  if (outreachCount < 50) {
    return (
      "**Sample size rule:** At 20–50 attempts, **begin pattern detection** — " +
      "track reply rate and which prospect types respond. Still do not rewrite the offer."
    );
  }
  return (
    "**Sample size rule:** At 50+ attempts, **evaluate offer, targeting, and messaging** — " +
    "we use your logged data for that review."
  );
};

const resolveActiveRep = ({ userMessage, goalContext, map, funnelStage, outcomePending, openSession }) => {
  const sessionRep = openSession?.green_rep_last;
  if (sessionRep?.name) return sessionRep;

  const inferred = buildClarityExecutionRep({
    userMessage,
    goalContext,
    map,
    funnelStage,
    outcomePending,
    preferSampleSize: true,
  });
  return inferred;
};

const inferBottleneckLabel = ({ userMessage, map, journey, funnelStage, outcomePending }) => {
  const evidence = evidenceHelpers();
  const inferNewBottleneck = evidence.inferNewBottleneck;
  const diagnosisIsInvisibility = evidence.diagnosisIsInvisibility;
  const fallbackLabel = "Lack of market data — need more responses to learn what the market will pay";
  const t = String(userMessage || "");
  if (/\b(market feedback|sample size|not enough information|lack of (?:market|feedback|data))\b/i.test(t)) {
    return fallbackLabel;
  }
  if (typeof inferNewBottleneck !== "function") {
    return fallbackLabel;
  }
  if (/\b(follow[\s-]?up|no repl|waiting)\b/i.test(t) || outcomePending) {
    return inferNewBottleneck({ userMessage, funnelStage, outcomePending }).label;
  }
  if (typeof diagnosisIsInvisibility === "function" && diagnosisIsInvisibility(map, journey)) {
    return "Lack of market data — visibility done, feedback volume is the edge";
  }
  return inferNewBottleneck({ userMessage, funnelStage, outcomePending }).label;
};

const buildClarityExecutionRep = ({
  userMessage,
  goalContext,
  map,
  funnelStage,
  outcomePending,
  preferSampleSize = false,
  bottleneckLabel = "",
}) => {
  const { buildFunnelAwareRep } = evidenceHelpers();
  const t = String(userMessage || "").toLowerCase();
  const milestone =
    goalContext?.current_milestone || goalContext?.goal_name || map?.goal_title || "your milestone";

  const sampleSizeMove =
    preferSampleSize ||
    isMarketDataBottleneck(userMessage, bottleneckLabel) ||
    /\b10\s*[-–]\s*20|\d+\s*(?:new )?prospects?|increase.*(?:feedback|volume|sample|market)|more outreach\b/i.test(
      t,
    );

  if (sampleSizeMove) {
    return {
      name: "Increase Market Sample Size",
      steps: [
        "List 10 prospects you can contact today (new contacts or follow-ups).",
        `Send messages #1–#5 with a clear offer and stated rate toward ${milestone}.`,
        "Send #6–#10 before end of day. Include one follow-up to a prior contact.",
      ],
      win_condition: "10 outbound messages sent with offer and rate — log any replies",
    };
  }

  const funnelRep = buildFunnelAwareRep({
    funnelStage,
    goalContext,
    map,
    userMessage,
    outcomePending,
  });
  if (funnelRep) return funnelRep;

  return {
    name: "Send Five Outreach With Clear Rate",
    steps: [
      "Pick 5 prospects (new or prior contacts).",
      `Send each message with service, scope, and rate toward ${milestone}.`,
      "Do not rewrite the offer after fear — sent counts.",
    ],
    win_condition: "5 outbound messages sent naming offer and rate",
  };
};

const buildClarityExecutionWriteback = ({
  bottleneckLabel,
  rep,
  map,
  journey,
  userMessage,
  funnelStage,
  executionMode = false,
}) => {
  const hints = {
    diagnosis_refined: !executionMode,
    removed_bottleneck: executionMode
      ? null
      : evidenceHelpers().diagnosisIsInvisibility(map, journey)
        ? "Staying financially invisible"
        : null,
    progression_stage: funnelStage,
    active_bottleneck: {
      type: "strategy_gap",
      label: bottleneckLabel,
      stage: funnelStage,
    },
    current_resistance: bottleneckLabel,
    current_failure_strategy: {
      rule: executionMode
        ? `${bottleneckLabel} — execution mode; hold strategy steady`
        : `${bottleneckLabel} — user identified edge; executing sample-size move`,
    },
    coaching_insights: executionMode
      ? `Execution mode — reinforce focus, no restatement`
      : `Self-generated clarity → execution: ${bottleneckLabel}`,
    progress_note: String(userMessage || "").slice(0, 200),
    assign_new_green_rep: !executionMode,
    execution_mode: executionMode,
  };

  const successBase =
    journey?.evolved_success?.behaviour || map?.success_strategy?.behaviour || map?.flip_rule;
  if (successBase) {
    hints.current_success_strategy = { behaviour: successBase };
  }
  return hints;
};

const countClarityDemonstrations = (messages = [], userMessage = "") => {
  const texts = userTextsFromMessages(messages, userMessage);
  return texts.filter((t) => {
    const clarity = detectSelfGeneratedClarity(t, []);
    const execution = detectUserDefinedExecution(t, []);
    return (
      clarity.clear ||
      execution.complete ||
      (EXECUTION_CONFIRM_PATTERN.test(t) && EXECUTION_RECAP_PATTERN.test(t))
    );
  }).length;
};

const { formatOutcomeDirective } = require("./directive");

const buildSignalCoachingDirective = (signals) => {
  if (signals.user_showing_hope_depletion) {
    return formatOutcomeDirective("user_showing_hope_depletion", {
      goal: "Member stays engaged long enough for real data — belief is the bottleneck, not strategy.",
      yourJob: [
        "validate emotional reality",
        "investigate what conclusion they are reaching about continued effort",
        "explore what giving up belief would protect",
        "one question that moves understanding forward",
      ],
      avoid: ["rep repetition", "scoreboard", "execution plan", "diagnosis replay"],
    });
  }
  if (signals.execution_sustainability_issue) {
    return formatOutcomeDirective("execution_sustainability_issue", {
      goal: "Member maintains consistent execution through delayed feedback without premature pivot.",
      yourJob: [
        "reinforce strategy is clear",
        "separate executions completed from replies",
        "surface momentum drains and friction",
        "support adherence without re-teaching the plan",
      ],
      avoid: ["new rep assignment", "repeating accepted instructions", "verbatim scoreboard templates"],
    });
  }
  if (signals.clarity_saturation) {
    return formatOutcomeDirective("clarity_saturation", {
      goal: "Move forward without rediscovering what member already demonstrated.",
      yourJob: [
        "acknowledge existing clarity",
        "add only blind spots, review criteria, stopping rules, emotional cost, or decision thresholds",
      ],
      avoid: ["restating map", "restating rep", "restating plan", "questions already answered"],
    });
  }
  if (signals.execution_confirmed) {
    return formatOutcomeDirective("execution_confirmed", {
      goal: "Convert agreement into sustained execution without another planning loop.",
      yourJob: [
        "confirm execution mode",
        "hold focus on completion criteria and review threshold",
        "add only new execution support",
      ],
      avoid: ["echoing their recap", "reopening strategy"],
    });
  }
  if (signals.self_generated_clarity) {
    return formatOutcomeDirective("self_generated_clarity", {
      goal: "Member identified bottleneck and next action — convert clarity into execution.",
      yourJob: [
        "validate the useful insight",
        "prevent unnecessary rediscovery",
        "convert clarity into execution",
        "assign green_rep if assign_green_rep is true",
      ],
      avoid: ["asking next obstacle", "lengthy re-synthesis"],
    });
  }
  if (signals.seeking_leverage_direction) {
    return formatOutcomeDirective("seeking_leverage_direction", {
      goal: "Member chooses highest-leverage move for market data at current volume.",
      yourJob: [
        "direct sample-size before offer rewrite when data insufficient",
        "prioritize follow-up when appropriate",
        "assign rep if warranted and not blocked",
      ],
      avoid: ["offer or targeting rewrite before enough evidence"],
    });
  }
  return null;
};

const buildClarityExecutionSignals = (ctx) => {
  const {
    userMessage,
    messages = [],
    map,
    goalContext,
    memoryCtx,
    openSession,
    proofCycleFlow,
  } = ctx;

  const empty = {
    self_generated_clarity: false,
    seeking_leverage_direction: false,
    execution_confirmed: false,
    execution_sustainability_issue: false,
    user_showing_hope_depletion: false,
    motivation_loss: false,
    clarity_saturation: false,
    agreement_loop_detected: false,
    strategy_context_clear: false,
    stop_discovery: false,
    outreach_target_count: 0,
    coaching_directive: null,
    coaching_context: null,
    writeback_hints: null,
    structural_coaching_flow: null,
    block_green_rep: false,
    assign_green_rep: false,
    suggested_clarity_rep: null,
  };

  if (!map?.map_resistance_complete) return empty;
  if (proofCycleFlow?.awaiting_proof_log) return empty;

  const { loadCoachingJourney } = require("../utils/evolution");
  const journey = loadCoachingJourney(memoryCtx, map, openSession);
  const { inferFunnelStageFromContext, hasOutcomePending } = evidenceHelpers();
  const funnelStage = inferFunnelStageFromContext({
    userMessage,
    messages,
    openSession,
    memoryCtx,
  });
  const outcomePending = hasOutcomePending(userMessage);
  const bottleneckLabel = inferBottleneckLabel({
    userMessage,
    map,
    journey,
    funnelStage,
    outcomePending,
  });
  const outreachTarget = inferOutreachTargetCount(userMessage, messages);
  const hopeDepletion = detectHopeDepletion(userMessage, messages, openSession);
  const executionThreat = detectExecutionThreat(userMessage, messages, openSession);
  const agreementLoop = detectAgreementLoop(messages);
  const executionConfirmed = detectExecutionConfirmation(userMessage, messages, openSession);
  const userExecDefined = detectUserDefinedExecution(userMessage, messages);
  const recentAssignment = hasRecentRepAssignment(messages, openSession);
  const clarity = detectSelfGeneratedClarity(userMessage, messages);
  const seekingLeverage = detectSeekingLeverageDirection(userMessage, messages);
  const establishedClarity = detectEstablishedExecutionClarity(userMessage, messages, openSession);
  const clarityDemonstrationCount = countClarityDemonstrations(messages, userMessage);
  const executionClarityTurns = establishedClarity.executionClarityTurns;
  const claritySaturation =
    clarityDemonstrationCount >= 2 ||
    executionClarityTurns >= 2 ||
    (clarityDemonstrationCount >= 1 && agreementLoop && recentAssignment) ||
    (executionClarityTurns >= 1 && recentAssignment && establishedClarity.hasStallReason);

  const strategyClear = isStrategyContextClear(userMessage, messages, openSession);
  const activeRep = resolveActiveRep({
    userMessage,
    goalContext,
    map,
    funnelStage,
    outcomePending,
    openSession,
  });

  const signals = {
    ...empty,
    self_generated_clarity: clarity.clear || establishedClarity.established,
    seeking_leverage_direction: seekingLeverage,
    execution_confirmed: executionConfirmed || (userExecDefined.complete && recentAssignment),
    execution_sustainability_issue:
      executionThreat.active ||
      (establishedClarity.established && strategyClear && establishedClarity.hasStallReason),
    user_showing_hope_depletion: hopeDepletion.active,
    motivation_loss: executionThreat.type === "motivation_loss",
    clarity_saturation: claritySaturation || (establishedClarity.established && executionClarityTurns >= 2),
    agreement_loop_detected: agreementLoop,
    strategy_context_clear: strategyClear || establishedClarity.established,
    outreach_target_count: outreachTarget,
    stop_discovery: establishedClarity.stop_discovery,
    coaching_context: {
      bottleneck_label: bottleneckLabel,
      funnel_stage: funnelStage,
      outcome_pending: outcomePending,
      active_rep_name: activeRep?.name || openSession?.green_rep_last?.name || null,
      active_rep_win: activeRep?.win_condition || null,
      fear_evolution: hopeDepletion.active
        ? { from: pickEarlyFear(map), to: "What if I keep trying and nothing changes?" }
        : null,
      sample_size_guidance: buildSampleSizeGuidance(outreachTarget),
      clarity_demonstration_count: clarityDemonstrationCount,
      execution_clarity_established: establishedClarity.established,
      execution_clarity_turns: executionClarityTurns,
      insufficient_data_for_analysis:
        establishedClarity.hasMissingProof && establishedClarity.hasActionKnown,
    },
  };

  const blockRep =
    signals.user_showing_hope_depletion ||
    signals.execution_sustainability_issue ||
    signals.clarity_saturation ||
    signals.execution_confirmed ||
    signals.agreement_loop_detected;

  signals.block_green_rep = blockRep;
  signals.assign_green_rep =
    !blockRep && (signals.self_generated_clarity || signals.seeking_leverage_direction);

  if (signals.assign_green_rep) {
    signals.suggested_clarity_rep = buildClarityExecutionRep({
      userMessage,
      goalContext,
      map,
      funnelStage,
      outcomePending,
      preferSampleSize:
        seekingLeverage || isMarketDataBottleneck(userMessage, bottleneckLabel),
      bottleneckLabel,
    });
    if (signals.coaching_context) {
      signals.coaching_context.suggested_rep = signals.suggested_clarity_rep;
    }
  }

  signals.coaching_directive = buildSignalCoachingDirective(signals);

  if (signals.user_showing_hope_depletion) {
    signals.writeback_hints = buildHopeDepletionWriteback({ map, userMessage, funnelStage });
    signals.structural_coaching_flow = {
      ...(openSession?.structural_coaching_flow || {}),
      progression_stage: funnelStage,
      hope_depletion_mode: true,
      fear_evolution: signals.coaching_context?.fear_evolution,
    };
  } else if (signals.execution_sustainability_issue) {
    signals.writeback_hints = buildExecutionSustainabilityWriteback({
      rep: activeRep,
      map,
      journey,
      userMessage,
      funnelStage,
    });
    signals.structural_coaching_flow = {
      ...(openSession?.structural_coaching_flow || {}),
      progression_stage: funnelStage,
      execution_sustainability_mode: true,
    };
  } else if (signals.self_generated_clarity || signals.seeking_leverage_direction) {
    if (signals.suggested_clarity_rep) {
      signals.writeback_hints = buildClarityExecutionWriteback({
        bottleneckLabel,
        rep: signals.suggested_clarity_rep,
        map,
        journey,
        userMessage,
        funnelStage,
        executionMode: false,
      });
    }
    signals.structural_coaching_flow = {
      ...(openSession?.structural_coaching_flow || {}),
      progression_stage: funnelStage,
      clarity_execution: true,
    };
  }

  const hasAnySignal =
    signals.self_generated_clarity ||
    signals.seeking_leverage_direction ||
    signals.execution_confirmed ||
    signals.execution_sustainability_issue ||
    signals.user_showing_hope_depletion ||
    signals.clarity_saturation;

  if (!hasAnySignal) {
    return empty;
  }

  return signals;
};

/** Orchestration wrapper — signals only; Coach Brain generates user-facing text. */
const buildClarityExecutionFlow = (ctx) => {
  const signals = buildClarityExecutionSignals(ctx);
  const active =
    signals.self_generated_clarity ||
    signals.seeking_leverage_direction ||
    signals.execution_confirmed ||
    signals.execution_sustainability_issue ||
    signals.user_showing_hope_depletion ||
    signals.clarity_saturation;

  if (!active) {
    return {
      skip_llm: false,
      assistant_override: null,
      green_rep: null,
      coaching_directive: null,
      writeback_hints: null,
      structural_coaching_flow: null,
      clarity_signals: signals,
    };
  }

  return {
    skip_llm: false,
    assistant_override: null,
    green_rep: signals.assign_green_rep ? signals.suggested_clarity_rep : null,
    block_green_rep: signals.block_green_rep,
    assign_green_rep: signals.assign_green_rep,
    coaching_directive: signals.coaching_directive,
    writeback_hints: signals.writeback_hints,
    structural_coaching_flow: signals.structural_coaching_flow,
    clarity_signals: signals,
  };
};

module.exports = {
  IDENTIFIED_BOTTLENECK_PATTERN,
  EXECUTION_GAP_STATED_PATTERN,
  INSUFFICIENT_DATA_STATED_PATTERN,
  PROPOSED_ACTION_PATTERN,
  detectSelfGeneratedClarity,
  detectEstablishedExecutionClarity,
  countExecutionClarityStatements,
  detectSeekingLeverageDirection,
  detectUserDefinedExecution,
  detectExecutionConfirmation,
  detectExecutionThreat,
  detectHopeDepletion,
  detectAgreementLoop,
  hasRecentRepAssignment,
  countClarityDemonstrations,
  buildSampleSizeGuidance,
  inferOutreachTargetCount,
  buildClarityExecutionRep,
  buildClarityExecutionSignals,
  buildClarityExecutionFlow,
  buildClarityExecutionWriteback,
};
