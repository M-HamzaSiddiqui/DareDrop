-- DareDrop Consolidated Database Migration: Challenges & Participants
-- File: supabase/migrations/20261022000000_create_challenges_and_participants.sql

-- 1. Enable pgcrypto / uuid generation extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 2. Challenges Table
CREATE TABLE IF NOT EXISTS public.challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('Fitness', 'Focus', 'Fun', 'Learning')),
  duration_days INTEGER NOT NULL CHECK (duration_days > 0),
  ends_at TIMESTAMPTZ,
  creator_id TEXT,
  creator_name TEXT NOT NULL DEFAULT 'Anonymous',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  participants_count INTEGER NOT NULL DEFAULT 0
);

-- Ensure default is 0 for existing tables
ALTER TABLE public.challenges ALTER COLUMN participants_count SET DEFAULT 0;

-- 3. Challenge Participants Table (Membership with duplicate prevention)
CREATE TABLE IF NOT EXISTS public.challenge_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID NOT NULL REFERENCES public.challenges(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_challenge_participant UNIQUE (challenge_id, user_id)
);

-- 4. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_challenges_created_at ON public.challenges (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_challenges_category ON public.challenges (category);
CREATE INDEX IF NOT EXISTS idx_challenge_participants_challenge ON public.challenge_participants (challenge_id);
CREATE INDEX IF NOT EXISTS idx_challenge_participants_user ON public.challenge_participants (user_id);

-- 5. Trigger for Real-Time Participant Counts (Privacy-Conscious Counter Cache)
CREATE OR REPLACE FUNCTION public.handle_challenge_participant_count()
RETURNS TRIGGER AS $$
DECLARE
  target_challenge_id UUID;
BEGIN
  target_challenge_id := COALESCE(NEW.challenge_id, OLD.challenge_id);
  UPDATE public.challenges
  SET participants_count = (
    SELECT COUNT(*)
    FROM public.challenge_participants
    WHERE challenge_id = target_challenge_id
  )
  WHERE id = target_challenge_id;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_challenge_participant_count ON public.challenge_participants;
CREATE TRIGGER trg_challenge_participant_count
  AFTER INSERT OR DELETE ON public.challenge_participants
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_challenge_participant_count();

CREATE OR REPLACE FUNCTION public.handle_challenge_participant_truncate()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.challenges SET participants_count = 0;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_challenge_participant_truncate ON public.challenge_participants;
CREATE TRIGGER trg_challenge_participant_truncate
  AFTER TRUNCATE ON public.challenge_participants
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.handle_challenge_participant_truncate();

-- Sync existing counts with actual participant rows
UPDATE public.challenges c
SET participants_count = (
  SELECT COUNT(*)
  FROM public.challenge_participants cp
  WHERE cp.challenge_id = c.id
);

-- 6. Enable Row Level Security (RLS)
ALTER TABLE public.challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.challenge_participants ENABLE ROW LEVEL SECURITY;

-- 7. RLS Policies for challenges
-- Allow anyone (public, authenticated, or anonymous) to view active challenges
DROP POLICY IF EXISTS "Public can view challenges" ON public.challenges;
CREATE POLICY "Public can view challenges"
  ON public.challenges
  FOR SELECT
  USING (true);

-- Allow authenticated (including anonymous auth) users to insert challenges with their own UID
DROP POLICY IF EXISTS "Users can create challenges" ON public.challenges;
DROP POLICY IF EXISTS "Authenticated users can create challenges" ON public.challenges;
CREATE POLICY "Authenticated users can create challenges"
  ON public.challenges
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL AND creator_id = auth.uid()::text
  );

-- Allow creators to update their own challenges
DROP POLICY IF EXISTS "Creators can update challenges" ON public.challenges;
CREATE POLICY "Creators can update challenges"
  ON public.challenges
  FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL AND creator_id = auth.uid()::text)
  WITH CHECK (auth.uid() IS NOT NULL AND creator_id = auth.uid()::text);

-- Allow creators to delete their own challenges
DROP POLICY IF EXISTS "Creators can delete challenges" ON public.challenges;
CREATE POLICY "Creators can delete challenges"
  ON public.challenges
  FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL AND creator_id = auth.uid()::text);

-- 8. RLS Policies for challenge_participants
-- Privacy-conscious SELECT: authenticated users can only view their own participation records
DROP POLICY IF EXISTS "Public can view challenge participants" ON public.challenge_participants;
DROP POLICY IF EXISTS "Users can view own participation" ON public.challenge_participants;
CREATE POLICY "Users can view own participation"
  ON public.challenge_participants
  FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL AND user_id = auth.uid()::text);

-- Strictly allow authenticated users to join challenges with their verified UID
DROP POLICY IF EXISTS "Users can join challenges" ON public.challenge_participants;
DROP POLICY IF EXISTS "Authenticated users can join challenges" ON public.challenge_participants;
CREATE POLICY "Authenticated users can join challenges"
  ON public.challenge_participants
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL AND user_id = auth.uid()::text
  );

-- Strictly allow authenticated users to leave (delete only their own membership row)
DROP POLICY IF EXISTS "Users can leave challenges" ON public.challenge_participants;
CREATE POLICY "Users can leave challenges"
  ON public.challenge_participants
  FOR DELETE
  TO authenticated
  USING (
    auth.uid() IS NOT NULL AND user_id = auth.uid()::text
  );
