-- DareDrop In-App Notification Inbox & Read State Migration
-- File: supabase/migrations/20261027000000_notification_inbox.sql
-- Adds read_at column to notification_deliveries, indexes, and security-definer RPCs
-- NOTE: PROPOSED MIGRATION FOR LOCAL REVIEW ONLY. DO NOT APPLY TO PRODUCTION DATABASE WITHOUT EXPLICIT AUTHORIZATION.

-- 1. Add read_at column to notification_deliveries if not present
ALTER TABLE public.notification_deliveries
  ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ DEFAULT NULL;

-- Index for fast recipient lookup filtered by read status and sorted by timestamp
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_recipient_inbox
  ON public.notification_deliveries (recipient_id, read_at, created_at DESC);

-- 2. Security-definer RPC: get_user_notifications
-- Returns notifications strictly addressed to auth.uid()::text
-- Internal backend delivery details (claim_token, tickets, raw errors) are never returned
CREATE OR REPLACE FUNCTION public.get_user_notifications(
  p_limit INT DEFAULT 30,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (
  id UUID,
  event_type TEXT,
  title TEXT,
  body TEXT,
  created_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  is_read BOOLEAN,
  challenge_id UUID,
  completion_id UUID,
  rejection_reason TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
  v_offset INT := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    nd.id,
    nd.event_type,
    COALESCE(nd.payload->'spec'->>'title', 'DareDrop Notification')::TEXT AS title,
    COALESCE(nd.payload->'spec'->>'body', '')::TEXT AS body,
    nd.created_at,
    nd.read_at,
    (nd.read_at IS NOT NULL) AS is_read,
    COALESCE(
      CASE 
        WHEN (nd.payload->'spec'->'data'->>'challengeId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' 
        THEN (nd.payload->'spec'->'data'->>'challengeId')::UUID 
        ELSE NULL 
      END,
      cc.challenge_id
    ) AS challenge_id,
    nd.completion_id,
    cc.rejection_reason
  FROM public.notification_deliveries nd
  LEFT JOIN public.challenge_completions cc ON cc.id = nd.completion_id
  WHERE nd.recipient_id = v_caller_id
    AND nd.status IN ('sent', 'skipped_no_tokens')
  ORDER BY nd.created_at DESC
  LIMIT v_limit OFFSET v_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_notifications(INT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_user_notifications(INT, INT) TO authenticated;

-- 3. Security-definer RPC: mark_notification_read
-- Marks a single notification as read if and only if it belongs to auth.uid()::text
CREATE OR REPLACE FUNCTION public.mark_notification_read(
  p_notification_id UUID
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

  IF p_notification_id IS NULL THEN
    RAISE EXCEPTION 'Notification ID is required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.notification_deliveries
  SET read_at = pg_catalog.now()
  WHERE id = p_notification_id
    AND recipient_id = v_caller_id
    AND read_at IS NULL;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_notification_read(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_notification_read(UUID) TO authenticated;

-- 4. Security-definer RPC: mark_all_notifications_read
-- Marks all unread notifications for auth.uid()::text as read
CREATE OR REPLACE FUNCTION public.mark_all_notifications_read()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_updated_count INT;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.notification_deliveries
  SET read_at = pg_catalog.now()
  WHERE recipient_id = v_caller_id
    AND status IN ('sent', 'skipped_no_tokens')
    AND read_at IS NULL;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  RETURN v_updated_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_all_notifications_read() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read() TO authenticated;

-- 5. Security-definer RPC: get_unread_notification_count
-- Returns accurate unread count for badge presentation
CREATE OR REPLACE FUNCTION public.get_unread_notification_count()
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id TEXT;
  v_count INT;
BEGIN
  v_caller_id := auth.uid()::text;
  IF v_caller_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COUNT(*)::INT INTO v_count
  FROM public.notification_deliveries
  WHERE recipient_id = v_caller_id
    AND status IN ('sent', 'skipped_no_tokens')
    AND read_at IS NULL;

  RETURN COALESCE(v_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.get_unread_notification_count() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_unread_notification_count() TO authenticated;
