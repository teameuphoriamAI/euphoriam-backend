/**
 * Pre-flight environment & database check script.
 *
 * Run before starting the server (or before deploying) to verify env vars, DB
 * connectivity, tables/columns, prompt enums, required prompt rows, and (optionally)
 * REQUIRE_IRL_PROMPT_V22=true → active invisible_red_line_report must look like v2.2.
 *
 * Usage:
 *   node src/scripts/preFlightCheck.js
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = one or more checks failed
 */

require("dotenv").config();
const { Sequelize, QueryTypes } = require("sequelize");

// ── Colour helpers ─────────────────────────────────────────────────────────────
const c = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

const PASS = c.green("  ✓");
const FAIL = c.red("  ✗");
const WARN = c.yellow("  ⚠");

let failures = 0;
let warnings = 0;

const pass = (msg) => console.log(`${PASS} ${msg}`);
const fail = (msg) => { console.log(`${FAIL} ${c.red(msg)}`); failures++; };
const warn = (msg) => { console.log(`${WARN} ${c.yellow(msg)}`); warnings++; };

// ── 1. Environment variables ────────────────────────────────────────────────

console.log(c.bold("\n── 1. Environment Variables ─────────────────────────────"));

const REQUIRED_VARS = [
  "DATABASE_URL",
  "JWT_ACCESS_SECRET",
  "OPENAI_API_KEY",
  "KAJABI_WEBHOOK_SECRET",
  "BREVO_API_KEY",
  "SENDER_EMAIL",
  "FRONTEND_URL",
];

const OPTIONAL_VARS = [
  ["JWT_FUNNEL_SECRET",         "funnel token isolation (falls back to funnel_<JWT_ACCESS_SECRET>)"],
  ["UC_SALES_URL",              "Unlimited Creator CTA in IRL report + expired page"],
  ["UC_OFFER_NAME",             "offer name displayed in Section 12"],
  ["UC_CTA_TEXT",               "CTA button label"],
  ["FUNNEL_LINK_VALIDITY_DAYS", "link validity window (default: 10)"],
  ["FUNNEL_ACCESS_WINDOW_DAYS", "access window after first use (default: 7)"],
  ["FUNNEL_MAX_DIAGNOSTICS",    "max diagnostics per email (default: 3)"],
  ["LOGO_URL",                  "logo in emails"],
  ["SUPABASE_URL",              "PDF storage"],
  ["SUPABASE_SERVICE_ROLE_KEY", "PDF storage"],
  ["SUPABASE_STORAGE_BUCKET_REPORTS", "PDF storage bucket"],
  ["REQUIRE_IRL_PROMPT_V22", "if true, fail pre-flight unless active IRL row looks like v2.2"],
];

for (const v of REQUIRED_VARS) {
  if (process.env[v]) {
    pass(`${v} is set`);
  } else {
    fail(`${v} is MISSING — required`);
  }
}

for (const [v, note] of OPTIONAL_VARS) {
  if (process.env[v]) {
    pass(`${v} is set`);
  } else {
    warn(`${v} not set — ${note}`);
  }
}

// ── 2. Database connection ──────────────────────────────────────────────────

console.log(c.bold("\n── 2. Database Connection ───────────────────────────────"));

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  fail("Cannot check DB — DATABASE_URL is missing");
  console.log(c.red(`\nPre-flight failed: ${failures} error(s), ${warnings} warning(s)\n`));
  process.exit(1);
}

const isSupabaseOrNeon =
  DATABASE_URL.includes("supabase.co") || DATABASE_URL.includes("neon.tech");

const sequelize = new Sequelize(DATABASE_URL, {
  dialect: "postgres",
  logging: false,
  dialectOptions: isSupabaseOrNeon
    ? { ssl: { require: true, rejectUnauthorized: false } }
    : { ssl: false },
  pool: { max: 2, min: 0, acquire: 10000, idle: 5000 },
});

