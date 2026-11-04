-- DareDrop Migration: Dynamic Proof Challenges Backend
-- File: supabase/migrations/20261102000000_dynamic_proof_challenges.sql
-- Status: PREPARED MIGRATION — DO NOT EXECUTE DIRECTLY AGAINST PRODUCTION WITHOUT EXPLICIT APPROVAL
--
-- Objective:
-- Implement the server-side foundation for DareDrop's dynamic proof challenge system:
-- 1. Create public.proof_challenges table with strict state constraints and 45-min TTL.
-- 2. Add permanent proof metadata columns to public.challenge_completions.
-- 3. Implement server-authoritative RPC public.generate_proof_challenge with Crockford Base32
--    cryptographic randomness, curated safe gestures, rate limiting, and binding.
-- 4. Extend public.submit_challenge_completion to atomically consume the proof challenge
--    and persist proof metadata.
-- 5. Harden verifier reassignment and rejected resubmission behavior.

BEGIN;

-- ============================================================================
-- 1. Table: public.proof_challenges
-- Dedicated table for pre-submission ephemeral proof challenges.
-- Decoupled from challenge_completions to avoid polluting uniqueness constraints.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.proof_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID NOT NULL REFERENCES public.challenges(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  verifier_id TEXT NOT NULL,
  completion_date DATE NOT NULL,
  proof_code VARCHAR(8) NOT NULL,
  action_prompt_id TEXT NOT NULL,
  action_prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'cancelled', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (pg_catalog.now() + interval '45 minutes'),
  consumed_at TIMESTAMPTZ,

  -- Integrity: Consumed records must have consumed_at timestamp; unconsumed must not
  CONSTRAINT chk_proof_challenge_consumed_time
    CHECK (
      (status = 'consumed' AND consumed_at IS NOT NULL) OR
      (status != 'consumed' AND consumed_at IS NULL)
    ),

  -- Anti-self-verification at table constraint level
  CONSTRAINT chk_proof_challenge_no_self_verification
    CHECK (participant_id != verifier_id)
);

-- Indexes for performance, state lookup, and expiry cleanup
CREATE INDEX IF NOT EXISTS idx_proof_challenges_lookup
  ON public.proof_challenges (participant_id, challenge_id, completion_date, status);

CREATE INDEX IF NOT EXISTS idx_proof_challenges_verifier_lookup
  ON public.proof_challenges (verifier_id, status);

CREATE INDEX IF NOT EXISTS idx_proof_challenges_rate_limit
  ON public.proof_challenges (participant_id, created_at);

CREATE INDEX IF NOT EXISTS idx_proof_challenges_active_expiry
  ON public.proof_challenges (expires_at)
  WHERE status = 'active';

-- ============================================================================
-- 2. Extend public.challenge_completions with Proof Metadata Columns
-- Must precede the proof_challenges policy so cc.proof_challenge_id exists.
-- ============================================================================
ALTER TABLE public.challenge_completions
  ADD COLUMN IF NOT EXISTS proof_code VARCHAR(8),
  ADD COLUMN IF NOT EXISTS action_prompt_id TEXT,
  ADD COLUMN IF NOT EXISTS action_prompt TEXT,
  ADD COLUMN IF NOT EXISTS proof_challenge_id UUID REFERENCES public.proof_challenges(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_completions_proof_code
  ON public.challenge_completions (challenge_id, proof_code)
  WHERE proof_code IS NOT NULL;

-- ============================================================================
-- 3. Row Level Security: public.proof_challenges
-- ============================================================================
ALTER TABLE public.proof_challenges ENABLE ROW LEVEL SECURITY;

-- Block direct INSERT, UPDATE, DELETE from untrusted client roles.
REVOKE ALL ON TABLE public.proof_challenges FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.proof_challenges TO authenticated;

-- SELECT Policy: Submitter, currently assigned verifier, and challenge creator can read.
-- Previous verifiers are strictly excluded once reassignment occurs.
DROP POLICY IF EXISTS "Authorized users can view proof challenges" ON public.proof_challenges;
CREATE POLICY "Authorized users can view proof challenges"
  ON public.proof_challenges
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() IS NOT NULL AND (
      -- 1. Submitter participant
      participant_id = auth.uid()::text
      -- 2. Challenge creator
      OR EXISTS (
        SELECT 1 FROM public.challenges c
        WHERE c.id = proof_challenges.challenge_id
          AND c.creator_id = auth.uid()::text
      )
      -- 3. Currently assigned verifier for a submitted completion
      OR EXISTS (
        SELECT 1 FROM public.challenge_completions cc
        WHERE cc.proof_challenge_id = proof_challenges.id
          AND cc.verifier_id = auth.uid()::text
      )
      -- 4. Intended verifier for an active, unsubmitted proof challenge
      OR (
        proof_challenges.status = 'active'
        AND proof_challenges.verifier_id = auth.uid()::text
        AND NOT EXISTS (
          SELECT 1 FROM public.challenge_completions cc
          WHERE cc.proof_challenge_id = proof_challenges.id
        )
      )
    )
  );

