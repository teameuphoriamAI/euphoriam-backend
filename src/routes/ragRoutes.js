const express = require("express");
const asyncHandler = require("../helpers/asyncHandler");
const ragController = require("../controllers/ragController");

const router = express.Router();

router.post("/documents", asyncHandler(ragController.ingestDocuments));
router.post("/search", asyncHandler(ragController.searchDocuments));
router.post("/ingest-supabase", asyncHandler(ragController.ingestSupabase));
router.post("/ingest-bucket", asyncHandler(ragController.ingestBucketPdfs));
router.post("/ingest-brain-prompt", asyncHandler(ragController.ingestBrainPrompt));
router.post("/extract-fine-tuning", asyncHandler(ragController.extractForFineTuning));

module.exports = router;

