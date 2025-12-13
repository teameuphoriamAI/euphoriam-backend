const bcrypt = require("bcryptjs");
const userModel = require("../models/userModel");
const validate = require("../helpers/validate");
const loginSchema = require("../schemas/loginSchema");
const { successResponse, errorResponse } = require("../utils/response");
const { signAccessToken, signRefreshToken } = require("../utils/tokens");

const login = async (req, res) => {
  const { email, password } = validate(loginSchema, req.body);
  const user = await userModel.findOneWithPassword(email);

  if (!user || !user.password) {
    return errorResponse(res, "User Not Found", 401);
  }

  const isMatch = await bcrypt.compare(password, user.password);
  if (!isMatch) {
    return errorResponse(res, "Invalid credentials", 401);
  }

  const safeUser = user.toJSON();
  delete safeUser.password;

  const accessToken = signAccessToken({
    sub: safeUser.id,
    role: safeUser.role,
  });

  const refreshToken = signRefreshToken({
    sub: safeUser.id,
    role: safeUser.role,
  });

  return successResponse(
    res,
    "Login successful",
    { user: safeUser, accessToken, refreshToken },
    200
  );
};

module.exports = { login };
