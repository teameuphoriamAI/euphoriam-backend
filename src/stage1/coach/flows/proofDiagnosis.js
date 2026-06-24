/**
 * LLM proof ↔ diagnosis integration.
 * Compares user proof against the live structural diagnosis and advances the funnel
 * without repeating stale patterns or assigning backwards reps.
 */

const { resolveFailureStrategyForMap, resolveSuccessStrategyForMap } = require("../../../helpers/stage1MapStructure");
const { loadCoachingJourney } = require("../utils/evolution");
const { progressionFromProof, detectProofMilestone } = require("../signals/bottleneckProgression");

const FUNNEL_STAGES = [
  "no_prospect",
  "prospect_identified",
  "no_contact",
  "contact_initiated",
  "conversation_started",
  "proposal_sent",
  "client_closed",
];

const PROOF_DIAGNOSIS_REQUIRED = [
  "evidence_relationship",
  "diagnosis_still_primary",
  "should_investigate",
  "should_assign_rep",
  "coach_message",
];

function normalizeAnalysis(raw) {
  if (!raw || typeof raw !== "object") return null;
  for (const key of PROOF_DIAGNOSIS_REQUIRED) {
    if (raw[key] === undefined || raw[key] === null) return null;
  }
  if (!String(raw.coach_message || "").trim()) return null;
  return raw;
}

function pickCurrentDiagnosis(map, journey = null) {
  const failure =
    journey?.evolved_failure?.rule ||
    resolveFailureStrategyForMap(map)?.rule ||
    map?.protector_rule ||
    map?.failure_strategy?.rule ||
    null;
  const resistance =
    journey?.current_resistance ||
    openSessionResistance(map) ||
    null;
  return {
    failure_strategy: failure,
    protector_rule: map?.protector_rule || null,
    current_resistance: resistance,
    contradiction: map?.contradiction_statement || null,
  };
}

function openSessionResistance(map) {
  const sessions = map?.coaching_memory?.coaching_sessions || [];
  const last = sessions[sessions.length - 1];
  return last?.current_resistance || null;
}

function buildProofDiagnosisPrompt({
  userMessage,
  map,
  goalContext,
  journey,
  openSession,
  recentProofs = [],
}) {
  const diagnosis = pickCurrentDiagnosis(map, journey);
  const milestone =
    goalContext?.current_milestone ||
    goalContext?.milestones?.day_7 ||
    map?.milestones?.day_7 ||
    goalContext?.goal_name ||
    map?.goal_title ||
    "current milestone";
  const progressionStage =
    openSession?.structural_coaching_flow?.progression_stage ||
    journey?.progression_stage ||
    "no_prospect";
  const completedStages =
    openSession?.structural_coaching_flow?.funnel_stages_completed ||
    funnelStagesFromProgression(progressionStage);
  const lastRep = journey?.last_green_rep || null;
  const proofLines = (recentProofs || [])
    .slice(0, 5)
    .map((p) => `- ${p.action}`)
    .join("\n");

  return `You are the structural diagnosis engine for Euphoriam coaching.

CURRENT MAP DIAGNOSIS (baseline from Map Resistance — may be OUTDATED):
- Failure strategy: ${diagnosis.failure_strategy || "—"}
- Protector rule: ${diagnosis.protector_rule || "—"}
- Live resistance note: ${diagnosis.current_resistance || "—"}
- Contradiction: ${diagnosis.contradiction || "—"}

GOAL / MILESTONE: ${milestone}
FUNNEL STAGE NOW: ${progressionStage}
FUNNEL STAGES ALREADY COMPLETED (do NOT assign reps for these again):
${completedStages.map((s) => `- ${s}`).join("\n") || "- none yet"}
LAST GREEN REP ASSIGNED: ${lastRep || "none"}

RECENT PROOF LOG:
${proofLines || "—"}

USER MESSAGE (new proof or update):
"${String(userMessage || "").trim()}"

RULES:
1. Compare proof to diagnosis. Ask implicitly: does this evidence support or contradict the diagnosis?
2. If proof contradicts (e.g. diagnosis says "staying invisible" but user did outreach / identified client / had conversations), refined_diagnosis must DROP the old pattern as primary and name the NEW bottleneck.
3. Never send the user backwards in the funnel. If prospect identified + outreach done, do NOT assign "identify prospect" or "do outreach" again.
4. If proof is vague (e.g. "nobody was interested") set should_investigate=true, should_assign_rep=false, and ask ONE sharp question (how many, what offer, what message, what response).
5. next_green_rep must be ONE observable behavior for the NEXT funnel stage only — not an outcome (not "get a client", not "$/hr").
6. coach_message: warm, structural, excited when map gets more accurate. No failure-strategy lecture if contradicted. No repeating the old diagnosis.
7. Possible new bottlenecks: offer clarity, pricing, positioning, prospect quality, handling rejection, follow-up consistency, conversation depth, closing commitment.

Return JSON only.`;
}

