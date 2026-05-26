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
  endCoachSession,
} = require("../helpers/stage1CoachHistory");
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
    const stage1 = await loadStage1ForUser(user);
    const domain =
      normalizeDomain(req.body?.domain) || resolvePrimaryDomain(stage1);
    if (!domain) {
      return errorResponse(res, "No active domain. Complete Map Resistance first.", 400);
    }

    const map = (stage1.domain_maps || []).find((m) => m.domain === domain);
    if (!map) {
      return errorResponse(res, "Domain map not found", 404);
    }
    if (!map.map_resistance_complete) {
      return errorResponse(res, "Complete Map Resistance before daily coaching.", 400);
    }

    const checkin = {
      current_state: req.body?.state || req.body?.current_state || "clear",
      gravity_rating: req.body?.gravity_rating ?? null,
      message: req.body?.message || null,
    };

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const prompts = await loadCoachPromptBundle();
    const user_coach_context = await buildCoachUserContext(user, stage1, map, domain);
    const result = await aiService.coachReply({
      user_id: user.id,
      domain_map: map,
      active_goal_context: buildActiveGoalContext(map, domain),
      user_coach_context,
      checkin,
      messages,
      user_message: req.body?.message || null,
      prompts,
    });

    const nextStage1 = recordCoachCheckin(stage1, {
      domain,
      state: checkin.current_state,
      gravity_rating: checkin.gravity_rating,
      messages,
      user_message: req.body?.message || null,
      assistant_message: result.assistant_message,
      green_rep: result.green_rep || null,
    });
    await persistStage1ForUser(user.id, nextStage1);

    return successResponse(res, "Coach reply", {
      domain,
      assistant_message: result.assistant_message,
      green_rep: result.green_rep || null,
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
    const messages = getResumableCoachMessages(stage1, domain);
    return successResponse(res, "Coach resume", { domain, messages });
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
    const { stage1: nextStage1, ended, session_id } = endCoachSession(stage1, domain);
    if (ended) {
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
  coachCheckin,
  frictionRescue,
  getCoachHistory,
  getCoachResume,
  endCoachChat,
};
