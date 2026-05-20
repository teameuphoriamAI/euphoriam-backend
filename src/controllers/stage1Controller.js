const { User } = require("../models/userModel");
const { withDbSlot } = require("../config/sequelize");
const { successResponse, errorResponse } = require("../utils/response");
const { normalizeDomain, isValidDomain, DOMAIN_LABELS } = require("../constants/domains");
const {
  getTier,
  canAddStoredGoal,
  canActivateDomain,
  getTierLimits,
} = require("../helpers/membershipDomains");
const {
  getStage1FromUser,
  computeOnboardingStatus,
  listDomainStatuses,
  buildHomeDashboard,
  upsertDomainMap,
  setActiveDomain,
  pickAllowedGoalFields,
  countStoredMaps,
  emptyStage1State,
} = require("../helpers/stage1State");

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

const persistStage1 = async (user, stage1) => {
  const metadata = { ...(user.metadata || {}), stage1 };
  await user.update({ metadata });
  return metadata.stage1;
};

const buildHomePayload = (user, stage1) => {
  const onboarding_status = computeOnboardingStatus(stage1);
  return {
    membership_tier: getTier(user),
    onboarding_status,
    primary_domain: stage1.primary_domain,
    active_domains: stage1.active_domains || [],
    map_resistance_in_progress: Boolean(stage1.map_resistance_in_progress),
    show_create_goals_cta:
      onboarding_status === "none" || onboarding_status === "goals_draft",
    dashboard: buildHomeDashboard(stage1),
  };
};

/** GET /api/stage1/home */
const getHome = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const stage1 = getStage1FromUser(user);
    return successResponse(res, "Stage 1 home", buildHomePayload(user, stage1));
  } catch (err) {
    return errorResponse(res, err.message || "Failed to load home", err.status || 500);
  }
};

/** GET /api/stage1/domains */
const listDomains = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const stage1 = getStage1FromUser(user);
    const tier = getTier(user);
    const items = listDomainStatuses(stage1, tier).map((row) => ({
      domain: row.domain,
      label: DOMAIN_LABELS[row.domain] || row.domain,
      status: row.status,
      goals_complete: row.map?.goals_complete ?? false,
      map_resistance_complete: row.map?.map_resistance_complete ?? false,
    }));
    return successResponse(res, "Domains listed", {
      membership_tier: tier,
      limits: getTierLimits(tier),
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

    const stage1 = getStage1FromUser(user);
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

/** POST /api/stage1/domains — create or update goal (onboarding) */
const createOrUpdateDomain = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const domain = normalizeDomain(req.body?.domain);
    if (!domain) return errorResponse(res, "Valid domain is required", 400);

    let stage1 = getStage1FromUser(user);
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
      stage1 = {
        ...stage1,
        map_resistance_in_progress: true,
      };
      delete patch.begin_map_resistance;
    }

    stage1 = upsertDomainMap(stage1, domain, patch);
    await persistStage1(user, stage1);

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

    let stage1 = getStage1FromUser(user);
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
    await persistStage1(user, stage1);

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

    let stage1 = getStage1FromUser(user);
    const existing = (stage1.domain_maps || []).find((m) => m.domain === domain);
    if (!existing) {
      return errorResponse(res, "Save goals for this domain before activating.", 404);
    }

    const activeCount = (stage1.domain_maps || []).filter((m) => m.status === "active").length;
    const alreadyActive = existing.status === "active";

    if (
      !alreadyActive &&
      !canActivateDomain(user, activeCount, false)
    ) {
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

    await persistStage1(user, stage1);

    return successResponse(res, "Domain activated", {
      domain,
      ...buildHomePayload(user, stage1),
    });
  } catch (err) {
    return errorResponse(res, err.message || "Failed to activate domain", err.status || 500);
  }
};

/** GET /api/stage1/onboarding/status — helper for frontend wizard */
const getOnboardingStatus = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const stage1 = getStage1FromUser(user);
    return successResponse(res, "Onboarding status", {
      onboarding_status: computeOnboardingStatus(stage1),
      membership_tier: getTier(user),
      domain_maps_count: (stage1.domain_maps || []).length,
    });
  } catch (err) {
    return errorResponse(res, err.message || "Failed", err.status || 500);
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
};
