/**
 * Index Brain Prompt / Coach Brain Prompt into documents table for hybrid RAG.
 *
 * Usage (from backend/):
 *   node src/scripts/ingestBrainPromptRag.js
 *   node src/scripts/ingestBrainPromptRag.js --dry-run
 *   node src/scripts/ingestBrainPromptRag.js --include-v2
 */

const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const { buildBrainPromptDocuments } = require("../helpers/brainPromptChunking");
const { PromptType } = require("../utils/types");
const { getLatestPromptFromDb } = require("../helpers/euphoriamChatbot");

const dryRun = process.argv.includes("--dry-run");
const includeV2 = process.argv.includes("--include-v2");

async function main() {
  const { ingestBrainPromptRag } = require("../helpers/ingestBrainPromptRag");

  if (dryRun) {
    const brain = await getLatestPromptFromDb(PromptType.BRAINPROMPT);
    const coachBrain = await getLatestPromptFromDb(PromptType.COACHBRAINPROMPT);
    const docs = [
      ...(brain?.content
        ? buildBrainPromptDocuments({ content: brain.content, promptType: "Brain Prompt" })
        : []),
      ...(coachBrain?.content
        ? buildBrainPromptDocuments({ content: coachBrain.content, promptType: "Coach Brain Prompt" })
        : []),
    ];
    console.log("[dry-run] Would ingest", docs.length, "chunks");
    console.log(
      "  signature-tagged:",
      docs.filter((d) => d.metadata.signature_id).length,
    );
    console.log(
      "  baseline sections:",
      docs.filter((d) =>
        ["uc_routing", "rep_library", "opposite_map", "signature_overview"].includes(d.metadata.section),
      ).length,
    );
    process.exit(0);
  }

  const result = await ingestBrainPromptRag({ includeV2 });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
