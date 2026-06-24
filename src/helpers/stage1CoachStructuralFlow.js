/**
 * Goal-Specific Structural Coach flow:
 * Goal → Milestone → Bottleneck → Disruption → Flip → Green Rep → Proof → Integration
 */

const { classifyBottleneckFromTranscript, isNonResistanceBottleneck, BOTTLENECK_TYPES } = require("./stage1CoachBottleneck");
const {
  disruptionWasDelivered,
  buildDisruptionMessage,
  buildBottleneckAcknowledgment,
} = require("./stage1CoachDisruption");
const {
  loadCoachingJourney,
  evolveStrategiesFromBottleneck,
  buildJourneyContextDirective,
  wouldRepeatCrossSessionDiagnosis,
} = require("./stage1CoachEvolution");
const {
  buildMilestoneAlignedRep,
  buildMilestonePriorityDirective,
} = require("./stage1CoachMilestoneRep");
const { detectUncertaintySignal } = require("./stage1CoachInvestigation");
const { detectProofMilestone } = require("./stage1CoachBottleneckProgression");

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
  if (firstSessionFlow?.skip_llm) return false;
  if (investigationFlow?.skip_llm || investigationFlow?.active) return false;
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
  if (proofCycleFlow?.skip_llm) return base;
  if (firstSessionFlow?.skip_llm) return base;
  if (investigationFlow?.skip_llm) return base;
  if (openSession?.structural_coaching_flow?.proof_investigation?.active) return base;
  if (openSession?.activation_moment_flow?.active) return base;
  const { detectCoachingMoment } = require("./stage1CoachActivationMoment");
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
      skip_llm: true,
      block_green_rep: true,
      disruption_required: true,
      assistant_override: buildDisruptionMessage({ map, goalContext, bottleneck }),
      coaching_directive:
        `${journeyDirective} BOTTLENECK: ${bottleneck.type} — NOT resistance. ` +
        "Deliver disruption for this gap type. Do NOT assign Green Rep yet. Do NOT say financially invisible.",
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
    const disruptionMsg = buildDisruptionMessage({
      map,
      goalContext,
      bottleneck: isNonResistanceBottleneck(bottleneck)
        ? bottleneck
        : { type: BOTTLENECK_TYPES.RESISTANCE, ...bottleneck },
    });

    if (
      wouldRepeatCrossSessionDiagnosis(disruptionMsg, journey) &&
      !isNonResistanceBottleneck(bottleneck)
    ) {
      return {
        ...base,
        skip_llm: true,
        block_green_rep: true,
        disruption_required: true,
        assistant_override:
          buildBottleneckAcknowledgment({ bottleneck, goalContext }) +
          `\n\nWe've named this pattern before. What's **different today** — same loop, or a new bottleneck?`,
        coaching_directive:
          `${journeyDirective} ANTI-REPEAT: Do not re-deliver same diagnosis. Ask what changed. No Green Rep.`,
        active_bottleneck: bottleneck,
        structural_coaching_flow: { ...flowState, disruption_asked: true },
        evolution_hints: evolutionHints,
      };
    }

    return {
      ...base,
      skip_llm: true,
      block_green_rep: true,
      disruption_required: true,
      assistant_override: disruptionMsg,
      coaching_directive:
        `${journeyDirective} DISRUPTION STAGE — mandatory before Green Rep. ` +
        "Surface contradiction, protector, old strategy, flip. Do NOT assign rep this turn.",
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
