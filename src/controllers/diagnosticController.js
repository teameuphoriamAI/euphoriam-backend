const { Diagnostic } = require("../models/diagnosticModel");
const validate = require("../helpers/validate");
const diagnosticSchema = require("../schemas/diagnosticSchema");
const { successResponse, errorResponse } = require("../utils/response");

const createDiagnostic = async (req, res) => {
  console.log("Creating diagnostic with data:", req.body);
  // const payload = validate(diagnosticSchema, req.body);
  // const diagnostic = await Diagnostic.create({
  //   ...payload,
  //   userId: req.user.sub,
  // });
  return successResponse(res, "Diagnostic saved", 201);
};

const listMine = async (req, res) => {
  const diagnostics = await Diagnostic.findAll({
    where: { userId: req.user.sub },
    order: [["createdAt", "DESC"]],
  });
  return successResponse(res, "Diagnostics fetched", diagnostics);
};

const listAll = async (_req, res) => {
  const diagnostics = await Diagnostic.findAll({
    order: [["createdAt", "DESC"]],
  });
  return successResponse(res, "Diagnostics fetched", diagnostics);
};

const getById = async (req, res) => {
  const diagnostic = await Diagnostic.findByPk(req.params.id);
  if (!diagnostic) {
    return errorResponse(res, "Diagnostic not found", 404);
  }

  if (
    diagnostic.userId !== req.user.sub &&
    req.user.role &&
    req.user.role !== "admin"
  ) {
    return errorResponse(res, "Forbidden", 403);
  }

  return successResponse(res, "Diagnostic fetched", diagnostic);
};

module.exports = { createDiagnostic, listMine, listAll, getById };

