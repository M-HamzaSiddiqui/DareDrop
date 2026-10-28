-- DareDrop Friends & Social Challenges Migration (Hardened Pre-Production Version)
-- File: supabase/migrations/20261028000000_friends_and_invitations.sql
-- Sets up user profiles, friend codes, friendships, challenge invitations, RLS, and atomic SECURITY DEFINER RPCs.
-- NOTE: PROPOSED MIGRATION FOR LOCAL REVIEW ONLY. DO NOT APPLY TO PRODUCTION DATABASE WITHOUT EXPLICIT AUTHORIZATION.

BEGIN;

-- 1. User Profiles & Friend Codes Table
CREATE TABLE IF NOT EXISTS public.user_profiles (
  user_id TEXT PRIMARY KEY,
  friend_code TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT 'DareDropper',
  avatar_emoji TEXT NOT NULL DEFAULT '🦁',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_profile_display_name_len CHECK (char_length(display_name) >= 2 AND char_length(display_name) <= 32),
  CONSTRAINT chk_profile_avatar_emoji_len CHECK (char_length(avatar_emoji) >= 1 AND char_length(avatar_emoji) <= 8)
);

-- Index for exact-match friend code lookups
CREATE INDEX IF NOT EXISTS idx_user_profiles_friend_code ON public.user_profiles (friend_code);

-- Enable RLS on user_profiles
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- Security Lockdown: Revoke all direct writes from client roles. Mutations are permitted strictly via RPCs.
REVOKE ALL ON TABLE public.user_profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_profiles TO authenticated;

-- Users can inspect their own profile
DROP POLICY IF EXISTS "Users can view own profile" ON public.user_profiles;
CREATE POLICY "Users can view own profile"
  ON public.user_profiles
  FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL AND user_id = auth.uid()::text);

-- Drop direct update policy since direct writes are revoked
DROP POLICY IF EXISTS "Users can update own profile" ON public.user_profiles;

-- 2. Friendships Table
CREATE TABLE IF NOT EXISTS public.friendships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_friendship_no_self CHECK (sender_id <> receiver_id)
);

-- Partial Unique Index: Guarantees at most ONE active friendship or pending request per canonical pair
-- Allows re-requesting after previous request was declined or cancelled
CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_active_pair
  ON public.friendships (LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id))
  WHERE status IN ('pending', 'accepted');

CREATE INDEX IF NOT EXISTS idx_friendships_sender ON public.friendships (sender_id);
CREATE INDEX IF NOT EXISTS idx_friendships_receiver ON public.friendships (receiver_id);
CREATE INDEX IF NOT EXISTS idx_friendships_status ON public.friendships (status);
CREATE INDEX IF NOT EXISTS idx_friendships_pair ON public.friendships (LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id));

-- Enable RLS on friendships
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.friendships FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.friendships TO authenticated;

-- Users can only view friendships where they are the sender or receiver
DROP POLICY IF EXISTS "Users can view own friendships" ON public.friendships;
CREATE POLICY "Users can view own friendships"
  ON public.friendships
  FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL AND (sender_id = auth.uid()::text OR receiver_id = auth.uid()::text));

-- Allow accepted friends to view each other's public profile
DROP POLICY IF EXISTS "Friends can view public profile" ON public.user_profiles;
CREATE POLICY "Friends can view public profile"
  ON public.user_profiles
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() IS NOT NULL AND (
      user_id = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.friendships f
        WHERE f.status = 'accepted'
          AND (
            (f.sender_id = auth.uid()::text AND f.receiver_id = public.user_profiles.user_id)
            OR (f.receiver_id = auth.uid()::text AND f.sender_id = public.user_profiles.user_id)
          )
      )
    )
  );

-- 3. Challenge Invitations Table
CREATE TABLE IF NOT EXISTS public.challenge_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge_id UUID NOT NULL REFERENCES public.challenges(id) ON DELETE CASCADE,
  inviter_id TEXT NOT NULL,
  invitee_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT chk_invitation_no_self CHECK (inviter_id <> invitee_id)
);

-- Partial Unique Index: At most ONE pending invitation per challenge per invitee while preserving history
CREATE UNIQUE INDEX IF NOT EXISTS idx_challenge_invitations_active
  ON public.challenge_invitations (challenge_id, invitee_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_challenge_invitations_challenge ON public.challenge_invitations (challenge_id);
CREATE INDEX IF NOT EXISTS idx_challenge_invitations_invitee ON public.challenge_invitations (invitee_id);
CREATE INDEX IF NOT EXISTS idx_challenge_invitations_inviter ON public.challenge_invitations (inviter_id);

-- Enable RLS on challenge_invitations
ALTER TABLE public.challenge_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.challenge_invitations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.challenge_invitations TO authenticated;

-- Users can only view invitations they sent or received
DROP POLICY IF EXISTS "Users can view own invitations" ON public.challenge_invitations;
CREATE POLICY "Users can view own invitations"
  ON public.challenge_invitations
  FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL AND (inviter_id = auth.uid()::text OR invitee_id = auth.uid()::text));

