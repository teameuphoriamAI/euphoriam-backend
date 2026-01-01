const express = require("express");
const asyncHandler = require("../helpers/asyncHandler");
const adminController = require("../controllers/adminController");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");

const router = express.Router();

// All admin routes require authentication and admin role
router.use(auth);
router.use(requireRole("admin"));

// Admin login verification (already authenticated via auth middleware)
router.get("/verify", adminController.adminLogin);

// User management
router.get("/users", asyncHandler(adminController.getAllUsers));
router.get("/users/:userId/reports", asyncHandler(adminController.getUserReports));

// Prompt management
router.get("/prompts", asyncHandler(adminController.getAllPrompts));
router.get("/prompts/:id", asyncHandler(adminController.getPromptById));
router.post("/prompts", asyncHandler(adminController.createPrompt));
router.put("/prompts/:id", asyncHandler(adminController.updatePrompt));
router.delete("/prompts/:id", asyncHandler(adminController.deletePrompt));
router.get("/prompts/:id/history", asyncHandler(adminController.getPromptHistory));

// Stats
router.get("/stats", asyncHandler(adminController.getStats));

module.exports = router;



