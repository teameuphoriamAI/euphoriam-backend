const openai = require("../config/openai");
const { extractStructuredPacket } = require("./structuredPacketExtractor");
const { normalizeSuccessStrategy } = require("./stage1SuccessStrategy");
const {
  structureHasMinimalContent,
  structureHasVortexSignature,
  mergeExtractedStructures,
  heuristicStructureFromTranscript,
  normalizeExtractedStructure,
} = require("./stage1MapStructure");
const aiService = require("../clients/aiService");
const { loadMapResistancePromptBundle } = require("./stage1Prompts");
const { VORTEX_EXTRACT_RULES } = require("./stage1PromptSuite");

const buildExtractSystemPrompt = (prompts) => {
  const parts = [VORTEX_EXTRACT_RULES];
  if (prompts?.stage1_map_resistance?.trim()) {
    parts.push(`--- MAP RESISTANCE (admin overlay) ---\n${prompts.stage1_map_resistance.trim()}`);
  }
  if (prompts?.brain_prompt?.trim()) {
    parts.push(
      `--- BRAIN PROMPT (48 vortex signatures — map EO, Lack, Avoid, opposites, reps) ---\n${prompts.brain_prompt.trim()}`,
    );
  }
  if (prompts?.coach_brain_prompt?.trim()) {
    parts.push(`--- COACH BRAIN PROMPT ---\n${prompts.coach_brain_prompt.trim()}`);
  }
  return parts.join("\n\n");
};

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
    avoid_type: dp.protector_type || dp.avoid_type || null,
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

const finalizeStructureFromPython = async ({
  transcript = [],
  activeGoalContext = {},
  domain,
  prompts,
}) => {
  const bundle = prompts || (await loadMapResistancePromptBundle());
  const data = await aiService.mapResistanceFinalize({
    transcript,
    active_goal_context: activeGoalContext,
    domain,
    prompts: bundle,
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

const finishStructure = (structure, options = {}) => {
  const merged = normalizeExtractedStructure(
    {
      ...(structure && typeof structure === "object" ? structure : {}),
      map_resistance_complete: true,
    },
    options,
  );
  merged.success_strategy = normalizeSuccessStrategy(merged);
  const { enrichProgressMetricsFromMap } = require("./stage1ProgressMetrics");
  merged.progress_metrics = enrichProgressMetricsFromMap(merged, merged.progress_metrics);
  return merged;
};

const extractViaOpenAI = async ({
  transcript,
  activeGoalContext,
  domain,
  prompts,
}) => {
  const transcriptText = JSON.stringify(transcript, null, 2);
  const contextText = JSON.stringify(activeGoalContext, null, 2);
  const systemContent = buildExtractSystemPrompt(prompts);

  const response = await openai.chat.completions.create({
    model: process.env.OPENAI_EXTRACTION_MODEL || "gpt-4o",
    messages: [
      { role: "system", content: systemContent },
      {
        role: "user",
        content: `Domain: ${domain}\n\nACTIVE_GOAL_CONTEXT:\n${contextText}\n\nMAP RESISTANCE TRANSCRIPT:\n${transcriptText}`,
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.1,
    max_completion_tokens: 4000,
  });

  const raw = response?.choices?.[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  return finishStructure(
    {
      ...parsed,
      ...packetToDomainStructure({ diagnostic_packet: parsed, constraint_packet: parsed }),
    },
    { transcript, activeGoalContext },
  );
};

/**
 * Extract goal-scoped structure from map resistance transcript + goal context.
 */
const extractGoalStructureFromTranscript = async ({
  transcript = [],
  activeGoalContext = {},
  domain,
}) => {
  const prompts = await loadMapResistancePromptBundle();
  let merged = {};
  const extractRules = VORTEX_EXTRACT_RULES;

  const tryMerge = (candidate) => {
    if (!candidate || typeof candidate !== "object") return;
    merged = mergeExtractedStructures(merged, candidate);
  };

  if (aiService.flags.mapResistance && aiService.isEnabled()) {
    try {
      tryMerge(
        await finalizeStructureFromPython({
          transcript,
          activeGoalContext,
          domain,
          prompts,
        }),
      );
      if (structureHasMinimalContent(merged, { transcript })) {
        return finishStructure(merged, { transcript, activeGoalContext });
      }
      console.warn(
        "[stage1MapResistanceExtract] Python finalize missing vortex; trying fallbacks",
        {
          hasVortex: structureHasVortexSignature(merged),
        },
      );
    } catch (err) {
      console.warn("[stage1MapResistanceExtract] Python finalize failed:", err.message);
    }
  }

  try {
    const packet = await extractStructuredPacket({
      reportText: `Goal-scoped Map Resistance for domain "${domain}". ${extractRules}\n\nACTIVE_GOAL_CONTEXT:\n${JSON.stringify(activeGoalContext, null, 2)}`,
      transcript,
    });
    tryMerge(packetToDomainStructure(packet));
    if (structureHasMinimalContent(merged, { transcript })) {
      return finishStructure(merged, { transcript, activeGoalContext });
    }
  } catch (err) {
    console.warn("[stage1MapResistanceExtract] structuredPacket path failed:", err.message);
  }

  try {
    tryMerge(
      await extractViaOpenAI({
        transcript,
        activeGoalContext,
        domain,
        prompts,
      }),
    );
    if (structureHasMinimalContent(merged, { transcript })) {
      return finishStructure(merged, { transcript, activeGoalContext });
    }
  } catch (err) {
    console.warn("[stage1MapResistanceExtract] OpenAI extract failed:", err.message);
  }

  console.warn("[stage1MapResistanceExtract] Using heuristic transcript fallback (no vortex)");
  tryMerge(heuristicStructureFromTranscript(transcript));
  return finishStructure(merged, { transcript, activeGoalContext });
};

module.exports = {
  extractGoalStructureFromTranscript,
  packetToDomainStructure,
  structureHasVortexSignature,
};
