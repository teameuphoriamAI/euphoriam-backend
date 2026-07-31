const { Document } = require("../models/documentModel");
const { embedText, cosineSim } = require("./rag");
const {
  retrieveDeterministicChunks,
  toBrainChunkResult,
} = require("./brainPromptChunking");

const BRAIN_DOCS_TTL_MS = Number(process.env.BRAIN_PROMPT_DOCS_CACHE_TTL_MS || 5 * 60 * 1000);

let _brainDocsCache = { docs: null, loadedAt: 0 };

const loadBrainPromptDocs = async ({ force = false } = {}) => {
  const now = Date.now();
  if (
    !force &&
    _brainDocsCache.docs &&
    now - _brainDocsCache.loadedAt < BRAIN_DOCS_TTL_MS
  ) {
    return _brainDocsCache.docs;
  }

  const docs = await Document.findAll({ limit: 500, order: [["id", "ASC"]] });
  const brainDocs = docs.filter((d) => d.metadata?.source === "brain_prompt");
  _brainDocsCache = { docs: brainDocs, loadedAt: now };
  return brainDocs;
};

const retrieveSemanticBrainChunks = async ({
  query,
  brainDocs,
  topK = 3,
  minSim = 0.22,
  excludeIds = new Set(),
}) => {
  if (!query?.trim() || !brainDocs.length) return [];

  const embed = await embedText(query);
  const scored = brainDocs
    .filter((d) => !excludeIds.has(String(d.id)))
    .map((d) => ({
      doc: d,
      score: cosineSim(embed, d.embedding),
    }))
    .filter((s) => s.score >= minSim)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored.map((s) => toBrainChunkResult(s.doc, s.score));
};

/**
 * Hybrid retrieval: deterministic signature + baseline sections, then semantic fill.
 */
const retrieveBrainPromptChunks = async ({
  query,
  signatureId = null,
  domain = null,
  topK = 6,
  minSim = 0.22,
}) => {
  const brainDocs = await loadBrainPromptDocs();
  if (!brainDocs.length) return [];

  const compositeQuery = [
    query,
    signatureId ? `signature ${signatureId}` : null,
    domain ? `domain ${domain}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const deterministic = retrieveDeterministicChunks(brainDocs, signatureId);
  const excludeIds = new Set(deterministic.map((d) => String(d.id)));

  const semanticSlots = Math.max(0, topK - deterministic.length);
  const semantic =
    semanticSlots > 0
      ? await retrieveSemanticBrainChunks({
          query: compositeQuery,
          brainDocs,
          topK: semanticSlots,
          minSim,
          excludeIds,
        })
      : [];

  return [...deterministic, ...semantic].slice(0, topK);
};

module.exports = {
  retrieveBrainPromptChunks,
  retrieveDeterministicChunks,
  loadBrainPromptDocs,
};
