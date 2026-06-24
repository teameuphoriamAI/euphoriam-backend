/**
 * Evidence ↔ diagnosis — visibility actions, funnel stage, contradiction detection.
 * EVIDENCE OVERRIDES DIAGNOSIS when user behavior contradicts the active pattern.
 */

const { resolveFailureStrategyForMap } = require("../../../helpers/stage1MapStructure");
const { PROGRESSION_STAGES } = require("./bottleneckProgression");
const { formatOutcomeDirective } = require("./directive");

const VISIBILITY_ACTION_PATTERN =
  /\b(reached?\s+out|reach(?:ed|ing)?|sent|messaged|contacted|dm(?:ed)?|emailed|outreach|stated|quoted|named|offered|shared|submitted|pitch(?:ed)?)\b/i;

const CLIENT_OFFER_CONTEXT_PATTERN =
  /\b(client|prospect|customer|offer|proposal|rate|message|linkedin|dm)\b/i;

const OUTCOME_PENDING_PATTERN =
  /\b(no\s+(?:reply|response)|didn'?t\s+repl(?:y|ies)?|not\s+repl(?:y|ies)?|no\s+one\s+repl(?:ied|y)?|waiting\s+for|haven'?t\s+heard|assumed|they\s+won'?t|won'?t\s+repl(?:y|ies)?|ghost)\b/i;

const PURE_GAP_PATTERN =
  /\b(nothing\s+(?:happened|landed|special)|didn'?t\s+(?:do|reach|contact|send)|no\s+progress|feeling\s+lazy|lazy|procrastinat|slept|scrolled)\b/i;

const INBOUND_ONLY_GAP_PATTERN =
  /\bno\s+one\s+contacted\s+me\b|\bnobody\s+contacted\b|\bno\s+inbound\b/i;

const INVISIBILITY_DIAGNOSIS_PATTERN =
  /\b(financially\s+invisible|staying\s+invisible|stay\s+invisible|avoid\s+(?:being\s+)?(?:seen|visible|judg))\b/i;

const FUNNEL_ORDER = [
  PROGRESSION_STAGES.NO_PROSPECT,
  PROGRESSION_STAGES.PROSPECT_IDENTIFIED,
  PROGRESSION_STAGES.NO_CONTACT,
  PROGRESSION_STAGES.CONTACT_INITIATED,
  PROGRESSION_STAGES.CONVERSATION_STARTED,
  PROGRESSION_STAGES.PROPOSAL_SENT,
  PROGRESSION_STAGES.CLIENT_CLOSED,
];

const FUNNEL_LABELS = {
  [PROGRESSION_STAGES.NO_PROSPECT]: "Find prospect",
  [PROGRESSION_STAGES.PROSPECT_IDENTIFIED]: "Prospect found",
  [PROGRESSION_STAGES.NO_CONTACT]: "Reach out",
  [PROGRESSION_STAGES.CONTACT_INITIATED]: "Outreach sent",
  [PROGRESSION_STAGES.CONVERSATION_STARTED]: "Conversation started",
  [PROGRESSION_STAGES.PROPOSAL_SENT]: "Offer sent",
  [PROGRESSION_STAGES.CLIENT_CLOSED]: "Client closed",
};

const hasVisibilityAction = (text) => {
  const t = String(text || "").trim();
  if (!t || t.length < 4) return false;
  if (!VISIBILITY_ACTION_PATTERN.test(t)) return false;
  if (/\bdidn'?t\s+(?:reach|send|contact|message|do)\b/i.test(t) && !/\bbut\b/i.test(t)) {
    return false;
  }
  return CLIENT_OFFER_CONTEXT_PATTERN.test(t) || /\breach(?:ed|ing)?\b/i.test(t);
};

const hasOutcomePending = (text) => OUTCOME_PENDING_PATTERN.test(String(text || ""));

const isActionWithOutcomePending = (text) =>
  hasVisibilityAction(text) && hasOutcomePending(text);

const isPureGapNoAction = (text) => {
  const t = String(text || "").trim();
  if (!t) return false;
  if (hasVisibilityAction(t)) return false;
  return PURE_GAP_PATTERN.test(t) || INBOUND_ONLY_GAP_PATTERN.test(t);
};

const shouldNotLabelAsAvoidance = (text) => hasVisibilityAction(text);

const pickActiveFailureRule = (map, journey = null) =>
  journey?.evolved_failure?.rule ||
  resolveFailureStrategyForMap(map)?.rule ||
  map?.failure_strategy?.rule ||
  map?.protector_rule ||
  "";

const diagnosisIsInvisibility = (map, journey = null) =>
  INVISIBILITY_DIAGNOSIS_PATTERN.test(pickActiveFailureRule(map, journey));

const inferFunnelStageFromText = (text) => {
  const t = String(text || "");
  if (!t) return null;

  if (/\b(paid|payment|closed|signed|first\s+client\s+landed)\b/i.test(t) && /\b(got|received|landed)\b/i.test(t)) {
    return PROGRESSION_STAGES.CLIENT_CLOSED;
  }
  if (/\b(proposal|quote|offer)\b/i.test(t) && /\b(sent|submitted|shared)\b/i.test(t)) {
    return PROGRESSION_STAGES.PROPOSAL_SENT;
  }
  if (/\b(repl|respond|conversation|call|meeting|they\s+said)\b/i.test(t) && !/\bno\s+(?:reply|response)\b/i.test(t)) {
    return PROGRESSION_STAGES.CONVERSATION_STARTED;
  }
  if (hasVisibilityAction(t) || /\b(outreach|messaged|contacted|reached)\b/i.test(t)) {
    return PROGRESSION_STAGES.CONTACT_INITIATED;
  }
  if (/\b(identif|found|listed|picked)\w*\s+(?:\d+\s+)?(?:client|prospect|business|lead)/i.test(t)) {
    return PROGRESSION_STAGES.PROSPECT_IDENTIFIED;
  }
  return null;
};

const maxFunnelStage = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const ia = FUNNEL_ORDER.indexOf(a);
  const ib = FUNNEL_ORDER.indexOf(b);
  if (ia < 0) return b;
  if (ib < 0) return a;
  return ia >= ib ? a : b;
};

