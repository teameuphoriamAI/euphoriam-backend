const { User } = require("../models/userModel");
const { withDbSlot } = require("../config/sequelize");
const { successResponse, errorResponse } = require("../utils/response");
const { normalizeDomain, DOMAIN_LABELS } = require("../constants/domains");
const {
  getTier,
  canAddStoredGoal,
  canActivateDomain,
  getTierLimits,
} = require("../helpers/membershipDomains");
const {
  computeOnboardingStatus,
  listDomainStatuses,
  buildHomeDashboard,
  upsertDomainMap,
  setActiveDomain,
  pickAllowedGoalFields,
  countStoredMaps,
  resolvePrimaryDomain,
  ensurePrimaryAfterGoalSave,
} = require("../helpers/stage1State");
const {
  loadStage1ForUser,
  persistStage1ForUser,
  migrateLegacyFromMetadata,
} = require("../helpers/stage1Repository");
const {
  buildActiveGoalContext,
  buildMapResistanceIntroText,
} = require("../helpers/stage1GoalContext");
const { extractGoalStructureFromTranscript } = require("../helpers/stage1MapResistanceExtract");
const { listMapResistanceHistory } = require("../helpers/stage1MapResistanceHistory");
const { mapResistanceChatViaPython } = require("../helpers/stage1MapResistanceViaAi");
const aiService = require("../clients/aiService");
const { chatbotDiagnosticFreeform } = require("./diagnosticController");
const { Chat } = require("../models/chatModel");

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

const buildHomePayload = (user, stage1) => {
  const onboarding_status = computeOnboardingStatus(stage1);
  const primary = resolvePrimaryDomain(stage1);
  const active_domains =
    (stage1.active_domains || []).length > 0
      ? stage1.active_domains
      : primary
        ? [primary]
        : [];
  return {
    membership_tier: getTier(user),
    onboarding_status,
    primary_domain: primary,
    active_domains,
    map_resistance_in_progress: Boolean(stage1.map_resistance_in_progress),
    show_create_goals_cta:
      onboarding_status === "none" || onboarding_status === "goals_draft",
    walkthrough_completed: Boolean(stage1.walkthrough_completed),
    dashboard: buildHomeDashboard(stage1),
  };
};

/** GET /api/stage1/home */
const getHome = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const stage1 = await loadStage1ForUser(user);
    return successResponse(res, "Stage 1 home", buildHomePayload(user, stage1));
  } catch (err) {
    return errorResponse(res, err.message || "Failed to load home", err.status || 500);
  }
};

/** GET /api/stage1/domains */
const listDomains = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const stage1 = await loadStage1ForUser(user);
    const tier = getTier(user);
    const items = listDomainStatuses(stage1, tier).map((row) => ({
      domain: row.domain,
      label: DOMAIN_LABELS[row.domain] || row.domain,
      status: row.status,
      goals_complete: row.map?.goals_complete ?? false,
      map_resistance_complete: row.map?.map_resistance_complete ?? false,
      goal_title: row.map?.goal_title ?? null,
      desired_outcome: row.map?.desired_outcome ?? null,
    }));
    const storedGoalsCount = countStoredMaps(stage1.domain_maps || []);
    const limits = getTierLimits(tier);
    return successResponse(res, "Domains listed", {
      membership_tier: tier,
      limits: {
        maxStoredGoals: limits.maxStoredGoals,
        maxActiveDomains: limits.maxActiveDomains,
        storedGoalsCount,
      },
      stored_goals_count: storedGoalsCount,
      domains: items,
    });
  } catch (err) {
    return errorResponse(res, err.message || "Failed to list domains", err.status || 500);
  }
};

