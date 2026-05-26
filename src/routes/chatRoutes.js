const express = require("express");
const chatController = require("../controllers/chatController");
const asyncHandler = require("../helpers/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const router = express.Router();

// Reset in-progress diagnostic Q&A or discovery chat (DB + vector + fresh welcome)
router.post(
  "/reset",
  auth,
  asyncHandler(chatController.resetChatSession)
);

// Get chat history (traditional list)
router.post(
  "/getHistory",
  auth,
  asyncHandler(chatController.getChatHistory)
);

// Semantic search for chat history (vector DB)
router.post(
  "/search",
  auth,
  asyncHandler(chatController.searchChatHistorySemantic)
);

// Search across all history (chats + sessions)
router.post(
  "/search/all",
  auth,
  asyncHandler(chatController.searchAllChatAndSessionHistory)
);

module.exports = router;
