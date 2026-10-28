-- DareDrop Peer-Verification & Progress Tracking Migration
-- File: supabase/migrations/20261024000000_peer_verification.sql

-- 1. Schema Hardening: Revoke CREATE on public from untrusted client roles
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    REVOKE CREATE ON SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE CREATE ON SCHEMA public FROM authenticated;
  END IF;
END $$;

-- 2. Add challenge_type and timezone to challenges table with safe explicit backfill
ALTER TABLE public.challenges
  ADD COLUMN IF NOT EXISTS challenge_type TEXT,
  ADD COLUMN IF NOT EXISTS timezone TEXT;

-- Safe explicit backfill: all verified existing challenges in the repository are multi-day habit challenges ('daily')
UPDATE public.challenges
SET challenge_type = 'daily'
WHERE challenge_type IS NULL;

-- Repair empty or whitespace-only timezones to 'UTC'
UPDATE public.challenges
SET timezone = 'UTC'
WHERE timezone IS NULL OR pg_catalog.btrim(timezone) = '';

-- Fail loudly if any existing challenge has an invalid, unresolvable timezone name
DO $$
DECLARE
  v_invalid_count INT;
  v_sample_invalid TEXT;
BEGIN
  SELECT count(*), min(timezone)
  INTO v_invalid_count, v_sample_invalid
  FROM public.challenges c
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names tz WHERE tz.name = c.timezone
  );

  IF v_invalid_count > 0 THEN
    RAISE EXCEPTION 'Migration failed: % challenges have invalid timezones (e.g. "%"). Repair invalid timezone names before migrating.',
      v_invalid_count, v_sample_invalid USING ERRCODE = '22023';
  END IF;
END $$;

-- Apply NOT NULL and DEFAULT constraints after validated backfill
ALTER TABLE public.challenges
  ALTER COLUMN challenge_type SET DEFAULT 'daily',
  ALTER COLUMN challenge_type SET NOT NULL,
  ALTER COLUMN timezone SET DEFAULT 'UTC',
  ALTER COLUMN timezone SET NOT NULL;

DO $$
BEGIN
  -- Strict table-scoped check for chk_challenge_type
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.challenges'::pg_catalog.regclass
      AND conname = 'chk_challenge_type'
  ) THEN
    ALTER TABLE public.challenges
      ADD CONSTRAINT chk_challenge_type CHECK (challenge_type IN ('daily', 'one_time'));
  END IF;

  -- Strict table-scoped check for unique_challenge_id_type
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.challenges'::pg_catalog.regclass
      AND conname = 'unique_challenge_id_type'
  ) THEN
    ALTER TABLE public.challenges
      ADD CONSTRAINT unique_challenge_id_type UNIQUE (id, challenge_type);
  END IF;
END $$;

-- 3. Timezone Validation Trigger on challenges (Hardened with empty search_path)
CREATE OR REPLACE FUNCTION public.validate_challenge_timezone()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.timezone IS NULL OR pg_catalog.btrim(NEW.timezone) = '' THEN
    NEW.timezone := 'UTC';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.timezone
  ) THEN
    RAISE EXCEPTION 'Invalid timezone: "%". Must be a valid IANA or PostgreSQL timezone name.', NEW.timezone USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;

-- Trigger functions must not be directly callable by client roles
REVOKE ALL ON FUNCTION public.validate_challenge_timezone() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_validate_challenge_timezone ON public.challenges;
CREATE TRIGGER trg_validate_challenge_timezone
  BEFORE INSERT OR UPDATE OF timezone ON public.challenges
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_challenge_timezone();

-- 4. Create Challenge Completions Table
CREATE TABLE IF NOT EXISTS public.challenge_completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID NOT NULL,
  challenge_type TEXT NOT NULL CHECK (challenge_type IN ('daily', 'one_time')),
  participant_id TEXT NOT NULL,
  verifier_id TEXT NOT NULL,
  completion_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  submission_note TEXT,
  rejection_reason TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at TIMESTAMPTZ,

  -- Enforce parent-child challenge_type consistency via composite foreign key
  CONSTRAINT fk_completions_challenge_and_type
    FOREIGN KEY (challenge_id, challenge_type)
    REFERENCES public.challenges(id, challenge_type)
    ON DELETE CASCADE,

  -- Self-verification is strictly prohibited at the database constraint level
  CONSTRAINT chk_no_self_verification CHECK (participant_id != verifier_id)
);

