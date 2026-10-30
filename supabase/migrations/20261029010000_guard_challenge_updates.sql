-- DareDrop Database Migration: Guard Challenge Update Permissions (Finding M-1)
-- File: supabase/migrations/20261029010000_guard_challenge_updates.sql
-- Status: PREPARED MIGRATION — DO NOT EXECUTE DIRECTLY AGAINST PRODUCTION WITHOUT EXPLICIT APPROVAL
--
-- Objective:
-- Enforces strict column-level privileges and database invariants for public.challenges updates:
--
-- 1. Permissions Hardening & Residual Column Grant Elimination:
--    - Revokes table-level UPDATE privilege on public.challenges from anon and authenticated.
--    - Explicitly revokes any column-level privileges on all columns of public.challenges from anon and authenticated.
--    - Grants column-level UPDATE on public.challenges STRICTLY on legitimate creator-editable fields:
--      (title, description, category, creator_name) to authenticated.
--    - Ensures anon has zero UPDATE privileges at table and column levels.
--    - Ensures authenticated has zero UPDATE privileges on protected/system fields:
--      participants_count, id, creator_id, created_at, challenge_type, duration_days, ends_at, timezone.
--    - Leaves service_role and postgres privileges completely untouched.
--    - Preserves existing SELECT, INSERT, and DELETE table grants and RLS policies for all roles.
--
-- 2. Trigger Invariant Guard (trg_guard_challenge_updates):
--    - Enforces immutability of id, creator_id, created_at, and challenge_type.
--    - Enforces derivation integrity: participants_count must strictly equal actual rows in challenge_participants.
--    - Locks duration_days, ends_at, and timezone if co-participants exist, completion history exists,
--      or invitations have been sent.
--    - Backward-compatible text validation: Only validates title, description, and creator_name IF CHANGED.
--      Unchanged legacy records are never blocked from legitimate edits.
--
-- 3. Compatibility & Internal Maintenance:
--    - handle_challenge_participant_count() and handle_challenge_participant_truncate() are SECURITY DEFINER
--      functions owned by postgres, which retains table-level UPDATE privilege. They continue to maintain
--      participants_count without impedance.

BEGIN;

-- ============================================================================
-- 1. Permissions Hardening: Revoke Table-Level & Residual Column UPDATE Grants
-- ============================================================================

-- A. Revoke blanket table-level UPDATE from anon and authenticated
REVOKE UPDATE ON public.challenges FROM anon, authenticated;

-- B. Explicitly eliminate any residual column-level privileges across all columns
REVOKE ALL (
  id,
  title,
  description,
  category,
  duration_days,
  ends_at,
  creator_id,
  creator_name,
  created_at,
  participants_count,
  challenge_type,
  timezone
) ON public.challenges FROM anon, authenticated;

-- C. Grant column-level UPDATE strictly on legitimate creator-editable fields to authenticated
GRANT UPDATE (title, description, category, creator_name) ON public.challenges TO authenticated;

