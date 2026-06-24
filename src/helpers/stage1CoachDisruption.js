/**
 * Mandatory disruption stage — contradiction → protector → old strategy → flip.
 * Required before Green Rep assignment.
 */

const { resolveFailureStrategyForMap } = require("./stage1MapStructure");
const { BOTTLENECK_TYPES, isNonResistanceBottleneck, bottleneckLabel } = require("./stage1CoachBottleneck");

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

const buildStrategyGapDisruption = ({ map, goalContext, bottleneck }) => {
  const goal = goalContext?.goal_name || map?.goal_title || "your goal";
  const milestone =
    goalContext?.current_milestone || goalContext?.milestones?.day_7 || "your milestone";
  const service =
    /\b(web\s+dev|development|design|coaching|consulting)\b/i.exec(bottleneck?.evidence || "")?.[0] ||
    "your offer";

  return (
    `Your blocker doesn't sound like outreach resistance right now.\n\n` +
    `It sounds like you don't yet have a **client acquisition strategy** for ${service} toward ${milestone}.\n\n` +
    `${DISRUPTION_MARKER}:\n` +
    `No clear channel → no list → no conversations → no clients → no pricing feedback.\n\n` +
    `The old strategy: figure out how, where, when, and what **before** talking to anyone.\n\n` +
    `${FLIP_MARKER}: build a simple acquisition path first — then talk to real prospects to refine it.\n\n` +
    `Before we assign action: which is most missing — where to find buyers, what to offer, or what to charge?`
  );
};

const buildKnowledgeGapDisruption = ({ map, goalContext }) => {
  const milestone =
    goalContext?.current_milestone || goalContext?.milestones?.day_7 || "your milestone";
  const flip = map?.flip_belief?.trim() || map?.flip_rule?.trim() || "learn from the market, not from guessing";

  return (
    `This looks like a **knowledge gap**, not laziness.\n\n` +
    `You don't need more willpower — you need one clear how-to for ${milestone}.\n\n` +
    `${DISRUPTION_MARKER}: guessing alone → no feedback → more guessing.\n\n` +
    `The old strategy: know everything before acting.\n\n` +
    `${FLIP_MARKER}: "${flip.slice(0, 100)}" — one small test teaches more than a week of prep.\n\n` +
    `What's the single how-to question that would unlock the next step?`
  );
};

const buildResourceGapDisruption = ({ map, goalContext }) => {
  const milestone =
    goalContext?.current_milestone || goalContext?.milestones?.day_7 || "your milestone";

  return (
    `This looks like a **resource gap** — missing assets, not avoidance.\n\n` +
    `You can't sell what people can't see yet. Milestone: ${milestone}.\n\n` +
    `${DISRUPTION_MARKER}: no portfolio/samples → no credibility → no conversations.\n\n` +
    `The old strategy: wait until everything is perfect.\n\n` +
    `${FLIP_MARKER}: ship one credible asset, then start outreach with something real to show.\n\n` +
    `What's the minimum asset you need before outreach — one page, one sample, one case study?`
  );
};

const buildResistanceDisruption = ({ map, goalContext }) => {
  const contradiction =
    map?.contradiction_statement?.trim() ||
    `You want ${goalContext?.goal_name || map?.goal_title || "the goal"}, but your structure keeps you safe instead of visible.`;
  const protector = map?.protector_rule?.trim() || "stay safe by not taking visible action";
  const failure = pickFailureLabel(map) || "your failure strategy";
  const flip = map?.flip_belief?.trim() || map?.flip_rule?.trim() || map?.success_strategy?.behaviour?.trim();
  const milestone =
    goalContext?.current_milestone || goalContext?.milestones?.day_7 || "your milestone";

  const pricingLoop =
    /\b(rate|price|charge|client|income|dollar|\$|hour)\b/i.test(
      `${milestone} ${goalContext?.goal_name || ""}`,
    );

  let loopBlock = "";
  if (pricingLoop) {
    loopBlock =
      `You say you need the perfect rate before talking to clients.\n\n` +
      `But the businesses who could tell you what they would pay are the very people you're waiting to talk to.\n\n` +
      `${DISRUPTION_MARKER}:\n` +
      `No outreach → no market feedback.\n` +
      `No market feedback → no pricing confidence.\n\n` +
      `The old strategy: figure everything out before talking to clients.\n\n`;
  } else {
    loopBlock =
      `${contradiction}\n\n` +
      `${DISRUPTION_MARKER}: ${failure} obeys "${protector.slice(0, 120)}".\n\n` +
      `The old strategy: ${failure}.\n\n`;
  }

  return (
    `${loopBlock}` +
    `${FLIP_MARKER}: ${flip ? `"${flip.slice(0, 120)}"` : "act before the structure feels ready"}.\n\n` +
    `That's the disruption — not motivation. Ready for one milestone move?`
  );
};

const buildDisruptionMessage = ({ map, goalContext, bottleneck }) => {
  if (bottleneck?.type === BOTTLENECK_TYPES.STRATEGY) {
    return buildStrategyGapDisruption({ map, goalContext, bottleneck });
  }
  if (bottleneck?.type === BOTTLENECK_TYPES.KNOWLEDGE) {
    return buildKnowledgeGapDisruption({ map, goalContext });
  }
  if (bottleneck?.type === BOTTLENECK_TYPES.RESOURCE) {
    return buildResourceGapDisruption({ map, goalContext });
  }
  if (bottleneck?.type === BOTTLENECK_TYPES.SKILL) {
    return buildKnowledgeGapDisruption({ map, goalContext });
  }
  return buildResistanceDisruption({ map, goalContext });
};

const buildBottleneckAcknowledgment = ({ bottleneck, goalContext }) => {
  const milestone =
    goalContext?.current_milestone || goalContext?.milestones?.day_7 || "your milestone";
  return (
    `Got it — primary bottleneck: **${bottleneckLabel(bottleneck?.type)}** for ${milestone}.\n\n` +
    `We'll solve that first, not label it as resistance.`
  );
};

module.exports = {
  DISRUPTION_MARKER,
  FLIP_MARKER,
  disruptionWasDelivered,
  buildDisruptionMessage,
  buildStrategyGapDisruption,
  buildResistanceDisruption,
  buildBottleneckAcknowledgment,
};
