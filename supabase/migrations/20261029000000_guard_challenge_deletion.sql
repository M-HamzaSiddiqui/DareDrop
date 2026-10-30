-- DareDrop Database Migration: Guard Challenge Deletion Against Data Destruction
-- File: supabase/migrations/20261029000000_guard_challenge_deletion.sql
-- Status: PREPARED MIGRATION — DO NOT EXECUTE DIRECTLY AGAINST PRODUCTION WITHOUT EXPLICIT APPROVAL
--
-- Objective:
-- Prevent unilateral, accidental, or malicious hard deletion of challenges that have active co-participants,
-- peer verification completion history, or invitation records (pending, accepted, declined, or expired).
-- Preserves legitimate deletion of unused test challenges (creator only, zero completions, zero invites).
--
-- Invariants Enforced:
-- 1. Completions Guard: If ANY row exists in public.challenge_completions for the challenge, deletion is aborted.
-- 2. Participants Guard: If ANY participant other than the creator exists in public.challenge_participants, deletion is aborted.
-- 3. Invitations Guard: If ANY invitation row exists in public.challenge_invitations (regardless of status), deletion is aborted.
-- 4. Clean Creator Cleanup: If only the creator is in challenge_participants and no completions or invitations exist, deletion proceeds.
-- 5. Counter Independence: Evaluates actual relational rows; does NOT rely on the mutable participants_count column.
-- 6. Engine-Level Security: Operates in a BEFORE DELETE trigger, preventing foreign-key cascade deletions before they start.

BEGIN;

-- ============================================================================
-- 1. Trigger Function: check_challenge_can_be_deleted()
-- ============================================================================
CREATE OR REPLACE FUNCTION public.check_challenge_can_be_deleted()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_has_completions BOOLEAN;
  v_has_other_participants BOOLEAN;
  v_has_invitations BOOLEAN;
BEGIN
  -- 1. Check if ANY completion records exist (pending, approved, or rejected)
  SELECT EXISTS (
    SELECT 1 FROM public.challenge_completions
    WHERE challenge_id = OLD.id
  ) INTO v_has_completions;

  IF v_has_completions THEN
    RAISE EXCEPTION 'Cannot delete challenge: verification history exists for this challenge'
      USING ERRCODE = '23503';
  END IF;

  -- 2. Check if ANY participant other than the creator exists
  -- Strictly queries relational rows; does NOT rely on mutable participants_count
  SELECT EXISTS (
    SELECT 1 FROM public.challenge_participants
    WHERE challenge_id = OLD.id
      AND (OLD.creator_id IS NULL OR user_id <> OLD.creator_id)
  ) INTO v_has_other_participants;

  IF v_has_other_participants THEN
    RAISE EXCEPTION 'Cannot delete challenge: other participants have already joined'
      USING ERRCODE = '23503';
  END IF;

  -- 3. Check if ANY invitation records exist, regardless of status
  -- Preserves complete social invitation history (pending, accepted, declined, expired)
  SELECT EXISTS (
    SELECT 1 FROM public.challenge_invitations
    WHERE challenge_id = OLD.id
  ) INTO v_has_invitations;

  IF v_has_invitations THEN
    RAISE EXCEPTION 'Cannot delete challenge: invitation history exists for this challenge'
      USING ERRCODE = '23503';
  END IF;

  -- If only the creator is a participant and no completions or invites exist, allow deletion
  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.check_challenge_can_be_deleted() IS
  'Guards public.challenges against deletion whenever co-participants, completion history, or invitation records exist.';

-- Hardened execution privileges & schema ownership
ALTER FUNCTION public.check_challenge_can_be_deleted() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.check_challenge_can_be_deleted() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_challenge_can_be_deleted() TO postgres, service_role;

-- ============================================================================
-- 2. Trigger Installation on public.challenges
-- ============================================================================
DROP TRIGGER IF EXISTS trg_prevent_active_challenge_deletion ON public.challenges;
CREATE TRIGGER trg_prevent_active_challenge_deletion
  BEFORE DELETE ON public.challenges
  FOR EACH ROW
  EXECUTE FUNCTION public.check_challenge_can_be_deleted();

COMMIT;
