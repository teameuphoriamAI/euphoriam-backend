const express = require("express");
const multer = require("multer");
const asyncHandler = require("../helpers/asyncHandler");
const voiceController = require("../controllers/voiceController");
const errorResponse = require("../utils/response").errorResponse;

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB for video files
});

// Error handler for multer errors (file size, etc.)
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return errorResponse(
        res,
        `File too large. Maximum file size is 500MB. Your file exceeds this limit. If you're on a serverless platform (like Vercel), consider using direct upload to storage instead.`,
        413,
      );
    }
    return errorResponse(res, `Upload error: ${err.message}`, 400);
  }
  if (err) {
    return errorResponse(res, err.message || "Upload error", 400);
  }
  next();
};

router.post(
  "/",
  upload.single("voice"),
  handleMulterError,
  asyncHandler(voiceController.createVoiceNote),
);
router.post(
  "/attachUser",
  upload.single("voice"),
  handleMulterError,
  asyncHandler(voiceController.attachVoiceNoteToUser),
);
router.get("/getAll", asyncHandler(voiceController.getAll));
router.post(
  "/getLessonRecording",
  asyncHandler(voiceController.getLessonRecording),
);
router.post(
  "/updateCompletion",
  asyncHandler(voiceController.updateCompletion),
);
router.delete(
  "/deleteLessonRecording",
  asyncHandler(voiceController.deleteLessonRecording),
);
router.post(
  "/transcribe",
  upload.single("audio"),
  handleMulterError,
  asyncHandler(voiceController.transcribeRecording),
);

module.exports = router;
