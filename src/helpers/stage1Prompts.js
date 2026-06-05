const { PromptType } = require("../utils/types");
const { getLatestPromptFromDb } = require("./euphoriamChatbot");

const fetchContent = async (type) => {
  const row = await getLatestPromptFromDb(type);
  const text = row?.content?.trim();
  return text || null;
};

/**
 * Stage 1 LLM prompts — required: Coach Brain + Brain Prompt.
 * Optional admin overlays: stage1_daily_coach, stage1_map_resistance, stage1_friction_rescue.
 * Templates, fallbacks, and JSON guardrails are hardcoded in stage1PromptSuite.js / prompts.py.
 */
const loadCoachPromptBundle = async () => {
  const [coachBrain, brain, dailyCoach, friction] = await Promise.all([
    fetchContent(PromptType.COACHBRAINPROMPT),
    fetchContent(PromptType.BRAINPROMPT),
    fetchContent(PromptType.STAGE1_DAILY_COACH),
    fetchContent(PromptType.STAGE1_FRICTION_RESCUE),
  ]);
  return {
    coach_brain_prompt: coachBrain,
    brain_prompt: brain,
    stage1_daily_coach: dailyCoach,
    stage1_friction_rescue: friction,
  };
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
