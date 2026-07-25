-- Migration: Add attachments JSONB column to messages table and configure private storage bucket
-- Idempotent: safe to re-run against existing schemas.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Add attachments column (idempotent)
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT NULL;

COMMENT ON COLUMN messages.attachments IS 
  'Array of {storagePath, url, filename, mimeType, size} for uploaded files. storagePath is the authoritative storage reference. url is transient (signed). NULL for messages without attachments.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Create or update chat-attachments bucket as PRIVATE
-- ═══════════════════════════════════════════════════════════════════════════════
INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-attachments', 'chat-attachments', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Remove any broad/legacy storage policies safely
-- ═══════════════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Allow authenticated uploads to chat-attachments" ON storage.objects;
DROP POLICY IF EXISTS "Allow anon uploads to chat-attachments" ON storage.objects;
DROP POLICY IF EXISTS "Allow public read from chat-attachments" ON storage.objects;
DROP POLICY IF EXISTS "Allow all operations on chat-attachments" ON storage.objects;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Create minimal policies for service-role-only access
--    The service_role key bypasses RLS entirely, so these policies only need to
--    ensure that anon/authenticated clients CANNOT access the bucket directly.
--    We create NO permissive policies for anon/authenticated/public.
--    Only the service_role (used by our API routes) can read/write.
-- ═══════════════════════════════════════════════════════════════════════════════
-- No policies created — service_role bypasses RLS. This means:
-- - Anonymous browser clients: CANNOT upload, read, or delete (no permissive policy)
-- - Authenticated browser clients: CANNOT upload, read, or delete (no permissive policy)
-- - Server API routes (service_role): CAN do everything (RLS bypassed)
