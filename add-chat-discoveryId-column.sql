-- Add discoveryId column to chat table
-- Run this SQL directly in your PostgreSQL database if you can't restart the server

DO $$ 
BEGIN
  -- Add discoveryId column if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'chat' 
    AND column_name = 'discoveryId'
  ) THEN
    ALTER TABLE "chat" ADD COLUMN "discoveryId" INTEGER;
    RAISE NOTICE 'Added discoveryId column to chat table';
  ELSE
    RAISE NOTICE 'discoveryId column already exists in chat table';
  END IF;
END $$;