const inferFunnelStageFromContext = ({
  userMessage = "",
  messages = [],
  openSession = null,
  memoryCtx = null,
} = {}) => {
  let stage =
    openSession?.structural_coaching_flow?.progression_stage ||
    memoryCtx?.progression_stage ||
    PROGRESSION_STAGES.NO_PROSPECT;

  const texts = [
    ...(messages || []).filter((m) => m?.role === "user").map((m) => String(m.content || "")),
    String(userMessage || ""),
  ].filter(Boolean);

  for (const t of texts) {
    stage = maxFunnelStage(stage, inferFunnelStageFromText(t));
  }

  for (const proof of (memoryCtx?.recent_proofs || []).slice(-6)) {
    const action = typeof proof === "string" ? proof : proof?.action;
    if (action) stage = maxFunnelStage(stage, inferFunnelStageFromText(action));
  }

  return stage;
};

const buildFunnelStatusLines = (stage, { outcomePending = false } = {}) => {
  const idx = FUNNEL_ORDER.indexOf(stage);
  if (idx < 0) return [];
  const lines = [];
  for (let i = 0; i <= idx; i += 1) {
    const key = FUNNEL_ORDER[i];
    const label = FUNNEL_LABELS[key] || key;
    const pending =
      outcomePending &&
      key === PROGRESSION_STAGES.CONTACT_INITIATED &&
      i === idx;
    lines.push(`${label}${pending ? " — response pending" : " ✓"}`);
  }
  return lines;
};

const inferNewBottleneck = ({ userMessage, funnelStage, outcomePending }) => {
  if (outcomePending || funnelStage === PROGRESSION_STAGES.CONTACT_INITIATED) {
    if (/\bassum|predict|won'?t|before\s+(?:they|the)\s+repl/i.test(userMessage)) {
      return {
        type: "prediction_gap",
        label: "Premature negative assumptions before the market responds",
        stage: funnelStage,
      };
    }
    return {
      type: "follow_up_gap",
      label: "Follow-up or response-wait tolerance — outreach done, outcome unknown",
      stage: funnelStage,
    };
  }
  if (funnelStage === PROGRESSION_STAGES.PROPOSAL_SENT) {
    return {
      type: "close_gap",
      label: "Closing commitment or follow-up after offer sent",
      stage: funnelStage,
    };
  }
  if (funnelStage === PROGRESSION_STAGES.CONVERSATION_STARTED) {
    return {
      type: "offer_gap",
      label: "Offer clarity or rate named in conversation",
      stage: funnelStage,
    };
  }
  return {
    type: "strategy_gap",
    label: "Next funnel stage after visibility action",
    stage: funnelStage,
  };
};

