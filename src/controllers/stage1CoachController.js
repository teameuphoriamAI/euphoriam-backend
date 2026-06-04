const { successResponse, errorResponse } = require("../utils/response");
const aiService = require("../clients/aiService");
const { loadStage1ForUser, persistStage1ForUser } = require("../helpers/stage1Repository");
const { buildActiveGoalContext } = require("../helpers/stage1GoalContext");
const { resolvePrimaryDomain } = require("../helpers/stage1State");
const { normalizeDomain } = require("../constants/domains");
const { User } = require("../models/userModel");
const { withDbSlot } = require("../config/sequelize");
const { loadCoachPromptBundle } = require("../helpers/stage1Prompts");
const { buildCoachUserContext } = require("../helpers/stage1CoachContext");
const {
  recordCoachCheckin,
  listCoachHistory,
  getResumableCoachMessages,
  getOpenCoachSession,
  endCoachSession,
} = require("../helpers/stage1CoachHistory");
const { gatherCoachOpenPayload, resolveLastGreenRep } = require("../helpers/stage1CoachOpen");
const { buildSessionSummaryFromCoachLog } = require("../helpers/stage1CoachSessionContinuity");
const {
  initCheckInProgress,
  normalizeProgress,
} = require("../helpers/stage1CoachCheckInFlow");
const {
  resolveCoachTurn,
  COACH_STATE,
  sanitizeCoachGreenRep,
  buildProgressCoachingInstructions,
  maybeAutoLogProof,
} = require("../helpers/stage1CoachStateMachine");
const { buildProgressIntegrationFromContinuity } = require("../helpers/stage1CoachProgress");
const { deriveCoachingWritebackFromProgress } = require("../helpers/stage1CoachWriteback");
const {
  isProgressIntegrationActive,
  isPostProofDevaluationActive,
  isWoundFlipActive,
  buildProgressClosing,
  buildPostProofDevaluationMessage,
} = require("../helpers/stage1CoachProgress");
const {
  recordCoachingMemoryTurn,
  finalizeCoachingMemorySession,
  ensureInitialDiagnosticOnStage1,
  ensureCoachingMemory,
  serializeCoachingMemoryForCoach,
  syncProofLogsToCoachingMemory,
} = require("../helpers/stage1CoachingMemory");
const { DOMAIN_LABELS } = require("../constants/domains");

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

const persistProgressTurn = ({
  stage1,
  map,
  domain,
  checkinState,
  gravityRating,
  messages,
  userMessage,
  assistantMessage,
  sessionId: existingSessionId,
  checkInProgress,
  progressIntegration,
  coachState,
  phase,
  writebackHints = {},
  greenRep = null,
}) => {
  const { stage1: afterTurn, session_id } = recordCoachCheckin(stage1, {
    domain,
    state: coachState || checkinState,
    gravity_rating: gravityRating,
    messages,
    user_message: userMessage,
    assistant_message: assistantMessage,
    green_rep: greenRep,
    phase,
    check_in_progress: checkInProgress,
    progress_integration: progressIntegration,
    coach_state: coachState,
  });

  const mapIdx = (afterTurn.domain_maps || []).findIndex((m) => m.domain === domain);
  let nextStage1 = afterTurn;
  if (mapIdx >= 0) {
    const maps = [...afterTurn.domain_maps];
    const mergedWriteback = deriveCoachingWritebackFromProgress(progressIntegration, {
      ...writebackHints,
      green_rep_completed: progressIntegration?.signals?.repCompleted || undefined,
      progress_note: userMessage,
    });
    maps[mapIdx] = recordCoachingMemoryTurn(maps[mapIdx], {
      session_id: session_id || existingSessionId,
      domain,
      state: coachState || checkinState,
      messages,
      user_message: userMessage,
      assistant_message: assistantMessage,
      green_rep: greenRep,
      gravity_rating: gravityRating,
      writeback_hints: mergedWriteback,
      active_goal_context: buildActiveGoalContext(map, domain),
      opening_checkin: phase === "check_in",
    });
    maps[mapIdx] = syncProofLogsToCoachingMemory(maps[mapIdx], afterTurn.proof_logs || []);
    nextStage1 = { ...afterTurn, domain_maps: maps };
  }
  return { nextStage1, session_id: session_id || existingSessionId };
};

