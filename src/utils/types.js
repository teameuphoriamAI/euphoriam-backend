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
});

exports.PromptType = Object.freeze({
  DIAGNOSTIC: "Diagnostic",
  DIAGNOSTIC_CHAT: "Diagnostic Chat",
  DISCOVERY: "Discovery",
  BRAINPROMPT: "Brain Prompt",
  INVISIBLE_RED_LINE_REPORT: "invisible_red_line_report",
  STAGE1_CONSTRAINT_EXTRACTION: "stage1_constraint_extraction",
  MARKET_RESEARCH: "market_research",
});
