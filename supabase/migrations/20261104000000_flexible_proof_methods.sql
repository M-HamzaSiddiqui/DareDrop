-- DareDrop Flexible Proof Methods Migration
-- File: supabase/migrations/20261104000000_flexible_proof_methods.sql
--
-- Objective:
-- Support flexible proof verification methods (peer_confirmation, text_log,
-- numeric_entry, photo_code, physical_action) while preserving full backward
-- compatibility for existing challenges and older clients (default 'physical_action').

BEGIN;

-- ============================================================================
-- 1. Schema Extensions: challenges table
-- ============================================================================
ALTER TABLE public.challenges
  ADD COLUMN IF NOT EXISTS proof_method TEXT DEFAULT 'physical_action',
  ADD COLUMN IF NOT EXISTS proof_config JSONB DEFAULT '{}'::jsonb;

-- Backfill existing rows safely
UPDATE public.challenges
SET proof_method = 'physical_action'
WHERE proof_method IS NULL;

UPDATE public.challenges
SET proof_config = '{}'::jsonb
WHERE proof_config IS NULL;

ALTER TABLE public.challenges
  ALTER COLUMN proof_method SET NOT NULL,
  ALTER COLUMN proof_method SET DEFAULT 'physical_action',
  ALTER COLUMN proof_config SET NOT NULL,
  ALTER COLUMN proof_config SET DEFAULT '{}'::jsonb;

ALTER TABLE public.challenges
  DROP CONSTRAINT IF EXISTS chk_challenge_proof_method;
ALTER TABLE public.challenges
  ADD CONSTRAINT chk_challenge_proof_method
  CHECK (proof_method IN ('peer_confirmation', 'text_log', 'numeric_entry', 'photo_code', 'physical_action'));

ALTER TABLE public.challenges
  DROP CONSTRAINT IF EXISTS chk_challenge_proof_config;
ALTER TABLE public.challenges
  ADD CONSTRAINT chk_challenge_proof_config
  CHECK (
    pg_catalog.jsonb_typeof(proof_config) = 'object'
    AND (proof_config - ARRAY['unit', 'min_value', 'max_value']) = '{}'::jsonb
    AND (
      NOT (proof_config ? 'unit')
      OR (pg_catalog.jsonb_typeof(proof_config->'unit') = 'string' AND pg_catalog.char_length(proof_config->>'unit') <= 12)
    )
    AND (
      NOT (proof_config ? 'min_value')
      OR (pg_catalog.jsonb_typeof(proof_config->'min_value') = 'number')
    )
    AND (
      NOT (proof_config ? 'max_value')
      OR (pg_catalog.jsonb_typeof(proof_config->'max_value') = 'number')
    )
    AND (
      NOT (proof_config ? 'min_value' AND proof_config ? 'max_value')
      OR ((proof_config->>'min_value')::numeric <= (proof_config->>'max_value')::numeric)
    )
  );

-- ============================================================================
-- 2. Schema Extensions: challenge_completions table
-- ============================================================================
ALTER TABLE public.challenge_completions
  ADD COLUMN IF NOT EXISTS numeric_value NUMERIC,
  ADD COLUMN IF NOT EXISTS text_entry TEXT;

ALTER TABLE public.challenge_completions
  DROP CONSTRAINT IF EXISTS chk_completions_text_entry_len;
ALTER TABLE public.challenge_completions
  ADD CONSTRAINT chk_completions_text_entry_len
  CHECK (text_entry IS NULL OR (pg_catalog.char_length(pg_catalog.btrim(text_entry)) >= 5 AND pg_catalog.char_length(text_entry) <= 500));

ALTER TABLE public.challenge_completions
  DROP CONSTRAINT IF EXISTS chk_completions_numeric_value_range;
ALTER TABLE public.challenge_completions
  ADD CONSTRAINT chk_completions_numeric_value_range
  CHECK (numeric_value IS NULL OR (numeric_value >= 0 AND numeric_value <= 1000000 AND numeric_value = numeric_value));

