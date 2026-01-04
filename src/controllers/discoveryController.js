const { Discovery } = require("../models/discoveryModel");
const { User } = require("../models/userModel");
const { sequelize } = require("../config/sequelize");
const { Op } = require("sequelize");
const { successResponse, errorResponse } = require("../utils/response");

const listMine = async (req, res) => {
  try {
    // If email is provided, search by email column, otherwise use userId
    const whereClause = req.body.email
      ? { email: req.body.email }
      : { userId: req.user?.sub || req.body.userId };

    const discoveries = await Discovery.findAll({
      where: whereClause,
      order: [["createdAt", "DESC"]],
    });
    return successResponse(res, "Discoveries fetched", discoveries);
  } catch (err) {
    console.error("[listMine] Error:", err);
    return errorResponse(
      res,
      err.message || "Failed to fetch discoveries",
      500
    );
  }
};

const listAll = async (_req, res) => {
  try {
    const discoveries = await Discovery.findAll({
      order: [["createdAt", "DESC"]],
    });
    return successResponse(res, "Discoveries fetched", discoveries);
  } catch (err) {
    console.error("[listAll] Error:", err);
    return errorResponse(
      res,
      err.message || "Failed to fetch discoveries",
      500
    );
  }
};

const getById = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return errorResponse(res, "Email is required", 400);
    }
    const finduser = await User.findOne({ where: { email } });
    if (!finduser) {
      return errorResponse(res, "user not found", 404);
    }
    // Search by email in the JSONB data field
    const discovery = await Discovery.findAll({
      where: { userId: finduser.id },
    });

    if (discovery.length <= 0) {
      return errorResponse(res, "Discovery not found", 404);
    }
    return successResponse(res, "Discovery fetched", discovery);
  } catch (err) {
    console.error("[getById] Error:", err);
    return errorResponse(res, err.message || "Failed to fetch discovery", 500);
  }
};

module.exports = { listMine, listAll, getById };
