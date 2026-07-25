-- Migration: Add message_seq auto-incrementing column to messages table
-- Required by the V2 Intelligence Engine for ordering and cursor-based incremental processing.

-- Create a sequence for message_seq
CREATE SEQUENCE IF NOT EXISTS messages_message_seq_seq;

-- Add the column with a default from the sequence
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS message_seq BIGINT DEFAULT nextval('messages_message_seq_seq');

-- Backfill existing rows in created_at order so the sequence reflects insertion order
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) AS rn
  FROM messages
  WHERE message_seq IS NULL OR message_seq = 0
)
UPDATE messages
SET message_seq = ordered.rn
FROM ordered
WHERE messages.id = ordered.id;

-- Advance the sequence past the highest existing value
SELECT setval('messages_message_seq_seq', COALESCE((SELECT MAX(message_seq) FROM messages), 0) + 1, false);

-- Add an index for efficient cursor queries
CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq
ON messages (conversation_id, message_seq);

COMMENT ON COLUMN messages.message_seq IS 
  'Auto-incrementing sequence number for cursor-based V2 incremental processing. Populated automatically on insert.';
