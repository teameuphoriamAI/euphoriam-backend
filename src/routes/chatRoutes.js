const express = require("express");
const chatController = require("../controllers/chatController");
const asyncHandler = require("../helpers/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const router = express.Router();
router.post(
  "/getHistory",
  //   auth,
  //   requireRole(["admin"]),
  asyncHandler(chatController.getChatHistory)
);

module.exports = router;