-- ============================================================================
-- 2. Trigger Function: guard_challenge_updates()
-- ============================================================================
CREATE OR REPLACE FUNCTION public.guard_challenge_updates()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actual_participant_count BIGINT;
BEGIN
  -- ==========================================================================
  -- A. Immutable Core Identifiers & Metadata (Defense-in-Depth)
  -- ==========================================================================
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Challenge ID is immutable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.creator_id IS DISTINCT FROM OLD.creator_id THEN
    RAISE EXCEPTION 'Challenge creator cannot be transferred'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Challenge creation timestamp is immutable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.challenge_type IS DISTINCT FROM OLD.challenge_type THEN
    RAISE EXCEPTION 'Challenge type is immutable after creation'
      USING ERRCODE = '22000';
  END IF;

  -- ==========================================================================
  -- B. Relational Derivation Guard for participants_count
  -- ==========================================================================
  -- Direct client updates to participants_count are blocked at the engine layer
  -- via column privileges. For any internal/privileged update (e.g. participant counter trigger),
  -- this check ensures participants_count strictly equals the actual child row count.
  IF NEW.participants_count IS DISTINCT FROM OLD.participants_count THEN
    SELECT COUNT(*)
    INTO v_actual_participant_count
    FROM public.challenge_participants
    WHERE challenge_id = OLD.id;

    IF NEW.participants_count <> v_actual_participant_count THEN
      RAISE EXCEPTION 'participants_count must match actual participant count'
        USING ERRCODE = '22000';
    END IF;
  END IF;

  -- ==========================================================================
  -- C. Lifecycle Guards for duration_days, ends_at, and timezone
  -- ==========================================================================
  IF (NEW.duration_days IS DISTINCT FROM OLD.duration_days)
     OR (NEW.ends_at IS DISTINCT FROM OLD.ends_at)
     OR (NEW.timezone IS DISTINCT FROM OLD.timezone) THEN

    -- Block modifications if ANY other participant has joined
    IF EXISTS (
      SELECT 1 FROM public.challenge_participants
      WHERE challenge_id = OLD.id
        AND (OLD.creator_id IS NULL OR user_id <> OLD.creator_id)
    ) THEN
      RAISE EXCEPTION 'Cannot modify duration, end time, or timezone: other participants have already joined'
        USING ERRCODE = '23503';
    END IF;

    -- Block modifications if ANY peer verification completion history exists
    IF EXISTS (
      SELECT 1 FROM public.challenge_completions
      WHERE challenge_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'Cannot modify duration, end time, or timezone: verification history exists'
        USING ERRCODE = '23503';
    END IF;

    -- Block modifications if ANY invitation record exists
    IF EXISTS (
      SELECT 1 FROM public.challenge_invitations
      WHERE challenge_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'Cannot modify duration, end time, or timezone: invitation history exists'
        USING ERRCODE = '23503';
    END IF;

    -- Sane bounds checks when solo with no history
    IF NEW.duration_days <= 0 THEN
      RAISE EXCEPTION 'duration_days must be greater than zero'
        USING ERRCODE = '22023';
    END IF;

    IF NEW.ends_at IS NOT NULL AND NEW.ends_at <= OLD.created_at THEN
      RAISE EXCEPTION 'ends_at must be after creation time'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- ==========================================================================
  -- D. Backward-Compatible Validation for Editable Fields (ONLY WHEN CHANGED)
  -- ==========================================================================

  -- Title validation: only evaluated if title is being modified
  IF NEW.title IS DISTINCT FROM OLD.title THEN
    IF NEW.title IS NULL OR pg_catalog.btrim(NEW.title) = '' THEN
      RAISE EXCEPTION 'Title cannot be empty'
        USING ERRCODE = '22023';
    END IF;

    IF pg_catalog.char_length(NEW.title) > 100 THEN
      RAISE EXCEPTION 'Title cannot exceed 100 characters'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Description validation: only evaluated if description is being modified
  IF NEW.description IS DISTINCT FROM OLD.description THEN
    IF NEW.description IS NULL OR pg_catalog.btrim(NEW.description) = '' THEN
      RAISE EXCEPTION 'Description cannot be empty'
        USING ERRCODE = '22023';
    END IF;

    IF pg_catalog.char_length(NEW.description) > 2000 THEN
      RAISE EXCEPTION 'Description cannot exceed 2000 characters'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Creator name validation: only evaluated if creator_name is being modified
  IF NEW.creator_name IS DISTINCT FROM OLD.creator_name THEN
    IF NEW.creator_name IS NULL OR pg_catalog.btrim(NEW.creator_name) = '' THEN
      RAISE EXCEPTION 'Creator name cannot be empty'
        USING ERRCODE = '22023';
    END IF;

    IF pg_catalog.char_length(NEW.creator_name) > 100 THEN
      RAISE EXCEPTION 'Creator name cannot exceed 100 characters'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_challenge_updates() IS
  'Enforces database-level immutability, participant count derivation integrity, and lifecycle guards on public.challenges updates.';

-- Hardened execution privileges & schema ownership
ALTER FUNCTION public.guard_challenge_updates() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_challenge_updates() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_challenge_updates() TO postgres, service_role;

-- ============================================================================
-- 3. Trigger Installation on public.challenges
-- ============================================================================
DROP TRIGGER IF EXISTS trg_guard_challenge_updates ON public.challenges;
CREATE TRIGGER trg_guard_challenge_updates
  BEFORE UPDATE ON public.challenges
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_challenge_updates();

COMMIT;
