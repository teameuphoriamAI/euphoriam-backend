/**
 * Coach activation moments and future predictions.
 * Flow: Evidence → Investigate → Insight → Flip → Rep (never Rep before Flip).
 * Standalone predictions ("I feel like they won't reply") get facts-vs-predictions coaching.
 */

const { resolveFailureStrategyForMap } = require("./stage1MapStructure");
const { loadCoachingJourney } = require("./stage1CoachEvolution");

const ACTIVATION_MOMENT_PATTERN =
  /\b(reached|sent|messaged|contacted|stated|quoted|named|offered|shared)\b[\s\S]{0,120}\b(?:but|then|however|though)\b[\s\S]{0,120}\b(hold|held back|thought|afraid|scared|won'?t|wouldn'?t|too high|too much|reject|reply|respond|interest|pull|back|anxious)/i;

const ACTIVATION_PRICE_FEAR =
  /\b(thought the price|price (?:is|was) too high|too expensive|can'?t afford|overpriced)\b/i;

const ACTIVATION_REJECTION_PREDICTION =
  /\b(won'?t reply|won'?t respond|they won'?t|no (?:reply|response)|ghost|not interested|before.*(?:reply|response|answer))\b/i;

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
  /\b(reached|sent|messaged|contacted|stated|quoted|clear rate|outreach|identified (?:a )?client|named (?:my )?rate)\b/i;

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

const buildInvestigateActivationMessage = ({ activation, evolved, userMessage, map }) => {
  const actionMatch = String(userMessage || "").match(
    /\b(reached|sent|messaged|contacted|stated)[^.!?]{0,60}/i,
  );
  const actionBit = actionMatch ? actionMatch[0].trim() : "You took visible action";
  const momentBit = extractMomentSnippet(userMessage);

  let question =
    "What evidence did you have for that fear — did the client tell you, or did you decide before any response?";
  if (activation.type === "self_rejecting_price") {
    question =
      "What evidence did you have that the price was too high — did the client say that, or did you decide before receiving any response?";
  } else if (activation.type === "predicting_rejection") {
    question =
      "What evidence did you have that they won't reply — have they responded yet, or did you predict that before hearing back?";
  }

  let visibilityNote = "";
  if (evolved?.visibility_disproven) {
    visibilityNote =
      `\n\n(Map update: outreach + rate stated — **staying financially invisible is no longer the primary failure strategy.** We're coaching the moment resistance fired instead.)\n`;
  }

  return (
    `${actionBit} — that's real movement toward your milestone.\n\n` +
    `Then this fired: "${momentBit}."\n\n` +
    `Slow down on that exact moment — this is the highest-value coaching data.${visibilityNote}\n` +
    `${question}`
  );
};

const formatPredictionLabel = (prediction, type) => {
  const p = String(prediction || "").trim();
  if (p) return p.charAt(0).toLowerCase() === "that" ? p : `That ${p.replace(/^they\b/i, "they")}`;
  if (type === "self_rejecting_price") return "The price is too high";
  if (type === "predicting_rejection") return "They won't reply";
  return "The outcome will be negative";
};

const buildInvestigatePredictionMessage = ({
  moment,
  evolved,
  userMessage,
  contextFacts = [],
  contextEvidence = null,
}) => {
  const predictionLabel = formatPredictionLabel(moment.prediction, moment.type);
  const factLines =
    contextFacts.length > 0
      ? contextFacts.map((f) => `- ${f}`).join("\n")
      : "- You took visible action toward your milestone";

  let unknownNote = "";
  if (contextEvidence?.outcomeUnknown) {
    unknownNote =
      "\n\nThe outcome is still **unknown** — that is not failure. Rejection has not happened yet.";
  }

  let visibilityNote = "";
  if (evolved?.visibility_disproven) {
    visibilityNote =
      "\n\n(Map update: prospect found, outreach done — **staying invisible is no longer the active failure strategy.** Coaching the prediction instead.)\n";
  }

  return (
    `Maybe. But let's separate what happened from what you're predicting.${visibilityNote}\n\n` +
    `**What actually happened?**\n${factLines}\n\n` +
    `**What are you predicting?**\n- ${predictionLabel}.\n\n` +
    `Did they tell you that, or is your mind filling in the blank?${unknownNote}`
  );
};

const buildInvestigateMomentMessage = ({
  moment,
  evolved,
  userMessage,
  map,
  contextFacts = [],
  contextEvidence = null,
}) => {
  if (moment.mode === "prediction") {
    return buildInvestigatePredictionMessage({
      moment,
      evolved,
      userMessage,
      contextFacts,
      contextEvidence,
    });
  }
  return buildInvestigateActivationMessage({ activation: moment, evolved, userMessage, map });
};

const isInvestigateAnswer = (text) => {
  const t = String(text || "").trim();
  if (!t || t.length < 6) return false;
  if (/^(yes|no|yup|yeah|ok|okay|idk)\s*\.?$/i.test(t)) return false;
  return true;
};

const buildFlipAndRepMessage = ({ activation, evolved, userMessage, map, priorMoment }) => {
  const protector = map?.protector_rule?.trim() || "stay safe by predicting rejection before it happens";
  const selfDecided =
    /\b(i decided|no they didn|before they|just (?:thought|felt|assumed)|didn'?t (?:say|tell)|no evidence|made it up|in my head)\b/i.test(
      userMessage,
    ) || !/\b(they said|client said|told me)\b/i.test(userMessage);

  const hiddenPrediction =
    activation?.type === "self_rejecting_price"
      ? "the price was too high"
      : activation?.type === "predicting_rejection"
        ? "they won't reply or engage"
        : "the outcome would be negative";

  const flip = "Let the market answer before you answer for it.";
  const unknownNote =
    priorMoment?.mode === "prediction" || activation?.type === "predicting_rejection"
      ? "\n\n**Unknown ≠ failure.** No reply yet is not rejection — your mind is treating uncertainty as a verdict."
      : "";

  const rep = buildFlipAlignedRep(activation?.type);

  return {
    message:
      `That's the internal rule exposed.\n\n` +
      `**Hidden prediction:** ${hiddenPrediction}.\n` +
      `**Protector:** ${protector.slice(0, 120)}.\n` +
      `**Evidence:** You ${selfDecided ? "decided that before the client could respond" : "named what showed up"}.\n\n` +
      `Old strategy: answer for the client before they speak.\n\n` +
      `**The flip:** ${flip}${unknownNote}\n\n` +
      `**Next Green Rep:** ${rep.name}\n` +
      `Win: ${rep.win_condition}`,
    rep,
    flip,
    evolved_failure: {
      rule: evolved?.rule || activationTypeLabel(activation?.type),
      flip_installed: flip,
    },
  };
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
    const { message, rep, flip, evolved_failure } = buildFlipAndRepMessage({
      activation,
      evolved,
      userMessage,
      map,
      priorMoment: activation,
    });

    return {
      skip_llm: true,
      assistant_override: message,
      green_rep: rep,
      block_green_rep: false,
      coaching_directive:
        (prior.coaching_mode === "prediction" ? "PREDICTION MOMENT" : "ACTIVATION MOMENT") +
        " — insight and flip delivered. Assign flip-aligned green_rep only. " +
        "No generic confidence exercises. No repeating financially invisible diagnosis. Unknown ≠ failure.",
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
    skip_llm: true,
    assistant_override: buildInvestigateMomentMessage({
      moment,
      evolved,
      userMessage,
      map,
      contextFacts,
      contextEvidence,
    }),
    green_rep: null,
    block_green_rep: true,
    coaching_directive:
      (moment.mode === "prediction" ? "PREDICTION MOMENT" : "ACTIVATION MOMENT") +
      " — investigate before any Green Rep. Separate facts from predictions. " +
      "Do NOT treat unknown outcome as failure. Do NOT use generic confidence exercises. " +
      "Map may be updating — do not repeat old failure strategy.",
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
  buildInvestigateActivationMessage,
  buildInvestigatePredictionMessage,
  buildInvestigateMomentMessage,
  buildFlipAndRepMessage,
  buildFlipAlignedRep,
  resolveActivationMomentFlow,
};
