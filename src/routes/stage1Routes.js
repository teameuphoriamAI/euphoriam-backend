const express = require("express");
const auth = require("../middleware/auth");
const requirePaidStage1 = require("../middleware/requirePaidStage1");
const asyncHandler = require("../helpers/asyncHandler");
const stage1Controller = require("../controllers/stage1Controller");
const stage1CoachController = require("../controllers/stage1CoachController");
const stage1ProofController = require("../controllers/stage1ProofController");

const router = express.Router();
const stage1Auth = [auth, requirePaidStage1];

router.get("/home", ...stage1Auth, asyncHandler(stage1Controller.getHome));
router.get("/onboarding/status", ...stage1Auth, asyncHandler(stage1Controller.getOnboardingStatus));
router.patch(
  "/walkthrough/complete",
  ...stage1Auth,
  asyncHandler(stage1Controller.completeWalkthrough),
);
router.get("/domains", ...stage1Auth, asyncHandler(stage1Controller.listDomains));
router.get("/domains/:domain", ...stage1Auth, asyncHandler(stage1Controller.getDomain));
router.post("/domains", ...stage1Auth, asyncHandler(stage1Controller.createOrUpdateDomain));
router.patch("/domains/:domain", ...stage1Auth, asyncHandler(stage1Controller.patchDomain));
router.patch(
  "/domains/:domain/activate",
  ...stage1Auth,
  asyncHandler(stage1Controller.activateDomain),
);
router.post(
  "/domains/:domain/map-resistance/chat",
  ...stage1Auth,
  asyncHandler(stage1Controller.mapResistanceChat),
);
router.post(
  "/domains/:domain/map-resistance/finalize",
  ...stage1Auth,
  asyncHandler(stage1Controller.finalizeMapResistance),
);
router.post(
  "/domains/:domain/map-resistance/re-extract",
  ...stage1Auth,
  asyncHandler(stage1Controller.reExtractMapResistance),
);
router.get(
  "/map-resistance/history",
  ...stage1Auth,
  asyncHandler(stage1Controller.getMapResistanceHistory),
);
router.get(
  "/domains/:domain/map-resistance/history",
  ...stage1Auth,
  asyncHandler(stage1Controller.getDomainMapResistanceHistory),
);

router.post("/coach/checkin", ...stage1Auth, asyncHandler(stage1CoachController.coachCheckin));
router.get("/coach/history", ...stage1Auth, asyncHandler(stage1CoachController.getCoachHistory));
router.get("/coach/resume", ...stage1Auth, asyncHandler(stage1CoachController.getCoachResume));
router.post("/coach/end", ...stage1Auth, asyncHandler(stage1CoachController.endCoachChat));
router.post("/friction", ...stage1Auth, asyncHandler(stage1CoachController.frictionRescue));

router.post("/proof", ...stage1Auth, asyncHandler(stage1ProofController.postProof));
router.get(
  "/progress/:domain",
  ...stage1Auth,
  asyncHandler(stage1ProofController.getProgress),
);

module.exports = router;
