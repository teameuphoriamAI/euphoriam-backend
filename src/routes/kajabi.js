const express = require("express");
const kajabiController = require("../controllers/kajabi");
const asyncHandler = require("../helpers/asyncHandler");
const auth = require("../middleware/auth");
const requireRole = require("../middleware/requireRole");
const router = express.Router();
router.get(
  "/",
  //   auth,
  //   requireRole(["admin"]),
  asyncHandler(kajabiController.getAllMembers)
);
router.get(
  "/getCustomerByEmail",
  asyncHandler(kajabiController.getCustomerByEmail)
);
router.post(
  "/getCustomerFullDetails",
  asyncHandler(kajabiController.getCustomerFullDetails)
);

module.exports = router;
