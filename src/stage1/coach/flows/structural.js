/**
 * Goal-Specific Structural Coach flow:
 * Goal → Milestone → Bottleneck → Disruption → Flip → Green Rep → Proof → Integration
 */

const { classifyBottleneckFromTranscript, isNonResistanceBottleneck, BOTTLENECK_TYPES } = require("../signals/bottleneck");
const {
  disruptionWasDelivered,
  buildDisruptionContext,
  buildBottleneckAcknowledgmentContext,
} = require("../signals/disruption");
const { formatOutcomeDirective } = require("../signals/directive");
const {
  loadCoachingJourney,
  evolveStrategiesFromBottleneck,
  buildJourneyContextDirective,
  wouldRepeatCrossSessionDiagnosis,
} = require("../utils/evolution");
const {
  buildMilestoneAlignedRep,
  buildMilestonePriorityDirective,
} = require("../utils/milestoneRep");
const { detectUncertaintySignal } = require("../signals/investigation");
const { detectProofMilestone } = require("../signals/bottleneckProgression");

const isSubstantiveAnswer = (text) => {
  const t = String(text || "").trim();
  return t.length >= 12 && !detectUncertaintySignal(t);
};

const shouldAttemptRepAssignment = ({
  proofCycleFlow,
  firstSessionFlow,
  investigationFlow,
  transitionBrief,
}) => {
  if (proofCycleFlow?.proof_integration_mode || proofCycleFlow?.awaiting_proof_log) return false;
  if (firstSessionFlow?.active) return false;
  if (investigationFlow?.active) return false;
  if (transitionBrief?.assign_green_rep) return true;
  return false;
};