-- ============================================================================
-- 3. RPC: public.generate_proof_challenge
-- Only permits dynamic proof generation for photo_code and physical_action.
-- photo_code uses a neutral 'write_code_on_paper' prompt (no physical gesture).
-- physical_action preserves existing randomized gestures and repetition checks.
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
  PERFORM pg_catalog.pg_advisory_xact_lock(424202, pg_catalog.hashtext(v_caller_id));

  -- 3. Fetch challenge
  SELECT * INTO v_challenge FROM public.challenges WHERE id = p_challenge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Challenge not found' USING ERRCODE = 'P0002';
  END IF;

  -- 4. Proof Method Enforcement: Only photo_code and physical_action require dynamic proof challenges
  IF v_challenge.proof_method NOT IN ('photo_code', 'physical_action') THEN
    RAISE EXCEPTION 'Dynamic proof challenges are not required for "%" proof method', v_challenge.proof_method
      USING ERRCODE = '22023';
  END IF;

  -- 5. Timezone-aware date validation & active lifecycle calculation
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

  -- 6. Lock and check existing completion status
  IF v_challenge.challenge_type = 'one_time' THEN
    SELECT * INTO v_existing_comp
    FROM public.challenge_completions
    WHERE challenge_id = p_challenge_id AND participant_id = v_caller_id
    FOR UPDATE;

    IF FOUND THEN
      IF v_existing_comp.status = 'approved' THEN
        RAISE EXCEPTION 'This one-time dare has already been approved' USING ERRCODE = '23505';
      ELSIF v_existing_comp.status = 'pending' THEN
        RAISE EXCEPTION 'A submission for this dare is already pending verification' USING ERRCODE = '23505';
      ELSIF v_existing_comp.status = 'rejected' THEN
        IF v_existing_comp.reviewed_at IS NULL OR v_existing_comp.reviewed_at < (pg_catalog.now() - INTERVAL '48 hours') THEN
          RAISE EXCEPTION 'Resubmission grace period expired (rejection occurred more than 48 hours ago for date %)', v_existing_comp.completion_date USING ERRCODE = '22023';
        END IF;
      END IF;
    END IF;
  ELSE
    SELECT * INTO v_existing_comp
    FROM public.challenge_completions
    WHERE challenge_id = p_challenge_id
      AND participant_id = v_caller_id
      AND completion_date = p_completion_date
    FOR UPDATE;

    IF FOUND THEN
      IF v_existing_comp.status = 'approved' THEN
        RAISE EXCEPTION 'Day % is already approved', p_completion_date USING ERRCODE = '23505';
      ELSIF v_existing_comp.status = 'pending' THEN
        RAISE EXCEPTION 'Day % is already pending verification', p_completion_date USING ERRCODE = '23505';
      END IF;
    END IF;
  END IF;

  -- 7. Date window check with 48-hour rejection grace period
  IF p_completion_date > v_today_in_tz THEN
    RAISE EXCEPTION 'Cannot generate proof for a future date (current challenge date is %)', v_today_in_tz USING ERRCODE = '22023';
  ELSIF p_completion_date < (v_today_in_tz - 1) THEN
    IF v_existing_comp.id IS NULL THEN
      RAISE EXCEPTION 'Submission window expired for date % (allowed: % to %)', p_completion_date, (v_today_in_tz - 1), v_today_in_tz USING ERRCODE = '22023';
    END IF;

    IF v_existing_comp.status != 'rejected' THEN
      RAISE EXCEPTION 'Submission window expired for date % (allowed: % to %)', p_completion_date, (v_today_in_tz - 1), v_today_in_tz USING ERRCODE = '22023';
    END IF;

    IF v_existing_comp.reviewed_at IS NULL OR v_existing_comp.reviewed_at < (pg_catalog.now() - INTERVAL '48 hours') THEN
      RAISE EXCEPTION 'Resubmission grace period expired (rejection occurred more than 48 hours ago for date %)', p_completion_date USING ERRCODE = '22023';
    END IF;

    IF (COALESCE(v_existing_comp.first_submitted_at, v_existing_comp.submitted_at) AT TIME ZONE v_challenge.timezone)::date > (v_existing_comp.completion_date + 1) THEN
      RAISE EXCEPTION 'Resubmission denied: original submission was not submitted within the permitted window for date %', p_completion_date USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 8. Validate participant membership with FOR SHARE lock
  PERFORM 1 FROM public.challenge_participants
  WHERE challenge_id = p_challenge_id AND user_id = v_caller_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You must be an active participant to generate a proof challenge' USING ERRCODE = '42501';
  END IF;

  -- 9. Validate verifier eligibility
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

  -- 10. Rate Limiting: Max 5 generations per participant in the trailing 1 hour
  SELECT count(*) INTO v_recent_generations
  FROM public.proof_challenges
  WHERE participant_id = v_caller_id
    AND created_at > (pg_catalog.now() - interval '1 hour');

  IF v_recent_generations >= 5 THEN
    RAISE EXCEPTION 'Rate limit exceeded: maximum 5 proof challenges per hour. Please wait before generating another code.'
      USING ERRCODE = '42900';
  END IF;

  -- 11. Supersede / Cancel any prior active challenges for this participant, dare, and date
  UPDATE public.proof_challenges
  SET status = 'cancelled'
  WHERE participant_id = v_caller_id
    AND challenge_id = p_challenge_id
    AND completion_date = p_completion_date
    AND status = 'active';

  -- 12. Prompt Selection:
  -- photo_code uses the neutral write_code_on_paper prompt.
  -- physical_action uses the randomized gesture prompt catalogue avoiding immediate repetition.
  IF v_challenge.proof_method = 'photo_code' THEN
    v_selected_prompt_id := 'write_code_on_paper';
    v_selected_prompt_text := 'Write code on paper or note 📝';
  ELSE
    SELECT action_prompt_id INTO v_last_prompt_id
    FROM public.proof_challenges
    WHERE participant_id = v_caller_id
    ORDER BY created_at DESC
    LIMIT 1;

    v_rand_byte := pg_catalog.get_byte(extensions.gen_random_bytes(1), 0);
    v_selected_idx := (v_rand_byte % 8) + 1;

    IF v_last_prompt_id IS NOT NULL AND v_prompt_ids[v_selected_idx] = v_last_prompt_id THEN
      v_selected_idx := (v_selected_idx % 8) + 1;
    END IF;

    v_selected_prompt_id := v_prompt_ids[v_selected_idx];
    v_selected_prompt_text := v_prompt_texts[v_selected_idx];
  END IF;

  -- 13. Generate cryptographic 4-character proof code
  v_proof_code := public.generate_secure_proof_code();

  -- 14. Insert and return proof challenge record
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
-- 4. Primary RPC: public.submit_challenge_completion
-- Drops the old 5-argument signature and previous 7-argument signature (to reset defaults).
-- Requires p_proof_challenge_id (passed as NULL for non-photo/non-gesture dares),
-- preserving unambiguous 4-argument call resolution to the legacy tombstone RPC.
-- Method-specific payload rules strictly enforced at database boundary.
-- ============================================================================
DROP FUNCTION IF EXISTS public.submit_challenge_completion(UUID, TEXT, DATE, UUID, TEXT);
DROP FUNCTION IF EXISTS public.submit_challenge_completion(UUID, TEXT, DATE, UUID, TEXT, NUMERIC, TEXT);

