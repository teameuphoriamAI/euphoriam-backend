const openai = require("../config/openai");
const { Prompt } = require("../models/promptModel");
const { withDbSlot } = require("../config/sequelize");

// ── Prompt cache (5-minute TTL, same pattern as euphoriamChatbot.js) ─────────

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

// ── Task 3.2 — inferStructureType() ─────────────────────────────────────────

/**
 * Deterministically maps the diagnostic fields to one of the 4 structure types
 * defined in the Euphoriam framework.
 *
 * Rules (applied in priority order):
 *  1. "Something's Wrong With Me"  — self-blame dominant + high contradiction or CL < 1.5
 *  2. "Towards & Away"             — oscillation patterns (attach→ / ask→ / announce→ + withdraw)
 *  3. "Progress with Snapback"     — real movement then collapse patterns
 *  4. "Orbit"                      — default (repeated circling)
 */
const inferStructureType = ({
  orbit_pattern = "",
  recovery_speed = "",
  contradiction_rate = "",
  current_loop = "",
  CL_estimate = null,
} = {}) => {
  const op = (orbit_pattern || "").toLowerCase();
  const cl = (current_loop || "").toLowerCase();
  const combined = `${op} ${cl}`;

  // Rule 1: Something's Wrong With Me
  // Triggered when self-blame language is dominant AND either contradiction is high
  // OR CL estimate is very low (below 1.5 — identity-level shame)
  const selfBlameKeywords = [
    "wrong with me",
    "broken",
    "shame",
    "self-blame",
    "self blame",
    "worthless",
    "not enough",
    "never enough",
    "failure",
    "defective",
    "fault",
    "my fault",
    "blame myself",
  ];
  const hasSelfBlame = selfBlameKeywords.some((kw) => combined.includes(kw));
  const clNum = typeof CL_estimate === "number" ? CL_estimate : parseFloat(CL_estimate);
  const isVeryLowCL = !isNaN(clNum) && clNum < 1.5;
  const isHighContradiction = contradiction_rate === "high";

  if (hasSelfBlame && (isHighContradiction || isVeryLowCL)) {
    return "Something's Wrong With Me";
  }

  // Rule 2: Towards & Away
  // Visible oscillation between movement and retreat
  const towardsAwayPatterns = [
    /attach.*withdraw/,
    /test.*withdraw/,
    /ask.*withdraw/,
    /announce.*withdraw/,
    /reach.*pull.?back/,
    /open.*close/,
    /connect.*retreat/,
    /approach.*retreat/,
    /move.*toward.*pull.?back/,
    /engage.*disengage/,
    /start.*stop.*start/,
    /commit.*bail/,
    /invest.*pull.?out/,
  ];
  if (towardsAwayPatterns.some((re) => re.test(op))) {
    return "Towards & Away";
  }

  // Rule 3: Progress with Snapback
  // Real movement exists but collapses when it gets real
  const snapbackPatterns = [
    /progress.*collapse/,
    /prove.*crash/,
    /overwork.*crash/,
    /freeze.*scramble.*crash/,
    /build.*collapse/,
    /grow.*crash/,
    /advance.*crash/,
    /momentum.*crash/,
    /win.*lose.*win.*lose/,
    /succeed.*sabotage/,
    /almost.*then.*back/,
    /close.*then.*retreat/,
    /nearly.*then.*collapse/,
    /push.*then.*crash/,
    /move.*then.*snap.?back/,
    /rise.*fall/,
    /up.*down.*up.*down/,
  ];
  if (snapbackPatterns.some((re) => re.test(op))) {
    return "Progress with Snapback";
  }

  // Default: Orbit (repeated circling, same ceiling, same loop)
  return "Orbit";
};

// ── Task 3.3 — buildExtractionContent() ──────────────────────────────────────

/**
 * Assembles the user-facing content block sent to GPT for extraction.
 * Includes:
 *  - The Stage 1 diagnostic report text
 *  - The last 10 transcript messages (most informationally dense portion)
 *  - Any existing metrics already computed
 */
