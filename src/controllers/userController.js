const userModel = require("../models/userModel");
const userSchema = require("../schemas/userSchema");
const validate = require("../helpers/validate");
const { successResponse, errorResponse } = require("../utils/response");
const { User } = require("../models/userModel");
const { Purchase } = require("../models/purchaseModel");
const { Product } = require("../models/productModel");
const { Diagnostic } = require("../models/diagnosticModel");
const { Discovery } = require("../models/discoveryModel");
const { CoachingSession } = require("../models/coachingSessionModel");

const listUsers = async (_req, res) => {
  const users = await userModel.getAll();
  return successResponse(res, "Users fetched", users);
};

const createUser = async (req, res) => {
  const payload = validate(userSchema, req.body);
  const findUser = await userModel.findOne(payload.email);
  if (findUser) {
    return errorResponse(res, "User with this email already exists", 401);
  }
  const user = await userModel.create(payload);
  return successResponse(res, "User created", user, 201);
};

const getMe = async (req, res) => {
  const user = await User.findByPk(req.user.sub, {
    attributes: { exclude: ["password"] },
    include: [
      { model: Purchase, include: [{ model: Product }] },
      { model: Diagnostic },
      { model: Discovery },
      { model: CoachingSession },
    ],
  });

  if (!user) {
    return errorResponse(res, "User not found", 404);
  }

  return successResponse(res, "User fetched", user);
};

module.exports = { listUsers, createUser, getMe };
