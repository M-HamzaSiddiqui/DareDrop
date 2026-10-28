-- DareDrop Supabase Realtime Publication Migration
-- Enables real-time Postgres Change events for challenge completions (peer verification)
-- Safe to re-run multiple times (idempotent)

-- 1. Ensure the supabase_realtime publication exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

-- 2. Add public.challenge_completions to supabase_realtime if not already present
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'challenge_completions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.challenge_completions;
  END IF;
END $$;

-- 3. Set REPLICA IDENTITY FULL so UPDATE and DELETE events provide the full row
-- required for Supabase Realtime RLS evaluation (participant_id, verifier_id, challenge_id).
ALTER TABLE public.challenge_completions REPLICA IDENTITY FULL;