const resolveStructuralCoachingFlow = ({
  messages = [],
  userMessage = "",
  map = null,
  goalContext = null,
  memoryCtx = null,
  openSession = null,
  proofCycleFlow = null,
  firstSessionFlow = null,
  investigationFlow = null,
  transitionBrief = null,
} = {}) => {
  const base = {
    skip_llm: false,
    assistant_override: null,
    coaching_directive: null,
    block_green_rep: false,
    disruption_required: false,
    disruption_complete: false,
    active_bottleneck: null,
    suggested_milestone_rep: null,
    structural_coaching_flow: openSession?.structural_coaching_flow || null,
  };

  if (!map?.map_resistance_complete) return base;
  if (proofCycleFlow?.proof_integration_mode) return base;

  const { buildEvidenceContradictionFlow } = require("../signals/evidence");
  const evidenceFlow = buildEvidenceContradictionFlow({
    userMessage,
    messages,
    map,
    goalContext,
    memoryCtx,
    openSession,
    proofCycleFlow,
  });
  if (evidenceFlow.coaching_directive) {
    return {
      ...base,
      coaching_directive: evidenceFlow.coaching_directive,
      structural_coaching_flow:
        evidenceFlow.structural_coaching_flow || openSession?.structural_coaching_flow || null,
      block_green_rep: evidenceFlow.evidence_signals?.block_green_rep || false,
    };
  }

  if (proofCycleFlow?.proof_integration_mode || proofCycleFlow?.awaiting_proof_log) {
    return {
      ...base,
      block_green_rep: true,
      coaching_directive:
        "PROOF CYCLE ACTIVE — integration or proof logging in progress. " +
        "Do NOT re-deliver diagnosis, protector, flip, or the same Green Rep.",
    };
  }
  if (transitionBrief?.conversation_signals?.user_completed_current_rep) {
    return {
      ...base,
      block_green_rep: true,
      coaching_directive:
        "REP JUST COMPLETED — proof integration only. Do NOT restart diagnosis or reassign the same rep.",
    };
  }
  if (firstSessionFlow?.active) return base;
  if (investigationFlow?.active) return base;
  if (openSession?.structural_coaching_flow?.proof_investigation?.active) return base;
  if (openSession?.activation_moment_flow?.active) return base;

  const {
    inferFunnelStageFromContext,
    diagnosisIsInvisibility,
    requiresNewBottleneckSearch,
  } = require("../signals/evidence");
  const journeyEarly = loadCoachingJourney(memoryCtx, map, openSession);
  const funnelStage = inferFunnelStageFromContext({
    userMessage,
    messages,
    openSession,
    memoryCtx,
  });
  const funnelPastOutreach =
    [
      "contact_initiated",
      "conversation_started",
      "proposal_sent",
      "client_closed",
    ].includes(funnelStage);

  if (funnelPastOutreach && diagnosisIsInvisibility(map, journeyEarly)) {
    return {
      ...base,
      block_green_rep: true,
      coaching_directive:
        "FUNNEL AWARENESS — outreach/offer stages already complete. " +
        "Do NOT repeat financially invisible diagnosis. Do NOT assign find-prospect or reach-out reps. " +
        "Coach the next funnel bottleneck only.",
      structural_coaching_flow: {
        ...(openSession?.structural_coaching_flow || {}),
        progression_stage: funnelStage,
      },
    };
  }

  if (requiresNewBottleneckSearch({ journey: journeyEarly, map, userMessage, messages })) {
    return {
      ...base,
      block_green_rep: true,
      coaching_directive:
        "NO DIAGNOSIS LOOPS — same diagnosis repeated without supporting evidence. " +
        "Search for a more accurate active bottleneck. Do NOT re-deliver invisibility disruption.",
    };
  }
  const { detectCoachingMoment } = require("../signals/activation");
  if (detectCoachingMoment(userMessage)) return base;
  if (detectProofMilestone(userMessage)) return base;

  const priorFlow = openSession?.structural_coaching_flow || {};
  const journey = loadCoachingJourney(memoryCtx, map, openSession);
  const bottleneck = classifyBottleneckFromTranscript(messages, userMessage);
  const disruptionComplete =
    Boolean(priorFlow.disruption_complete) || disruptionWasDelivered(messages, openSession);
  const wantsRep = shouldAttemptRepAssignment({
    proofCycleFlow,
    firstSessionFlow,
    investigationFlow,
    transitionBrief,
  });

  const flowState = {
    ...priorFlow,
    active_bottleneck: bottleneck,
    journey_snapshot: {
      last_rep: journey.last_green_rep,
      proof_count: journey.proof_count,
    },
  };

  const journeyDirective = buildJourneyContextDirective(journey, bottleneck);
  const evolutionHints = evolveStrategiesFromBottleneck({ bottleneck, map, journey });

  if (priorFlow.disruption_asked && !disruptionComplete && isSubstantiveAnswer(userMessage)) {
    const milestoneRep = buildMilestoneAlignedRep({
      map,
      goalContext,
      memoryCtx,
      bottleneck,
      journey,
    });
    return {
      ...base,
      skip_llm: false,
      disruption_complete: true,
      block_green_rep: !wantsRep,
      suggested_milestone_rep: milestoneRep,
      coaching_directive:
        `${journeyDirective} Disruption acknowledged — assign suggested_milestone_rep if appropriate. ` +
        `Bottleneck: ${bottleneck.type}. Do NOT repeat disruption block.`,
      active_bottleneck: bottleneck,
      structural_coaching_flow: {
        ...flowState,
        disruption_complete: true,
        disruption_asked: true,
      },
      evolution_hints: evolutionHints,
    };
  }

  if (isNonResistanceBottleneck(bottleneck) && isSubstantiveAnswer(userMessage) && !disruptionComplete) {
    return {
      ...base,
      skip_llm: false,
      block_green_rep: true,
      disruption_required: true,
      coaching_directive: formatOutcomeDirective("disruption_required", {
        goal: "Deliver disruption for non-resistance bottleneck before any Green Rep.",
        yourJob: [
          "surface contradiction and old strategy",
          "install flip conversationally",
          "clarify primary gap type",
        ],
        avoid: ["financially invisible diagnosis", "green rep assignment this turn"],
      }),
      coaching_context: buildDisruptionContext({ map, goalContext, bottleneck }),
      conversation_signals: {
        disruption_required: true,
        disruption_non_resistance: true,
      },
      active_bottleneck: bottleneck,
      structural_coaching_flow: {
        ...flowState,
        disruption_asked: true,
        disruption_complete: false,
      },
      evolution_hints: evolutionHints,
    };
  }

  if (wantsRep && !disruptionComplete) {
    const disruptionCtx = buildDisruptionContext({
      map,
      goalContext,
      bottleneck: isNonResistanceBottleneck(bottleneck)
        ? bottleneck
        : { type: BOTTLENECK_TYPES.RESISTANCE, ...bottleneck },
    });

    if (
      wouldRepeatCrossSessionDiagnosis(
        `${disruptionCtx.failure_strategy || ""} ${disruptionCtx.flip || ""}`,
        journey,
      ) &&
      !isNonResistanceBottleneck(bottleneck)
    ) {
      return {
        ...base,
        skip_llm: false,
        block_green_rep: true,
        disruption_required: true,
        coaching_directive: formatOutcomeDirective("disruption_repeat", {
          goal: "Break diagnosis repetition loop — find what changed today.",
          yourJob: ["acknowledge prior pattern was named", "ask what is different today"],
          avoid: ["re-delivering same diagnosis", "green rep assignment"],
        }),
        coaching_context: {
          ...buildBottleneckAcknowledgmentContext({ bottleneck, goalContext }),
          ...disruptionCtx,
        },
        conversation_signals: {
          disruption_repeat_detected: true,
          diagnosis_would_repeat: true,
        },
        active_bottleneck: bottleneck,
        structural_coaching_flow: { ...flowState, disruption_asked: true },
        evolution_hints: evolutionHints,
      };
    }

    return {
      ...base,
      skip_llm: false,
      block_green_rep: true,
      disruption_required: true,
      coaching_directive: formatOutcomeDirective("disruption_required", {
        goal: "Mandatory disruption before first Green Rep on this edge.",
        yourJob: [
          "surface contradiction, protector, old strategy, flip",
          "prepare member for milestone-aligned rep next",
        ],
        avoid: ["assigning green rep this turn"],
      }),
      coaching_context: disruptionCtx,
      conversation_signals: { disruption_required: true },
      active_bottleneck: bottleneck,
      structural_coaching_flow: {
        ...flowState,
        disruption_asked: true,
        disruption_complete: false,
      },
      evolution_hints: evolutionHints,
    };
  }

  if (disruptionComplete || (priorFlow.disruption_asked && isSubstantiveAnswer(userMessage))) {
    const milestoneRep = buildMilestoneAlignedRep({
      map,
      goalContext,
      memoryCtx,
      bottleneck,
      journey,
    });

    const coaching_directive =
      `${journeyDirective} ${buildMilestonePriorityDirective({
        map,
        goalContext,
        milestoneRep,
      })} ` +
      `Active bottleneck: ${bottleneck.type}. ` +
      (wantsRep
        ? "Disruption complete — assign suggested_milestone_rep in green_rep JSON."
        : "Proof integration or coaching — evolve strategies from evidence; no immediate new rep after proof.");

    return {
      ...base,
      disruption_complete: true,
      block_green_rep: !wantsRep,
      suggested_milestone_rep: milestoneRep,
      coaching_directive,
      active_bottleneck: bottleneck,
      structural_coaching_flow: {
        ...flowState,
        disruption_complete: true,
        disruption_asked: true,
      },
      evolution_hints: evolutionHints,
    };
  }

  return {
    ...base,
    coaching_directive: journeyDirective || null,
    active_bottleneck: bottleneck,
    evolution_hints: evolutionHints,
    structural_coaching_flow: flowState,
  };
};

module.exports = {
  resolveStructuralCoachingFlow,
  shouldAttemptRepAssignment,
};
