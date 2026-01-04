const pdfParse = require("pdf-parse");
const { supabase } = require("../config/supabase");
const { upsertDocuments } = require("./rag");

const { SUPABASE_COURSES_BUCKET } = process.env;

const chunkText = (text, maxLen = 1200) => {
  const parts = [];
  let cursor = 0;
  while (cursor < text.length) {
    parts.push(text.slice(cursor, cursor + maxLen));
    cursor += maxLen;
  }
  return parts;
};

const ingestSupabaseCourses = async (bucket = SUPABASE_COURSES_BUCKET) => {
  if (!bucket) {
    throw new Error("SUPABASE_COURSES_BUCKET is not set");
  }

  const { data: files, error: listErr } = await supabase.storage
    .from(bucket)
    .list("", { limit: 1000 });
  if (listErr) throw listErr;

  const pdfFiles = (files || []).filter((f) => f?.name?.toLowerCase().endsWith(".pdf"));
  const ingested = [];

  for (const file of pdfFiles) {
    const { data, error } = await supabase.storage.from(bucket).download(file.name);
    if (error) {
      console.error("[supabaseRag] download error", file.name, error);
      continue;
    }

    const arrayBuf = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    let text = "";
    try {
      const parsed = await pdfParse(buffer);
      text = parsed.text || "";
    } catch (err) {
      console.error("[supabaseRag] pdf parse error", file.name, err);
      continue;
    }

    const chunks = chunkText(text);
    const docs = chunks.map((chunk, idx) => ({
      title: `${file.name} [${idx + 1}/${chunks.length}]`,
      chunk,
      metadata: { source: "supabase_courses_bucket", file: file.name },
    }));

    const created = await upsertDocuments(docs);
    ingested.push(...created.map((c) => c.id));
  }

  return { count: ingested.length, ids: ingested };
};

/**
 * Ingest PDFs from a Supabase bucket for RAG (Retrieval Augmented Generation)
 * @param {string} bucket - Bucket name (e.g., "reports", "diagnostics")
 * @param {string} folder - Optional folder path within bucket (e.g., "diagnostics/")
 * @returns {Promise<{count: number, ids: number[], files: string[]}>}
 */
const ingestSupabaseBucketPdfs = async (
  bucket = process.env.SUPABASE_STORAGE_BUCKET_REPORTS || "reports",
  folder = ""
) => {
  if (!bucket) {
    throw new Error("Bucket name is required");
  }

  // List files in the bucket (optionally in a specific folder)
  // Note: Supabase list() returns folders and files, we need to filter for PDFs
  const { data: files, error: listErr } = await supabase.storage
    .from(bucket)
    .list(folder || "", { 
      limit: 1000, 
      sortBy: { column: "created_at", order: "desc" },
      offset: 0
    });
  
  if (listErr) {
    console.error("[supabaseRag] list error", folder, listErr);
    throw listErr;
  }

  const pdfFiles = (files || []).filter((f) => 
    f?.name?.toLowerCase().endsWith(".pdf") && !f.name.startsWith(".")
  );
  
  const ingested = [];
  const processedFiles = [];

  for (const file of pdfFiles) {
    const filePath = folder ? `${folder}/${file.name}` : file.name;
    
    try {
      const { data, error } = await supabase.storage.from(bucket).download(filePath);
      if (error) {
        console.error("[supabaseRag] download error", filePath, error);
        continue;
      }

      const arrayBuf = await data.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      let text = "";
      
      try {
        const parsed = await pdfParse(buffer);
        text = parsed.text || "";
      } catch (err) {
        console.error("[supabaseRag] pdf parse error", filePath, err);
        continue;
      }

      if (!text.trim()) {
        console.warn("[supabaseRag] Empty text extracted from", filePath);
        continue;
      }

      const chunks = chunkText(text, 1200);
      const docs = chunks.map((chunk, idx) => ({
        title: `${file.name} [${idx + 1}/${chunks.length}]`,
        chunk,
        metadata: { 
          source: bucket, 
          file: file.name,
          filePath: filePath,
          folder: folder || "root",
          extractedAt: new Date().toISOString()
        },
      }));

      const created = await upsertDocuments(docs);
      ingested.push(...created.map((c) => c.id));
      processedFiles.push(file.name);
      
      console.log(`[supabaseRag] Processed ${file.name}: ${chunks.length} chunks`);
    } catch (err) {
      console.error(`[supabaseRag] Error processing ${filePath}:`, err);
      continue;
    }
  }

  return { 
    count: ingested.length, 
    ids: ingested,
    files: processedFiles,
    bucket,
    folder 
  };
};

