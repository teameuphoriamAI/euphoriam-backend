/**
 * Investigation mode — when the user is uncertain or stuck without detail,
 * narrow the bottleneck before naming the map diagnosis again.
 */

const { resolveFailureStrategyForMap } = require("./stage1MapStructure");
const { lastAssistantMessage } = require("./stage1CoachStructuralReflection");

const UNCERTAINTY_SIGNAL_PATTERN =
  /^\s*(nothing(?:\s+special)?|nothing\.?|i'?m\s+stuck|stuck|i\s+feel\s+stuck|i\s+don'?t\s+know(?:\s+what\s+to\s+do)?|don'?t\s+know(?:\s+what\s+to\s+do)?|no\s+idea(?:\s+what\s+to\s+do)?|idk|not\s+sure|unsure|no\s+clue|i\s+have\s+no\s+idea)\s*\.?!?\s*$/i;

const DIAGNOSIS_MARKER_PATTERN =
  /\b(financially\s+invisible|staying\s+invisible|failure\s+strategy|protector\s+rule|pattern\s+(?:is\s+)?(?:still\s+)?active|doing\s+its\s+job|the\s+gap\s+we'?re\s+tracking)\b/i;

const INVESTIGATION_MARKER = "What part is unclear";

const pickFailureLabel = (map) => {
  const fs = resolveFailureStrategyForMap(map);
  if (typeof fs === "string") return fs.trim();
  return (fs?.rule || fs?.title || map?.protector_rule || "").trim() || null;
};

const normalizeDiagnosisKey = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

const detectUncertaintySignal = (text) =>
  UNCERTAINTY_SIGNAL_PATTERN.test(String(text || "").trim());

/** @deprecated alias */
const detectVagueStuck = detectUncertaintySignal;

const assistantMessages = (messages = []) =>
  (messages || [])
    .filter((m) => m?.role === "assistant")
    .map((m) => String(m.content || "").trim())
    .filter(Boolean);

const messageNamesDiagnosis = (text, map) => {
  const t = String(text || "");
  if (!t) return false;
  if (DIAGNOSIS_MARKER_PATTERN.test(t)) return true;
  const failure = pickFailureLabel(map);
  if (failure && t.toLowerCase().includes(failure.toLowerCase().slice(0, 24))) return true;
  const protector = map?.protector_rule?.trim();
  if (protector && protector.length > 12) {
    const snippet = protector.toLowerCase().slice(0, 32);
    if (t.toLowerCase().includes(snippet)) return true;
  }
  return false;
};

const lastAssistantNamedDiagnosis = (messages = [], map = null) => {
  const last = lastAssistantMessage(messages);
  return messageNamesDiagnosis(last, map);
};

const wouldRepeatDiagnosis = (messages = [], map = null) => {
  const assistants = assistantMessages(messages);
  if (assistants.length < 1) return false;
  if (messageNamesDiagnosis(assistants[assistants.length - 1], map)) return true;
  if (assistants.length < 2) return false;
  const prev = assistants[assistants.length - 2];
  const last = assistants[assistants.length - 1];
  if (!messageNamesDiagnosis(prev, map) || !messageNamesDiagnosis(last, map)) return false;
  return normalizeDiagnosisKey(prev) === normalizeDiagnosisKey(last);
};

const lastAssistantWasInvestigation = (messages = [], openSession = null) => {
  if (openSession?.investigation_flow?.active) return true;
  const last = lastAssistantMessage(messages);
  return (
    last.includes(INVESTIGATION_MARKER) ||
    /\bwhat would your first step be\b/i.test(last) ||
    /\bwhat have you already considered\b/i.test(last) ||
    /\bwhere to find clients\b/i.test(last)
  );
};

const isSubstantiveBottleneckAnswer = (text) => {
  const t = String(text || "").trim();
  if (!t || detectUncertaintySignal(t)) return false;
  if (t.length < 10) return false;
  return (
    /\b(client|customer|price|charge|rate|outreach|message|post|sell|offer|contact|find|friend|linkedin|instagram|email|dm|call|follow.?up|portfolio|service|niche|audience|platform)\b/i.test(
      t,
    ) || t.length >= 40
  );
};

const bottleneckMenuForDomain = (domain, milestone) => {
  const d = String(domain || "").toLowerCase();
  if (d === "income" || d === "wealth" || d === "money") {
    return `finding clients, what service to sell, what to charge, or who to contact first toward ${milestone}`;
  }
  if (d === "relationships" || d === "relationship") {
    return `who to reach out to, what to say, what you're afraid will happen, or what stopped you last time`;
  }
  return `the first step, what to say or do, who to involve, or what you're avoiding`;
};

const INVESTIGATION_STEPS = [
  {
    id: "unclear_part",
    build: ({ domain, milestone }) =>
      `Okay — let's not guess the pattern yet.\n\n` +
      `What part is unclear: ${bottleneckMenuForDomain(domain, milestone)}?`,
  },
  {
    id: "first_step",
    build: ({ milestone, goal }) =>
      `If I asked you to make one real move this week toward ${milestone || goal}, ` +
      `what would your first step be — even if it feels small or messy?`,
  },
  {
    id: "bottleneck_menu",
    build: ({ domain, milestone }) =>
      `Let's narrow it down.\n\n` +
      `Is the block: ${bottleneckMenuForDomain(domain, milestone)}?`,
  },
  {
    id: "considered",
    build: () =>
      `What have you already considered but haven't done yet — even once?`,
  },
];

const pickInvestigationStep = (investigationFlow = null) => {
  const used = investigationFlow?.questions_asked || [];
  for (const step of INVESTIGATION_STEPS) {
    if (!used.includes(step.id)) return step;
  }
  return INVESTIGATION_STEPS[used.length % INVESTIGATION_STEPS.length];
};

const buildInvestigationMessage = ({
  map = null,
  activeGoalContext = null,
  investigationFlow = null,
  userMessage = "",
  messages = [],
  step: stepOverride = null,
}) => {
  const milestone =
    activeGoalContext?.current_milestone ||
    activeGoalContext?.milestones?.day_7 ||
    map?.goal_title ||
    "your goal";
  const goal = activeGoalContext?.goal_name || map?.goal_title || "your goal";
  const domain = activeGoalContext?.domain || map?.domain || null;

  const step = stepOverride || pickInvestigationStep(investigationFlow);
  const body = step.build({ domain, milestone, goal });

  if (lastAssistantWasInvestigation(messages, { investigation_flow: investigationFlow })) {
    return body;
  }

  if (lastAssistantNamedDiagnosis(messages, map)) {
    return (
      `That's uncertainty — not proof the map is wrong.\n\n` +
      `${body}`
    );
  }

  return body;
};

const buildBottleneckAcknowledgment = ({ userMessage, map, activeGoalContext }) => {
  const milestone =
    activeGoalContext?.current_milestone ||
    activeGoalContext?.milestones?.day_7 ||
    map?.goal_title ||
    "your goal";
  const snippet = String(userMessage || "").trim().slice(0, 160);
  return (
    `Good — that's specific: "${snippet}".\n\n` +
    `So the bottleneck isn't "everything" — it's something we can move on.\n\n` +
    `What's the smallest next action toward ${milestone} that tests that — one message, one price named, or one person contacted?`
  );
};

const resolveInvestigationTurnFlow = ({
  messages = [],
  userMessage = "",
  map = null,
  activeGoalContext = null,
  openSession = null,
  proofCycleFlow = null,
  firstSessionFlow = null,
} = {}) => {
  const base = {
    skip_llm: false,
    assistant_override: null,
    coaching_directive: null,
    active: false,
    investigation_flow: openSession?.investigation_flow || null,
  };

  if (!map?.map_resistance_complete) return base;
  if (proofCycleFlow?.skip_llm) return base;
  if (firstSessionFlow?.skip_llm) return base;

  const priorFlow = openSession?.investigation_flow || {};
  const uncertain = detectUncertaintySignal(userMessage);
  const substantive = isSubstantiveBottleneckAnswer(userMessage);
  const investigationActive = Boolean(priorFlow.active && !priorFlow.complete);

  if (investigationActive && substantive) {
    return {
      ...base,
      skip_llm: true,
      active: true,
      assistant_override: buildBottleneckAcknowledgment({
        userMessage,
        map,
        activeGoalContext,
      }),
      coaching_directive:
        "User named a specific bottleneck — acknowledge it. ONE tiny targeted action. " +
        "Do NOT re-state failure strategy, financially invisible, or protector lecture.",
      investigation_flow: {
        ...priorFlow,
        active: false,
        complete: true,
        last_answer: userMessage.trim().slice(0, 300),
      },
    };
  }

  const shouldInvestigate =
    uncertain &&
    (investigationActive ||
      assistantMessages(messages).length >= 1 ||
      wouldRepeatDiagnosis(messages, map));

  if (!shouldInvestigate) return base;

  const step = pickInvestigationStep(priorFlow);
  const questionsAsked = [...(priorFlow.questions_asked || [])];
  if (!questionsAsked.includes(step.id)) questionsAsked.push(step.id);

  return {
    ...base,
    skip_llm: true,
    active: true,
    assistant_override: buildInvestigationMessage({
      map,
      activeGoalContext,
      investigationFlow: priorFlow,
      userMessage,
      messages,
      step,
    }),
    coaching_directive:
      "INVESTIGATION MODE — identify the real bottleneck with ONE discovery question. " +
      "Do NOT name failure strategy, financially invisible, or repeat the last diagnosis. " +
      "No generic advice until they name what's actually blocked.",
    investigation_flow: {
      active: true,
      complete: false,
      questions_asked: questionsAsked,
      last_question_id: step.id,
      diagnosis_blocked: true,
    },
  };
};

module.exports = {
  UNCERTAINTY_SIGNAL_PATTERN,
  INVESTIGATION_MARKER,
  detectUncertaintySignal,
  detectVagueStuck,
  isSubstantiveBottleneckAnswer,
  messageNamesDiagnosis,
  lastAssistantNamedDiagnosis,
  wouldRepeatDiagnosis,
  buildInvestigationMessage,
  buildBottleneckAcknowledgment,
  resolveInvestigationTurnFlow,
  pickFailureLabel,
};
