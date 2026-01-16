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
  pool: {
    max: 20, // Maximum number of connections in pool (increased from 10)
    min: 2, // Minimum number of connections in pool
    acquire: 60000, // Maximum time (ms) to wait for a connection
    idle: 10000, // Maximum time (ms) a connection can be idle before being released
    evict: 1000, // Interval (ms) to check for idle connections
  },
  retry: {
    max: 3,
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

  // Handle membership column type conversion if needed
  try {
    await sequelize.query(`
      DO $$ 
      BEGIN
        -- Check if membership column exists
        IF EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'membership'
        ) THEN
          -- Check if it's not already JSONB
          IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'users' 
            AND column_name = 'membership' 
            AND data_type != 'jsonb'
          ) THEN
            -- Convert membership column to JSONB with proper casting
            ALTER TABLE "users" 
            ALTER COLUMN "membership" TYPE JSONB 
            USING CASE 
              WHEN "membership" IS NULL THEN NULL::jsonb
              WHEN "membership"::text = '' THEN NULL::jsonb
              ELSE "membership"::text::jsonb
            END;
          END IF;
        END IF;
      END $$;
    `);
  } catch (err) {
    // If column doesn't exist or conversion fails, that's fine - sync will handle it
    console.log("Membership column migration:", err.message);
  }

  // Add missing columns to diagnostics table if they don't exist
  try {
    await sequelize.query(`
      DO $$ 
      BEGIN
        -- Add chatId column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'diagnostics' 
          AND column_name = 'chatId'
        ) THEN
          ALTER TABLE "diagnostics" ADD COLUMN "chatId" INTEGER;
        END IF;

        -- Add pdfUrl column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'diagnostics' 
          AND column_name = 'pdfUrl'
        ) THEN
          ALTER TABLE "diagnostics" ADD COLUMN "pdfUrl" VARCHAR(255);
        END IF;

        -- Add report column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'diagnostics' 
          AND column_name = 'report'
        ) THEN
          ALTER TABLE "diagnostics" ADD COLUMN "report" TEXT;
        END IF;
      END $$;
    `);
    console.log("Diagnostics table columns migration completed");
  } catch (err) {
    console.log("Diagnostics columns migration:", err.message);
  }

  // Handle voice_notes table migrations
  try {
    await sequelize.query(`
      DO $$ 
      BEGIN
        -- Drop any existing foreign key constraints on diagnosticEmail
        IF EXISTS (
          SELECT 1 FROM information_schema.table_constraints 
          WHERE table_name = 'voice_notes' 
          AND constraint_name LIKE '%diagnosticEmail%'
          AND constraint_type = 'FOREIGN KEY'
        ) THEN
          ALTER TABLE "voice_notes" 
          DROP CONSTRAINT IF EXISTS "voice_notes_diagnosticEmail_fkey";
        END IF;

        -- Make diagnosticEmail nullable (remove NOT NULL constraint)
        IF EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'voice_notes' 
          AND column_name = 'diagnosticEmail'
          AND is_nullable = 'NO'
        ) THEN
          ALTER TABLE "voice_notes" 
          ALTER COLUMN "diagnosticEmail" DROP NOT NULL;
        END IF;

        -- Check if voice_notes table exists and userId column exists
        IF EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'voice_notes' 
          AND column_name = 'userId'
        ) THEN
          -- Check if it's not already INTEGER
          IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'voice_notes' 
            AND column_name = 'userId' 
            AND data_type != 'integer'
          ) THEN
            -- Drop any existing foreign key constraints on userId first
            IF EXISTS (
              SELECT 1 FROM information_schema.table_constraints 
              WHERE table_name = 'voice_notes' 
              AND constraint_name LIKE '%userId%'
              AND constraint_type = 'FOREIGN KEY'
            ) THEN
              ALTER TABLE "voice_notes" 
              DROP CONSTRAINT IF EXISTS "voice_notes_userId_fkey";
            END IF;

            -- Convert userId column to INTEGER with proper casting
            ALTER TABLE "voice_notes" 
            ALTER COLUMN "userId" TYPE INTEGER 
            USING CASE 
              WHEN "userId" IS NULL THEN NULL
              WHEN "userId"::text ~ '^[0-9]+$' THEN "userId"::text::INTEGER
              ELSE NULL
            END;
          END IF;

          -- Ensure userId is nullable (remove NOT NULL constraint if it exists)
          IF EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'voice_notes' 
            AND column_name = 'userId'
            AND is_nullable = 'NO'
          ) THEN
            ALTER TABLE "voice_notes" 
            ALTER COLUMN "userId" DROP NOT NULL;
          END IF;
        END IF;
      END $$;
    `);
    console.log("Voice notes table migration completed");
  } catch (err) {
    // If column doesn't exist or conversion fails, that's fine - sync will handle it
    console.log("Voice notes table migration:", err.message);
  }

  // Add missing columns to chat table if they don't exist
  try {
    await sequelize.query(`
      DO $$ 
      BEGIN
        -- Add discoveryId column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'chat' 
          AND column_name = 'discoveryId'
        ) THEN
          ALTER TABLE "chat" ADD COLUMN "discoveryId" INTEGER;
        END IF;
      END $$;
    `);
    console.log("Chat table columns migration completed");
  } catch (err) {
    console.log("Chat table columns migration:", err.message);
  }

  // Sync all models together to respect FK dependencies (e.g., users before diagnostics)
  await sequelize.sync({ alter: true });

  // Backfill and enforce email uniqueness on diagnostics after tables exist
  await backfillDiagnosticEmails();
  await ensureDiagnosticEmailUnique();

  console.log("Database connected and synced");
  return models;
};

module.exports = { sequelize, initDb };
