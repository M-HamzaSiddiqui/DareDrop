-- DareDrop Push Notifications Migration
-- File: supabase/migrations/20261024030000_push_notifications.sql
-- Sets up device push token registry, RLS policies, atomic registration RPCs, and notification delivery deduplication

-- 1. Device Push Tokens Table
CREATE TABLE IF NOT EXISTS public.user_push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  expo_push_token TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web', 'unknown')),
  device_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_push_token UNIQUE (expo_push_token)
);

CREATE INDEX IF NOT EXISTS idx_user_push_tokens_user_id ON public.user_push_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_user_push_tokens_token ON public.user_push_tokens (expo_push_token);

-- 2. Row Level Security on user_push_tokens
ALTER TABLE public.user_push_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.user_push_tokens FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.user_push_tokens TO authenticated;

-- Users can only inspect their own device registrations (never other users' tokens)
DROP POLICY IF EXISTS "Users can view own push tokens" ON public.user_push_tokens;
CREATE POLICY "Users can view own push tokens"
  ON public.user_push_tokens
  FOR SELECT
  TO authenticated
  USING (auth.uid() IS NOT NULL AND user_id = auth.uid()::text);

DROP POLICY IF EXISTS "Users can insert own push tokens" ON public.user_push_tokens;
CREATE POLICY "Users can insert own push tokens"
  ON public.user_push_tokens
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL AND user_id = auth.uid()::text);

DROP POLICY IF EXISTS "Users can update own push tokens" ON public.user_push_tokens;
CREATE POLICY "Users can update own push tokens"
  ON public.user_push_tokens
  FOR UPDATE
  TO authenticated
  USING (auth.uid() IS NOT NULL AND user_id = auth.uid()::text)
  WITH CHECK (auth.uid() IS NOT NULL AND user_id = auth.uid()::text);

DROP POLICY IF EXISTS "Users can delete own push tokens" ON public.user_push_tokens;
CREATE POLICY "Users can delete own push tokens"
  ON public.user_push_tokens
  FOR DELETE
  TO authenticated
  USING (auth.uid() IS NOT NULL AND user_id = auth.uid()::text);

-- 3. Atomic Device Token Registration RPC
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

-- 4. Atomic Device Token Unregistration RPC (for sign-out)
CREATE OR REPLACE FUNCTION public.unregister_device_push_token(
  p_expo_push_token TEXT
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
    RETURN FALSE;
  END IF;

  DELETE FROM public.user_push_tokens
  WHERE expo_push_token = pg_catalog.btrim(p_expo_push_token)
    AND user_id = v_caller_id;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.unregister_device_push_token(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unregister_device_push_token(TEXT) TO authenticated;

-- 5. Notification Deliveries & Deduplication Table
CREATE TABLE IF NOT EXISTS public.notification_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  completion_id UUID REFERENCES public.challenge_completions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  tokens_sent INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent', 'failed', 'skipped_no_tokens', 'already_processed')),
  payload JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_key ON public.notification_deliveries (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_recipient ON public.notification_deliveries (recipient_id);

ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notification_deliveries FROM PUBLIC, anon, authenticated;
