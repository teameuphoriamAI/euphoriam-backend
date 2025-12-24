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

module.exports = { ingestSupabaseCourses };

