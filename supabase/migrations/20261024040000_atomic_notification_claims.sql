-- DareDrop Push Notifications Concurrency & Fencing Migration
-- File: supabase/migrations/20261024040000_atomic_notification_claims.sql
-- Proposes atomic claim acquisition, fencing tokens, and lease recovery to eliminate duplicate deliveries.
-- NOTE: PROPOSED MIGRATION FOR LOCAL REVIEW ONLY. DO NOT APPLY TO PRODUCTION WITHOUT EXPLICIT AUTHORIZATION.

-- 1. Add claim_token and claimed_at columns to notification_deliveries if not present
ALTER TABLE public.notification_deliveries
  ADD COLUMN IF NOT EXISTS claim_token UUID DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ DEFAULT now();

-- Ensure existing rows have claimed_at aligned with their original created_at
UPDATE public.notification_deliveries
SET claimed_at = created_at
WHERE claimed_at IS NULL OR claimed_at > created_at;

ALTER TABLE public.notification_deliveries
  ALTER COLUMN claim_token SET NOT NULL,
  ALTER COLUMN claimed_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notification_deliveries_claim_lease
  ON public.notification_deliveries (status, claimed_at);

-- 2. Atomic Claim Acquisition RPC Function
-- Exclusively claims an event by idempotency key. Handles:
-- - Initial claim via INSERT
-- - Concurrent contention serialized by row-level FOR UPDATE lock
-- - Crash recovery for expired leases (status = 'claimed' and claimed_at older than lease)
-- - Retry for failed deliveries (status = 'failed')
-- - Idempotency deduplication for already-processed deliveries ('sent', 'skipped_no_tokens', 'already_processed')
CREATE OR REPLACE FUNCTION public.claim_notification_delivery(
  p_idempotency_key TEXT,
  p_completion_id UUID,
  p_event_type TEXT,
  p_recipient_id TEXT,
  p_lease_seconds INT DEFAULT 60,
  p_payload JSONB DEFAULT NULL
)
RETURNS TABLE (
  delivery_id UUID,
  claim_token UUID,
  claim_status TEXT, -- 'claimed', 'already_processed', 'in_progress'
  current_status TEXT,
  tokens_sent INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_delivery public.notification_deliveries%ROWTYPE;
  v_new_token UUID := pg_catalog.gen_random_uuid();
  v_lease_sec INT := GREATEST(COALESCE(p_lease_seconds, 60), 5);
  v_lease INTERVAL := (v_lease_sec || ' seconds')::INTERVAL;
BEGIN
  IF p_idempotency_key IS NULL OR pg_catalog.btrim(p_idempotency_key) = '' THEN
    RAISE EXCEPTION 'Idempotency key is required' USING ERRCODE = '22023';
  END IF;

  -- 1. Attempt initial claim insert
  BEGIN
    INSERT INTO public.notification_deliveries (
      idempotency_key,
      completion_id,
      event_type,
      recipient_id,
      tokens_sent,
      status,
      claim_token,
      claimed_at,
      payload
    ) VALUES (
      pg_catalog.btrim(p_idempotency_key),
      p_completion_id,
      p_event_type,
      p_recipient_id,
      0,
      'claimed',
      v_new_token,
      pg_catalog.now(),
      p_payload
    )
    RETURNING * INTO v_delivery;

    RETURN QUERY SELECT v_delivery.id, v_delivery.claim_token, 'claimed'::TEXT, v_delivery.status, v_delivery.tokens_sent;
    RETURN;
  EXCEPTION WHEN unique_violation THEN
    -- Row already exists: fall through to serialized evaluation
  END;

  -- 2. Serialize concurrent contenders on the existing record with row-level lock
  SELECT * INTO v_delivery
  FROM public.notification_deliveries
  WHERE idempotency_key = pg_catalog.btrim(p_idempotency_key)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery record disappeared unexpectedly' USING ERRCODE = 'P0002';
  END IF;

  -- Case A: Delivery already completed or intentionally skipped
  IF v_delivery.status IN ('sent', 'skipped_no_tokens', 'already_processed') THEN
    RETURN QUERY SELECT v_delivery.id, v_delivery.claim_token, 'already_processed'::TEXT, v_delivery.status, v_delivery.tokens_sent;
    RETURN;
  END IF;

  -- Case B: Currently claimed with active (unexpired) lease
  IF v_delivery.status = 'claimed' AND v_delivery.claimed_at > (pg_catalog.now() - v_lease) THEN
    RETURN QUERY SELECT v_delivery.id, v_delivery.claim_token, 'in_progress'::TEXT, v_delivery.status, v_delivery.tokens_sent;
    RETURN;
  END IF;

  -- Case C: Reclaim expired claim OR retry failed delivery
  -- Generates fresh claim_token (fencing token) and updates claimed_at timestamp atomically
  UPDATE public.notification_deliveries
  SET
    status = 'claimed',
    claim_token = v_new_token,
    claimed_at = pg_catalog.now(),
    payload = COALESCE(p_payload, notification_deliveries.payload),
    error = NULL
  WHERE id = v_delivery.id
  RETURNING * INTO v_delivery;

  RETURN QUERY SELECT v_delivery.id, v_delivery.claim_token, 'claimed'::TEXT, v_delivery.status, v_delivery.tokens_sent;
  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_notification_delivery(TEXT, UUID, TEXT, TEXT, INT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_notification_delivery(TEXT, UUID, TEXT, TEXT, INT, JSONB) TO service_role;

-- 3. Atomic Delivery Completion / Fencing RPC Function
-- Updates terminal delivery state only if caller still holds the active claim_token and delivery is claimed
CREATE OR REPLACE FUNCTION public.complete_notification_delivery(
  p_delivery_id UUID,
  p_claim_token UUID,
  p_status TEXT,
  p_tokens_sent INT DEFAULT 0,
  p_payload JSONB DEFAULT NULL,
  p_error TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_status NOT IN ('sent', 'failed', 'skipped_no_tokens', 'already_processed') THEN
    RAISE EXCEPTION 'Invalid delivery status %', p_status USING ERRCODE = '22023';
  END IF;

  UPDATE public.notification_deliveries
  SET
    status = p_status,
    tokens_sent = COALESCE(p_tokens_sent, 0),
    payload = COALESCE(p_payload, notification_deliveries.payload),
    error = p_error
  WHERE id = p_delivery_id
    AND claim_token = p_claim_token
    AND status = 'claimed';

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_notification_delivery(UUID, UUID, TEXT, INT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_notification_delivery(UUID, UUID, TEXT, INT, JSONB, TEXT) TO service_role;
