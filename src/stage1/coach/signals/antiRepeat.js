/**
 * Zero-tolerance anti-repeat: thematic loops, exercise prescriptions, ignored pushback.
 * Discovery must eventually exit once the mechanism is clear (Nathan: discover → action).
 */

const normalizeForCompare = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const tokenOverlapRatio = (a, b) => {
  const ta = new Set(normalizeForCompare(a).split(" ").filter((w) => w.length > 2));
  const tb = new Set(normalizeForCompare(b).split(" ").filter((w) => w.length > 2));
  if (!ta.size || !tb.size) {
    const na = normalizeForCompare(a);
    const nb = normalizeForCompare(b);
    return na && na === nb ? 1 : 0;
  }
  let shared = 0;
  for (const t of ta) {
    if (tb.has(t)) shared += 1;
  }
  return shared / Math.max(ta.size, tb.size);
};

/** Hard reject of homework/exercises — keeps discovery-only sticky. */
const USER_REJECTS_PRESCRIPTION_PATTERN =
  /\b(don'?t want (?:an? )?(?:exercise|homework|action|step|task|assignment)|no(?:t)? (?:another )?(?:exercise|homework|action step|numbered|step-by-step)|stop giving (?:me )?(?:exercises|homework|action|steps|advice)|please stop|not (?:analyzing|the issue)|stay with (?:the )?(?:feeling|emotion|experience)|don'?t think we'?re addressing|move(?:d|s)? back to (?:another )?(?:action|exercise|step)|not (?:a|the) small action|before trying to change|instead of (?:just )?(?:giving|another)|talking past|you keep (?:giving|suggesting|pushing))\b/i;

/** Soft discovery intent — does NOT permanently block Green Rep once mechanism is clear. */
const USER_WANTS_DISCOVERY_PATTERN =
  /\b(help me (?:figure|understand|explore)|want to understand|trying to understand|what'?s underneath|what'?s driving|where did (?:that|this) (?:start|come from|begin)|stay with (?:the )?(?:feeling|emotion)|tell me more|go deeper|what are you experiencing|peel (?:back|another)|uncover (?:the|what|why)|roots? of (?:this|that)|why do i (?:do|pull|step)|what happened (?:the )?last time|figure out why|understand why)\b/i;

const COACHING_REPEAT_COMPLAINT_EXTRA =
  /\b(same (?:thing|advice|question|exercise|step)|you (?:already|keep)|keep (?:giving|suggesting|repeating|doing)|another exercise|move(?:d|s)? to (?:another )?(?:action|exercise)|not what i (?:asked|need|want)|you'?re not listening|ignoring what i said)\b/i;

const PRESCRIPTIVE_REPLY_PATTERN =
  /\b(try this|here'?s (?:a|your|one) (?:action|exercise|step)|let'?s try|numbered|step-by-step|write down|close your eyes|take a deep breath|send (?:them|a message)|reach out|schedule (?:a|time)|hit send|small action|concrete step|micro-action|forbidden from|1\.|2\.|3\.)\b/i;

const DIAGNOSIS_THEME_PATTERNS = [
  /\bfear of rejection\b/i,
  /\bprotective mechanism\b/i,
  /\bbeing seen as too much\b/i,
  /\bfear of being (?:seen|judged|rejected)\b/i,
  /\bprotect(?:ive|ing) (?:part|mechanism|yourself)\b/i,
  /\bties? (?:your )?worth\b/i,
  /\bvalidation from others\b/i,
  /\bfinancially invisible\b/i,
  /\bact of kindness\b/i,
  /\bsmall step you can take\b/i,
  /\bconcrete step\b/i,
  /\breach out\b/i,
  /\bschedule (?:a|time to) catch up\b/i,
];

const USER_NAMED_MECHANISM_PATTERN =
  /\b(protective part|protector|fear of (?:rejection|being)|not (?:being )?enough|not valued|not matter|pull(?:ing)? away|avoid(?:ing|ance)|vulnerable|vulnerability|rejection|misunderstood)\b/i;

const DISCOVERY_ONLY_DIRECTIVE =
  "DISCOVERY ONLY — member rejected exercises, repeated advice, or asked to stay with feeling/understand roots. " +
  "Reply in 1-3 SHORT sentences with ONE new question only. " +
  "FORBIDDEN: numbered lists, homework, breathing/writing exercises, outreach tasks, Green Rep, diagnosis labels they already heard, restating their goal, 'Let's focus on', 'small actionable step'. " +
  "Follow their thread — do not solve. green_rep must be null.";

const MECHANISM_EXIT_DIRECTIVE =
  "MECHANISM CLEAR — discovery is enough. In 1-2 short sentences name the pattern " +
  "(want connection → protector predicts rejection → avoid → loneliness). " +
  "Then assign ONE Green Rep as a structural experiment (observe the protector while taking one small visible step). " +
  "Do NOT ask another discovery-only question. Set green_rep JSON; assign_green_rep must be true.";

const EXPLORE_FIRST_DIRECTIVE =
  "EXPLORE FIRST — Nathan-style discovery. Reply in 1-3 SHORT sentences with ONE new question only. " +
  "Let the member uncover structure; do NOT label, diagnose, prescribe, or assign homework. " +
  "FORBIDDEN: fear of rejection, protective mechanism, outreach/send-a-message tasks, numbered steps, Green Rep, 'Let's focus on', 'small actionable step'. " +
  "Prefer body/feeling questions over 'what do you think'. Peel layers — do not solve.";

const DISCOVERY_QUESTION_FALLBACKS = [
  "What are you experiencing right now — in your body, not your head?",
  "Tell me more about the last time that pull-away feeling showed up.",
  "Stay with that. What's the worst part of it?",
  "What happens inside you right before you close the tab or delay?",
  "What part of that feels most alive for you right now?",
  "If you didn't pull away, what would you be afraid might happen next?",
];

const INCOME_DISCOVERY_FALLBACKS = [
  "What are you experiencing in your body when you think about hitting send?",
  "Tell me more about the last time you almost sent a follow-up but stopped.",
  "What happens inside you when you imagine their silence after you reach out?",
  "If you didn't delay the follow-up, what would you be afraid might happen next?",
  "What part of being ignored or seen as pushy feels worst in your body?",
];

const RELATIONSHIP_DISCOVERY_FALLBACKS = [
  "What are you experiencing right now — in your body, not your head?",
  "What happens inside you the moment closeness starts to feel real?",
  "Tell me more about the last time that pull-away feeling showed up.",
  "If you didn't pull away, what would you be afraid might happen next?",
];

const DISCOVERY_FIRST_DOMAINS = new Set([
  "relationships",
  "relationship",
  "love",
  "connection",
  "family",
]);

const USER_WANTS_ACTION_PATTERN =
  /\b(what (?:exactly )?(?:should|can|do) i do|what do i do first|one message or one call|what'?s next|how do i start|one thing (?:i|to|we) can do|smallest step|action today|give me (?:an? )?(?:action|step|homework|task)|(?:knowing|know|leave (?:with|knowing)|want(?:ing)?) (?:the |a )?next step|the next step|next step for today|next step)\b/i;

const MECHANISM_READY_MIN_TURNS = 6;
const EXPLORE_FIRST_MAX_TURNS = 8;

const assistantTextsFromMessages = (messages = []) =>
  (messages || [])
    .filter((m) => m?.role === "assistant")
    .map((m) => String(m.content || "").trim())
    .filter(Boolean);

const userTextsFromMessages = (messages = [], currentMessage = "") => {
  const prior = (messages || [])
    .filter((m) => m?.role === "user")
    .map((m) => String(m.content || "").trim())
    .filter(Boolean);
  const current = String(currentMessage || "").trim();
  return current ? [...prior, current] : prior;
};

const countUserTurns = (messages = [], userMessage = "") =>
  userTextsFromMessages(messages, userMessage).length;

const detectUserRejectsPrescription = (texts = []) => {
  const combined = texts.join("\n");
  return USER_REJECTS_PRESCRIPTION_PATTERN.test(combined);
};

const detectUserWantsDiscovery = (texts = []) => {
  const combined = texts.join("\n");
  return USER_WANTS_DISCOVERY_PATTERN.test(combined);
};

const detectSessionWantsNextStep = (texts = []) => {
  const combined = Array.isArray(texts) ? texts.join("\n") : String(texts || "");
  return USER_WANTS_ACTION_PATTERN.test(combined);
};

const detectCoachingRepeatComplaintExpanded = (text) =>
  COACHING_REPEAT_COMPLAINT_EXTRA.test(String(text || ""));

const countDiagnosisThemesInText = (text) =>
  DIAGNOSIS_THEME_PATTERNS.reduce((n, re) => (re.test(String(text || "")) ? n + 1 : n), 0);

const detectThematicAssistantRepeat = (messages = []) => {
  const texts = assistantTextsFromMessages(messages);
  if (texts.length < 2) return false;

  let themeHits = 0;
  for (const re of DIAGNOSIS_THEME_PATTERNS) {
    const hits = texts.filter((t) => re.test(t)).length;
    if (hits >= 2) themeHits += 1;
  }

  const prescriptiveHits = texts.filter((t) => PRESCRIPTIVE_REPLY_PATTERN.test(t)).length;
  return themeHits >= 1 || prescriptiveHits >= 2;
};

const maxAssistantOverlapRatio = (messages = []) => {
  const texts = assistantTextsFromMessages(messages);
  if (texts.length < 2) return 0;
  const latest = texts[texts.length - 1];
  let max = 0;
  for (let i = 0; i < texts.length - 1; i += 1) {
    max = Math.max(max, tokenOverlapRatio(latest, texts[i]));
  }
  return max;
};

const detectRepeatedAssistantAdvice = (messages = []) => {
  const texts = assistantTextsFromMessages(messages);
  if (texts.length < 2) return false;

  const latest = texts[texts.length - 1];
  const previous = texts[texts.length - 2];
  if (latest === previous) return true;

  if (maxAssistantOverlapRatio(messages) >= 0.38) return true;
  if (tokenOverlapRatio(latest, previous) >= 0.38) return true;

  if (detectThematicAssistantRepeat(messages)) return true;

  for (let i = 0; i < texts.length - 1; i += 1) {
    if (countDiagnosisThemesInText(latest) >= 2 && countDiagnosisThemesInText(texts[i]) >= 2) {
      if (tokenOverlapRatio(latest, texts[i]) >= 0.28) return true;
    }
  }

  return false;
};

/**
 * Mechanism is "clear enough" to leave discovery: enough turns + mapped or named structure.
 */
const isMechanismReady = ({
  messages = [],
  userMessage = "",
  map = null,
  minTurns = MECHANISM_READY_MIN_TURNS,
} = {}) => {
  const userTurns = countUserTurns(messages, userMessage);
  if (userTurns < minTurns) return false;
  if (!map?.map_resistance_complete) return false;

  const hasMappedStructure = Boolean(
    map.protector_rule ||
      map.core_fear ||
      map.failure_strategy?.rule ||
      map.failure_strategy,
  );

  const userTexts = userTextsFromMessages(messages, userMessage);
  const userNamedMechanism = userTexts.some((t) => USER_NAMED_MECHANISM_PATTERN.test(t));

  return hasMappedStructure || userNamedMechanism;
};

const buildAntiRepeatState = ({
  messages = [],
  userMessage = "",
  map = null,
  mechanism_ready: mechanismReadyArg = null,
} = {}) => {
  const userTexts = userTextsFromMessages(messages, userMessage);
  const user_rejects_prescription = detectUserRejectsPrescription(userTexts);
  const user_wants_discovery = detectUserWantsDiscovery(userTexts);
  const session_wants_next_step = detectSessionWantsNextStep(userTexts);
  const repeat_complaint =
    userTexts.some((t) => detectCoachingRepeatComplaintExpanded(t)) ||
    detectCoachingRepeatComplaintExpanded(userMessage);
  const repeated_assistant_advice = detectRepeatedAssistantAdvice(messages);
  const thematic_repeat = detectThematicAssistantRepeat(messages);
  const max_overlap = maxAssistantOverlapRatio(messages);
  const user_turns = countUserTurns(messages, userMessage);
  const mechanism_ready =
    mechanismReadyArg != null
      ? Boolean(mechanismReadyArg)
      : isMechanismReady({ messages, userMessage, map });

  // Soft discovery / thematic loops must not forever-block Green Rep once mechanism is clear,
  // unless the member hard-rejects homework or complains about coaching loops.
  const soft_discovery_lock = Boolean(
    user_wants_discovery ||
      repeated_assistant_advice ||
      thematic_repeat ||
      max_overlap >= 0.38,
  );

  const discovery_only_mode = Boolean(
    user_rejects_prescription ||
      repeat_complaint ||
      (!mechanism_ready && soft_discovery_lock),
  );

  const anti_repeat_active = discovery_only_mode;

  return {
    user_rejects_prescription,
    user_wants_discovery,
    session_wants_next_step,
    coaching_repeat_complaint: repeat_complaint,
    repeated_assistant_advice,
    thematic_assistant_repeat: thematic_repeat,
    max_assistant_overlap: max_overlap,
    user_turns,
    mechanism_ready,
    discovery_only_mode,
    anti_repeat_active,
    coaching_directive: anti_repeat_active ? DISCOVERY_ONLY_DIRECTIVE : null,
    stop_discovery: anti_repeat_active ? false : mechanism_ready ? true : undefined,
    block_green_rep: anti_repeat_active,
  };
};

const pickDiscoveryFallback = (userMessage, priorAssistants = [], domain = null) => {
  const domainLower = String(domain || "").toLowerCase();
  const pool =
    domainLower === "income" || domainLower === "wealth" || domainLower === "money"
      ? INCOME_DISCOVERY_FALLBACKS
      : DISCOVERY_FIRST_DOMAINS.has(domainLower)
        ? RELATIONSHIP_DISCOVERY_FALLBACKS
        : DISCOVERY_QUESTION_FALLBACKS;

  const prior = priorAssistants.filter(Boolean);
  const candidates = [];

  if (/\b(body|feel|feeling|anxiety|experience|stomach|chest)\b/i.test(String(userMessage || ""))) {
    candidates.push(pool[0]);
  }
  if (/\b(understand|why|where|come from|roots?|underneath|follow.?up|send|message)\b/i.test(String(userMessage || ""))) {
    candidates.push(pool[1] || pool[0]);
  }

  const idx = prior.length % pool.length;
  candidates.push(...pool.slice(idx), ...pool.slice(0, idx));

  const seen = new Set();
  const ordered = [];
  for (const q of candidates) {
    const key = q.trim().toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      ordered.push(q);
    }
  }

  const fresh = ordered.filter((q) => prior.every((p) => tokenOverlapRatio(q, p) < 0.38));
  if (fresh.length) return fresh[0];

  let best = ordered[0] || pool[0];
  let bestScore = 1;
  for (const q of ordered.length ? ordered : pool) {
    const score = prior.length ? Math.max(...prior.map((p) => tokenOverlapRatio(q, p))) : 0;
    if (score < bestScore) {
      bestScore = score;
      best = q;
    }
  }
  return best;
};

const isDiscoveryOnlyQuestion = (text = "") => {
  const t = String(text || "").trim();
  if (!t) return false;
  if (DISCOVERY_QUESTION_FALLBACKS.some((q) => tokenOverlapRatio(t, q) >= 0.55)) return true;
  const sentences = t.split(/[.!]+/).map((s) => s.trim()).filter(Boolean);
  const onlyQuestions =
    /\?/.test(t) &&
    sentences.length <= 2 &&
    t.length < 220 &&
    !/\b(green rep|today'?s action|try this|send|reach out|your step|experiment)\b/i.test(t);
  return onlyQuestions;
};

/**
 * When a Green Rep is assigned, never leave the member with a discovery-only question.
 * Kept as a no-op passthrough — canned rewrites caused duplicate identical replies.
 */
const ensureActionReplyWhenRepAssigned = ({
  assistant = "",
} = {}) => String(assistant || "").trim();

const {
  assistantAlreadyAssignedRep,
} = require("../utils/repLatch");

const shouldDefaultExploreFirst = ({
  domain = null,
  userMessage = "",
  messages = [],
  user_asked_what_next = false,
  user_wants_discovery = false,
  user_rejects_prescription = false,
  user_completed_current_rep = false,
  has_active_session_rep = false,
  execution_confirmed = false,
  stop_discovery = false,
  proofCycleFlow = null,
  mechanism_ready = false,
  session_wants_next_step = false,
  map = null,
} = {}) => {
  if (user_asked_what_next) return false;
  if (session_wants_next_step && mechanism_ready) return false;
  if (USER_WANTS_ACTION_PATTERN.test(String(userMessage || ""))) return false;
  if (user_completed_current_rep && has_active_session_rep) return false;
  if (proofCycleFlow?.proof_integration_mode) return false;
  if (execution_confirmed) return false;
  if (stop_discovery) return false;
  if (mechanism_ready) return false;

  const userTurns = countUserTurns(messages, userMessage);
  if (
    userTurns >= EXPLORE_FIRST_MAX_TURNS &&
    (map?.map_resistance_complete || mechanism_ready)
  ) {
    return false;
  }

  if (user_rejects_prescription || detectUserRejectsPrescription([userMessage])) return true;

  const domainLower = String(domain || "").toLowerCase();
  if (DISCOVERY_FIRST_DOMAINS.has(domainLower)) return true;
  if (user_wants_discovery || detectUserWantsDiscovery([userMessage])) return true;

  return false;
};

const guardAssistantReplyAgainstRepeat = ({
  assistant = "",
  messages = [],
  userMessage = "",
  extraPriorAssistants = [],
  allowDiscoveryFallback = true,
  domain = null,
  sessionRepLocked = false,
} = {}) => {
  const text = String(assistant || "").trim();
  if (!text) return text;
  if (sessionRepLocked || !allowDiscoveryFallback) return text;

  const priorSet = new Set([
    ...assistantTextsFromMessages(messages),
    ...extraPriorAssistants.map((t) => String(t || "").trim()).filter(Boolean),
  ]);
  const prior = [...priorSet];
  const extraPrior = extraPriorAssistants.map((t) => String(t || "").trim()).filter(Boolean);

  const swap = () => pickDiscoveryFallback(userMessage, [...prior, ...extraPrior], domain);

  if (extraPrior.some((p) => normalizeForCompare(p) === normalizeForCompare(text))) {
    return swap();
  }

  if (!prior.length && !extraPrior.length) return text;
  const allPrior = [...new Set([...prior, ...extraPrior])];

  const exactDup = allPrior.some((p) => p.trim() === text);
  let maxOverlap = 0;
  for (const p of allPrior) {
    maxOverlap = Math.max(maxOverlap, tokenOverlapRatio(text, p));
  }

  if (!exactDup && maxOverlap < 0.38) return text;
  return swap();
};

module.exports = {
  DISCOVERY_ONLY_DIRECTIVE,
  MECHANISM_EXIT_DIRECTIVE,
  EXPLORE_FIRST_DIRECTIVE,
  PRESCRIPTIVE_REPLY_PATTERN,
  DIAGNOSIS_THEME_PATTERNS,
  DISCOVERY_QUESTION_FALLBACKS,
  MECHANISM_READY_MIN_TURNS,
  EXPLORE_FIRST_MAX_TURNS,
  USER_WANTS_ACTION_PATTERN,
  detectUserRejectsPrescription,
  detectUserWantsDiscovery,
  detectSessionWantsNextStep,
  detectCoachingRepeatComplaintExpanded,
  detectThematicAssistantRepeat,
  detectRepeatedAssistantAdvice,
  maxAssistantOverlapRatio,
  tokenOverlapRatio,
  countUserTurns,
  isMechanismReady,
  buildAntiRepeatState,
  shouldDefaultExploreFirst,
  pickDiscoveryFallback,
  isDiscoveryOnlyQuestion,
  ensureActionReplyWhenRepAssigned,
  assistantAlreadyAssignedRep,
  guardAssistantReplyAgainstRepeat,
};
