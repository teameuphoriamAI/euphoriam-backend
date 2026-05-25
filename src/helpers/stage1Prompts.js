const { PromptType } = require("../utils/types");
const { getLatestPromptFromDb } = require("./euphoriamChatbot");

const fetchContent = async (type) => {
  const row = await getLatestPromptFromDb(type);
  const text = row?.content?.trim();
  return text || null;
};

/**
 * Active prompts for Stage 1 Python AI (coach, map resistance, friction).
 *
 * Layer order (Nathan V2):
 * 1. Coach Brain Prompt — goal-specific structural OS (Version 2 MVP)
 * 2. Brain Prompt — canonical library (48 signatures, reps, UC routing)
 * 3. stage1_* — turn-specific rules (JSON shape, Q&A flow)
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
