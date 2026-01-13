const express = require("express");
const asyncHandler = require("../helpers/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const diagnosticController = require("../controllers/diagnosticController");

const router = express.Router();

// Specific routes must come before parameterized routes
router.get(
  "/admin",
  auth,
  requireRole(["admin"]),
  asyncHandler(diagnosticController.listAll)
);

router.post(
  "/chatbot-freeform",
  asyncHandler(diagnosticController.chatbotDiagnosticFreeform)
);

router.post(
  "/checkUser",
  asyncHandler(diagnosticController.findOrCreateCreatorUser)
);

router.get("/pdf-urls", asyncHandler(diagnosticController.getAllPdfUrls));

router.post("/pdf-urls", asyncHandler(diagnosticController.getAllPdfUrls));

// User metrics endpoint (for dashboard)
router.get("/metrics/user", asyncHandler(diagnosticController.getUserMetrics));

// Parameterized routes come last
router.get("/:id/metrics", asyncHandler(diagnosticController.getMetrics));
router.get("/:id", asyncHandler(diagnosticController.getById));
router.get(
  "/:id/dignostic",
  asyncHandler(diagnosticController.getDignosticById)
);

// Root routes
router.post("/", asyncHandler(diagnosticController.listMine));
router.get("/", asyncHandler(diagnosticController.listMine));

module.exports = router;
