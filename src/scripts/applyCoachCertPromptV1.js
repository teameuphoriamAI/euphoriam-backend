/**
 * Insert certification-aligned Coach Brain + daily coach overlay prompts (v1).
 *
 * Usage (from backend/):
 *   node src/scripts/applyCoachCertPromptV1.js
 *   node src/scripts/applyCoachCertPromptV1.js --dry-run
 *
 * Code guardrails remain in prompts.py; these rows tune voice only.
 */

const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const COACH_BRAIN_OVERLAY = `You are Nathan's daily coaching voice — human, present, and intention-led.

SESSION OPENING TONE:
- Meet the member where they are. No framework jargon.
- Ask what they want from today's session before pushing structure.
- When they share body or pressure language, acknowledge it briefly and gently link it to the pattern — not therapy.

RESISTANCE & STUCK LOOPS:
- Name the stuck loop in everyday words.
- One grounding question, then the smallest visible next step.
- Honour protective parts: they are trying to keep the member safe.

INTEGRATION:
- After insight, tie to one Green Rep and proof — keep it practical.
- Do not repeat the full map diagnosis every turn; assume they remember their structure.

FORBIDDEN IN MEMBER-FACING COPY:
- vortex, signature IDs, EO, lack channel, quantum, NLP meta-model terms, entity language.`;

const DAILY_COACH_OVERLAY = `Daily coach overlay — certification v1

Intention first: "What do you want from today's session?" (one sentence is enough).
Optional body check-in: "Where do you feel that?" — skippable.
Then coach toward flip-aligned action and proof.

When overwhelmed: calm, one question, smallest step — no scripts to read aloud.`;

const COACH_OPENING_OVERLAY = `Opening copy guidance (server sends first message; use for tone alignment):

Hey {first_name}. We're working on {goal}. Before we dive in — what do you want from today's session? One sentence is enough.`;

const METADATA = { model: "gpt-4o", temperature: 0.5, max_tokens: 4000 };

async function upsertPrompt(Prompt, sequelize, PromptType, type, name, content) {
  const maxV = await Prompt.max("version", { where: { type } });
  const nextVersion = (typeof maxV === "number" ? maxV : 0) + 1;

  await sequelize.transaction(async (t) => {
    await Prompt.update({ isActive: false }, { where: { type }, transaction: t });
    await Prompt.create(
      {
        name,
        type,
        content,
        isActive: true,
        version: nextVersion,
        metadata: METADATA,
      },
      { transaction: t },
    );
  });

  return nextVersion;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (dryRun) {
    console.log("[dry-run] Would insert certification overlays:");
    console.log("  - Coach Brain Prompt (overlay content appended via new active row)");
    console.log("  - stage1_daily_coach");
    console.log("  - stage1_coach_opening");
    console.log("Chars:", {
      coach_brain: COACH_BRAIN_OVERLAY.length,
      daily: DAILY_COACH_OVERLAY.length,
      opening: COACH_OPENING_OVERLAY.length,
    });
    return;
  }

  const { Prompt } = require("../models/promptModel");
  const { sequelize } = require("../config/sequelize");
  const { PromptType } = require("../utils/types");

  const results = {};

  results.coach_brain = await upsertPrompt(
    Prompt,
    sequelize,
    PromptType.COACHBRAINPROMPT,
    PromptType.COACHBRAINPROMPT,
    "Coach Brain — certification v1 voice",
    COACH_BRAIN_OVERLAY,
  );

  results.stage1_daily_coach = await upsertPrompt(
    Prompt,
    sequelize,
    PromptType.STAGE1_DAILY_COACH,
    PromptType.STAGE1_DAILY_COACH,
    "Stage 1 daily coach — certification v1",
    DAILY_COACH_OVERLAY,
  );

  results.stage1_coach_opening = await upsertPrompt(
    Prompt,
    sequelize,
    PromptType.STAGE1_COACH_OPENING,
    PromptType.STAGE1_COACH_OPENING,
    "Stage 1 coach opening — certification v1",
    COACH_OPENING_OVERLAY,
  );

  console.log("Applied Coach Certification Prompt v1:", results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
