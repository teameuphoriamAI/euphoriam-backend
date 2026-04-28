const openai = require("../config/openai");
const { Prompt } = require("../models/promptModel");
const { withDbSlot } = require("../config/sequelize");

// ── v2.2 length / completion (Phase B) ───────────────────────────────────────

/** Minimum words before accept (or one retry expand); v2.2 target band ~1000–1600. */
const IRL_MIN_WORD_COUNT = 1000;
/** Room for ~1600 words of prose without mid-section truncation. */
const IRL_MAX_COMPLETION_TOKENS = 4000;

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

/** Clears cached prompt row(s) for `type` (Phase A.4: use after DB prompt swap without full restart). */
const invalidatePromptCache = (type = "invisible_red_line_report") => {
  _cache.delete(type);
};

// ── Phase B.4 — normalise Stage 2 inputs (defaults for missing Stage 1 keys) ──

const DEFAULT_PROTECTOR_PROFILE = Object.freeze({
  what_it_prevents: null,
  typical_behaviours: [],
});

const DEFAULT_DAILY_REP = Object.freeze({
  name: null,
  steps: null,
  win_condition: null,
});

const DEFAULT_DIAGNOSTIC_FLAT = Object.freeze({
  domain_primary: null,
  desired_outcome: null,
  current_loop: null,
  orbit_pattern: null,
  EO: null,
  lack_channel: null,
  protector_type: null,
  gravity_depth: null,
  CL_estimate: null,
  CL_confidence: null,
  rule_engine: null,
  behaviour_evidence: null,
  recovery_speed: null,
  contradiction_rate: null,
  signature_confidence: null,
  signature_primary_id: null,
  signature_secondary_id: null,
  predictions: null,
  falsifiers: null,
  confirmation_test: null,
  recommended_resource: null,
  data_needed_next: null,
  structure_type: null,
});

const DEFAULT_CONSTRAINT_PACKET = Object.freeze({
  name: null,
  protector_rule: null,
  red_barrier_sentence: null,
  how_it_caps_output: null,
  good_intent: null,
  bad_cost: null,
  confidence: null,
  alt_hypothesis: null,
});

const DEFAULT_OPTIONAL_INPUTS = Object.freeze({
  top_trigger_example: null,
  recent_trigger_example: null,
  abduction_sentence: null,
  family_rule_summary: null,
  main_avoidance_behaviours: null,
  main_cost_domain: null,
  personalised_offer_price: null,
  personalised_offer_name: null,
});

/**
 * Merges v2.2 envelope defaults onto Stage 1 extraction so `buildIrlInputContent` always
 * sees a full key set (missing → null / empty array where appropriate).
 */
