const openai = require("../config/openai");
const { Prompt } = require("../models/promptModel");
const { withDbSlot } = require("../config/sequelize");
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
- Use null only when truly unknown — vortex fields are required.`;

const FALLBACK_GOAL_EXTRACT_PROMPT = `${VORTEX_EXTRACT_RULES}

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

const getPromptByType = async (type) =>
  withDbSlot(() =>
    Prompt.findOne({
      where: { type, isActive: true },
      order: [["createdAt", "DESC"]],
      raw: true,
    }),
  );

const buildExtractSystemPrompt = (prompts, mapPromptContent) => {
  const parts = [VORTEX_EXTRACT_RULES];
  if (mapPromptContent?.trim()) {
    parts.push(`--- MAP RESISTANCE EXTRACTION (admin) ---\n${mapPromptContent.trim()}`);
  } else {
    parts.push(FALLBACK_GOAL_EXTRACT_PROMPT);
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
  mapPromptContent,
}) => {
  const transcriptText = JSON.stringify(transcript, null, 2);
  const contextText = JSON.stringify(activeGoalContext, null, 2);
  const systemContent = buildExtractSystemPrompt(prompts, mapPromptContent);

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

  return finishStructure({
    ...parsed,
    ...packetToDomainStructure({ diagnostic_packet: parsed, constraint_packet: parsed }),
  });
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
  const mapPrompt = await getPromptByType("stage1_map_resistance");

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
        return finishStructure(merged, { transcript });
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
      reportText: `Goal-scoped Map Resistance for domain "${domain}". ${VORTEX_EXTRACT_RULES}\n\nACTIVE_GOAL_CONTEXT:\n${JSON.stringify(activeGoalContext, null, 2)}`,
      transcript,
    });
    tryMerge(packetToDomainStructure(packet));
    if (structureHasMinimalContent(merged, { transcript })) {
      return finishStructure(merged, { transcript });
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
        mapPromptContent: mapPrompt?.content,
      }),
    );
    if (structureHasMinimalContent(merged, { transcript })) {
      return finishStructure(merged, { transcript });
    }
  } catch (err) {
    console.warn("[stage1MapResistanceExtract] OpenAI extract failed:", err.message);
  }

  console.warn("[stage1MapResistanceExtract] Using heuristic transcript fallback (no vortex)");
  tryMerge(heuristicStructureFromTranscript(transcript));
  return finishStructure(merged, { transcript });
};

module.exports = {
  extractGoalStructureFromTranscript,
  packetToDomainStructure,
  structureHasVortexSignature,
};