-- 5. Indexes & Constraints

-- Daily Dare Rule: At most one submission record per participant, challenge, and calendar date
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_daily_completion
  ON public.challenge_completions (challenge_id, participant_id, completion_date)
  WHERE challenge_type = 'daily';

-- One-Time Dare Rule A: At most one approved completion per participant
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_approved_onetime
  ON public.challenge_completions (challenge_id, participant_id)
  WHERE challenge_type = 'one_time' AND status = 'approved';

-- One-Time Dare Rule B: At most one active (pending or approved) submission
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_onetime
  ON public.challenge_completions (challenge_id, participant_id)
  WHERE challenge_type = 'one_time' AND status IN ('pending', 'approved');

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_completions_participant_lookup
  ON public.challenge_completions (challenge_id, participant_id, status);

CREATE INDEX IF NOT EXISTS idx_completions_verifier_lookup
  ON public.challenge_completions (verifier_id, status);

CREATE INDEX IF NOT EXISTS idx_completions_challenge_status
  ON public.challenge_completions (challenge_id, status);

-- 6. Row Level Security (RLS) & Permissions Audit
ALTER TABLE public.challenge_completions ENABLE ROW LEVEL SECURITY;

-- Block direct INSERT, UPDATE, DELETE from untrusted client tokens. All mutations must use security definer RPCs.
REVOKE ALL ON TABLE public.challenge_completions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.challenge_completions TO authenticated;

-- SELECT Policy: Submitter, Assigned Verifier, and Challenge Creator can view completion records
DROP POLICY IF EXISTS "Authorized users can view completions" ON public.challenge_completions;
CREATE POLICY "Authorized users can view completions"
  ON public.challenge_completions
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() IS NOT NULL AND (
      participant_id = auth.uid()::text
      OR verifier_id = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.challenges c
        WHERE c.id = challenge_completions.challenge_id
          AND c.creator_id = auth.uid()::text
      )
    )
  );

