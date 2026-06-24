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

const norm = (v) => String(v || "").trim().toLowerCase();

const EO_FEAR = {
  "not enough": "that you are fundamentally not enough",
  "not capable": "that you are not capable of handling this",
  "not safe": "that you are not safe",
  powerless: "that you are powerless to change things",
  "can't depend": "that you cannot rely on anyone but yourself",
  "cant depend": "that you cannot rely on anyone but yourself",
  "needs not ok": "that your own needs make you unacceptable to others",
  "not ok vulnerable": "that being vulnerable will be used against you",
  "not ok happy": "that you are not allowed to fully have what you want",
};

const AVOID_FEAR = {
  rejection: "that if people truly saw you, they would judge or reject you",
  "rejection-protector": "that if people truly saw you, they would judge or reject you",
  failure: "that if you fully committed, you would fail and confirm something is wrong with you",
  "failure-protector": "that if you fully committed, you would fail and confirm something is wrong with you",
};

const AVOID_RISK = {
  rejection: "Being seen, judged, or rejected if you show your real self.",
  "rejection-protector": "Being seen, judged, or rejected if you show your real self.",
  failure: "Committing fully and failing — exposing yourself as not good enough.",
  "failure-protector": "Committing fully and failing — exposing yourself as not good enough.",
};

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const humanizeOrbit = (orbit) =>
  String(orbit || "")
    .replace(/\s*(?:→|—>|->|➝|⟶|=>)\s*/g, " then ")
    .replace(/\s*,\s*/g, "; ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Derive clean, domain-safe insight strings from the already-extracted
 * structured signature (EO / lack / avoid / orbit / flip). Used only to fill
 * fields the LLM left empty — never echoes the user's raw transcript answers.
 */
const synthesizeMissingInsights = (out) => {
  const eo = norm(out.EO);
  const avoid = norm(out.avoid_type);

  if (!out.core_fear?.trim()) {
    const eoPart = EO_FEAR[eo];
    const avoidPart = AVOID_FEAR[avoid];
    const parts = [eoPart, avoidPart].filter(Boolean);
    if (parts.length) out.core_fear = cap(`${parts.join(", and ")}.`);
  }

  if (!out.perceived_risk?.trim()) {
    if (AVOID_RISK[avoid]) out.perceived_risk = AVOID_RISK[avoid];
  }

  if (!out.past_pattern?.trim()) {
    const orbit = humanizeOrbit(out.orbit_pattern);
    if (orbit) {
      out.past_pattern = `The same loop keeps repeating: ${orbit} — instead of moving forward.`;
    }
  }

  if (!out.required_role?.trim()) {
    const belief =
      out.flip_belief?.trim() ||
      out.success_strategy?.belief?.trim() ||
      null;
    const rule =
      out.flip_rule?.trim() ||
      out.success_strategy?.success_rule?.trim() ||
      out.success_strategy?.behaviour?.trim() ||
      null;
    if (belief) {
      out.required_role = `The version of you who lives "${belief}"${
        rule ? ` and ${norm(rule).replace(/\.$/, "")}` : ""
      }.`;
    } else if (rule) {
      out.required_role = `Someone who can ${norm(rule).replace(/\.$/, "")} without collapsing.`;
    }
  }

  return out;
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

  // Guarantee the four insight fields are populated from structured signature
  // data when the LLM returned null — clean insight, never raw transcript text.
  synthesizeMissingInsights(out);

  return out;
};

module.exports = {
  enrichResistanceNarrative,
  inferStructureType,
  buildContradictionStatement,
  buildTakeoverMoment,
  buildFlipProjection,
};
