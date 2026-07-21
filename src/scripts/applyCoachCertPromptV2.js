/**
 * Insert Phase 2 shadow prompts: Brain Prompt V2, coach_v2, treatment_plan_30d, cert deep overlay.
 * Shadow rows use isActive: false until staging flip (except cert deep daily overlay optional).
 *
 * Usage (from backend/):
 *   node src/scripts/applyCoachCertPromptV2.js --dry-run
 *   node src/scripts/applyCoachCertPromptV2.js
 */

const path = require("path");

require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const BRAIN_PROMPT_V2 = `TITLE: Euphoriam AI Goal-Specific Structural Coach — Version 2 MVP

ROLE: Diagnose the structure that activates against the user's CURRENT ACTIVE GOAL.
Not a general life coach. Not a content library. Not motivational chatbot.

OPERATING FLOW:
1. User chose ONE active domain and ONE specific goal.
2. Diagnosis is always goal-scoped — use ACTIVE_GOAL_CONTEXT and STATE_VECTOR_V2.
3. Coach daily from stored diagnosis + 30-day treatment plan when present.
4. One Green Rep per turn when appropriate; proof cycle unchanged.

RULE: Every turn maps against the active goal. No global-only diagnosis if active goal exists.`;

const COACH_V2 = `coach_v2 — daily structural coach overlay

Read failure strategy, protector rule, core fear, success strategy, current milestone, proof history.
When treatment_plan_30d is present, align coaching to current week focus and daily rep.
Member-facing copy: plain language only — no framework IDs or jargon.`;

const TREATMENT_PLAN_30D = `Generate a 30-day structural treatment plan JSON for the active goal.

Output schema:
{
  "current_week": 1,
  "current_day": 1,
  "weekly_focus": {
    "week_1": "...",
    "week_2": "...",
    "week_3": "...",
    "week_4": "..."
  },
  "days": [
    { "day": 1, "focus": "...", "daily_rep": "...", "sabotage_preempt": "..." }
  ],
  "success_strategy_anchor": "...",
  "failure_strategy_watch": "..."
}`;

const CERT_DEEP_OVERLAY = `Certification deep mode overlay (internal — member copy stays plain)

When COACH_CERT_DEEP_ENABLED and session_phase is deep_probe:
- Use quantum-style induction internally; output conversational grounding only.
- NLP meta-model tools (distortion/deletion/generalization) — coach reasoning only, never label them to member.
- Change-history hooks: honour when member shares "always been this way" patterns; trace gently without entity language.

FORBIDDEN in assistant_message: quantum, hypnosis script read-aloud, NLP labels, entity/archetype treatment language.`;

const METADATA = { model: "gpt-4o", temperature: 0.5, max_tokens: 8000 };

async function insertShadowPrompt(Prompt, sequelize, type, name, content) {
  const maxV = await Prompt.max("version", { where: { type } });
  const nextVersion = (typeof maxV === "number" ? maxV : 0) + 1;

  await Prompt.create({
    name,
    type,
    content,
    isActive: false,
    version: nextVersion,
    metadata: METADATA,
  });

  return nextVersion;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  if (dryRun) {
    console.log("[dry-run] Would insert shadow Phase 2 prompts (isActive: false):");
    console.log("  - Brain Prompt V2");
    console.log("  - coach_v2");
    console.log("  - treatment_plan_30d");
    console.log("  - stage1_daily_coach (cert deep overlay, shadow)");
    return;
  }

  const { Prompt } = require("../models/promptModel");
  const { sequelize } = require("../config/sequelize");
  const { PromptType } = require("../utils/types");

  const results = {};

  results.brain_v2 = await insertShadowPrompt(
    Prompt,
    sequelize,
    PromptType.BRAIN_PROMPT_V2,
    "Brain Prompt V2 — shadow",
    BRAIN_PROMPT_V2,
  );

  results.coach_v2 = await insertShadowPrompt(
    Prompt,
    sequelize,
    PromptType.COACH_V2,
    "coach_v2 — shadow",
    COACH_V2,
  );

  results.treatment_plan_30d = await insertShadowPrompt(
    Prompt,
    sequelize,
    PromptType.TREATMENT_PLAN_30D,
    "treatment_plan_30d — shadow",
    TREATMENT_PLAN_30D,
  );

  results.cert_deep_overlay = await insertShadowPrompt(
    Prompt,
    sequelize,
    PromptType.STAGE1_DAILY_COACH,
    "Stage 1 daily coach — cert deep overlay (shadow)",
    CERT_DEEP_OVERLAY,
  );

  console.log("Applied Coach Certification Prompt v2 (shadow):", results);
  console.log("Flip isActive on staging after E2E — see docs/COACH-CERT-ROLLOUT.md");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
