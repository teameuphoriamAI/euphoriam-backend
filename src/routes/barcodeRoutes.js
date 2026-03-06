const express = require("express");
const asyncHandler = require("../helpers/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const barcodeController = require("../controllers/barcodeController");
const { UserRole } = require("../utils/types");
const router = express.Router();

router.post(
  "/create",
  // requireRole([UserRole.ADMIN]),
  asyncHandler(barcodeController.createBarcodeForProduct),
);
router.get(
  "/getAll",
  // requireRole([UserRole.ADMIN]),
  asyncHandler(barcodeController.getAllBarcode),
);
router.delete(
  "/delete/:id",
  // requireRole([UserRole.ADMIN]),
  asyncHandler(barcodeController.deleteBarcode),
);
module.exports = router;
