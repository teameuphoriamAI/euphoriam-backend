/**
 * Phase A.4: Confirm DB has the expected active IRL row (after apply + cache refresh, content matches DB).
 *
 * Usage (from code/euphoriam-backend):
 *   node src/scripts/verifyActiveIrlPrompt.js
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const { Prompt } = require("../models/promptModel");
const { sequelize } = require("../config/sequelize");
const { PromptType } = require("../utils/types");

async function main() {
  const row = await Prompt.findOne({
    where: { type: PromptType.INVISIBLE_RED_LINE_REPORT, isActive: true },
    order: [["createdAt", "DESC"]],
    raw: true,
  });
  if (!row) {
    console.error("No active invisible_red_line_report prompt in DB.");
    process.exit(1);
  }
  const preview = (row.content || "").slice(0, 120).replace(/\s+/g, " ");
  console.log(
    JSON.stringify(
      {
        id: row.id,
        name: row.name,
        version: row.version,
        contentChars: (row.content || "").length,
        contentPreview: `${preview}…`,
        metadata: row.metadata,
      },
      null,
      2
    )
  );
  await sequelize.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
