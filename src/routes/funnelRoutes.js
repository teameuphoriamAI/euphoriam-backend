const express = require("express");
const asyncHandler = require("../helpers/asyncHandler");
const funnelAuth = require("../middleware/funnelAuth");
const funnelController = require("../controllers/funnelController");

const router = express.Router();

router.get("/access-status", funnelAuth, asyncHandler(funnelController.getAccessStatus));
router.post("/validate-token", asyncHandler(funnelController.validateToken));
router.get("/diagnostics", funnelAuth, asyncHandler(funnelController.listDiagnostics));
router.post("/start-diagnostic", funnelAuth, asyncHandler(funnelController.startDiagnostic));
router.post("/socket-session", funnelAuth, asyncHandler(funnelController.socketSession));
router.get("/chats", funnelAuth, asyncHandler(funnelController.listChats));
router.get("/chat/:chatId", funnelAuth, asyncHandler(funnelController.getChat));
router.get("/report/:diagnosticId/pdf", funnelAuth, asyncHandler(funnelController.getReportPdf));
router.get("/report/:diagnosticId", funnelAuth, asyncHandler(funnelController.getReport));
router.post("/resend-report", funnelAuth, asyncHandler(funnelController.resendReport));
router.get("/expired", asyncHandler(funnelController.getExpiredCopy));

module.exports = router;
