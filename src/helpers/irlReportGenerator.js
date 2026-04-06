const openai = require("../config/openai");
const { Prompt } = require("../models/promptModel");
const { withDbSlot } = require("../config/sequelize");

// ── Prompt cache (5-minute TTL) ───────────────────────────────────────────────

const _cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

const getPromptByType = async (type) => {
  const now = Date.now();
  const cached = _cache.get(type);
  if (cached && cached.expiresAt > now) return cached.data;

  const prompt = await withDbSlot(() =>
    Prompt.findOne({
      where: { type, isActive: true },
      order: [["createdAt", "DESC"]],
      raw: true,
    })
  );

  _cache.set(type, { data: prompt || null, expiresAt: now + CACHE_TTL_MS });
  return prompt || null;
};

// ── Task 4.2 — buildIrlInputContent() ────────────────────────────────────────

/**
 * Formats the full structured input object into a readable user-turn message
 * for the Stage 2 IRL report prompt.
 *
 * Rules:
 *  - Wrap in clear INPUTS START / INPUTS END delimiters
 *  - Label every key-value pair (no raw JSON blobs)
 *  - Replace null/undefined with "not available"
 *  - Include offer_config last so the model knows what commercial sections to include
 */
const buildIrlInputContent = ({
  user = {},
  diagnostic_packet = {},
  constraint_packet = {},
  optional_inputs = {},
  access_flags = {},
  offer_config = {},
}) => {
  const safe = (val) => {
    if (val === null || val === undefined || val === "") return "not available";
    if (Array.isArray(val)) return val.length ? val.join(", ") : "not available";
    if (typeof val === "object") return JSON.stringify(val);
    return String(val);
  };

  const lines = [];

  lines.push("=== INPUTS START ===");
  lines.push("");

  // User context
  lines.push("USER:");
  lines.push(`  first_name: ${safe(user.first_name || user.name?.split(" ")[0])}`);
  lines.push(`  timezone: ${safe(user.timezone)}`);
  lines.push("");

  // Diagnostic packet — individual labelled fields for maximum readability
  lines.push("DIAGNOSTIC PACKET:");
  lines.push(`  domain_primary: ${safe(diagnostic_packet.domain_primary)}`);
  lines.push(`  desired_outcome: ${safe(diagnostic_packet.desired_outcome)}`);
  lines.push(`  current_loop: ${safe(diagnostic_packet.current_loop)}`);
  lines.push(`  orbit_pattern: ${safe(diagnostic_packet.orbit_pattern)}`);
  lines.push(`  EO: ${safe(diagnostic_packet.EO)}`);
  lines.push(`  lack_channel: ${safe(diagnostic_packet.lack_channel)}`);
  lines.push(`  protector_type: ${safe(diagnostic_packet.protector_type)}`);
  lines.push(`  gravity_depth: ${safe(diagnostic_packet.gravity_depth)}`);
  lines.push(`  CL_estimate: ${safe(diagnostic_packet.CL_estimate)}`);
  lines.push(`  CL_confidence: ${safe(diagnostic_packet.CL_confidence)}`);
  lines.push(`  structure_type: ${safe(diagnostic_packet.structure_type)}`);

  const pp = diagnostic_packet.protector_profile || {};
  lines.push(`  protector_profile.what_it_prevents: ${safe(pp.what_it_prevents)}`);
  lines.push(`  protector_profile.typical_behaviours: ${safe(pp.typical_behaviours)}`);

  lines.push(`  rule_engine: ${safe(diagnostic_packet.rule_engine)}`);
  lines.push(`  behaviour_evidence: ${safe(diagnostic_packet.behaviour_evidence)}`);
  lines.push(`  recovery_speed: ${safe(diagnostic_packet.recovery_speed)}`);
  lines.push(`  contradiction_rate: ${safe(diagnostic_packet.contradiction_rate)}`);
  lines.push(`  signature_confidence: ${safe(diagnostic_packet.signature_confidence)}`);
  lines.push(`  signature_primary_id: ${safe(diagnostic_packet.signature_primary_id)}`);
  lines.push(`  signature_secondary_id: ${safe(diagnostic_packet.signature_secondary_id)}`);
  lines.push(`  predictions: ${safe(diagnostic_packet.predictions)}`);

  const rep = diagnostic_packet.daily_rep_assigned || {};
  lines.push(`  daily_rep_assigned.name: ${safe(rep.name)}`);
  lines.push(`  daily_rep_assigned.steps: ${safe(rep.steps)}`);
  lines.push(`  daily_rep_assigned.win_condition: ${safe(rep.win_condition)}`);
  lines.push(`  recommended_resource: ${safe(diagnostic_packet.recommended_resource)}`);
  lines.push("");

  // Constraint packet
  lines.push("CONSTRAINT PACKET:");
  lines.push(`  name: ${safe(constraint_packet.name)}`);
  lines.push(`  protector_rule: ${safe(constraint_packet.protector_rule)}`);
  lines.push(`  red_barrier_sentence: ${safe(constraint_packet.red_barrier_sentence)}`);
  lines.push(`  how_it_caps_output: ${safe(constraint_packet.how_it_caps_output)}`);
  lines.push(`  good_intent: ${safe(constraint_packet.good_intent)}`);
  lines.push(`  bad_cost: ${safe(constraint_packet.bad_cost)}`);
  lines.push(`  confidence: ${safe(constraint_packet.confidence)}`);
  lines.push(`  alt_hypothesis: ${safe(constraint_packet.alt_hypothesis)}`);
  lines.push("");

  // Optional inputs (populate when available, gracefully skip when null)
  lines.push("OPTIONAL INPUTS:");
  lines.push(`  top_trigger_example: ${safe(optional_inputs.top_trigger_example)}`);
  lines.push(`  recent_trigger_example: ${safe(optional_inputs.recent_trigger_example)}`);
  lines.push(`  abduction_sentence: ${safe(optional_inputs.abduction_sentence)}`);
  lines.push(`  main_avoidance_behaviours: ${safe(optional_inputs.main_avoidance_behaviours)}`);
  lines.push(`  main_cost_domain: ${safe(optional_inputs.main_cost_domain)}`);
  lines.push(`  personalised_offer_price: ${safe(optional_inputs.personalised_offer_price)}`);
  lines.push(`  personalised_offer_name: ${safe(optional_inputs.personalised_offer_name)}`);
  lines.push(`  family_rule_summary: ${safe(optional_inputs.family_rule_summary)}`);
  lines.push("");

  // Access flags
  lines.push("ACCESS FLAGS:");
  lines.push(`  UC: ${safe(access_flags.UC)}`);
  lines.push(`  CreatorClub: ${safe(access_flags.CreatorClub)}`);
  lines.push(`  ChangingRealities: ${safe(access_flags.ChangingRealities)}`);
  lines.push(`  LiveCalls: ${safe(access_flags.LiveCalls)}`);
  lines.push(`  Mastery: ${safe(access_flags.Mastery)}`);
  lines.push("");

  // Offer config — controls Section 12 and CTA button
  lines.push("OFFER CONFIG:");
  lines.push(`  uc_offer_name: ${safe(offer_config.uc_offer_name || "Unlimited Creator")}`);
  lines.push(`  uc_offer_price_string: ${safe(offer_config.uc_offer_price_string)}`);
  lines.push(`  include_price_compare: ${safe(offer_config.include_price_compare)}`);
  lines.push(`  include_button_cta: ${safe(offer_config.include_button_cta)}`);
  lines.push(`  cta_text: ${safe(offer_config.cta_text || "Start Unlimited Creator")}`);
  lines.push("");

  lines.push("=== INPUTS END ===");
  lines.push("");
  lines.push("Generate the Invisible Red Line Report now, following all section rules and voice guidelines from the system prompt.");

  return lines.join("\n");
};