/** GET /api/stage1/domains/:domain */
const getDomain = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = normalizeDomain(req.params.domain);
    if (!domain) return errorResponse(res, "Invalid domain", 400);

    const stage1 = await loadStage1ForUser(user);
    const map = (stage1.domain_maps || []).find((m) => m.domain === domain);

    if (!map) {
      return successResponse(res, "Domain not started", {
        domain,
        label: DOMAIN_LABELS[domain],
        status: "available",
        map: null,
        onboarding_status: computeOnboardingStatus(stage1),
      });
    }

    const isActive = (stage1.active_domains || []).includes(domain);
    return successResponse(res, "Domain detail", {
      domain,
      label: DOMAIN_LABELS[domain],
      status: isActive ? "active" : map.status === "stored" ? "stored" : "draft",
      map,
      is_primary: stage1.primary_domain === domain,
      onboarding_status: computeOnboardingStatus(stage1),
    });
  } catch (err) {
    return errorResponse(res, err.message || "Failed to load domain", err.status || 500);
  }
};

/** POST /api/stage1/domains — create or update goal */
const createOrUpdateDomain = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = normalizeDomain(req.body?.domain);
    if (!domain) return errorResponse(res, "Valid domain is required", 400);

    let stage1 = await loadStage1ForUser(user);
    const existing = (stage1.domain_maps || []).find((m) => m.domain === domain);
    const storedCount = countStoredMaps(stage1.domain_maps || []);

    if (!existing && !canAddStoredGoal(user, storedCount, false)) {
      return errorResponse(
        res,
        `Your plan allows up to ${getTierLimits(getTier(user)).maxStoredGoals} stored goals. Upgrade or remove a goal.`,
        403,
      );
    }

    const patch = pickAllowedGoalFields(req.body);
    if (patch.begin_map_resistance) {
      stage1 = { ...stage1, map_resistance_in_progress: true };
      delete patch.begin_map_resistance;
    }

    stage1 = upsertDomainMap(stage1, domain, patch);
    stage1 = ensurePrimaryAfterGoalSave(stage1, domain, getTierLimits(getTier(user)));
    stage1 = await persistStage1ForUser(user.id, stage1);

    return successResponse(res, "Domain goals saved", {
      domain,
      map: stage1.domain_maps.find((m) => m.domain === domain),
      ...buildHomePayload(user, stage1),
    });
  } catch (err) {
    return errorResponse(res, err.message || "Failed to save domain", err.status || 500);
  }
};

/** PATCH /api/stage1/domains/:domain */
const patchDomain = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = normalizeDomain(req.params.domain);
    if (!domain) return errorResponse(res, "Invalid domain", 400);

    let stage1 = await loadStage1ForUser(user);
    const existing = (stage1.domain_maps || []).find((m) => m.domain === domain);
    if (!existing) {
      return errorResponse(res, "Domain not found. POST to create goals first.", 404);
    }

    const patch = pickAllowedGoalFields(req.body);
    if (patch.begin_map_resistance) {
      stage1 = { ...stage1, map_resistance_in_progress: true };
      delete patch.begin_map_resistance;
    }
    if (req.body?.map_resistance_in_progress === false) {
      stage1 = { ...stage1, map_resistance_in_progress: false };
    }

    stage1 = upsertDomainMap(stage1, domain, patch);
    stage1 = await persistStage1ForUser(user.id, stage1);

    return successResponse(res, "Domain updated", {
      domain,
      map: stage1.domain_maps.find((m) => m.domain === domain),
      onboarding_status: computeOnboardingStatus(stage1),
    });
  } catch (err) {
    return errorResponse(res, err.message || "Failed to update domain", err.status || 500);
  }
};

