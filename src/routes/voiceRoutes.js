const express = require("express");
const multer = require("multer");
const asyncHandler = require("../helpers/asyncHandler");
const voiceController = require("../controllers/voiceController");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

router.post(
  "/",
  upload.single("voice"),
  asyncHandler(voiceController.createVoiceNote)
);

module.exports = router;


