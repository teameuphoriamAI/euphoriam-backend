const { User } = require("../models/userModel");
const { withDbSlot } = require("../config/sequelize");
const { errorResponse } = require("../utils/response");
const { getTier, TIERS } = require("../helpers/membershipDomains");

/**
 * Stage 1 (domains, coach, map resistance) requires a paid Creator Club tier.
 * Free funnel users use diagnostic routes only.
 */
const requirePaidStage1 = async (req, res, next) => {
  try {
    const id = req.user?.sub || req.user?.userId;
    if (!id) return errorResponse(res, "Not authenticated", 401);

    const user = await withDbSlot(() =>
      User.findByPk(id, { attributes: { exclude: ["password"] } }),
    );
    if (!user) return errorResponse(res, "User not found", 404);

    const tier = getTier(user);
    if (tier === TIERS.STANDARD) {
      return errorResponse(
        res,
        "Paid membership required for Goal Domains, Map Resistance, and Daily Coach. Complete a free diagnostic or upgrade your plan.",
        403,
      );
    }

    req.stage1User = user;
    return next();
  } catch (err) {
    return errorResponse(res, err.message || "Authorization failed", 500);
  }
};

module.exports = requirePaidStage1;
