const express = require("express");
const auth = require("../middleware/auth");
const asyncHandler = require("../helpers/asyncHandler");
const stage1Controller = require("../controllers/stage1Controller");

const router = express.Router();

router.get("/home", auth, asyncHandler(stage1Controller.getHome));
router.get("/onboarding/status", auth, asyncHandler(stage1Controller.getOnboardingStatus));
router.get("/domains", auth, asyncHandler(stage1Controller.listDomains));
router.get("/domains/:domain", auth, asyncHandler(stage1Controller.getDomain));
router.post("/domains", auth, asyncHandler(stage1Controller.createOrUpdateDomain));
router.patch("/domains/:domain", auth, asyncHandler(stage1Controller.patchDomain));
router.patch(
  "/domains/:domain/activate",
  auth,
  asyncHandler(stage1Controller.activateDomain),
);

module.exports = router;
