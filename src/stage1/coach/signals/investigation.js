/**
 * Investigation mode — detect uncertainty; emit signals for Coach Brain.
 */

const { resolveFailureStrategyForMap } = require("../../../helpers/stage1MapStructure");
const { lastAssistantMessage } = require("./structuralReflection");
const { formatOutcomeDirective } = require("./directive");

const UNCERTAINTY_SIGNAL_PATTERN =
  /^\s*(nothing(?:\s+special)?|nothing\.?|i'?m\s+stuck|stuck|i\s+feel\s+stuck|i\s+don'?t\s+know(?:\s+what\s+to\s+do)?|don'?t\s+know(?:\s+what\s+to\s+do)?|no\s+idea(?:\s+what\s+to\s+do)?|idk|not\s+sure|unsure|no\s+clue|i\s+have\s+no\s+idea)\s*\.?!?\s*$/i;

const DIAGNOSIS_MARKER_PATTERN =
  /\b(financially\s+invisible|staying\s+invisible|failure\s+strategy|protector\s+rule|pattern\s+(?:is\s+)?(?:still\s+)?active|doing\s+its\s+job|the\s+gap\s+we'?re\s+tracking)\b/i;

const INVESTIGATION_MARKER = "What part is unclear";

const INVESTIGATION_STEPS = Object.freeze([
  { id: "unclear_part", themes: ["finding clients", "service to sell", "pricing", "first contact"] },
  { id: "first_step", themes: ["smallest first move", "one real step this week"] },
  { id: "bottleneck_menu", themes: ["narrow the block", "which category is stuck"] },
  { id: "considered", themes: ["already considered but not done"] },
]);

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
    return ["finding clients", "what service to sell", "what to charge", "who to contact first"];
  }
  if (d === "relationships" || d === "relationship") {
    return ["who to reach out to", "what to say", "fear of outcome", "what stopped them last time"];
  }
  return ["first step", "what to say or do", "who to involve", "what they are avoiding"];
};

const pickInvestigationStep = (investigationFlow = null) => {
  const used = investigationFlow?.questions_asked || [];
  for (const step of INVESTIGATION_STEPS) {
    if (!used.includes(step.id)) return step;
  }
  return INVESTIGATION_STEPS[used.length % INVESTIGATION_STEPS.length];
};

const buildInvestigationContext = ({
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
    "goal";
  const goal = activeGoalContext?.goal_name || map?.goal_title || "goal";
  const domain = activeGoalContext?.domain || map?.domain || null;
  const step = stepOverride || pickInvestigationStep(investigationFlow);

  return {
    investigation_active: true,
    investigation_step_id: step.id,
    investigation_themes: step.themes,
    bottleneck_menu: bottleneckMenuForDomain(domain, milestone),
    milestone,
    goal,
    domain,
    diagnosis_named_last_turn: lastAssistantNamedDiagnosis(messages, map),
    prior_investigation_turn: lastAssistantWasInvestigation(messages, { investigation_flow: investigationFlow }),
    user_message_snippet: String(userMessage || "").trim().slice(0, 160),
  };
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
    coaching_context: null,
    conversation_signals: null,
    active: false,
    investigation_flow: openSession?.investigation_flow || null,
  };

  if (!map?.map_resistance_complete) return base;
  if (proofCycleFlow?.proof_integration_mode) return base;
  if (firstSessionFlow?.active) return base;

  const { detectEstablishedExecutionClarity } = require("./clarity");
  if (detectEstablishedExecutionClarity(userMessage, messages, openSession).established) {
    return base;
  }

  const userTexts = (messages || [])
    .filter((m) => m?.role === "user")
    .map((m) => String(m.content || "").trim())
    .filter(Boolean);
  if (userMessage) userTexts.push(String(userMessage).trim());
  const { detectSessionWantsNextStep } = require("./antiRepeat");
  if (detectSessionWantsNextStep(userTexts)) {
    return base;
  }

  const priorFlow = openSession?.investigation_flow || {};
  const uncertain = detectUncertaintySignal(userMessage);
  const substantive = isSubstantiveBottleneckAnswer(userMessage);
  const investigationActive = Boolean(priorFlow.active && !priorFlow.complete);

  if (investigationActive && substantive) {
    const milestone =
      activeGoalContext?.current_milestone ||
      activeGoalContext?.milestones?.day_7 ||
      map?.goal_title ||
      "goal";
    return {
      ...base,
      active: true,
      coaching_directive: formatOutcomeDirective("investigation_bottleneck_named", {
        goal: "Convert named bottleneck into one testable next action.",
        yourJob: [
          "acknowledge the specific bottleneck they named",
          "offer one tiny targeted action toward milestone",
        ],
        avoid: ["failure strategy lecture", "financially invisible diagnosis", "protector recap"],
      }),
      coaching_context: {
        investigation_complete: true,
        bottleneck_answer: userMessage.trim().slice(0, 300),
        milestone,
      },
      conversation_signals: {
        investigation_active: false,
        investigation_bottleneck_named: true,
        user_expressed_uncertainty: false,
      },
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
    active: true,
    coaching_directive: formatOutcomeDirective("investigation_active", {
      goal: "Identify the real bottleneck before naming the map diagnosis again.",
      yourJob: [
        "ask one discovery question matched to investigation_step_id",
        "gather what is genuinely unclear",
      ],
      avoid: ["failure strategy naming", "financially invisible", "repeating last diagnosis"],
    }),
    coaching_context: buildInvestigationContext({
      map,
      activeGoalContext,
      investigationFlow: priorFlow,
      userMessage,
      messages,
      step,
    }),
    conversation_signals: {
      investigation_active: true,
      user_expressed_uncertainty: true,
      diagnosis_would_repeat: wouldRepeatDiagnosis(messages, map),
    },
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
  INVESTIGATION_STEPS,
  detectUncertaintySignal,
  detectVagueStuck,
  isSubstantiveBottleneckAnswer,
  messageNamesDiagnosis,
  lastAssistantNamedDiagnosis,
  wouldRepeatDiagnosis,
  buildInvestigationContext,
  resolveInvestigationTurnFlow,
  pickFailureLabel,
};
