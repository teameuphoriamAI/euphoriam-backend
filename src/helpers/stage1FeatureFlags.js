/**
 * Stage 1 feature flags — Phase 2 cert deep + Brain V2 + treatment plan.
 * Default off so Phase 1 behaviour is unchanged in production.
 */

const truthy = (value) => {
  if (value === true || value === 1) return true;
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
};

const stage1FeatureFlags = () => ({
  coach_cert_deep_enabled: truthy(process.env.COACH_CERT_DEEP_ENABLED),
  brain_prompt_v2_shadow: truthy(process.env.BRAIN_PROMPT_V2_SHADOW),
  treatment_plan_enabled: truthy(process.env.TREATMENT_PLAN_ENABLED),
  brain_prompt_rag_enabled: truthy(process.env.BRAIN_PROMPT_RAG_ENABLED),
});

module.exports = {
  stage1FeatureFlags,
  truthy,
};
