const { DOMAIN_LABELS } = require("../constants/domains");
const { MAP_RESISTANCE_TARGET_QUESTIONS } = require("../constants/mapResistance");
const {
  buildMapResistanceIntroText,
  getStage1MapResistanceWelcomeMessage,
} = require("./stage1PromptSuite");
/**
 * ACTIVE_GOAL_CONTEXT for goal-scoped map resistance Q&A (Stage 1).
 * @see docs/EUPHORIAM-STAGE1-STAGE2-README.md
 */
const buildActiveGoalContext = (map, domain) => {
  const milestones = map?.milestones || {};
  return {
    active_domain: domain,
    domain_label: DOMAIN_LABELS[domain] || domain,
    goal_name: map?.goal_title || null,
    specific_goal: map?.goal_title || null,
    measurable_outcome: map?.desired_outcome || null,
    target_date: map?.target_date || null,
    why_it_matters: map?.notes?.trim() || null,
    notes: map?.notes?.trim() || null,
    current_reality: map?.today_visible_action || null,
    current_milestone: milestones?.day_7 || milestones?.day_30 || null,
    milestones: {
      day_7: milestones?.day_7 ?? null,
      day_30: milestones?.day_30 ?? null,
      day_90: milestones?.day_90 ?? null,
    },
    proof_of_success: map?.proof_of_success || null,
    required_role: map?.required_role || null,
    required_behaviours: Array.isArray(map?.required_behaviours) ? map.required_behaviours : [],
    known_avoidance: Array.isArray(map?.top_3_avoidance_behaviours)
      ? map.top_3_avoidance_behaviours
      : [],
    perceived_risk: map?.perceived_risk || null,
    past_pattern: map?.past_pattern || null,
    core_fear: map?.core_fear || null,
    visible_next_action: map?.today_visible_action || null,
  };
};

/**
 * User prompt for ongoing map-resistance turns (goal-scoped, not 25Q life intake).
 */const buildMapResistanceIntakePrompt = async ({
  transcript = [],
  userName,
  resumeNotice,
  activeGoalContext = {},
  targetCount = MAP_RESISTANCE_TARGET_QUESTIONS,
  aiAnswered = true,
  lastUserContent = "",
  isGibberish = false,
  currentQuestionNumber = null,
}) => {
  const displayName =
    typeof userName === "string" && userName.trim().length
      ? userName.trim()
      : "there";
  const label =
    activeGoalContext.domain_label || activeGoalContext.active_domain || "this domain";
  const goal =
    activeGoalContext.specific_goal ||
    activeGoalContext.goal_name ||
    "the stated goal";

  const assistantMessages = transcript.filter(
    (m) => m?.role === "assistant" && m.content,
  );
  let lastAnsweredQ = 0;
  for (let i = 0; i < transcript.length - 1; i++) {
    const curr = transcript[i];
    const next = transcript[i + 1];
    if (
      curr?.role === "assistant" &&
      next?.role === "user" &&
      /Q\d+/i.test(curr.content || "")
    ) {
      const match = (curr.content || "").match(/Q(\d+)/i);
      if (match) lastAnsweredQ = parseInt(match[1], 10);
    }
  }
  const stayOnQ =
    currentQuestionNumber != null && Number.isFinite(Number(currentQuestionNumber))
      ? Number(currentQuestionNumber)
      : Math.max(1, lastAnsweredQ);
  const nextQ = aiAnswered
    ? Math.min(targetCount, Math.max(1, lastAnsweredQ + 1))
    : Math.min(targetCount, Math.max(1, stayOnQ));

  const ctxBlock = JSON.stringify(activeGoalContext, null, 2);

  const gibberishBlock =
    isGibberish && lastUserContent
      ? `The user's last message was unclear or gibberish ("${String(lastUserContent).slice(0, 80)}"). Output: (1) A brief warm response — e.g. "Hmm, that doesn't look like a response I can work with — no worries." (2) Then re-ask **Q${stayOnQ}** in simpler words with one short example. Do NOT advance to Q${stayOnQ + 1}. Do NOT count their last message as an answer.\n\n`
      : !aiAnswered && lastUserContent
        ? `The user's last message did not answer the question ("${String(lastUserContent).slice(0, 80)}"). Output: (1) Brief acknowledgment — e.g. "I'm not sure that answers the question — let me rephrase." (2) Stay on **Q${stayOnQ}** and rephrase in new words.\n\n`
        : lastUserContent
          ? `The user gave a valid answer ("${String(lastUserContent).slice(0, 120)}"). Output: (1) Brief acknowledgment that reflects what they shared (e.g. "Got it — I hear that."). (2) Then ask the next question.\n\n`
          : "";

  const questionBlock =
    lastAnsweredQ >= targetCount && aiAnswered
      ? `All ${targetCount} questions are done. Acknowledge completion warmly and tell them they can press "Complete mapping" — do not ask another intake question.`
      : `Ask exactly ONE question labeled **Q${nextQ}** about resistance, avoidance, protector behaviour, fear, or cost tied to achieving "${goal}" in the ${label} domain. Include your brief acknowledgment BEFORE the **Q${nextQ}** line.`;

  return `${resumeNotice ? `${resumeNotice}\n\n` : ""}You are conducting MAP RESISTANCE for domain "${label}" only.

ACTIVE_GOAL_CONTEXT:
${ctxBlock}

The user already selected this domain and saved their goal. Never ask them to pick money, relationship, health, purpose, or "everything first."

Goal: "${goal}"

Transcript so far:
${JSON.stringify(transcript, null, 2)}

${gibberishBlock}${questionBlock}

Reply as the assistant only. One acknowledgment + one question per message.`;
};

module.exports = {
  buildActiveGoalContext,
  buildMapResistanceIntroText,
  getStage1MapResistanceWelcomeMessage,
  buildMapResistanceIntakePrompt,
};
