const { inferStructureType } = require("./stage1InferStructureType");

const pickGoalLabel = (structure = {}, goalContext = {}) => {
  const goal =
    goalContext.specific_goal?.trim() ||
    goalContext.goal_name?.trim() ||
    structure.goal_title?.trim() ||
    null;
  const outcome =
    goalContext.measurable_outcome?.trim() ||
    structure.desired_outcome?.trim() ||
    structure.milestones?.day_90?.trim() ||
    null;
  if (goal && outcome && goal !== outcome) {
    return `${goal} (${outcome})`;
  }
  return goal || outcome || "your goal";
};

const pickStructureLabel = (structure = {}) => {
  const fs = structure.failure_strategy;
  if (fs && typeof fs === "object") {
    const title = String(fs.title || "").trim();
    const rule = String(fs.rule || "").trim();
    if (title && title !== "Failure strategy") return title;
    if (rule) return rule;
  }
  const parts = [
    structure.orbit_pattern?.trim(),
    structure.protector_rule?.trim(),
    structure.EO?.trim(),
  ].filter(Boolean);
  return parts[0] || "your protective structure";
};

const buildContradictionStatement = (structure, goalContext) => {
  const existing = String(structure.contradiction_statement || "").trim();
  if (existing) return existing;

  const goal = pickGoalLabel(structure, goalContext);
  const structureLabel = pickStructureLabel(structure);
  const powering =
    structure.top_3_avoidance_behaviours?.[0]?.trim() ||
    structure.failure_strategy?.behaviours?.[0]?.trim() ||
    structure.orbit_pattern?.trim() ||
    "avoidance";

  return `You say you want ${goal}, but your structure says "${structureLabel}" — so you power ${powering} instead of progress.`;
};

const buildTakeoverMoment = (structure) => {
  const existing = structure.structure_takeover_moment;
  if (existing && typeof existing === "object") {
    const trigger = String(existing.trigger || "").trim();
    const ruleObeyed = String(existing.rule_obeyed || existing.rule || "").trim();
    const sabotage = String(
      existing.sabotage_sequence || existing.sabotage || "",
    ).trim();
    if (trigger || ruleObeyed || sabotage) {
      return {
        trigger: trigger || null,
        rule_obeyed: ruleObeyed || null,
        sabotage_sequence: sabotage || null,
      };
    }
  }

  const behaviours = Array.isArray(structure.top_3_avoidance_behaviours)
    ? structure.top_3_avoidance_behaviours.filter((x) => x?.trim())
    : [];
  const rule =
    structure.protector_rule?.trim() ||
    structure.failure_strategy?.rule?.trim() ||
    null;

  return {
    trigger:
      structure.core_fear?.trim() ||
      structure.perceived_risk?.trim() ||
      behaviours[0] ||
      null,
    rule_obeyed: rule,
    sabotage_sequence:
      structure.orbit_pattern?.trim() ||
      (behaviours.length ? behaviours.join(" → ") : null),
  };
};

const buildFlipProjection = (structure, goalContext) => {
  const existing = String(structure.flip_90_day_projection || "").trim();
  if (existing) return existing;

  const ss = structure.success_strategy;
  const actions = Array.isArray(ss?.behaviours)
    ? ss.behaviours.filter((x) => x?.trim()).slice(0, 3)
    : [];
  const belief = ss?.belief?.trim();
  const outcome =
    goalContext.measurable_outcome?.trim() ||
    structure.desired_outcome?.trim() ||
    structure.proof_of_success?.trim() ||
    "your 90-day outcome";

  const actionText = actions.length
    ? actions.join(", ")
    : ss?.behaviour?.trim() || ss?.success_rule?.trim() || "the flip actions";

  if (belief) {
    return `If you installed "${belief}" and took ${actionText} for 90 days, you'd be moving toward ${outcome} with proof you can be seen without collapsing.`;
  }
  return `If you lived the flip for 90 days — ${actionText} — you'd be on track toward ${outcome}.`;
};

const inferContradictionRate = (structure) => {
  const stored = String(structure.contradiction_rate || "").trim().toLowerCase();
  if (stored === "high" || stored === "medium" || stored === "low") return stored;

  const goal = pickGoalLabel(structure, {});
  const hasGoal = goal && goal !== "your goal";
  const hasAvoidance = Boolean(
    structure.top_3_avoidance_behaviours?.length ||
      structure.failure_strategy?.behaviours?.length,
  );
  if (hasGoal && hasAvoidance) return "high";
  return "medium";
};

/**
 * Add client-facing resistance narrative fields after LLM extraction.
 */
const enrichResistanceNarrative = (structure, options = {}) => {
  if (!structure || typeof structure !== "object") return structure;

  const goalContext = options.activeGoalContext || options.goalContext || {};
  const out = { ...structure };

  out.structure_type =
    String(out.structure_type || "").trim() ||
    inferStructureType({
      orbit_pattern: out.orbit_pattern,
      recovery_speed: out.recovery_speed,
      contradiction_rate: out.contradiction_rate || inferContradictionRate(out),
      current_loop: out.past_pattern,
      CL_estimate: out.CL_estimate ?? out.cl_estimate,
    });

  out.contradiction_statement = buildContradictionStatement(out, goalContext);
  out.structure_takeover_moment = buildTakeoverMoment(out);
  out.flip_90_day_projection = buildFlipProjection(out, goalContext);

  if (!out.contradiction_rate) {
    out.contradiction_rate = inferContradictionRate(out);
  }

  const ss = out.success_strategy;
  if (ss && typeof ss === "object") {
    if (!out.flip_belief?.trim() && ss.belief?.trim()) {
      out.flip_belief = ss.belief.trim();
    }
    if (!out.flip_rule?.trim()) {
      const rule = ss.success_rule?.trim() || ss.behaviour?.trim();
      if (rule) out.flip_rule = rule;
    }
  }

  return out;
};

module.exports = {
  enrichResistanceNarrative,
  inferStructureType,
  buildContradictionStatement,
  buildTakeoverMoment,
  buildFlipProjection,
};
