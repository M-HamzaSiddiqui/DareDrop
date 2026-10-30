-- DareDrop Rollback: Enforce Database Text-Length Limits (Finding L-1)
-- File: supabase/migrations/rollback/20261030010000_enforce_text_length_limits_rollback.sql
-- Status: PREPARED ROLLBACK — DO NOT EXECUTE DIRECTLY AGAINST PRODUCTION WITHOUT EXPLICIT APPROVAL
--
-- Objective:
-- Reverts all schema objects introduced by 20261030010000_enforce_text_length_limits.sql,
-- restoring the database to the exact 20261030000000 state (post M-2 expiry guard).
--
-- Operational & Security Impact:
-- 1. Drops the 3 CHECK constraints added to public.challenges:
--    - chk_challenges_title_len
--    - chk_challenges_description_len
--    - chk_challenges_creator_name_len
-- 2. Drops the 2 CHECK constraints added to public.challenge_completions:
--    - chk_completions_submission_note_len
--    - chk_completions_rejection_reason_len
-- 3. Modifies zero tables, zero columns, zero policies, zero functions, zero triggers, and zero existing data rows.
-- 4. Preserves H-1 deletion guard, M-1 update guard, and M-2 expired-challenge join guard completely untouched.
-- 5. WARNING: Rolling back this migration removes database-level text bounds on INSERT into public.challenges
--    and submissions in public.challenge_completions, re-exposing Finding L-1.

BEGIN;

-- ============================================================================
-- 1. Remove Constraints from public.challenges
-- ============================================================================
ALTER TABLE public.challenges
  DROP CONSTRAINT IF EXISTS chk_challenges_title_len,
  DROP CONSTRAINT IF EXISTS chk_challenges_description_len,
  DROP CONSTRAINT IF EXISTS chk_challenges_creator_name_len;

-- ============================================================================
-- 2. Remove Constraints from public.challenge_completions
-- ============================================================================
ALTER TABLE public.challenge_completions
  DROP CONSTRAINT IF EXISTS chk_completions_submission_note_len,
  DROP CONSTRAINT IF EXISTS chk_completions_rejection_reason_len;

COMMIT;
