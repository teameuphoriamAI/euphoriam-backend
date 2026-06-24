const { successResponse, errorResponse } = require("../utils/response");
const aiService = require("../clients/aiService");
const { loadStage1ForUser, persistStage1ForUser } = require("../helpers/stage1Repository");
const { buildActiveGoalContext } = require("../helpers/stage1GoalContext");
const { resolvePrimaryDomain } = require("../helpers/stage1State");
const { normalizeDomain } = require("../constants/domains");
const { User } = require("../models/userModel");
const { withDbSlot } = require("../config/sequelize");
const { loadCoachPromptBundle } = require("../helpers/stage1Prompts");
const { buildCoachUserContext } = require("../stage1/coach/context/userContext");
const { buildCoachMemoryContext } = require("../stage1/coach/context/memory");
const {
  recordCoachCheckin,
  listCoachHistory,
  getResumableCoachMessages,
  getOpenCoachSession,
  endCoachSession,
  findOpenSessionForDomain,
} = require("../stage1/coach/persistence/history");
const { gatherCoachOpenPayload, resolveLastGreenRep } = require("../stage1/coach/context/open");
const { buildSessionSummaryFromCoachLog } = require("../stage1/coach/context/sessionContinuity");
const {
  detectProgressSignals,
  maybeAutoLogProof,
  sanitizeCoachGreenRep,
} = require("../stage1/coach/utils/progress");
const {
  recordCoachingMemoryTurn,
  finalizeCoachingMemorySession,
  ensureInitialDiagnosticOnStage1,
  ensureCoachingMemory,
  serializeCoachingMemoryForCoach,
  syncProofLogsToCoachingMemory,
} = require("../stage1/coach/context/coachingMemory");
const { indexCoachSession } = require("../stage1/coach/persistence/vectorMemory");
const { DOMAIN_LABELS } = require("../constants/domains");
const { sanitizeCoachUserFacingText, unwrapCoachAssistantMessage } = require("../stage1/coach/context/naturalLanguage");
const { mergeBarriersIntoMemory } = require("../stage1/coach/signals/barriers");
const { resolveCoachingTransition } = require("../stage1/coach/flows/transition");
const { buildCoachConversationSignals } = require("../stage1/coach/signals/conversation");
const {
  resolveProofCycleFlow,
  onGreenRepAssigned,
} = require("../stage1/coach/flows/proofCycle");
const { inferGravityFromCoachState } = require("../helpers/stage1StructuralMap");
const { buildStructuralCoachBlock } = require("../helpers/stage1StructuralFramework");
const { resolveFirstSessionTurnFlow } = require("../stage1/coach/signals/firstSession");
const { resolveInvestigationTurnFlow } = require("../stage1/coach/signals/investigation");
const { deriveEvolutionWritebackFromTurn } = require("../stage1/coach/utils/milestoneRep");
const { resolveStructuralCoachingFlow } = require("../stage1/coach/flows/structural");
const { resolveProofProgressionFlowAsync } = require("../stage1/coach/flows/proofDiagnosis");
const { resolveActivationMomentFlow } = require("../stage1/coach/signals/activation");
const { mergeFlowSignals } = require("../stage1/coach/signals/merge");

const COACH_STATE = Object.freeze({ COACHING: "coaching", PROGRESS: "progress" });

const resolveUser = async (req) => {
  const id = req.user?.sub || req.user?.userId;
  if (!id) {
    const err = new Error("Not authenticated");
    err.status = 401;
    throw err;
  }
  const user = await withDbSlot(() =>
    User.findByPk(id, { attributes: { exclude: ["password"] } }),
  );
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }
  return user;
};

