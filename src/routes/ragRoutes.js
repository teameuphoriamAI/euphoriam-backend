const express = require("express");
const asyncHandler = require("../helpers/asyncHandler");
const ragController = require("../controllers/ragController");

const router = express.Router();

router.post("/documents", asyncHandler(ragController.ingestDocuments));
router.post("/search", asyncHandler(ragController.searchDocuments));
router.post("/ingest-supabase", asyncHandler(ragController.ingestSupabase));

module.exports = router;

