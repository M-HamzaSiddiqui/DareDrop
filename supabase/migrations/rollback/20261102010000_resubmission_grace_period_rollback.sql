-- DareDrop Resubmission Grace Period Migration Rollback
-- File: supabase/migrations/rollback/20261102010000_resubmission_grace_period_rollback.sql

-- 1. Restore generate_proof_challenge to 20261102000000_dynamic_proof_challenges.sql
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
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_registered_account() THEN
    RAISE EXCEPTION 'A registered account is required to generate proof challenges' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(424202, pg_catalog.hashtext(v_caller_id));

  SELECT * INTO v_challenge FROM public.challenges WHERE id = p_challenge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Challenge not found' USING ERRCODE = 'P0002';
  END IF;

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

  PERFORM 1 FROM public.challenge_participants
  WHERE challenge_id = p_challenge_id AND user_id = v_caller_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You must be an active participant to generate a proof challenge' USING ERRCODE = '42501';
  END IF;

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

  SELECT count(*) INTO v_recent_generations
  FROM public.proof_challenges
  WHERE participant_id = v_caller_id
    AND created_at > (pg_catalog.now() - interval '1 hour');

  IF v_recent_generations >= 5 THEN
    RAISE EXCEPTION 'Rate limit exceeded: maximum 5 proof challenges per hour. Please wait before generating another code.'
      USING ERRCODE = '42900';
  END IF;

  UPDATE public.proof_challenges
  SET status = 'cancelled'
  WHERE participant_id = v_caller_id
    AND challenge_id = p_challenge_id
    AND completion_date = p_completion_date
    AND status = 'active';

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

  v_proof_code := public.generate_secure_proof_code();

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

-- 2. Restore submit_challenge_completion to 20261102000000_dynamic_proof_challenges.sql
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
  v_lock_namespace INT := 424201;
  v_lock_resource INT;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_registered_account() THEN
    RAISE EXCEPTION 'A registered account is required to submit challenge completions' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_challenge FROM public.challenges WHERE id = p_challenge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Challenge not found' USING ERRCODE = 'P0002';
  END IF;

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

  IF v_proof_challenge.expires_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'Proof challenge has expired. Please generate a new proof code.' USING ERRCODE = '22000';
  END IF;

  v_lock_resource := pg_catalog.hashtext(
    p_challenge_id::text || ':' || v_caller_id || ':' ||
    CASE WHEN v_challenge.challenge_type = 'one_time' THEN 'one_time' ELSE p_completion_date::text END
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(v_lock_namespace, v_lock_resource);

  PERFORM 1 FROM public.challenge_participants
  WHERE challenge_id = p_challenge_id AND user_id = v_caller_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'You must be an active participant to submit proof' USING ERRCODE = '42501';
  END IF;

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

        UPDATE public.proof_challenges
        SET status = 'consumed', consumed_at = pg_catalog.now()
        WHERE id = v_proof_challenge.id;

        RETURN v_result;
      END IF;
    END IF;
  ELSE
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

        UPDATE public.proof_challenges
        SET status = 'consumed', consumed_at = pg_catalog.now()
        WHERE id = v_proof_challenge.id;

        RETURN v_result;
      END IF;
    END IF;
  END IF;

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

  UPDATE public.proof_challenges
  SET status = 'consumed', consumed_at = pg_catalog.now()
  WHERE id = v_proof_challenge.id;

  RETURN v_result;
END;
$$;