const buildExtractionContent = ({ reportText, transcript = [], existingMetrics = {} }) => {
  const parts = [];

  if (reportText) {
    parts.push("=== STAGE 1 DIAGNOSTIC REPORT ===");
    parts.push(reportText.trim());
    parts.push("");
  }

  // Last 10 transcript messages — captures the richest Q&A detail without
  // overwhelming the context window
  const recentTranscript = Array.isArray(transcript) ? transcript.slice(-10) : [];
  if (recentTranscript.length > 0) {
    parts.push("=== RECENT CONVERSATION TRANSCRIPT (last 10 messages) ===");
    recentTranscript.forEach((msg) => {
      const role = (msg.role || "unknown").toUpperCase();
      const content = (msg.content || "").trim();
      parts.push(`${role}: ${content}`);
    });
    parts.push("");
  }

  const metricsKeys = Object.keys(existingMetrics || {});
  if (metricsKeys.length > 0) {
    parts.push("=== EXISTING COMPUTED METRICS ===");
    parts.push(JSON.stringify(existingMetrics, null, 2));
    parts.push("");
  }

  parts.push("Extract and return only the JSON object as specified in the system prompt.");

  return parts.join("\n");
};

// ── Task 3.3 — extractStructuredPacket() ─────────────────────────────────────

/**
 * Runs Stage 1 structured output extraction:
 *  1. Loads the extraction prompt from DB
 *  2. Calls GPT-4o with JSON mode
 *  3. Parses the returned JSON
 *  4. Merges in the inferred structure_type
 *  5. Returns the fully populated packet
 *
 * Gracefully handles missing/partial fields — always returns a valid object.
 *
 * @param {object} params
 * @param {string} params.reportText       - Stage 1 report text from the diagnostic engine
 * @param {Array}  params.transcript       - Full Q&A transcript array
 * @param {object} [params.existingMetrics] - Pre-computed metrics (optional)
 * @returns {Promise<{ diagnostic_packet, constraint_packet, optional_inputs }>}
 */
const extractStructuredPacket = async ({
  reportText,
  transcript = [],
  existingMetrics = {},
}) => {
  // 1. Load extraction prompt from DB
  const extractionPrompt = await getPromptByType("stage1_constraint_extraction");

  if (!extractionPrompt?.content) {
    console.warn("[extractor] stage1_constraint_extraction prompt not found in DB — using fallback");
  }

  const systemContent = extractionPrompt?.content || FALLBACK_EXTRACTION_PROMPT;

  // 2. Build the user content block
  const userContent = buildExtractionContent({ reportText, transcript, existingMetrics });

  // 3. Call GPT-4o with JSON mode (guarantees valid JSON output)
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
    max_completion_tokens: 2000,
  });

  const rawContent = response?.choices?.[0]?.message?.content || "{}";

  // 4. Parse JSON — robust to unexpected shapes
  let packet;
  try {
    packet = JSON.parse(rawContent);
  } catch (parseErr) {
    console.error("[extractor] JSON parse failed:", parseErr.message, "\nRaw:", rawContent.slice(0, 300));
    packet = {};
  }

  // 5. Normalise structure — ensure all top-level keys exist even if GPT omitted them
  packet.diagnostic_packet = packet.diagnostic_packet || {};
  packet.constraint_packet = packet.constraint_packet || {};
  packet.optional_inputs = packet.optional_inputs || {};

  // Ensure array fields are always arrays
  const dp = packet.diagnostic_packet;
  if (!Array.isArray(dp.protector_profile?.typical_behaviours)) {
    dp.protector_profile = { ...(dp.protector_profile || {}), typical_behaviours: [] };
  }
  if (dp.daily_rep_assigned && !Array.isArray(dp.daily_rep_assigned.steps)) {
    dp.daily_rep_assigned.steps = [];
  }
  if (!Array.isArray(packet.optional_inputs.main_avoidance_behaviours)) {
    packet.optional_inputs.main_avoidance_behaviours = [];
  }

  // 6. Infer structure_type deterministically (never rely on GPT for this)
  packet.diagnostic_packet.structure_type = inferStructureType({
    orbit_pattern: dp.orbit_pattern,
    recovery_speed: dp.recovery_speed,
    contradiction_rate: dp.contradiction_rate,
    current_loop: dp.current_loop,
    CL_estimate: dp.CL_estimate,
  });

  return packet;
};

// ── Minimal fallback prompt (used if DB prompt is missing) ────────────────────

const FALLBACK_EXTRACTION_PROMPT = `Extract the Euphoriam diagnostic data from the provided report and transcript. Return ONLY a valid JSON object with keys: diagnostic_packet, constraint_packet, optional_inputs. For any field you cannot find, use null. Return no markdown, no explanation — only the JSON object.`;

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  extractStructuredPacket,
  inferStructureType,
};
