/**
 * Wound-edge → flip-install flow (Nathan spec):
 * aware of protecting rule → reduce gravity → install flip — one question per turn, no loops.
 */

const WOUND_EDGE_QUESTIONS = [
  "What rule are you running right now to protect the \"not enough\" story?",
  "What story keeps this win from counting — even though the action happened?",
  "What are you telling yourself that makes this result unsafe to claim?",
];

const FLIP_LEVERAGE_QUESTIONS = [
  "What would make breaking this rule a must for you — not a preference?",
  "Who or what becomes possible if this wound loosens even 5%?",
  "Why would continuing this old rule cost you more than playing small?",
];

const CORE_WOUND_PATTERNS = [
  { re: /\bnot\s+enough\b/i, wound: "I'm not enough" },
  { re: /\bnot\s+safe\b/i, wound: "I'm not safe" },
  { re: /\bnot\s+good\s+enough\b/i, wound: "I'm not enough" },
  { re: /\bnot\s+worth\b/i, wound: "I'm not enough" },
  { re: /\bnot\s+ready\b/i, wound: "I'm not safe" },
];

const AVOIDANCE_RULE_HINTS = [
  {
    re: /\b24\s*hrs?|\b7\s*days\b|all\s*day|every\s*day|non.?stop|work\s+\d+\s*hrs?\s*7/i,
    rule: "If I grind 24/7, then I'll finally be enough",
  },
  {
    re: /\bcan'?t\b.*\bmake\b.*\bmoney\b|\bwon'?t\b.*\bmoney\b.*\blove\b/i,
    rule: "I can't make money doing what I love",
  },
  {
    re: /\btoo\s+little\b|\bworking\s+too\s+little\b/i,
    rule: "I'm not working hard enough — so the win doesn't count",
  },
  {
    re: /\bneed\s+more\b|\bshould\s+be\s+further\b/i,
    rule: "I need more before I'm allowed to feel successful",
  },
  {
    re: /\b(earn|make|paid)\b.*\b(less|little|low|small)\b|\bso\s+less\b|\bless\s+money\b|\bnot\s+much\s+money\b/i,
    rule: "If I earn this little, the win doesn't count — I'm still not enough",
  },
  {
    re: /\bonly\s+\$|\bjust\s+\d/i,
    rule: "The amount is too small to count as real progress",
  },
];