/** GET /api/stage1/coach/open — load memory + deterministic welcome check-in (no AI diagnosis). */
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
      const phase = open.phase || "coaching";
      return successResponse(res, "Coach session resumed", {
        domain,
        session_phase: phase,
        coach_state: open.coach_state || null,
        awaiting_user: open.awaiting_user,
        resumed: true,
        assistant_message: null,
        messages: open.messages,
        session_id: open.id,
        check_in_progress: open.check_in_progress || null,
        progress_integration: open.progress_integration || null,
      });
    }

    const { map: enrichedMap, opening_message, coachContext, activeGoalContext, continuity } =
      gatherCoachOpenPayload(user, stage1, map, domain);

    const checkin = {
      current_state: req.query?.state || "clear",
      gravity_rating: null,
    };

    const checkInProgress = initCheckInProgress(continuity);
    const seededProgress = buildProgressIntegrationFromContinuity(continuity);

    const { stage1: afterOpen, session_id } = recordCoachCheckin(stage1, {
      domain,
      state: checkin.current_state,
      assistant_message: opening_message,
      phase: seededProgress ? "proof_integration" : "check_in",
      opening_checkin: true,
      check_in_progress: checkInProgress,
      progress_integration: seededProgress,
      coach_state: seededProgress ? COACH_STATE.PROGRESS : undefined,
    });

    const mapIdx = (afterOpen.domain_maps || []).findIndex((m) => m.domain === domain);
    let nextStage1 = afterOpen;
    if (mapIdx >= 0) {
      const maps = [...afterOpen.domain_maps];
      maps[mapIdx] = recordCoachingMemoryTurn(maps[mapIdx], {
        session_id,
        domain,
        state: checkin.current_state,
        assistant_message: opening_message,
        active_goal_context: activeGoalContext,
        opening_checkin: true,
      });
      nextStage1 = { ...afterOpen, domain_maps: maps };
    }

    await persistStage1ForUser(user.id, nextStage1);

    return successResponse(res, "Coach check-in", {
      domain,
      session_phase: "check_in",
      awaiting_user: true,
      resumed: false,
      assistant_message: opening_message,
      messages: [{ role: "assistant", content: opening_message }],
      session_id,
      check_in_progress: checkInProgress,
      context_loaded: {
        goal: activeGoalContext.goal_name,
        milestone: activeGoalContext.current_milestone,
        has_initial_diagnostic: Boolean(coachContext.initial_diagnostic),
        prior_sessions: (coachContext.coaching_sessions || []).length,
        proof_logs: (coachContext.proof_logs || []).length,
        recent_patterns: coachContext.recent_patterns || [],
        session_continuity: continuity || null,
      },
      session_continuity: continuity || null,
    });
  } catch (err) {
    console.error("[coachOpen]", err);
    return errorResponse(res, err.message || "Coach open failed", err.status || 500);
  }
};

