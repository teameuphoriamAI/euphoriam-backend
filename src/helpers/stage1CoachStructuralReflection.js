/**
 * Structural reflection after action — Nathan flow:
 * Resistance → Action → Proof → Reflection → Pattern exposure → Flip → Next rep
 */

const { resolveFailureStrategyForMap } = require("./stage1MapStructure");
const { detectProgressSignals } = require("./stage1CoachProgress");

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
  return (fs?.rule || fs?.title || map?.protector_rule || "your failure strategy").trim();
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

const escapeRegExp = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Coach suggested a concrete action this session (named rep in chat OR generic advice). */
const hasCoachActionThisSession = (messages = [], openSession = null, repName = null) => {
  const rep = repName || openSession?.green_rep_last?.name || null;
  const assistantText = (messages || [])
    .filter((m) => m?.role === "assistant")
    .map((m) => String(m.content || ""))
    .join("\n");
  if (
    rep &&
    new RegExp(escapeRegExp(rep), "i").test(assistantText) &&
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

const buildInvestigateStuckMessage = (map) => {
  const goal = map?.goal_title || "your goal";
  return (
    `Before I name a pattern — tell me what happened in the last 24 hours.\n\n` +
    `What were you trying to do toward "${goal}", and where did you stop?`
  );
};

const buildStructuralReflectionOpen = ({
  map,
  userMessage,
  proofAction = null,
  lastRepName = null,
}) => {
  const failure = pickFailureLabel(map);
  const protector = map?.protector_rule?.trim() || "your protector rule";
  const action =
    proofAction?.trim() ||
    extractActionSummary(userMessage) ||
    (lastRepName ? `completed "${lastRepName}"` : "took action toward your goal");

  const prediction =
    map?.core_fear?.trim() ||
    `that ${protector.toLowerCase().slice(0, 100)} would keep you safe`;

  return (
    `Good — that's proof.\n\n` +
    `Your pattern (${failure}) predicted ${prediction}. ` +
    `Today you ${action} anyway.\n\n` +
    `What happened after? Did anything bad actually happen — or did reality not match the fear?`
  );
};

const buildPatternExposureFollowUp = ({ map, userMessage, priorAnswer = null }) => {
  const failure = pickFailureLabel(map);
  const flip = map?.flip_belief?.trim() || map?.flip_rule?.trim() || null;
  const combined = [priorAnswer, userMessage].filter(Boolean).join(" ");

  if (/\b(nothing|no one|didn'?t|wasn'?t|not bad|fine|ok|okay|better|helped|relief)\b/i.test(combined)) {
    return (
      `So the structure predicted danger — and reality was milder than the fear. That's evidence against the old code.\n\n` +
      (flip
        ? `What would "${flip.slice(0, 90)}" look like as one slightly bigger move tomorrow?`
        : "What's one slightly bigger move tomorrow — not a repeat of today, one step toward the flip?")
    );
  }

  if (/\b(hard|scary|anxious|weird|awkward|judg|reject)\b/i.test(combined)) {
    return (
      `You did it and the protector still fired — that's the pattern (${failure}) trying to shrink the win.\n\n` +
      `What part was hardest — and what does that tell you about the rule running underneath?`
    );
  }

  return (
    `Use what they just said as evidence. Name how ${failure} showed up — then ask ONE question: ` +
    `what did this prove about the old prediction vs what actually happened?`
  );
};

const buildReflectionCompleteDirective = ({
  map,
  completedActions = [],
  lastRepName = null,
}) => {
  const lastFamily = completedActions[completedActions.length - 1]?.family;
  const flip = map?.flip_belief?.trim() || map?.success_strategy?.behaviour?.trim();

  let nextHint =
    "Assign ONE new Green Rep — must be a DIFFERENT action family than what they already completed this session. Slightly bigger, flip-aligned.";
  if (
    lastFamily === ACTION_FAMILIES.KINDNESS_MESSAGE ||
    lastFamily === ACTION_FAMILIES.MOTIVATIONAL_MESSAGE
  ) {
    nextHint =
      "They already sent a kindness/motivational message — do NOT suggest another. " +
      "Next rep: one honest sentence (truth, not cheerleading) to the same person OR one visibility move toward the flip. Slightly bigger.";
  } else if (lastFamily === ACTION_FAMILIES.SOLO_TRUTH) {
    nextHint =
      "Solo truth done — next rep should add feeling-stay, mirror, or one-line-out (progression), not repeat the same sentence exercise.";
  }

  if (flip) {
    nextHint += ` Flip anchor: "${flip.slice(0, 100)}".`;
  }
  if (lastRepName) {
    nextHint += ` Last rep was "${lastRepName}" — must differ.`;
  }
  return nextHint;
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
  buildInvestigateStuckMessage,
  buildStructuralReflectionOpen,
  buildPatternExposureFollowUp,
  buildReflectionCompleteDirective,
  recordCompletedAction,
  lastAssistantMessage,
};
