const { Discovery } = require("../models/discoveryModel");
const { successResponse, errorResponse } = require("../utils/response");

const listMine = async (req, res) => {
  const discoveries = await Discovery.findAll({
    where: { userId: req.body.email },
    order: [["createdAt", "DESC"]],
  });
  return successResponse(res, "Discoveries fetched", discoveries);
};

const listAll = async (_req, res) => {
  const discoveries = await Discovery.findAll({
    order: [["createdAt", "DESC"]],
  });
  return successResponse(res, "Discoveries fetched", discoveries);
};

const getById = async (req, res) => {
  const discovery = await Discovery.findByPk(req.params.id);
  if (!discovery) {
    return errorResponse(res, "Discovery not found", 404);
  }

  if (
    discovery.userId !== req.user.sub &&
    req.user.role &&
    req.user.role !== "admin"
  ) {
    return errorResponse(res, "Forbidden", 403);
  }

  return successResponse(res, "Discovery fetched", discovery);
};

module.exports = { listMine, listAll, getById };