(async () => {
  try {
    await sequelize.authenticate();
    pass("Database connection established");
  } catch (err) {
    fail(`Database connection failed: ${err.message}`);
    console.log(c.red(`\nPre-flight failed: ${failures} error(s), ${warnings} warning(s)\n`));
    await sequelize.close();
    process.exit(1);
  }

  // ── 3. Required tables ─────────────────────────────────────────────────────

  console.log(c.bold("\n── 3. Required Tables ───────────────────────────────────"));

  const REQUIRED_TABLES = [
    "users",
    "diagnostics",
    "chat",
    "prompts",
    "funnel_access",
  ];

  const [tableRows] = await sequelize.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    { type: QueryTypes.SELECT }
  );

  // pg returns an array of rows directly with QueryTypes.SELECT
  const tableResult = await sequelize.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
    { type: QueryTypes.SELECT }
  );
  const existingTables = new Set(tableResult.map((r) => r.tablename));

  for (const t of REQUIRED_TABLES) {
    if (existingTables.has(t)) {
      pass(`Table "${t}" exists`);
    } else {
      fail(`Table "${t}" is MISSING`);
    }
  }

  // ── 4. Required columns ────────────────────────────────────────────────────

  console.log(c.bold("\n── 4. Required Columns ──────────────────────────────────"));

  const REQUIRED_COLUMNS = [
    ["diagnostics", "report_type"],
    ["diagnostics", "funnel_access_id"],
    ["funnel_access", "link_token"],
    ["funnel_access", "email"],
    ["funnel_access", "is_blocked"],
  ];

  const columnResult = await sequelize.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'`,
    { type: QueryTypes.SELECT }
  );
  const existingCols = new Set(columnResult.map((r) => `${r.table_name}.${r.column_name}`));

  for (const [table, col] of REQUIRED_COLUMNS) {
    const key = `${table}.${col}`;
    if (existingCols.has(key)) {
      pass(`Column "${key}" exists`);
    } else {
      fail(`Column "${key}" is MISSING`);
    }
  }

  // ── 5. Enum values ─────────────────────────────────────────────────────────

  console.log(c.bold("\n── 5. Prompt Enum Values ────────────────────────────────"));

  const REQUIRED_ENUM_VALUES = [
    "invisible_red_line_report",
    "stage1_constraint_extraction",
    "market_research",
  ];

  try {
    const enumResult = await sequelize.query(
      `SELECT enumlabel FROM pg_enum
       JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
       WHERE pg_type.typname = 'enum_prompts_type'`,
      { type: QueryTypes.SELECT }
    );
    const enumValues = new Set(enumResult.map((r) => r.enumlabel));

    for (const v of REQUIRED_ENUM_VALUES) {
      if (enumValues.has(v)) {
        pass(`Enum value "${v}" exists`);
      } else {
        fail(`Enum value "${v}" is MISSING from enum_prompts_type`);
      }
    }
  } catch {
    warn('Could not check enum values (enum_prompts_type may not exist yet)');
  }

  // ── 6. Required prompt records ─────────────────────────────────────────────

  console.log(c.bold("\n── 6. Required Prompt Records ───────────────────────────"));

  const REQUIRED_PROMPTS = [
    "invisible_red_line_report",
    "stage1_constraint_extraction",
  ];

  try {
    const promptResult = await sequelize.query(
      `SELECT type, length(content) AS content_len
       FROM prompts
       WHERE type IN ('invisible_red_line_report', 'stage1_constraint_extraction', 'market_research')
         AND "isActive" = true`,
      { type: QueryTypes.SELECT }
    );
    const foundTypes = new Set(promptResult.map((r) => r.type));

    for (const pt of REQUIRED_PROMPTS) {
      if (foundTypes.has(pt)) {
        const row = promptResult.find((r) => r.type === pt);
        pass(`Prompt "${pt}" exists (${row.content_len} chars)`);
      } else {
        fail(`Prompt "${pt}" is MISSING from prompts table`);
      }
    }

    if (foundTypes.has("market_research")) {
      const row = promptResult.find((r) => r.type === "market_research");
      pass(`Prompt "market_research" exists (${row.content_len} chars)`);
    } else {
      warn('Prompt "market_research" not found — GPT will use built-in fallback');
    }
  } catch (err) {
    warn(`Could not check prompt records: ${err.message}`);
  }

  // ── 7. Optional strict IRL v2.2 (Phase E.2) ────────────────────────────────

  if (process.env.REQUIRE_IRL_PROMPT_V22 === "true") {
    console.log(c.bold("\n── 7. IRL prompt v2.2 (REQUIRE_IRL_PROMPT_V22) ─────────────"));

    try {
      const irlRows = await sequelize.query(
        `SELECT name, version
         FROM prompts
         WHERE type = 'invisible_red_line_report' AND "isActive" = true
         ORDER BY "createdAt" DESC
         LIMIT 1`,
        { type: QueryTypes.SELECT }
      );
      const irl = irlRows?.[0];
      if (!irl) {
        fail("REQUIRE_IRL_PROMPT_V22: no active invisible_red_line_report prompt row");
      } else {
        const name = String(irl.name || "").toLowerCase();
        const nameLooksV22 = name.includes("v2.2") || name.includes("2.2");
        const verNum = Number(irl.version);
        const versionLooksV22 = Number.isFinite(verNum) && verNum >= 2;
        if (nameLooksV22 || versionLooksV22) {
          pass(
            `Active IRL prompt passes v2.2 check (name="${irl.name}", version=${irl.version})`
          );
        } else {
          fail(
            `REQUIRE_IRL_PROMPT_V22: active IRL row does not look like v2.2 (name="${irl.name}", version=${irl.version}). Run npm run apply:irl-prompt-v22 or activate the correct DB row.`
          );
        }
      }
    } catch (err) {
      fail(`REQUIRE_IRL_PROMPT_V22 check failed: ${err.message}`);
    }
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log(c.bold("\n── Summary ───────────────────────────────────────────────"));
  if (failures === 0) {
    console.log(c.green(`\n  ✓ All checks passed${warnings > 0 ? ` (${warnings} warning(s))` : ""}.\n`));
  } else {
    console.log(c.red(`\n  ✗ Pre-flight failed: ${failures} error(s), ${warnings} warning(s).\n`));
    console.log(c.dim("  Fix the errors above before starting the server.\n"));
  }

  await sequelize.close();
  process.exit(failures > 0 ? 1 : 0);
})();
