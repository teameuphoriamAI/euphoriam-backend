const express = require("express");
const asyncHandler = require("../helpers/asyncHandler");
const funnelController = require("../controllers/funnelController");
const { funnelIpLimit, createTokenLimit } = require("../middleware/funnelRateLimit");

const router = express.Router();

// Apply IP rate limit to all funnel routes (skips /complete-diagnostic internally)
router.use(funnelIpLimit);

// ── Kajabi webhook secret middleware ──────────────────────────────────────────
// Applied only to create-token. All other routes are protected by signed JWT.
const requireKajabiSecret = (req, res, next) => {
  const secret = process.env.KAJABI_WEBHOOK_SECRET;
  if (!secret) return next(); // Not configured — skip in development
  const provided = req.headers["x-kajabi-secret"];
  if (!provided || provided !== secret) {
    return res.status(401).json({ status: false, error: "Unauthorized" });
  }
  next();
};

// POST /api/funnel/create-token
// Called by Kajabi after opt-in. Requires x-kajabi-secret header.
router.post(
  "/create-token",
  createTokenLimit,
  requireKajabiSecret,
  asyncHandler(funnelController.createToken)
);

// POST /api/funnel/validate-token
// Called by frontend on every funnel page load to verify access.
router.post("/validate-token", asyncHandler(funnelController.validateToken));

// POST /api/funnel/start-diagnostic
// Called when user clicks "Start Diagnostic". Returns session token for Socket.IO.
router.post("/start-diagnostic", asyncHandler(funnelController.startDiagnostic));

// POST /api/funnel/complete-diagnostic
// Internal route called by socket finalize flow. Not exposed to the public frontend directly.
router.post("/complete-diagnostic", asyncHandler(async (req, res) => {
  const { funnel_access_id, email, transcript, reportText, metrics, chat_id } = req.body;
  if (!funnel_access_id || !email) {
    return res.status(400).json({ status: false, error: "funnel_access_id and email are required" });
  }
  const result = await funnelController.completeDiagnostic({
    funnel_access_id,
    email,
    transcript,
    reportText,
    metrics,
    chat_id,
  });
  return res.json({ status: true, message: "Diagnostic completed", result });
}));

// GET /api/funnel/access-status
// Returns current window / usage status for the UI access bar.
router.get("/access-status", asyncHandler(funnelController.getAccessStatus));

// GET /api/funnel/expired
// Returns expiry reason and UC upgrade CTA for the expired page.
router.get("/expired", asyncHandler(funnelController.getExpiredMessage));

// POST /api/funnel/resend-report
// Re-sends the stored IRL report PDF to the user's email.
router.post("/resend-report", asyncHandler(funnelController.resendReport));

// GET /api/funnel/report/:diagnosticId
// Returns the sanitised IRL report for display on the frontend report page.
// Never exposes prompts, structured packets, or transcript data.
router.get("/report/:diagnosticId", asyncHandler(funnelController.getReport));

// GET /api/funnel/report/:diagnosticId/pdf
// Generates (or re-generates) the IRL PDF using latest renderer and streams it.
router.get("/report/:diagnosticId/pdf", asyncHandler(funnelController.downloadReportPdf));

// GET /api/funnel/diagnostics
// Returns the list of completed IRL diagnostics for the current funnel user (hub "Your Reports").
router.get("/diagnostics", asyncHandler(funnelController.getMyDiagnostics));

// GET /api/funnel/chats — funnel Q&A sessions for sidebar history
router.get("/chats", asyncHandler(funnelController.getMyFunnelChats));

// GET /api/funnel/chat/:chatId — read-only transcript
router.get("/chat/:chatId", asyncHandler(funnelController.getFunnelChatTranscript));

module.exports = router;
