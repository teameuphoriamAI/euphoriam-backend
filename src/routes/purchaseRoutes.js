const express = require("express");
const asyncHandler = require("../helpers/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const purchaseController = require("../controllers/purchaseController");

const router = express.Router();

router.get(
  "/admin",
  auth,
  requireRole(["admin"]),
  asyncHandler(purchaseController.listAll)
);
router.get("/", auth, asyncHandler(purchaseController.listMine));
router.get("/:id", auth, asyncHandler(purchaseController.getById));

module.exports = router;