/** POST /api/stage1/coach/checkin */
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
    if (!map) {
      return errorResponse(res, "Domain map not found", 404);
    }
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
    const openSession = getOpenCoachSession(stage1, domain);
    let checkInProgress = normalizeProgress(
      openSession?.check_in_progress || req.body?.check_in_progress,
    );

    const turn = resolveCoachTurn({
      userMessage,
      messages,
      openSession,
      checkInProgress,
      stage1,
      domain,
      map,
      userSelectedState: checkinState,
    });

    stage1 = turn.stage1 || stage1;
    const coachState = turn.coach_state;
    const lastRep = resolveLastGreenRep(
      { ...ensureCoachingMemory(map), ...serializeCoachingMemoryForCoach(map, stage1, domain) },
      map,
    );

    let assistantMessage = String(turn.assistant_message || "").trim() || null;
    if (!assistantMessage) {
      const ctx = { lastRepName: lastRep?.name, map, patterns: map?.top_3_avoidance_behaviours || [] };
      assistantMessage = isPostProofDevaluationActive(turn.progress_integration)
        ? buildPostProofDevaluationMessage(turn.progress_integration, turn.proof_signals || {}, ctx)
        : buildProgressClosing(turn.proof_signals || {}, ctx);
      assistantMessage =
        assistantMessage || "What you did counts — take a moment and let that land.";
    }

    const deterministicReply =
      !turn.ready_for_coaching ||
      coachState !== COACH_STATE.COACHING ||
      coachState === COACH_STATE.POST_PROOF_DEVALUATION ||
      coachState === COACH_STATE.WOUND_EDGE ||
      coachState === COACH_STATE.FLIP_INSTALL ||
      isPostProofDevaluationActive(turn.progress_integration) ||
      isWoundFlipActive(turn.progress_integration) ||
      Boolean(turn.progress_integration) ||
      Boolean(turn.check_in_progress?.continuity?.had_proof);

    if (deterministicReply) {
      const phase =
        coachState === COACH_STATE.WOUND_EDGE
          ? "wound_edge"
          : coachState === COACH_STATE.FLIP_INSTALL
            ? turn.session_phase === "flip_leverage"
              ? "flip_leverage"
              : "flip_install"
            : coachState === COACH_STATE.POST_PROOF_DEVALUATION
              ? turn.session_phase === "post_proof_devaluation_loop"
                ? "post_proof_devaluation_loop"
                : "post_proof_devaluation"
              : coachState === COACH_STATE.PROGRESS
                ? turn.session_phase || "proof_integration"
                : coachState === COACH_STATE.CHECK_IN
                  ? "check_in"
                  : turn.session_phase || "coaching";
      const { nextStage1 } = persistProgressTurn({
        stage1,
        map,
        domain,
        checkinState: coachState,
        gravityRating: req.body?.gravity_rating ?? null,
        messages,
        userMessage,
        assistantMessage,
        checkInProgress: turn.check_in_progress,
        progressIntegration: turn.progress_integration,
        coachState,
        phase:
          phase === "proof_integration_complete"
            ? "proof_integration"
            : phase === "wound_flip_complete"
              ? "wound_flip_complete"
              : phase === "wound_edge" || phase === "flip_leverage" || phase === "flip_install"
                ? phase
                : phase === "coaching"
                  ? "coaching"
                  : coachState === COACH_STATE.PROGRESS
                    ? "proof_integration"
                    : "check_in",
        writebackHints: {
          proof_logged: turn.progress_integration?.proof_logged,
          proof_priority: coachState === COACH_STATE.PROGRESS,
          diagnostic_observation: turn.diagnostic_observation || undefined,
        },
      });
      await persistStage1ForUser(user.id, nextStage1);
      return successResponse(res, "Coach reply", {
        domain,
        session_phase: phase,
        coach_state: coachState,
        assistant_message: assistantMessage,
        green_rep: null,
        detected_failure_strategy: null,
        writeback_hints: {
          proof_logged: turn.progress_integration?.proof_logged,
          diagnostic_observation: turn.diagnostic_observation || undefined,
        },
        progress_integration: turn.progress_integration,
        check_in_progress: turn.check_in_progress,
        checkin: {
          current_state: coachState,
          gravity_rating: req.body?.gravity_rating ?? null,
          message: userMessage,
        },
      });
    }

    checkInProgress = turn.check_in_progress;

    const checkin = {
      current_state: coachState,
      gravity_rating: req.body?.gravity_rating ?? null,
      message: userMessage,
      session_phase: "coaching",
      check_in_answers: turn.check_in_progress?.answers,
      progress_integration: turn.progress_integration,
      user_reported_proof: false,
    };

    const prompts = await loadCoachPromptBundle();
    const user_coach_context = await buildCoachUserContext(user, stage1, map, domain);
    user_coach_context.check_in_answers = turn.check_in_progress?.answers;
    user_coach_context.progress_signals = turn.proof_signals || {};
    user_coach_context.coaching_instructions =
      "Check-in and proof integration are complete. Assign ONE Green Rep only if clearly needed — not the rep they just completed.";

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

    const safeGreenRep = sanitizeCoachGreenRep(result.green_rep, {
      progressMode: coachState === COACH_STATE.PROGRESS,
      proofIntegrationActive: isProgressIntegrationActive(turn.progress_integration),
      postProofDevaluation: isPostProofDevaluationActive(turn.progress_integration),
      lastRepName: lastRep?.name,
      allowNewRep: Boolean(result.writeback_hints?.assign_new_green_rep),
      userReportedProof: checkin.user_reported_proof,
    });

    if (coachState === COACH_STATE.PROGRESS && !turn.progress_integration?.proof_logged) {
      const logged = maybeAutoLogProof(
        stage1,
        domain,
        userMessage,
        turn.proof_signals || {},
        lastRep?.name,
      );
      stage1 = logged.stage1;
    }

    const progressIntegrationDone = turn.progress_integration
      ? { ...turn.progress_integration, step: "complete" }
      : null;

    const { nextStage1, session_id } = persistProgressTurn({
      stage1,
      map,
      domain,
      checkinState: coachState,
      gravityRating: checkin.gravity_rating,
      messages,
      userMessage,
      assistantMessage: result.assistant_message,
      checkInProgress: turn.check_in_progress,
      progressIntegration: progressIntegrationDone,
      coachState,
      phase: coachState === COACH_STATE.PROGRESS ? "proof_integration" : "coaching",
      writebackHints: {
        ...(result.writeback_hints || {}),
        green_rep_completed: turn.proof_signals?.repCompleted,
      },
      greenRep: safeGreenRep,
    });

    await persistStage1ForUser(user.id, nextStage1);

    return successResponse(res, "Coach reply", {
      domain,
      session_phase:
        coachState === COACH_STATE.PROGRESS ? "proof_integration_complete" : "coaching",
      coach_state: coachState,
      assistant_message: result.assistant_message,
      green_rep: safeGreenRep,
      detected_failure_strategy: result.detected_failure_strategy || null,
      writeback_hints: result.writeback_hints || {},
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
      assistant_message: result.assistant_message,
      green_rep: result.green_rep || null,
    });
  } catch (err) {
    console.error("[frictionRescue]", err);
    return errorResponse(res, err.message || "Friction rescue failed", err.status || 502);
  }
};