const persistCoachTurn = ({
  stage1,
  map,
  domain,
  checkinState,
  gravityRating,
  messages,
  userMessage,
  assistantMessage,
  sessionId: existingSessionId,
  greenRep = null,
  writebackHints = {},
  proofCycle = null,
  sessionPhase = "coaching",
  firstSessionFlow = null,
  investigationFlow = null,
  structuralCoachingFlow = null,
  activationMomentFlow = null,
}) => {
  const { stage1: afterTurn, session_id } = recordCoachCheckin(stage1, {
    domain,
    state: checkinState,
    gravity_rating: gravityRating,
    messages,
    user_message: userMessage,
    assistant_message: assistantMessage,
    green_rep: greenRep,
    phase: sessionPhase === "coaching" ? "coaching" : sessionPhase,
    coach_state: checkinState,
    proof_cycle: proofCycle,
    first_session_flow: firstSessionFlow,
    investigation_flow: investigationFlow,
    structural_coaching_flow: structuralCoachingFlow,
    activation_moment_flow: activationMomentFlow,
  });

  const mapIdx = (afterTurn.domain_maps || []).findIndex((m) => m.domain === domain);
  let nextStage1 = afterTurn;
  if (mapIdx >= 0) {
    const maps = [...afterTurn.domain_maps];
    maps[mapIdx] = recordCoachingMemoryTurn(maps[mapIdx], {
      session_id: session_id || existingSessionId,
      domain,
      state: checkinState,
      messages,
      user_message: userMessage,
      assistant_message: assistantMessage,
      green_rep: greenRep,
      gravity_rating: gravityRating,
      writeback_hints: writebackHints,
      active_goal_context: buildActiveGoalContext(map, domain),
    });
    maps[mapIdx] = syncProofLogsToCoachingMemory(maps[mapIdx], afterTurn.proof_logs || []);
    nextStage1 = { ...afterTurn, domain_maps: maps };
  }
  return { nextStage1, session_id: session_id || existingSessionId };
};

/** GET /api/stage1/coach/open — structured memory + conversational opening (no scripted Q&A). */
const coachOpen = async (req, res) => {
  try {
    const user = await resolveUser(req);
    let stage1 = await loadStage1ForUser(user);
    const domain =
      normalizeDomain(req.query?.domain) || resolvePrimaryDomain(stage1);
    if (!domain) {
      return errorResponse(res, "No active domain. Complete Map Resistance first.", 400);
    }

    let map = (stage1.domain_maps || []).find((m) => m.domain === domain);
    if (!map) return errorResponse(res, "Domain map not found", 404);
    if (!map.map_resistance_complete) {
      return errorResponse(res, "Complete Map Resistance before daily coaching.", 400);
    }

    const { stage1: withDiagnostic, changed: diagnosticBackfill } =
      ensureInitialDiagnosticOnStage1(stage1, domain);
    if (diagnosticBackfill) {
      stage1 = await persistStage1ForUser(user.id, withDiagnostic);
      map = (stage1.domain_maps || []).find((m) => m.domain === domain);
    }

    const open = getOpenCoachSession(stage1, domain);
    if (open?.messages?.length) {
      return successResponse(res, "Coach session resumed", {
        domain,
        session_phase: "coaching",
        coach_state: COACH_STATE.COACHING,
        awaiting_user: open.awaiting_user,
        resumed: true,
        assistant_message: null,
        messages: open.messages,
        session_id: open.id,
      });
    }

    const { opening_message, coachContext, activeGoalContext, continuity } =
      gatherCoachOpenPayload(user, stage1, map, domain);

    const coachMemoryContext = await buildCoachMemoryContext({
      user,
      stage1,
      map,
      domain,
    });

    const checkinState = req.query?.state || "clear";

    const { stage1: afterOpen, session_id } = recordCoachCheckin(stage1, {
      domain,
      state: checkinState,
      assistant_message: opening_message,
      phase: "coaching",
      opening_checkin: true,
      coach_state: COACH_STATE.COACHING,
    });

    const mapIdx = (afterOpen.domain_maps || []).findIndex((m) => m.domain === domain);
    let nextStage1 = afterOpen;
    if (mapIdx >= 0) {
      const maps = [...afterOpen.domain_maps];
      maps[mapIdx] = recordCoachingMemoryTurn(maps[mapIdx], {
        session_id,
        domain,
        state: checkinState,
        assistant_message: opening_message,
        active_goal_context: activeGoalContext,
        opening_checkin: true,
        writeback_hints: {
          current_failure_strategy:
            map.protector_rule ||
            map.failure_strategy?.rule ||
            null,
          current_success_strategy: map.success_strategy?.behaviour || null,
          milestone_focus: activeGoalContext?.current_milestone || null,
        },
      });
      nextStage1 = { ...afterOpen, domain_maps: maps };
    }

    await persistStage1ForUser(user.id, nextStage1);

    const safeOpening = sanitizeCoachUserFacingText(opening_message);

    return successResponse(res, "Coach check-in", {
      domain,
      session_phase: "coaching",
      awaiting_user: true,
      resumed: false,
      assistant_message: safeOpening,
      messages: [{ role: "assistant", content: safeOpening }],
      session_id,
      COACH_MEMORY_CONTEXT: coachMemoryContext,
      context_loaded: {
        goal: activeGoalContext.goal_name,
        milestone: activeGoalContext.current_milestone,
        prior_sessions: (coachContext.coaching_sessions || []).length,
        proof_logs: (coachMemoryContext.recent_proofs || []).length,
        session_continuity: continuity || null,
      },
    });
  } catch (err) {
    console.error("[coachOpen]", err);
    return errorResponse(res, err.message || "Coach open failed", err.status || 500);
  }
};

