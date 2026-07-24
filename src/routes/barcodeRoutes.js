const express = require("express");
const asyncHandler = require("../helpers/asyncHandler");
const auth = require("../middleware/auth");
const barcodeController = require("../controllers/barcodeController");
const router = express.Router();

router.post("/create", auth, asyncHandler(barcodeController.createBarcodeForProduct));
router.get("/getAll", auth, asyncHandler(barcodeController.getAllBarcode));
router.delete("/delete/:id", auth, asyncHandler(barcodeController.deleteBarcode));

module.exports = router;