-- 6b. Helper: Challenge active window (single source of truth for submit + progress)
-- Semantics (all dates are calendar dates in the challenge's own timezone):
--   start_date = local date of created_at.
--   end_date   = start_date + duration_days - 1, capped by the ends_at deadline.
--   ends_at is an EXCLUSIVE instant: the challenge is active for instants strictly before it.
--     * local ends_at exactly at 00:00:00 (no fractional part) -> last active date is the previous day.
--     * local ends_at at any other time (incl. 00:00:00.5)      -> last active date is that same day.
--     This is computed by comparing against date_trunc('day', ...) on the local timestamp, so it is exact
--     to the microsecond and never subtracts an arbitrary epsilon.
--   is_empty = TRUE when ends_at <= created_at (deadline not after the start instant) or end_date < start_date.
--     An empty window has NO active dates: submissions are rejected and progress counts nothing.
--     (No GREATEST(start, end) fallback: an expired/empty window is never silently revived.)
-- Plain (SECURITY INVOKER) function; only the SECURITY DEFINER RPCs below call it.
CREATE OR REPLACE FUNCTION public.challenge_active_window(
  p_created_at TIMESTAMPTZ,
  p_ends_at TIMESTAMPTZ,
  p_duration_days INT,
  p_timezone TEXT,
  OUT start_date DATE,
  OUT end_date DATE,
  OUT is_empty BOOLEAN
)
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_ends_local TIMESTAMP;
  v_deadline_date DATE;
BEGIN
  start_date := (p_created_at AT TIME ZONE p_timezone)::date;
  end_date := start_date + (p_duration_days - 1);
  is_empty := FALSE;

  IF p_ends_at IS NOT NULL THEN
    IF p_ends_at <= p_created_at THEN
      end_date := start_date - 1;
      is_empty := TRUE;
      RETURN;
    END IF;

    v_ends_local := p_ends_at AT TIME ZONE p_timezone;
    IF v_ends_local = pg_catalog.date_trunc('day', v_ends_local) THEN
      v_deadline_date := v_ends_local::date - 1;
    ELSE
      v_deadline_date := v_ends_local::date;
    END IF;
    end_date := LEAST(end_date, v_deadline_date);
  END IF;

  IF end_date < start_date THEN
    is_empty := TRUE;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.challenge_active_window(TIMESTAMPTZ, TIMESTAMPTZ, INT, TEXT) FROM PUBLIC, anon, authenticated;

-- 7. RPC: Submit / Resubmit Challenge Completion
-- Enforces: Active challenge date boundaries, midnight handling, timeliness, 2-key advisory lock, row locks
CREATE OR REPLACE FUNCTION public.submit_challenge_completion(
  p_challenge_id UUID,
  p_verifier_id TEXT,
  p_completion_date DATE,
  p_submission_note TEXT DEFAULT NULL
)
RETURNS public.challenge_completions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_challenge public.challenges%ROWTYPE;
  v_existing public.challenge_completions%ROWTYPE;
  v_today_in_tz DATE;
  v_challenge_start_date DATE;
  v_challenge_end_date DATE;
  v_window_empty BOOLEAN;
  v_result public.challenge_completions%ROWTYPE;
  v_constraint_name TEXT;
  v_lock_namespace INT := 424201; -- Dedicated namespace for DareDrop submission serialization
  v_lock_resource INT;
BEGIN
  -- 1. Identify caller securely via session JWT
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- 2. Fetch challenge details
  SELECT * INTO v_challenge FROM public.challenges WHERE id = p_challenge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Challenge not found' USING ERRCODE = 'P0002';
  END IF;

  -- 3. Timezone-aware date validation & active lifecycle calculation:
  -- Fail safely if timezone is invalid; never silently fall back
  BEGIN
    v_today_in_tz := (pg_catalog.now() AT TIME ZONE v_challenge.timezone)::date;
    SELECT w.start_date, w.end_date, w.is_empty
    INTO v_challenge_start_date, v_challenge_end_date, v_window_empty
    FROM public.challenge_active_window(
      v_challenge.created_at, v_challenge.ends_at, v_challenge.duration_days, v_challenge.timezone
    ) w;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid timezone configuration on challenge: %', v_challenge.timezone USING ERRCODE = '22023';
  END;

  -- Empty / expired active window (ends_at not after the start instant): nothing can be submitted
  IF v_window_empty THEN
    RAISE EXCEPTION 'Challenge has no active submission window (ends_at % is not after its start %)', v_challenge.ends_at, v_challenge.created_at USING ERRCODE = '22023';
  END IF;

  -- Active challenge date boundaries enforcement:
  IF p_completion_date < v_challenge_start_date THEN
    RAISE EXCEPTION 'Cannot submit proof for date % before challenge started (%)', p_completion_date, v_challenge_start_date USING ERRCODE = '22023';
  END IF;

  IF p_completion_date > v_challenge_end_date THEN
    RAISE EXCEPTION 'Cannot submit proof for date % after challenge ended (%)', p_completion_date, v_challenge_end_date USING ERRCODE = '22023';
  END IF;

  -- Timeliness boundary comparison: allow today or yesterday in challenge timezone
  -- (Applies equally to daily challenges and one-time dares for prompt, honest peer verification)
  IF p_completion_date > v_today_in_tz THEN
    RAISE EXCEPTION 'Cannot submit proof for a future date (current challenge date is %)', v_today_in_tz USING ERRCODE = '22023';
  ELSIF p_completion_date < (v_today_in_tz - 1) THEN
    RAISE EXCEPTION 'Submission window expired for date % (allowed: % to %)', p_completion_date, (v_today_in_tz - 1), v_today_in_tz USING ERRCODE = '22023';
  END IF;

  -- 4. Serialize concurrent submission attempts using a 2-key advisory lock:
  -- Key 1: Application namespace (424201)
  -- Key 2: Hash of (challenge_id, caller_id, date/one_time)
  v_lock_resource := pg_catalog.hashtext(
    p_challenge_id::text || ':' || v_caller_id || ':' ||
    CASE WHEN v_challenge.challenge_type = 'one_time' THEN 'one_time' ELSE p_completion_date::text END
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(v_lock_namespace, v_lock_resource);

  -- 5. Race-safe membership check with FOR SHARE lock (coordinates with concurrent leaves)
  PERFORM 1 FROM public.challenge_participants
  WHERE challenge_id = p_challenge_id AND user_id = v_caller_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You must be an active participant to submit proof' USING ERRCODE = '42501';
  END IF;

  -- 6. Authoritative verifier eligibility check:
  -- Verifier must not be the submitter.
  -- Verifier must be either the challenge creator (referee) or an active co-participant.
  IF p_verifier_id = v_caller_id THEN
    RAISE EXCEPTION 'You cannot designate yourself as verifier' USING ERRCODE = '22023';
  END IF;

  IF p_verifier_id != v_challenge.creator_id THEN
    PERFORM 1 FROM public.challenge_participants
    WHERE challenge_id = p_challenge_id AND user_id = p_verifier_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Designated verifier must be the challenge creator or an active participant' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 7. Check existing completion records under row lock (FOR UPDATE)
  IF v_challenge.challenge_type = 'one_time' THEN
    SELECT * INTO v_existing
    FROM public.challenge_completions
    WHERE challenge_id = p_challenge_id AND participant_id = v_caller_id
    FOR UPDATE;

    IF FOUND THEN
      IF v_existing.status = 'approved' THEN
        RAISE EXCEPTION 'This one-time dare has already been approved' USING ERRCODE = '23505';
      ELSIF v_existing.status = 'pending' THEN
        RAISE EXCEPTION 'A submission for this dare is already pending verification' USING ERRCODE = '23505';
      ELSIF v_existing.status = 'rejected' THEN
        -- Resubmission: update the rejected row back to pending
        UPDATE public.challenge_completions
        SET
          verifier_id = p_verifier_id,
          completion_date = p_completion_date,
          status = 'pending',
          submission_note = pg_catalog.btrim(p_submission_note),
          rejection_reason = NULL,
          submitted_at = pg_catalog.now(),
          reviewed_at = NULL
        WHERE id = v_existing.id
        RETURNING * INTO v_result;
        RETURN v_result;
      END IF;
    END IF;
  ELSE
    -- Daily challenge: check specific calendar date with lock
    SELECT * INTO v_existing
    FROM public.challenge_completions
    WHERE challenge_id = p_challenge_id
      AND participant_id = v_caller_id
      AND completion_date = p_completion_date
    FOR UPDATE;

    IF FOUND THEN
      IF v_existing.status = 'approved' THEN
        RAISE EXCEPTION 'Day % is already approved', p_completion_date USING ERRCODE = '23505';
      ELSIF v_existing.status = 'pending' THEN
        RAISE EXCEPTION 'Day % is already pending verification', p_completion_date USING ERRCODE = '23505';
      ELSIF v_existing.status = 'rejected' THEN
        -- Resubmission for same day: reset to pending
        UPDATE public.challenge_completions
        SET
          verifier_id = p_verifier_id,
          status = 'pending',
          submission_note = pg_catalog.btrim(p_submission_note),
          rejection_reason = NULL,
          submitted_at = pg_catalog.now(),
          reviewed_at = NULL
        WHERE id = v_existing.id
        RETURNING * INTO v_result;
        RETURN v_result;
      END IF;
    END IF;
  END IF;

  -- 8. Insert new pending submission (derived challenge_type)
  BEGIN
    INSERT INTO public.challenge_completions (
      challenge_id,
      challenge_type,
      participant_id,
      verifier_id,
      completion_date,
      status,
      submission_note
    ) VALUES (
      p_challenge_id,
      v_challenge.challenge_type,
      v_caller_id,
      p_verifier_id,
      p_completion_date,
      'pending',
      pg_catalog.btrim(p_submission_note)
    )
    RETURNING * INTO v_result;

    RETURN v_result;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name IN ('idx_unique_daily_completion', 'idx_unique_active_onetime', 'idx_unique_approved_onetime') THEN
      RAISE EXCEPTION 'A submission already exists for this challenge date' USING ERRCODE = '23505';
    ELSE
      RAISE;
    END IF;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_challenge_completion(UUID, TEXT, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_challenge_completion(UUID, TEXT, DATE, TEXT) TO authenticated;

-- 8. RPC: Review Challenge Completion (Hardened search_path, row locking & membership locking)
CREATE OR REPLACE FUNCTION public.review_challenge_completion(
  p_completion_id UUID,
  p_decision TEXT,
  p_rejection_reason TEXT DEFAULT NULL
)
RETURNS public.challenge_completions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_challenge public.challenges%ROWTYPE;
  v_completion public.challenge_completions%ROWTYPE;
BEGIN
  -- 1. Verify caller authentication
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- 2. Validate decision argument
  IF p_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be approved or rejected' USING ERRCODE = '22023';
  END IF;

  -- 3. Lock completion row for atomic state transition
  SELECT * INTO v_completion
  FROM public.challenge_completions
  WHERE id = p_completion_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Completion record not found' USING ERRCODE = 'P0002';
  END IF;

  -- 4. Enforce verifier authorization
  IF v_completion.verifier_id != v_caller_id THEN
    RAISE EXCEPTION 'Only the assigned verifier can review this submission' USING ERRCODE = '42501';
  END IF;

  -- 5. Anti-self-verification check
  IF v_completion.participant_id = v_caller_id THEN
    RAISE EXCEPTION 'Participants cannot verify their own submissions' USING ERRCODE = '42501';
  END IF;

  -- 6. Enforce state machine: only pending submissions can be reviewed
  IF v_completion.status != 'pending' THEN
    RAISE EXCEPTION 'Only pending submissions can be reviewed (current status: %)', v_completion.status USING ERRCODE = '22000';
  END IF;

  -- 7. Validate membership consistency with FOR SHARE locks (serializes against leaving):
  SELECT * INTO v_challenge FROM public.challenges WHERE id = v_completion.challenge_id;

  -- Verifier must STILL be challenge creator or active participant
  IF v_caller_id != v_challenge.creator_id THEN
    PERFORM 1 FROM public.challenge_participants
    WHERE challenge_id = v_completion.challenge_id AND user_id = v_caller_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'You are no longer an active participant or creator of this challenge' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Submitter must STILL be an active participant
  PERFORM 1 FROM public.challenge_participants
  WHERE challenge_id = v_completion.challenge_id AND user_id = v_completion.participant_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Submitter is no longer an active participant of this challenge' USING ERRCODE = '42501';
  END IF;

  -- 8. Execute atomic update
  UPDATE public.challenge_completions
  SET
    status = p_decision,
    rejection_reason = CASE
      WHEN p_decision = 'rejected' THEN
        CASE
          WHEN p_rejection_reason IS NOT NULL AND pg_catalog.btrim(p_rejection_reason) != '' THEN pg_catalog.btrim(p_rejection_reason)
          ELSE 'Proof was insufficient or unverified'
        END
      ELSE NULL
    END,
    reviewed_at = pg_catalog.now()
  WHERE id = p_completion_id
  RETURNING * INTO v_completion;

  RETURN v_completion;
END;
$$;

REVOKE ALL ON FUNCTION public.review_challenge_completion(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.review_challenge_completion(UUID, TEXT, TEXT) TO authenticated;

-- 9. RPC: Reassign Challenge Verifier (Hardened search_path, row locking & membership locking)
CREATE OR REPLACE FUNCTION public.reassign_challenge_verifier(
  p_completion_id UUID,
  p_new_verifier_id TEXT
)
RETURNS public.challenge_completions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_challenge public.challenges%ROWTYPE;
  v_completion public.challenge_completions%ROWTYPE;
BEGIN
  -- 1. Verify caller authentication
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- 2. Fetch and lock completion row
  SELECT * INTO v_completion
  FROM public.challenge_completions
  WHERE id = p_completion_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Completion record not found' USING ERRCODE = 'P0002';
  END IF;

  -- 3. Only the submitter can reassign their pending submission
  IF v_completion.participant_id != v_caller_id THEN
    RAISE EXCEPTION 'Only the submitter can reassign this submission' USING ERRCODE = '42501';
  END IF;

  -- 4. Reassignment is forbidden once reviewed
  IF v_completion.status != 'pending' THEN
    RAISE EXCEPTION 'Cannot reassign a submission that has already been reviewed (status: %)', v_completion.status USING ERRCODE = '22000';
  END IF;

  -- 5. Anti-self-verification
  IF p_new_verifier_id = v_caller_id THEN
    RAISE EXCEPTION 'You cannot designate yourself as verifier' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_challenge FROM public.challenges WHERE id = v_completion.challenge_id;

  -- 6. Verify submitter is STILL an active participant
  PERFORM 1 FROM public.challenge_participants
  WHERE challenge_id = v_completion.challenge_id AND user_id = v_caller_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You are no longer an active participant of this challenge' USING ERRCODE = '42501';
  END IF;

  -- 7. Verify new verifier is active challenge creator or joined participant with lock
  IF p_new_verifier_id != v_challenge.creator_id THEN
    PERFORM 1 FROM public.challenge_participants
    WHERE challenge_id = v_completion.challenge_id AND user_id = p_new_verifier_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'New verifier must be the challenge creator or an active participant' USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 8. Execute update
  UPDATE public.challenge_completions
  SET
    verifier_id = p_new_verifier_id,
    submitted_at = pg_catalog.now()
  WHERE id = p_completion_id
  RETURNING * INTO v_completion;

  RETURN v_completion;
END;
$$;

REVOKE ALL ON FUNCTION public.reassign_challenge_verifier(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reassign_challenge_verifier(UUID, TEXT) TO authenticated;

-- 10. RPC: Get Eligible Verifiers for a Challenge (Hardened search_path & authorized members only)
CREATE OR REPLACE FUNCTION public.get_challenge_eligible_verifiers(
  p_challenge_id UUID
)
RETURNS TABLE (
  user_id TEXT,
  display_name TEXT,
  is_creator BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_challenge public.challenges%ROWTYPE;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_challenge FROM public.challenges WHERE id = p_challenge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Challenge not found' USING ERRCODE = 'P0002';
  END IF;

  -- Caller must be an active participant or the creator of this challenge
  IF v_challenge.creator_id != v_caller_id THEN
    PERFORM 1 FROM public.challenge_participants
    WHERE challenge_id = p_challenge_id AND user_id = v_caller_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Only active challenge members can view eligible verifiers' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN QUERY
    -- Creator (if not caller)
    SELECT
      v_challenge.creator_id AS user_id,
      v_challenge.creator_name AS display_name,
      TRUE AS is_creator
    WHERE v_challenge.creator_id IS NOT NULL AND v_challenge.creator_id != v_caller_id

    UNION

    -- Co-participants (excluding caller)
    SELECT
      cp.user_id,
      'Participant ' || pg_catalog.substr(cp.user_id, 1, 6) AS display_name,
      FALSE AS is_creator
    FROM public.challenge_participants cp
    WHERE cp.challenge_id = p_challenge_id
      AND cp.user_id != v_caller_id
      AND (v_challenge.creator_id IS NULL OR cp.user_id != v_challenge.creator_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_challenge_eligible_verifiers(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_challenge_eligible_verifiers(UUID) TO authenticated;

-- 11. RPC: Get Participant Challenge Progress & Streak
-- Enforces: Member-only privacy, active challenge window date filtering, future-date exclusion, pure count math
CREATE OR REPLACE FUNCTION public.get_participant_challenge_progress(
  p_challenge_id UUID,
  p_user_id TEXT
)
RETURNS TABLE (
  challenge_type TEXT,
  duration_days INT,
  verified_count INT,
  progress_pct INT,
  current_streak INT,
  is_completed BOOLEAN,
  latest_approved_date DATE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_challenge public.challenges%ROWTYPE;
  v_today_in_tz DATE;
  v_challenge_start_date DATE;
  v_challenge_end_date DATE;
  v_window_empty BOOLEAN;
  v_dates DATE[];
  v_date DATE;
  v_streak INT := 0;
  v_expected_date DATE;
  v_verified_count INT := 0;
  v_pct INT := 0;
  v_is_completed BOOLEAN := FALSE;
  v_latest_date DATE := NULL;
BEGIN
  -- 1. Enforce caller authentication
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- 2. Fetch challenge
  SELECT * INTO v_challenge FROM public.challenges WHERE id = p_challenge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Challenge not found' USING ERRCODE = 'P0002';
  END IF;

  -- 3. Authorization check: Caller must be an active participant or creator of the challenge
  IF v_caller_id != v_challenge.creator_id THEN
    PERFORM 1 FROM public.challenge_participants
    WHERE challenge_id = p_challenge_id AND user_id = v_caller_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Only active challenge participants or the creator can view progress' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- 4. Target user check: Target user must be an active participant or the creator
  IF p_user_id != v_challenge.creator_id THEN
    PERFORM 1 FROM public.challenge_participants
    WHERE challenge_id = p_challenge_id AND user_id = p_user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Target user is not an active participant of this challenge' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  -- 5. Calculate date in challenge timezone and active challenge boundaries
  v_today_in_tz := (pg_catalog.now() AT TIME ZONE v_challenge.timezone)::date;
  SELECT w.start_date, w.end_date, w.is_empty
  INTO v_challenge_start_date, v_challenge_end_date, v_window_empty
  FROM public.challenge_active_window(
    v_challenge.created_at, v_challenge.ends_at, v_challenge.duration_days, v_challenge.timezone
  ) w;

  -- 6. Gather all distinct approved completion dates falling STRICTLY within the challenge active period
  -- and NOT in the future relative to the challenge's current date (cc.completion_date <= v_today_in_tz)
  SELECT pg_catalog.array_agg(sub.completion_date ORDER BY sub.completion_date DESC)
  INTO v_dates
  FROM (
    SELECT DISTINCT cc.completion_date
    FROM public.challenge_completions cc
    WHERE cc.challenge_id = p_challenge_id
      AND cc.participant_id = p_user_id
      AND cc.status = 'approved'
      AND NOT v_window_empty -- empty/expired window: nothing counts
      AND cc.completion_date >= v_challenge_start_date
      AND cc.completion_date <= v_challenge_end_date
      AND cc.completion_date <= v_today_in_tz
  ) sub;

  -- 7. Compute verified metrics directly (never rely on rounded percentage math)
  IF v_dates IS NOT NULL AND pg_catalog.array_length(v_dates, 1) > 0 THEN
    v_verified_count := pg_catalog.array_length(v_dates, 1);
    v_latest_date := v_dates[1];

    IF v_challenge.challenge_type = 'daily' THEN
      v_is_completed := (v_verified_count >= v_challenge.duration_days);
      v_pct := LEAST(100, (v_verified_count * 100) / GREATEST(1, v_challenge.duration_days));

      -- Calculate consecutive streak ending either today or yesterday in challenge timezone
      IF v_latest_date = v_today_in_tz OR v_latest_date = (v_today_in_tz - 1) THEN
        v_expected_date := v_latest_date;
        FOREACH v_date IN ARRAY v_dates LOOP
          IF v_date = v_expected_date THEN
            v_streak := v_streak + 1;
            v_expected_date := v_expected_date - 1;
          ELSE
            EXIT; -- Streak breaks at missing date
          END IF;
        END LOOP;
      ELSE
        v_streak := 0; -- Inactive streak (more than 1 day missed)
      END IF;
    ELSE
      -- One-time dare: exactly 1 approved completion completes the dare
      v_verified_count := 1;
      v_pct := 100;
      v_streak := 1;
      v_is_completed := TRUE;
    END IF;
  ELSE
    v_verified_count := 0;
    v_pct := 0;
    v_streak := 0;
    v_is_completed := FALSE;
  END IF;

  RETURN QUERY SELECT
    v_challenge.challenge_type,
    v_challenge.duration_days,
    v_verified_count,
    v_pct,
    v_streak,
    v_is_completed,
    v_latest_date;
END;
$$;

REVOKE ALL ON FUNCTION public.get_participant_challenge_progress(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_participant_challenge_progress(UUID, TEXT) TO authenticated;

-- 12. Function Ownership Policy (no ALTER OWNER)
-- The SECURITY DEFINER RPCs read/lock public.challenges and public.challenge_participants, which have RLS
-- enabled (not FORCED). They only work as intended because the function owner == the table owner (RLS is
-- bypassed by the owner). Functions created by this migration are owned by the migration role, which is also
-- the owner of those tables (on Supabase: postgres). Re-assigning ownership to a different role would make RLS
-- apply inside the RPCs and break them, so ownership is deliberately NOT changed. Fail the migration if the
-- invariant does not hold or if an untrusted role owns any function.
DO $$
DECLARE
  v_table_owner NAME;
  v_bad INT;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO v_table_owner
  FROM pg_catalog.pg_class c
  WHERE c.oid = 'public.challenge_participants'::pg_catalog.regclass;

  SELECT count(*) INTO v_bad
  FROM pg_catalog.pg_proc p
  WHERE p.pronamespace = 'public'::pg_catalog.regnamespace
    AND p.proname IN (
      'validate_challenge_timezone', 'challenge_active_window', 'submit_challenge_completion',
      'review_challenge_completion', 'reassign_challenge_verifier',
      'get_challenge_eligible_verifiers', 'get_participant_challenge_progress'
    )
    AND (pg_catalog.pg_get_userbyid(p.proowner) <> v_table_owner
         OR pg_catalog.pg_get_userbyid(p.proowner) IN ('anon', 'authenticated', 'public'));

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'Migration failed: % function(s) are not owned by the table owner (%) or are owned by an untrusted role', v_bad, v_table_owner USING ERRCODE = '42501';
  END IF;
END $$;
