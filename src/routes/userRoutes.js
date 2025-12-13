const express = require("express");
const userController = require("../controllers/userController");
const asyncHandler = require("../helpers/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const router = express.Router();

router.get("/me", auth, asyncHandler(userController.getMe));
router.get(
  "/",
  auth,
  requireRole(["admin"]),
  asyncHandler(userController.listUsers)
);
router.post(
  "/",
  auth,
  requireRole(["admin"]),
  asyncHandler(userController.createUser)
);

module.exports = router;