const diagnosisContradictedByEvidence = ({
  userMessage = "",
  messages = [],
  map = null,
  journey = null,
  openSession = null,
  memoryCtx = null,
} = {}) => {
  const combined = [
    ...(messages || []).filter((m) => m?.role === "user").map((m) => String(m.content || "")),
    String(userMessage || ""),
  ].join(" ");

  const visibilityInMessage = hasVisibilityAction(userMessage) || hasVisibilityAction(combined);
  const invisibilityDiagnosis = diagnosisIsInvisibility(map, journey);
  const funnelStage = inferFunnelStageFromContext({
    userMessage,
    messages,
    openSession,
    memoryCtx,
  });
  const beyondOutreach = FUNNEL_ORDER.indexOf(funnelStage) >= FUNNEL_ORDER.indexOf(
    PROGRESSION_STAGES.CONTACT_INITIATED,
  );
  const outcomePending = hasOutcomePending(userMessage) || hasOutcomePending(combined);

  const contradicted =
    visibilityInMessage &&
    (beyondOutreach ||
      isActionWithOutcomePending(userMessage) ||
      isActionWithOutcomePending(combined) ||
      (invisibilityDiagnosis && visibilityInMessage));

  if (!contradicted) {
    return { contradicted: false, funnelStage, outcomePending, visibilityInMessage };
  }

  const newBottleneck = inferNewBottleneck({
    userMessage: userMessage || combined,
    funnelStage,
    outcomePending,
  });

  return {
    contradicted: true,
    funnelStage,
    outcomePending,
    removed_bottleneck: invisibilityDiagnosis ? "Staying financially invisible" : null,
    newBottleneck,
    visibility_action: true,
    facts: buildFunnelStatusLines(funnelStage, { outcomePending }),
  };
};

const buildFunnelAwareRep = ({
  funnelStage = null,
  goalContext = null,
  map = null,
  userMessage = "",
  outcomePending = false,
} = {}) => {
  const {
    progressionFromProof,
    PROOF_TYPES,
    PROGRESSION_STAGES,
  } = require("./bottleneckProgression");
  const goal = { goalContext, map };
  const stageIdx = FUNNEL_ORDER.indexOf(funnelStage);

  if (stageIdx >= FUNNEL_ORDER.indexOf(PROGRESSION_STAGES.CONTACT_INITIATED)) {
    const progression = progressionFromProof(
      {
        proof_type: PROOF_TYPES.OUTREACH_SENT,
        source_text: userMessage || (outcomePending ? "waiting for reply no response" : "outreach sent"),
      },
      goal,
    );
    if (progression?.next_green_rep) return progression.next_green_rep;
  }
  if (stageIdx >= FUNNEL_ORDER.indexOf(PROGRESSION_STAGES.CONVERSATION_STARTED)) {
    const progression = progressionFromProof(
      { proof_type: PROOF_TYPES.CONVERSATION_STARTED },
      goal,
    );
    if (progression?.next_green_rep) return progression.next_green_rep;
  }
  if (stageIdx >= FUNNEL_ORDER.indexOf(PROGRESSION_STAGES.PROPOSAL_SENT)) {
    const progression = progressionFromProof({ proof_type: PROOF_TYPES.PROPOSAL_SENT }, goal);
    if (progression?.next_green_rep) return progression.next_green_rep;
  }
  return null;
};

const buildEvidenceContradictionWriteback = ({ contradiction, map, journey, userMessage }) => {
  const hints = {
    diagnosis_refined: true,
    removed_bottleneck: contradiction.removed_bottleneck,
    progression_stage: contradiction.funnelStage,
    active_bottleneck: contradiction.newBottleneck,
    coaching_insights: `Evidence contradicted invisibility diagnosis. New bottleneck: ${contradiction.newBottleneck.label}`,
    progress_note: `Map refined from proof: ${String(userMessage || "").slice(0, 160)}`,
    current_resistance: contradiction.newBottleneck.label,
    current_failure_strategy: {
      rule: `${contradiction.newBottleneck.label} — invisibility pattern weakened by outreach proof`,
    },
  };

  const successBase =
    journey?.evolved_success?.behaviour || map?.success_strategy?.behaviour || map?.flip_rule;
  if (successBase) {
    hints.current_success_strategy = {
      behaviour: `${successBase} — evidenced by visible action`,
    };
  }

  return hints;
};

