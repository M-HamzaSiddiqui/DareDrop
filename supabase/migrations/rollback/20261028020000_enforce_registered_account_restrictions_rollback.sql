-- DareDrop Rollback: Enforce Registered Account Restrictions
-- File: supabase/migrations/rollback/20261028020000_enforce_registered_account_restrictions_rollback.sql
-- Status: PREPARED ROLLBACK — DO NOT EXECUTE DIRECTLY AGAINST PRODUCTION WITHOUT EXPLICIT APPROVAL
--
-- Objective:
-- Reverts all changes made by 20261028020000_enforce_registered_account_restrictions.sql.
-- Restores RLS policies and all ten RPCs to their exact authoritative pre-migration
-- definitions (where all authenticated sessions, including anonymous sessions, were permitted).
-- Restores function grants and drops public.is_registered_account().

BEGIN;

-- ============================================================================
-- 1. Rollback Challenges RLS Policies
-- ============================================================================

DROP POLICY IF EXISTS "Registered users can create challenges" ON public.challenges;
DROP POLICY IF EXISTS "Authenticated users can create challenges" ON public.challenges;
CREATE POLICY "Authenticated users can create challenges"
  ON public.challenges
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL AND creator_id = auth.uid()::text
  );

DROP POLICY IF EXISTS "Registered creators can update challenges" ON public.challenges;
DROP POLICY IF EXISTS "Creators can update challenges" ON public.challenges;
CREATE POLICY "Creators can update challenges"
  ON public.challenges
  FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL AND creator_id = auth.uid()::text)
  WITH CHECK (auth.uid() IS NOT NULL AND creator_id = auth.uid()::text);

DROP POLICY IF EXISTS "Registered creators can delete challenges" ON public.challenges;
DROP POLICY IF EXISTS "Creators can delete challenges" ON public.challenges;
CREATE POLICY "Creators can delete challenges"
  ON public.challenges
  FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL AND creator_id = auth.uid()::text);

-- ============================================================================
-- 2. Rollback Challenge Participants RLS Policies
-- ============================================================================

DROP POLICY IF EXISTS "Registered users can join challenges" ON public.challenge_participants;
DROP POLICY IF EXISTS "Authenticated users can join challenges" ON public.challenge_participants;
CREATE POLICY "Authenticated users can join challenges"
  ON public.challenge_participants
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() IS NOT NULL AND user_id = auth.uid()::text
  );

-- ============================================================================
-- 3. Rollback User Push Tokens RLS Policies
-- ============================================================================

DROP POLICY IF EXISTS "Registered users can insert own push tokens" ON public.user_push_tokens;
DROP POLICY IF EXISTS "Users can insert own push tokens" ON public.user_push_tokens;
CREATE POLICY "Users can insert own push tokens"
  ON public.user_push_tokens
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL AND user_id = auth.uid()::text);

DROP POLICY IF EXISTS "Registered users can update own push tokens" ON public.user_push_tokens;
DROP POLICY IF EXISTS "Users can update own push tokens" ON public.user_push_tokens;
CREATE POLICY "Users can update own push tokens"
  ON public.user_push_tokens
  FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL AND user_id = auth.uid()::text)
  WITH CHECK (auth.uid() IS NOT NULL AND user_id = auth.uid()::text);

-- ============================================================================
-- 4. Rollback Peer-Verification RPCs (Restores Authoritative Pre-Migration Logic)
-- ============================================================================

-- RPC 1: submit_challenge_completion
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

-- RPC 2: review_challenge_completion
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

-- RPC 3: reassign_challenge_verifier
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

-- ============================================================================
-- 5. Rollback Device Push Token RPC
-- ============================================================================

