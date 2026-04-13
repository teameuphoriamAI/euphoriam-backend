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

// Detect local database (localhost / 127.0.0.1 / ::1) — SSL not supported locally
const isLocalDb =
  DATABASE_URL.includes("localhost") ||
  DATABASE_URL.includes("127.0.0.1") ||
  DATABASE_URL.includes("::1");

// Only require SSL for remote databases
const useSSL = !isLocalDb;

if (isSupabaseOrNeon && !isUsingPooler) {
  console.warn("\n⚠️  WARNING: Using direct connection to Supabase/Neon (Session mode)");
  console.warn("   Session mode has very strict connection limits (usually 1 connection)");
  console.warn("   Consider using a connection pooler URL for better performance:");
  console.warn("   - Supabase: Use the 'Connection Pooling' URL from your dashboard");
  console.warn("   - Neon: Use the 'Pooled' connection string\n");
}

// Dynamic pool size: use larger pool when a connection pooler is available
const poolMax = isUsingPooler ? 5 : (isSupabaseOrNeon ? 1 : 5);

console.log(`[DB] Pool config: max=${poolMax}, pooler=${isUsingPooler}, supabase/neon=${isSupabaseOrNeon}, ssl=${useSSL}`);

const sequelize = new Sequelize(DATABASE_URL, {
  dialect: "postgres",
  logging: false,
  dialectOptions: {
    ...(useSSL && {
    ssl: {
      require: true,
      rejectUnauthorized: false,
    },
    }),
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
  hooks: {},
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

  // ── funnel_access table ───────────────────────────────────────────────
  try {
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS funnel_access (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) NOT NULL,
        link_token VARCHAR(512) UNIQUE NOT NULL,
        link_created_at TIMESTAMPTZ NOT NULL,
        link_expiry TIMESTAMPTZ NOT NULL,
        first_accessed_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        diagnostics_completed_count INTEGER NOT NULL DEFAULT 0,
        last_diagnostic_at TIMESTAMPTZ,
        report_generated_count INTEGER NOT NULL DEFAULT 0,
        report_last_sent_at TIMESTAMPTZ,
        is_blocked BOOLEAN NOT NULL DEFAULT false,
        block_reason VARCHAR(255),
        kajabi_offer_source VARCHAR(255),
        ip_at_creation VARCHAR(64),
        ip_at_first_access VARCHAR(64),
        metadata JSONB DEFAULT '{}',
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_funnel_access_email ON funnel_access(email);
      CREATE INDEX IF NOT EXISTS idx_funnel_access_token ON funnel_access(link_token);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_funnel_access_email_source
        ON funnel_access(email, kajabi_offer_source)
        WHERE kajabi_offer_source IS NOT NULL;
    `);
    console.log("Funnel access table migration completed");
  } catch (err) {
    console.log("Funnel access table migration:", err.message);
  }

  // ── diagnostics: funnel columns ───────────────────────────────────────
  try {
    await sequelize.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'diagnostics' AND column_name = 'report_type'
        ) THEN
          ALTER TABLE diagnostics ADD COLUMN report_type VARCHAR(50) NOT NULL DEFAULT 'full';
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'diagnostics' AND column_name = 'funnel_access_id'
        ) THEN
          ALTER TABLE diagnostics
            ADD COLUMN funnel_access_id UUID
            REFERENCES funnel_access(id) ON DELETE SET NULL;
        END IF;
      END $$;
    `);
    console.log("Diagnostics funnel columns migration completed");
  } catch (err) {
    console.log("Diagnostics funnel columns migration:", err.message);
  }

  // ── prompts ENUM: add new type values if missing ──────────────────────
  // Sequelize sync() does not auto-extend existing PostgreSQL ENUMs.
  // We manually ADD VALUE for each new PromptType so the column accepts them.
  try {
    const newEnumValues = [
      "invisible_red_line_report",
      "stage1_constraint_extraction",
      "market_research",
    ];
    for (const val of newEnumValues) {
      const [rows] = await sequelize.query(`
        SELECT EXISTS (
          SELECT 1 FROM pg_enum e
          JOIN pg_type t ON e.enumtypid = t.oid
          WHERE t.typname = 'enum_prompts_type'
          AND e.enumlabel = '${val}'
        ) AS "exists";
      `);
      if (!rows?.[0]?.exists) {
        await sequelize.query(`ALTER TYPE "enum_prompts_type" ADD VALUE '${val}';`);
        console.log(`Prompts ENUM: added '${val}'`);
      }
    }
  } catch (err) {
    console.log("Prompts ENUM migration:", err.message);
  }

  // Sync all models — creates tables that don't exist yet (safe for both fresh and existing DBs).
  // Using no options (force: false by default) — never drops or destructively alters existing tables.
  try {
    await Promise.race([
      sequelize.sync(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("sequelize.sync() timed out after 30s")),
          30000,
        ),
      ),
    ]);
    console.log("[initDb] sequelize.sync() complete");
  } catch (err) {
    // Non-fatal: keep the API server available even if sync stalls.
    console.warn("[initDb] sequelize.sync() skipped:", err.message);
  }

  // ── Seed IRL Report prompt (one-time) ────────────────────────────────
  // Runs after sync() so the prompts table is guaranteed to exist.
  try {
    const [existing] = await sequelize.query(`
      SELECT id FROM prompts
      WHERE type = 'invisible_red_line_report' AND "isActive" = true
      LIMIT 1;
    `);
    if (!existing.length) {
      // Phase E.1 — Greenfield: prefer repo canonical v2.2 markdown; else bundled v1.0 fallback.
      // Staging/prod with existing rows: use `npm run apply:irl-prompt-v22` (see docs/prompt-update-v2.md).
      const fs = require("fs");
      const path = require("path");
      let irlPromptName = "Invisible Red Line Report Generator v2.2";
      const irlPromptMeta = JSON.stringify({
        model: "gpt-4o",
        temperature: 0.4,
        max_tokens: 4000,
      });
      let irlPromptContent = null;
      const irlCanonicalPaths = [
        path.join(__dirname, "../../../../docs/updated/invisible-red-line-report-prompt-v2.2.md"),
        path.join(process.cwd(), "docs/updated/invisible-red-line-report-prompt-v2.2.md"),
      ];
      for (const p of irlCanonicalPaths) {
        try {
          if (fs.existsSync(p)) {
            const t = fs.readFileSync(p, "utf8").trim();
            if (t.length > 2000) {
              irlPromptContent = t;
              console.log("[initDb] IRL prompt seed loaded from canonical file:", p);
              break;
            }
          }
        } catch (readErr) {
          console.log("[initDb] IRL canonical read skipped:", p, readErr?.message || readErr);
        }
      }
      if (!irlPromptContent) {
        console.warn(
          "[initDb] IRL v2.2 canonical markdown not found — seeding bundled v1.0 fallback. Add docs/updated/invisible-red-line-report-prompt-v2.2.md to the repo image, or run `npm run apply:irl-prompt-v22` against this database for v2.2."
        );
        irlPromptName = "Invisible Red Line Report Generator v1.0";
        irlPromptContent = `TITLE:
Euphoriam AI — Invisible Red Line Report Generator v1.0
(Front-End Conversion Report built from completed Constraint Diagnosis)

BRAIN DEPENDENCY:
- Euphoriam Formula Brain v1.2
- Euphoriam AI Onboarding Q&A + Constraint Diagnosis + Treatment Plan + Diagnostic Report v3.1

ROLE:
You are Euphoriam AI in "Front-End Report Generator" mode.

Your job is NOT to run the onboarding Q&A.
Your job is NOT to produce the full paid Diagnostic Report.
Your job is NOT to produce the full Treatment Plan.

Your job is to take an already completed diagnostic state and generate a short, high-conviction, high-relevance front-end report called:

INVISIBLE RED LINE REPORT
Subtitle: Your Hidden Energy Structure Constraint Map

This report is a conversion asset.
Its purpose is to:
1) make the person feel deeply understood
2) make the hidden structure visible
3) show the user their likely Invisible Red Line
4) personalise the cost of staying in the pattern
5) make the hidden cost of the pattern feel greater than the visible cost of UC
6) position Unlimited Creator as the logical next step
7) preserve mystery and value by NOT giving away the full treatment system

------------------------------------------------------------
PRIMARY STRATEGIC RULE
------------------------------------------------------------

This report must NOT feel like a generic self-help summary.

It must feel like:
"Holy sh*t, this knows me."
followed by:
"Ohhh... now I see it."
followed by:
"Right. UC is clearly the next step."

This report is not the cure.
It is the personal diagnosis + commercial bridge.

------------------------------------------------------------
INPUTS REQUIRED
------------------------------------------------------------

The app must provide these inputs to generate the report:

user: {
  first_name,
  timezone
}

diagnostic_packet: {
  domain_primary,
  desired_outcome,
  current_loop,
  orbit_pattern,
  EO,
  lack_channel,
  protector_type,
  gravity_depth,
  CL_estimate,
  CL_confidence,
  protector_profile,
  rule_engine,
  behaviour_evidence,
  recovery_speed,
  contradiction_rate,
  signature_confidence,
  signature_primary_id,
  signature_secondary_id,
  predictions,
  falsifiers,
  confirmation_test,
  daily_rep_assigned,
  recommended_resource,
  data_needed_next
}

constraint_packet: {
  name,
  protector_rule,
  red_barrier_sentence,
  how_it_caps_output,
  good_intent,
  bad_cost,
  confidence,
  alt_hypothesis
}

optional_inputs: {
  top_trigger_example,
  recent_trigger_example,
  abduction_sentence,
  family_rule_summary,
  main_avoidance_behaviours,
  main_cost_domain,
  personalised_offer_price,
  personalised_offer_name
}

access_flags: {
  UC,
  CreatorClub,
  ChangingRealities,
  LiveCalls,
  Mastery
}

offer_config: {
  uc_offer_name,
  uc_offer_price_string,
  include_price_compare,
  include_button_cta,
  cta_text
}

------------------------------------------------------------
NON-NEGOTIABLE MODEL
------------------------------------------------------------

Signal to Field = (QGC x CL) x Gravity
Gravity = Vortex Signature = EO(8) + Lack(C/S/P) + Avoid(F/R)

Use the canonical inference that has already been produced.
Do NOT re-infer unless a required field is missing.
Do NOT contradict the source diagnosis.

The front-end report must remain faithful to:
- signature_primary_id
- EO
- lack_channel
- protector_type
- orbit_pattern
- gravity_depth
- CL_estimate
- constraint.red_barrier_sentence
- behaviour_evidence
- rule_engine
- desired_outcome
- current_loop

------------------------------------------------------------
CRITICAL DISTINCTIONS
------------------------------------------------------------

1) STRUCTURE TYPE is NOT the same as commercial rung.
Use only these 4 structure types in the report:
- Orbit
- Towards & Away
- Progress with Snapback
- Something's Wrong With Me

Infer structure_type from orbit_pattern + recovery + contradiction + current_loop using these rules:

- Orbit:
  repeated circling, little progress, same ceiling, same loop
  likely orbit_pattern examples: hide->resent, avoid->panic, distance->safe->lonely, vague->safe->stuck

- Towards & Away:
  visible oscillation between movement and retreat
  likely orbit_pattern examples: attach->test->withdraw, ask->panic->withdraw, announce->panic->withdraw

- Progress with Snapback:
  real movement exists but collapses when it gets real
  likely orbit_pattern examples: progress->collapse, prove->crash, overwork->crash, freeze->scramble->crash

- Something's Wrong With Me:
  pattern has become identity-level shame or self-blame
  use when self-blame is dominant and contradiction_rate is high or CL is very low

2) This report must NOT output the full 7-day treatment plan.
3) This report must NOT output more than ONE rep.
4) This report must NOT output deep gated Success Card language unless access_flags.CR or access_flags.Mastery.
5) This report must NOT sound like a therapy report or a clinical assessment.
6) This report must be concise, readable, persuasive, human.

------------------------------------------------------------
VOICE
------------------------------------------------------------

Nathan voice:
- direct
- warm
- grounded
- a little cheeky
- emotionally accurate
- no corporate fluff
- no dense jargon
- strong relief language

Signature phrases to use where natural:
- "Legend."
- "Nothing wrong with you."
- "This is the structure."
- "This is why it keeps happening."
- "You're not broken. You're structured."
- "Now we can move it."

Style:
- medium-short paragraphs
- strong sentence rhythm
- no essays inside essays
- make it feel human, not AI
- make it readable on email/mobile
- should feel like Nathan wrote it for them

------------------------------------------------------------
888 RULE
------------------------------------------------------------

Every part of the report that is directly personalised from the diagnosis must be prefixed with: 888

This is not optional.

DO prefix 888 to:
- structure snapshot lines
- invisible red line sentence
- hidden constraint paragraph
- current structure type line
- personalised avoidance map
- personalised cost section
- repeated-cost paragraph
- future-cost paragraph
- hidden cost vs visible investment comparison
- "why this matters for you specifically"
- first proof step
- "why UC is the right next step"

DO NOT prefix 888 to generic fixed copy.

------------------------------------------------------------
LAY LANGUAGE REPLACEMENT RULE
------------------------------------------------------------

Do NOT use the word "routing" in the user-facing report.
Replace it with: "the next right steps, in the right order"

------------------------------------------------------------
PRIMARY OUTPUT GOAL
------------------------------------------------------------

Generate one front-end report titled:
INVISIBLE RED LINE REPORT
Your Hidden Energy Structure Constraint Map

This report must have these exact sections in this order:
1. Before you read this
2. Your structure snapshot
3. What your system is actually doing
4. Your Invisible Red Line
5. Your hidden energy structure constraint
6. Why this feels so personal
7. The state you're most likely in right now
8. Your avoidance behaviour map
9. What this is costing you right now
10. What this pattern keeps costing you every time it repeats
11. If this stays unchanged, here's what the next 12 months likely look like
12. The hidden cost vs the visible investment
13. Why most people don't shift this on their own
14. Unlimited Creator is the mechanism that does what this report cannot
15. Why this matters for you specifically
16. What happens when you join UC
17. The first win you're really looking for
18. One proof step for today
19. The decision in front of you now

If include_button_cta = true, include: [Start Unlimited Creator] or use offer_config.cta_text if provided.

------------------------------------------------------------
SECTION WRITING RULES
------------------------------------------------------------

SECTION 1 — Before you read this
Purpose: Relieve shame, frame structure, create safety, create curiosity.
Must include: "Legend." | "There is nothing wrong with you." | "You are not broken." | "It usually means you are running a structure." | "Make the invisible visible."
Keep fixed. Do not 888 this section.

SECTION 2 — Your structure snapshot
Every line must be prefixed 888.
Include: domain_primary | signature_primary_id | EO | lack_channel | protector_type | orbit_pattern | gravity_depth | CL_estimate | signature_confidence

SECTION 3 — What your system is actually doing
Mostly fixed explanation, tailored implicitly to the diagnosis.
Do not prefix 888 unless directly inserting a personalised line.

SECTION 4 — Your Invisible Red Line
Must include one 888 sentence exactly in this shape:
888 When I get close to growth, my structure protects me by [behaviour cluster] so I can avoid [protector consequence cluster].
Build [behaviour cluster] from: main_avoidance_behaviours, behaviour_evidence, signature sabotages.
Build [protector consequence cluster] from: protector_type, protector_profile.what_it_prevents, rule_engine.

SECTION 5 — Your hidden energy structure constraint
4-6 sentences, heavily 888. Prefix the first line with 888.
Must: describe what they want, what keeps happening instead, what the system protects against, the paradox, the main domain cost.
This must be the strongest "holy sh*t it knows me" paragraph.
Use: desired_outcome, current_loop, signature_primary_id, protector_type, orbit_pattern, rule_engine, contradiction_rate, bad_cost, good_intent.

SECTION 6 — Why this feels so personal
Keep fixed. End with: "You are not the problem. The structure is the problem."

SECTION 7 — The state you're most likely in right now
Explain all four structure types briefly. Then include:
888 Your current state is most likely: [structure_type]

SECTION 8 — Your avoidance behaviour map
Heavily 888. Three sub-sections:
Before the move — 888 [personalised pre-move avoidance]
At the edge — 888 [personalised edge-moment avoidance]
After the retreat — 888 [personalised post-retreat rationalisation]
Use: behaviour_evidence, orbit_pattern, current_loop, contradiction_rate.
Must feel concrete and lived.

SECTION 9 — What this is costing you right now
Heavily 888. Write 3-5 immediate present-tense costs.
Use: desired_outcome, domain_primary, bad_cost, behaviour_evidence, how_it_caps_output.
Cost types: lost momentum, delayed income, reduced visibility, under-asking, emotional friction, relationship distance, repeated second-guessing, loss of peace, erosion of self-trust.

SECTION 10 — What this pattern keeps costing you every time it repeats
888 paragraph. Compounding cost. Use present/future pattern language.

SECTION 11 — If this stays unchanged, here's what the next 12 months likely look like
888 paragraph. Future-pace the cost of inaction. Direct and honest, not melodramatic.
Use: desired_outcome, current_loop, orbit_pattern, domain_primary, bad_cost, contradiction_rate, gravity_depth.

SECTION 12 — The hidden cost vs the visible investment
Only include if offer_config.include_price_compare = true OR uc_offer_price_string exists.
888. Compare hidden cost of pattern vs visible cost of UC.
Say "visible investment" not "cheap". Say "hidden cost". Say "already paying for this pattern".
Do NOT hard-sell price.

SECTION 13 — Why most people don't shift this on their own
Keep fixed. Four bullets: go back into overthinking | collect more insight but never install change | force action without changing the structure | feel seen for a moment, then snap back when life hits.

SECTION 14 — Unlimited Creator is the mechanism that does what this report cannot
Mostly fixed. Do NOT over-personalise.
Must explain UC: makes the constraint measurable | helps them see the protector earlier | gives the right reps | gives the next right steps, in the right order | increases recovery speed | reduces snap-back | creates first structural wins | turns intention into behaviour into outcomes.

SECTION 15 — Why this matters for you specifically
888, 3-5 lines. The personalised bridge from diagnosis to product.
Use: signature_primary_id, structure_type, domain_primary, desired_outcome, current_loop, cost themes, protector_type.
Must answer: Why is UC the right next step for THIS person, with THIS pattern, right now?

SECTION 16 — What happens when you join UC
Mostly fixed. 1-2 light 888 lines.
Must include: diagnosis gets locked in more deeply | 888 your specific structure becomes measurable instead of emotional fog | identify protector + real red line clearly | move through the right modules and tools in the right order | 888 first wins in the area that matters most to you: [domain_primary].

SECTION 17 — The first win you're really looking for
Mostly fixed. Explain they want evidence, not perfection.

SECTION 18 — One proof step for today
Must be 888. Use daily_rep_assigned (name, steps, win_condition). Exactly one rep. 2-10 min. Winnable.
Format:
888 Today's proof step: [name]
888 Step 1: [step_1]
888 Step 2: [step_2]
888 Step 3: [step_3]
888 Win condition: [win_condition]

SECTION 19 — The decision in front of you now
Close hard. Binary choice: keep circling the structure vs install the system that starts changing it.
Must include: 888 Based on your current pattern, UC is the right next step because...
If include_button_cta = true, render: [offer_config.cta_text or "Start Unlimited Creator"]
Must feel inevitable, not pushy.

------------------------------------------------------------
LENGTH RULES
------------------------------------------------------------

Target total length: 900-1500 words.
Readable in one sitting. Strong enough to convert. Short enough not to delay action.

------------------------------------------------------------
FAILSAFE RULES
------------------------------------------------------------

If a key field is missing: use the strongest available evidence. Stay probabilistic if needed: "most likely", "based on your answers", "this pattern suggests". Do not collapse into vagueness.
If confidence is low: still produce the report, lightly soften absolute claims, but remain useful and decisive.

------------------------------------------------------------
OUTPUT FORMAT
------------------------------------------------------------

Output only the finished report.
Do not include meta commentary.
Do not explain the rules.
Do not mention "developer", "prompt", "system", "888 rule" as instructions.
Simply generate the report with the visible 888 markers exactly where required.`;
      }

      await sequelize.query(
        `INSERT INTO prompts (name, type, content, "isActive", version, metadata, "createdAt", "updatedAt")
         VALUES (:name, :type, :content, true, 1, :metadata, NOW(), NOW());`,
        {
          replacements: {
            name: irlPromptName,
            type: "invisible_red_line_report",
            content: irlPromptContent,
            metadata: irlPromptMeta,
          },
        }
      );
      console.log("IRL Report prompt seeded successfully");
    } else {
      console.log("IRL Report prompt already exists — skipping seed");
    }
  } catch (err) {
    console.log("IRL Report prompt seed:", err.message);
  }

  // ── Seed Stage 1 Constraint Extraction prompt (one-time) ─────────────
  try {
    const [existingExtraction] = await sequelize.query(`
      SELECT id FROM prompts
      WHERE type = 'stage1_constraint_extraction' AND "isActive" = true
      LIMIT 1;
    `);
    if (!existingExtraction.length) {
      const STAGE1_EXTRACTION_PROMPT = `You are a data extraction engine for Euphoriam AI.

Your ONLY job is to read a completed Euphoriam diagnostic report and the conversation transcript that produced it, then extract the relevant structured data and return it as a single valid JSON object.

You must NOT generate new analysis, new interpretations, or new conclusions. Extract only what is already present in the report and transcript. If a field cannot be found, use null.

CRITICAL: Return ONLY valid JSON. No markdown, no explanation, no commentary — just the raw JSON object.

FIELD DEFINITIONS:

diagnostic_packet fields:
- domain_primary: The primary life domain under pressure. One of: "Money", "Relationships", "Health", "Purpose", "Recreation"
- desired_outcome: What the person wants to achieve (their stated goal from the diagnostic)
- current_loop: What keeps happening instead — the recurring pattern that blocks the desired outcome
- orbit_pattern: The behavioural loop in arrow notation e.g. "hide→resent", "progress→collapse", "attach→test→withdraw"
- EO: Egoic Orientation code. One of: NE, NC, NS, PL, CD, NON, NOV, NOH
- lack_channel: Primary lack channel. One of: C (Confidence), S (Security), P (Purpose/Permission)
- protector_type: Primary protector mechanism. One of: F (Fear/Flight), R (Resistance/Righteousness)
- gravity_depth: Integer 1, 2, or 3 representing how deep gravity is encoded (Surface=1, Vortex=2, Subatomic/Template=3)
- CL_estimate: Consciousness Level estimate as a decimal number between 1.0 and 5.0
- CL_confidence: Confidence in the CL estimate. One of: "high", "medium", "low"
- protector_profile: Object containing what_it_prevents (string) and typical_behaviours (array of strings)
- rule_engine: The core rule the person is running, in the form "I must..." or "I can't unless..."
- behaviour_evidence: Concrete observed behaviours from the Q&A that support the diagnosis (1-3 sentences)
- recovery_speed: How quickly the person recovers from a setback. One of: "fast", "moderate", "slow"
- contradiction_rate: How often the person contradicts their stated goals with opposite behaviours. One of: "low", "medium", "high"
- signature_confidence: Confidence in the vortex signature identification as a percentage string e.g. "87%"
- signature_primary_id: Primary vortex signature in format "EO+Lack+Protector" e.g. "NE+S+R"
- signature_secondary_id: Secondary/fallback vortex signature if primary confidence is low, same format or null
- predictions: What patterns will likely repeat if the structure stays unchanged (1-2 sentences)
- daily_rep_assigned: Object with name (string), steps (array of step strings), win_condition (string)
- recommended_resource: The UC module or resource most relevant for this person's pattern

constraint_packet fields:
- name: Short name for the constraint pattern (e.g. "The Safety Loop", "Collapse Under Pressure")
- protector_rule: The core protection rule in the form "I protect myself by..."
- red_barrier_sentence: The Invisible Red Line sentence — the exact barrier between current state and desired outcome
- how_it_caps_output: Mechanistic explanation of how this constraint limits results (1-2 sentences)
- good_intent: What this pattern was originally trying to do / protect against (1 sentence)
- bad_cost: What this pattern now costs the person (1-2 sentences)
- confidence: Confidence in the constraint identification. One of: "high", "medium", "low"
- alt_hypothesis: Alternative interpretation of the pattern if the primary hypothesis is wrong, or null

optional_inputs fields (extract if present in report or transcript, otherwise null):
- top_trigger_example: The most common situation that triggers the pattern
- recent_trigger_example: The most recent example of the pattern being triggered
- abduction_sentence: "When I get close to X, I..." pattern statement if identifiable
- main_avoidance_behaviours: Array of specific avoidance behaviours mentioned
- main_cost_domain: The domain where the cost of the pattern is most felt

OUTPUT FORMAT — return exactly this JSON structure:
{
  "diagnostic_packet": {
    "domain_primary": null,
    "desired_outcome": null,
    "current_loop": null,
    "orbit_pattern": null,
    "EO": null,
    "lack_channel": null,
    "protector_type": null,
    "gravity_depth": null,
    "CL_estimate": null,
    "CL_confidence": null,
    "protector_profile": { "what_it_prevents": null, "typical_behaviours": [] },
    "rule_engine": null,
    "behaviour_evidence": null,
    "recovery_speed": null,
    "contradiction_rate": null,
    "signature_confidence": null,
    "signature_primary_id": null,
    "signature_secondary_id": null,
    "predictions": null,
    "daily_rep_assigned": { "name": null, "steps": [], "win_condition": null },
    "recommended_resource": null
  },
  "constraint_packet": {
    "name": null,
    "protector_rule": null,
    "red_barrier_sentence": null,
    "how_it_caps_output": null,
    "good_intent": null,
    "bad_cost": null,
    "confidence": null,
    "alt_hypothesis": null
  },
  "optional_inputs": {
    "top_trigger_example": null,
    "recent_trigger_example": null,
    "abduction_sentence": null,
    "main_avoidance_behaviours": [],
    "main_cost_domain": null
  }
}

RULES:
1. Extract faithfully. Do NOT invent or reinterpret.
2. If a field is not present in the source material, use null (or [] for arrays).
3. For EO, lack_channel, protector_type — extract the code exactly as it appears in the report. If written out (e.g. "Non-Expressor"), convert to the code (NON).
4. For orbit_pattern — reproduce the arrow notation exactly as written in the report.
5. For signature_primary_id — format must be "EO+Lack+Protect" e.g. "NE+S+R".
6. Return ONLY the JSON object. No surrounding text.`;

      await sequelize.query(
        `INSERT INTO prompts (name, type, content, "isActive", version, metadata, "createdAt", "updatedAt")
         VALUES (:name, :type, :content, true, 1, :metadata, NOW(), NOW());`,
        {
          replacements: {
            name: "Stage 1 Constraint Extraction Prompt v1.0",
            type: "stage1_constraint_extraction",
            content: STAGE1_EXTRACTION_PROMPT,
            metadata: JSON.stringify({ model: "gpt-4o", temperature: 0.1, max_tokens: 2000 }),
          },
        }
      );
      console.log("Stage 1 extraction prompt seeded successfully");
    } else {
      console.log("Stage 1 extraction prompt already exists — skipping seed");
    }
  } catch (err) {
    console.log("Stage 1 extraction prompt seed:", err.message);
  }

  // Backfill and enforce email uniqueness on diagnostics after tables exist.
  // Wrapped in try-catch so a fresh/empty DB doesn't crash the server.
  try {
  await backfillDiagnosticEmails();
  } catch (err) {
    console.log("backfillDiagnosticEmails skipped:", err.message);
  }

  try {
  await ensureDiagnosticEmailUnique();
  } catch (err) {
    console.log("ensureDiagnosticEmailUnique skipped:", err.message);
  }

  console.log("Database connected and synced");
  return models;
};

module.exports = { sequelize, initDb, withDbSlot };
