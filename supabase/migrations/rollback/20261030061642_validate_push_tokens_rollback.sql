-- DareDrop Rollback: Validate Device Push Notification Tokens (Finding L-2)
-- File: supabase/migrations/rollback/20261030020000_validate_push_tokens_rollback.sql
-- Status: PREPARED ROLLBACK — DO NOT EXECUTE DIRECTLY AGAINST PRODUCTION WITHOUT EXPLICIT APPROVAL
--
-- Objective:
-- Reverts all schema objects introduced by 20261030020000_validate_push_tokens.sql,
-- restoring the database to the exact 20261030010000 state (post L-1 text limits).
--
-- Operational & Security Impact:
-- 1. Drops the 2 CHECK constraints added to public.user_push_tokens:
--    - chk_user_push_tokens_token_format
--    - chk_user_push_tokens_device_name_len
-- 2. Restores public.register_device_push_token() to its exact 20261028020000 definition.
-- 3. Grants execute on register_device_push_token to authenticated and service_role, preserving live ACL symmetry.
-- 4. Modifies zero tables, zero columns, zero policies, and zero existing data rows.
-- 5. Preserves H-1 deletion guard, M-1 update guard, M-2 expiry guard, and L-1 text length limits.
-- 6. WARNING: Rolling back this migration removes database-level format validation on push tokens,
--    re-exposing Finding L-2.

BEGIN;

-- ============================================================================
-- 1. Remove Constraints from public.user_push_tokens
-- ============================================================================
ALTER TABLE public.user_push_tokens
  DROP CONSTRAINT IF EXISTS chk_user_push_tokens_token_format,
  DROP CONSTRAINT IF EXISTS chk_user_push_tokens_device_name_len;

-- ============================================================================
-- 2. Restore Original public.register_device_push_token RPC Definition
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
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_registered_account() THEN
    RAISE EXCEPTION 'A registered account is required to register device push tokens' USING ERRCODE = '42501';
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

ALTER FUNCTION public.register_device_push_token(TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.register_device_push_token(TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_device_push_token(TEXT, TEXT, TEXT) TO authenticated, service_role;

COMMIT;