-- ============================================================================
-- 4. Internal Helper: public.generate_secure_proof_code()
-- Generates a 4-character cryptographic random code using unambiguous Crockford Base32.
-- Omits 0, 1, I, L, O, U to prevent handwriting ambiguity when written on paper.
-- 30^4 = 810,000 combinations, combined with 45-min TTL and rate limiting.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.generate_secure_proof_code()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- 30 unambiguous alphanumeric characters (omitting 0, 1, I, L, O, U)
  v_chars TEXT := '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bytes BYTEA;
  v_code TEXT := '';
  v_byte INT;
  v_idx INT;
  v_pos INT := 0;
BEGIN
  -- 30 characters. 240 is largest multiple of 30 <= 256 (30 * 8 = 240).
  -- Rejection sampling: discard bytes >= 240 to guarantee exact uniform distribution (1/30 per char).
  v_bytes := extensions.gen_random_bytes(16);
  WHILE pg_catalog.length(v_code) < 4 LOOP
    IF v_pos >= pg_catalog.length(v_bytes) THEN
      v_bytes := extensions.gen_random_bytes(16);
      v_pos := 0;
    END IF;
    v_byte := pg_catalog.get_byte(v_bytes, v_pos);
    v_pos := v_pos + 1;
    IF v_byte < 240 THEN
      v_idx := (v_byte % 30) + 1;
      v_code := v_code || pg_catalog.substr(v_chars, v_idx, 1);
    END IF;
  END LOOP;
  RETURN v_code;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_secure_proof_code() FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 5. RPC: public.generate_proof_challenge
-- Server-authoritative generation of ephemeral dynamic proof challenges.
-- Enforces:
-- - Registered account check (is_registered_account())
-- - Active challenge membership
-- - Verifier eligibility (creator or active participant, != caller)
-- - Timezone-aware date boundaries (today or yesterday in challenge TZ)
-- - Rejection of already-approved or pending dares
-- - Rate limit: max 5 generations per participant per hour (across all states)
-- - Cancellation of superseded active challenges for same date
-- - Curated safe gesture catalogue with consecutive repetition avoidance
-- ============================================================================
CREATE OR REPLACE FUNCTION public.generate_proof_challenge(
  p_challenge_id UUID,
  p_verifier_id TEXT,
  p_completion_date DATE
)
RETURNS public.proof_challenges
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
  v_existing_comp public.challenge_completions%ROWTYPE;
  v_recent_generations INT;
  v_proof_code TEXT;
  v_last_prompt_id TEXT;
  v_prompt_ids TEXT[] := ARRAY[
    'gesture_thumbs_up',
    'gesture_peace_sign',
    'gesture_raised_fist',
    'gesture_open_palm',
    'gesture_point_up',
    'gesture_hand_heart',
    'gesture_touch_ear',
    'gesture_ok_sign'
  ];
  v_prompt_texts TEXT[] := ARRAY[
    'Give a thumbs-up 👍',
    'Show a peace sign ✌️',
    'Hold up a raised fist ✊',
    'Show an open palm ✋',
    'Point index finger upward ☝️',
    'Place a palm over your heart ❤️',
    'Touch your ear with your hand 👂',
    'Show an OK sign 👌'
  ];
  v_selected_idx INT;
  v_selected_prompt_id TEXT;
  v_selected_prompt_text TEXT;
  v_rand_byte INT;
  v_new_challenge public.proof_challenges%ROWTYPE;