function funnelStagesFromProgression(stage) {
  const order = FUNNEL_STAGES;
  const idx = order.indexOf(stage);
  if (idx < 0) return [];
  return order.slice(0, idx + 1);
}

function nextFunnelStage(stage) {
  const order = FUNNEL_STAGES;
  const idx = order.indexOf(stage);
  if (idx < 0 || idx >= order.length - 1) return stage;
  return order[idx + 1];
}

async function analyzeProofAgainstDiagnosis(ctx, { client } = {}) {
  const prompt = buildProofDiagnosisPrompt(ctx);
  const model = process.env.OPENAI_COACH_MODEL || "gpt-4o-mini";
  const llmClient = client || require("../../../config/openai");

  const response = await llmClient.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content:
          "You refine structural coaching diagnoses from proof. Return a single JSON object with keys: " +
          "evidence_relationship (supports|contradicts|partial|insufficient_detail), " +
          "diagnosis_still_primary (boolean), refined_diagnosis (string), removed_bottleneck (string), " +
          "new_bottleneck_label (string), new_bottleneck_type (string), funnel_stage_reached (string), " +
          "funnel_stages_completed (string array), should_investigate (boolean), investigation_question (string), " +
          "should_assign_rep (boolean), next_green_rep ({name, steps, win_condition} or null), " +
          "coach_message (string), do_not_repeat_diagnosis (boolean).",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    max_completion_tokens: 900,
    response_format: { type: "json_object" },
  });

  const raw = response?.choices?.[0]?.message?.content?.trim();
  if (!raw) return null;
  try {
    return normalizeAnalysis(JSON.parse(raw));
  } catch {
    return null;
  }
}

function buildWritebackFromAnalysis(analysis, { map, journey, userMessage }) {
  const hints = {
    coaching_insights: `Proof analysis: ${analysis.evidence_relationship}. ${
      analysis.refined_diagnosis || ""
    }`.trim(),
    progress_note: `Diagnosis update from proof: ${String(userMessage || "").slice(0, 160)}`,
    diagnosis_refined: analysis.evidence_relationship === "contradicts",
  };

  if (analysis.refined_diagnosis?.trim()) {
    hints.current_resistance = analysis.refined_diagnosis.trim();
    hints.session_summary = analysis.refined_diagnosis.trim().slice(0, 280);
  }

  if (analysis.removed_bottleneck) {
    hints.removed_bottleneck = analysis.removed_bottleneck;
  }

  if (analysis.new_bottleneck_label) {
    hints.active_bottleneck = {
      type: analysis.new_bottleneck_type || "strategy_gap",
      label: analysis.new_bottleneck_label,
      stage: analysis.funnel_stage_reached || null,
    };
  }

  if (analysis.evidence_relationship === "contradicts" && analysis.refined_diagnosis) {
    const successBase =
      journey?.evolved_success?.behaviour ||
      resolveSuccessStrategyForMap(map)?.behaviour ||
      null;
    hints.current_failure_strategy = {
      rule: `${analysis.refined_diagnosis} — prior map pattern weakened by proof`,
    };
    if (successBase) {
      hints.current_success_strategy = {
        behaviour: `${successBase} — evidenced by recent proof`,
      };
    }
  }

  if (analysis.funnel_stage_reached) {
    hints.progression_stage = analysis.funnel_stage_reached;
  }

  if (analysis.should_assign_rep) {
    hints.assign_new_green_rep = true;
  }

  return hints;
}

