const { User } = require("../models/userModel");
const { withDbSlot } = require("../config/sequelize");
const { successResponse, errorResponse } = require("../utils/response");
const { normalizeDomain, DOMAIN_LABELS } = require("../constants/domains");
const {
  MAP_RESISTANCE_TARGET_QUESTIONS,
} = require("../constants/mapResistance");
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
  setPrimaryDomain,
  deactivateDomain,
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
const {
  extractGoalStructureFromTranscript,
} = require("../helpers/stage1MapResistanceExtract");
const { transcriptsDiffer } = require("../helpers/stage1MapResistanceResume");
const {
  listMapResistanceHistory,
} = require("../helpers/stage1MapResistanceHistory");
const {
  mapResistanceChatViaPython,
} = require("../helpers/stage1MapResistanceViaAi");
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
    avatar_url: user?.metadata?.avatar_url || null,
  };
};

/** GET /api/stage1/home */
const getHome = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const stage1 = await loadStage1ForUser(user);
    return successResponse(res, "Stage 1 home", buildHomePayload(user, stage1));
  } catch (err) {
    console.error("[stage1] getHome failed:", err);
    const detail =
      err?.errors?.[0]?.message || err?.original?.message || err.message;
    return errorResponse(
      res,
      detail || "Failed to load home",
      err.status || 500,
    );
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
    console.error("[stage1] listDomains failed:", err);
    const detail =
      err?.errors?.[0]?.message || err?.original?.message || err.message;
    return errorResponse(
      res,
      detail || "Failed to list domains",
      err.status || 500,
    );
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
    const { applyProofMetricsToMap } = require("../helpers/stage1Proof");
    const proof_logs = Array.isArray(stage1.proof_logs)
      ? stage1.proof_logs
      : [];
    const { enrichMapForClient } = require("../helpers/stage1MapStructure");
    const {
      ensureInitialDiagnosticOnStage1,
    } = require("../helpers/stage1CoachingMemory");

    let stage1ForResponse = stage1;
    const { stage1: withDiagnostic, changed } = ensureInitialDiagnosticOnStage1(
      stage1,
      domain,
    );
    if (changed) {
      stage1ForResponse = await persistStage1ForUser(user.id, withDiagnostic);
    }

    const mapRow = (stage1ForResponse.domain_maps || []).find(
      (m) => m.domain === domain,
    );
    const mapForClient = enrichMapForClient(
      applyProofMetricsToMap({ ...mapRow }, proof_logs),
      {
        proof_logs,
        coach_session_log: stage1ForResponse.coach_session_log || [],
      },
    );

    return successResponse(res, "Domain detail", {
      domain,
      label: DOMAIN_LABELS[domain],
      status: isActive
        ? "active"
        : map.status === "stored"
          ? "stored"
          : "draft",
      map: mapForClient,
      is_primary: stage1.primary_domain === domain,
      onboarding_status: computeOnboardingStatus(stage1),
    });
  } catch (err) {
    return errorResponse(
      res,
      err.message || "Failed to load domain",
      err.status || 500,
    );
  }
};

/** POST /api/stage1/domains — create or update goal */
const createOrUpdateDomain = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = normalizeDomain(req.body?.domain);
    if (!domain) return errorResponse(res, "Valid domain is required", 400);

    let stage1 = await loadStage1ForUser(user);
    const existing = (stage1.domain_maps || []).find(
      (m) => m.domain === domain,
    );
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
    stage1 = ensurePrimaryAfterGoalSave(
      stage1,
      domain,
      getTierLimits(getTier(user)),
    );
    stage1 = await persistStage1ForUser(user.id, stage1);

    return successResponse(res, "Domain goals saved", {
      domain,
      map: stage1.domain_maps.find((m) => m.domain === domain),
      ...buildHomePayload(user, stage1),
    });
  } catch (err) {
    return errorResponse(
      res,
      err.message || "Failed to save domain",
      err.status || 500,
    );
  }
};

/** PATCH /api/stage1/domains/:domain */
const patchDomain = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = normalizeDomain(req.params.domain);
    if (!domain) return errorResponse(res, "Invalid domain", 400);

    let stage1 = await loadStage1ForUser(user);
    const existing = (stage1.domain_maps || []).find(
      (m) => m.domain === domain,
    );
    if (!existing) {
      return errorResponse(
        res,
        "Domain not found. POST to create goals first.",
        404,
      );
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
    return errorResponse(
      res,
      err.message || "Failed to update domain",
      err.status || 500,
    );
  }
};

