const { upsertDocuments, retrieveSimilarChunks } = require("../helpers/rag");
const { ingestSupabaseCourses } = require("../helpers/supabaseRag");
const { successResponse, errorResponse } = require("../utils/response");

const ingestDocuments = async (req, res) => {
  const { documents = [] } = req.body || {};
  if (!Array.isArray(documents) || !documents.length) {
    return errorResponse(res, "documents array is required", 400);
  }
  const created = await upsertDocuments(documents);
  return successResponse(res, "Documents ingested", {
    count: created.length,
    ids: created.map((d) => d.id),
  });
};

const searchDocuments = async (req, res) => {
  const { query, topK = 3, minSim = 0.2 } = req.body || {};
  if (!query) return errorResponse(res, "query is required", 400);
  const results = await retrieveSimilarChunks({ query, topK, minSim });
  return successResponse(res, "Documents retrieved", { results });
};

const ingestSupabase = async (_req, res) => {
  const result = await ingestSupabaseCourses();
  return successResponse(res, "Supabase bucket ingested", result);
};

module.exports = { ingestDocuments, searchDocuments, ingestSupabase };