/** PATCH /api/stage1/domains/:domain/activate */
const activateDomain = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = normalizeDomain(req.params.domain);
    if (!domain) return errorResponse(res, "Invalid domain", 400);

    let stage1 = await loadStage1ForUser(user);
    const existing = (stage1.domain_maps || []).find((m) => m.domain === domain);
    if (!existing) {
      return errorResponse(res, "Save goals for this domain before activating.", 404);
    }

    const activeCount = (stage1.domain_maps || []).filter((m) => m.status === "active").length;
    const alreadyActive = existing.status === "active";

    if (!alreadyActive && !canActivateDomain(user, activeCount, false)) {
      const tier = getTier(user);
      const limits = getTierLimits(tier);
      if (limits.maxActiveDomains === 1) {
        const result = setActiveDomain(stage1, domain, limits);
        if (!result.ok) return errorResponse(res, result.error, 400);
        stage1 = result.stage1;
      } else {
        return errorResponse(
          res,
          `Your plan allows ${limits.maxActiveDomains} active domain(s).`,
          403,
        );
      }
    } else {
      const result = setActiveDomain(stage1, domain, getTierLimits(getTier(user)));
      if (!result.ok) return errorResponse(res, result.error, 400);
      stage1 = result.stage1;
    }

    stage1 = await persistStage1ForUser(user.id, stage1);

    return successResponse(res, "Domain activated", {
      domain,
      ...buildHomePayload(user, stage1),
    });
  } catch (err) {
    return errorResponse(res, err.message || "Failed to activate domain", err.status || 500);
  }
};

/** GET /api/stage1/onboarding/status */
const getOnboardingStatus = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const stage1 = await loadStage1ForUser(user);
    return successResponse(res, "Onboarding status", {
      onboarding_status: computeOnboardingStatus(stage1),
      membership_tier: getTier(user),
      domain_maps_count: (stage1.domain_maps || []).length,
      walkthrough_completed: Boolean(stage1.walkthrough_completed),
    });
  } catch (err) {
    return errorResponse(res, err.message || "Failed", err.status || 500);
  }
};

/** POST /api/stage1/domains/:domain/map-resistance/chat — goal-scoped Q&A (reuses diagnostics/chatbot-freeform) */
const mapResistanceChat = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = normalizeDomain(req.params.domain);
    if (!domain) return errorResponse(res, "Invalid domain", 400);

    let stage1 = await loadStage1ForUser(user);
    const map = (stage1.domain_maps || []).find((m) => m.domain === domain);
    if (!map) {
      return errorResponse(res, "Domain not found. Save goals first.", 404);
    }
    if (!map.goals_complete) {
      return errorResponse(res, "Complete all goal fields before Map Resistance.", 400);
    }

    if (!stage1.map_resistance_in_progress) {
      stage1 = { ...stage1, map_resistance_in_progress: true };
      await persistStage1ForUser(user.id, stage1);
    }

    const activeGoalContext = buildActiveGoalContext(map, domain);

    if (req.body?.finalize) {
      return errorResponse(
        res,
        "Use POST /api/stage1/domains/:domain/map-resistance/finalize to complete Map Resistance (do not finalize via chat).",
        400,
      );
    }

    req.body.email = user.email;
    req.body.name = user.name;
    req.body.stage1MapResistance = true;
    req.body.activeDomain = domain;
    req.body.activeGoalContext = activeGoalContext;
    req.body.targetCount = req.body.targetCount || 12;
    req.body.introPageText =
      req.body.introPageText || buildMapResistanceIntroText(activeGoalContext);

    if (aiService.flags.mapResistance && aiService.isEnabled()) {
      return mapResistanceChatViaPython(req, res, { user, domain, map, stage1 });
    }

    return chatbotDiagnosticFreeform(req, res);
  } catch (err) {
    return errorResponse(res, err.message || "Map resistance chat failed", err.status || 500);
  }
};