const VAGUE_ANSWER =
  /^(yes|yeah|yep|yup|idk|i\s+don'?t\s+know|nothing\s+much|not\s+much|not\s+sure|no\s+idea|tho|ok|okay|sure|mm+|hm+)\s*$/i;

const normalizeQuestionKey = (q) =>
  String(q || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

const isVagueAnswer = (text) => {
  const t = String(text || "").trim();
  return !t || VAGUE_ANSWER.test(t);
};

const isDuplicateQuestion = (candidate, state) => {
  const key = normalizeQuestionKey(candidate);
  if (!key) return true;
  if (state?.last_question_key === key) return true;
  if ((state?.questions_asked || []).includes(key)) return true;
  return false;
};

const pickQuestion = (candidates, state) => {
  for (const q of candidates) {
    if (!isDuplicateQuestion(q, state)) return q;
  }
  return null;
};

const recordQuestion = (state, question) => {
  const key = normalizeQuestionKey(question);
  if (!key) return;
  if (!state.questions_asked.includes(key)) state.questions_asked.push(key);
  state.last_question_key = key;
  state.last_question_text = String(question || "").trim();
};

const inferCoreWound = (text, map = {}) => {
  const t = String(text || "");
  for (const { re, wound } of CORE_WOUND_PATTERNS) {
    if (re.test(t)) return wound;
  }
  const avoidance = map?.top_3_avoidance_behaviours || [];
  if (avoidance.some((a) => /not\s+enough|never\s+enough/i.test(a))) return "I'm not enough";
  if (avoidance.some((a) => /safe|security|reject/i.test(a))) return "I'm not safe";
  return "I'm not enough";
};

const detectAvoidanceRule = (text) => {
  const t = String(text || "").trim();
  if (!t) return null;
  for (const { re, rule } of AVOIDANCE_RULE_HINTS) {
    if (re.test(t)) return rule;
  }
  if (/\bnot\s+enough\b/i.test(t) && /\b(work|hour|grind|more)\b/i.test(t)) {
    return "I have to do more before this counts";
  }
  return null;
};

/** User's answer to the wound-edge question — always prefer this turn's text */
const resolveAvoidanceRuleFromAnswer = (text) => {
  const t = String(text || "").trim().replace(/^that\s+/i, "").trim();
  if (!t || isVagueAnswer(t)) return null;
  const detected = detectAvoidanceRule(t);
  if (detected) return detected;
  if (/\b(earn|make|paid|income|money|amount)\b/i.test(t)) {
    return `If I ${t}, it doesn't count — I'm still not enough`;
  }
  if (t.length <= 160) {
    const capped = t.charAt(0).toUpperCase() + t.slice(1);
    return capped.endsWith(".") ? capped : `${capped}.`;
  }
  return t.slice(0, 160);
};

const detectRegression = (text) => {
  const t = String(text || "").trim();
  if (!t) return null;
  if (/\b(slipped|slip\s+back|again|old\s+pattern|same\s+loop|back\s+into)\b/i.test(t)) {
    return t.slice(0, 200);
  }
  if (/\bstill\s+(overthink|avoid|delay|not\s+enough)\b/i.test(t)) return t.slice(0, 200);
  return null;
};

const buildDiagnosticObservation = (state) => {
  const wound = state.answers?.active_core_wound;
  const rule = state.answers?.avoidance_rule;
  const leverage = state.answers?.leverage_note;
  const parts = [];
  if (wound) parts.push(`Core wound active: ${wound}`);
  if (rule) parts.push(`Avoidance rule: ${rule}`);
  if (leverage) parts.push(`Flip leverage: ${leverage}`);
  if (state.answers?.regression_note) parts.push(`Regression noted: ${state.answers.regression_note}`);
  return parts.length ? parts.join(" | ") : null;
};

/** First turn after devaluation close — name wound + one edge question */
const enterWoundEdge = (state, text, context = {}) => {
  if (text) {
    const regression = detectRegression(text);
    if (regression) state.answers.regression_note = regression;
    // Do not set avoidance_rule here — opening-turn text is not their answer to the wound question
  }

  const wound = inferCoreWound(
    [state.answers?.devaluation_note, text].filter(Boolean).join(" "),
    context.map,
  );
  state.answers.active_core_wound = wound;
  state.wound_edge_asked = true;
  state.step = "wound_edge";

  const q =
    pickQuestion(WOUND_EDGE_QUESTIONS, state) ||
    WOUND_EDGE_QUESTIONS[0];
  recordQuestion(state, q);

  const lines = [
    `The progress is real. Under it, the familiar wound is "${wound}" — that's the edge, not the income number.`,
    "There's usually a rule that protects that wound (grinding harder, shrinking the win, waiting for 'more').",
    q,
  ];

  return {
    assistant_message: lines.join("\n\n"),
    session_phase: "wound_edge",
    coach_state: "wound_edge",
    ready_for_resistance_coaching: false,
    diagnostic_observation: buildDiagnosticObservation(state),
  };
};

/** User named the protecting rule → ask leverage (one question) */
const enterFlipLeverage = (state, text) => {
  const userSaid = String(text || "").trim();
  const resolved = resolveAvoidanceRuleFromAnswer(userSaid);
  if (resolved) {
    state.answers.avoidance_rule = resolved;
  } else if (userSaid && !isVagueAnswer(userSaid)) {
    state.answers.avoidance_rule = userSaid.replace(/^that\s+/i, "").trim();
  } else {
    state.answers.avoidance_rule =
      state.answers.avoidance_rule || "unclear — protecting not enough";
  }

  const ruleLabel = String(state.answers.avoidance_rule || "").slice(0, 120);
  const ruleSnippet =
    userSaid && !isVagueAnswer(userSaid)
      ? `You said "${userSaid.slice(0, 100)}" — so the rule sounds like: "${ruleLabel}".`
      : ruleLabel
        ? `So the rule sounds like: "${ruleLabel}".`
        : "Name the rule out loud — that's the first break.";

  const q =
    pickQuestion(FLIP_LEVERAGE_QUESTIONS, state) ||
    FLIP_LEVERAGE_QUESTIONS[0];
  recordQuestion(state, q);
  state.step = "flip_leverage";

  return {
    assistant_message: [ruleSnippet, q].filter(Boolean).join("\n\n"),
    session_phase: "flip_leverage",
    coach_state: "flip_install",
    ready_for_resistance_coaching: false,
    diagnostic_observation: buildDiagnosticObservation(state),
  };
};

/** Flip installed — STOP, coaching may continue later */
const finishFlipInstall = (state, text) => {
  if (text && !isVagueAnswer(text)) {
    state.answers.leverage_note = text;
  }
  state.flip_complete = true;
  state.step = "integration_complete";

  const wound = state.answers?.active_core_wound || "the old wound";
  const lines = [
    "Good — that's the leverage.",
    "",
    `The flip is to act from proof without letting "${wound}" run the scoreboard.`,
    "We're not assigning a bigger grind or the same rep today. Let this land.",
  ];

  return {
    assistant_message: lines.join("\n\n"),
    session_phase: "wound_flip_complete",
    coach_state: "coaching",
    ready_for_resistance_coaching: true,
    diagnostic_observation: buildDiagnosticObservation(state),
  };
};

const handleWoundFlipTurn = (state, text, context = {}) => {
  if (state.flip_complete || state.step === "integration_complete") {
    if (/\b24|7\s*days|all\s*day|grind|non.?stop/i.test(String(text || ""))) {
      return {
        assistant_message:
          "Working 24/7 rarely satisfies a 'not enough' feeling — it usually deepens it.\n\nWhat you already did still counts for this week.",
        session_phase: "wound_flip_complete",
        coach_state: "coaching",
        ready_for_resistance_coaching: false,
        diagnostic_observation: buildDiagnosticObservation(state),
      };
    }
    return {
      assistant_message:
        "This integration pass is complete. We can pick up fresh coaching when you're ready — no extra questions today.",
      session_phase: "wound_flip_complete",
      coach_state: "coaching",
      ready_for_resistance_coaching: false,
    };
  }

  if (state.step === "wound_edge" || (state.devaluation_loop_complete && !state.wound_edge_asked)) {
    if (!state.wound_edge_asked) {
      return enterWoundEdge(state, text, context);
    }
    return enterFlipLeverage(state, text);
  }

  if (state.step === "flip_leverage") {
    return finishFlipInstall(state, text);
  }

  if (state.devaluation_loop_complete) {
    return enterWoundEdge(state, text, context);
  }

  return null;
};

module.exports = {
  WOUND_EDGE_QUESTIONS,
  FLIP_LEVERAGE_QUESTIONS,
  inferCoreWound,
  detectAvoidanceRule,
  resolveAvoidanceRuleFromAnswer,
  detectRegression,
  enterWoundEdge,
  enterFlipLeverage,
  finishFlipInstall,
  handleWoundFlipTurn,
  buildDiagnosticObservation,
  isVagueAnswer,
};
