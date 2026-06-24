/**
 * Coach activation moments and future predictions.
 * Flow: Evidence → Investigate → Insight → Flip → Rep (never Rep before Flip).
 * Standalone predictions ("I feel like they won't reply") get facts-vs-predictions coaching.
 */

const { resolveFailureStrategyForMap } = require("../../../helpers/stage1MapStructure");
const { loadCoachingJourney } = require("../utils/evolution");
const { formatOutcomeDirective } = require("./directive");

const ACTIVATION_MOMENT_PATTERN =
  /\b(reached|sent|messaged|contacted|stated|quoted|named|offered|shared)\b[\s\S]{0,120}\b(?:but|then|however|though)\b[\s\S]{0,120}\b(hold|held back|thought|afraid|scared|won'?t|wouldn'?t|too high|too much|reject|reply|respond|interest|pull|back|anxious)/i;

const ACTIVATION_PRICE_FEAR =
  /\b(thought the price|price (?:is|was) too high|too expensive|can'?t afford|overpriced)\b/i;

const ACTIVATION_REJECTION_PREDICTION =
  /\b(won'?t reply|won'?t respond|they won'?t|no (?:reply|response)|no\s+one\s+repl|ghost|not interested|before.*(?:reply|response|answer))\b/i;

const FUTURE_PREDICTION_PATTERNS = [
  /\b(?:won'?t|will not|never)\s+(?:reply|respond|answer|buy|hire|pay|work out)\b/i,
  /\b(?:no\s+one|nobody)\s+will\s+(?:buy|hire|pay|reply|respond)\b/i,
  /\b(?:it'?s|its|that'?s)\s+too\s+(?:expensive|high|much)\b/i,
  /\b(?:i'?ll|i will)\s+fail\b/i,
  /\b(?:they'?ll|they will)\s+reject\b/i,
  /\bfeel(?:s)?\s+like\b[\s\S]{0,50}\b(?:won'?t|never|not|reject|fail|expensive|buy)\b/i,
  /\b(?:i|they)\s+(?:think|feel|bet|know|assume)\b[\s\S]{0,60}\b(?:won'?t|reject|fail|expensive|buy|reply|respond)\b/i,
  /\b(?:probably|likely)\s+(?:won'?t|reject|fail|say no)\b/i,
  /\bmind\s+(?:is\s+)?fill(?:ing)?\s+in\b/i,
];

const VISIBILITY_ACTION_PATTERN =
  /\b(reached?\s+out|reach(?:ed|ing)?|sent|messaged|contacted|stated|quoted|clear rate|outreach|identified (?:a )?client|named (?:my )?rate|submitted (?:an )?offer)\b/i;

const GENERIC_CONFIDENCE_REP_PATTERN =
  /\b(build confidence|confidence exercise|practice stating your rate|say your rate out loud|write your rate in)\b/i;

const detectActivationMoment = (text) => {
  const t = String(text || "").trim();
  if (!t || t.length < 16) return null;

  if (ACTIVATION_MOMENT_PATTERN.test(t)) {
    return { moment_text: t, type: classifyActivationType(t) };
  }

  const hasAction = VISIBILITY_ACTION_PATTERN.test(t);
  const hasFear =
    ACTIVATION_PRICE_FEAR.test(t) ||
    ACTIVATION_REJECTION_PREDICTION.test(t) ||
    /\b(hold back|held back|pulled back|mind.?read|assuming)\b/i.test(t);

  if (hasAction && hasFear) {
    return { moment_text: t, type: classifyActivationType(t) };
  }

  return null;
};

const extractPredictionPhrase = (text) => {
  const t = String(text || "").trim();
  const patterns = [
    /\b(?:feel(?:s)? like|think(?:ing)?|bet|afraid|worried|scared)\s+(?:that\s+)?([^.!?]{4,80})/i,
    /\b(they won'?t[^.!?]{0,40})/i,
    /\b(it'?s|that'?s)\s+too\s+(?:expensive|high|much)[^.!?]*/i,
    /\b(?:no\s+one|nobody)\s+will\s+[^.!?]{4,60}/i,
    /\b(i'?ll|i will)\s+fail[^.!?]*/i,
    /\b(they'?ll|they will)\s+reject[^.!?]*/i,
  ];
  for (const p of patterns) {
    const m = t.match(p);
    if (m) return (m[1] || m[0]).trim();
  }
  return t.slice(0, 80);
};

const detectFuturePrediction = (text) => {
  const t = String(text || "").trim();
  if (!t || t.length < 8) return null;
  if (VISIBILITY_ACTION_PATTERN.test(t) && ACTIVATION_MOMENT_PATTERN.test(t)) return null;

  for (const pattern of FUTURE_PREDICTION_PATTERNS) {
    if (pattern.test(t)) {
      return {
        moment_text: t,
        type: classifyActivationType(t),
        mode: "prediction",
        prediction: extractPredictionPhrase(t),
      };
    }
  }

  return null;
};

const detectCoachingMoment = (text) => {
  const activation = detectActivationMoment(text);
  if (activation) return { ...activation, mode: "activation" };
  return detectFuturePrediction(text);
};

const inferKnownFactsFromContext = ({
  journey = null,
  memoryCtx = null,
  openSession = null,
  messages = [],
} = {}) => {
  const facts = [];
  const stage = journey?.progression_stage || openSession?.structural_coaching_flow?.progression_stage;

  const stageFacts = {
    prospect_identified: "Prospect found",
    contact_initiated: "Outreach completed",
    conversation_started: "Conversation started",
    proposal_sent: "Proposal or offer sent",
  };
  if (stage && stageFacts[stage]) facts.push(stageFacts[stage]);

  const proofs = memoryCtx?.recent_proofs || memoryCtx?.proof_logs || [];
  for (const proof of proofs.slice(-4)) {
    const p = String(proof || "");
    if (/\b(identif|found|client|prospect)\b/i.test(p)) facts.push("Prospect found");
    if (/\b(sent|messaged|outreach|contacted|reached)\b/i.test(p)) facts.push("Outreach completed");
    if (/\b(rate|price|quoted|stated)\b/i.test(p)) facts.push("Rate or price stated");
  }

  for (const msg of (messages || []).slice(-8)) {
    const content = String(msg?.content || msg?.user_message || "");
    if (!content) continue;
    if (/\b(identif|found)\w*\s+(?:client|prospect)/i.test(content)) facts.push("Prospect found");
    if (/\b(sent|messaged|contacted|reached out)\b/i.test(content) && !/\bdidn'?t\b/i.test(content)) {
      facts.push("Message sent");
    }
    if (/\b(rate|price|quoted|stated)\b/i.test(content)) facts.push("Rate or price stated");
  }

  const priorMoment = openSession?.activation_moment_flow?.moment_text;
  if (priorMoment && VISIBILITY_ACTION_PATTERN.test(priorMoment)) {
    if (/\bsent\b/i.test(priorMoment)) facts.push("Message sent");
    if (/\brate|price|quoted\b/i.test(priorMoment)) facts.push("Rate or price stated");
  }

  return [...new Set(facts)];
};

const inferContextVisibilityEvidence = (context = {}) => {
  const facts = context.facts || [];
  const hasOutreach = facts.some((f) => /message|outreach|sent|contact/i.test(f));
  const hasProspect = facts.some((f) => /prospect/i.test(f));
  const hasRate = facts.some((f) => /rate|price/i.test(f));
  const stage = context.journey?.progression_stage;
  const stageBeyondInvisible = [
    "prospect_identified",
    "contact_initiated",
    "conversation_started",
    "proposal_sent",
    "client_closed",
  ].includes(stage);

  return {
    hasVisibilityProof: hasOutreach || hasProspect || hasRate || stageBeyondInvisible,
    facts,
    hasOutreach,
    hasProspect,
    hasRate,
    outcomeUnknown:
      (hasOutreach || stageBeyondInvisible) &&
      !facts.some((f) => /reply|response|reject|conversation/i.test(f)),
  };
};

const classifyActivationType = (text) => {
  const t = String(text || "");
  if (/\b(mind.?read|assuming|probably think|they think)\b/i.test(t)) return "mind_reading";
  if (ACTIVATION_PRICE_FEAR.test(t)) return "self_rejecting_price";
  if (ACTIVATION_REJECTION_PREDICTION.test(t)) return "predicting_rejection";
  if (/\b(hold back|held back|pulled back)\b/i.test(t)) return "retreat_after_action";
  return "activation_resistance";
};

const activationTypeLabel = (type) => {
  const labels = {
    self_rejecting_price: "Self-rejecting before market feedback",
    predicting_rejection: "Predicting rejection without evidence",
    mind_reading: "Mind-reading client responses",
    retreat_after_action: "Retreating after visible action",
    activation_resistance: "Resistance at the moment of activation",
  };
  return labels[type] || labels.activation_resistance;
};

const inferEvolvedFailureStrategy = (text, map = null, journey = null, contextEvidence = null) => {
  const t = String(text || "");
  const oldFailure =
    journey?.evolved_failure?.rule ||
    resolveFailureStrategyForMap(map)?.rule ||
    map?.failure_strategy?.rule ||
    map?.protector_rule ||
    "";
  const visibilityProof =
    VISIBILITY_ACTION_PATTERN.test(t) || Boolean(contextEvidence?.hasVisibilityProof);
  const type = classifyActivationType(t);
  const newRule = activationTypeLabel(type);

  const result = {
    rule: newRule,
    activation_type: type,
    visibility_disproven: false,
    superseded_rule: null,
  };

  if (visibilityProof && /invisible|visibility|outreach avoid/i.test(oldFailure)) {
    result.visibility_disproven = true;
    result.superseded_rule = oldFailure;
    result.rule = `${newRule} — visibility action happened; invisibility is no longer the primary block`;
  } else if (visibilityProof && oldFailure && !/predict|reject|mind.?read|self-reject/i.test(oldFailure)) {
    result.visibility_disproven = true;
    result.superseded_rule = oldFailure;
    result.rule = `${newRule} — assuming negative outcomes before reality responds`;
  }

  return result;
};

const extractMomentSnippet = (text) => {
  const t = String(text || "").trim();
  const m = t.match(
    /\b(?:but|then)\b[^.!?]{0,100}|(?:thought|afraid|scared|held back|won'?t)[^.!?]{0,80}/i,
  );
  return m ? m[0].trim() : t.slice(0, 100);
};

const buildActivationMomentContext = ({
  moment,
  evolved,
  userMessage,
  map,
  contextFacts = [],
  contextEvidence = null,
  phase = "investigate",
}) => {
  const actionMatch = String(userMessage || "").match(
    /\b(reached|sent|messaged|contacted|stated)[^.!?]{0,60}/i,
  );
  return {
    activation_moment_active: true,
    activation_phase: phase,
    coaching_mode: moment.mode || "activation",
    activation_type: moment.type,
    activation_type_label: activationTypeLabel(moment.type),
    moment_snippet: extractMomentSnippet(userMessage || moment.moment_text),
    action_snippet: actionMatch ? actionMatch[0].trim() : null,
    prediction: moment.prediction || null,
    context_facts: contextFacts,
    outcome_unknown: Boolean(contextEvidence?.outcomeUnknown),
    visibility_disproven: Boolean(evolved?.visibility_disproven),
    superseded_failure_rule: evolved?.superseded_rule || null,
    evolved_failure_rule: evolved?.rule || null,
    protector_rule: map?.protector_rule?.trim() || null,
    investigation_question_theme:
      moment.type === "self_rejecting_price"
        ? "evidence_for_price_too_high"
        : moment.type === "predicting_rejection"
          ? "evidence_for_no_reply"
          : "evidence_for_fear_at_activation",
  };
};

const buildFlipMomentContext = ({
  activation,
  evolved,
  userMessage,
  map,
  priorMoment,
  rep,
  flip,
}) => {
  const selfDecided =
    /\b(i decided|no they didn|before they|just (?:thought|felt|assumed)|didn'?t (?:say|tell)|no evidence|made it up|in my head)\b/i.test(
      userMessage,
    ) || !/\b(they said|client said|told me)\b/i.test(userMessage);

  return {
    activation_moment_active: true,
    activation_phase: "flip_complete",
    coaching_mode: priorMoment?.mode || activation?.mode || "activation",
    activation_type: activation?.type,
    hidden_prediction:
      activation?.type === "self_rejecting_price"
        ? "price too high"
        : activation?.type === "predicting_rejection"
          ? "they will not reply or engage"
          : "outcome will be negative",
    self_decided_before_market: selfDecided,
    flip_installed: flip,
    suggested_rep: rep,
    visibility_disproven: Boolean(evolved?.visibility_disproven),
    protector_rule: map?.protector_rule?.trim() || null,
    unknown_not_failure:
      priorMoment?.mode === "prediction" || activation?.type === "predicting_rejection",
  };
};

const isInvestigateAnswer = (text) => {
  const t = String(text || "").trim();
  if (!t || t.length < 6) return false;
  if (/^(yes|no|yup|yeah|ok|okay|idk)\s*\.?$/i.test(t)) return false;
  return true;
};

const buildFlipAlignedRep = (activationType) => {
  if (activationType === "self_rejecting_price") {
    return {
      name: "Send Offer Without Price Edit",
      steps: [
        "Use the rate or price you already stated.",
        "When fear says to lower it or soften it — send unchanged.",
        "One send. No edits after fear appears.",
      ],
      win_condition: "Offer or rate sent unchanged after fear fired",
    };
  }
  if (activationType === "predicting_rejection") {
    return {
      name: "Send One Message Without Pullback",
      steps: [
        "Take the outreach you already drafted or sent.",
        "Do not delete, unsend, or apologize for reaching out.",
        "Leave it sent and wait for one response window (24h).",
      ],
      win_condition: "Message left sent — no pullback after fear of no reply",
    };
  }
  return {
    name: "Complete the Visible Action",
    steps: [
      "Return to the exact action where you held back.",
      "Finish the send / state the rate / leave the message live.",
      "Do not edit downward after fear fires.",
    ],
    win_condition: "Activation completed without retreat after fear",
  };
};

const resolveActivationMomentFlow = ({
  messages = [],
  userMessage = "",
  map = null,
  goalContext = null,
  memoryCtx = null,
  openSession = null,
  proofCycleFlow = null,
} = {}) => {
  const base = {
    skip_llm: false,
    assistant_override: null,
    green_rep: null,
    coaching_directive: null,
    coaching_context: null,
    conversation_signals: null,
    assign_green_rep: false,
    writeback_hints: null,
    activation_moment_flow: openSession?.activation_moment_flow || null,
    block_green_rep: false,
  };

  if (!map?.map_resistance_complete) return base;
  if (proofCycleFlow?.proof_integration_mode) return base;

  const prior = openSession?.activation_moment_flow || {};
  const journey = loadCoachingJourney(memoryCtx, map, openSession);
  const contextFacts = inferKnownFactsFromContext({
    journey,
    memoryCtx,
    openSession,
    messages,
  });
  const contextEvidence = inferContextVisibilityEvidence({ facts: contextFacts, journey });

  if (prior.active && prior.phase === "investigate" && isInvestigateAnswer(userMessage)) {
    const activation = {
      moment_text: prior.moment_text,
      type: prior.activation_type || "activation_resistance",
      mode: prior.coaching_mode || "activation",
    };
    const evolved =
      prior.evolved_failure ||
      inferEvolvedFailureStrategy(prior.moment_text, map, journey, contextEvidence);
    const flip = "Let the market answer before you answer for it.";
    const rep = buildFlipAlignedRep(activation.type);
    const evolved_failure = {
      rule: evolved?.rule || activationTypeLabel(activation.type),
      flip_installed: flip,
    };

    return {
      ...base,
      green_rep: rep,
      assign_green_rep: true,
      block_green_rep: false,
      coaching_directive: formatOutcomeDirective(
        prior.coaching_mode === "prediction" ? "prediction_moment_flip" : "activation_moment_flip",
        {
          goal: "Install flip and assign flip-aligned rep after investigation answer.",
          yourJob: [
            "expose hidden prediction and protector",
            "install flip",
            "assign flip-aligned green_rep",
          ],
          avoid: [
            "generic confidence exercises",
            "financially invisible diagnosis repeat",
            "treating unknown outcome as failure",
          ],
        },
      ),
      coaching_context: buildFlipMomentContext({
        activation,
        evolved,
        userMessage,
        map,
        priorMoment: activation,
        rep,
        flip,
      }),
      conversation_signals: {
        activation_moment_active: true,
        activation_moment_flip_ready: true,
        prediction_moment: prior.coaching_mode === "prediction",
      },
      writeback_hints: {
        current_failure_strategy: evolved_failure,
        current_resistance: `Moment of activation: ${activationTypeLabel(activation.type)}`,
        current_success_strategy: {
          behaviour: flip,
        },
        coaching_insights: `Flip installed: ${flip}`,
        diagnosis_refined: Boolean(evolved?.visibility_disproven),
        assign_new_green_rep: true,
        flip_installed: flip,
      },
      activation_moment_flow: {
        active: false,
        phase: "complete",
        moment_text: prior.moment_text,
        activation_type: activation.type,
        coaching_mode: prior.coaching_mode || "activation",
        flip_installed: flip,
        completed_at: new Date().toISOString(),
      },
      structural_coaching_flow: {
        ...(openSession?.structural_coaching_flow || {}),
        disruption_complete: true,
        diagnosis_refined: Boolean(evolved?.visibility_disproven),
      },
    };
  }

  const activation = detectActivationMoment(userMessage);
  const prediction = activation ? null : detectFuturePrediction(userMessage);
  const moment = activation
    ? { ...activation, mode: "activation" }
    : prediction;
  if (!moment) return base;

  const evolved = inferEvolvedFailureStrategy(userMessage, map, journey, contextEvidence);

  return {
    ...base,
    block_green_rep: true,
    coaching_directive: formatOutcomeDirective(
      moment.mode === "prediction" ? "prediction_moment_investigate" : "activation_moment_investigate",
      {
        goal: "Separate facts from predictions before any Green Rep.",
        yourJob: [
          "acknowledge visible action if present",
          "investigate the activation moment",
          "separate facts from predictions",
        ],
        avoid: [
          "treating unknown outcome as failure",
          "generic confidence exercises",
          "repeating old failure strategy",
        ],
      },
    ),
    coaching_context: buildActivationMomentContext({
      moment,
      evolved,
      userMessage,
      map,
      contextFacts,
      contextEvidence,
      phase: "investigate",
    }),
    conversation_signals: {
      activation_moment_active: true,
      activation_moment_investigate: true,
      prediction_moment: moment.mode === "prediction",
      block_clarity_rep: true,
    },
    writeback_hints: {
      current_failure_strategy: evolved,
      current_resistance:
        moment.mode === "prediction"
          ? `Future prediction: ${activationTypeLabel(moment.type)}`
          : `Activation moment: ${activationTypeLabel(moment.type)}`,
      diagnosis_refined: Boolean(evolved?.visibility_disproven),
      assign_new_green_rep: false,
      coaching_insights: evolved?.visibility_disproven
        ? `Visibility disproven — superseded: ${evolved.superseded_rule}`
        : null,
    },
    activation_moment_flow: {
      active: true,
      phase: "investigate",
      moment_text: userMessage.trim().slice(0, 400),
      activation_type: moment.type,
      coaching_mode: moment.mode,
      evolved_failure: evolved,
      context_facts: contextFacts,
      started_at: new Date().toISOString(),
    },
    structural_coaching_flow: {
      ...(openSession?.structural_coaching_flow || {}),
      diagnosis_refined: Boolean(evolved?.visibility_disproven),
    },
  };
};

module.exports = {
  ACTIVATION_MOMENT_PATTERN,
  FUTURE_PREDICTION_PATTERNS,
  GENERIC_CONFIDENCE_REP_PATTERN,
  detectActivationMoment,
  detectFuturePrediction,
  detectCoachingMoment,
  classifyActivationType,
  inferEvolvedFailureStrategy,
  inferKnownFactsFromContext,
  buildActivationMomentContext,
  buildFlipMomentContext,
  buildFlipAlignedRep,
  resolveActivationMomentFlow,
};
