#!/usr/bin/env node
/**
 * Set per-user free diagnostic cap (metadata.max_diagnostics).
 *
 * Usage:
 *   node src/scripts/setFunnelMaxDiagnostics.js --email=user@example.com --max=2
 *   node src/scripts/setFunnelMaxDiagnostics.js --email=user@example.com --max=2 --reset-count
 */
require("dotenv").config();

const { sequelize } = require("../config/sequelize");
const {
  getFunnelAccessByEmail,
  computeAccessStatus,
} = require("../helpers/funnelAccess");

const parseArgs = () => {
  const out = { email: null, max: null, resetCount: false };
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--email=")) out.email = arg.slice(8).trim().toLowerCase();
    if (arg.startsWith("--max=")) out.max = Number(arg.slice(6));
    if (arg === "--reset-count") out.resetCount = true;
  }
  return out;
};

(async () => {
  const { email, max, resetCount } = parseArgs();
  if (!email) {
    console.error("Missing --email=user@example.com");
    process.exit(1);
  }
  if (!Number.isFinite(max) || max < 0) {
    console.error("Missing or invalid --max=N (non-negative integer)");
    process.exit(1);
  }

  const cap = Math.floor(max);
  const sets = [
    `metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('max_diagnostics', :cap)`,
    `"updatedAt" = NOW()`,
  ];
  if (resetCount) {
    sets.push("diagnostics_completed_count = 0");
    sets.push("report_generated_count = 0");
  }

  await sequelize.query(
    `UPDATE funnel_access SET ${sets.join(", ")} WHERE LOWER(email) = :email`,
    { replacements: { email, cap } },
  );

  const row = await getFunnelAccessByEmail(email);
  if (!row) {
    console.error(`No funnel_access row for ${email}`);
    process.exit(1);
  }

  const status = computeAccessStatus(row);
  console.log(
    JSON.stringify(
      {
        email: row.email,
        max_diagnostics: status.max_diagnostics,
        diagnostics_completed_count: row.diagnostics_completed_count,
        diagnostics_remaining: status.diagnostics_remaining,
        can_start_new: status.can_start_new,
      },
      null,
      2,
    ),
  );

  await sequelize.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
