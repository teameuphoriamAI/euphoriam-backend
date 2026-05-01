/**
 * Phase A.2–A.3: Insert IRL prompt v2.2 from canonical markdown and deactivate prior rows.
 *
 * Prereqs: DATABASE_URL in .env (point at staging/prod as needed).
 * Complements Phase E.1 greenfield seed (canonical file); use this when the DB already has rows.
 *
 * Usage (from code/euphoriam-backend):
 *   node src/scripts/applyIrlPromptV22.js
 *   node src/scripts/applyIrlPromptV22.js --dry-run
 *
 * Phase A.4: Restart the staging API (or wait 5 minutes) so in-process prompt cache refreshes.
 * Phase A.5: Complete one staging funnel; save the generated report under docs/updated/samples/.
 */

const fs = require("fs");
const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const CANONICAL = path.join(
  __dirname,
  "../../../../docs/updated/invisible-red-line-report-prompt-v2.2.md"
);
const METADATA = { model: "gpt-4o", temperature: 0.4, max_tokens: 4000 };

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const content = fs.readFileSync(CANONICAL, "utf8").trim();
  if (!content) {
    console.error("Canonical prompt file is empty:", CANONICAL);
    process.exit(1);
  }

  if (dryRun) {
    console.log("[dry-run] Canonical prompt:", CANONICAL, `(${content.length} chars)`);
    console.log(
      "[dry-run] Would set all invisible_red_line_report rows to isActive=false, then INSERT v2.2 (version=max+1)."
    );
    return;
  }

  const { Prompt } = require("../models/promptModel");
  const { sequelize } = require("../config/sequelize");
  const { PromptType } = require("../utils/types");
  const TYPE = PromptType.INVISIBLE_RED_LINE_REPORT;

  const maxV = await Prompt.max("version", { where: { type: TYPE } });
  const nextVersion = (typeof maxV === "number" ? maxV : 0) + 1;

  console.log("Applying v2.2 prompt", {
    nextVersion,
    chars: content.length,
    canonical: CANONICAL,
  });

  await sequelize.transaction(async (t) => {
    await Prompt.update(
      { isActive: false },
      { where: { type: TYPE }, transaction: t }
    );
    await Prompt.create(
      {
        name: "Your hidden structure map generator v2.2",
        type: TYPE,
        content,
        isActive: true,
        version: nextVersion,
        metadata: METADATA,
      },
      { transaction: t }
    );
  });

  const active = await Prompt.findOne({
    where: { type: TYPE, isActive: true },
    order: [["createdAt", "DESC"]],
    raw: true,
  });
  console.log("Active row:", {
    id: active?.id,
    name: active?.name,
    version: active?.version,
    contentPreview: (active?.content || "").slice(0, 120).replace(/\s+/g, " ") + "…",
  });

  const activeCount = await Prompt.count({ where: { type: TYPE, isActive: true } });
  if (activeCount !== 1) {
    console.warn("Expected exactly one active IRL row; got:", activeCount);
  }

  console.log(
    "\nA.4: Restart staging backend or wait 5 minutes for prompt cache TTL.\n" +
      "A.5: Run one funnel on staging; save irlReport to docs/updated/samples/irl-v2.2-staging-sample.md\n"
  );

  await sequelize.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
