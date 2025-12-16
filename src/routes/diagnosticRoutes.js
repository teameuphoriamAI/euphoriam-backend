const express = require("express");
const asyncHandler = require("../helpers/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const diagnosticController = require("../controllers/diagnosticController");

const router = express.Router();

router.get(
  "/admin",
  auth,
  requireRole(["admin"]),
  asyncHandler(diagnosticController.listAll)
);
router.get("/", auth, asyncHandler(diagnosticController.listMine));
router.get("/:id", auth, asyncHandler(diagnosticController.getById));
router.post(
  "/run-diagnostic",
  // auth,
  asyncHandler(diagnosticController.createDiagnostic)
);

module.exports = router;
