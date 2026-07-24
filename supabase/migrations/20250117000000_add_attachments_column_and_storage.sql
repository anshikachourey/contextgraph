-- Migration: Add attachments JSONB column to messages table and create chat-attachments storage bucket
-- Requirement: 5.8 - Message schema includes attachments field (url, filename, mimeType, size)

-- Add attachments column to messages table
ALTER TABLE messages
ADD COLUMN attachments JSONB DEFAULT NULL;

COMMENT ON COLUMN messages.attachments IS 
  'Array of {url, filename, mimeType, size} for uploaded files. NULL for messages without attachments.';

-- Create chat-attachments storage bucket (public)
INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-attachments', 'chat-attachments', true);

-- RLS policy: authenticated users can upload
CREATE POLICY "Allow authenticated uploads to chat-attachments"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'chat-attachments');

-- RLS policy: anonymous users can upload (until auth is implemented)
CREATE POLICY "Allow anon uploads to chat-attachments"
  ON storage.objects
  FOR INSERT
  TO anon
  WITH CHECK (bucket_id = 'chat-attachments');

-- RLS policy: public can read (for serving attachments)
CREATE POLICY "Allow public read from chat-attachments"
  ON storage.objects
  FOR SELECT
  TO public
  USING (bucket_id = 'chat-attachments');