/** POST /api/stage1/coach/checkin — LLM controls conversation (memory loaded every turn). */
const coachCheckin = async (req, res) => {
  try {
    if (!aiService.flags.coach) {
      return errorResponse(
        res,
        "Coach AI is disabled. Set USE_PYTHON_COACH=true and start euphoriam-ai.",
        503,
      );
    }
    if (!aiService.isEnabled()) {
      return errorResponse(res, "AI_SERVICE_URL is not configured", 503);
    }

    const user = await resolveUser(req);
    let stage1 = await loadStage1ForUser(user);
    const domain =
      normalizeDomain(req.body?.domain) || resolvePrimaryDomain(stage1);
    if (!domain) {
      return errorResponse(res, "No active domain. Complete Map Resistance first.", 400);
    }

    let map = (stage1.domain_maps || []).find((m) => m.domain === domain);
    if (!map) return errorResponse(res, "Domain map not found", 404);
    if (!map.map_resistance_complete) {
      return errorResponse(res, "Complete Map Resistance before daily coaching.", 400);
    }

    const { stage1: withDiagnostic, changed: diagnosticBackfill } =
      ensureInitialDiagnosticOnStage1(stage1, domain);
    if (diagnosticBackfill) {
      stage1 = await persistStage1ForUser(user.id, withDiagnostic);
      map = (stage1.domain_maps || []).find((m) => m.domain === domain);
    }

    const userMessage = String(req.body?.message || "").trim();
    if (!userMessage) {
      return errorResponse(res, "Answer the coach's question to continue.", 400);
    }

    const checkinState = req.body?.state || req.body?.current_state || "clear";
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const gravityRating = req.body?.gravity_rating ?? null;

    const memoryCtx = serializeCoachingMemoryForCoach(map, stage1, domain);
    const lastRep = resolveLastGreenRep(
      { ...ensureCoachingMemory(map), ...memoryCtx },
      map,
    );
    const proofSignals = detectProgressSignals(userMessage, { lastRepName: lastRep?.name });

    if (proofSignals.hasProof) {
      const logged = maybeAutoLogProof(
        stage1,
        domain,
        userMessage,
        proofSignals,
        lastRep?.name,
      );
      stage1 = logged.stage1;
    }

    const coachMemoryContext = await buildCoachMemoryContext({
      user,
      stage1,
      map,
      domain,
      semanticQuery: userMessage,
    });

    const rawOpenSession = findOpenSessionForDomain(
      Array.isArray(stage1.coach_session_log) ? stage1.coach_session_log : [],
      domain,
    );
    const activeGoalContext = buildActiveGoalContext(map, domain);
    const preSignals = buildCoachConversationSignals({
      messages,
      userMessage,
      map,
      memoryCtx: coachMemoryContext,
      openSession: rawOpenSession,
      goalContext: activeGoalContext,
      proofCycleFlow: null,
    });
    const proofCycleFlow = resolveProofCycleFlow({
      stage1,
      domain,
      messages,
      userMessage,
      lastRepName: lastRep?.name,
      openSession: rawOpenSession,
      map,
      goalContext: activeGoalContext,
      memoryCtx: coachMemoryContext,
      reports_stagnation: preSignals.reports_stagnation,
      user_completed_current_rep: preSignals.user_completed_current_rep,
      rep_assigned_this_session: preSignals.has_active_session_rep,
      coaching_repeat_complaint: preSignals.coaching_repeat_complaint,
    });

    const firstSessionFlow = resolveFirstSessionTurnFlow({
      messages,
      userMessage,
      map,
      activeGoalContext,
      continuity: coachMemoryContext.member_continuity,
      coachContext: coachMemoryContext,
      memory: coachMemoryContext,
      proofCycleFlow,
      openSession: rawOpenSession,
    });

    const investigationFlow = resolveInvestigationTurnFlow({
      messages,
      userMessage,
      map,
      activeGoalContext,
      openSession: rawOpenSession,
      proofCycleFlow,
      firstSessionFlow,
    });

    const prompts = await loadCoachPromptBundle();
    const user_coach_context = await buildCoachUserContext(user, stage1, map, domain);
    user_coach_context.COACH_MEMORY_CONTEXT = coachMemoryContext;

    const transition = resolveCoachingTransition({
      messages,
      userMessage,
      map,
      coachMemoryContext,
      stage1,
      domain,
      proofCycleFlow,
      openSession: rawOpenSession,
      firstSessionFlow,
      investigationFlow,
      goalContext: activeGoalContext,
    });

    const proofProgressionFlow = await resolveProofProgressionFlowAsync({
      userMessage,
      proofSignals,
      messages,
      map,
      goalContext: activeGoalContext,
      memoryCtx: coachMemoryContext,
      openSession: rawOpenSession,
      proofCycleFlow,
    });

    const activationMomentFlow = resolveActivationMomentFlow({
      messages,
      userMessage,
      map,
      goalContext: activeGoalContext,
      memoryCtx: coachMemoryContext,
      openSession: rawOpenSession,
      proofCycleFlow,
    });

    if (activationMomentFlow.block_green_rep && transition.coaching_brief) {
      transition.coaching_brief.assign_green_rep = false;
      transition.coaching_brief.must_assign_green_rep = false;
    }

    const structuralFlow = resolveStructuralCoachingFlow({
      messages,
      userMessage,
      map,
      goalContext: activeGoalContext,
      memoryCtx: coachMemoryContext,
      openSession: rawOpenSession,
      proofCycleFlow,
      firstSessionFlow,
      investigationFlow,
      transitionBrief: transition.coaching_brief,
    });

    if (structuralFlow.block_green_rep && transition.coaching_brief) {
      transition.coaching_brief.assign_green_rep = false;
      transition.coaching_brief.must_assign_green_rep = false;
    }
    if (structuralFlow.suggested_milestone_rep && transition.coaching_brief) {
      transition.coaching_brief.suggested_milestone_rep = structuralFlow.suggested_milestone_rep;
    }
    if (structuralFlow.coaching_directive && transition.coaching_brief) {
      transition.coaching_brief.instruction =
        `${transition.coaching_brief.instruction || ""} ${structuralFlow.coaching_directive}`.trim();
    }

    const mergedConversationSignals = mergeFlowSignals(
      transition.conversation_signals ||
        transition.coaching_brief?.conversation_signals ||
        {},
      {
        proofCycleFlow,
        proofProgressionFlow,
        activationMomentFlow,
        investigationFlow,
        structuralFlow,
        firstSessionFlow,
      },
    );
    transition.conversation_signals = mergedConversationSignals;
    if (mergedConversationSignals.stop_discovery) {
      transition.stop_discovery = true;
      transition.discovery_complete = true;
      if (transition.coaching_mode === "discovery") {
        transition.coaching_mode = "coaching";
      }
    }
    if (transition.coaching_brief) {
      transition.coaching_brief.conversation_signals = mergedConversationSignals;
      if (mergedConversationSignals.coaching_directive) {
        transition.coaching_brief.instruction =
          `${transition.coaching_brief.instruction || ""} ${mergedConversationSignals.coaching_directive}`.trim();
      }
      if (proofProgressionFlow?.green_rep && mergedConversationSignals.assign_green_rep) {
        transition.coaching_brief.assign_green_rep = true;
        transition.coaching_brief.must_assign_green_rep = true;
      }
      if (activationMomentFlow?.assign_green_rep && activationMomentFlow?.green_rep) {
        transition.coaching_brief.assign_green_rep = true;
        transition.coaching_brief.must_assign_green_rep = true;
        transition.coaching_brief.suggested_milestone_rep = activationMomentFlow.green_rep;
      }
    }

    coachMemoryContext.coaching_transition = {
      coaching_phase: transition.coaching_phase,
      coaching_mode: transition.coaching_mode,
      discovery_complete: transition.discovery_complete,
      stop_discovery: transition.stop_discovery,
      reasons: transition.reasons,
    };
    if (transition.coaching_brief) {
      coachMemoryContext.coaching_brief = transition.coaching_brief;
      coachMemoryContext.conversation_signals =
        transition.conversation_signals ||
        transition.coaching_brief?.conversation_signals ||
        null;
    }

    const checkin = {
      current_state: checkinState,
      gravity_rating: gravityRating,
      message: userMessage,
      session_phase: proofCycleFlow.session_phase || "coaching",
      coaching_phase: transition.coaching_phase,
      coaching_mode: transition.coaching_mode,
      discovery_complete: transition.discovery_complete,
      stop_discovery: transition.stop_discovery,
      coaching_brief: transition.coaching_brief,
      conversation_signals: transition.conversation_signals ||
        transition.coaching_brief?.conversation_signals ||
        null,
      user_reported_proof: Boolean(proofSignals.hasProof),
      turn_count: messages.filter((m) => m?.role === "user").length + 1,
      last_green_rep: lastRep?.name || coachMemoryContext?.last_green_rep || null,
      returning_member: Boolean(coachMemoryContext?.member_continuity?.is_returning_member),
      do_not_reintroduce: Boolean(coachMemoryContext?.member_continuity?.do_not_reintroduce),
      prior_session_count: coachMemoryContext?.member_continuity?.prior_session_count || 0,
      member_continuity: coachMemoryContext?.member_continuity || null,
      first_session: Boolean(firstSessionFlow.is_first_session),
      first_turn: Boolean(firstSessionFlow.is_first_turn),
      reports_setback: Boolean(firstSessionFlow.is_first_turn && firstSessionFlow.active),
      reports_stagnation: transition.conversation_signals?.reports_stagnation || false,
      solo_ladder_complete: transition.conversation_signals?.solo_ladder_complete || false,
      assign_green_rep:
        Boolean(transition.coaching_brief?.assign_green_rep) &&
        !transition.conversation_signals?.block_clarity_rep,
      awaiting_proof_log: Boolean(proofCycleFlow.awaiting_proof_log),
      proof_integration_mode: Boolean(proofCycleFlow.proof_integration_mode),
      suggest_session_end: Boolean(proofCycleFlow.suggest_session_end),
      structural_framework:
        transition.coaching_brief?.structural_framework ||
        buildStructuralCoachBlock({
          map,
          memoryCtx: coachMemoryContext,
          userMessage,
          proofCycleFlow,
          transition,
          investigationFlow,
        }),
      active_bottleneck: structuralFlow.active_bottleneck || null,
      structural_coaching_flow: structuralFlow.structural_coaching_flow || null,
      suggested_milestone_rep: transition.coaching_brief?.suggested_milestone_rep || null,
    };

    const result = await aiService.coachReply({
      user_id: user.id,
      domain_map: map,
      active_goal_context: buildActiveGoalContext(map, domain),
      user_coach_context,
      checkin,
      messages,
      user_message: userMessage,
      prompts,
    });

    let rawAssistant = result.assistant_message;
    let rawGreenRep = result.green_rep;
    if (typeof rawAssistant === "string" && rawAssistant.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(rawAssistant);
        if (parsed.assistant_message) rawAssistant = parsed.assistant_message;
        if (!rawGreenRep && parsed.green_rep) rawGreenRep = parsed.green_rep;
        if (parsed.writeback_hints) {
          result.writeback_hints = { ...(result.writeback_hints || {}), ...parsed.writeback_hints };
        }
      } catch {
        /* keep raw */
      }
    }

    const safeGreenRep = proofCycleFlow.suggest_session_end
      ? null
      : sanitizeCoachGreenRep(rawGreenRep, {
          lastRepName: lastRep?.name,
          proofIntegrationActive: Boolean(proofCycleFlow.proof_integration_mode),
          allowNewRep: Boolean(
            result.writeback_hints?.assign_new_green_rep &&
              transition.coaching_brief?.assign_green_rep,
          ),
          completedActionFamilies: proofCycleFlow.proof_cycle?.completed_actions || [],
          map,
          goalContext: activeGoalContext,
          allowSoloFallback: Boolean(
            transition.conversation_signals?.no_trusted_person &&
              !["income", "wealth", "money"].includes(String(domain || "").toLowerCase()),
          ),
          assignRequested: Boolean(transition.coaching_brief?.assign_green_rep),
        });

    const assistantReply = sanitizeCoachUserFacingText(unwrapCoachAssistantMessage(rawAssistant), {
      stripGreetingName: (user?.name || "Member").split(/\s+/)[0],
      noTrustedPerson: Boolean(transition.conversation_signals?.no_trusted_person),
      greenRep: safeGreenRep,
    });

    const writebackHints = { ...(result.writeback_hints || {}) };
    Object.assign(
      writebackHints,
      proofProgressionFlow?.writeback_hints || {},
      activationMomentFlow?.writeback_hints || {},
      deriveEvolutionWritebackFromTurn({
        userMessage,
        map,
        memoryCtx: coachMemoryContext,
        signals: proofSignals,
        bottleneck: structuralFlow.active_bottleneck,
      }),
      structuralFlow.evolution_hints || {},
    );
    if (proofCycleFlow.awaiting_proof_log) {
      writebackHints.awaiting_proof_log = true;
    }
    if (proofCycleFlow.suggest_session_end) {
      writebackHints.suggest_session_end = true;
    }
    if (!transition.coaching_brief?.assign_green_rep || proofCycleFlow.suggest_session_end) {
      delete writebackHints.assign_new_green_rep;
    }
    const resolvedGravity =
      gravityRating ??
      (writebackHints.gravity_rating != null
        ? Number(writebackHints.gravity_rating)
        : null) ??
      inferGravityFromCoachState(checkinState);
    if (resolvedGravity != null && Number.isFinite(resolvedGravity)) {
      writebackHints.gravity_rating = resolvedGravity;
    }
    const lastMemSession = [...(coachMemoryContext?.coaching_sessions || [])].pop();
    if (!writebackHints.current_failure_strategy && !writebackHints.current_resistance) {
      writebackHints.current_failure_strategy =
        lastMemSession?.current_failure_strategy?.rule ||
        map.protector_rule ||
        map.failure_strategy?.rule ||
        null;
    }
    if (!writebackHints.current_success_strategy) {
      writebackHints.current_success_strategy =
        lastMemSession?.current_success_strategy?.behaviour ||
        map.success_strategy?.behaviour ||
        null;
    }
    if (!writebackHints.cl_estimate && map.recovery_speed) {
      const recovery = String(map.recovery_speed).toLowerCase();
      if (recovery.includes("slow")) writebackHints.cl_estimate = 2;
      else if (recovery.includes("fast")) writebackHints.cl_estimate = 3.5;
    }

    let nextStructuralFlow =
      structuralFlow.structural_coaching_flow ||
      proofProgressionFlow?.structural_coaching_flow ||
      activationMomentFlow?.structural_coaching_flow;
    if (safeGreenRep?.name) {
      nextStructuralFlow = {
        ...(nextStructuralFlow || {}),
        disruption_complete: false,
        disruption_asked: false,
        last_rep_name: safeGreenRep.name,
        last_rep_assigned_at: new Date().toISOString(),
      };
    }
    if (structuralFlow.active_bottleneck) {
      writebackHints.active_bottleneck = structuralFlow.active_bottleneck;
    }

    let nextProofCycle = proofCycleFlow.proof_cycle;
    if (safeGreenRep?.name) {
      nextProofCycle = onGreenRepAssigned(
        proofCycleFlow.proof_cycle,
        safeGreenRep.name,
        proofCycleFlow.proof_cycle?.known_proof_ids || [],
      );
    }

    const sessionPhase = proofCycleFlow.session_phase || "coaching";
    const coachState =
      proofCycleFlow.proof_integration_mode || sessionPhase === "proof_integration"
        ? COACH_STATE.PROGRESS
        : COACH_STATE.COACHING;

    const { nextStage1 } = persistCoachTurn({
      stage1,
      map:
        transition.conversation_signals?.no_trusted_person
          ? mergeBarriersIntoMemory(map, { no_trusted_person: true })
          : map,
      domain,
      checkinState: coachState,
      gravityRating: resolvedGravity,
      messages,
      userMessage,
      assistantMessage: assistantReply,
      writebackHints,
      greenRep: safeGreenRep,
      proofCycle: nextProofCycle,
      sessionPhase,
      firstSessionFlow: firstSessionFlow.first_session_flow,
      investigationFlow: investigationFlow.investigation_flow,
      structuralCoachingFlow: nextStructuralFlow,
    });

    await persistStage1ForUser(user.id, nextStage1);

    return successResponse(res, "Coach reply", {
      domain,
      session_phase: sessionPhase,
      coach_state: coachState,
      assistant_message: assistantReply,
      green_rep: safeGreenRep,
      detected_failure_strategy: result.detected_failure_strategy || null,
      writeback_hints: writebackHints,
      COACH_MEMORY_CONTEXT: coachMemoryContext,
      checkin,
    });
  } catch (err) {
    console.error("[coachCheckin]", err);
    return errorResponse(res, err.message || "Coach check-in failed", err.status || 502);
  }
};

