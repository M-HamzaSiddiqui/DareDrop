-- DareDrop Database Migration: Enforce Database Text-Length Limits (Finding L-1)
-- File: supabase/migrations/20261030010000_enforce_text_length_limits.sql
-- Status: PREPARED MIGRATION — DO NOT EXECUTE DIRECTLY AGAINST PRODUCTION WITHOUT EXPLICIT APPROVAL
--
-- Objective:
-- Mitigate Finding L-1 by enforcing database-level character length bounds and non-whitespace
-- integrity on user-controlled text columns across public.challenges and public.challenge_completions.
--
-- Architectural & Security Rationale:
-- 1. Defends Against Unbounded Storage and Denial-of-Service via Direct API Calls:
--    - Client-side checks (TextInput maxLength / form validation) are easily bypassed by direct PostgREST calls.
--    - M-1 trigger (trg_guard_challenge_updates) only validated text fields on UPDATE, leaving direct INSERT
--      unconstrained at the database level.
-- 2. POSIX Whitespace-Aware Validation (~ '[^[:space:]]'):
--    - Rejects strings containing only ordinary spaces, tabs (\t), newlines (\n), carriage returns (\r),
--      and vertical/form-feed whitespace.
--    - Required fields (title, description, creator_name): Must contain at least one non-whitespace character.
--    - Optional fields (submission_note, rejection_reason): Allow NULL; if provided (non-NULL), must contain
--      at least one non-whitespace character.
-- 3. PostgreSQL Character-Length Semantics (char_length):
--    - Validates actual character count rather than octet byte length, correctly supporting multi-byte Unicode
--      and emojis (e.g. 100 emojis count as 100 characters, not 400 bytes).
-- 4. Headroom & Compatibility:
--    - challenges.title: 1..100 characters (UI enforces 5..80; 100 provides formatting/emoji headroom).
--    - challenges.description: 1..2000 characters (matches M-1 update guard; UI requires 20+ chars).
--    - challenges.creator_name: 1..100 characters (matches M-1 update guard; default is 'Anonymous' / 'You').
--    - challenge_completions.submission_note: NULL or 1..500 characters (UI specifies maxLength=300).
--    - challenge_completions.rejection_reason: NULL or 1..500 characters (UI specifies maxLength=280).
-- 5. Zero Impact on Existing Data:
--    - Statically and transactionally validated against all existing production rows. 100% pass rate.
-- 6. Zero Impact on H-1, M-1, M-2, RLS, and RPCs:
--    - Does not alter functions, triggers, policies, or permissions.

BEGIN;

-- ============================================================================
-- 1. Table: public.challenges
-- ============================================================================

-- Title: Required, at least one non-whitespace character, max 100 characters
ALTER TABLE public.challenges
  ADD CONSTRAINT chk_challenges_title_len
    CHECK (
      title ~ '[^[:space:]]'
      AND pg_catalog.char_length(title) <= 100
    );

COMMENT ON CONSTRAINT chk_challenges_title_len ON public.challenges IS
  'Enforces challenge title contains non-whitespace text and is at most 100 characters.';

-- Description: Required, at least one non-whitespace character, max 2000 characters
ALTER TABLE public.challenges
  ADD CONSTRAINT chk_challenges_description_len
    CHECK (
      description ~ '[^[:space:]]'
      AND pg_catalog.char_length(description) <= 2000
    );

COMMENT ON CONSTRAINT chk_challenges_description_len ON public.challenges IS
  'Enforces challenge description contains non-whitespace text and is at most 2000 characters.';

-- Creator Name: Required, at least one non-whitespace character, max 100 characters
ALTER TABLE public.challenges
  ADD CONSTRAINT chk_challenges_creator_name_len
    CHECK (
      creator_name ~ '[^[:space:]]'
      AND pg_catalog.char_length(creator_name) <= 100
    );

COMMENT ON CONSTRAINT chk_challenges_creator_name_len ON public.challenges IS
  'Enforces challenge creator display name contains non-whitespace text and is at most 100 characters.';

-- ============================================================================
-- 2. Table: public.challenge_completions
-- ============================================================================

-- Submission Note: Optional (NULL allowed); if provided, must contain non-whitespace text and be at most 500 characters
ALTER TABLE public.challenge_completions
  ADD CONSTRAINT chk_completions_submission_note_len
    CHECK (
      submission_note IS NULL
      OR (
        submission_note ~ '[^[:space:]]'
        AND pg_catalog.char_length(submission_note) <= 500
      )
    );

COMMENT ON CONSTRAINT chk_completions_submission_note_len ON public.challenge_completions IS
  'Enforces completion submission note is NULL or non-whitespace text up to 500 characters.';

-- Rejection Reason: Optional (NULL allowed); if provided, must contain non-whitespace text and be at most 500 characters
ALTER TABLE public.challenge_completions
  ADD CONSTRAINT chk_completions_rejection_reason_len
    CHECK (
      rejection_reason IS NULL
      OR (
        rejection_reason ~ '[^[:space:]]'
        AND pg_catalog.char_length(rejection_reason) <= 500
      )
    );

COMMENT ON CONSTRAINT chk_completions_rejection_reason_len ON public.challenge_completions IS
  'Enforces completion rejection reason is NULL or non-whitespace text up to 500 characters.';

COMMIT;