/** PATCH /api/stage1/domains/:domain/activate */
const activateDomain = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = normalizeDomain(req.params.domain);
    if (!domain) return errorResponse(res, "Invalid domain", 400);

    let stage1 = await loadStage1ForUser(user);
    const existing = (stage1.domain_maps || []).find(
      (m) => m.domain === domain,
    );
    if (!existing) {
      return errorResponse(
        res,
        "Save goals for this domain before activating.",
        404,
      );
    }

    const activeCount = (stage1.domain_maps || []).filter(
      (m) => m.status === "active",
    ).length;
    const alreadyActive = existing.status === "active";

    if (!alreadyActive && !canActivateDomain(user, activeCount, false)) {
      const tier = getTier(user);
      const limits = getTierLimits(tier);
      if (limits.maxActiveDomains === 1) {
        const result = setActiveDomain(stage1, domain, limits, {
          setPrimary: true,
        });
        if (!result.ok) return errorResponse(res, result.error, 400);
        stage1 = result.stage1;
      } else {
        return errorResponse(
          res,
          `Your plan allows ${limits.maxActiveDomains} active domain(s). Deactivate another domain first.`,
          403,
        );
      }
    } else {
      const setPrimary =
        req.body?.set_primary === false
          ? false
          : req.body?.set_primary === true
            ? true
            : undefined;
      const result = setActiveDomain(
        stage1,
        domain,
        getTierLimits(getTier(user)),
        {
          setPrimary,
        },
      );
      if (!result.ok) return errorResponse(res, result.error, 400);
      stage1 = result.stage1;
    }

    stage1 = await persistStage1ForUser(user.id, stage1);

    return successResponse(res, "Domain activated", {
      domain,
      ...buildHomePayload(user, stage1),
    });
  } catch (err) {
    return errorResponse(
      res,
      err.message || "Failed to activate domain",
      err.status || 500,
    );
  }
};

/** PATCH /api/stage1/domains/:domain/primary — set Daily Coach focus (must be active) */
const setDomainPrimary = async (req, res) => {
  try {
    const user = await resolveUser(req);

    const domain = normalizeDomain(req.params.domain);
    if (!domain) return errorResponse(res, "Invalid domain", 400);

    let stage1 = await loadStage1ForUser(user);
    console.log("stage", stage1, "domain", domain);

    const result = setPrimaryDomain(stage1, domain);
    if (!result.ok) return errorResponse(res, result.error, 400);

    stage1 = await persistStage1ForUser(user.id, result.stage1);
    return successResponse(res, "Primary domain updated", {
      domain,
      ...buildHomePayload(user, stage1),
    });
  } catch (err) {
    return errorResponse(
      res,
      err.message || "Failed to set primary domain",
      err.status || 500,
    );
  }
};

/** PATCH /api/stage1/domains/:domain/deactivate — move active domain to stored */
const deactivateDomainHandler = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = normalizeDomain(req.params.domain);
    if (!domain) return errorResponse(res, "Invalid domain", 400);

    let stage1 = await loadStage1ForUser(user);
    const result = deactivateDomain(stage1, domain);
    if (!result.ok) return errorResponse(res, result.error, 400);

    stage1 = await persistStage1ForUser(user.id, stage1);
    return successResponse(res, "Domain deactivated", {
      domain,
      ...buildHomePayload(user, stage1),
    });
  } catch (err) {
    return errorResponse(
      res,
      err.message || "Failed to deactivate domain",
      err.status || 500,
    );
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
      return errorResponse(
        res,
        "Complete all goal fields before Map Resistance.",
        400,
      );
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
    req.body.targetCount =
      req.body.targetCount || MAP_RESISTANCE_TARGET_QUESTIONS;
    req.body.introPageText =
      req.body.introPageText || buildMapResistanceIntroText(activeGoalContext);

    if (aiService.flags.mapResistance && aiService.isEnabled()) {
      return mapResistanceChatViaPython(req, res, {
        user,
        domain,
        map,
        stage1,
      });
    }

    return chatbotDiagnosticFreeform(req, res);
  } catch (err) {
    return errorResponse(
      res,
      err.message || "Map resistance chat failed",
      err.status || 500,
    );
  }
};

