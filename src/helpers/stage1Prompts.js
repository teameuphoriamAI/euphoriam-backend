const { PromptType } = require("../utils/types");
const { getLatestPromptFromDb } = require("./euphoriamChatbot");
const { stage1FeatureFlags } = require("./stage1FeatureFlags");

const fetchContent = async (type) => {
  const row = await getLatestPromptFromDb(type);
  const text = row?.content?.trim();
  return text || null;
};

/**
 * Stage 1 LLM prompts — required: Coach Brain + Brain Prompt.
 * Optional admin overlays: stage1_daily_coach, stage1_map_resistance, stage1_friction_rescue.
 * When BRAIN_PROMPT_V2_SHADOW=true, loads Brain Prompt V2 + coach_v2 (shadow rows).
 * Templates, fallbacks, and JSON guardrails are hardcoded in stage1PromptSuite.js / prompts.py.
 */
const loadCoachPromptBundle = async () => {
  const flags = stage1FeatureFlags();
  const brainType = flags.brain_prompt_v2_shadow
    ? PromptType.BRAIN_PROMPT_V2
    : PromptType.BRAINPROMPT;

  const fetches = [
    fetchContent(PromptType.COACHBRAINPROMPT),
    fetchContent(brainType),
    fetchContent(PromptType.STAGE1_DAILY_COACH),
    fetchContent(PromptType.STAGE1_FRICTION_RESCUE),
    fetchContent(PromptType.STAGE1_COACH_OPENING),
    fetchContent(PromptType.STAGE1_GOAL_INTAKE),
  ];

  if (flags.brain_prompt_v2_shadow) {
    fetches.push(fetchContent(PromptType.COACH_V2));
  }

  const results = await Promise.all(fetches);
  const [coachBrain, brain, dailyCoach, friction, coachOpening, goalIntake, coachV2] = results;

  const bundle = {
    coach_brain_prompt: coachBrain,
    brain_prompt: brain,
    stage1_daily_coach: dailyCoach,
    stage1_friction_rescue: friction,
    stage1_coach_opening: coachOpening,
    stage1_goal_intake: goalIntake,
    feature_flags: flags,
  };

  if (flags.brain_prompt_v2_shadow && coachV2) {
    bundle.coach_v2 = coachV2;
  }

  return bundle;
};

const loadMapResistancePromptBundle = async () => {
  const [coachBrain, brain, mapResistance] = await Promise.all([
    fetchContent(PromptType.COACHBRAINPROMPT),
    fetchContent(PromptType.BRAINPROMPT),
    fetchContent(PromptType.STAGE1_MAP_RESISTANCE),
  ]);
  return {
    coach_brain_prompt: coachBrain,
    brain_prompt: brain,
    stage1_map_resistance: mapResistance,
  };
};

module.exports = {
  loadCoachPromptBundle,
  loadMapResistancePromptBundle,
};
