const openai = require("../config/openai");
const { Prompt } = require("../models/promptModel");
const { withDbSlot } = require("../config/sequelize");
const { extractStructuredPacket } = require("./structuredPacketExtractor");
const { normalizeSuccessStrategy } = require("./stage1SuccessStrategy");
const {
  structureHasMinimalContent,
  heuristicStructureFromTranscript,
} = require("./stage1MapStructure");
const aiService = require("../clients/aiService");
const { loadMapResistancePromptBundle } = require("./stage1Prompts");

const FALLBACK_GOAL_EXTRACT_PROMPT = `You extract goal-scoped structural resistance data from a Map Resistance Q&A transcript.

Return ONLY valid JSON with these top-level keys matching domain storage:
{
  "signature_id": string|null,
  "EO": string|null,
  "lack_channel": string|null,
  "avoid_type": string|null,
  "orbit_pattern": string|null,
  "protector_rule": string|null,
  "failure_strategy": { "title": string, "rule": string, "behaviours": string[] }|null,
  "top_3_avoidance_behaviours": string[],
  "success_strategy": { "title": string, "behaviour": string, "behaviours": string[] }|null,
  "daily_rep": { "name": string, "steps": string[], "win_condition": string }|string|null,
  "win_condition": string|null
}

Anchor extraction to ACTIVE_GOAL_CONTEXT. Use null for missing fields.`;

const getPromptByType = async (type) =>
  withDbSlot(() =>
    Prompt.findOne({
      where: { type, isActive: true },
      order: [["createdAt", "DESC"]],
      raw: true,
    }),
  );

/**
 * Map funnel-style structured packet → Stage 1 domain_map structure fields.
 */
const packetToDomainStructure = (packet) => {
  const dp = packet?.diagnostic_packet || {};
  const cp = packet?.constraint_packet || {};
  const oi = packet?.optional_inputs || {};
  const rep = dp.daily_rep_assigned || {};
  const avoid = Array.isArray(oi.main_avoidance_behaviours)
    ? oi.main_avoidance_behaviours.slice(0, 3)
    : [];

  const failureRule = cp.protector_rule || dp.rule_engine || cp.red_barrier_sentence;
  const failureTitle = cp.name || "Failure strategy";

  return {
    signature_id: dp.signature_primary_id || dp.signature_id || null,
    EO: dp.EO || null,
    lack_channel: dp.lack_channel || null,
    avoid_type: dp.protector_type || null,
    orbit_pattern: dp.orbit_pattern || null,
    recovery_speed: dp.recovery_speed || cp.recovery_speed || null,
    protector_rule: failureRule || null,
    failure_strategy: failureRule
      ? {
          title: failureTitle,
          rule: failureRule,
          behaviours: avoid.length ? avoid : (dp.protector_profile?.typical_behaviours || []),
        }
      : null,
    top_3_avoidance_behaviours: avoid,
    success_strategy: normalizeSuccessStrategy({
      success_strategy: dp.success_strategy,
      opposite_behaviour: dp.opposite_behaviour || dp.opposite_behavior,
      opposite_belief: dp.opposite_belief,
      success_rule: dp.success_rule,
      recommended_resource: dp.recommended_resource,
    }),
    daily_rep: rep?.name
      ? { name: rep.name, steps: rep.steps || [], win_condition: rep.win_condition || null }
      : null,
    win_condition: rep?.win_condition || null,
    map_resistance_complete: true,
  };
};

/**
 * Extract goal-scoped structure from map resistance transcript + goal context.
 */
const finalizeStructureFromPython = async ({
  transcript = [],
  activeGoalContext = {},
  domain,
}) => {
  const prompts = await loadMapResistancePromptBundle();
  const data = await aiService.mapResistanceFinalize({
    transcript,
    active_goal_context: activeGoalContext,
    domain,
    prompts,
  });
  const merged = {
    ...(data.structure || data.domain_structure || {}),
    map_resistance_complete: true,
  };
  merged.success_strategy = normalizeSuccessStrategy(merged);
  const { enrichProgressMetricsFromMap } = require("./stage1ProgressMetrics");
  merged.progress_metrics = enrichProgressMetricsFromMap(merged, merged.progress_metrics);
  return merged;
};

const finishStructure = (structure) => {
  const merged = {
    ...(structure && typeof structure === "object" ? structure : {}),
    map_resistance_complete: true,
  };
  merged.success_strategy = normalizeSuccessStrategy(merged);
  const { enrichProgressMetricsFromMap } = require("./stage1ProgressMetrics");
  merged.progress_metrics = enrichProgressMetricsFromMap(merged, merged.progress_metrics);
  return merged;
};

const extractGoalStructureFromTranscript = async ({
  transcript = [],
  activeGoalContext = {},
  domain,
}) => {
  if (aiService.flags.mapResistance && aiService.isEnabled()) {
    try {
      const fromPython = await finalizeStructureFromPython({
        transcript,
        activeGoalContext,
        domain,
      });
      if (structureHasMinimalContent(fromPython)) {
        return fromPython;
      }
      console.warn(
        "[stage1MapResistanceExtract] Python finalize returned sparse structure; trying fallbacks",
      );
    } catch (err) {
      console.warn("[stage1MapResistanceExtract] Python finalize failed:", err.message);
    }
  }

  const transcriptText = JSON.stringify(transcript, null, 2);
  const contextText = JSON.stringify(activeGoalContext, null, 2);

  try {
    const packet = await extractStructuredPacket({
      reportText: `Goal-scoped Map Resistance for domain "${domain}". ACTIVE_GOAL_CONTEXT:\n${contextText}`,
      transcript,
    });
    const mapped = packetToDomainStructure(packet);
    if (structureHasMinimalContent(mapped)) {
      return finishStructure(mapped);
    }
  } catch (err) {
    console.warn("[stage1MapResistanceExtract] structuredPacket path failed:", err.message);
  }

  const mapPrompt = await getPromptByType("stage1_map_resistance");
  const systemContent = mapPrompt?.content || FALLBACK_GOAL_EXTRACT_PROMPT;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemContent },
        {
          role: "user",
          content: `ACTIVE_GOAL_CONTEXT:\n${contextText}\n\nTRANSCRIPT:\n${transcriptText}`,
        },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_completion_tokens: 2000,
    });

    const raw = response?.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }

    const merged = finishStructure({
      ...parsed,
      ...packetToDomainStructure({ diagnostic_packet: parsed, constraint_packet: parsed }),
    });
    if (structureHasMinimalContent(merged)) {
      return merged;
    }
  } catch (err) {
    console.warn("[stage1MapResistanceExtract] OpenAI extract failed:", err.message);
  }

  console.warn("[stage1MapResistanceExtract] Using heuristic structure from transcript");
  return finishStructure(
    heuristicStructureFromTranscript(transcript, activeGoalContext),
  );
};

module.exports = {
  extractGoalStructureFromTranscript,
  packetToDomainStructure,
};
