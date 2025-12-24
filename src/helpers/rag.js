const openai = require("../config/openai");
const { Document } = require("../models/documentModel");

const embedText = async (text) => {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return res.data?.[0]?.embedding || [];
};

const cosineSim = (a, b) => {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
};

const upsertDocuments = async (docs = []) => {
  const results = [];
  for (const doc of docs) {
    const chunk = doc.chunk || doc.content || "";
    const title = doc.title || "Document";
    const metadata = doc.metadata || {};
    const embedding = await embedText(chunk);
    const created = await Document.create({ title, chunk, metadata, embedding });
    results.push(created);
  }
  return results;
};

const retrieveSimilarChunks = async ({ query, topK = 3, minSim = 0.2 }) => {
  const embed = await embedText(query);
  const docs = await Document.findAll({ limit: 200 });
  const scored = docs
    .map((d) => ({
      doc: d,
      score: cosineSim(embed, d.embedding),
    }))
    .filter((s) => s.score >= minSim)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored.map((s) => ({
    title: s.doc.title,
    chunk: s.doc.chunk,
    metadata: s.doc.metadata,
    score: s.score,
  }));
};

module.exports = { upsertDocuments, retrieveSimilarChunks, embedText };

