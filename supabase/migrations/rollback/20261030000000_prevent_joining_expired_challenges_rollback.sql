-- DareDrop Rollback: Prevent Joining Expired Challenges Migration (Finding M-2)
-- File: supabase/migrations/rollback/20261030000000_prevent_joining_expired_challenges_rollback.sql
-- Status: PREPARED ROLLBACK — DO NOT EXECUTE DIRECTLY AGAINST PRODUCTION WITHOUT EXPLICIT APPROVAL
--
-- Objective:
-- Reverts all schema objects introduced by 20261030000000_prevent_joining_expired_challenges.sql,
-- restoring the database to the exact 20261029010000 state (post M-1 challenge update guard).
--
-- Operational & Security Impact:
-- 1. Drops trigger trg_prevent_joining_expired_challenge from public.challenge_participants.
-- 2. Drops function public.check_challenge_not_expired().
-- 3. Modifies zero tables, zero columns, zero policies, and zero existing data rows.
-- 4. Preserves H-1 deletion guard and M-1 update guard completely untouched.
-- 5. WARNING: Rolling back this migration removes expiry enforcement on challenge joins,
--    re-exposing Finding M-2 (allowing registered users to join expired challenges via direct PostgREST calls).

BEGIN;

-- ============================================================================
-- 1. Drop Trigger & Trigger Function Introduced by M-2
-- ============================================================================
DROP TRIGGER IF EXISTS trg_prevent_joining_expired_challenge ON public.challenge_participants;
DROP FUNCTION IF EXISTS public.check_challenge_not_expired();

COMMIT;
