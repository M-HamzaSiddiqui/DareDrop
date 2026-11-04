-- DareDrop Private Challenges Migration
-- File: supabase/migrations/20261105000000_private_challenges.sql
--
-- Objective:
-- Makes challenges private: visible ONLY to their creator and joined participants.
-- Closes direct join table mutations in favor of hardened SECURITY DEFINER RPCs.
-- Auto-joins challenge creators atomically via database trigger.

BEGIN;

-- ============================================================================
-- 1. Helper Function: is_challenge_member (1-argument, checks auth.uid() internally)
-- STABLE, SECURITY DEFINER with empty search path to avoid RLS recursion
-- between public.challenges and public.challenge_participants.
-- ============================================================================
DROP FUNCTION IF EXISTS public.is_challenge_member(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.is_challenge_member(
  p_challenge_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.challenge_participants
    WHERE challenge_id = p_challenge_id
      AND user_id = (SELECT auth.uid())::text
  );
$$;

COMMENT ON FUNCTION public.is_challenge_member(UUID) IS
  'Checks if the current authenticated caller is an active participant of a challenge without RLS recursion.';

REVOKE ALL ON FUNCTION public.is_challenge_member(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_challenge_member(UUID) TO authenticated;

-- ============================================================================
-- 2. Creator Auto-Participation Trigger
-- Automatically and atomically inserts the challenge creator as participant #1
-- upon challenge creation, maintaining participants_count = 1 via existing triggers.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.handle_challenge_creator_participation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.creator_id IS NOT NULL AND (NEW.ends_at IS NULL OR NEW.ends_at > pg_catalog.now()) THEN
    INSERT INTO public.challenge_participants (challenge_id, user_id, joined_at)
    VALUES (NEW.id, NEW.creator_id, COALESCE(NEW.created_at, pg_catalog.now()))
    ON CONFLICT (challenge_id, user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_challenge_creator_participation() IS
  'Atomically registers the creator into challenge_participants upon challenge creation.';

REVOKE ALL ON FUNCTION public.handle_challenge_creator_participation() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.handle_challenge_creator_participation() FROM authenticated;

DROP TRIGGER IF EXISTS trg_challenge_creator_participation ON public.challenges;
CREATE TRIGGER trg_challenge_creator_participation
  AFTER INSERT ON public.challenges
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_challenge_creator_participation();

-- ============================================================================
-- 3. Restrict SELECT Policy on public.challenges
-- Challenge rows are visible strictly to the creator and joined participants.
-- Revoke SELECT from anon and PUBLIC. Grant nothing new.
-- ============================================================================
DROP POLICY IF EXISTS "Public can view challenges" ON public.challenges;
DROP POLICY IF EXISTS "Members and creators can view challenges" ON public.challenges;

CREATE POLICY "Members and creators can view challenges"
  ON public.challenges
  FOR SELECT
  TO authenticated
  USING (
    creator_id = (SELECT auth.uid())::text
    OR public.is_challenge_member(id)
  );

REVOKE SELECT ON public.challenges FROM anon, PUBLIC;

-- ============================================================================
-- 4. Close Direct Client Joins on public.challenge_participants
-- Revoke direct INSERT so join_challenge and respond_to_challenge_invitation
-- are the only authorized entrypoints. Direct DELETE remains for leaving.
-- ============================================================================
REVOKE INSERT ON public.challenge_participants FROM anon, authenticated, PUBLIC;

DROP POLICY IF EXISTS "Registered users can join challenges" ON public.challenge_participants;
DROP POLICY IF EXISTS "Authenticated users can join challenges" ON public.challenge_participants;
DROP POLICY IF EXISTS "Users can join challenges" ON public.challenge_participants;

-- ============================================================================
-- 5. RPC: public.get_challenge_invite_preview
-- Returns strictly minimal metadata (id, title, creator_name, challenge_type, proof_method)
-- for previewing an invitation link. Granted to BOTH anon and authenticated.
-- Missing or ended challenges raise identical generic error to prevent existence oracles.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_challenge_invite_preview(
  p_challenge_id UUID
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  creator_name TEXT,
  challenge_type TEXT,
  proof_method TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id,
    c.title,
    c.creator_name,
    c.challenge_type,
    c.proof_method
  FROM public.challenges c
  WHERE c.id = p_challenge_id
    AND (c.ends_at IS NULL OR c.ends_at > pg_catalog.now());

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This invite is not available' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.get_challenge_invite_preview(UUID) IS
  'Provides safe minimal challenge preview for invite links to anon and authenticated callers.';

REVOKE ALL ON FUNCTION public.get_challenge_invite_preview(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_challenge_invite_preview(UUID) TO anon, authenticated;

-- ============================================================================
-- 6. RPC: public.join_challenge
-- Dedicated join RPC requiring a registered account. Plain SELECT avoids
-- deadlocks with the participant count trigger. Idempotent via ON CONFLICT DO NOTHING.
-- When already joined, returns the existing participant row.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.join_challenge(
  p_challenge_id UUID
)
RETURNS public.challenge_participants
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_ends_at TIMESTAMPTZ;
  v_participant public.challenge_participants%ROWTYPE;
BEGIN
  -- 1. Identify caller securely and ensure registered account
  IF NOT public.is_registered_account() THEN
    RAISE EXCEPTION 'A registered account is required to join challenges' USING ERRCODE = '42501';
  END IF;

  v_caller_id := (SELECT auth.uid())::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- 2. Fetch challenge details without row locks to prevent deadlocks
  SELECT c.ends_at INTO v_ends_at
  FROM public.challenges c
  WHERE c.id = p_challenge_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This invite is not available' USING ERRCODE = 'P0002';
  END IF;

  -- 3. Check active window / expiry
  IF v_ends_at IS NOT NULL AND v_ends_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'Cannot join challenge: challenge has already ended' USING ERRCODE = '22023';
  END IF;

  -- 4. Idempotently insert participant row (DO NOTHING on conflict)
  INSERT INTO public.challenge_participants (
    challenge_id,
    user_id,
    joined_at
  ) VALUES (
    p_challenge_id,
    v_caller_id,
    pg_catalog.now()
  )
  ON CONFLICT (challenge_id, user_id) DO NOTHING
  RETURNING * INTO v_participant;

  -- 5. If row already existed (insert did nothing), SELECT and return the existing row
  IF v_participant IS NULL THEN
    SELECT * INTO v_participant
    FROM public.challenge_participants
    WHERE challenge_id = p_challenge_id
      AND user_id = v_caller_id;
  END IF;

  RETURN v_participant;
END;
$$;

COMMENT ON FUNCTION public.join_challenge(UUID) IS
  'Authoritative registered-account RPC for joining challenges.';

REVOKE ALL ON FUNCTION public.join_challenge(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_challenge(UUID) TO authenticated;

COMMIT;