/** POST /api/stage1/domains/:domain/map-resistance/finalize — extract structure + mark complete */
const finalizeMapResistance = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = normalizeDomain(req.params.domain);
    if (!domain) return errorResponse(res, "Invalid domain", 400);

    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (messages.length < 4) {
      return errorResponse(res, "Transcript too short to finalize Map Resistance.", 400);
    }

    let stage1 = await loadStage1ForUser(user);
    const map = (stage1.domain_maps || []).find((m) => m.domain === domain);
    if (!map) {
      return errorResponse(res, "Domain not found. Save goals first.", 404);
    }

    const activeGoalContext = buildActiveGoalContext(map, domain);
    const structure = await extractGoalStructureFromTranscript({
      transcript: messages,
      activeGoalContext,
      domain,
    });

    const completedAt = new Date().toISOString();
    stage1 = upsertDomainMap(stage1, domain, {
      ...structure,
      map_resistance_complete: true,
      map_resistance_transcript: messages,
      map_resistance_completed_at: completedAt,
    });
    stage1 = {
      ...stage1,
      map_resistance_in_progress: false,
    };

    const tierLimits = getTierLimits(getTier(user));
    stage1 = ensurePrimaryAfterGoalSave(stage1, domain, tierLimits);

    const activeResult = setActiveDomain(stage1, domain, tierLimits);
    if (activeResult.ok) {
      stage1 = activeResult.stage1;
    }

    stage1 = await persistStage1ForUser(user.id, stage1);

    try {
      const mrChat = await Chat.findOne({
        where: { userId: user.id, isChatEnded: false },
        order: [["updatedAt", "DESC"]],
      });
      if (mrChat?.data?.stage1MapResistance && mrChat?.data?.stage1MapResistanceDomain === domain) {
        await mrChat.update({
          isChatEnded: true,
          data: {
            ...mrChat.data,
            transcript: messages,
            mapResistanceCompletedAt: completedAt,
          },
        });
      }
    } catch (chatErr) {
      console.warn("[finalizeMapResistance] Could not close chat:", chatErr.message);
    }

    const updatedMap = (stage1.domain_maps || []).find((m) => m.domain === domain);

    return successResponse(res, "Map resistance complete", {
      domain,
      map: updatedMap,
      active_goal_context: activeGoalContext,
      ...buildHomePayload(user, stage1),
    });
  } catch (err) {
    console.error("[finalizeMapResistance]", err);
    return errorResponse(res, err.message || "Failed to finalize map resistance", err.status || 500);
  }
};

/** GET /api/stage1/map-resistance/history — all completed mappings for this user */
const getMapResistanceHistory = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = req.query?.domain
      ? normalizeDomain(String(req.query.domain))
      : null;
    const sessions = await listMapResistanceHistory(user, { domain });
    return successResponse(res, "Map resistance history", {
      sessions,
      count: sessions.length,
    });
  } catch (err) {
    return errorResponse(res, err.message || "Failed to load history", err.status || 500);
  }
};

/** GET /api/stage1/domains/:domain/map-resistance/history */
const getDomainMapResistanceHistory = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = normalizeDomain(req.params.domain);
    if (!domain) return errorResponse(res, "Invalid domain", 400);
    const sessions = await listMapResistanceHistory(user, { domain });
    return successResponse(res, "Domain map resistance history", {
      domain,
      label: DOMAIN_LABELS[domain],
      sessions,
      count: sessions.length,
    });
  } catch (err) {
    return errorResponse(res, err.message || "Failed to load history", err.status || 500);
  }
};

/** PATCH /api/stage1/walkthrough/complete */
const completeWalkthrough = async (req, res) => {
  try {
    const user = await resolveUser(req);
    let stage1 = await loadStage1ForUser(user);
    stage1 = {
      ...stage1,
      walkthrough_completed: true,
      walkthrough_completed_at: new Date().toISOString(),
    };
    await persistStage1ForUser(user.id, stage1);
    return successResponse(res, "Walkthrough completed", {
      walkthrough_completed: true,
      walkthrough_completed_at: stage1.walkthrough_completed_at,
    });
  } catch (err) {
    return errorResponse(res, err.message || "Failed to save walkthrough", err.status || 500);
  }
};

module.exports = {
  getHome,
  listDomains,
  getDomain,
  createOrUpdateDomain,
  patchDomain,
  activateDomain,
  getOnboardingStatus,
  completeWalkthrough,
  mapResistanceChat,
  finalizeMapResistance,
  getMapResistanceHistory,
  getDomainMapResistanceHistory,
  buildHomePayload,
};