const buildEvidenceContradictionSignals = (ctx) => {
  const {
    userMessage,
    messages = [],
    map,
    memoryCtx,
    openSession,
    proofCycleFlow,
  } = ctx;

  const empty = {
    evidence_contradicts_diagnosis: false,
    visibility_action_occurred: false,
    outcome_pending: false,
    coaching_directive: null,
    coaching_context: null,
    writeback_hints: null,
    structural_coaching_flow: null,
    block_green_rep: false,
    assign_green_rep: false,
  };

  if (proofCycleFlow?.proof_integration_mode) return empty;

  const { detectActivationMoment } = require("./activation");
  if (detectActivationMoment(userMessage)) return empty;

  const { loadCoachingJourney } = require("../utils/evolution");
  const journey = loadCoachingJourney(memoryCtx, map, openSession);

  const contradiction = diagnosisContradictedByEvidence({
    userMessage,
    messages,
    map,
    journey,
    openSession,
    memoryCtx,
  });

  if (!contradiction.contradicted) return empty;

  const completedStages = FUNNEL_ORDER.slice(
    0,
    Math.max(0, FUNNEL_ORDER.indexOf(contradiction.funnelStage) + 1),
  );

  return {
    evidence_contradicts_diagnosis: true,
    visibility_action_occurred: hasVisibilityAction(userMessage),
    outcome_pending: Boolean(contradiction.outcomePending),
    coaching_directive: formatOutcomeDirective("evidence_contradicts_diagnosis", {
      goal: "Coaching map aligns with what the member actually did.",
      yourJob: [
        "acknowledge visible action first",
        "update bottleneck in writeback_hints",
        "coach next funnel stage forward",
      ],
      avoid: ["avoidance ran the day", "backward funnel reps", "outdated diagnosis replay"],
    }),
    coaching_context: {
      new_bottleneck_label: contradiction.newBottleneck.label,
      funnel_stage: contradiction.funnelStage,
      funnel_facts: contradiction.facts || [],
      removed_bottleneck: contradiction.removed_bottleneck,
      user_action_snippet: String(userMessage || "").trim().slice(0, 160),
    },
    writeback_hints: buildEvidenceContradictionWriteback({
      contradiction,
      map,
      journey,
      userMessage,
    }),
    structural_coaching_flow: {
      ...(openSession?.structural_coaching_flow || {}),
      progression_stage: contradiction.funnelStage,
      funnel_stages_completed: completedStages,
      removed_bottleneck: contradiction.removed_bottleneck,
      current_bottleneck: contradiction.newBottleneck,
      diagnosis_refined: true,
      disruption_complete: true,
      last_evidence_at: new Date().toISOString(),
    },
    block_green_rep: false,
    assign_green_rep: false,
  };
};

const buildEvidenceContradictionFlow = (ctx) => {
  const signals = buildEvidenceContradictionSignals(ctx);
  if (!signals.evidence_contradicts_diagnosis) {
    return {
      skip_llm: false,
      assistant_override: null,
      green_rep: null,
      coaching_directive: null,
      writeback_hints: null,
      structural_coaching_flow: null,
      evidence_signals: signals,
    };
  }

  return {
    skip_llm: false,
    assistant_override: null,
    green_rep: null,
    coaching_directive: signals.coaching_directive,
    writeback_hints: signals.writeback_hints,
    structural_coaching_flow: signals.structural_coaching_flow,
    evidence_signals: signals,
  };
};

const countDiagnosisRepeats = (journey = null, map = null) => {
  const failure = pickActiveFailureRule(map, journey);
  const key = failure.toLowerCase().slice(0, 40);
  if (!key) return 0;
  return (journey?.diagnosis_history || []).filter(
    (h) => h.includes(key.slice(0, 20)) || key.includes(String(h).slice(0, 20)),
  ).length;
};

const requiresNewBottleneckSearch = ({ journey, map, userMessage, messages }) => {
  const repeats = countDiagnosisRepeats(journey, map);
  if (repeats < 2) return false;
  const contradiction = diagnosisContradictedByEvidence({
    userMessage,
    messages,
    map,
    journey,
  });
  return contradiction.contradicted || hasVisibilityAction(userMessage);
};

module.exports = {
  VISIBILITY_ACTION_PATTERN,
  OUTCOME_PENDING_PATTERN,
  hasVisibilityAction,
  hasOutcomePending,
  isActionWithOutcomePending,
  isPureGapNoAction,
  shouldNotLabelAsAvoidance,
  diagnosisIsInvisibility,
  inferFunnelStageFromText,
  inferFunnelStageFromContext,
  buildFunnelStatusLines,
  inferNewBottleneck,
  diagnosisContradictedByEvidence,
  buildEvidenceContradictionSignals,
  buildEvidenceContradictionFlow,
  buildEvidenceContradictionWriteback,
  buildFunnelAwareRep,
  countDiagnosisRepeats,
  requiresNewBottleneckSearch,
  FUNNEL_LABELS,
};