/** POST /api/stage1/friction */
const frictionRescue = async (req, res) => {
  try {
    if (!aiService.flags.coach) {
      return errorResponse(res, "Friction AI requires USE_PYTHON_COACH=true", 503);
    }
    if (!aiService.isEnabled()) {
      return errorResponse(res, "AI_SERVICE_URL is not configured", 503);
    }

    const user = await resolveUser(req);
    const stage1 = await loadStage1ForUser(user);
    const domain =
      normalizeDomain(req.body?.domain) || resolvePrimaryDomain(stage1);
    const map = (stage1.domain_maps || []).find((m) => m.domain === domain);
    if (!map) return errorResponse(res, "Domain map not found", 404);

    const prompts = await loadCoachPromptBundle();
    const user_coach_context = await buildCoachUserContext(user, stage1, map, domain);
    user_coach_context.COACH_MEMORY_CONTEXT = await buildCoachMemoryContext({
      user,
      stage1,
      map,
      domain,
      semanticQuery: req.body?.message,
    });

    const result = await aiService.frictionRescue({
      domain_map: map,
      active_goal_context: buildActiveGoalContext(map, domain),
      user_coach_context,
      checkin: {
        current_state: req.body?.state || "high_gravity",
        gravity_rating: req.body?.gravity_rating,
      },
      messages: req.body?.messages || [],
      user_message: req.body?.message,
      prompts,
    });

    return successResponse(res, "Friction rescue", {
      assistant_message: sanitizeCoachUserFacingText(result.assistant_message),
      green_rep: result.green_rep || null,
    });
  } catch (err) {
    console.error("[frictionRescue]", err);
    return errorResponse(res, err.message || "Friction rescue failed", err.status || 502);
  }
};

