-- Add lightTheme column to users table
-- Run this SQL directly in your PostgreSQL database (e.g. psql, Supabase SQL Editor)

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'lightTheme'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "lightTheme" BOOLEAN DEFAULT true;
  END IF;
END $$;