BEGIN
  -- 1. Identify caller securely and ensure registered account
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_registered_account() THEN
    RAISE EXCEPTION 'A registered account is required to generate proof challenges' USING ERRCODE = '42501';
  END IF;

  -- 2. Concurrency Hardening: Acquire participant-scoped transaction advisory lock immediately
  -- Namespace 424202 is dedicated to DareDrop proof challenge generation rate limiting.
  -- Acquired before any validation or state checks and held until transaction commit/rollback.
  PERFORM pg_catalog.pg_advisory_xact_lock(424202, pg_catalog.hashtext(v_caller_id));

  -- 3. Fetch challenge
  SELECT * INTO v_challenge FROM public.challenges WHERE id = p_challenge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Challenge not found' USING ERRCODE = 'P0002';
  END IF;

  -- 3. Timezone-aware date validation & active lifecycle calculation
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

  IF v_window_empty THEN
    RAISE EXCEPTION 'Challenge has no active submission window' USING ERRCODE = '22023';
  END IF;

  IF p_completion_date < v_challenge_start_date THEN
    RAISE EXCEPTION 'Cannot generate proof for date % before challenge started (%)', p_completion_date, v_challenge_start_date USING ERRCODE = '22023';
  END IF;

  IF p_completion_date > v_challenge_end_date THEN
    RAISE EXCEPTION 'Cannot generate proof for date % after challenge ended (%)', p_completion_date, v_challenge_end_date USING ERRCODE = '22023';
  END IF;

  IF p_completion_date > v_today_in_tz THEN
    RAISE EXCEPTION 'Cannot generate proof for a future date (current challenge date is %)', v_today_in_tz USING ERRCODE = '22023';
  ELSIF p_completion_date < (v_today_in_tz - 1) THEN
    RAISE EXCEPTION 'Submission window expired for date % (allowed: % to %)', p_completion_date, (v_today_in_tz - 1), v_today_in_tz USING ERRCODE = '22023';
  END IF;

  -- 4. Validate participant membership with FOR SHARE lock
  PERFORM 1 FROM public.challenge_participants
  WHERE challenge_id = p_challenge_id AND user_id = v_caller_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You must be an active participant to generate a proof challenge' USING ERRCODE = '42501';
  END IF;

  -- 5. Validate verifier eligibility
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

  -- 6. Check existing completion status (prevent generating code for already-approved/pending dares)
  IF v_challenge.challenge_type = 'one_time' THEN
    SELECT * INTO v_existing_comp
    FROM public.challenge_completions
    WHERE challenge_id = p_challenge_id AND participant_id = v_caller_id;

    IF FOUND THEN
      IF v_existing_comp.status = 'approved' THEN
        RAISE EXCEPTION 'This one-time dare has already been approved' USING ERRCODE = '23505';
      ELSIF v_existing_comp.status = 'pending' THEN
        RAISE EXCEPTION 'A submission for this dare is already pending verification' USING ERRCODE = '23505';
      END IF;
    END IF;
  ELSE
    SELECT * INTO v_existing_comp
    FROM public.challenge_completions
    WHERE challenge_id = p_challenge_id
      AND participant_id = v_caller_id
      AND completion_date = p_completion_date;

    IF FOUND THEN
      IF v_existing_comp.status = 'approved' THEN
        RAISE EXCEPTION 'Day % is already approved', p_completion_date USING ERRCODE = '23505';
      ELSIF v_existing_comp.status = 'pending' THEN
        RAISE EXCEPTION 'Day % is already pending verification', p_completion_date USING ERRCODE = '23505';
      END IF;
    END IF;
  END IF;

  -- 7. Rate Limiting: Max 5 generations per participant in the trailing 1 hour
  -- Count is protected by the participant-scoped advisory transaction lock acquired at function entry.
  SELECT count(*) INTO v_recent_generations
  FROM public.proof_challenges
  WHERE participant_id = v_caller_id
    AND created_at > (pg_catalog.now() - interval '1 hour');

  IF v_recent_generations >= 5 THEN
    RAISE EXCEPTION 'Rate limit exceeded: maximum 5 proof challenges per hour. Please wait before generating another code.'
      USING ERRCODE = '42900';
  END IF;

  -- 8. Supersede / Cancel any prior active challenges for this participant, dare, and date
  UPDATE public.proof_challenges
  SET status = 'cancelled'
  WHERE participant_id = v_caller_id
    AND challenge_id = p_challenge_id
    AND completion_date = p_completion_date
    AND status = 'active';

  -- 9. Select physical-action prompt avoiding immediate repetition
  SELECT action_prompt_id INTO v_last_prompt_id
  FROM public.proof_challenges
  WHERE participant_id = v_caller_id
  ORDER BY created_at DESC
  LIMIT 1;

  v_rand_byte := pg_catalog.get_byte(extensions.gen_random_bytes(1), 0);
  v_selected_idx := (v_rand_byte % 8) + 1;

  -- If same as last used, shift to next to ensure variety
  IF v_last_prompt_id IS NOT NULL AND v_prompt_ids[v_selected_idx] = v_last_prompt_id THEN
    v_selected_idx := (v_selected_idx % 8) + 1;
  END IF;

  v_selected_prompt_id := v_prompt_ids[v_selected_idx];
  v_selected_prompt_text := v_prompt_texts[v_selected_idx];

  -- 10. Generate cryptographic 4-character proof code
  v_proof_code := public.generate_secure_proof_code();

  -- 11. Insert and return proof challenge record
  INSERT INTO public.proof_challenges (
    challenge_id,
    participant_id,
    verifier_id,
    completion_date,
    proof_code,
    action_prompt_id,
    action_prompt,
    status,
    created_at,
    expires_at
  ) VALUES (
    p_challenge_id,
    v_caller_id,
    p_verifier_id,
    p_completion_date,
    v_proof_code,
    v_selected_prompt_id,
    v_selected_prompt_text,
    'active',
    pg_catalog.now(),
    pg_catalog.now() + interval '45 minutes'
  )
  RETURNING * INTO v_new_challenge;

  RETURN v_new_challenge;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_proof_challenge(UUID, TEXT, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_proof_challenge(UUID, TEXT, DATE) TO authenticated;

-- ============================================================================
-- 6. RPC: public.cancel_proof_challenge
-- Explicitly cancels an active proof challenge if the participant abandons or
-- reconfigures their submission prior to submission.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.cancel_proof_challenge(
  p_proof_challenge_id UUID
)
RETURNS public.proof_challenges
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_proof public.proof_challenges%ROWTYPE;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_proof
  FROM public.proof_challenges
  WHERE id = p_proof_challenge_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proof challenge not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_proof.participant_id != v_caller_id THEN
    RAISE EXCEPTION 'Only the participant can cancel their proof challenge' USING ERRCODE = '42501';
  END IF;

  IF v_proof.status != 'active' THEN
    RAISE EXCEPTION 'Proof challenge is not active (current status: %)', v_proof.status USING ERRCODE = '22000';
  END IF;

  UPDATE public.proof_challenges
  SET status = 'cancelled'
  WHERE id = v_proof.id
  RETURNING * INTO v_proof;

  RETURN v_proof;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_proof_challenge(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_proof_challenge(UUID) TO authenticated;

-- ============================================================================
-- 7a. Legacy Compatibility Stub: public.submit_challenge_completion (4 Arguments)
-- Preserves the historical 4-argument signature used by pre-Phase-23 mobile clients.
-- Strictly rejects calls with SQLSTATE P0001 explaining that dynamic proof
-- verification is required and directing the user to update their app.
-- Creates no completions and provides zero proof-less bypass.
-- ============================================================================
DROP FUNCTION IF EXISTS public.submit_challenge_completion(UUID, TEXT, DATE, TEXT, UUID);

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
BEGIN
  RAISE EXCEPTION 'App update required: DareDrop now requires dynamic proof verification. Please update your app to submit completions.'
    USING ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION public.submit_challenge_completion(UUID, TEXT, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_challenge_completion(UUID, TEXT, DATE, TEXT) TO authenticated;

-- ============================================================================
-- 7b. Primary Proof-Enforced RPC: public.submit_challenge_completion (5 Arguments)
-- Strictly requires p_proof_challenge_id UUID (no DEFAULT NULL).
-- Atomically verifies and consumes the proof challenge in the same transaction.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.submit_challenge_completion(
  p_challenge_id UUID,
  p_verifier_id TEXT,
  p_completion_date DATE,
  p_proof_challenge_id UUID,
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
  v_proof_challenge public.proof_challenges%ROWTYPE;
  v_today_in_tz DATE;
  v_challenge_start_date DATE;
  v_challenge_end_date DATE;
  v_window_empty BOOLEAN;
  v_result public.challenge_completions%ROWTYPE;
  v_constraint_name TEXT;
  v_lock_namespace INT := 424201; -- Dedicated namespace for DareDrop submission serialization
  v_lock_resource INT;
BEGIN
  -- 1. Identify caller securely and ensure registered account
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_registered_account() THEN
    RAISE EXCEPTION 'A registered account is required to submit challenge completions' USING ERRCODE = '42501';
  END IF;

  -- 2. Fetch challenge details
  SELECT * INTO v_challenge FROM public.challenges WHERE id = p_challenge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Challenge not found' USING ERRCODE = 'P0002';
  END IF;

  -- 3. Timezone-aware date validation & active lifecycle calculation
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

  IF v_window_empty THEN
    RAISE EXCEPTION 'Challenge has no active submission window (ends_at % is not after start %)',
      v_challenge.ends_at, v_challenge.created_at USING ERRCODE = '22023';
  END IF;

  IF p_completion_date < v_challenge_start_date THEN
    RAISE EXCEPTION 'Cannot submit proof for date % before challenge started (%)', p_completion_date, v_challenge_start_date USING ERRCODE = '22023';
  END IF;

  IF p_completion_date > v_challenge_end_date THEN
    RAISE EXCEPTION 'Cannot submit proof for date % after challenge ended (%)', p_completion_date, v_challenge_end_date USING ERRCODE = '22023';
  END IF;

  IF p_completion_date > v_today_in_tz THEN
    RAISE EXCEPTION 'Cannot submit proof for a future date (current challenge date is %)', v_today_in_tz USING ERRCODE = '22023';
  ELSIF p_completion_date < (v_today_in_tz - 1) THEN
    RAISE EXCEPTION 'Submission window expired for date % (allowed: % to %)', p_completion_date, (v_today_in_tz - 1), v_today_in_tz USING ERRCODE = '22023';
  END IF;

  -- 4. Mandatory Proof Challenge Validation
  -- Product rule: All new completions and resubmissions require an authentic, active proof challenge.
  IF p_proof_challenge_id IS NULL THEN
    RAISE EXCEPTION 'A valid proof challenge is required to submit challenge completion' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_proof_challenge
  FROM public.proof_challenges
  WHERE id = p_proof_challenge_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proof challenge not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_proof_challenge.participant_id != v_caller_id THEN
    RAISE EXCEPTION 'Proof challenge does not belong to authenticated participant' USING ERRCODE = '42501';
  END IF;

  IF v_proof_challenge.challenge_id != p_challenge_id THEN
    RAISE EXCEPTION 'Proof challenge does not match the target challenge' USING ERRCODE = '22023';
  END IF;

  IF v_proof_challenge.verifier_id != p_verifier_id THEN
    RAISE EXCEPTION 'Proof challenge was generated for a different verifier' USING ERRCODE = '22023';
  END IF;

  IF v_proof_challenge.completion_date != p_completion_date THEN
    RAISE EXCEPTION 'Proof challenge was generated for a different completion date' USING ERRCODE = '22023';
  END IF;

  IF v_proof_challenge.status != 'active' THEN
    RAISE EXCEPTION 'Proof challenge is no longer active (status: %)', v_proof_challenge.status USING ERRCODE = '22000';
  END IF;

  -- Expiry is authoritative through expires_at timestamp
  IF v_proof_challenge.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'Proof challenge has expired. Please generate a new proof code.' USING ERRCODE = '22000';
  END IF;

  -- 5. Serialize concurrent submission attempts using a 2-key advisory lock
  v_lock_resource := pg_catalog.hashtext(
    p_challenge_id::text || ':' || v_caller_id || ':' ||
    CASE WHEN v_challenge.challenge_type = 'one_time' THEN 'one_time' ELSE p_completion_date::text END
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(v_lock_namespace, v_lock_resource);

  -- 6. Race-safe membership check with FOR SHARE lock
  PERFORM 1 FROM public.challenge_participants
  WHERE challenge_id = p_challenge_id AND user_id = v_caller_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You must be an active participant to submit proof' USING ERRCODE = '42501';
  END IF;

  -- 7. Authoritative verifier eligibility check
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

  -- 8. Check existing completion records under row lock (FOR UPDATE)
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
        -- Resubmission: update the rejected row back to pending with fresh proof metadata
        UPDATE public.challenge_completions
        SET
          verifier_id = p_verifier_id,
          completion_date = p_completion_date,
          status = 'pending',
          submission_note = pg_catalog.btrim(p_submission_note),
          rejection_reason = NULL,
          submitted_at = pg_catalog.now(),
          reviewed_at = NULL,
          proof_code = v_proof_challenge.proof_code,
          action_prompt_id = v_proof_challenge.action_prompt_id,
          action_prompt = v_proof_challenge.action_prompt,
          proof_challenge_id = v_proof_challenge.id
        WHERE id = v_existing.id
        RETURNING * INTO v_result;

        -- Atomically consume the proof challenge
        UPDATE public.proof_challenges
        SET status = 'consumed', consumed_at = pg_catalog.now()
        WHERE id = v_proof_challenge.id;

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
        -- Resubmission for same day: reset to pending with fresh proof metadata
        UPDATE public.challenge_completions
        SET
          verifier_id = p_verifier_id,
          status = 'pending',
          submission_note = pg_catalog.btrim(p_submission_note),
          rejection_reason = NULL,
          submitted_at = pg_catalog.now(),
          reviewed_at = NULL,
          proof_code = v_proof_challenge.proof_code,
          action_prompt_id = v_proof_challenge.action_prompt_id,
          action_prompt = v_proof_challenge.action_prompt,
          proof_challenge_id = v_proof_challenge.id
        WHERE id = v_existing.id
        RETURNING * INTO v_result;

        -- Atomically consume the proof challenge
        UPDATE public.proof_challenges
        SET status = 'consumed', consumed_at = pg_catalog.now()
        WHERE id = v_proof_challenge.id;

        RETURN v_result;
      END IF;
    END IF;
  END IF;

  -- 9. Insert new pending submission (derived challenge_type)
  BEGIN
    INSERT INTO public.challenge_completions (
      challenge_id,
      challenge_type,
      participant_id,
      verifier_id,
      completion_date,
      status,
      submission_note,
      proof_code,
      action_prompt_id,
      action_prompt,
      proof_challenge_id
    ) VALUES (
      p_challenge_id,
      v_challenge.challenge_type,
      v_caller_id,
      p_verifier_id,
      p_completion_date,
      'pending',
      pg_catalog.btrim(p_submission_note),
      v_proof_challenge.proof_code,
      v_proof_challenge.action_prompt_id,
      v_proof_challenge.action_prompt,
      v_proof_challenge.id
    )
    RETURNING * INTO v_result;

    -- 10. Atomically consume the proof challenge
    UPDATE public.proof_challenges
    SET status = 'consumed', consumed_at = pg_catalog.now()
    WHERE id = v_proof_challenge.id;

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

REVOKE ALL ON FUNCTION public.submit_challenge_completion(UUID, TEXT, DATE, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_challenge_completion(UUID, TEXT, DATE, UUID, TEXT) TO authenticated;

-- ============================================================================
-- 8. Hardened RPC: public.reassign_challenge_verifier
-- Updates verifier on challenge_completions AND synchronizes proof_challenges
-- so the previous verifier's access is immediately revoked while the new
-- verifier is granted access.
-- ============================================================================
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
  -- 1. Verify caller authentication and registered account
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_registered_account() THEN
    RAISE EXCEPTION 'A registered account is required to reassign challenge verifiers' USING ERRCODE = '42501';
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

  -- 8. Execute update on completion
  UPDATE public.challenge_completions
  SET
    verifier_id = p_new_verifier_id,
    submitted_at = pg_catalog.now()
  WHERE id = p_completion_id
  RETURNING * INTO v_completion;

  -- 9. Synchronize proof_challenges verifier_id so previous verifier loses access
  IF v_completion.proof_challenge_id IS NOT NULL THEN
    UPDATE public.proof_challenges
    SET verifier_id = p_new_verifier_id
    WHERE id = v_completion.proof_challenge_id;
  END IF;

  RETURN v_completion;
END;
$$;

REVOKE ALL ON FUNCTION public.reassign_challenge_verifier(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reassign_challenge_verifier(UUID, TEXT) TO authenticated;

-- Notify PostgREST to reload its schema cache upon transaction commit
NOTIFY pgrst, 'reload schema';

COMMIT;
