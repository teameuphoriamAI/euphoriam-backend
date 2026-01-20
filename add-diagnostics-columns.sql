-- Add missing columns to diagnostics table
-- Run this SQL directly in your PostgreSQL database if you can't restart the server

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




