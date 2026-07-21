const { successResponse, errorResponse } = require("../utils/response");
const aiService = require("../clients/aiService");
const { loadStage1ForUser, persistStage1ForUser } = require("../helpers/stage1Repository");
const { buildActiveGoalContext } = require("../helpers/stage1GoalContext");
const { buildStateVectorV2, validateStateVectorV2 } = require("../helpers/stage1StateVector");
const { stage1FeatureFlags } = require("../helpers/stage1FeatureFlags");
const { resolvePrimaryDomain } = require("../helpers/stage1State");
const { normalizeDomain } = require("../constants/domains");
const { User } = require("../models/userModel");
const { withDbSlot } = require("../config/sequelize");
const { PromptType } = require("../utils/types");
const { getLatestPromptFromDb } = require("../helpers/euphoriamChatbot");

const resolveUser = async (req) => {
  const id = req.user?.sub || req.user?.userId;
  if (!id) {
    const err = new Error("Not authenticated");
    err.status = 401;
    throw err;
  }
  const user = await withDbSlot(() =>
    User.findByPk(id, { attributes: { exclude: ["password"] } }),
  );
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }
  return user;
};

/** POST /api/stage1/treatment-plan/generate */
const generateTreatmentPlan = async (req, res) => {
  try {
    const flags = stage1FeatureFlags();
    if (!flags.treatment_plan_enabled) {
      return errorResponse(res, "Treatment plan generation is not enabled", 403);
    }
    if (!aiService.isEnabled()) {
      return errorResponse(res, "AI service is not configured", 503);
    }

    const user = await resolveUser(req);
    let stage1 = await loadStage1ForUser(user);
    const domain =
      normalizeDomain(req.body?.domain) || resolvePrimaryDomain(stage1);
    if (!domain) {
      return errorResponse(res, "No active domain", 400);
    }

    const mapIdx = (stage1.domain_maps || []).findIndex((m) => m.domain === domain);
    if (mapIdx < 0) {
      return errorResponse(res, "Domain map not found", 404);
    }
    const map = stage1.domain_maps[mapIdx];
    if (!map.map_resistance_complete) {
      return errorResponse(res, "Complete Map Resistance before generating a treatment plan", 400);
    }

    const activeGoalContext = buildActiveGoalContext(map, domain);
    const stateVector = buildStateVectorV2({
      userId: user.id,
      stage1,
      map,
      domain,
    });

    const promptRow = await getLatestPromptFromDb(PromptType.TREATMENT_PLAN_30D);
    const prompts = {
      treatment_plan_30d: promptRow?.content?.trim() || null,
      feature_flags: flags,
    };

    const result = await aiService.generateTreatmentPlan({
      user_id: user.id,
      domain_map: map,
      active_goal_context: activeGoalContext,
      state_vector_v2: stateVector,
      prompts,
    });

    const plan = result?.treatment_plan_30d || result?.plan;
    if (!plan || typeof plan !== "object") {
      return errorResponse(res, "Treatment plan generation returned invalid data", 502);
    }

    const maps = [...stage1.domain_maps];
    maps[mapIdx] = {
      ...map,
      treatment_plan_30d: plan,
      treatment_week: plan.current_week ?? 1,
      treatment_day: plan.current_day ?? 1,
      state_vector_v2: result?.state_vector_v2 || stateVector,
    };
    stage1 = { ...stage1, domain_maps: maps };
    await persistStage1ForUser(user.id, stage1);

    const validation = validateStateVectorV2(result?.state_vector_v2 || stateVector);
    return successResponse(res, {
      domain,
      treatment_plan_30d: plan,
      state_vector_v2: result?.state_vector_v2 || stateVector,
      state_vector_valid: validation.ok,
    });
  } catch (err) {
    console.error("[generateTreatmentPlan]", err);
    return errorResponse(
      res,
      err.message || "Treatment plan generation failed",
      err.status || 502,
    );
  }
};

module.exports = {
  generateTreatmentPlan,
};