const normalizeStage2PacketInputs = ({
  diagnostic_packet: dpIn,
  constraint_packet: cpIn,
  optional_inputs: oiIn,
}) => {
  const rawDp = dpIn && typeof dpIn === "object" ? { ...dpIn } : {};
  const { protector_profile: ppRaw, daily_rep_assigned: drRaw, ...flatDp } = rawDp;

  const dp = { ...DEFAULT_DIAGNOSTIC_FLAT, ...flatDp };
  dp.protector_profile = {
    ...DEFAULT_PROTECTOR_PROFILE,
    ...(ppRaw && typeof ppRaw === "object" ? ppRaw : {}),
  };
  if (!Array.isArray(dp.protector_profile.typical_behaviours)) {
    dp.protector_profile.typical_behaviours = [];
  }

  dp.daily_rep_assigned = {
    ...DEFAULT_DAILY_REP,
    ...(drRaw && typeof drRaw === "object" ? drRaw : {}),
  };
  if (dp.daily_rep_assigned.steps != null && !Array.isArray(dp.daily_rep_assigned.steps)) {
    dp.daily_rep_assigned.steps = [];
  }

  const cp = {
    ...DEFAULT_CONSTRAINT_PACKET,
    ...(cpIn && typeof cpIn === "object" ? cpIn : {}),
  };

  const oi = {
    ...DEFAULT_OPTIONAL_INPUTS,
    ...(oiIn && typeof oiIn === "object" ? oiIn : {}),
  };
  if (!Array.isArray(oi.main_avoidance_behaviours)) {
    if (oi.main_avoidance_behaviours == null || oi.main_avoidance_behaviours === "") {
      oi.main_avoidance_behaviours = [];
    } else {
      oi.main_avoidance_behaviours = [String(oi.main_avoidance_behaviours)];
    }
  }

  return { diagnostic_packet: dp, constraint_packet: cp, optional_inputs: oi };
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

  // Diagnostic packet — individual labelled fields for maximum readability (v2.2 envelope)
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
  lines.push(`  falsifiers: ${safe(diagnostic_packet.falsifiers)}`);
  lines.push(`  confirmation_test: ${safe(diagnostic_packet.confirmation_test)}`);

  const rep = diagnostic_packet.daily_rep_assigned || {};
  lines.push(`  daily_rep_assigned.name: ${safe(rep.name)}`);
  lines.push(`  daily_rep_assigned.steps: ${safe(rep.steps)}`);
  lines.push(`  daily_rep_assigned.win_condition: ${safe(rep.win_condition)}`);
  lines.push(`  recommended_resource: ${safe(diagnostic_packet.recommended_resource)}`);
  lines.push(`  data_needed_next: ${safe(diagnostic_packet.data_needed_next)}`);
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
  lines.push(`  cta_text: ${safe(offer_config.cta_text || "Upgrade for Full Access")}`);
  lines.push("");

  lines.push("=== INPUTS END ===");
  lines.push("");
  lines.push(
    "Generate the Invisible Red Line Report now, following all section rules and voice guidelines from the system prompt."
  );
  lines.push("IMPORTANT: Do not include any internal marker token like '888' anywhere in the final report.");

  return lines.join("\n");
};

const countWords = (text) => String(text || "").trim().split(/\s+/).filter(Boolean).length;