-- 4. Friend Code Lookup Rate Limits Table
CREATE TABLE IF NOT EXISTS public.friend_code_lookup_rate_limits (
  user_id TEXT PRIMARY KEY,
  attempt_count INT NOT NULL DEFAULT 1,
  window_start TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()
);

-- Enable RLS on rate limits table and strictly revoke direct client access
ALTER TABLE public.friend_code_lookup_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.friend_code_lookup_rate_limits FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 5. Helper Function: Generate Cryptographically Secure Crockford Base32 Friend Code
-- Fully schema-qualifies extensions.gen_random_bytes and uses a fixed empty search path.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.generate_secure_friend_code()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Crockford Base32 alphabet: 32 chars, excluding I, L, O, U to prevent visual confusion and offensive words
  v_chars TEXT := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_bytes BYTEA;
  v_code TEXT := '';
  v_i INT;
  v_idx INT;
BEGIN
  -- 8 characters with 32 alphabet = 32^8 = 1.099 trillion combinations
  -- pgcrypto is installed in extensions schema in Supabase
  v_bytes := extensions.gen_random_bytes(8);
  FOR v_i IN 0..7 LOOP
    v_idx := (pg_catalog.get_byte(v_bytes, v_i) % 32) + 1;
    v_code := v_code || pg_catalog.substr(v_chars, v_idx, 1);
  END LOOP;
  -- Return formatted as DARE-XXXX-XXXX
  RETURN 'DARE-' || pg_catalog.substr(v_code, 1, 4) || '-' || pg_catalog.substr(v_code, 5, 4);
END;
$$;

-- Internal helper only; revoke execution from client roles
REVOKE ALL ON FUNCTION public.generate_secure_friend_code() FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 5. RPC: get_or_create_user_profile
-- Initializes or retrieves the authenticated caller's profile and unique friend code.
-- Concurrency-safe: handles simultaneous creation for the same user idempotently,
-- distinguishing PK conflicts from friend-code uniqueness collisions.
-- ============================================================================
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

-- ============================================================================
-- 5B. RPC: update_user_profile
-- Authenticated profile modification RPC with strict server-side validation.
-- Users cannot modify user_id or friend_code.
-- ============================================================================
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

