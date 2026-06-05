/**
 * Stage 1 runtime suite — templates, fallbacks, and extract guardrails.
 * Product voice stays in admin: Coach Brain Prompt + Brain Prompt (+ optional stage1_* overlays).
 */

const { MAP_RESISTANCE_TARGET_QUESTIONS } = require("../constants/mapResistance");

const MAP_ADVANCE_FALLBACKS = [
  ["Resistance when pursuing this goal", "When you move toward your goal, what do you usually do instead, avoid, or tell yourself first that slows you down?"],
  ["Body and breath", "When you imagine taking the next visible step on your goal, what do you notice first in your body, breath, or energy?"],
  ["Protector voice", "What inner voice or story shows up to talk you out of moving on your goal?"],
  ["Fear if you act", "If you actually moved forward on your goal today, what are you afraid would happen?"],
  ["Cost to the goal", "How does your usual avoidance limit the measurable outcome you want from your goal?"],
  ["Past pattern", "When you tried something similar before, what happened — and what made you stop?"],
  ["Hidden rule", "What unspoken rule are you obeying that says you cannot fully go for your goal yet?"],
  ["Avoidance behaviours", "Name 2–3 specific things you do instead of the next step on your goal."],
  ["Identity risk", "Who would you have to become to complete your goal — and what feels unsafe about that?"],
  ["Visibility or judgement", "Do you avoid being seen, judged, wrong, or needy — which hits hardest and how?"],
  ["Smallest disobedience", "What is the smallest action on your goal that would disobey your usual avoidance?"],
  ["Proof in 7 days", "What proof would you accept from yourself in the next 7 days that you are serious about your goal?"],
  ["Recovery after action", "After you take a small step on your goal, what makes you collapse, overthink, or pull back?"],
  ["Resistance belief", "What do you believe about yourself when you avoid your goal — even if you never say it out loud?"],
  ["Shame hook", "What would feel shameful or exposing if someone saw you struggling with your goal?"],
  ["Permission structure", "What conditions do you wait for before you allow yourself to act on your goal (energy, mood, time, approval)?"],
  ["All-or-nothing", "Where does all-or-nothing thinking show up around your goal — and how does it justify stopping?"],
  ["Comparison trap", "Who do you compare yourself to around your goal, and how does that comparison become a reason to delay?"],
  ["Energy story", "What story do you tell yourself about your energy or capacity when your goal comes up?"],
  ["Commitment meaning", "What does fully committing to your goal mean you can no longer pretend or postpone?"],
  ["Self-trust", "When you think about past attempts at your goal, what breaks your trust in yourself — and how does that show up now?"],
  ["Withdrawal pattern", "After a good day on your goal, what pulls you back into old habits — reward, relief, or collapse?"],
  ["Success cost", "If you actually succeeded at your goal, what uncomfortable change would you have to live with?"],
  ["Integration", "What would need to shift in daily life so your goal feels normal rather than a battle every time?"],
];

const VORTEX_EXTRACT_RULES = `GOAL-SCOPED MAP RESISTANCE EXTRACTION (mandatory)

You extract structural resistance for ONE specific goal from the Map Resistance Q&A transcript — NOT a generic life map.

Use the Brain Prompt 48 vortex signature library to identify the primary signature for THIS outcome.
You MUST return all of:
- signature_id: code (e.g. "NE+S+R") OR full label ("Needs Not OK + Security + Rejection")
- EO, lack_channel, avoid_type: human-readable labels from the signature library
- orbit_pattern: optional orbit label if evident
- failure_strategy: { title, rule, behaviours[] } — what the old structure predictably does toward this goal
- top_3_avoidance_behaviours: exactly 3 specific sabotage behaviours (MUST match failure_strategy.behaviours)
- success_strategy: { title, behaviour, belief?, success_rule?, behaviours[] } — opposite structure from Brain Prompt for this signature
- daily_rep: { name, steps[], win_condition } — ONE green rep that interrupts failure strategy TODAY for this goal
- win_condition: observable proof (e.g. "Walk done. Not perfect. Done.")
- recovery_speed: "Slow" | "Moderate" | "Fast" — how quickly they collapse/pull back after action
- core_fear, perceived_risk, past_pattern, required_role: short strings from transcript themes when evident

Rules:
- Anchor every field to ACTIVE_GOAL_CONTEXT (domain, goal, outcome, milestones).
- daily_rep must come from the diagnosis — do NOT copy today_visible_action from goal onboarding unless it is clearly the green rep.
- success_strategy must be the structural opposite for this vortex, not a restatement of desired_outcome.
- Use null only when truly unknown — vortex fields are required.

Return ONLY valid JSON with these top-level keys:
{
  "signature_id": string,
  "EO": string,
  "lack_channel": string,
  "avoid_type": string,
  "orbit_pattern": string|null,
  "protector_rule": string|null,
  "failure_strategy": { "title": string, "rule": string, "behaviours": string[] },
  "top_3_avoidance_behaviours": string[],
  "success_strategy": { "title": string, "behaviour": string, "belief": string, "success_rule": string, "behaviours": string[] },
  "daily_rep": { "name": string, "steps": string[], "win_condition": string },
  "win_condition": string,
  "recovery_speed": "Slow"|"Moderate"|"Fast",
  "core_fear": string|null,
  "perceived_risk": string|null,
  "past_pattern": string|null,
  "required_role": string|null
}`;

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
- Target ~${MAP_RESISTANCE_TARGET_QUESTIONS} focused questions before completion.
- Match diagnostic intake style: always acknowledge the user's last message briefly, then ask the question (or re-ask if invalid).`;
};

const getStage1MapResistanceWelcomeMessage = (userName, goalContext = {}) => {
  const displayName =
    typeof userName === "string" && userName.trim().length ? userName.trim() : "there";
  const label = goalContext.domain_label || goalContext.active_domain || "this domain";
  const goal = goalContext.specific_goal || goalContext.goal_name || "your goal";
  const outcome = goalContext.measurable_outcome || "your 90-day outcome";

  return [
    `Hi ${displayName}, we're mapping the resistance structure for your **${label}** goal — not a generic life diagnostic.`,
    "",
    `**Your goal:** ${goal}`,
    `**90-day outcome:** ${outcome}`,
    "",
    `About ${MAP_RESISTANCE_TARGET_QUESTIONS} focused questions — your goal and milestones are already set, so we isolate resistance around this outcome only.`,
    "",
    "One question at a time. Every question stays anchored to this goal.",
    "",
    "**Q1 — Resistance when pursuing this goal**",
    `When you move toward "${goal}", what do you usually do instead, avoid, or tell yourself first that slows you down?`,
  ].join("\n");
};

module.exports = {
  MAP_ADVANCE_FALLBACKS,
  VORTEX_EXTRACT_RULES,
  buildMapResistanceIntroText,
  getStage1MapResistanceWelcomeMessage,
};