// ── Task 4.1 — generateInvisibleRedLineReport() ───────────────────────────────

/**
 * Stage 2 of the funnel pipeline — generates the Invisible Red Line Report.
 *
 * Takes a fully structured packet (from Stage 1 extraction) and produces a
 * 900–1500 word personalised conversion report in 19 sections with 888 markers.
 *
 * @param {object} params
 * @param {object} params.user               - { first_name, timezone }
 * @param {object} params.diagnostic_packet  - Structured fields from Stage 1
 * @param {object} params.constraint_packet  - Constraint identification from Stage 1
 * @param {object} [params.optional_inputs]  - Additional context fields (may be partial)
 * @param {object} [params.access_flags]     - User membership flags
 * @param {object} [params.offer_config]     - UC offer presentation config
 * @returns {Promise<{ reportText: string, wordCount: number }>}
 */
const generateInvisibleRedLineReport = async ({
  user = {},
  diagnostic_packet = {},
  constraint_packet = {},
  optional_inputs = {},
  access_flags = {},
  offer_config = {},
}) => {
  // 1. Load IRL report prompt from DB
  const systemPrompt = await getPromptByType("invisible_red_line_report");

  if (!systemPrompt?.content) {
    throw new Error("invisible_red_line_report prompt not found in DB. Run initDb() to seed it.");
  }

  // 2. Assemble the structured user-turn message
  const userContent = buildIrlInputContent({
    user,
    diagnostic_packet,
    constraint_packet,
    optional_inputs,
    access_flags,
    offer_config,
  });

  // 3. Call GPT-4o — quality matters, not speed
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemPrompt.content },
      { role: "user", content: userContent },
    ],
    temperature: 0.4,
    max_completion_tokens: 3000,
  });

  const reportText = (response?.choices?.[0]?.message?.content || "").trim();

  if (!reportText) {
    throw new Error("IRL Report generation returned empty content");
  }

  // 4. Validate minimum length (700 words enforced — soft floor, 900 target)
  const wordCount = reportText.split(/\s+/).filter(Boolean).length;
  if (wordCount < 700) {
    throw new Error(`IRL Report too short: ${wordCount} words (minimum 700)`);
  }

  return { reportText, wordCount };
};

module.exports = {
  generateInvisibleRedLineReport,
  buildIrlInputContent,
};