-- RPC 4: register_device_push_token
CREATE OR REPLACE FUNCTION public.register_device_push_token(
  p_expo_push_token TEXT,
  p_platform TEXT DEFAULT 'unknown',
  p_device_name TEXT DEFAULT NULL
)
RETURNS public.user_push_tokens
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_result public.user_push_tokens;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF p_expo_push_token IS NULL OR pg_catalog.btrim(p_expo_push_token) = '' THEN
    RAISE EXCEPTION 'Invalid push token' USING ERRCODE = '22023';
  END IF;

  -- Upsert token: transfers device token to the currently active user if ownership changed
  INSERT INTO public.user_push_tokens (
    user_id,
    expo_push_token,
    platform,
    device_name,
    updated_at
  ) VALUES (
    v_caller_id,
    pg_catalog.btrim(p_expo_push_token),
    COALESCE(p_platform, 'unknown'),
    p_device_name,
    pg_catalog.now()
  )
  ON CONFLICT (expo_push_token) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    platform = EXCLUDED.platform,
    device_name = EXCLUDED.device_name,
    updated_at = pg_catalog.now()
  RETURNING * INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.register_device_push_token(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_device_push_token(TEXT, TEXT, TEXT) TO authenticated;

-- ============================================================================
-- 6. Rollback Social RPCs (Restores Pre-Migration Definitions from 20261028000000)
-- ============================================================================

-- RPC 5: get_or_create_user_profile
CREATE OR REPLACE FUNCTION public.get_or_create_user_profile(
  p_display_name TEXT DEFAULT NULL,
  p_avatar_emoji TEXT DEFAULT NULL
)
RETURNS public.user_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_profile public.user_profiles;
  v_code TEXT;
  v_clean_name TEXT;
  v_clean_emoji TEXT;
  v_attempts INT := 0;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- 1. Fast check if profile already exists
  SELECT * INTO v_profile FROM public.user_profiles WHERE user_id = v_caller_id;
  IF FOUND THEN
    RETURN v_profile;
  END IF;

  -- Sanitize inputs
  v_clean_name := pg_catalog.btrim(COALESCE(p_display_name, ''));
  IF v_clean_name = '' OR pg_catalog.char_length(v_clean_name) < 2 OR pg_catalog.char_length(v_clean_name) > 32 OR NOT (v_clean_name ~* '^[a-zA-Z0-9 _.''-]+$') THEN
    v_clean_name := 'DareDropper';
  END IF;

  v_clean_emoji := pg_catalog.btrim(COALESCE(p_avatar_emoji, ''));
  IF v_clean_emoji = '' OR pg_catalog.char_length(v_clean_emoji) > 8 THEN
    v_clean_emoji := '🦁';
  END IF;

  -- 2. Generate unique friend code with collision retry loop
  LOOP
    v_attempts := v_attempts + 1;
    v_code := public.generate_secure_friend_code();
    BEGIN
      INSERT INTO public.user_profiles (
        user_id,
        friend_code,
        display_name,
        avatar_emoji,
        created_at,
        updated_at
      ) VALUES (
        v_caller_id,
        v_code,
        v_clean_name,
        v_clean_emoji,
        pg_catalog.now(),
        pg_catalog.now()
      )
      RETURNING * INTO v_profile;
      RETURN v_profile;
    EXCEPTION WHEN unique_violation THEN
      -- Check if conflict was caused by concurrent profile creation for this user
      SELECT * INTO v_profile FROM public.user_profiles WHERE user_id = v_caller_id;
      IF FOUND THEN
        RETURN v_profile; -- Idempotently return concurrently created profile
      END IF;

      -- Otherwise, it was a friend-code collision
      IF v_attempts >= 10 THEN
        RAISE EXCEPTION 'Failed to generate unique friend code after 10 attempts' USING ERRCODE = '54000';
      END IF;
    END;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_user_profile(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_or_create_user_profile(TEXT, TEXT) TO authenticated;

-- RPC 6: update_user_profile
CREATE OR REPLACE FUNCTION public.update_user_profile(
  p_display_name TEXT,
  p_avatar_emoji TEXT DEFAULT NULL
)
RETURNS public.user_profiles
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_profile public.user_profiles;
  v_clean_name TEXT;
  v_clean_emoji TEXT;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  v_clean_name := pg_catalog.btrim(COALESCE(p_display_name, ''));
  IF v_clean_name = '' OR pg_catalog.char_length(v_clean_name) < 2 THEN
    RAISE EXCEPTION 'Display name must be at least 2 characters' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.char_length(v_clean_name) > 32 THEN
    RAISE EXCEPTION 'Display name must not exceed 32 characters' USING ERRCODE = '22023';
  END IF;

  -- Verify safe character pattern (alphanumeric, spaces, underscores, dots, hyphens, apostrophes)
  IF NOT (v_clean_name ~* '^[a-zA-Z0-9 _.''-]+$') THEN
    RAISE EXCEPTION 'Display name contains invalid characters' USING ERRCODE = '22023';
  END IF;

  v_clean_emoji := pg_catalog.btrim(COALESCE(p_avatar_emoji, ''));
  IF v_clean_emoji = '' THEN
    v_clean_emoji := '🦁';
  ELSIF pg_catalog.char_length(v_clean_emoji) > 8 THEN
    RAISE EXCEPTION 'Avatar emoji is too long' USING ERRCODE = '22023';
  END IF;

  -- Ensure profile exists
  PERFORM public.get_or_create_user_profile();

  UPDATE public.user_profiles
  SET display_name = v_clean_name,
      avatar_emoji = v_clean_emoji,
      updated_at = pg_catalog.now()
  WHERE user_id = v_caller_id
  RETURNING * INTO v_profile;

  RETURN v_profile;
END;
$$;

REVOKE ALL ON FUNCTION public.update_user_profile(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_user_profile(TEXT, TEXT) TO authenticated;

-- RPC 7: send_friend_request
CREATE OR REPLACE FUNCTION public.send_friend_request(
  p_friend_code TEXT
)
RETURNS TABLE (
  request_id UUID,
  status TEXT,
  target_display_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_caller_name TEXT;
  v_target public.user_profiles;
  v_existing public.friendships;
  v_result_id UUID;
  v_result_status TEXT;
  v_normalized_code TEXT;
  v_raw TEXT;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- Ensure caller has a profile
  PERFORM public.get_or_create_user_profile();
  SELECT display_name INTO v_caller_name FROM public.user_profiles WHERE user_id = v_caller_id;

  -- Normalize target code
  v_raw := pg_catalog.upper(pg_catalog.btrim(p_friend_code));
  v_raw := pg_catalog.replace(v_raw, 'DARE-', '');
  v_raw := pg_catalog.replace(v_raw, '-', '');
  IF pg_catalog.length(v_raw) <> 8 THEN
    RAISE EXCEPTION 'Invalid friend code format' USING ERRCODE = '22023';
  END IF;
  v_normalized_code := 'DARE-' || pg_catalog.substr(v_raw, 1, 4) || '-' || pg_catalog.substr(v_raw, 5, 4);

  SELECT * INTO v_target FROM public.user_profiles WHERE friend_code = v_normalized_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No user found with that friend code' USING ERRCODE = 'P0002';
  END IF;

  IF v_target.user_id = v_caller_id THEN
    RAISE EXCEPTION 'Cannot send a friend request to yourself' USING ERRCODE = '22023';
  END IF;

  -- Lock existing friendship record between this canonical pair if one exists
  SELECT * INTO v_existing
  FROM public.friendships
  WHERE (sender_id = v_caller_id AND receiver_id = v_target.user_id)
     OR (sender_id = v_target.user_id AND receiver_id = v_caller_id)
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'accepted' THEN
      RAISE EXCEPTION 'You are already friends with this user' USING ERRCODE = '23505';
    ELSIF v_existing.status = 'pending' THEN
      IF v_existing.sender_id = v_caller_id THEN
        RAISE EXCEPTION 'Friend request already sent and pending' USING ERRCODE = '23505';
      ELSE
        -- Reciprocal request! The other user already sent a pending request to caller.
        -- Resolve immediately and atomically to accepted.
        UPDATE public.friendships
        SET status = 'accepted', updated_at = pg_catalog.now()
        WHERE id = v_existing.id
        RETURNING friendships.id, friendships.status INTO v_result_id, v_result_status;

        -- Record in-app notification for target user that friend request was accepted
        INSERT INTO public.notification_deliveries (
          idempotency_key,
          event_type,
          recipient_id,
          status,
          payload,
          created_at
        ) VALUES (
          'friend_accepted_' || v_result_id || '_' || v_target.user_id,
          'friend_request_accepted',
          v_target.user_id,
          'sent',
          jsonb_build_object(
            'spec', jsonb_build_object(
              'title', 'Friend Request Accepted! 🤝',
              'body', COALESCE(v_caller_name, 'A user') || ' accepted your friend request.',
              'data', jsonb_build_object(
                'type', 'friend_request_accepted',
                'friendUserId', v_caller_id
              )
            )
          ),
          pg_catalog.now()
        ) ON CONFLICT (idempotency_key) DO NOTHING;

        RETURN QUERY SELECT v_result_id, v_result_status, v_target.display_name;
        RETURN;
      END IF;
    ELSE
      -- Previous request was declined or cancelled: reactivate the existing row to pending
      UPDATE public.friendships
      SET sender_id = v_caller_id,
          receiver_id = v_target.user_id,
          status = 'pending',
          updated_at = pg_catalog.now()
      WHERE id = v_existing.id
      RETURNING friendships.id, friendships.status INTO v_result_id, v_result_status;
    END IF;
  ELSE
    -- Attempt insert with concurrent unique_violation handling
    BEGIN
      INSERT INTO public.friendships (
        sender_id,
        receiver_id,
        status,
        created_at,
        updated_at
      ) VALUES (
        v_caller_id,
        v_target.user_id,
        'pending',
        pg_catalog.now(),
        pg_catalog.now()
      )
      RETURNING friendships.id, friendships.status INTO v_result_id, v_result_status;
    EXCEPTION WHEN unique_violation THEN
      -- A simultaneous request from the other party committed in parallel
      SELECT * INTO v_existing
      FROM public.friendships
      WHERE (sender_id = v_caller_id AND receiver_id = v_target.user_id)
         OR (sender_id = v_target.user_id AND receiver_id = v_caller_id)
      FOR UPDATE;

      IF FOUND THEN
        IF v_existing.status = 'pending' AND v_existing.sender_id = v_target.user_id THEN
          -- The other user simultaneously inserted a pending request! Resolve to accepted
          UPDATE public.friendships
          SET status = 'accepted', updated_at = pg_catalog.now()
          WHERE id = v_existing.id
          RETURNING friendships.id, friendships.status INTO v_result_id, v_result_status;

          INSERT INTO public.notification_deliveries (
            idempotency_key,
            event_type,
            recipient_id,
            status,
            payload,
            created_at
          ) VALUES (
            'friend_accepted_' || v_result_id || '_' || v_target.user_id,
            'friend_request_accepted',
            v_target.user_id,
            'sent',
            jsonb_build_object(
              'spec', jsonb_build_object(
                'title', 'Friend Request Accepted! 🤝',
                'body', COALESCE(v_caller_name, 'A user') || ' accepted your friend request.',
                'data', jsonb_build_object(
                  'type', 'friend_request_accepted',
                  'friendUserId', v_caller_id
                )
              )
            ),
            pg_catalog.now()
          ) ON CONFLICT (idempotency_key) DO NOTHING;

          RETURN QUERY SELECT v_result_id, v_result_status, v_target.display_name;
          RETURN;
        ELSIF v_existing.status = 'accepted' THEN
          RAISE EXCEPTION 'You are already friends with this user' USING ERRCODE = '23505';
        ELSE
          RAISE EXCEPTION 'Friend request already sent and pending' USING ERRCODE = '23505';
        END IF;
      ELSE
        RAISE;
      END IF;
    END;
  END IF;

  -- Record in-app notification for target user that a new friend request arrived
  INSERT INTO public.notification_deliveries (
    idempotency_key,
    event_type,
    recipient_id,
    status,
    payload,
    created_at
  ) VALUES (
    'friend_req_' || v_result_id || '_' || pg_catalog.to_char(pg_catalog.now(), 'YYYYMMDDHH24MISS'),
    'friend_request_received',
    v_target.user_id,
    'sent',
    jsonb_build_object(
      'spec', jsonb_build_object(
        'title', 'New Friend Request 👋',
        'body', COALESCE(v_caller_name, 'Someone') || ' sent you a friend request on DareDrop.',
        'data', jsonb_build_object(
          'type', 'friend_request_received',
          'requestId', v_result_id,
          'senderId', v_caller_id
        )
      )
    ),
    pg_catalog.now()
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN QUERY SELECT v_result_id, v_result_status, v_target.display_name;
END;
$$;

REVOKE ALL ON FUNCTION public.send_friend_request(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_friend_request(TEXT) TO authenticated;

-- RPC 8: accept_friend_request
CREATE OR REPLACE FUNCTION public.accept_friend_request(
  p_request_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_caller_name TEXT;
  v_request public.friendships;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- Lock row to prevent concurrent accept/decline race conditions
  SELECT * INTO v_request FROM public.friendships WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Friend request not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_request.receiver_id <> v_caller_id THEN
    RAISE EXCEPTION 'Only the recipient can accept a friend request' USING ERRCODE = '42501';
  END IF;

  IF v_request.status = 'accepted' THEN
    RETURN TRUE; -- Idempotent success
  END IF;

  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'Only a pending friend request can be accepted' USING ERRCODE = '22023';
  END IF;

  UPDATE public.friendships
  SET status = 'accepted', updated_at = pg_catalog.now()
  WHERE id = p_request_id;

  -- Lookup caller name for notification
  SELECT display_name INTO v_caller_name FROM public.user_profiles WHERE user_id = v_caller_id;

  -- Record in-app notification for original sender
  INSERT INTO public.notification_deliveries (
    idempotency_key,
    event_type,
    recipient_id,
    status,
    payload,
    created_at
  ) VALUES (
    'friend_accepted_' || p_request_id || '_' || v_request.sender_id,
    'friend_request_accepted',
    v_request.sender_id,
    'sent',
    jsonb_build_object(
      'spec', jsonb_build_object(
        'title', 'Friend Request Accepted! 🤝',
        'body', COALESCE(v_caller_name, 'A user') || ' accepted your friend request.',
        'data', jsonb_build_object(
          'type', 'friend_request_accepted',
          'friendUserId', v_caller_id
        )
      )
    ),
    pg_catalog.now()
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.accept_friend_request(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_friend_request(UUID) TO authenticated;

-- RPC 9: send_challenge_invitation
CREATE OR REPLACE FUNCTION public.send_challenge_invitation(
  p_challenge_id UUID,
  p_invitee_user_id TEXT
)
RETURNS TABLE (
  invitation_id UUID,
  status TEXT,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_caller_name TEXT;
  v_challenge public.challenges;
  v_is_friend BOOLEAN;
  v_is_participant BOOLEAN;
  v_invitee_joined BOOLEAN;
  v_invitation_id UUID;
  v_expires_at TIMESTAMPTZ;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF v_caller_id = p_invitee_user_id THEN
    RAISE EXCEPTION 'Cannot invite yourself to a challenge' USING ERRCODE = '22023';
  END IF;

  -- 1. Verify challenge exists
  SELECT * INTO v_challenge FROM public.challenges WHERE id = p_challenge_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Challenge not found' USING ERRCODE = 'P0002';
  END IF;

  -- Check if challenge has expired
  IF v_challenge.ends_at IS NOT NULL AND v_challenge.ends_at <= pg_catalog.now() THEN
    RAISE EXCEPTION 'Challenge has already ended' USING ERRCODE = '22023';
  END IF;

  -- 2. Verify caller is a participant or creator
  SELECT EXISTS (
    SELECT 1 FROM public.challenge_participants
    WHERE challenge_id = p_challenge_id AND user_id = v_caller_id
  ) OR (v_challenge.creator_id = v_caller_id) INTO v_is_participant;

  IF NOT v_is_participant THEN
    RAISE EXCEPTION 'You must be a participant or creator to invite friends' USING ERRCODE = '42501';
  END IF;

  -- 3. Verify users are accepted friends
  SELECT EXISTS (
    SELECT 1 FROM public.friendships f
    WHERE f.status = 'accepted'
      AND ((f.sender_id = v_caller_id AND f.receiver_id = p_invitee_user_id)
        OR (f.receiver_id = v_caller_id AND f.sender_id = p_invitee_user_id))
  ) INTO v_is_friend;

  IF NOT v_is_friend THEN
    RAISE EXCEPTION 'You can only invite accepted friends' USING ERRCODE = '42501';
  END IF;

  -- 4. Check if invitee is already joined
  SELECT EXISTS (
    SELECT 1 FROM public.challenge_participants
    WHERE challenge_id = p_challenge_id AND user_id = p_invitee_user_id
  ) INTO v_invitee_joined;

  IF v_invitee_joined THEN
    RAISE EXCEPTION 'User is already a participant in this challenge' USING ERRCODE = '23505';
  END IF;

  -- 5. Calculate expiration: minimum of 7 days or challenge end date
  v_expires_at := LEAST(
    pg_catalog.now() + INTERVAL '7 days',
    COALESCE(v_challenge.ends_at, pg_catalog.now() + INTERVAL '7 days')
  );

  -- 6. Insert pending invitation (unique partial index prevents duplicate active pending)
  INSERT INTO public.challenge_invitations (
    challenge_id,
    inviter_id,
    invitee_id,
    status,
    created_at,
    expires_at
  ) VALUES (
    p_challenge_id,
    v_caller_id,
    p_invitee_user_id,
    'pending',
    pg_catalog.now(),
    v_expires_at
  )
  RETURNING id INTO v_invitation_id;

  -- Lookup caller name for notification
  SELECT display_name INTO v_caller_name FROM public.user_profiles WHERE user_id = v_caller_id;

  -- 7. Notify invitee via in-app inbox
  INSERT INTO public.notification_deliveries (
    idempotency_key,
    event_type,
    recipient_id,
    status,
    payload,
    created_at
  ) VALUES (
    'challenge_invite_' || v_invitation_id,
    'challenge_invitation_received',
    p_invitee_user_id,
    'sent',
    jsonb_build_object(
      'spec', jsonb_build_object(
        'title', 'Challenge Invitation ⚡',
        'body', COALESCE(v_caller_name, 'A friend') || ' invited you to "' || v_challenge.title || '"',
        'data', jsonb_build_object(
          'type', 'challenge_invitation_received',
          'challengeId', p_challenge_id::TEXT,
          'invitationId', v_invitation_id,
          'inviterId', v_caller_id
        )
      )
    ),
    pg_catalog.now()
  ) ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN QUERY SELECT v_invitation_id, 'pending'::TEXT, v_expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.send_challenge_invitation(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_challenge_invitation(UUID, TEXT) TO authenticated;

-- RPC 10: respond_to_challenge_invitation
CREATE OR REPLACE FUNCTION public.respond_to_challenge_invitation(
  p_invitation_id UUID,
  p_accept BOOLEAN
)
RETURNS TABLE (
  invitation_id UUID,
  status TEXT,
  challenge_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_invitation public.challenge_invitations;
  v_challenge public.challenges;
  v_is_friend BOOLEAN;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- Row-level locking ensures strict serialization across concurrent accept/decline calls
  SELECT * INTO v_invitation FROM public.challenge_invitations WHERE id = p_invitation_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_invitation.invitee_id <> v_caller_id THEN
    RAISE EXCEPTION 'Only the invited user can respond to this invitation' USING ERRCODE = '42501';
  END IF;

  -- If already finalized, return idempotent status
  IF v_invitation.status IN ('accepted', 'declined', 'expired') THEN
    RETURN QUERY SELECT p_invitation_id, v_invitation.status, v_invitation.challenge_id;
    RETURN;
  END IF;

  -- Check if invitation has expired: persist 'expired' status without raising rollback exception
  IF v_invitation.expires_at <= pg_catalog.now() THEN
    UPDATE public.challenge_invitations SET status = 'expired' WHERE id = p_invitation_id;
    RETURN QUERY SELECT p_invitation_id, 'expired'::TEXT, v_invitation.challenge_id;
    RETURN;
  END IF;

  IF p_accept THEN
    -- 1. Revalidate challenge is still active
    SELECT * INTO v_challenge FROM public.challenges WHERE id = v_invitation.challenge_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Challenge not found' USING ERRCODE = 'P0002';
    END IF;

    IF v_challenge.ends_at IS NOT NULL AND v_challenge.ends_at <= pg_catalog.now() THEN
      UPDATE public.challenge_invitations SET status = 'expired' WHERE id = p_invitation_id;
      RETURN QUERY SELECT p_invitation_id, 'expired'::TEXT, v_invitation.challenge_id;
      RETURN;
    END IF;

    -- 2. Revalidate friendship is still active
    SELECT EXISTS (
      SELECT 1 FROM public.friendships f
      WHERE f.status = 'accepted'
        AND ((f.sender_id = v_caller_id AND f.receiver_id = v_invitation.inviter_id)
          OR (f.receiver_id = v_caller_id AND f.sender_id = v_invitation.inviter_id))
    ) INTO v_is_friend;

    IF NOT v_is_friend THEN
      RAISE EXCEPTION 'You must be accepted friends with the inviter to accept this invitation' USING ERRCODE = '42501';
    END IF;

    -- 3. Atomically join the challenge (fires existing trg_challenge_participant_count trigger)
    INSERT INTO public.challenge_participants (
      challenge_id,
      user_id,
      joined_at
    ) VALUES (
      v_invitation.challenge_id,
      v_caller_id,
      pg_catalog.now()
    )
    ON CONFLICT ON CONSTRAINT unique_challenge_participant DO NOTHING;

    UPDATE public.challenge_invitations
    SET status = 'accepted'
    WHERE id = p_invitation_id;

    RETURN QUERY SELECT p_invitation_id, 'accepted'::TEXT, v_invitation.challenge_id;
  ELSE
    UPDATE public.challenge_invitations
    SET status = 'declined'
    WHERE id = p_invitation_id;

    RETURN QUERY SELECT p_invitation_id, 'declined'::TEXT, v_invitation.challenge_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.respond_to_challenge_invitation(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_to_challenge_invitation(UUID, BOOLEAN) TO authenticated;

-- ============================================================================
-- 7. Drop Registration Helper Function
-- ============================================================================

DROP FUNCTION IF EXISTS public.is_registered_account();

COMMIT;