/** GET /api/stage1/coach/history */
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

/** GET /api/stage1/coach/resume — messages for in-progress session (same domain, not ended) */
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
    const phase = open?.phase || "coaching";
    return successResponse(res, "Coach resume", {
      domain,
      messages,
      session_phase: phase,
      coach_state: open?.coach_state || null,
      check_in_progress: open?.check_in_progress || null,
      progress_integration: open?.progress_integration || null,
      awaiting_user: open?.awaiting_user ?? false,
    });
  } catch (err) {
    return errorResponse(res, err.message || "Failed to resume coach", err.status || 500);
  }
};

/** POST /api/stage1/coach/end — mark current open session as ended */
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
      const mapIdx = (afterEnd.domain_maps || []).findIndex((m) => m.domain === domain);
      if (mapIdx >= 0) {
        const maps = [...afterEnd.domain_maps];
        const openEntry = (maps[mapIdx].coaching_memory?.coaching_history || [])
          .slice()
          .reverse()
          .find((e) => e.session_id === session_id);
        const autoSummary = buildSessionSummaryFromCoachLog(openBeforeEnd);
        maps[mapIdx] = finalizeCoachingMemorySession(maps[mapIdx], {
          domain,
          session_id,
          session_summary: openEntry?.session_summary || autoSummary || null,
        });
        maps[mapIdx] = syncProofLogsToCoachingMemory(maps[mapIdx], afterEnd.proof_logs || []);
        nextStage1 = { ...afterEnd, domain_maps: maps };
      }
      await persistStage1ForUser(user.id, nextStage1);
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
};