/** POST /api/stage1/domains/:domain/map-resistance/finalize — extract structure + mark complete */
const finalizeMapResistance = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = normalizeDomain(req.params.domain);
    if (!domain) return errorResponse(res, "Invalid domain", 400);

    let messages = Array.isArray(req.body?.messages) ? req.body.messages : [];

    let stage1 = await loadStage1ForUser(user);
    const map = (stage1.domain_maps || []).find((m) => m.domain === domain);
    if (!map) {
      return errorResponse(res, "Domain not found. Save goals first.", 404);
    }

    if (messages.length < 4) {
      const saved = map.map_resistance_transcript;
      if (Array.isArray(saved) && saved.length >= 4) {
        messages = saved;
      }
    }
    if (messages.length < 4) {
      return errorResponse(
        res,
        "Transcript too short to finalize Map Resistance.",
        400,
      );
    }

    const {
      resolveFailureStrategyForMap,
    } = require("../helpers/stage1MapStructure");
    const savedTranscript = map.map_resistance_transcript;
    const remappingTranscript = transcriptsDiffer(messages, savedTranscript);
    const shouldReextract = Boolean(req.body?.reextract) || remappingTranscript;
    if (
      map.map_resistance_complete &&
      resolveFailureStrategyForMap(map) &&
      !shouldReextract
    ) {
      return errorResponse(
        res,
        "Map Resistance is already complete. Send reextract: true to refresh your structure.",
        400,
      );
    }

    const activeGoalContext = buildActiveGoalContext(map, domain);
    const structure = await extractGoalStructureFromTranscript({
      transcript: messages,
      activeGoalContext,
      domain,
    });

    const introText = buildMapResistanceIntroText(activeGoalContext);
    let reportResult = null;
    try {
      const {
        generateAndPersistMapResistanceReport,
      } = require("../helpers/stage1MapResistanceReport");
      reportResult = await generateAndPersistMapResistanceReport({
        user,
        domain,
        transcript: messages,
        activeGoalContext,
        introText,
        structure,
      });
    } catch (reportErr) {
      console.error(
        "[finalizeMapResistance] Report generation failed:",
        reportErr.message,
      );
    }

    const completedAt = new Date().toISOString();
    const existingMap = (stage1.domain_maps || []).find(
      (m) => m.domain === domain,
    );
    const preservedMemory = existingMap?.coaching_memory;

    stage1 = upsertDomainMap(stage1, domain, {
      ...structure,
      map_resistance_complete: true,
      map_resistance_transcript: messages,
      map_resistance_completed_at: completedAt,
      ...(reportResult?.reportText
        ? {
            diagnostic_report: reportResult.reportText,
            diagnostic_report_generated_at: completedAt,
            diagnostic_id: reportResult.diagnosticId,
            pdf_url: reportResult.pdfUrl,
          }
        : {}),
      ...(reportResult?.progressMetrics
        ? { progress_metrics: reportResult.progressMetrics }
        : {}),
      ...(preservedMemory ? { coaching_memory: preservedMemory } : {}),
    });

    const {
      captureInitialDiagnosticIfNeeded,
    } = require("../helpers/stage1CoachingMemory");
    const mapAfterMerge = (stage1.domain_maps || []).find(
      (m) => m.domain === domain,
    );
    const mapWithSnapshot = captureInitialDiagnosticIfNeeded(
      mapAfterMerge,
      activeGoalContext,
      domain,
    );
    if (mapWithSnapshot !== mapAfterMerge) {
      stage1 = upsertDomainMap(stage1, domain, {
        coaching_memory: mapWithSnapshot.coaching_memory,
      });
    }
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
      if (
        mrChat?.data?.stage1MapResistance &&
        mrChat?.data?.stage1MapResistanceDomain === domain
      ) {
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
      console.warn(
        "[finalizeMapResistance] Could not close chat:",
        chatErr.message,
      );
    }

    const updatedMapRaw = (stage1.domain_maps || []).find(
      (m) => m.domain === domain,
    );
    const { applyProofMetricsToMap } = require("../helpers/stage1Proof");
    const { enrichMapForClient } = require("../helpers/stage1MapStructure");
    const proof_logs = Array.isArray(stage1.proof_logs)
      ? stage1.proof_logs
      : [];
    const updatedMap = enrichMapForClient(
      applyProofMetricsToMap({ ...updatedMapRaw }, proof_logs),
      { proof_logs },
    );

    return successResponse(res, "Map resistance complete", {
      domain,
      map: updatedMap,
      active_goal_context: buildActiveGoalContext(updatedMap, domain),
      ...buildHomePayload(user, stage1),
    });
  } catch (err) {
    console.error("[finalizeMapResistance]", err);
    return errorResponse(
      res,
      err.message || "Failed to finalize map resistance",
      err.status || 500,
    );
  }
};

