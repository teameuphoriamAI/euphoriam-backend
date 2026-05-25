const { DOMAIN_LABELS } = require("../constants/domains");

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
    why_it_matters: null,
    current_reality: map?.today_visible_action || null,
    current_milestone: milestones?.day_7 || milestones?.day_30 || null,
    milestones: {
      day_7: milestones?.day_7 ?? null,
      day_30: milestones?.day_30 ?? null,
      day_90: milestones?.day_90 ?? null,
    },
    proof_of_success: map?.proof_of_success || null,
    required_role: null,
    required_behaviours: [],
    known_avoidance: Array.isArray(map?.top_3_avoidance_behaviours)
      ? map.top_3_avoidance_behaviours
      : [],
    perceived_risk: null,
    past_pattern: null,
    visible_next_action: map?.today_visible_action || null,
  };
};

const buildMapResistanceIntroText = (goalContext) => {
  const ctx = goalContext || {};
  return `STAGE 1 — MAP RESISTANCE (goal-scoped diagnostic)

You are mapping the hidden structure that activates when this person tries to achieve ONE specific goal — not a generic life diagnosis.

ACTIVE_GOAL_CONTEXT (anchor every question to this):
${JSON.stringify(ctx, null, 2)}

Rules:
- Ask numbered questions (Q1, Q2, …) one at a time.
- Each question must relate to resistance, avoidance, protector patterns, or behaviour tied to this goal.
- Do NOT ask which life area to focus on — the domain is already "${ctx.domain_label || ctx.active_domain}".
- Do NOT run the 25-Question Deep Intake Engine or generic life-direction Q1.
- Do not produce a full diagnostic report in chat; intake only.
- Target ~12 focused questions before completion.`;
};

/**
 * First assistant message for Map Resistance (domain already chosen).
 */
const getStage1MapResistanceWelcomeMessage = (userName, goalContext = {}) => {
  const displayName =
    typeof userName === "string" && userName.trim().length
      ? userName.trim()
      : "there";
  const label = goalContext.domain_label || goalContext.active_domain || "this domain";
  const goal = goalContext.specific_goal || goalContext.goal_name || "your goal";
  const outcome =
    goalContext.measurable_outcome || "your 90-day outcome";

  return [
    `Hi ${displayName}, we're mapping the resistance structure for your **${label}** goal — not a generic life diagnostic.`,
    "",
    `**Your goal:** ${goal}`,
    `**90-day outcome:** ${outcome}`,
    "",
    "About 12 focused questions (not 25) — your goal and milestones are already set, so we isolate resistance around this outcome only.",
    "",
    "One question at a time. Every question stays anchored to this goal.",
    "",
    "**Q1 — Resistance when pursuing this goal**",
    `When you move toward "${goal}", what do you usually do instead, avoid, or tell yourself first that slows you down?`,
  ].join("\n");
};

/**
 * User prompt for ongoing map-resistance turns (goal-scoped, not 25Q life intake).
 */
const buildMapResistanceIntakePrompt = async ({
  transcript = [],
  userName,
  resumeNotice,
  activeGoalContext = {},
  targetCount = 12,
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
      ? `The user's last message was unclear or gibberish ("${String(lastUserContent).slice(0, 80)}"). You MUST re-ask **Q${stayOnQ}** in simpler words with one short example. Do NOT advance to Q${stayOnQ + 1}. Do NOT count their last message as an answer.\n\n`
      : !aiAnswered && lastUserContent
        ? `The user's last message did not answer the question. Stay on **Q${stayOnQ}** and rephrase once.\n\n`
        : "";

  return `${resumeNotice ? `${resumeNotice}\n\n` : ""}You are conducting MAP RESISTANCE for domain "${label}" only.

ACTIVE_GOAL_CONTEXT:
${ctxBlock}

The user already selected this domain and saved their goal. Never ask them to pick money, relationship, health, purpose, or "everything first."

Goal: "${goal}"

Transcript so far:
${JSON.stringify(transcript, null, 2)}

${gibberishBlock}${lastAnsweredQ >= targetCount && aiAnswered ? `All ${targetCount} questions are done. Acknowledge completion briefly and tell them they can press "Complete mapping" — do not ask another intake question.` : `Ask exactly ONE next question labeled **Q${nextQ}** about resistance, avoidance, protector behaviour, fear, or cost tied to achieving "${goal}" in the ${label} domain.`}

Reply as the assistant only. One question at a time.`;
};

module.exports = {
  buildActiveGoalContext,
  buildMapResistanceIntroText,
  getStage1MapResistanceWelcomeMessage,
  buildMapResistanceIntakePrompt,
};
