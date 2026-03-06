const { Sequelize } = require("sequelize");

const { DATABASE_URL } = process.env;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

// Check if using Supabase/Neon (Session mode databases with strict limits)
const isSupabaseOrNeon = 
  DATABASE_URL.includes("supabase.co") || 
  DATABASE_URL.includes("neon.tech");

const isUsingPooler = DATABASE_URL.includes("pooler");

if (isSupabaseOrNeon && !isUsingPooler) {
  console.warn("\n⚠️  WARNING: Using direct connection to Supabase/Neon (Session mode)");
  console.warn("   Session mode has very strict connection limits (usually 1 connection)");
  console.warn("   Consider using a connection pooler URL for better performance:");
  console.warn("   - Supabase: Use the 'Connection Pooling' URL from your dashboard");
  console.warn("   - Neon: Use the 'Pooled' connection string\n");
}

// Dynamic pool size: use larger pool when a connection pooler is available
const poolMax = isUsingPooler ? 5 : (isSupabaseOrNeon ? 1 : 5);

console.log(`[DB] Pool config: max=${poolMax}, pooler=${isUsingPooler}, supabase/neon=${isSupabaseOrNeon}`);

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
    max: poolMax,
    min: 0, // Start with 0 connections, create as needed
    acquire: 60000, // Maximum time (ms) to wait for a connection (60 seconds)
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
      /SequelizeConnectionAcquireTimeoutError/,
      /ConnectionAcquireTimeoutError/,
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

// ── Query semaphore for low-pool scenarios ──────────────────────────────
// When pool max is 1, concurrent callers pile up waiting for the single
// connection.  If they exceed the acquire timeout they all fail at once.
// This semaphore limits in-flight DB work so callers queue in JS instead
// of inside the pool, preventing cascade timeouts.
const _dbQueue = [];
let _dbInFlight = 0;
const DB_MAX_CONCURRENT = poolMax; // match pool size

const acquireDbSlot = () =>
  new Promise((resolve) => {
    if (_dbInFlight < DB_MAX_CONCURRENT) {
      _dbInFlight++;
      resolve();
    } else {
      _dbQueue.push(resolve);
    }
  });

const releaseDbSlot = () => {
  _dbInFlight--;
  if (_dbQueue.length > 0) {
    _dbInFlight++;
    const next = _dbQueue.shift();
    next();
  }
};

/**
 * Wraps an async DB operation with the semaphore so that at most
 * DB_MAX_CONCURRENT operations run in parallel. Prevents pool-acquire
 * timeouts when many requests arrive at once.
 */
const withDbSlot = async (fn) => {
  await acquireDbSlot();
  try {
    return await fn();
  } finally {
    releaseDbSlot();
  }
};

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

        -- Add lightTheme column if it doesn't exist
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns 
          WHERE table_name = 'users' 
          AND column_name = 'lightTheme'
        ) THEN
          ALTER TABLE "users" ADD COLUMN "lightTheme" BOOLEAN DEFAULT true;
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

  // Add 'Discovery' to chat.chatType enum if missing (app uses ChatType.DISCOVERY = "Discovery")
  try {
    const [rows] = await sequelize.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_enum e
        JOIN pg_type t ON e.enumtypid = t.oid
        WHERE t.typname = 'enum_chat_chatType'
        AND e.enumlabel = 'Discovery'
      ) AS "exists";
    `);
    const exists = rows?.[0]?.exists === true;
    if (!exists) {
      await sequelize.query(`ALTER TYPE "enum_chat_chatType" ADD VALUE 'Discovery';`);
      console.log("Chat chatType enum: added 'Discovery'");
    }
  } catch (err) {
    console.log("Chat chatType enum migration:", err.message);
  }

  // Create discoveryChat table if it doesn't exist (DiscoveryChat model)
  try {
    await sequelize.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables 
          WHERE table_schema = 'public' AND table_name = 'discoveryChat'
        ) THEN
          CREATE TABLE "discoveryChat" (
            "id" SERIAL PRIMARY KEY,
            "userId" INTEGER NOT NULL,
            "title" VARCHAR(255),
            "discoveryType" VARCHAR(255),
            "email" VARCHAR(255),
            "transcript" JSONB,
            "report" JSONB,
            "previousReportSnippet" TEXT,
            "newReportSnippet" TEXT,
            "pdfUrl" VARCHAR(255),
            "data" JSONB NOT NULL DEFAULT '{}',
            "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS "discoveryChat_email_idx" ON "discoveryChat"("email");
          CREATE INDEX IF NOT EXISTS "discoveryChat_userId_idx" ON "discoveryChat"("userId");
          CREATE INDEX IF NOT EXISTS "discoveryChat_updatedAt_idx" ON "discoveryChat"("updatedAt" DESC);
        END IF;
      END $$;
    `);
    console.log("DiscoveryChat table migration completed");
  } catch (err) {
    console.log("DiscoveryChat table migration:", err.message);
  }

  // Create userlesson table if it doesn't exist
  try {
    await sequelize.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.tables 
          WHERE table_name = 'userlesson'
        ) THEN
          CREATE TABLE "userlesson" (
            "id" SERIAL PRIMARY KEY,
            "userId" VARCHAR(255) NOT NULL UNIQUE,
            "course" VARCHAR(255),
            "module" VARCHAR(255),
            "lesson" VARCHAR(255),
            "isCompleted" VARCHAR(255),
            "voiceId" INTEGER,
            "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS "userlesson_userId_idx" ON "userlesson"("userId");
        END IF;
      END $$;
    `);
    console.log("Userlesson table migration completed");
  } catch (err) {
    console.log("Userlesson table migration:", err.message);
  }

  // Create Barcode table if it doesn't exist
  try {
    await sequelize.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (
          SELECT 1 
          FROM information_schema.tables 
          WHERE table_schema = 'public' 
            AND table_name = 'Barcode'
        ) THEN
          CREATE TABLE "Barcode" (
            "id" SERIAL PRIMARY KEY,
            "websiteLink" VARCHAR(255) NOT NULL,
            "productName" VARCHAR(255) NOT NULL,
            "barcodeImage" VARCHAR(255) NOT NULL,
            "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
          );

          CREATE UNIQUE INDEX IF NOT EXISTS "Barcode_website_product_idx" 
            ON "Barcode"("websiteLink", "productName");
        END IF;
      END $$;
    `);
    console.log("Barcode table migration completed");
  } catch (err) {
    console.log("Barcode table migration:", err.message);
  }

  // Sync all models together to respect FK dependencies (e.g., users before diagnostics)
  // await sequelize.sync({ alter: true });

  // Backfill and enforce email uniqueness on diagnostics after tables exist
  await backfillDiagnosticEmails();
  await ensureDiagnosticEmailUnique();

  console.log("Database connected and synced");
  return models;
};

module.exports = { sequelize, initDb, withDbSlot };