/** POST /api/stage1/domains/:domain/map-resistance/re-extract — rebuild structure from saved transcript */
const reExtractMapResistance = async (req, res) => {
  req.body = { ...(req.body || {}), reextract: true };
  return finalizeMapResistance(req, res);
};

/** POST /api/stage1/domains/:domain/map-resistance/regenerate-report — full Phase C report from saved transcript */
const regenerateMapResistanceReport = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = normalizeDomain(req.params.domain);
    if (!domain) return errorResponse(res, "Invalid domain", 400);

    let stage1 = await loadStage1ForUser(user);
    const map = (stage1.domain_maps || []).find((m) => m.domain === domain);
    if (!map) {
      return errorResponse(res, "Domain not found. Save goals first.", 404);
    }
    if (!map.map_resistance_complete) {
      return errorResponse(
        res,
        "Complete Map Resistance before regenerating the report.",
        400,
      );
    }

    const messages = map.map_resistance_transcript;
    if (!Array.isArray(messages) || messages.length < 4) {
      return errorResponse(
        res,
        "No saved Map Resistance transcript. Re-run Map Resistance first.",
        400,
      );
    }

    const activeGoalContext = buildActiveGoalContext(map, domain);
    const introText = buildMapResistanceIntroText(activeGoalContext);
    const {
      generateAndPersistMapResistanceReport,
    } = require("../helpers/stage1MapResistanceReport");

    const reportResult = await generateAndPersistMapResistanceReport({
      user,
      domain,
      transcript: messages,
      activeGoalContext,
      introText,
      structure: map,
      sendEmail: false,
    });

    const generatedAt = new Date().toISOString();
    stage1 = upsertDomainMap(stage1, domain, {
      diagnostic_report: reportResult.reportText,
      diagnostic_report_generated_at: generatedAt,
      diagnostic_id: reportResult.diagnosticId,
      pdf_url: reportResult.pdfUrl,
      ...(reportResult.progressMetrics
        ? { progress_metrics: reportResult.progressMetrics }
        : {}),
    });
    stage1 = await persistStage1ForUser(user.id, stage1);

    const updatedMapRaw = (stage1.domain_maps || []).find(
      (m) => m.domain === domain,
    );
    const { applyProofMetricsToMap } = require("../helpers/stage1Proof");
    const { enrichMapForClient } = require("../helpers/stage1MapStructure");
    const proof_logs = Array.isArray(stage1.proof_logs)
      ? stage1.proof_logs
      : [];
    const updatedMap = enrichMapForClient(
      applyProofMetricsToMap({ ...updatedMapRaw }, proof_logs),
      { proof_logs },
    );

    return successResponse(res, "Report regenerated", {
      domain,
      map: updatedMap,
      diagnostic_id: reportResult.diagnosticId,
      pdf_url: reportResult.pdfUrl,
      report_text: reportResult.reportText,
      report_complete: Boolean(reportResult.completeness?.complete),
      report_word_count: reportResult.completeness?.wordCount ?? 0,
      report_generated_at: generatedAt,
      active_goal_context: buildActiveGoalContext(updatedMap, domain),
      ...buildHomePayload(user, stage1),
    });
  } catch (err) {
    console.error("[regenerateMapResistanceReport]", err);
    return errorResponse(
      res,
      err.message || "Failed to regenerate report",
      err.status || 500,
    );
  }
};

