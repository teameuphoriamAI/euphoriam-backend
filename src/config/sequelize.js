const { Sequelize } = require("sequelize");

const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const sequelize = new Sequelize(DATABASE_URL, {
  dialect: "postgres",
  logging: false,
  dialectOptions: {
    ssl: {
      require: true,
      rejectUnauthorized: false,
    },
  },
});

const backfillDiagnosticEmails = async () => {
  // Fill email from profile only for one row per email, avoiding unique violations
  await sequelize.query(
    `
    WITH candidates AS (
      SELECT
        id,
        data->'profile'->>'email' AS profile_email,
        ROW_NUMBER() OVER (
          PARTITION BY data->'profile'->>'email'
          ORDER BY id
        ) AS rn
      FROM "diagnostics"
      WHERE "email" IS NULL
        AND data->'profile'->>'email' IS NOT NULL
    )
    UPDATE "diagnostics" d
    SET "email" = c.profile_email
    FROM candidates c
    WHERE d.id = c.id
      AND c.rn = 1 -- only the first per email
      AND NOT EXISTS (
        SELECT 1 FROM "diagnostics" d2
        WHERE d2."email" = c.profile_email
      );
    `
  );
};

const findDuplicateDiagnosticEmails = async () => {
  const [rows] = await sequelize.query(`
    SELECT email, COUNT(*) AS count
    FROM "diagnostics"
    WHERE email IS NOT NULL
    GROUP BY email
    HAVING COUNT(*) > 1;
  `);
  return rows;
};

const ensureDiagnosticEmailUnique = async () => {
  const duplicates = await findDuplicateDiagnosticEmails();
  if (duplicates.length) {
    const sample = duplicates
      .slice(0, 5)
      .map((d) => `${d.email} (${d.count})`)
      .join(", ");
    throw new Error(
      `Duplicate diagnostic emails found. Please dedupe before starting. Examples: ${sample}`
    );
  }

  try {
    await sequelize.query(
      'ALTER TABLE "diagnostics" ADD CONSTRAINT "diagnostics_email_unique" UNIQUE ("email");'
    );
  } catch (err) {
    // 42710 = duplicate_object, 42P07 = duplicate_table/index
    const code = err?.original?.code;
    if (code !== "42710" && code !== "42P07") {
      throw err;
    }
  }
};

const initDb = async () => {
  await sequelize.authenticate();
  // Register models and associations before sync
  const models = require("../models");
  models.applyAssociations();

  // Sync all models together to respect FK dependencies (e.g., users before diagnostics)
  await sequelize.sync({ alter: true });

  // Backfill and enforce email uniqueness on diagnostics after tables exist
  await backfillDiagnosticEmails();
  await ensureDiagnosticEmailUnique();

  console.log("Database connected and synced");
  return models;
};

module.exports = { sequelize, initDb };