const getCoachHistory = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const stage1 = await loadStage1ForUser(user);
    const domain = req.query?.domain
      ? normalizeDomain(String(req.query.domain))
      : null;
    const sessions = listCoachHistory(stage1, { domain });
    return successResponse(res, "Coach history", {
      sessions,
      count: sessions.length,
      domain: domain || null,
      label: domain ? DOMAIN_LABELS[domain] : null,
    });
  } catch (err) {
    console.error("[getCoachHistory]", err);
    return errorResponse(res, err.message || "Failed to load coach history", err.status || 500);
  }
};

const getCoachResume = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const stage1 = await loadStage1ForUser(user);
    const domain =
      normalizeDomain(req.query?.domain) || resolvePrimaryDomain(stage1);
    if (!domain) {
      return successResponse(res, "No domain", { messages: [], domain: null });
    }
    const open = getOpenCoachSession(stage1, domain);
    const messages = open?.messages?.length
      ? open.messages
      : getResumableCoachMessages(stage1, domain);
    return successResponse(res, "Coach resume", {
      domain,
      messages,
      session_phase: "coaching",
      coach_state: COACH_STATE.COACHING,
      awaiting_user: open?.awaiting_user ?? false,
    });
  } catch (err) {
    return errorResponse(res, err.message || "Failed to resume coach", err.status || 500);
  }
};