/** GET /api/stage1/domains/:domain/map-resistance/report — full report text for this domain */
const getMapResistanceReport = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = normalizeDomain(req.params.domain);
    if (!domain) return errorResponse(res, "Invalid domain", 400);

    const stage1 = await loadStage1ForUser(user);
    const map = (stage1.domain_maps || []).find((m) => m.domain === domain);
    if (!map?.map_resistance_complete) {
      return errorResponse(res, "Complete Map Resistance first.", 400);
    }

    const reportText = map.diagnostic_report || null;
    if (!reportText || typeof reportText !== "string") {
      return errorResponse(
        res,
        "No report saved yet. Click Regenerate report to build your full diagnostic.",
        404,
      );
    }

    const {
      getReportCompletenessMeta,
    } = require("../helpers/euphoriamChatbot");
    const completeness = getReportCompletenessMeta(reportText);
    const pdfBase = map.pdf_url || null;
    const pdfUrl = pdfBase
      ? `${pdfBase}${String(pdfBase).includes("?") ? "&" : "?"}v=${Date.now()}`
      : null;

    return successResponse(res, "Map resistance report", {
      domain,
      report_text: reportText,
      report_complete: completeness.complete,
      report_word_count: completeness.wordCount,
      generated_at:
        map.diagnostic_report_generated_at ||
        map.map_resistance_completed_at ||
        null,
      diagnostic_id: map.diagnostic_id || null,
      pdf_url: pdfUrl,
      completeness,
    });
  } catch (err) {
    return errorResponse(
      res,
      err.message || "Failed to load report",
      err.status || 500,
    );
  }
};

/** POST /api/stage1/domains/:domain/map-resistance/restart — begin a new mapping session */
const restartMapResistance = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = normalizeDomain(req.params.domain);
    if (!domain) return errorResponse(res, "Invalid domain", 400);

    let stage1 = await loadStage1ForUser(user);
    const map = (stage1.domain_maps || []).find((m) => m.domain === domain);
    if (!map) {
      return errorResponse(res, "Domain not found. Save goals first.", 404);
    }
    if (!map.goals_complete && !String(map.goal_title || "").trim()) {
      return errorResponse(
        res,
        "Save your goal before starting Map Resistance.",
        400,
      );
    }

    try {
      const openChats = await Chat.findAll({
        where: { userId: user.id, isChatEnded: false },
        order: [["updatedAt", "DESC"]],
      });
      for (const chat of openChats) {
        const data = chat.data || {};
        if (
          data.stage1MapResistance &&
          data.stage1MapResistanceDomain === domain
        ) {
          await chat.update({
            isChatEnded: true,
            data: {
              ...data,
              endedReason: "remapping_restart",
            },
          });
        }
      }
    } catch (chatErr) {
      console.warn(
        "[restartMapResistance] Could not close open chat:",
        chatErr.message,
      );
    }

    stage1 = {
      ...stage1,
      map_resistance_in_progress: true,
    };
    stage1 = await persistStage1ForUser(user.id, stage1);

    return successResponse(res, "Map resistance restarted", {
      domain,
      remapping: Boolean(map.map_resistance_complete),
      map_resistance_in_progress: true,
    });
  } catch (err) {
    return errorResponse(
      res,
      err.message || "Failed to restart map resistance",
      err.status || 500,
    );
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
    return errorResponse(
      res,
      err.message || "Failed to load history",
      err.status || 500,
    );
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
    return errorResponse(
      res,
      err.message || "Failed to load history",
      err.status || 500,
    );
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
    return errorResponse(
      res,
      err.message || "Failed to save walkthrough",
      err.status || 500,
    );
  }
};

const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_AVATAR_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);
const AVATAR_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const AVATAR_BUCKET = () =>
  process.env.SUPABASE_STORAGE_BUCKET_AVATARS || "avatars";

const resolveAvatarStoragePath = (user) => {
  const metadata = user?.metadata || {};
  if (metadata.avatar_storage_path) return metadata.avatar_storage_path;
  const {
    objectPathFromPublicUrl,
  } = require("../utils/storage");
  return objectPathFromPublicUrl(metadata.avatar_url, AVATAR_BUCKET());
};

const removeStoredAvatar = async (user) => {
  const objectPath = resolveAvatarStoragePath(user);
  if (!objectPath) return;
  const { deleteObjectFromSupabase } = require("../utils/storage");
  await deleteObjectFromSupabase({
    objectPath,
    bucket: AVATAR_BUCKET(),
  });
};

