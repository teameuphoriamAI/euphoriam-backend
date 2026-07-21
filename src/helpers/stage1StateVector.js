/**
 * STATE_VECTOR_V2 builder and validator.
 * @see docs/EUPHORIAM-STAGE1-STAGE2-README.md §16
 */

const { buildActiveGoalContext } = require("./stage1GoalContext");

const REQUIRED_SCALAR_KEYS = ["active_domain", "specific_goal"];

const pick = (obj, key, fallback = null) => {
  const v = obj?.[key];
  if (v === undefined || v === null || v === "") return fallback;
  return v;
};

/**
 * Build STATE_VECTOR_V2 from stage1 state + domain map for coach / writeback.
 */
const buildStateVectorV2 = ({ userId, stage1, map, domain, checkin = {} }) => {
  const goalCtx = buildActiveGoalContext(map, domain);
  const metrics = map?.progress_metrics || {};
  const treatment = map?.treatment_plan_30d || {};
  const currentWeek = treatment?.current_week ?? map?.treatment_week ?? null;
  const currentDay = treatment?.current_day ?? map?.treatment_day ?? null;

  return {
    user_id: userId ?? null,
    active_domain: domain,
    active_goal_id: map?.id ?? map?.domain ?? domain,
    specific_goal: goalCtx.specific_goal,
    measurable_outcome: goalCtx.measurable_outcome,
    target_date: goalCtx.target_date,
    why_it_matters: goalCtx.why_it_matters,
    current_reality: goalCtx.current_reality,
    current_milestone: goalCtx.current_milestone,
    required_role: goalCtx.required_role,
    required_behaviours: goalCtx.required_behaviours,
    vortex_signature: pick(map, "signature_id"),
    EO: pick(map, "EO"),
    lack_channel: pick(map, "lack_channel"),
    avoidance_channel: pick(map, "avoid_type"),
    gravity_depth: checkin.gravity_rating ?? map?.gravity_depth ?? null,
    CL_estimate: pick(map, "CL_estimate"),
    CL_confidence: pick(map, "CL_confidence"),
    signature_confidence: pick(map, "signature_confidence"),
    failure_strategy: pick(map, "failure_strategy"),
    protector_profile: pick(map, "protector_profile"),
    protector_rule: pick(map, "protector_rule"),
    core_fear: goalCtx.core_fear ?? pick(map, "core_fear"),
    cost_to_goal: pick(map, "cost_to_goal"),
    opposite_belief: pick(map, "opposite_belief"),
    opposite_behaviour: pick(map, "opposite_behaviour"),
    success_rule: pick(map, "success_rule"),
    success_strategy: pick(map, "success_strategy"),
    current_state: checkin.current_state ?? null,
    gravity_rating: checkin.gravity_rating ?? null,
    recovery_speed: pick(map, "recovery_speed"),
    current_green_rep: checkin.last_green_rep ?? map?.daily_rep ?? null,
    proof_required: Boolean(map?.win_condition),
    proof_logged: Boolean(metrics?.proof_of_change?.length),
    recommended_training: pick(map, "recommended_resource"),
    treatment_day: currentDay,
    treatment_week: currentWeek,
    weekly_focus: treatment?.weekly_focus?.[currentWeek ? `week_${currentWeek}` : "week_1"] ?? null,
    red_patterns_caught: metrics?.avoidance_caught_count ?? 0,
    green_reps_completed: metrics?.green_reps_completed ?? 0,
    visible_actions_taken: metrics?.visible_actions_taken ?? 0,
    milestone_progress: metrics?.milestones_completed ?? 0,
  };
};

const validateStateVectorV2 = (vector) => {
  const errors = [];
  if (!vector || typeof vector !== "object") {
    return { ok: false, errors: ["STATE_VECTOR_V2 must be an object"] };
  }
  for (const key of REQUIRED_SCALAR_KEYS) {
    if (!vector[key]) errors.push(`missing ${key}`);
  }
  return { ok: errors.length === 0, errors };
};

/**
 * Merge partial STATE_VECTOR_V2 patch onto domain map structure fields.
 */
const applyStateVectorPatchToMap = (map, patch) => {
  if (!patch || typeof patch !== "object") return map;
  const next = { ...map };
  const scalarKeys = [
    "gravity_depth",
    "CL_estimate",
    "CL_confidence",
    "signature_confidence",
    "cost_to_goal",
    "protector_profile",
    "treatment_day",
    "treatment_week",
  ];
  for (const key of scalarKeys) {
    if (patch[key] !== undefined && patch[key] !== null) next[key] = patch[key];
  }
  if (patch.progress_metrics && typeof patch.progress_metrics === "object") {
    next.progress_metrics = {
      ...(next.progress_metrics || {}),
      ...patch.progress_metrics,
    };
  }
  return next;
};

module.exports = {
  buildStateVectorV2,
  validateStateVectorV2,
  applyStateVectorPatchToMap,
};