-- ============================================================================
-- 6. RPC: lookup_profile_by_friend_code
-- Exact lookup only. Returns strictly minimal preview fields:
-- display_name, avatar_emoji, is_self, friendship_status.
-- Never exposes internal user_id or redundant friend_code.
-- Protected by server-side atomic rate limiting (15 attempts/min per user).
-- ============================================================================
DROP FUNCTION IF EXISTS public.lookup_profile_by_friend_code(TEXT);
CREATE OR REPLACE FUNCTION public.lookup_profile_by_friend_code(
  p_friend_code TEXT
)
RETURNS TABLE (
  display_name TEXT,
  avatar_emoji TEXT,
  is_self BOOLEAN,
  friendship_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_normalized_code TEXT;
  v_raw TEXT;
  v_target public.user_profiles;
  v_status TEXT := 'none';
  v_rate_limit_attempts INT;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- Server-side rate limiting: 15 lookups per 1-minute fixed window per authenticated user.
  -- Atomic upsert with row-level lock serialization prevents concurrent race bypasses.
  INSERT INTO public.friend_code_lookup_rate_limits (user_id, attempt_count, window_start)
  VALUES (v_caller_id, 1, pg_catalog.now())
  ON CONFLICT (user_id) DO UPDATE SET
    attempt_count = CASE
      WHEN pg_catalog.now() - public.friend_code_lookup_rate_limits.window_start > INTERVAL '1 minute' THEN 1
      ELSE public.friend_code_lookup_rate_limits.attempt_count + 1
    END,
    window_start = CASE
      WHEN pg_catalog.now() - public.friend_code_lookup_rate_limits.window_start > INTERVAL '1 minute' THEN pg_catalog.now()
      ELSE public.friend_code_lookup_rate_limits.window_start
    END
  RETURNING attempt_count INTO v_rate_limit_attempts;

  IF v_rate_limit_attempts > 15 THEN
    RAISE EXCEPTION 'Rate limit exceeded. Too many lookups. Please wait a minute before searching again.' USING ERRCODE = '22023';
  END IF;

  IF p_friend_code IS NULL THEN
    RAISE EXCEPTION 'Friend code is required' USING ERRCODE = '22023';
  END IF;

  -- Normalize: uppercase, strip whitespace, strip DARE- prefix and dashes
  v_raw := pg_catalog.upper(pg_catalog.btrim(p_friend_code));
  v_raw := pg_catalog.replace(v_raw, 'DARE-', '');
  v_raw := pg_catalog.replace(v_raw, '-', '');

  IF pg_catalog.length(v_raw) <> 8 THEN
    RAISE EXCEPTION 'Invalid friend code format' USING ERRCODE = '22023';
  END IF;

  v_normalized_code := 'DARE-' || pg_catalog.substr(v_raw, 1, 4) || '-' || pg_catalog.substr(v_raw, 5, 4);

  SELECT * INTO v_target FROM public.user_profiles WHERE friend_code = v_normalized_code;
  IF NOT FOUND THEN
    RETURN; -- Returns 0 rows (safely not found)
  END IF;

  -- Check existing friendship status
  IF v_target.user_id = v_caller_id THEN
    v_status := 'self';
  ELSE
    SELECT f.status INTO v_status
    FROM public.friendships f
    WHERE (f.sender_id = v_caller_id AND f.receiver_id = v_target.user_id)
       OR (f.receiver_id = v_caller_id AND f.sender_id = v_target.user_id)
    ORDER BY f.created_at DESC
    LIMIT 1;
    v_status := COALESCE(v_status, 'none');
  END IF;

  RETURN QUERY
  SELECT
    v_target.display_name,
    v_target.avatar_emoji,
    (v_target.user_id = v_caller_id) AS is_self,
    v_status AS friendship_status;
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_profile_by_friend_code(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lookup_profile_by_friend_code(TEXT) TO authenticated;

-- ============================================================================
-- 7. RPC: send_friend_request
-- Sends or resolves reciprocal friend request atomically with row locking.
-- Handles concurrent reciprocal requests without leaking raw unique_violation errors.
-- NOTE: In-app inbox notifications are recorded in notification_deliveries.
-- Push notifications to APNs/FCM are not triggered by this social event.
-- ============================================================================
DROP FUNCTION IF EXISTS public.send_friend_request(TEXT);
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

-- ============================================================================
-- 8. RPC: accept_friend_request
-- Accepts incoming request with row-level locking. Caller must be the recipient.
-- Idempotent if already accepted.
-- ============================================================================
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

-- ============================================================================
-- 9. RPC: decline_friend_request
-- Declines incoming request with row-level locking. Caller must be the recipient.
-- Enforces that only pending requests can be declined.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.decline_friend_request(
  p_request_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_request public.friendships;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_request FROM public.friendships WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Friend request not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_request.receiver_id <> v_caller_id THEN
    RAISE EXCEPTION 'Only the recipient can decline a friend request' USING ERRCODE = '42501';
  END IF;

  IF v_request.status = 'declined' THEN
    RETURN TRUE; -- Idempotent
  END IF;

  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'Only a pending friend request can be declined' USING ERRCODE = '22023';
  END IF;

  UPDATE public.friendships
  SET status = 'declined', updated_at = pg_catalog.now()
  WHERE id = p_request_id;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.decline_friend_request(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.decline_friend_request(UUID) TO authenticated;

-- ============================================================================
-- 10. RPC: cancel_friend_request
-- Cancels outgoing request with row-level locking. Caller must be the sender.
-- Enforces that only pending requests can be cancelled.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.cancel_friend_request(
  p_request_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_request public.friendships;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_request FROM public.friendships WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Friend request not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_request.sender_id <> v_caller_id THEN
    RAISE EXCEPTION 'Only the sender can cancel a friend request' USING ERRCODE = '42501';
  END IF;

  IF v_request.status = 'cancelled' THEN
    RETURN TRUE; -- Idempotent
  END IF;

  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'Only a pending friend request can be cancelled' USING ERRCODE = '22023';
  END IF;

  UPDATE public.friendships
  SET status = 'cancelled', updated_at = pg_catalog.now()
  WHERE id = p_request_id;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_friend_request(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_friend_request(UUID) TO authenticated;

-- ============================================================================
-- 11. RPC: remove_friend
-- Removes an accepted friendship. Either party can initiate.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.remove_friend(
  p_friend_user_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.friendships
  WHERE status = 'accepted'
    AND ((sender_id = v_caller_id AND receiver_id = p_friend_user_id)
      OR (receiver_id = v_caller_id AND sender_id = p_friend_user_id));

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_friend(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_friend(TEXT) TO authenticated;

-- ============================================================================
-- 12. RPC: get_user_friends
-- Returns list of accepted friends with safe public profile details.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_user_friends()
RETURNS TABLE (
  friendship_id UUID,
  friend_user_id TEXT,
  display_name TEXT,
  avatar_emoji TEXT,
  friend_code TEXT,
  friends_since TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    f.id AS friendship_id,
    CASE WHEN f.sender_id = v_caller_id THEN f.receiver_id ELSE f.sender_id END AS friend_user_id,
    COALESCE(p.display_name, 'DareDropper') AS display_name,
    COALESCE(p.avatar_emoji, '🦁') AS avatar_emoji,
    COALESCE(p.friend_code, '') AS friend_code,
    f.updated_at AS friends_since
  FROM public.friendships f
  JOIN public.user_profiles p
    ON p.user_id = (CASE WHEN f.sender_id = v_caller_id THEN f.receiver_id ELSE f.sender_id END)
  WHERE f.status = 'accepted'
    AND (f.sender_id = v_caller_id OR f.receiver_id = v_caller_id)
  ORDER BY p.display_name ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_friends() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_friends() TO authenticated;

-- ============================================================================
-- 13. RPC: get_pending_friend_requests
-- Returns incoming and outgoing pending requests with profile info.
-- ============================================================================
DROP FUNCTION IF EXISTS public.get_pending_friend_requests();
CREATE OR REPLACE FUNCTION public.get_pending_friend_requests()
RETURNS TABLE (
  request_id UUID,
  direction TEXT, -- 'incoming' or 'outgoing'
  display_name TEXT,
  avatar_emoji TEXT,
  friend_code TEXT,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    f.id AS request_id,
    CASE WHEN f.receiver_id = v_caller_id THEN 'incoming' ELSE 'outgoing' END AS direction,
    COALESCE(p.display_name, 'DareDropper') AS display_name,
    COALESCE(p.avatar_emoji, '🦁') AS avatar_emoji,
    COALESCE(p.friend_code, '') AS friend_code,
    f.created_at
  FROM public.friendships f
  JOIN public.user_profiles p
    ON p.user_id = (CASE WHEN f.receiver_id = v_caller_id THEN f.sender_id ELSE f.receiver_id END)
  WHERE f.status = 'pending'
    AND (f.sender_id = v_caller_id OR f.receiver_id = v_caller_id)
  ORDER BY f.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_pending_friend_requests() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_pending_friend_requests() TO authenticated;

-- ============================================================================
-- 14. RPC: send_challenge_invitation
-- Invites an accepted friend to an active challenge.
-- NOTE: In-app inbox notifications are recorded in notification_deliveries.
-- ============================================================================
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

-- ============================================================================
-- 15. RPC: respond_to_challenge_invitation
-- Accepts or declines invitation with row-level locking.
-- On accept, registers in challenge_participants atomically, triggering
-- the existing trg_challenge_participant_count trigger to maintain participants_count.
-- If expired, transitions status to 'expired' and commits without raising rollback exceptions.
-- Revalidates friendship and challenge-end invariants.
-- ============================================================================
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
-- 16. RPC: get_user_challenge_invitations
-- Fetches pending invitations for the authenticated user.
-- ============================================================================
DROP FUNCTION IF EXISTS public.get_user_challenge_invitations();
CREATE OR REPLACE FUNCTION public.get_user_challenge_invitations()
RETURNS TABLE (
  invitation_id UUID,
  challenge_id UUID,
  challenge_title TEXT,
  challenge_category TEXT,
  challenge_duration_days INT,
  inviter_name TEXT,
  inviter_avatar TEXT,
  created_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    i.id AS invitation_id,
    c.id AS challenge_id,
    c.title AS challenge_title,
    c.category AS challenge_category,
    c.duration_days AS challenge_duration_days,
    COALESCE(p.display_name, 'DareDropper') AS inviter_name,
    COALESCE(p.avatar_emoji, '🦁') AS inviter_avatar,
    i.created_at,
    i.expires_at
  FROM public.challenge_invitations i
  JOIN public.challenges c ON c.id = i.challenge_id
  JOIN public.user_profiles p ON p.user_id = i.inviter_id
  WHERE i.invitee_id = v_caller_id
    AND i.status = 'pending'
    AND i.expires_at > pg_catalog.now()
  ORDER BY i.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_challenge_invitations() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_challenge_invitations() TO authenticated;

COMMIT;
