/**
 * Structural reflection after action — detection and structured context only.
 */

const { resolveFailureStrategyForMap } = require("../../../helpers/stage1MapStructure");
const { detectProgressSignals } = require("../utils/progress");

const ACTION_FAMILIES = Object.freeze({
  KINDNESS_MESSAGE: "kindness_message",
  MOTIVATIONAL_MESSAGE: "motivational_message",
  OUTREACH: "outreach",
  VISIBILITY: "visibility",
  SOLO_TRUTH: "solo_truth",
  MIRROR: "mirror",
  VOICE_MEMO: "voice_memo",
  GENERIC_COMPLETION: "generic_completion",
  OTHER: "other",
});

const STUCK_VAGUE_PATTERN =
  /^\s*(i'?m\s+stuck|stuck|i\s+feel\s+stuck|don'?t\s+know\s+what\s+to\s+do|no\s+idea\s+what\s+to\s+do|idk)\s*\.?!?\s*$/i;

const USER_ACTION_REPORT_PATTERN =
  /\b(i\s+(?:sent|texted|wrote|messaged|shared|reached\s+out|called|did|posted|said|told)|i'?ve\s+(?:sent|texted|written|messaged|shared|reached)|already\s+(?:sent|texted|did))\b/i;

const COACH_ACTION_SUGGESTION_PATTERN =
  /\b(send(?:ing|s)?|text(?:ing|ed)?|write|reach\s+out|motivat|kindness|supportive|honest\s+sentence|notes\s+app|voice\s+memo|mirror|visible|outreach|message\s+to)\b/i;

const pickFailureLabel = (map) => {
  const fs = resolveFailureStrategyForMap(map);
  if (typeof fs === "string") return fs.trim();
  return (fs?.rule || fs?.title || map?.protector_rule || "failure strategy").trim();
};

const classifyActionFamily = (text) => {
  const t = String(text || "").toLowerCase();
  if (/\bmotivat/.test(t)) return ACTION_FAMILIES.MOTIVATIONAL_MESSAGE;
  if (/\b(kindness|supportive\s+message|appreciat)/.test(t)) {
    return ACTION_FAMILIES.KINDNESS_MESSAGE;
  }
  if (/\b(reach\s+out|outreach|contacted|client)/.test(t)) return ACTION_FAMILIES.OUTREACH;
  if (/\b(posted|visible|share|shared|seen)/.test(t)) return ACTION_FAMILIES.VISIBILITY;
  if (/\bmirror\b/.test(t)) return ACTION_FAMILIES.MIRROR;
  if (/\bvoice\s+memo|recorded\b/.test(t)) return ACTION_FAMILIES.VOICE_MEMO;
  if (/\b(honest\s+sentence|notes|journal|truth\s+hold)/.test(t)) {
    return ACTION_FAMILIES.SOLO_TRUTH;
  }
  if (/\b(done|finished|completed|i did it)\b/.test(t)) {
    return ACTION_FAMILIES.GENERIC_COMPLETION;
  }
  return ACTION_FAMILIES.OTHER;
};

const extractActionSummary = (userMessage) => {
  const t = String(userMessage || "").trim();
  if (!t) return "took the action";
  const m = t.match(
    /\b(?:i\s+)?(?:sent|texted|wrote|messaged|shared|reached\s+out\s+to|called)\b[^.!?]{0,80}/i,
  );
  if (m) return m[0].replace(/^i\s+/i, "").trim();
  if (t.length <= 120) return t.replace(/^i\s+/i, "").trim();
  return `${t.slice(0, 100).trim()}…`;
};

const lastAssistantMessage = (messages = []) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return String(messages[i].content || "");
  }
  return "";
};