function buildFlowFromAnalysis(analysis, ctx) {
  const { map, journey, openSession, userMessage } = ctx;
  const { formatOutcomeDirective } = require("../signals/directive");
  const base = {
    skip_llm: false,
    assistant_override: null,
    green_rep: null,
    coaching_directive: null,
    coaching_context: {
      proof_diagnosis_analysis: {
        evidence_relationship: analysis.evidence_relationship,
        refined_diagnosis: analysis.refined_diagnosis,
        removed_bottleneck: analysis.removed_bottleneck,
        new_bottleneck_label: analysis.new_bottleneck_label,
        investigation_question: analysis.investigation_question,
        should_investigate: analysis.should_investigate,
        should_assign_rep: analysis.should_assign_rep,
        do_not_repeat_diagnosis: analysis.do_not_repeat_diagnosis,
      },
    },
    conversation_signals: {
      proof_diagnosis_update: true,
      evidence_contradicts_diagnosis: analysis.evidence_relationship === "contradicts",
    },
    writeback_hints: buildWritebackFromAnalysis(analysis, { map, journey, userMessage }),
    structural_coaching_flow: {
      ...(openSession?.structural_coaching_flow || {}),
      last_proof_analysis: analysis.evidence_relationship,
      diagnosis_refined: analysis.evidence_relationship === "contradicts",
      disruption_complete: true,
      last_proof_at: new Date().toISOString(),
    },
  };

  if (analysis.should_investigate) {
    return {
      ...base,
      green_rep: null,
      coaching_directive: formatOutcomeDirective("proof_investigation", {
        goal: "Gather sufficient proof detail before updating diagnosis or assigning rep.",
        yourJob: ["ask investigation question from coaching_context"],
        avoid: ["new rep assignment", "old diagnosis repeat"],
      }),
      structural_coaching_flow: {
        ...base.structural_coaching_flow,
        proof_investigation: {
          active: true,
          question: analysis.investigation_question,
          proof_context: String(userMessage || "").slice(0, 400),
        },
      },
      writeback_hints: {
        ...base.writeback_hints,
        assign_new_green_rep: false,
      },
    };
  }

  if (analysis.should_assign_rep && analysis.next_green_rep?.name) {
    const rep = {
      name: String(analysis.next_green_rep.name).trim(),
      steps: Array.isArray(analysis.next_green_rep.steps)
        ? analysis.next_green_rep.steps.map(String).filter(Boolean)
        : [],
      win_condition: String(analysis.next_green_rep.win_condition || "").trim(),
    };
    return {
      ...base,
      green_rep: rep,
      assign_green_rep: true,
      coaching_directive: formatOutcomeDirective("proof_progression", {
        goal: "Diagnosis updated from evidence — assign next funnel rep.",
        yourJob: [
          "acknowledge proof and map update",
          `assign green_rep: ${rep.name}`,
        ],
        avoid: ["prior diagnosis repeat", "backward funnel reps"],
      }),
      structural_coaching_flow: {
        ...base.structural_coaching_flow,
        progression_stage: analysis.funnel_stage_reached || base.structural_coaching_flow.progression_stage,
        removed_bottleneck: analysis.removed_bottleneck || null,
        current_bottleneck: analysis.new_bottleneck_label
          ? {
              type: analysis.new_bottleneck_type || "strategy_gap",
              label: analysis.new_bottleneck_label,
            }
          : openSession?.structural_coaching_flow?.current_bottleneck,
        funnel_stages_completed: analysis.funnel_stages_completed || [],
        proof_investigation: null,
      },
      writeback_hints: {
        ...base.writeback_hints,
        assign_new_green_rep: true,
      },
    };
  }

  return {
    ...base,
    coaching_directive: formatOutcomeDirective("proof_acknowledged", {
      goal: "Acknowledge evidence and speak to updated bottleneck only.",
      yourJob: ["note proof", "avoid old diagnosis if map updated"],
      avoid: analysis.do_not_repeat_diagnosis ? ["old diagnosis"] : [],
    }),
    writeback_hints: {
      ...base.writeback_hints,
      assign_new_green_rep: false,
    },
  };
}

