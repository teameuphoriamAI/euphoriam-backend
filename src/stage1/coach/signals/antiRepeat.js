/**
 * Zero-tolerance anti-repeat: thematic loops, exercise prescriptions, ignored pushback.
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

const USER_REJECTS_PRESCRIPTION_PATTERN =
  /\b(don'?t want (?:an? )?(?:exercise|homework|action|step|task|assignment)|no(?:t)? (?:another )?(?:exercise|homework|action step|numbered|step-by-step)|stop giving (?:me )?(?:exercises|homework|action|steps|advice)|please stop|not (?:analyzing|the issue)|stay with (?:the )?(?:feeling|emotion|experience)|want to understand|help me (?:figure|understand|explore|uncover)|understand (?:why|what'?s driving)|what'?s driving|where (?:does|did) (?:that|this) (?:belief|pattern|reaction) come from|uncover (?:what|why|where)|don'?t think we'?re addressing|move(?:d|s)? back to (?:another )?(?:action|exercise|step)|rather understand|not (?:a|the) small action|before trying to change|instead of (?:just )?(?:giving|another)|talking past|you keep (?:giving|suggesting|pushing))\b/i;

const USER_WANTS_DISCOVERY_PATTERN =
  /\b(help me (?:figure|understand|explore)|want to understand|what'?s underneath|what'?s driving|where did (?:that|this) (?:start|come from|begin)|stay with (?:the )?(?:feeling|emotion)|tell me more|go deeper|what are you experiencing|peel (?:back|another)|uncover (?:the|what|why)|roots? of (?:this|that)|why do i (?:do|pull|step)|what happened (?:the )?last time)\b/i;

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

const DISCOVERY_ONLY_DIRECTIVE =
  "DISCOVERY ONLY — member rejected exercises, repeated advice, or asked to stay with feeling/understand roots. " +
  "Reply in 1-3 SHORT sentences with ONE new question only. " +
  "FORBIDDEN: numbered lists, homework, breathing/writing exercises, outreach tasks, Green Rep, diagnosis labels they already heard, restating their goal, 'Let's focus on', 'small actionable step'. " +
  "Follow their thread — do not solve. green_rep must be null.";

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

const detectUserRejectsPrescription = (texts = []) => {
  const combined = texts.join("\n");
  return USER_REJECTS_PRESCRIPTION_PATTERN.test(combined);
};

const detectUserWantsDiscovery = (texts = []) => {
  const combined = texts.join("\n");
  return USER_WANTS_DISCOVERY_PATTERN.test(combined);
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

const buildAntiRepeatState = ({ messages = [], userMessage = "" } = {}) => {
  const userTexts = userTextsFromMessages(messages, userMessage);
  const user_rejects_prescription = detectUserRejectsPrescription(userTexts);
  const user_wants_discovery = detectUserWantsDiscovery(userTexts);
  const repeat_complaint =
    userTexts.some((t) => detectCoachingRepeatComplaintExpanded(t)) ||
    detectCoachingRepeatComplaintExpanded(userMessage);
  const repeated_assistant_advice = detectRepeatedAssistantAdvice(messages);
  const thematic_repeat = detectThematicAssistantRepeat(messages);
  const max_overlap = maxAssistantOverlapRatio(messages);

  const discovery_only_mode = Boolean(
    user_rejects_prescription ||
      user_wants_discovery ||
      repeat_complaint ||
      repeated_assistant_advice ||
      thematic_repeat ||
      max_overlap >= 0.38,
  );

  const anti_repeat_active = discovery_only_mode;

  return {
    user_rejects_prescription,
    user_wants_discovery,
    coaching_repeat_complaint: repeat_complaint,
    repeated_assistant_advice,
    thematic_assistant_repeat: thematic_repeat,
    max_assistant_overlap: max_overlap,
    discovery_only_mode,
    anti_repeat_active,
    coaching_directive: anti_repeat_active ? DISCOVERY_ONLY_DIRECTIVE : null,
    stop_discovery: anti_repeat_active ? false : undefined,
    block_green_rep: anti_repeat_active,
  };
};

const DISCOVERY_FIRST_DOMAINS = new Set([
  "relationships",
  "relationship",
  "love",
  "connection",
  "family",
]);

const USER_WANTS_ACTION_PATTERN =
  /\b(what (?:should|can|do) i do|what'?s next|how do i start|one thing (?:i|to|we) can do|smallest step|action today|give me (?:an? )?(?:action|step|homework|task))\b/i;

const EXPLORE_FIRST_DIRECTIVE =
  "EXPLORE FIRST — Nathan-style discovery. Reply in 1-3 SHORT sentences with ONE new question only. " +
  "Let the member uncover structure; do NOT label, diagnose, prescribe, or assign homework. " +
  "FORBIDDEN: fear of rejection, protective mechanism, outreach/send-a-message tasks, numbered steps, Green Rep, 'Let's focus on', 'small actionable step'. " +
  "Prefer body/feeling questions over 'what do you think'. Peel layers — do not solve.";

const DISCOVERY_QUESTION_FALLBACKS = [
  "What are you experiencing right now — in your body, not your head?",
  "Tell me more about the last time that pull-away feeling showed up.",
  "Stay with that. What's the worst part of it?",
  "What happens inside you the moment closeness starts to feel real?",
  "What part of that feels most alive for you right now?",
  "If you didn't pull away, what would you be afraid might happen next?",
];

const pickDiscoveryFallback = (userMessage, priorAssistants = []) => {
  const prior = priorAssistants.filter(Boolean);
  const candidates = [];

  if (/\b(body|feel|feeling|anxiety|experience)\b/i.test(String(userMessage || ""))) {
    candidates.push(DISCOVERY_QUESTION_FALLBACKS[0]);
  }
  if (/\b(understand|why|where|come from|roots?|underneath)\b/i.test(String(userMessage || ""))) {
    candidates.push(DISCOVERY_QUESTION_FALLBACKS[1]);
  }

  const idx = prior.length % DISCOVERY_QUESTION_FALLBACKS.length;
  candidates.push(
    ...DISCOVERY_QUESTION_FALLBACKS.slice(idx),
    ...DISCOVERY_QUESTION_FALLBACKS.slice(0, idx),
  );

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

  let best = ordered[0] || DISCOVERY_QUESTION_FALLBACKS[0];
  let bestScore = 1;
  for (const q of (ordered.length ? ordered : DISCOVERY_QUESTION_FALLBACKS)) {
    const score = prior.length ? Math.max(...prior.map((p) => tokenOverlapRatio(q, p))) : 0;
    if (score < bestScore) {
      bestScore = score;
      best = q;
    }
  }
  return best;
};

const shouldDefaultExploreFirst = ({
  domain = null,
  userMessage = "",
  user_asked_what_next = false,
  user_wants_discovery = false,
  user_rejects_prescription = false,
  user_completed_current_rep = false,
  has_active_session_rep = false,
  execution_confirmed = false,
  stop_discovery = false,
  proofCycleFlow = null,
} = {}) => {
  if (user_asked_what_next) return false;
  if (USER_WANTS_ACTION_PATTERN.test(String(userMessage || ""))) return false;
  if (user_completed_current_rep && has_active_session_rep) return false;
  if (proofCycleFlow?.proof_integration_mode) return false;
  if (execution_confirmed) return false;
  if (stop_discovery) return false;

  const domainLower = String(domain || "").toLowerCase();
  if (DISCOVERY_FIRST_DOMAINS.has(domainLower)) return true;
  if (user_wants_discovery || detectUserWantsDiscovery([userMessage])) return true;
  if (user_rejects_prescription || detectUserRejectsPrescription([userMessage])) return true;

  return false;
};

const guardAssistantReplyAgainstRepeat = ({
  assistant = "",
  messages = [],
  userMessage = "",
  extraPriorAssistants = [],
} = {}) => {
  const text = String(assistant || "").trim();
  if (!text) return text;

  const priorSet = new Set([
    ...assistantTextsFromMessages(messages),
    ...extraPriorAssistants.map((t) => String(t || "").trim()).filter(Boolean),
  ]);
  const prior = [...priorSet];
  const extraPrior = extraPriorAssistants.map((t) => String(t || "").trim()).filter(Boolean);

  if (extraPrior.some((p) => normalizeForCompare(p) === normalizeForCompare(text))) {
    return pickDiscoveryFallback(userMessage, [...prior, ...extraPrior]);
  }

  if (!prior.length && !extraPrior.length) return text;
  const allPrior = [...new Set([...prior, ...extraPrior])];

  const exactDup = allPrior.some((p) => p.trim() === text);
  let maxOverlap = 0;
  for (const p of allPrior) {
    maxOverlap = Math.max(maxOverlap, tokenOverlapRatio(text, p));
  }

  if (!exactDup && maxOverlap < 0.38) return text;
  return pickDiscoveryFallback(userMessage, allPrior);
};

module.exports = {
  DISCOVERY_ONLY_DIRECTIVE,
  EXPLORE_FIRST_DIRECTIVE,
  PRESCRIPTIVE_REPLY_PATTERN,
  DIAGNOSIS_THEME_PATTERNS,
  DISCOVERY_QUESTION_FALLBACKS,
  detectUserRejectsPrescription,
  detectUserWantsDiscovery,
  detectCoachingRepeatComplaintExpanded,
  detectThematicAssistantRepeat,
  detectRepeatedAssistantAdvice,
  maxAssistantOverlapRatio,
  tokenOverlapRatio,
  buildAntiRepeatState,
  shouldDefaultExploreFirst,
  pickDiscoveryFallback,
  guardAssistantReplyAgainstRepeat,
};
