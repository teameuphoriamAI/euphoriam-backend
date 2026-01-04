const express = require("express");
const asyncHandler = require("../helpers/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const discoveryController = require("../controllers/discoveryController");

const router = express.Router();

router.get(
  "/admin",
  auth,
  requireRole(["admin"]),
  asyncHandler(discoveryController.listAll)
);
router.post("/", auth, asyncHandler(discoveryController.listMine));
router.post(
  "/findByEmail",
  // requireRole(["admin"]),
  asyncHandler(discoveryController.getById)
);

module.exports = router;