CREATE OR REPLACE FUNCTION public.submit_challenge_completion(
  p_challenge_id UUID,
  p_verifier_id TEXT,
  p_completion_date DATE,
  p_proof_challenge_id UUID,
  p_submission_note TEXT DEFAULT NULL,
  p_numeric_value NUMERIC DEFAULT NULL,
  p_text_entry TEXT DEFAULT NULL
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
  v_lock_namespace INT := 424201;
  v_lock_resource INT;
  v_trimmed_text TEXT;
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

  -- 4. Method-specific proof payload validation
  CASE v_challenge.proof_method
    WHEN 'physical_action', 'photo_code' THEN
      IF p_proof_challenge_id IS NULL THEN
        RAISE EXCEPTION 'A valid proof challenge is required for "%" proof method', v_challenge.proof_method USING ERRCODE = '22023';
      END IF;
      IF p_numeric_value IS NOT NULL OR p_text_entry IS NOT NULL THEN
        RAISE EXCEPTION 'Numeric values and text entries are not allowed for "%" proof method', v_challenge.proof_method USING ERRCODE = '22023';
      END IF;

    WHEN 'numeric_entry' THEN
      IF p_proof_challenge_id IS NOT NULL THEN
        RAISE EXCEPTION 'Proof challenge codes are not used for numeric_entry' USING ERRCODE = '22023';
      END IF;
      IF p_text_entry IS NOT NULL THEN
        RAISE EXCEPTION 'Text entries are not allowed for numeric_entry' USING ERRCODE = '22023';
      END IF;
      IF p_numeric_value IS NULL THEN
        RAISE EXCEPTION 'A numeric value is required for numeric_entry' USING ERRCODE = '22023';
      END IF;
      IF (v_challenge.proof_config ? 'min_value') AND p_numeric_value < (v_challenge.proof_config->>'min_value')::numeric THEN
        RAISE EXCEPTION 'Submitted value (%) is below minimum allowed (%)', p_numeric_value, v_challenge.proof_config->>'min_value' USING ERRCODE = '22023';
      END IF;
      IF (v_challenge.proof_config ? 'max_value') AND p_numeric_value > (v_challenge.proof_config->>'max_value')::numeric THEN
        RAISE EXCEPTION 'Submitted value (%) exceeds maximum allowed (%)', p_numeric_value, v_challenge.proof_config->>'max_value' USING ERRCODE = '22023';
      END IF;

    WHEN 'text_log' THEN
      IF p_proof_challenge_id IS NOT NULL THEN
        RAISE EXCEPTION 'Proof challenge codes are not used for text_log' USING ERRCODE = '22023';
      END IF;
      IF p_numeric_value IS NOT NULL THEN
        RAISE EXCEPTION 'Numeric values are not allowed for text_log' USING ERRCODE = '22023';
      END IF;
      v_trimmed_text := pg_catalog.btrim(p_text_entry);
      IF v_trimmed_text IS NULL OR pg_catalog.char_length(v_trimmed_text) < 5 THEN
        RAISE EXCEPTION 'A written text entry of at least 5 characters is required for text_log' USING ERRCODE = '22023';
      END IF;
      IF pg_catalog.char_length(v_trimmed_text) > 500 THEN
        RAISE EXCEPTION 'Written text entry cannot exceed 500 characters' USING ERRCODE = '22023';
      END IF;

    WHEN 'peer_confirmation' THEN
      IF p_proof_challenge_id IS NOT NULL THEN
        RAISE EXCEPTION 'Proof challenge codes are not used for peer_confirmation' USING ERRCODE = '22023';
      END IF;
      IF p_numeric_value IS NOT NULL THEN
        RAISE EXCEPTION 'Numeric values are not allowed for peer_confirmation' USING ERRCODE = '22023';
      END IF;
      IF p_text_entry IS NOT NULL THEN
        RAISE EXCEPTION 'Text entries are not allowed for peer_confirmation' USING ERRCODE = '22023';
      END IF;

    ELSE
      RAISE EXCEPTION 'Unknown proof method: %', v_challenge.proof_method USING ERRCODE = '22023';
  END CASE;

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

  -- 8. Fetch existing completion records under row lock (FOR UPDATE)
  -- Global Lock Hierarchy: challenge_completions is locked BEFORE proof_challenges
  IF v_challenge.challenge_type = 'one_time' THEN
    SELECT * INTO v_existing
    FROM public.challenge_completions
    WHERE challenge_id = p_challenge_id AND participant_id = v_caller_id
    FOR UPDATE;

    IF FOUND THEN
      IF v_existing.status = 'rejected' THEN
        IF v_existing.reviewed_at IS NULL OR v_existing.reviewed_at < (pg_catalog.now() - INTERVAL '48 hours') THEN
          RAISE EXCEPTION 'Resubmission grace period expired (rejection occurred more than 48 hours ago for date %)', v_existing.completion_date USING ERRCODE = '22023';
        END IF;
      END IF;
    END IF;
  ELSE
    SELECT * INTO v_existing
    FROM public.challenge_completions
    WHERE challenge_id = p_challenge_id
      AND participant_id = v_caller_id
      AND completion_date = p_completion_date
    FOR UPDATE;
  END IF;

  -- 9. Dynamic Proof Challenge Validation & Row Lock (if required for proof_method)
  IF v_challenge.proof_method IN ('physical_action', 'photo_code') THEN
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

    IF v_proof_challenge.expires_at <= pg_catalog.now() THEN
      RAISE EXCEPTION 'Proof challenge has expired. Please generate a new proof code.' USING ERRCODE = '22000';
    END IF;
  END IF;

  -- 10. Date window check with 48-hour rejection grace period
  IF p_completion_date > v_today_in_tz THEN
    RAISE EXCEPTION 'Cannot submit proof for a future date (current challenge date is %)', v_today_in_tz USING ERRCODE = '22023';
  ELSIF p_completion_date < (v_today_in_tz - 1) THEN
    IF v_existing.id IS NULL THEN
      RAISE EXCEPTION 'Submission window expired for date % (allowed: % to %)', p_completion_date, (v_today_in_tz - 1), v_today_in_tz USING ERRCODE = '22023';
    END IF;

    IF v_existing.status != 'rejected' THEN
      RAISE EXCEPTION 'Submission window expired for date % (allowed: % to %)', p_completion_date, (v_today_in_tz - 1), v_today_in_tz USING ERRCODE = '22023';
    END IF;

    IF v_existing.reviewed_at IS NULL OR v_existing.reviewed_at < (pg_catalog.now() - INTERVAL '48 hours') THEN
      RAISE EXCEPTION 'Resubmission grace period expired (rejection occurred more than 48 hours ago for date %)', p_completion_date USING ERRCODE = '22023';
    END IF;

    IF (COALESCE(v_existing.first_submitted_at, v_existing.submitted_at) AT TIME ZONE v_challenge.timezone)::date > (v_existing.completion_date + 1) THEN
      RAISE EXCEPTION 'Resubmission denied: original submission was not submitted within the permitted window for date %', p_completion_date USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 11. Execute State Transition or Insert
  IF v_existing.id IS NOT NULL THEN
    IF v_existing.status = 'approved' THEN
      IF v_challenge.challenge_type = 'one_time' THEN
        RAISE EXCEPTION 'This one-time dare has already been approved' USING ERRCODE = '23505';
      ELSE
        RAISE EXCEPTION 'Day % is already approved', p_completion_date USING ERRCODE = '23505';
      END IF;
    ELSIF v_existing.status = 'pending' THEN
      IF v_challenge.challenge_type = 'one_time' THEN
        RAISE EXCEPTION 'A submission for this dare is already pending verification' USING ERRCODE = '23505';
      ELSE
        RAISE EXCEPTION 'Day % is already pending verification', p_completion_date USING ERRCODE = '23505';
      END IF;
    ELSIF v_existing.status = 'rejected' THEN
      -- Resubmission: update the rejected row back to pending with fresh proof metadata
      UPDATE public.challenge_completions
      SET
        verifier_id = p_verifier_id,
        completion_date = p_completion_date,
        status = 'pending',
        submission_note = pg_catalog.btrim(p_submission_note),
        last_rejection_reason = v_existing.rejection_reason,
        last_reviewed_at = v_existing.reviewed_at,
        rejection_reason = NULL,
        submitted_at = pg_catalog.now(),
        reviewed_at = NULL,
        proof_code = CASE WHEN v_proof_challenge.id IS NOT NULL THEN v_proof_challenge.proof_code ELSE NULL END,
        action_prompt_id = CASE WHEN v_proof_challenge.id IS NOT NULL THEN v_proof_challenge.action_prompt_id ELSE NULL END,
        action_prompt = CASE WHEN v_proof_challenge.id IS NOT NULL THEN v_proof_challenge.action_prompt ELSE NULL END,
        proof_challenge_id = CASE WHEN v_proof_challenge.id IS NOT NULL THEN v_proof_challenge.id ELSE NULL END,
        numeric_value = p_numeric_value,
        text_entry = CASE WHEN p_text_entry IS NOT NULL THEN pg_catalog.btrim(p_text_entry) ELSE NULL END
      WHERE id = v_existing.id
      RETURNING * INTO v_result;

      IF v_proof_challenge.id IS NOT NULL THEN
        UPDATE public.proof_challenges
        SET status = 'consumed', consumed_at = pg_catalog.now()
        WHERE id = v_proof_challenge.id;
      END IF;

      RETURN v_result;
    END IF;
  END IF;

  -- 12. Insert new pending submission (first submission)
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
    proof_challenge_id,
    numeric_value,
    text_entry,
    first_submitted_at,
    submitted_at
  ) VALUES (
    p_challenge_id,
    v_challenge.challenge_type,
    v_caller_id,
    p_verifier_id,
    p_completion_date,
    'pending',
    pg_catalog.btrim(p_submission_note),
    CASE WHEN v_proof_challenge.id IS NOT NULL THEN v_proof_challenge.proof_code ELSE NULL END,
    CASE WHEN v_proof_challenge.id IS NOT NULL THEN v_proof_challenge.action_prompt_id ELSE NULL END,
    CASE WHEN v_proof_challenge.id IS NOT NULL THEN v_proof_challenge.action_prompt ELSE NULL END,
    CASE WHEN v_proof_challenge.id IS NOT NULL THEN v_proof_challenge.id ELSE NULL END,
    p_numeric_value,
    CASE WHEN p_text_entry IS NOT NULL THEN pg_catalog.btrim(p_text_entry) ELSE NULL END,
    pg_catalog.now(),
    pg_catalog.now()
  )
  RETURNING * INTO v_result;

  IF v_proof_challenge.id IS NOT NULL THEN
    UPDATE public.proof_challenges
    SET status = 'consumed', consumed_at = pg_catalog.now()
    WHERE id = v_proof_challenge.id;
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_challenge_completion(UUID, TEXT, DATE, UUID, TEXT, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_challenge_completion(UUID, TEXT, DATE, UUID, TEXT, NUMERIC, TEXT) TO authenticated;

COMMIT;

