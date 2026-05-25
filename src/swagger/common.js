/** Shared OpenAPI components for Euphoriam backend docs */

const DOMAIN_ENUM = ["income", "alignment", "relationships", "health", "wealth"];

const milestonesSchema = {
  type: "object",
  properties: {
    day_7: { type: "string", nullable: true, example: "Finalise rollout" },
    day_30: { type: "string", nullable: true, example: "Funnel live + launch date confirmed" },
    day_90: { type: "string", nullable: true, example: "Consistent lead flow + 25 UC sales" },
  },
};

const progressMetricsSchema = {
  type: "object",
  properties: {
    rep_completion_rate: { type: "number", example: 0 },
    recovery_speed: { type: "string", nullable: true },
    avoidance_caught_count: { type: "number", example: 0 },
    milestones_completed: { type: "number", example: 0 },
  },
};

const domainMapSchema = {
  type: "object",
  properties: {
    domain: { type: "string", enum: DOMAIN_ENUM },
    status: { type: "string", enum: ["draft", "stored", "active"] },
    goal_title: { type: "string", nullable: true },
    desired_outcome: { type: "string", nullable: true },
    target_date: { type: "string", nullable: true },
    proof_of_success: { type: "string", nullable: true },
    milestones: milestonesSchema,
    today_visible_action: { type: "string", nullable: true },
    goals_complete: { type: "boolean" },
    map_resistance_complete: { type: "boolean" },
    progress_metrics: progressMetricsSchema,
  },
};

const apiSuccessEnvelope = (resultSchema) => ({
  type: "object",
  properties: {
    status: { type: "boolean", example: true },
    message: { type: "string" },
    result: resultSchema,
  },
});

const apiErrorEnvelope = {
  type: "object",
  properties: {
    status: { type: "boolean", example: false },
    error: { type: "string" },
    result: { type: "object", nullable: true },
  },
};

const bearerSecurity = [{ bearerAuth: [] }];

const jwtResultSchema = {
  type: "object",
  properties: {
    token: { type: "string", description: "Use in Authorize for Stage 1 + paid APIs" },
    expiresIn: { type: "string", example: "15m" },
    lightTheme: { type: "boolean" },
  },
};

module.exports = {
  DOMAIN_ENUM,
  milestonesSchema,
  progressMetricsSchema,
  domainMapSchema,
  apiSuccessEnvelope,
  apiErrorEnvelope,
  bearerSecurity,
  jwtResultSchema,
};
