const express = require("express");
const multer = require("multer");
const asyncHandler = require("../helpers/asyncHandler");
const voiceController = require("../controllers/voiceController");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 155 * 1024 * 1024 }, // 15 MB
});

router.post(
  "/",
  upload.single("voice"),
  asyncHandler(voiceController.createVoiceNote)
);
router.post(
  "/attachUser",
  upload.single("voice"),
  asyncHandler(voiceController.attachVoiceNoteToUser)
);
router.get("/getAll", asyncHandler(voiceController.getAll));

module.exports = router;
