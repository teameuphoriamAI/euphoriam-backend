/**
 * Per-turn conversation signals — barriers, repetition, solo rep progression.
 */

const { detectProgressSignals } = require("../utils/progress");
const {
  detectUserActionReport,
  hasCoachActionThisSession,
} = require("./structuralReflection");
const {
  detectUncertaintySignal,
  wouldRepeatDiagnosis,
} = require("./investigation");

const NO_TRUSTED_PERSON_PATTERN =
  /\b(no\s*one|nobody|don'?t\s+have\s+anyone|have\s+no\s+one|no\s+friends?|not\s+anyone|no\s+body\s+to\s+talk|alone|isolated|no\s+one\s+to\s+talk)\b/i;

const WHAT_NEXT_PATTERN =
  /\b(what\s+should\s+i\s+do|what\s+do\s+i\s+do\s+next|what'?s?\s+next|what\s+now|what\s+should\s+i\s+do\s+next|what\s+next|how\s+(?:do|should|can|will|would)\s+i\s+(?:start|begin|do\s+(?:it|this|that)|get\s+started|actually\s+(?:start|do|begin))|how\s+will\s+i\s+do\s+it|where\s+(?:do|should|can|would)\s+i\s+(?:even\s+)?(?:start|begin)|(?:what'?s?|what\s+is)\s+the\s+first\s+step|first\s+step|(?:what|which)\s+steps|steps\s+(?:do\s+)?i\s+(?:must|need|should|have\s+to)\s+take|what\s+do\s+i\s+need\s+to\s+do|how\s+do\s+i\s+do\s+this|(?:knowing|know|leave\s+(?:with|knowing)|want(?:ing)?)\s+(?:the\s+|a\s+)?next\s+step|the\s+next\s+step|next\s+step)\b/i;

const REP_REQUIRES_PERSON_PATTERN =
  /\b(someone|person|trust|send\s+it|send\s+to|reach\s+out|friend|family|tell\s+them|text\s+them|safest\s+relevant\s+person)\b/i;

