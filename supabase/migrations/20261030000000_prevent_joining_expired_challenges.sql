-- DareDrop Database Migration: Prevent Joining Expired Challenges (Finding M-2)
-- File: supabase/migrations/20261030000000_prevent_joining_expired_challenges.sql
-- Status: PREPARED MIGRATION — DO NOT EXECUTE DIRECTLY AGAINST PRODUCTION WITHOUT EXPLICIT APPROVAL
--
-- Objective:
-- Enforces that users cannot join challenges that have already ended (expired challenges).
--
-- Architecture & Design Rationale:
-- 1. Authoritative Engine-Level Trigger (trg_prevent_joining_expired_challenge):
--    - Enforces expiry validation via a BEFORE INSERT trigger on public.challenge_participants.
--    - Rejects any insertion if target challenge ends_at IS NOT NULL AND ends_at <= pg_catalog.now().
--    - Operates as SECURITY DEFINER with search_path = '' and owner postgres.
--    - Provides semantic, non-silent rejection: raises exception with SQLSTATE '22023'
--      ('Cannot join challenge: challenge has already ended').
--    - Independent of RLS caller visibility: avoids complex subqueries or visibility coupling in RLS.
-- 2. Preserves Existing RLS Policy on public.challenge_participants:
--    - The existing policy "Registered users can join challenges" continues to enforce caller identity
--      (user_id = auth.uid()) and registered account verification (is_registered_account()).
--    - Leaves existing policies untouched to guarantee zero regression on invite link fetching,
--      creator auto-participation, or discover screens.
-- 3. Invariants & Compatibility:
--    - Challenge creation: Creator auto-participation succeeds (new challenges have ends_at in future).
--    - Active challenges: Registered users can continue to join directly or via invite link.
--    - Leaving challenges: Users can leave challenges via existing DELETE policy.
--    - Participant counts: Triggers trg_challenge_participant_count operate as expected.
--    - Deletion guard (H-1) and update guard (M-1) remain untouched.

BEGIN;

-- ============================================================================
-- 1. Trigger Function: check_challenge_not_expired()
-- ============================================================================
CREATE OR REPLACE FUNCTION public.check_challenge_not_expired()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_ends_at TIMESTAMPTZ;
BEGIN
  -- Look up target challenge end date directly
  SELECT ends_at INTO v_ends_at
  FROM public.challenges
  WHERE id = NEW.challenge_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Challenge not found'
      USING ERRCODE = 'P0002';
  END IF;

  -- Rejection rule: ends_at must be in the future (or NULL if ongoing)
  IF v_ends_at IS NOT NULL AND v_ends_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'Cannot join challenge: challenge has already ended'
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_challenge_not_expired() IS
  'Guards public.challenge_participants against insertions for expired challenges.';

-- Hardened execution privileges & schema ownership
ALTER FUNCTION public.check_challenge_not_expired() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.check_challenge_not_expired() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_challenge_not_expired() TO postgres, service_role;

-- ============================================================================
-- 2. Trigger Installation on public.challenge_participants
-- ============================================================================
DROP TRIGGER IF EXISTS trg_prevent_joining_expired_challenge ON public.challenge_participants;
CREATE TRIGGER trg_prevent_joining_expired_challenge
  BEFORE INSERT ON public.challenge_participants
  FOR EACH ROW
  EXECUTE FUNCTION public.check_challenge_not_expired();

COMMIT;
