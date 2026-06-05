/**
 * Curiosity-first coaching — gather context before resistance analysis or Green Rep.
 * NOTE: Live coach uses stage1CoachTransition.js (resolveCoachingTransition) — not this module's
 * MIN_DISCOVERY turn loop. Kept for state-machine tests and legacy routing only.
 */

const { detectProgressSignals } = require("./stage1CoachProgress");

const MIN_DISCOVERY_TURNS = 1;

const STRUGGLE_PATTERNS = [
  /\b(?:bad|terrible|awful|rough|sucked)\b/i,
  /\bdidn'?t\s+(?:do|get|finish|start|complete)\b/i,
  /\bno(?:thing)?\s+(?:done|happened|progress)\b/i,
  /\bavoided\b/i,
  /\bstuck\b/i,
  /\bprocrastinat/i,
  /\bfailed\b/i,
  /\bwasted\b/i,
  /\blazy\b/i,
  /\bunproductive\b/i,
  /\boff\s+track\b/i,
  /\bfell\s+off\b/i,
  /\bno\s+motivation\b/i,
];

const DISCOVERY_QUESTIONS = [
  "What got in the way today?",
  "Did you plan to work on this today?",
  "What did you spend most of the day doing?",
  "What felt hardest about starting?",
  "What were you hoping to get done?",
  "When did you notice you weren't going to do it?",
  "What pulled your attention away?",
];

const FOLLOW_UP_BY_TOPIC = [
  { re: /\b(plan|planned|intend)\b/i, q: "What got in the way of that plan?" },
  { re: /\b(scroll|phone|social|netflix|game|tv)\b/i, q: "What were you avoiding by staying in that?" },
  { re: /\b(tired|exhaust|sleep|burnout)\b/i, q: "Was it physical tiredness, or more resistance to the task?" },
  { re: /\b(fear|afraid|anxious|nervous)\b/i, q: "What felt scary about starting?" },
  { re: /\b(time|busy|meeting|kids|family)\b/i, q: "Was it truly no time, or did the task keep getting bumped?" },
];

const emptyDiscovery = () => ({
  active: false,
  step: 0,
  answers: [],
  questions_asked: [],
});

const normalizeDiscovery = (raw) => {
  if (!raw || typeof raw !== "object") return emptyDiscovery();
  return {
    active: Boolean(raw.active),
    step: Number(raw.step) || 0,
    answers: Array.isArray(raw.answers) ? raw.answers : [],
    questions_asked: Array.isArray(raw.questions_asked) ? raw.questions_asked : [],
  };
};

const detectStruggleSetback = (text) => {
  const t = String(text || "").trim();
  if (t.length < 4) return false;
  const proof = detectProgressSignals(t);
  if (proof.isStrong || proof.hasProof) return false;
  return STRUGGLE_PATTERNS.some((re) => re.test(t));
};

const pickDiscoveryQuestion = (discovery, lastAnswer = "") => {
  const asked = new Set((discovery.questions_asked || []).map((q) => q.toLowerCase()));
  for (const { re, q } of FOLLOW_UP_BY_TOPIC) {
    if (re.test(lastAnswer) && !asked.has(q.toLowerCase())) return q;
  }
  for (const q of DISCOVERY_QUESTIONS) {
    if (!asked.has(q.toLowerCase())) return q;
  }
  return "What else should I understand about today?";
};

const briefAck = (text) => {
  const t = String(text || "").trim();
  if (!t) return "I hear you.";
  if (/\b(bad|terrible|awful|rough|sucked)\b/i.test(t)) return "Sounds like a tough day.";
  if (/\bdidn'?t\b/i.test(t)) return "Got it — nothing landed today.";
  return "Thanks for being straight about that.";
};

const startDiscovery = (userMessage) => ({
  ...emptyDiscovery(),
  active: true,
  step: 0,
  answers: [String(userMessage || "").trim()].filter(Boolean),
});

const advanceDiscovery = (discovery, userMessage) => {
  const state = normalizeDiscovery(discovery);
  const text = String(userMessage || "").trim();
  if (text) state.answers.push(text);

  if (state.step >= MIN_DISCOVERY_TURNS) {
    return {
      discovery: { ...state, active: false },
      assistant_message: null,
      ready_for_coaching: true,
      session_phase: "coaching",
    };
  }

  const lastAnswer = state.answers[state.answers.length - 1] || "";
  const question = pickDiscoveryQuestion(state, lastAnswer);
  state.questions_asked.push(question);
  state.step += 1;

  const ack = briefAck(text || state.answers[0]);
  return {
    discovery: state,
    assistant_message: `${ack}\n\n${question}`,
    ready_for_coaching: false,
    session_phase: "discovery",
  };
};

const isDiscoveryActive = (discovery) => normalizeDiscovery(discovery).active;

const discoveryContextForAi = (discovery) => {
  const state = normalizeDiscovery(discovery);
  if (!state.answers.length) return null;
  return {
    struggle_reported: state.answers[0],
    follow_up_answers: state.answers.slice(1),
    turns: state.step,
    instruction:
      "Discovery is complete. Name the pattern you see ONLY now — then one Green Rep. " +
      "Do not psychoanalyze. Do not explain 'not enough' unless they said it about a win.",
  };
};

module.exports = {
  MIN_DISCOVERY_TURNS,
  emptyDiscovery,
  normalizeDiscovery,
  detectStruggleSetback,
  startDiscovery,
  advanceDiscovery,
  isDiscoveryActive,
  discoveryContextForAi,
  pickDiscoveryQuestion,
  briefAck,
};
