const { PromptType } = require("../utils/types");
const { getLatestPromptFromDb } = require("./euphoriamChatbot");
const { Document } = require("../models/documentModel");
const { upsertDocuments } = require("./rag");
const { buildBrainPromptDocuments } = require("./brainPromptChunking");
const { stage1FeatureFlags } = require("./stage1FeatureFlags");

const BRAIN_PROMPT_SOURCES = [
  { type: PromptType.BRAINPROMPT, label: "Brain Prompt" },
  { type: PromptType.COACHBRAINPROMPT, label: "Coach Brain Prompt" },
];

const deleteBrainPromptDocuments = async () => {
  const docs = await Document.findAll({ limit: 1000 });
  const ids = docs.filter((d) => d.metadata?.source === "brain_prompt").map((d) => d.id);
  if (!ids.length) return 0;
  await Document.destroy({ where: { id: ids } });
  return ids.length;
};

const ingestBrainPromptRag = async ({ includeV2 = null } = {}) => {
  const flags = stage1FeatureFlags();
  const useV2 = includeV2 ?? flags.brain_prompt_v2_shadow;

  const promptTypes = [...BRAIN_PROMPT_SOURCES];
  if (useV2) {
    promptTypes.push({ type: PromptType.BRAIN_PROMPT_V2, label: "Brain Prompt V2" });
  }

  const rows = [];
  for (const { type, label } of promptTypes) {
    const row = await getLatestPromptFromDb(type);
    const content = row?.content?.trim();
    if (!content) continue;
    rows.push(
      ...buildBrainPromptDocuments({
        content,
        promptType: label,
        version: String(row?.updatedAt || row?.id || "1"),
      }),
    );
  }

  if (!rows.length) {
    return { deleted: 0, count: 0, ids: [], message: "No Brain Prompt content found in DB" };
  }

  const deleted = await deleteBrainPromptDocuments();
  const created = await upsertDocuments(rows);

  return {
    deleted,
    count: created.length,
    ids: created.map((d) => d.id),
    prompt_types: [...new Set(rows.map((r) => r.metadata.prompt_type))],
    signature_chunks: rows.filter((r) => r.metadata.signature_id).length,
    baseline_chunks: rows.filter((r) =>
      ["uc_routing", "rep_library", "opposite_map", "signature_overview"].includes(r.metadata.section),
    ).length,
  };
};

module.exports = {
  ingestBrainPromptRag,
  deleteBrainPromptDocuments,
};