const stripInternalIrlMarkers = (text) =>
  String(text || "")
    .replace(/^\s*888(?:\b|[.:_-])\s*/gim, "")
    .replace(/\b888\b/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Phase F.4 — structured one-line JSON for log drains / alerts (grep `[IRL_QA]`). */
const irlQaMetric = (code, extra = {}) => {
  console.error("[IRL_QA]", JSON.stringify({ event: code, t: new Date().toISOString(), ...extra }));
};

// ── Task 4.1 — generateInvisibleRedLineReport() ───────────────────────────────

/**
 * Stage 2 of the funnel pipeline — generates the Invisible Red Line Report.
 *
 * Takes a fully structured packet (from Stage 1 extraction) and produces a
 * ~1000–1600 word personalised conversion report in 19 sections (v2.2).
 *
 * @param {object} params
 * @param {object} params.user               - { first_name, timezone }
 * @param {object} params.diagnostic_packet  - Structured fields from Stage 1
 * @param {object} params.constraint_packet  - Constraint identification from Stage 1
 * @param {object} [params.optional_inputs]  - Additional context fields (may be partial)
 * @param {object} [params.access_flags]     - User membership flags
 * @param {object} [params.offer_config]     - UC offer presentation config
 * @returns {Promise<{ reportText: string, wordCount: number, irlRetryUsed: boolean }>}
 */
const generateInvisibleRedLineReport = async ({
  user = {},
  diagnostic_packet = {},
  constraint_packet = {},
  optional_inputs = {},
  access_flags = {},
  offer_config = {},
}) => {
  const normalized = normalizeStage2PacketInputs({
    diagnostic_packet,
    constraint_packet,
    optional_inputs,
  });

  // Always load the latest active prompt from DB (5m cache would otherwise hide prompt edits until restart/TTL).
  invalidatePromptCache("invisible_red_line_report");

  // 1. Load IRL report prompt from DB
  const systemPrompt = await getPromptByType("invisible_red_line_report");

  if (!systemPrompt?.content) {
    irlQaMetric("PROMPT_MISSING", { type: "invisible_red_line_report" });
    throw new Error("invisible_red_line_report prompt not found in DB. Run initDb() to seed it.");
  }

  // 2. Assemble the structured user-turn message
  const userContent = buildIrlInputContent({
    user,
    diagnostic_packet: normalized.diagnostic_packet,
    constraint_packet: normalized.constraint_packet,
    optional_inputs: normalized.optional_inputs,
    access_flags,
    offer_config,
  });

  const systemMessage = { role: "system", content: systemPrompt.content };
  const antiMarkerSystemMessage = {
    role: "system",
    content:
      "Internal marker tokens (such as '888') are not user-facing content. Never output '888' in any line of the final report.",
  };
  const userMessage = { role: "user", content: userContent };

  // 3. Call GPT-4o — quality matters, not speed
  let response;
  try {
    response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [systemMessage, antiMarkerSystemMessage, userMessage],
      temperature: 0.4,
      max_completion_tokens: IRL_MAX_COMPLETION_TOKENS,
    });
  } catch (err) {
    irlQaMetric("openai_chat_failed", {
      phase: "primary",
      message: err?.message || String(err),
      status: err?.status,
    });
    throw err;
  }

  let reportText = stripInternalIrlMarkers(response?.choices?.[0]?.message?.content || "");

  if (!reportText) {
    irlQaMetric("EMPTY_OUTPUT", { phase: "primary" });
    throw new Error("IRL Report generation returned empty content");
  }

  let wordCount = countWords(reportText);
  let irlRetryUsed = false;

  // Phase B.5 — one expand retry if below v2.2 floor
  if (wordCount < IRL_MIN_WORD_COUNT) {
    irlRetryUsed = true;
    console.warn("[IRL] short_output_retry", {
      firstWordCount: wordCount,
      min: IRL_MIN_WORD_COUNT,
    });

    const retryUser =
      "The previous draft was too short for publication.\n\n" +
      `It was only about ${wordCount} words; the minimum is ${IRL_MIN_WORD_COUNT} words.\n\n` +
      "Regenerate the **complete** Invisible Red Line Report from the same inputs above: keep all 19 numbered sections, preserve personalization depth, and deepen thin sections with concrete behaviour and consequence language until the total clearly meets the minimum. " +
      "Do not include any internal marker token like '888' anywhere in the report. " +
      "Do not reply with meta-commentary — output only the finished report.";

    let response2;
    try {
      response2 = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          systemMessage,
          antiMarkerSystemMessage,
          userMessage,
          { role: "assistant", content: reportText },
          { role: "user", content: retryUser },
        ],
        temperature: 0.4,
        max_completion_tokens: IRL_MAX_COMPLETION_TOKENS,
      });
    } catch (err) {
      irlQaMetric("openai_chat_failed", {
        phase: "retry",
        message: err?.message || String(err),
        status: err?.status,
      });
      throw err;
    }

    reportText = stripInternalIrlMarkers(response2?.choices?.[0]?.message?.content || "");
    if (!reportText) {
      irlQaMetric("EMPTY_OUTPUT", { phase: "retry" });
      throw new Error("IRL Report retry generation returned empty content");
    }
    wordCount = countWords(reportText);
    console.warn("[IRL] short_output_retry_result", {
      finalWordCount: wordCount,
      stillBelowMin: wordCount < IRL_MIN_WORD_COUNT,
    });
  }

  if (wordCount < IRL_MIN_WORD_COUNT) {
    irlQaMetric("TOO_SHORT", {
      wordCount,
      irlRetryUsed,
      min: IRL_MIN_WORD_COUNT,
    });
    throw new Error(
      `IRL Report too short: ${wordCount} words (minimum ${IRL_MIN_WORD_COUNT} after optional expand retry)`
    );
  }

  return { reportText, wordCount, irlRetryUsed };
};

module.exports = {
  generateInvisibleRedLineReport,
  buildIrlInputContent,
  invalidatePromptCache,
  normalizeStage2PacketInputs,
  IRL_MIN_WORD_COUNT,
  IRL_MAX_COMPLETION_TOKENS,
};
