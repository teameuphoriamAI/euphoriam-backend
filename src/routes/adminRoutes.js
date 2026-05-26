const express = require("express");
const multer = require("multer");
const asyncHandler = require("../helpers/asyncHandler");
const adminController = require("../controllers/adminController");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const { errorResponse } = require("../utils/response");

const router = express.Router();

// Configure multer for PDF uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB for PDF files
  fileFilter: (req, file, cb) => {
    // Accept PDF files
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"), false);
    }
  },
});

// Error handler for multer errors
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return errorResponse(
        res,
        "File too large. Maximum file size is 50MB.",
        413,
      );
    }
    return errorResponse(res, `Upload error: ${err.message}`, 400);
  }
  if (err) {
    return errorResponse(res, err.message || "Upload error", 400);
  }
  next();
};

// All admin routes require authentication and admin role
router.use(auth);
router.use(requireRole("admin"));

// Admin login verification (already authenticated via auth middleware)
router.get("/verify", adminController.adminLogin);

// User management
router.get("/users", asyncHandler(adminController.getAllUsers));
router.get(
  "/users/:userId/reports",
  asyncHandler(adminController.getUserReports),
);

// Prompt management
router.get("/prompts", asyncHandler(adminController.getAllPrompts));
router.get("/prompts/:id", asyncHandler(adminController.getPromptById));
router.post("/prompts", asyncHandler(adminController.createPrompt));
router.put("/prompts/:id", asyncHandler(adminController.updatePrompt));
router.delete("/prompts/:id", asyncHandler(adminController.deletePrompt));
router.get(
  "/prompts/:id/history",
  asyncHandler(adminController.getPromptHistory),
);

// Stats
router.get("/stats", asyncHandler(adminController.getStats));
router.get("/getMonthlystats", asyncHandler(adminController.getMonthlystats));

// Market Research
router.get("/market-research", asyncHandler(adminController.getMarketResearch));
router.get("/market-research/export", asyncHandler(adminController.exportMarketResearchCsv));
router.post("/market-research/report", asyncHandler(adminController.generateMarketResearchReport));
// User Session management
router.post(
  "/user-sessions",
  upload.single("pdf"),
  handleMulterError,
  asyncHandler(adminController.uploadUserSession),
);
router.post(
  "/user-sessions/attach",
  asyncHandler(adminController.attachUserSessionToUser),
);
router.get("/user-sessions", asyncHandler(adminController.getAllUserSessions));
router.get(
  "/user-sessions/user",
  asyncHandler(adminController.getUserSessions),
);
router.get(
  "/user-sessions/latest",
  asyncHandler(adminController.getUserLatestSession),
);
router.patch(
  "/changeUserStatus/:id",
  asyncHandler(adminController.changeUserStatus),
);
router.delete("/deleteUser/:id", asyncHandler(adminController.deleteUser));

// Semantic search for user sessions (vector DB)
router.post(
  "/user-sessions/search",
  asyncHandler(adminController.searchUserSessionsSemantic),
);

router.get(
  "/user-sessions/:id",
  asyncHandler(adminController.singleUserSessionToUser),
);

module.exports = router;
