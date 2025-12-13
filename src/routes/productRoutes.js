const express = require("express");
const asyncHandler = require("../helpers/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const productController = require("../controllers/productController");

const router = express.Router();

router.get("/", auth, asyncHandler(productController.listProducts));
router.post(
  "/",
  auth,
  requireRole(["admin"]),
  asyncHandler(productController.createProduct)
);

module.exports = router;


