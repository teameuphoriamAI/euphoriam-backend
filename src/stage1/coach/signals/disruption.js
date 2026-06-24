/**
 * Mandatory disruption stage — contradiction → protector → old strategy → flip.
 * Detection and structured context only; Coach Brain generates wording.
 */

const { resolveFailureStrategyForMap } = require("../../../helpers/stage1MapStructure");
const { BOTTLENECK_TYPES, bottleneckLabel } = require("./bottleneck");

const DISRUPTION_MARKER = "Notice the loop";
const FLIP_MARKER = "The flip is";

const pickFailureLabel = (map) => {
  const fs = resolveFailureStrategyForMap(map);
  if (typeof fs === "string") return fs.trim();
  return (fs?.rule || fs?.title || map?.protector_rule || "").trim() || null;
};

const disruptionWasDelivered = (messages = [], openSession = null) => {
  if (openSession?.structural_coaching_flow?.disruption_complete) return true;
  const assistant = (messages || [])
    .filter((m) => m?.role === "assistant")
    .map((m) => String(m.content || ""))
    .join("\n");
  return assistant.includes(DISRUPTION_MARKER) && assistant.includes(FLIP_MARKER);
};

const buildDisruptionContext = ({ map, goalContext, bottleneck }) => {
  const milestone =
    goalContext?.current_milestone ||
    goalContext?.milestones?.day_7 ||
    goalContext?.goal_name ||
    map?.goal_title ||
    "current milestone";
  const goal = goalContext?.goal_name || map?.goal_title || "goal";
  const failure = pickFailureLabel(map);
  const protector = map?.protector_rule?.trim() || null;
  const flip = map?.flip_belief?.trim() || map?.flip_rule?.trim() || map?.success_strategy?.behaviour?.trim() || null;
  const contradiction = map?.contradiction_statement?.trim() || null;
  const bottleneckType = bottleneck?.type || BOTTLENECK_TYPES.RESISTANCE;
  const pricingLoop = /\b(rate|price|charge|client|income|dollar|\$|hour)\b/i.test(
    `${milestone} ${goal}`,
  );

  const ctx = {
    disruption_stage: true,
    bottleneck_type: bottleneckType,
    bottleneck_label: bottleneckLabel(bottleneckType),
    milestone,
    goal,
    failure_strategy: failure,
    protector_rule: protector,
    flip,
    contradiction,
    pricing_loop: pricingLoop,
  };

  if (bottleneckType === BOTTLENECK_TYPES.STRATEGY) {
    ctx.gap_focus = "client acquisition strategy — channel, list, conversations, pricing feedback";
    ctx.service_hint =
      /\b(web\s+dev|development|design|coaching|consulting)\b/i.exec(bottleneck?.evidence || "")?.[0] ||
      null;
    ctx.clarifying_question_theme = "where to find buyers, what to offer, or what to charge";
  } else if (
    bottleneckType === BOTTLENECK_TYPES.KNOWLEDGE ||
    bottleneckType === BOTTLENECK_TYPES.SKILL
  ) {
    ctx.gap_focus = "knowledge gap — how-to for next milestone step";
    ctx.clarifying_question_theme = "single how-to question that unlocks the next step";
  } else if (bottleneckType === BOTTLENECK_TYPES.RESOURCE) {
    ctx.gap_focus = "resource gap — missing portfolio or credibility assets";
    ctx.clarifying_question_theme = "minimum asset needed before outreach";
  } else if (pricingLoop) {
    ctx.loop_pattern = "no outreach → no market feedback → no pricing confidence";
    ctx.old_strategy = "figure everything out before talking to clients";
  }

  return ctx;
};

const buildBottleneckAcknowledgmentContext = ({ bottleneck, goalContext }) => ({
  disruption_repeat_detected: true,
  acknowledged_bottleneck_type: bottleneck?.type,
  acknowledged_bottleneck_label: bottleneckLabel(bottleneck?.type),
  milestone:
    goalContext?.current_milestone ||
    goalContext?.milestones?.day_7 ||
    "current milestone",
});

module.exports = {
  DISRUPTION_MARKER,
  FLIP_MARKER,
  disruptionWasDelivered,
  buildDisruptionContext,
  buildBottleneckAcknowledgmentContext,
  pickFailureLabel,
};
