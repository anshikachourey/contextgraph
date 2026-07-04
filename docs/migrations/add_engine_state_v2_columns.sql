-- Migration: Add v2 engine state columns to conversation_engine_state
-- and stale promotion tracking to topic_candidates.
-- Run this in the Supabase SQL Editor.
-- Safe to run multiple times.

ALTER TABLE conversation_engine_state ADD COLUMN IF NOT EXISTS cursor text;
ALTER TABLE conversation_engine_state ADD COLUMN IF NOT EXISTS open_segment jsonb;

ALTER TABLE topic_candidates ADD COLUMN IF NOT EXISTS last_touched_run integer DEFAULT 0;