/**
 * Extract PDFs from Supabase bucket and format for GPT fine-tuning
 * Returns data in OpenAI fine-tuning format (JSONL)
 * @param {string} bucket - Bucket name
 * @param {string} folder - Optional folder path
 * @param {Object} options - Options for formatting
 * @param {string} options.systemPrompt - System prompt to prepend to each example
 * @param {Function} options.formatFunction - Custom function to format PDF text into training examples
 * @returns {Promise<{examples: Array, jsonl: string, count: number}>}
 */
const extractPdfsForFineTuning = async (
  bucket = process.env.SUPABASE_STORAGE_BUCKET_REPORTS || "reports",
  folder = "",
  options = {}
) => {
  const { systemPrompt, formatFunction } = options;
  
  if (!bucket) {
    throw new Error("Bucket name is required");
  }

  const { data: files, error: listErr } = await supabase.storage
    .from(bucket)
    .list(folder, { limit: 1000, sortBy: { column: "created_at", order: "desc" } });
  
  if (listErr) throw listErr;

  const pdfFiles = (files || []).filter((f) => 
    f?.name?.toLowerCase().endsWith(".pdf") && !f.name.startsWith(".")
  );
  
  const examples = [];
  const processedFiles = [];

  // Default format function: treat entire PDF as a single training example
  const defaultFormatFunction = (text, fileName) => {
    const content = systemPrompt 
      ? `${systemPrompt}\n\n${text}`
      : text;
    
    return {
      messages: [
        {
          role: "system",
          content: systemPrompt || "You are a helpful assistant that analyzes diagnostic reports."
        },
        {
          role: "user",
          content: `Analyze this diagnostic report from ${fileName}:`
        },
        {
          role: "assistant",
          content: text
        }
      ]
    };
  };

  const formatFn = formatFunction || defaultFormatFunction;

  for (const file of pdfFiles) {
    const filePath = folder ? `${folder}/${file.name}` : file.name;
    
    try {
      const { data, error } = await supabase.storage.from(bucket).download(filePath);
      if (error) {
        console.error("[fineTuning] download error", filePath, error);
        continue;
      }

      const arrayBuf = await data.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      let text = "";
      
      try {
        const parsed = await pdfParse(buffer);
        text = parsed.text || "";
      } catch (err) {
        console.error("[fineTuning] pdf parse error", filePath, err);
        continue;
      }

      if (!text.trim()) {
        console.warn("[fineTuning] Empty text extracted from", filePath);
        continue;
      }

      // Format the text into training examples
      const example = formatFn(text, file.name);
      examples.push(example);
      processedFiles.push(file.name);
      
      console.log(`[fineTuning] Processed ${file.name}`);
    } catch (err) {
      console.error(`[fineTuning] Error processing ${filePath}:`, err);
      continue;
    }
  }

  // Convert to JSONL format (one JSON object per line)
  const jsonl = examples.map(ex => JSON.stringify(ex)).join("\n");

  return {
    examples,
    jsonl,
    count: examples.length,
    files: processedFiles,
    bucket,
    folder
  };
};

module.exports = { 
  ingestSupabaseCourses,
  ingestSupabaseBucketPdfs,
  extractPdfsForFineTuning
};