const REP_COMPLETION_PATTERN =
  /\b(done|fone|donw|finished|completed|i did it|said it|played it back|kept it|i'?ve been doing that)\b/i;

const REP_STAGNATION_PATTERN =
  /\b(nothing changed|nothing'?s changed|no change|didn'?t help|not helping|isn'?t helping|same thing|stuck|no new step|doing it daily but|beside writing|only writing|each day|what to do if i(?:'ve| have) already|already did that today|outcomes aren'?t|not shifting|should i just keep|same advice|told me same|yesterday and today|keep doing the same)\b/i;

const COACHING_REPEAT_COMPLAINT_PATTERN =
  /\b(same thing|same advice|told me same|you told me|yesterday and today|keep doing the same|should i just keep|nothing'?s changing|not shifting|outcomes aren'?t|doing the same thing|that'?s part of the problem|you keep asking|same question|talking past|not the issue|isn'?t (?:the|analyzing)|already (?:said|told|explained)|don'?t want (?:an? )?(?:exercise|homework|action|step)|stop giving (?:me )?(?:exercises|homework|steps|advice)|stay with (?:the )?(?:feeling|emotion)|want to understand|help me (?:figure|understand|explore)|move(?:d|s)? back to (?:another )?(?:action|exercise|step)|another exercise|you keep (?:giving|suggesting|repeating)|not what i (?:asked|need|want))\b/i;

const {
  buildAntiRepeatState,
  detectRepeatedAssistantAdvice: detectRepeatedAssistantAdviceStrict,
  detectCoachingRepeatComplaintExpanded,
  shouldDefaultExploreFirst,
  detectSessionWantsNextStep,
  isMechanismReady,
  assistantAlreadyAssignedRep,
  EXPLORE_FIRST_DIRECTIVE,
  MECHANISM_EXIT_DIRECTIVE,
  USER_WANTS_ACTION_PATTERN,
} = require("./antiRepeat");

const OUTREACH_INVESTIGATION_LOOP_PATTERN =
  /\b(investigation question|what specific outreach|responses have you received|patterns? in responses|analyze (?:your )?outreach)\b/i;

const GENERIC_KINDNESS_ADVICE_PATTERN =
  /\b(act of kindness|small act|acknowledging something you appreciate|relax and recharge|supportive message|thoughtful for someone|being good to humans)\b/i;

const REP_NAME_IN_CHAT =
  /\b(solo\s+truth\s+hold|feeling\s+stay|mirror\s+stay|one\s+line\s+out|green\s+rep)\b/i;

const ALREADY_DID_PATTERN = /\b(already did that|already done|already did this|i already did)\b/i;

const SOLO_REP_PROGRESSION = Object.freeze([
  {
    name: "Solo Truth Hold",
    steps: [
      "Write one honest sentence you're avoiding in your notes app — do not send it.",
      "Read it out loud once, then record a 20-second voice memo saying only that sentence.",
      "Play it back once and stay still for 20 seconds without deleting it.",
    ],
    win_condition:
      "One honest sentence exists in writing or voice — you did not delete it immediately after.",
  },
  {
    name: "Feeling Stay",
    steps: [
      "Open the note or memo from your last truth rep.",
      "Add one sentence: what feeling showed up in your body when you said it.",
      "Sit with that note for 60 seconds without editing or deleting.",
    ],
    win_condition: "One feeling sentence added — you did not delete the file or memo.",
  },
  {
    name: "Mirror Stay",
    steps: [
      "Say your honest sentence out loud to your reflection in the mirror.",
      "Hold eye contact with yourself for 30 seconds after you finish the sentence.",
      "Name one physical sensation quietly (tight chest, heat, urge to look away).",
    ],
    win_condition: "Sentence said aloud to mirror + 30-second hold without walking away.",
  },
  {
    name: "One Line Out",
    steps: [
      "Write one true sentence in your notes app as if someone kind were listening — do not send.",
      "Read it once out loud.",
      "Save it and leave it until tomorrow without deleting.",
    ],
    win_condition: "One unsent sentence saved until tomorrow.",
  },
]);

const normalizeForCompare = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const tokenOverlapRatio = (a, b) => {
  const ta = new Set(normalizeForCompare(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeForCompare(b).split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) {
    if (tb.has(t)) shared += 1;
  }
  return shared / Math.max(ta.size, tb.size);
};

const userMessagesFromTranscript = (messages = [], currentMessage = "") => {
  const prior = (messages || [])
    .filter((m) => m?.role === "user")
    .map((m) => String(m.content || "").trim())
    .filter(Boolean);
  const current = String(currentMessage || "").trim();
  return current ? [...prior, current] : prior;
};

const detectNoTrustedPerson = (texts = []) => {
  const combined = texts.join(" ");
  return NO_TRUSTED_PERSON_PATTERN.test(combined);
};

const detectWhatNextQuestion = (text) => WHAT_NEXT_PATTERN.test(String(text || ""));

const detectRepStagnation = (text) => REP_STAGNATION_PATTERN.test(String(text || ""));

const detectRepCompletion = (text, { hasActiveSessionRep = false, lastRepName = null } = {}) => {
  const t = String(text || "").trim();
  if (!t) return false;
  const sessionHasRep = hasActiveSessionRep || Boolean(lastRepName);
  if (detectRepStagnation(t)) return false;
  if (/^(done|fone|donw|finished|completed)$/i.test(t)) return sessionHasRep;
  if (ALREADY_DID_PATTERN.test(t)) return sessionHasRep;
  if (/\bi did that\b/i.test(t)) return sessionHasRep;
  if (/\bi did it\b/i.test(t)) return sessionHasRep;
  if (/\bi'?ve been doing that\b/i.test(t)) return sessionHasRep;
  if (/\b(said it|played it back|kept it)\b/i.test(t)) return sessionHasRep;
  const proof = detectProgressSignals(t);
  if (proof.hasProof) return true;
  if (proof.repCompleted && sessionHasRep) return true;
  return false;
};

const countSessionRepCompletions = (messages = []) =>
  (messages || [])
    .filter((m) => m?.role === "user")
    .filter((m) => detectRepCompletion(m.content)).length;

const isExplicitSoloRep = (name) =>
  /\b(mirror|solo|feeling|one\s+line|truth\s+hold|journal|voice\s+memo|notes|self|unsent)\b/i.test(
    String(name || ""),
  );

const soloRepIndex = (repName) => {
  const key = String(repName || "").trim().toLowerCase();
  if (!key) return -1;
  return SOLO_REP_PROGRESSION.findIndex((rep) => rep.name.toLowerCase() === key);
};

const repRequiresTrustedPerson = (repName, map = null) => {
  const daily = map?.daily_rep;
  const parts = [
    repName,
    daily?.name,
    daily?.win_condition,
    ...(daily?.steps || []),
  ]
    .filter(Boolean)
    .join(" ");
  if (REP_REQUIRES_PERSON_PATTERN.test(parts)) return true;
  if (
    repName &&
    /\b(truth\s+send|outreach|reach\s+out|contact|send\s+to|tell\s+them)\b/i.test(repName)
  ) {
    return true;
  }
  return Boolean(
    repName &&
      !isExplicitSoloRep(repName) &&
      /\b(truth|send|outreach|contact|reach)\b/i.test(repName),
  );
};

const detectRepeatedUserPoint = (messages = [], currentMessage = "") => {
  const users = userMessagesFromTranscript(messages, "");
  const current = normalizeForCompare(currentMessage);
  if (!current || users.length === 0) return false;

  const prev = normalizeForCompare(users[users.length - 1]);
  if (!prev) return false;

  if (current === prev) return true;
  if (current.length >= 3 && prev.length >= 3) {
    if (current.includes(prev) || prev.includes(current)) return true;
    if (current.length >= 8 && prev.length >= 8 && tokenOverlapRatio(current, prev) >= 0.72) {
      return true;
    }
  }
  return false;
};

const lastAssistantMessage = (messages = []) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return String(messages[i].content || "");
  }
  return "";
};

const INTERVENTION_LOOP_PHRASES = [
  /your voice matters/i,
  /express your truth/i,
  /be visible/i,
  /challenge the belief/i,
  /perfect to be accepted/i,
  /act of kindness/i,
  /small act/i,
  /supportive message/i,
  /significant step/i,
  /keep building on this momentum/i,
];

const detectRepeatedAssistantAdvice = (messages = []) => {
  const assistantTexts = (messages || [])
    .filter((m) => m?.role === "assistant")
    .map((m) => String(m.content || "").trim())
    .filter(Boolean);
  if (assistantTexts.length < 2) return false;
  const current = assistantTexts[assistantTexts.length - 1];
  const previous = assistantTexts[assistantTexts.length - 2];
  if (current === previous) return true;
  if (
    OUTREACH_INVESTIGATION_LOOP_PATTERN.test(current) &&
    OUTREACH_INVESTIGATION_LOOP_PATTERN.test(previous)
  ) {
    return true;
  }
  return detectRepeatedAssistantAdviceStrict(messages);
};

const detectCoachingRepeatComplaint = (text) =>
  COACHING_REPEAT_COMPLAINT_PATTERN.test(String(text || ""));

const lastAssistantWasGenericAdvice = (messages = []) => {
  const last = lastAssistantMessage(messages);
  if (!last) return false;
  return (
    GENERIC_KINDNESS_ADVICE_PATTERN.test(last) &&
    !REP_NAME_IN_CHAT.test(last) &&
    !/\bwin condition\b/i.test(last)
  );
};

const detectAssistantAdviceLoop = (messages = [], currentMessage = "") => {
  const assistantTexts = (messages || [])
    .filter((m) => m?.role === "assistant")
    .map((m) => String(m.content || ""));
  const last = assistantTexts[assistantTexts.length - 1] || "";
  if (!last) return false;

  let interventionFamilies = 0;
  for (const re of INTERVENTION_LOOP_PHRASES) {
    if (assistantTexts.some((t) => re.test(t))) interventionFamilies += 1;
  }
  const repeatedIntervention = INTERVENTION_LOOP_PHRASES.some((re) => {
    const hits = assistantTexts.filter((t) => re.test(t)).length;
    return hits >= 2;
  });
  if (repeatedIntervention || (interventionFamilies >= 2 && assistantTexts.length >= 2)) {
    return true;
  }
  if (detectRepeatedAssistantAdvice(messages)) return true;

  const loopHints = /notes app|voice memo|honest sentence|play it back|20 seconds/i;
  if (!loopHints.test(last)) return false;
  return (
    detectWhatNextQuestion(currentMessage) ||
    detectRepCompletion(currentMessage) ||
    /^fone$/i.test(String(currentMessage || "").trim())
  );
};

const resolveSoloRepLevel = ({
  messages = [],
  userMessage = "",
  lastRep = null,
  map = null,
  no_trusted_person = false,
  user_completed_current_rep = false,
  user_asked_what_next = false,
}) => {
  if (!no_trusted_person) return null;

  const lastIdx = soloRepIndex(lastRep);
  const sessionCompletions = countSessionRepCompletions(messages);

  if (user_completed_current_rep) {
    const next = lastIdx >= 0 ? lastIdx + 1 : Math.min(sessionCompletions, SOLO_REP_PROGRESSION.length - 1);
    if (next >= SOLO_REP_PROGRESSION.length) return null;
    return Math.min(Math.max(next, 1), SOLO_REP_PROGRESSION.length - 1);
  }

  if (lastRep && repRequiresTrustedPerson(lastRep, map) && !isExplicitSoloRep(lastRep)) {
    return 0;
  }

  if (lastIdx >= 0) {
    if (user_asked_what_next && sessionCompletions > lastIdx) {
      return Math.min(lastIdx + 1, SOLO_REP_PROGRESSION.length - 1);
    }
    return lastIdx;
  }

  return 0;
};

const buildSoloRepAdaptation = (level = 0) =>
  SOLO_REP_PROGRESSION[Math.min(Math.max(level, 0), SOLO_REP_PROGRESSION.length - 1)];

/**
 * @param {object} opts
 * @param {object[]} opts.messages
 * @param {string} opts.userMessage
 * @param {object} [opts.map]
 * @param {object} [opts.memoryCtx]
 */
const buildCoachConversationSignals = ({
  messages = [],
  userMessage = "",
  map = null,
  memoryCtx = {},
  persistentBarriers = null,
  openSession = null,
  goalContext = null,
  proofCycleFlow = null,
} = {}) => {
  const userTexts = userMessagesFromTranscript(messages, userMessage);
  const lastRep = memoryCtx?.last_green_rep || null;
  const { hasRepAssignedThisSession } = require("../flows/proofCycle");
  const hasActiveSessionRep = hasRepAssignedThisSession(openSession, messages, lastRep);
  const no_trusted_person = Boolean(
    persistentBarriers?.no_trusted_person || detectNoTrustedPerson(userTexts),
  );
  const mechanism_ready = isMechanismReady({ messages, userMessage, map });
  const antiRepeat = buildAntiRepeatState({
    messages,
    userMessage,
    map,
    mechanism_ready,
  });
  const session_wants_next_step = Boolean(
    antiRepeat.session_wants_next_step ||
      detectSessionWantsNextStep(userTexts) ||
      USER_WANTS_ACTION_PATTERN.test(String(userMessage || "")),
  );
  let user_asked_what_next =
    detectWhatNextQuestion(userMessage) ||
    (session_wants_next_step && mechanism_ready);
  const exploreFirstEarly = shouldDefaultExploreFirst({
    domain: map?.domain || goalContext?.domain || null,
    userMessage,
    messages,
    user_asked_what_next,
    user_wants_discovery: antiRepeat.user_wants_discovery,
    user_rejects_prescription: antiRepeat.user_rejects_prescription,
    proofCycleFlow,
    mechanism_ready,
    session_wants_next_step,
    map,
  });
  // Hard reject / soft discovery before mechanism is clear still suppress what-next.
  // Once mechanism is clear (or session asked for a next step), keep what-next alive.
  if (
    (antiRepeat.user_rejects_prescription ||
      (!mechanism_ready && (antiRepeat.user_wants_discovery || exploreFirstEarly))) &&
    !(mechanism_ready && session_wants_next_step)
  ) {
    user_asked_what_next = false;
  }
  const { detectEstablishedExecutionClarity } = require("./clarity");
  const establishedExecutionClarity = detectEstablishedExecutionClarity(
    userMessage,
    messages,
    openSession,
  );
  let user_expressed_uncertainty =
    !establishedExecutionClarity.established && detectUncertaintySignal(userMessage);
  const diagnosis_would_repeat = wouldRepeatDiagnosis(messages, map);
  const user_repeated_same_point = detectRepeatedUserPoint(messages, userMessage);
  const reports_stagnation =
    detectRepStagnation(userMessage) ||
    detectCoachingRepeatComplaint(userMessage) ||
    userTexts.some((t) => detectRepStagnation(t) || detectCoachingRepeatComplaint(t));
  const coaching_repeat_complaint =
    detectCoachingRepeatComplaint(userMessage) ||
    detectCoachingRepeatComplaintExpanded(userMessage) ||
    antiRepeat.coaching_repeat_complaint;
  const repeated_assistant_advice =
    antiRepeat.repeated_assistant_advice || detectRepeatedAssistantAdvice(messages);
  const user_completed_current_rep = detectRepCompletion(userMessage, {
    hasActiveSessionRep,
    lastRepName: lastRep,
  });
  const assistant_advice_loop =
    antiRepeat.anti_repeat_active ||
    detectAssistantAdviceLoop(messages, userMessage) ||
    repeated_assistant_advice ||
    coaching_repeat_complaint ||
    antiRepeat.thematic_assistant_repeat;
  const lastRepIdx = soloRepIndex(lastRep);
  const active_rep_needs_person = repRequiresTrustedPerson(lastRep, map);
  const active_solo_rep = isExplicitSoloRep(lastRep);

  const needs_solo_rep_adaptation =
    no_trusted_person &&
    !user_completed_current_rep &&
    lastRep &&
    !active_solo_rep &&
    active_rep_needs_person;

  const block_rep_reassign =
    active_solo_rep &&
    user_asked_what_next &&
    !user_completed_current_rep &&
    !needs_solo_rep_adaptation;

  const solo_level = resolveSoloRepLevel({
    messages,
    userMessage,
    lastRep,
    map,
    no_trusted_person,
    user_completed_current_rep,
    user_asked_what_next,
  });

  const solo_ladder_complete =
    no_trusted_person &&
    lastRepIdx >= SOLO_REP_PROGRESSION.length - 1 &&
    (reports_stagnation || user_completed_current_rep || ALREADY_DID_PATTERN.test(userMessage));

  let suggested_green_rep = null;
  if (
    !user_completed_current_rep &&
    no_trusted_person &&
    solo_level != null &&
    !reports_stagnation &&
    !solo_ladder_complete
  ) {
    suggested_green_rep = buildSoloRepAdaptation(solo_level);
  } else if (needs_solo_rep_adaptation) {
    suggested_green_rep = buildSoloRepAdaptation(0);
  }

  const same_rep_blocked = Boolean(
    suggested_green_rep &&
      lastRep &&
      suggested_green_rep.name.toLowerCase() === String(lastRep).toLowerCase(),
  );

  if (same_rep_blocked && solo_level != null && solo_level + 1 < SOLO_REP_PROGRESSION.length) {
    suggested_green_rep = buildSoloRepAdaptation(solo_level + 1);
  }

  const same_rep_after_fix = Boolean(
    suggested_green_rep &&
      lastRep &&
      suggested_green_rep.name.toLowerCase() === String(lastRep).toLowerCase(),
  );

  let assign_new_rep =
    !antiRepeat.discovery_only_mode &&
    !exploreFirstEarly &&
    !user_expressed_uncertainty &&
    !user_completed_current_rep &&
    !reports_stagnation &&
    !solo_ladder_complete &&
    !same_rep_after_fix &&
    !block_rep_reassign &&
    !coaching_repeat_complaint &&
    !repeated_assistant_advice &&
    !detectUserActionReport(userMessage) &&
    (needs_solo_rep_adaptation ||
      (hasActiveSessionRep && user_completed_current_rep) ||
      (user_asked_what_next && hasActiveSessionRep && user_completed_current_rep) ||
      (user_asked_what_next && no_trusted_person && !active_solo_rep && !lastRep) ||
      (mechanism_ready &&
        session_wants_next_step &&
        !hasActiveSessionRep &&
        !antiRepeat.user_rejects_prescription));

  if (!assign_new_rep && !user_completed_current_rep && !needs_solo_rep_adaptation) {
    suggested_green_rep = null;
  }

  let coaching_directive = antiRepeat.coaching_directive || null;
  if (antiRepeat.discovery_only_mode) {
    coaching_directive = antiRepeat.coaching_directive;
  } else if (user_expressed_uncertainty) {
    coaching_directive =
      "INVESTIGATION MODE — user is uncertain or stuck without detail. " +
      "Ask ONE discovery question to find the bottleneck (what's unclear, first step, who/what/price). " +
      "Do NOT name failure strategy, financially invisible, or repeat the last diagnosis. green_rep must be null.";
  } else if (diagnosis_would_repeat) {
    coaching_directive =
      "ANTI-REPEAT — you already named this diagnosis last turn. Do NOT say it again. " +
      "Ask what specifically is blocked or what their first step would be.";
  } else if (coaching_repeat_complaint || repeated_assistant_advice) {
    coaching_directive = antiRepeat.coaching_directive;
  } else if (reports_stagnation || solo_ladder_complete) {
    coaching_directive =
      "User reports solo sentence reps are not changing outcomes OR has completed the solo ladder. " +
      "Do NOT assign another notes/voice/sentence Green Rep. Do NOT paste rep steps in chat. " +
      "Coach conversationally: name what feels stuck, connect to their actual goal milestone, ask ONE question OR suggest one visible goal-aligned action (not another journal rep). green_rep must be null.";
  } else if (user_completed_current_rep && hasActiveSessionRep) {
    coaching_directive =
      "User completed the current rep — enter PROOF INTEGRATION. Ask what happened / what changed / what they learned / what resistance remained. " +
      "Do NOT re-explain protector, flip, or original diagnosis. Do NOT assign the same rep. " +
      "Member already knows the map — climb the staircase, do not restart at step one.";
  } else if (detectUserActionReport(userMessage) && hasCoachActionThisSession(messages, openSession)) {
    coaching_directive =
      "User reported a concrete action — treat as proof. Reflect: prediction vs reality. " +
      "Ask what happened after. Do NOT recommend the same action again.";
  } else if (user_completed_current_rep && !hasActiveSessionRep) {
    coaching_directive =
      "User said they did something, but NO Green Rep was assigned this session — this was casual check-in chat. " +
      "Acknowledge what they said. Do NOT ask for a proof log. Do NOT assign a Green Rep.";
  } else if (lastAssistantWasGenericAdvice(messages) && /\bi did that\b/i.test(userMessage)) {
    coaching_directive =
      "User responded to generic encouragement — NOT a Green Rep completion. Acknowledge briefly. " +
      "Do NOT ask for proof log. Do NOT assign a rep unless they ask what's next and a rep is warranted.";
  } else if (block_rep_reassign) {
    coaching_directive =
      "User asked what's next but has NOT finished the current solo rep — point them to the active rep's win condition. " +
      "Do NOT assign a new rep and do NOT repeat the full instructions verbatim.";
  } else if (assistant_advice_loop) {
    coaching_directive = antiRepeat.coaching_directive;
  } else if (user_repeated_same_point && no_trusted_person) {
    coaching_directive =
      "User repeated that they have no one. Do NOT ask again whether someone exists to talk to. " +
      "Acknowledge that directly, then give ONE solo alternative action for today.";
  } else if (no_trusted_person && user_asked_what_next) {
    coaching_directive =
      "User asked what to do next — give ONE new concrete action. " +
      "If they already finished the current solo rep, move to suggested_green_rep. No recap lecture.";
  } else if (no_trusted_person) {
    coaching_directive =
      "User has no one to talk to right now — treat that as fact (persists across sessions). " +
      "Do NOT suggest finding a trusted person. Do NOT cite proof logs about 'someone trust' as completed actions. Use solo channels only.";
  } else if (user_asked_what_next) {
    coaching_directive =
      "User asked what to do — give ONE concrete external next action tied to the active flip and milestone. " +
      "For income/business: prefer prospecting, outreach, offers, follow-up, proposals, or conversations. " +
      "No mirror/voice/solo truth exercises unless stabilization, overwhelm, or no external action is possible. " +
      "Answer what they can do in the next 10 minutes — not abstract reflection.";
    if (active_rep_needs_person) {
      coaching_directive +=
        " If the current rep involves another person, include a solo fallback in the same reply.";
    }
  } else if (user_repeated_same_point) {
    coaching_directive =
      "User repeated the same point — change your approach; do not reuse the prior assistant wording.";
  }

  let claritySignals = null;
  let evidenceSignals = null;
  if (map?.map_resistance_complete) {
    const { buildClarityExecutionSignals } = require("./clarity");
    const { buildEvidenceContradictionSignals } = require("./evidence");
    const signalCtx = {
      userMessage,
      messages,
      map,
      goalContext,
      memoryCtx,
      openSession,
      proofCycleFlow,
    };
    claritySignals = buildClarityExecutionSignals(signalCtx);
    evidenceSignals = buildEvidenceContradictionSignals(signalCtx);
    if (!antiRepeat.discovery_only_mode && !exploreFirstEarly) {
      if (claritySignals?.coaching_directive) {
        coaching_directive = claritySignals.coaching_directive;
      } else if (evidenceSignals?.coaching_directive) {
        coaching_directive = evidenceSignals.coaching_directive;
      }
    }
  }

  const exploreFirst = shouldDefaultExploreFirst({
    domain: map?.domain || goalContext?.domain || null,
    userMessage,
    messages,
    user_asked_what_next,
    user_wants_discovery: antiRepeat.user_wants_discovery,
    user_rejects_prescription: antiRepeat.user_rejects_prescription,
    user_completed_current_rep,
    has_active_session_rep: hasActiveSessionRep,
    execution_confirmed: Boolean(claritySignals?.execution_confirmed),
    stop_discovery: Boolean(
      claritySignals?.stop_discovery ||
        establishedExecutionClarity.established ||
        mechanism_ready,
    ),
    proofCycleFlow,
    mechanism_ready,
    session_wants_next_step,
    map,
  });
  const inDiscoveryMode = Boolean(
    antiRepeat.discovery_only_mode || (exploreFirst && !mechanism_ready),
  );

  if (inDiscoveryMode) {
    const hardPushback =
      antiRepeat.coaching_repeat_complaint ||
      antiRepeat.user_rejects_prescription ||
      /\b(don'?t want (?:an? )?(?:exercise|homework|action|step)|stop giving (?:me )?(?:exercises|homework|steps|advice)|stay with (?:the )?(?:feeling|emotion)|not another exercise|please stop)\b/i.test(
        String(userMessage || ""),
      );
    const exploreDirective =
      exploreFirst &&
      !hardPushback &&
      !antiRepeat.repeated_assistant_advice &&
      !antiRepeat.thematic_assistant_repeat
        ? EXPLORE_FIRST_DIRECTIVE
        : null;
    coaching_directive =
      exploreDirective || antiRepeat.coaching_directive || coaching_directive;
    assign_new_rep = false;
    suggested_green_rep = null;
  } else if (mechanism_ready && !antiRepeat.user_rejects_prescription) {
    const alreadyAssigned =
      hasActiveSessionRep || assistantAlreadyAssignedRep(messages);
    if (alreadyAssigned) {
      coaching_directive =
        "Green Rep already assigned this session. Do NOT repeat the same pattern speech or re-assign a new rep. " +
        "Respond briefly to what they said — help them execute the current step or answer their question.";
      assign_new_rep = false;
      suggested_green_rep = null;
    } else {
      coaching_directive = MECHANISM_EXIT_DIRECTIVE;
      if (!user_completed_current_rep && !block_rep_reassign) {
        assign_new_rep = true;
      }
    }
  }

  const block_clarity_rep =
    Boolean(claritySignals?.block_green_rep) || Boolean(evidenceSignals?.block_green_rep);
  const assign_clarity_rep = Boolean(claritySignals?.assign_green_rep);

  if (block_clarity_rep || inDiscoveryMode) {
    assign_new_rep = false;
    suggested_green_rep = null;
  } else if (assign_clarity_rep && claritySignals?.suggested_clarity_rep) {
    suggested_green_rep = claritySignals.suggested_clarity_rep;
    assign_new_rep = true;
  }

  const coaching_context = {
    ...(claritySignals?.coaching_context || {}),
    ...(evidenceSignals?.coaching_context || {}),
  };

  return {
    no_trusted_person,
    persistent_barrier: Boolean(persistentBarriers?.stored_no_trusted_person),
    user_asked_what_next,
    user_expressed_uncertainty,
    diagnosis_would_repeat,
    user_repeated_same_point,
    user_completed_current_rep,
    has_active_session_rep: hasActiveSessionRep,
    coaching_repeat_complaint,
    repeated_assistant_advice,
    assistant_advice_loop,
    active_rep_needs_person,
    active_solo_rep,
    needs_solo_rep_adaptation,
    block_rep_reassign,
    assign_new_rep,
    assign_green_rep: assign_new_rep,
    reports_stagnation,
    solo_ladder_complete,
    same_rep_blocked: same_rep_after_fix,
    suggested_green_rep,
    self_generated_clarity: Boolean(claritySignals?.self_generated_clarity),
    seeking_leverage_direction: Boolean(claritySignals?.seeking_leverage_direction),
    execution_confirmed: Boolean(claritySignals?.execution_confirmed),
    user_commitment_to_act: Boolean(claritySignals?.user_commitment_to_act),
    execution_sustainability_issue: Boolean(claritySignals?.execution_sustainability_issue),
    user_showing_hope_depletion: Boolean(claritySignals?.user_showing_hope_depletion),
    motivation_loss: Boolean(claritySignals?.motivation_loss),
    clarity_saturation: Boolean(claritySignals?.clarity_saturation),
    agreement_loop_detected: Boolean(claritySignals?.agreement_loop_detected),
    strategy_context_clear: Boolean(claritySignals?.strategy_context_clear),
    stop_discovery: Boolean(
      !antiRepeat.user_rejects_prescription &&
        !antiRepeat.coaching_repeat_complaint &&
        (mechanism_ready ||
          claritySignals?.stop_discovery ||
          establishedExecutionClarity.established) &&
        !inDiscoveryMode,
    ),
    execution_clarity_established: Boolean(
      establishedExecutionClarity.established ||
        claritySignals?.coaching_context?.execution_clarity_established,
    ),
    insufficient_data_for_analysis: Boolean(
      claritySignals?.coaching_context?.insufficient_data_for_analysis,
    ),
    evidence_contradicts_diagnosis: Boolean(evidenceSignals?.evidence_contradicts_diagnosis),
    visibility_action_occurred: Boolean(evidenceSignals?.visibility_action_occurred),
    outcome_pending: Boolean(evidenceSignals?.outcome_pending),
    outreach_target_count: claritySignals?.outreach_target_count || 0,
    block_clarity_rep,
    coaching_context: Object.keys(coaching_context).length ? coaching_context : null,
    clarity_writeback_hints: claritySignals?.writeback_hints || null,
    evidence_writeback_hints: evidenceSignals?.writeback_hints || null,
    structural_coaching_flow:
      claritySignals?.structural_coaching_flow ||
      evidenceSignals?.structural_coaching_flow ||
      null,
  /** @deprecated */ suggested_solo_rep: suggested_green_rep,
    coaching_directive,
    user_rejects_prescription: antiRepeat.user_rejects_prescription,
    user_wants_discovery: antiRepeat.user_wants_discovery,
    session_wants_next_step,
    mechanism_ready,
    user_turns: antiRepeat.user_turns,
    explore_first_mode: exploreFirst && !mechanism_ready,
    discovery_only_mode: inDiscoveryMode,
    anti_repeat_active: Boolean(
      antiRepeat.anti_repeat_active || (exploreFirst && !mechanism_ready),
    ),
    thematic_assistant_repeat: antiRepeat.thematic_assistant_repeat,
    max_assistant_overlap: antiRepeat.max_assistant_overlap,
  };
};

module.exports = {
  NO_TRUSTED_PERSON_PATTERN,
  WHAT_NEXT_PATTERN,
  REP_COMPLETION_PATTERN,
  REP_STAGNATION_PATTERN,
  SOLO_REP_PROGRESSION,
  detectNoTrustedPerson,
  detectWhatNextQuestion,
  detectRepCompletion,
  detectCoachingRepeatComplaint,
  detectRepeatedAssistantAdvice,
  detectRepeatedUserPoint,
  detectAssistantAdviceLoop,
  repRequiresTrustedPerson,
  buildSoloRepAdaptation,
  buildCoachConversationSignals,
};
