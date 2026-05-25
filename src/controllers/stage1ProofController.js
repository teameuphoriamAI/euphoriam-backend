const { User } = require("../models/userModel");
const { withDbSlot } = require("../config/sequelize");
const { successResponse, errorResponse } = require("../utils/response");
const { normalizeDomain } = require("../constants/domains");
const { resolvePrimaryDomain } = require("../helpers/stage1State");
const {
  loadStage1ForUser,
  persistStage1ForUser,
} = require("../helpers/stage1Repository");
const { recordProof, buildProgressPayload } = require("../helpers/stage1Proof");
const { buildHomePayload } = require("./stage1Controller");

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

/** POST /api/stage1/proof */
const postProof = async (req, res) => {
  try {
    const user = await resolveUser(req);
    let stage1 = await loadStage1ForUser(user);

    const domain =
      normalizeDomain(req.body?.domain) || resolvePrimaryDomain(stage1);
    const map = (stage1.domain_maps || []).find((m) => m.domain === domain);
    const dailyRep = map?.daily_rep;
    const greenRepName =
      req.body?.green_rep_name ||
      (typeof dailyRep === "object" ? dailyRep?.name : null) ||
      map?.today_visible_action ||
      null;

    const result = recordProof(stage1, {
      domain,
      action: req.body?.action,
      type: req.body?.type,
      green_rep_name: greenRepName,
    });

    if (!result.ok) {
      return errorResponse(res, result.error, result.status || 400);
    }

    stage1 = await persistStage1ForUser(user.id, result.stage1);

    return successResponse(res, "Proof logged", {
      proof: result.proof,
      domain,
      progress_metrics: result.progress_metrics,
      home: buildHomePayload(user, stage1),
    });
  } catch (err) {
    console.error("[postProof]", err);
    return errorResponse(res, err.message || "Failed to log proof", err.status || 500);
  }
};

/** GET /api/stage1/progress/:domain */
const getProgress = async (req, res) => {
  try {
    const user = await resolveUser(req);
    const stage1 = await loadStage1ForUser(user);
    const domain = normalizeDomain(req.params?.domain);
    if (!domain) {
      return errorResponse(res, "Invalid domain", 400);
    }

    const payload = buildProgressPayload(stage1, domain);
    if (!payload.progress_metrics) {
      return errorResponse(res, "Domain map not found", 404);
    }

    return successResponse(res, "Progress", payload);
  } catch (err) {
    console.error("[getProgress]", err);
    return errorResponse(res, err.message || "Failed to load progress", err.status || 500);
  }
};

module.exports = { postProof, getProgress };
