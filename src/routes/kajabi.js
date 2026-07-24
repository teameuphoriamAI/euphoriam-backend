const express = require("express");
const kajabiController = require("../controllers/kajabi");
const asyncHandler = require("../helpers/asyncHandler");
const auth = require("../middleware/auth");
const router = express.Router();

router.get("/", auth, asyncHandler(kajabiController.getAllMembers));
router.get(
  "/getCustomerByEmail",
  auth,
  asyncHandler(kajabiController.getCustomerByEmail),
);
router.post(
  "/getCustomerFullDetails",
  auth,
  asyncHandler(kajabiController.getCustomerFullDetails),
);
router.get(
  "/unlimited-creator-videos",
  auth,
  asyncHandler(kajabiController.getUnlimitedCreatorVideos),
);
router.get(
  "/product-videos",
  auth,
  asyncHandler(kajabiController.getProductVideosByTitle),
);
router.get(
  "/recommended-videos",
  auth,
  asyncHandler(kajabiController.getRecommendedVideos),
);

module.exports = router;
