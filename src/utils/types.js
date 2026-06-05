exports.UserRole = Object.freeze({
  ADMIN: "admin",
  USER: "user",
});

exports.UserStatus = Object.freeze({
  ACTIVE: "active",
  BLOCK: "block",
});

exports.ChatType = Object.freeze({
  DIAGNOSTIC: "Diagnostic",
  DIAGNOSTIC_CHAT: "Diagnostic Chat",
  DISCOVERY: "Discovery",
  BRAINPROMPT: "Brain Prompt",
  COACHBRAINPROMPT:"Coach Brain Prompt"
});

exports.PromptType = Object.freeze({
  DIAGNOSTIC: "Diagnostic",
  DIAGNOSTIC_CHAT: "Diagnostic Chat",
  DISCOVERY: "Discovery",
  BRAINPROMPT: "Brain Prompt",
  /** V2 goal-specific structural coach OS (Nathan); layers on Brain Prompt */
  COACHBRAINPROMPT: "Coach Brain Prompt",
  STAGE1_MAP_RESISTANCE: "stage1_map_resistance",
  STAGE1_MAP_RESISTANCE_EXTRACT: "stage1_map_resistance_extract",
  STAGE1_MAP_RESISTANCE_WELCOME: "stage1_map_resistance_welcome",
  STAGE1_MAP_ADVANCE_FALLBACKS: "stage1_map_advance_fallbacks",
  STAGE1_COACH_OPENING: "stage1_coach_opening",
  STAGE1_DAILY_COACH: "stage1_daily_coach",
  STAGE1_FRICTION_RESCUE: "stage1_friction_rescue",
  STAGE1_GOAL_INTAKE: "stage1_goal_intake",
  INVISIBLE_RED_LINE_REPORT: "invisible_red_line_report",
  STAGE1_CONSTRAINT_EXTRACTION: "stage1_constraint_extraction",
  MARKET_RESEARCH: "market_research",
});