const hasCoachActionThisSession = (messages = [], openSession = null, repName = null) => {
  const rep = repName || openSession?.green_rep_last?.name || null;
  const assistantText = (messages || [])
    .filter((m) => m?.role === "assistant")
    .map((m) => String(m.content || ""))
    .join("\n");
  if (
    rep &&
    new RegExp(String(rep).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(assistantText) &&
    /\b(rep|win condition|green\s+rep)\b/i.test(assistantText)
  ) {
    return true;
  }
  if (/\b(green\s+rep|win\s+condition)\b/i.test(assistantText)) return true;
  return COACH_ACTION_SUGGESTION_PATTERN.test(assistantText);
};

const detectUserActionReport = (text) => {
  const t = String(text || "").trim();
  if (!t || t.length < 8) return false;
  if (STUCK_VAGUE_PATTERN.test(t)) return false;
  if (USER_ACTION_REPORT_PATTERN.test(t)) return true;
  const signals = detectProgressSignals(t);
  return signals.hasProof && t.length >= 16;
};

const detectVagueStuck = (text) => STUCK_VAGUE_PATTERN.test(String(text || "").trim());

const familiesMatch = (a, b) => {
  if (!a || !b) return false;
  if (a === b) return true;
  const kindness = new Set([
    ACTION_FAMILIES.KINDNESS_MESSAGE,
    ACTION_FAMILIES.MOTIVATIONAL_MESSAGE,
  ]);
  return kindness.has(a) && kindness.has(b);
};

const isActionFamilyBlocked = (family, completedActions = []) => {
  if (!family || family === ACTION_FAMILIES.OTHER) return false;
  return (completedActions || []).some((c) => familiesMatch(c.family, family));
};

const buildStuckInvestigationContext = (map) => ({
  user_expressed_uncertainty: true,
  goal: map?.goal_title || "goal",
  investigation_theme: "last_24_hours_reality",
});

const buildStructuralReflectionContext = ({
  map,
  userMessage,
  proofAction = null,
  lastRepName = null,
  phase = "open",
}) => {
  const failure = pickFailureLabel(map);
  const protector = map?.protector_rule?.trim() || null;
  const flip = map?.flip_belief?.trim() || map?.flip_rule?.trim() || null;
  const action =
    proofAction?.trim() ||
    extractActionSummary(userMessage) ||
    (lastRepName ? `completed "${lastRepName}"` : "took action toward goal");
  const prediction =
    map?.core_fear?.trim() ||
    (protector ? `that ${protector.toLowerCase().slice(0, 100)} would keep them safe` : null);

  return {
    structural_reflection_active: true,
    reflection_phase: phase,
    failure_strategy: failure,
    protector_rule: protector,
    flip,
    action_summary: action,
    predicted_fear: prediction,
    user_message_snippet: String(userMessage || "").trim().slice(0, 200),
    last_rep_name: lastRepName || null,
  };
};

const buildPatternExposureContext = ({ map, userMessage, priorAnswer = null }) => {
  const failure = pickFailureLabel(map);
  const flip = map?.flip_belief?.trim() || map?.flip_rule?.trim() || null;
  const combined = [priorAnswer, userMessage].filter(Boolean).join(" ");
  let exposure_theme = "compare_prediction_to_reality";

  if (/\b(nothing|no one|didn'?t|wasn'?t|not bad|fine|ok|okay|better|helped|relief)\b/i.test(combined)) {
    exposure_theme = "reality_milder_than_fear";
  } else if (/\b(hard|scary|anxious|weird|awkward|judg|reject)\b/i.test(combined)) {
    exposure_theme = "protector_fired_despite_action";
  }

  return {
    structural_reflection_active: true,
    reflection_phase: "followup",
    exposure_theme,
    failure_strategy: failure,
    flip,
    prior_answer_snippet: priorAnswer ? String(priorAnswer).slice(0, 200) : null,
    user_message_snippet: String(userMessage || "").trim().slice(0, 200),
  };
};

const buildReflectionCompleteDirective = ({
  map,
  completedActions = [],
  lastRepName = null,
}) => {
  const lastFamily = completedActions[completedActions.length - 1]?.family;
  const flip = map?.flip_belief?.trim() || map?.success_strategy?.behaviour?.trim();
  const hints = {
    last_completed_action_family: lastFamily || null,
    flip_anchor: flip ? flip.slice(0, 100) : null,
    last_rep_name: lastRepName || null,
    require_different_rep_family: true,
  };
  if (
    lastFamily === ACTION_FAMILIES.KINDNESS_MESSAGE ||
    lastFamily === ACTION_FAMILIES.MOTIVATIONAL_MESSAGE
  ) {
    hints.next_rep_family_hint = "truth_or_visibility_not_kindness_repeat";
  } else if (lastFamily === ACTION_FAMILIES.SOLO_TRUTH) {
    hints.next_rep_family_hint = "feeling_stay_mirror_or_one_line_out";
  }
  return hints;
};

const recordCompletedAction = (cycle, userMessage, proofAction = null) => {
  const summary = proofAction?.trim() || extractActionSummary(userMessage);
  const family = classifyActionFamily(`${summary} ${userMessage}`);
  const existing = Array.isArray(cycle?.completed_actions) ? cycle.completed_actions : [];
  if (existing.some((c) => c.summary === summary && c.family === family)) {
    return existing;
  }
  return [
    ...existing,
    {
      family,
      summary,
      at: new Date().toISOString(),
    },
  ].slice(-8);
};

module.exports = {
  ACTION_FAMILIES,
  STUCK_VAGUE_PATTERN,
  classifyActionFamily,
  extractActionSummary,
  hasCoachActionThisSession,
  detectUserActionReport,
  detectVagueStuck,
  familiesMatch,
  isActionFamilyBlocked,
  buildStuckInvestigationContext,
  buildStructuralReflectionContext,
  buildPatternExposureContext,
  buildReflectionCompleteDirective,
  recordCompletedAction,
  lastAssistantMessage,
};
