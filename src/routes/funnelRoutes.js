const express = require("express");
const asyncHandler = require("../helpers/asyncHandler");
const funnelController = require("../controllers/funnelController");

const router = express.Router();

// POST /api/funnel/create-token
// Called by Kajabi after opt-in. Requires x-kajabi-secret header.
router.post("/create-token", asyncHandler(funnelController.createToken));

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

module.exports = router;