function fallbackFlowFromRegex(ctx) {
  const { userMessage, map, goalContext, memoryCtx, openSession, proofCycleFlow } = ctx;
  const { resolveProofProgressionFlow } = require("../signals/bottleneckProgression");
  return resolveProofProgressionFlow({
    userMessage,
    proofSignals: ctx.proofSignals,
    map,
    goalContext,
    memoryCtx,
    openSession,
    proofCycleFlow,
  });
}

/**
 * Async proof progression — LLM diagnosis update with regex fallback.
 */
async function resolveProofProgressionFlowAsync(ctx, options = {}) {
  const base = {
    skip_llm: false,
    assistant_override: null,
    green_rep: null,
    coaching_directive: null,
    writeback_hints: null,
    structural_coaching_flow: null,
  };

  const { proofSignals, proofCycleFlow, userMessage, map, goalContext, memoryCtx, openSession, messages } =
    ctx;

  if (proofCycleFlow?.proof_integration_mode) return base;
  if (!map?.map_resistance_complete) return base;

  const { buildClarityExecutionSignals } = require("../signals/clarity");
  const claritySignals = buildClarityExecutionSignals(ctx);
  if (
    claritySignals?.stop_discovery ||
    claritySignals?.execution_sustainability_issue ||
    claritySignals?.self_generated_clarity ||
    claritySignals?.clarity_saturation ||
    claritySignals?.coaching_context?.insufficient_data_for_analysis
  ) {
    return base;
  }

  const { buildClarityExecutionFlow } = require("../signals/clarity");
  buildClarityExecutionFlow(ctx);

  const { buildEvidenceContradictionFlow } = require("../signals/evidence");
  buildEvidenceContradictionFlow(ctx);

  const { hasVisibilityAction } = require("../signals/evidence");
  const hasActionEvidence = hasVisibilityAction(userMessage);
  if (!proofSignals?.hasProof && !hasActionEvidence) return base;
  if (proofSignals?.isSetback && !hasActionEvidence) return base;

  const { resolveActivationMomentFlow } = require("../signals/activation");
  const activationFlow = resolveActivationMomentFlow(ctx);
  if (activationFlow.conversation_signals?.activation_moment_active && !hasActionEvidence) return base;

  const journey = loadCoachingJourney(memoryCtx, map, openSession);
  const recentProofs =
    memoryCtx?.recent_proofs ||
    memoryCtx?.proof_logs ||
    (map?.coaching_memory?.proof_logs || []);

  const priorInvestigation = openSession?.structural_coaching_flow?.proof_investigation;
  const messageForAnalysis = priorInvestigation?.active
    ? `Earlier proof: ${priorInvestigation.proof_context}\nFollow-up detail: ${userMessage}`
    : userMessage;

  try {
    const analysis = await analyzeProofAgainstDiagnosis(
      {
        userMessage: messageForAnalysis,
        map,
        goalContext,
        journey,
        openSession,
        recentProofs,
      },
      options,
    );

    if (analysis?.coach_message) {
      return buildFlowFromAnalysis(analysis, {
        ...ctx,
        journey,
      });
    }
  } catch (err) {
    console.warn("[stage1CoachProofDiagnosis] LLM analysis failed:", err.message);
  }

  const proofMilestone = detectProofMilestone(userMessage);
  if (proofMilestone) {
    const progression = progressionFromProof(proofMilestone, { goalContext, map });
    if (progression) {
      return fallbackFlowFromRegex({ ...ctx, proofSignals: { hasProof: true, isSetback: false } });
    }
  }

  if (hasActionEvidence) {
    const retryMilestone = detectProofMilestone(userMessage);
    if (retryMilestone) {
      return fallbackFlowFromRegex({ ...ctx, proofSignals: { hasProof: true, isSetback: false } });
    }
  }

  return base;
}

module.exports = {
  FUNNEL_STAGES,
  analyzeProofAgainstDiagnosis,
  buildFlowFromAnalysis,
  buildWritebackFromAnalysis,
  buildProofDiagnosisPrompt,
  resolveProofProgressionFlowAsync,
  pickCurrentDiagnosis,
};
