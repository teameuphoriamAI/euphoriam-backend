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
router.get(
  "/unlimited-creator-videos",
  asyncHandler(kajabiController.getUnlimitedCreatorVideos)
);
router.get(
  "/product-videos",
  asyncHandler(kajabiController.getProductVideosByTitle)
);
router.get(
  "/recommended-videos",
  asyncHandler(kajabiController.getRecommendedVideos)
);

module.exports = router;
