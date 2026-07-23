const { upsertDocuments, retrieveSimilarChunks } = require("../helpers/rag");
const { ingestBrainPromptRag } = require("../helpers/ingestBrainPromptRag");
const { 
  ingestSupabaseCourses, 
  ingestSupabaseBucketPdfs,
  extractPdfsForFineTuning 
} = require("../helpers/supabaseRag");
const { successResponse, errorResponse } = require("../utils/response");
const fs = require("fs");
const path = require("path");

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

/**
 * Ingest PDFs from a Supabase bucket for RAG
 * POST /api/rag/ingest-bucket
 * Body: { bucket?: string, folder?: string }
 */
const ingestBucketPdfs = async (req, res) => {
  try {
    const { bucket, folder = "" } = req.body || {};
    const result = await ingestSupabaseBucketPdfs(bucket, folder);
    return successResponse(res, "Bucket PDFs ingested for RAG", result);
  } catch (error) {
    console.error("[ragController] ingestBucketPdfs error:", error);
    return errorResponse(res, error.message || "Failed to ingest bucket PDFs", 500);
  }
};

/**
 * Extract PDFs from Supabase bucket and format for GPT fine-tuning
 * POST /api/rag/extract-fine-tuning
 * Body: { bucket?: string, folder?: string, systemPrompt?: string, saveFile?: boolean }
 * Returns: JSONL format data ready for OpenAI fine-tuning
 */
const extractForFineTuning = async (req, res) => {
  try {
    const { bucket, folder = "", systemPrompt, saveFile = false } = req.body || {};
    
    const result = await extractPdfsForFineTuning(bucket, folder, {
      systemPrompt,
    });

    // Optionally save JSONL file
    if (saveFile) {
      const outputDir = path.join(__dirname, "..", "..", "training-data");
      if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
      }
      
      const fileName = `fine-tuning-${bucket}-${Date.now()}.jsonl`;
      const filePath = path.join(outputDir, fileName);
      fs.writeFileSync(filePath, result.jsonl, "utf8");
      
      result.filePath = filePath;
      result.fileName = fileName;
    }

    return successResponse(res, "Fine-tuning data extracted", {
      ...result,
      // Include JSONL in response for direct download
      downloadUrl: saveFile ? `/training-data/${result.fileName}` : null,
    });
  } catch (error) {
    console.error("[ragController] extractForFineTuning error:", error);
    return errorResponse(res, error.message || "Failed to extract fine-tuning data", 500);
  }
};

const ingestBrainPrompt = async (req, res) => {
  try {
    const { include_v2: includeV2 } = req.body || {};
    const result = await ingestBrainPromptRag({
      includeV2: includeV2 === true || includeV2 === "true",
    });
    return successResponse(res, "Brain Prompt indexed for RAG", result);
  } catch (error) {
    console.error("[ragController] ingestBrainPrompt error:", error);
    return errorResponse(res, error.message || "Failed to ingest Brain Prompt", 500);
  }
};

module.exports = { 
  ingestDocuments, 
  searchDocuments, 
  ingestSupabase,
  ingestBucketPdfs,
  extractForFineTuning,
  ingestBrainPrompt,
};

