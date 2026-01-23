const { Sequelize } = require("sequelize");

const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

// Check if using Supabase/Neon (Session mode databases with strict limits)
const isSupabaseOrNeon = 
  DATABASE_URL.includes("supabase.co") || 
  DATABASE_URL.includes("neon.tech") ||
  DATABASE_URL.includes("neon.tech");

if (isSupabaseOrNeon && !DATABASE_URL.includes("pooler")) {
  console.warn("\n⚠️  WARNING: Using direct connection to Supabase/Neon (Session mode)");
  console.warn("   Session mode has very strict connection limits (usually 1 connection)");
  console.warn("   Consider using a connection pooler URL for better performance:");
  console.warn("   - Supabase: Use the 'Connection Pooling' URL from your dashboard");
  console.warn("   - Neon: Use the 'Pooled' connection string\n");
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
    max: 1, // Absolute minimum for Session mode databases (Supabase/Neon free tier)
    min: 0, // Start with 0 connections, create as needed
    acquire: 60000, // Increased: Maximum time (ms) to wait for a connection (60 seconds)
    idle: 10000, // Maximum time (ms) a connection can be idle before being released
    evict: 1000, // Interval (ms) to check for idle connections
    handleDisconnects: true, // Automatically reconnect if connection is lost
  },
  retry: {
    max: 3,
    match: [
      /ConnectionError/,
      /SequelizeConnectionError/,
      /SequelizeConnectionRefusedError/,
      /SequelizeHostNotFoundError/,
      /SequelizeHostNotReachableError/,
      /SequelizeInvalidConnectionError/,
      /SequelizeConnectionTimedOutError/,
      /MaxClientsInSessionMode/,
    ],
  },
  // Close all connections on process exit
  hooks: {
    beforeDisconnect: async () => {
      console.log("Closing database connections...");
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

const initDb = async (retries = 5, initialDelay = 10000) => {
  for (let i = 0; i < retries; i++) {
    try {
      await sequelize.authenticate();
      console.log("Database connection established successfully");
      break; // Success, exit retry loop
    } catch (error) {
      const isConnectionError = 
        error.message?.includes("MaxClientsInSessionMode") ||
        error.message?.includes("max clients reached") ||
        error.original?.code === "XX000";
      
      if (isConnectionError && i < retries - 1) {
        // Exponential backoff: 10s, 20s, 30s, 40s, 50s
        const delay = initialDelay * (i + 1);
        console.log(`\n⚠️  Connection limit reached. Database connections are still in use.`);
        console.log(`   Waiting ${delay/1000}s before retry ${i + 1}/${retries}...`);
        console.log(`   Tip: Check your Supabase/Neon dashboard for active connections.`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      if (isConnectionError && i === retries - 1) {
        console.error("\n❌ Failed to connect after all retries.");
        console.error("   All database connections are currently in use.");
        console.error("   Solutions:");
        console.error("   1. Wait 2-3 minutes for connections to timeout");
        console.error("   2. Check your Supabase/Neon dashboard and close idle connections");
        console.error("   3. Restart your database instance (if possible)");
        console.error("   4. Consider upgrading your database plan for more connections");
      }
      
      throw error; // Re-throw if not a connection error or out of retries
    }
  }
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

  // Add OTP-related columns to users table if they don't exist
  try {
    await sequelize.query(`
      DO $$ 
      BEGIN
        -- Add otp column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'otp'
        ) THEN
          ALTER TABLE "users" ADD COLUMN "otp" VARCHAR(255);
        END IF;

        -- Add otpExpiry column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'otpExpiry'
        ) THEN
          ALTER TABLE "users" ADD COLUMN "otpExpiry" TIMESTAMP WITH TIME ZONE;
        END IF;

        -- Add otpAttempts column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'otpAttempts'
        ) THEN
          ALTER TABLE "users" ADD COLUMN "otpAttempts" INTEGER NOT NULL DEFAULT 0;
        END IF;

        -- Add otpCooldown column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'otpCooldown'
        ) THEN
          ALTER TABLE "users" ADD COLUMN "otpCooldown" TIMESTAMP WITH TIME ZONE;
        END IF;

        -- Add resendOTPCount column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'resendOTPCount'
        ) THEN
          ALTER TABLE "users" ADD COLUMN "resendOTPCount" INTEGER NOT NULL DEFAULT 0;
        END IF;

        -- Add resendOTPExpiry column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'resendOTPExpiry'
        ) THEN
          ALTER TABLE "users" ADD COLUMN "resendOTPExpiry" TIMESTAMP WITH TIME ZONE;
        END IF;

        -- Add resendOTPCooldown column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'resendOTPCooldown'
        ) THEN
          ALTER TABLE "users" ADD COLUMN "resendOTPCooldown" TIMESTAMP WITH TIME ZONE;
        END IF;

        -- Add requestedOTP column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'requestedOTP'
        ) THEN
          ALTER TABLE "users" ADD COLUMN "requestedOTP" BOOLEAN NOT NULL DEFAULT false;
        END IF;
      END $$;
    `);
    console.log("Users table OTP columns migration completed");
  } catch (err) {
    console.log("Users OTP columns migration:", err.message);
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

  // Handle user_sessions table creation
  try {
    await sequelize.query(`
      DO $$ 
      BEGIN
        -- Create user_sessions table if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables 
          WHERE table_name = 'user_sessions'
        ) THEN
          CREATE TABLE "user_sessions" (
            "id" SERIAL PRIMARY KEY,
            "userId" INTEGER,
            "email" VARCHAR(255),
            "transcript" JSONB NOT NULL,
            "embeddings" JSONB,
            "summery" TEXT,
            "sessionDate" TIMESTAMP WITH TIME ZONE,
            "metadata" JSONB DEFAULT '{}',
            "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            CONSTRAINT "user_sessions_userId_fkey" 
              FOREIGN KEY ("userId") 
              REFERENCES "users"("id") 
              ON DELETE CASCADE
          );
          
          -- Create index on userId for faster lookups
          CREATE INDEX IF NOT EXISTS "user_sessions_userId_idx" ON "user_sessions"("userId");
          
          -- Create index on email for faster lookups
          CREATE INDEX IF NOT EXISTS "user_sessions_email_idx" ON "user_sessions"("email");
          
          -- Create index on sessionDate for sorting
          CREATE INDEX IF NOT EXISTS "user_sessions_sessionDate_idx" ON "user_sessions"("sessionDate" DESC);
        ELSE
          -- Add embeddings column if table exists but column doesn't
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'user_sessions' 
            AND column_name = 'embeddings'
          ) THEN
            ALTER TABLE "user_sessions" ADD COLUMN "embeddings" JSONB;
          END IF;
          
          -- Add summery column if table exists but column doesn't
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = 'user_sessions' 
            AND column_name = 'summery'
          ) THEN
            ALTER TABLE "user_sessions" ADD COLUMN "summery" TEXT;
          END IF;
        END IF;
      END $$;
    `);
    console.log("User sessions table migration completed");
  } catch (err) {
    console.log("User sessions table migration:", err.message);
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
  // await sequelize.sync({ alter: true });

  // Backfill and enforce email uniqueness on diagnostics after tables exist
  await backfillDiagnosticEmails();
  await ensureDiagnosticEmailUnique();

  console.log("Database connected and synced");
  return models;
};

module.exports = { sequelize, initDb };
