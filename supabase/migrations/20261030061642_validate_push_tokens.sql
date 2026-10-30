-- DareDrop Database Migration: Validate Device Push Notification Tokens (Finding L-2)
-- File: supabase/migrations/20261030020000_validate_push_tokens.sql
-- Status: PREPARED MIGRATION — DO NOT EXECUTE DIRECTLY AGAINST PRODUCTION WITHOUT EXPLICIT APPROVAL
--
-- Objective:
-- Mitigates Finding L-2 by enforcing database-level format validation, character bounds, and whitespace
-- integrity on push tokens and device names in public.user_push_tokens.
--
-- Architectural & Security Rationale:
-- 1. Threat Mitigation:
--    - Previously, expo_push_token had no format, length, or whitespace validation.
--    - Malformed or arbitrary strings stored in user_push_tokens caused edge functions to skip notification
--      deliveries or could result in storage exhaustion DoS attacks.
-- 2. Push Token Format Enforcement:
--    - DareDrop exclusively uses the Expo Push API via Notifications.getExpoPushTokenAsync().
--    - Validates against Expo's official token structure: ExponentPushToken[...] or ExpoPushToken[...],
--      wrapping non-whitespace, non-closing-bracket characters, without over-constraining the inner token body.
--    - Adds CHECK constraint chk_user_push_tokens_token_format enforcing the regex and a 255-character maximum.
-- 3. Device Name Length & Whitespace Bounds:
--    - Adds CHECK constraint chk_user_push_tokens_device_name_len ensuring device_name is NULL or non-whitespace
--      and at most 100 characters.
-- 4. RPC Hardening:
--    - Updates public.register_device_push_token() to trim and validate token syntax before insertion,
--      returning descriptive SQLSTATE '22023' exceptions if a malformed token is submitted.
-- 5. Compatibility & Invariants:
--    - 100% compatible with existing production records (all 3 live tokens pass).
--    - Preserves unique constraint uq_user_push_token and device reassignment behavior on user change.
--    - Preserves RLS policies and ownership checks (user_id = auth.uid()::text AND is_registered_account()).
--    - Zero impact on H-1, M-1, M-2, or L-1.

BEGIN;

-- ============================================================================
-- 1. Constraints on public.user_push_tokens
-- ============================================================================

-- A. Enforce Expo Push Token structure and maximum length
ALTER TABLE public.user_push_tokens
  ADD CONSTRAINT chk_user_push_tokens_token_format
    CHECK (
      expo_push_token ~ '^(ExponentPushToken|ExpoPushToken)\[[^[:space:]\]]+\]$'
      AND pg_catalog.char_length(expo_push_token) <= 255
    );

COMMENT ON CONSTRAINT chk_user_push_tokens_token_format ON public.user_push_tokens IS
  'Enforces that push tokens match the canonical Expo Push Token structure and do not exceed 255 characters.';

-- B. Enforce device_name length and whitespace integrity
ALTER TABLE public.user_push_tokens
  ADD CONSTRAINT chk_user_push_tokens_device_name_len
    CHECK (
      device_name IS NULL
      OR (
        device_name ~ '[^[:space:]]'
        AND pg_catalog.char_length(device_name) <= 100
      )
    );

COMMENT ON CONSTRAINT chk_user_push_tokens_device_name_len ON public.user_push_tokens IS
  'Enforces that device_name is NULL or non-whitespace text up to 100 characters.';

-- ============================================================================
-- 2. Update Registration RPC: public.register_device_push_token
-- ============================================================================

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
  v_trimmed_token TEXT;
  v_trimmed_device TEXT;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_registered_account() THEN
    RAISE EXCEPTION 'A registered account is required to register device push tokens' USING ERRCODE = '42501';
  END IF;

  IF p_expo_push_token IS NULL THEN
    RAISE EXCEPTION 'Push token is required' USING ERRCODE = '22023';
  END IF;

  v_trimmed_token := pg_catalog.btrim(p_expo_push_token);

  -- Validate Expo push token format
  IF v_trimmed_token !~ '^(ExponentPushToken|ExpoPushToken)\[[^[:space:]\]]+\]$' THEN
    RAISE EXCEPTION 'Invalid Expo push token format' USING ERRCODE = '22023';
  END IF;

  IF pg_catalog.char_length(v_trimmed_token) > 255 THEN
    RAISE EXCEPTION 'Push token exceeds maximum length of 255 characters' USING ERRCODE = '22023';
  END IF;

  -- Normalize device name if provided
  IF p_device_name IS NOT NULL THEN
    v_trimmed_device := pg_catalog.btrim(p_device_name);
    IF v_trimmed_device = '' THEN
      v_trimmed_device := NULL;
    ELSIF pg_catalog.char_length(v_trimmed_device) > 100 THEN
      RAISE EXCEPTION 'Device name exceeds maximum length of 100 characters' USING ERRCODE = '22023';
    END IF;
  ELSE
    v_trimmed_device := NULL;
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
    v_trimmed_token,
    COALESCE(p_platform, 'unknown'),
    v_trimmed_device,
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

ALTER FUNCTION public.register_device_push_token(TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.register_device_push_token(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_device_push_token(TEXT, TEXT, TEXT) TO authenticated, service_role;

COMMIT;