const endCoachChat = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const stage1 = await loadStage1ForUser(user);
    const domain =
      normalizeDomain(req.body?.domain) || resolvePrimaryDomain(stage1);
    if (!domain) {
      return errorResponse(res, "No active domain", 400);
    }
    const openBeforeEnd = getOpenCoachSession(stage1, domain);
    const { stage1: afterEnd, ended, session_id } = endCoachSession(stage1, domain);
    let nextStage1 = afterEnd;
    if (ended && session_id) {
      const autoSummary = buildSessionSummaryFromCoachLog(openBeforeEnd);
      if (autoSummary) {
        const sessions = [...(nextStage1.coach_session_log || [])];
        const idx = sessions.findIndex((s) => s.id === session_id);
        if (idx >= 0) {
          sessions[idx] = { ...sessions[idx], session_summary: autoSummary };
          nextStage1 = { ...nextStage1, coach_session_log: sessions };
        }
      }

      const mapIdx = (nextStage1.domain_maps || []).findIndex((m) => m.domain === domain);
      if (mapIdx >= 0) {
        const maps = [...nextStage1.domain_maps];
        maps[mapIdx] = finalizeCoachingMemorySession(maps[mapIdx], {
          domain,
          session_id,
          session_summary: autoSummary || null,
        });
        maps[mapIdx] = syncProofLogsToCoachingMemory(maps[mapIdx], nextStage1.proof_logs || []);
        nextStage1 = { ...nextStage1, domain_maps: maps };
      }
      await persistStage1ForUser(user.id, nextStage1);

      if (openBeforeEnd?.messages?.length) {
        indexCoachSession({
          sessionId: session_id,
          userId: user.id,
          email: user.email,
          domain,
          messages: openBeforeEnd.messages,
          summary: buildSessionSummaryFromCoachLog(openBeforeEnd),
        }).catch(() => {});
      }
    }
    return successResponse(res, ended ? "Coach session ended" : "No open session", {
      domain,
      ended,
      session_id,
    });
  } catch (err) {
    console.error("[endCoachChat]", err);
    return errorResponse(res, err.message || "Failed to end coach session", err.status || 500);
  }
};

module.exports = {
  coachOpen,
  coachCheckin,
  frictionRescue,
  getCoachHistory,
  getCoachResume,
  endCoachChat,
  COACH_STATE,
};