/** PATCH /api/stage1/profile — update display name. */
const updateProfile = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const name = String(req.body?.name || "").trim();
    if (!name) {
      return errorResponse(res, "Name is required.", 400);
    }
    if (name.length > 120) {
      return errorResponse(res, "Name is too long (max 120 characters).", 400);
    }

    await withDbSlot(() =>
      User.update({ name }, { where: { id: user.id } }),
    );

    return successResponse(res, "Profile updated", { name });
  } catch (err) {
    console.error("[stage1] updateProfile failed:", err);
    return errorResponse(
      res,
      err.message || "Failed to update profile",
      err.status || 500,
    );
  }
};

/** DELETE /api/stage1/profile/avatar — remove avatar from storage and user metadata. */
const deleteAvatar = async (req, res) => {
  try {
    const user = await resolveUser(req);
    await removeStoredAvatar(user);

    const metadata = { ...(user.metadata || {}) };
    delete metadata.avatar_url;
    delete metadata.avatar_storage_path;

    await withDbSlot(() =>
      User.update({ metadata }, { where: { id: user.id } }),
    );

    return successResponse(res, "Avatar removed", { avatar_url: null });
  } catch (err) {
    console.error("[stage1] deleteAvatar failed:", err);
    return errorResponse(
      res,
      err.message || "Failed to remove avatar",
      err.status || 500,
    );
  }
};

/** POST /api/stage1/profile/avatar — upload avatar image to Supabase, save URL on user. */
const uploadAvatar = async (req, res) => {
  try {
    const user = await resolveUser(req);

    const raw = req.body?.image || req.body?.image_base64 || "";
    let contentType = req.body?.content_type || "";
    let base64 = String(raw);

    // Support data URLs: data:image/png;base64,XXXX
    const dataUrlMatch = base64.match(/^data:([^;]+);base64,(.*)$/s);
    if (dataUrlMatch) {
      contentType = contentType || dataUrlMatch[1];
      base64 = dataUrlMatch[2];
    }

    contentType = String(contentType || "").toLowerCase().trim();
    if (!base64) {
      return errorResponse(res, "No image provided.", 400);
    }
    if (!ALLOWED_AVATAR_TYPES.has(contentType)) {
      return errorResponse(
        res,
        "Unsupported image type. Use PNG, JPG, WEBP, or GIF.",
        400,
      );
    }

    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length) {
      return errorResponse(res, "Invalid image data.", 400);
    }
    if (buffer.length > MAX_AVATAR_BYTES) {
      return errorResponse(res, "Image too large (max 5MB).", 400);
    }

    await removeStoredAvatar(user);

    const { uploadBufferToSupabase } = require("../utils/storage");
    const ext = AVATAR_EXT[contentType] || "png";
    const objectPath = `avatars/${user.id}-${Date.now()}.${ext}`;
    const bucket = AVATAR_BUCKET();
    const { url } = await uploadBufferToSupabase({
      buffer,
      objectPath,
      bucket,
      contentType,
    });

    const metadata = {
      ...(user.metadata || {}),
      avatar_url: url,
      avatar_storage_path: objectPath,
    };
    await withDbSlot(() =>
      User.update({ metadata }, { where: { id: user.id } }),
    );

    return successResponse(res, "Avatar updated", { avatar_url: url });
  } catch (err) {
    console.error("[stage1] uploadAvatar failed:", err);
    return errorResponse(
      res,
      err.message || "Failed to upload avatar",
      err.status || 500,
    );
  }
};

module.exports = {
  getHome,
  updateProfile,
  uploadAvatar,
  deleteAvatar,
  listDomains,
  getDomain,
  createOrUpdateDomain,
  patchDomain,
  activateDomain,
  setDomainPrimary,
  deactivateDomainHandler,
  getOnboardingStatus,
  completeWalkthrough,
  mapResistanceChat,
  finalizeMapResistance,
  reExtractMapResistance,
  regenerateMapResistanceReport,
  getMapResistanceReport,
  restartMapResistance,
  getMapResistanceHistory,
  getDomainMapResistanceHistory,
  buildHomePayload,
};
