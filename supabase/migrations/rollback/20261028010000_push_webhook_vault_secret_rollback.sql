-- DareDrop Rollback Script: Push Webhook Secret Migration
-- File: supabase/migrations/rollback/20261028010000_push_webhook_vault_secret_rollback.sql
--
-- Objective:
-- Restores equivalent push webhook delivery if the primary trigger function needs to be reverted.
--
-- IMPORTANT ARCHITECTURAL CLARIFICATION & PARITY PROOF:
-- This rollback is a VAULT-BACKED FALLBACK RESTORATION, NOT a restoration of the original legacy trigger.
-- Restoring the original legacy trigger would re-introduce the plaintext secret into pg_trigger.tgargs
-- and database backups, which violates the security requirement.
--
-- Parity Matrix with Primary Function:
-- 1. Webhook Payload: 100% Identical (contains old_record, record, type, table, schema).
-- 2. Dispatch Target & Timeout: 100% Identical (dispatches async HTTP POST via pg_net with 5000ms timeout).
-- 3. Telemetry: 100% Identical (records request_id in supabase_functions.hooks).
-- 4. Error Isolation: 100% Identical (catches dispatch and telemetry errors, logging secret-free SQLSTATE/SQLERRM warnings without failing caller transaction).
-- 5. Security & Privileges: 100% Identical (SECURITY DEFINER, empty search_path, owned by postgres, execute restricted to postgres/service_role).
-- 6. Zero-Secret Guarantee: 100% Identical (trigger definition contains 0 arguments and zero secrets; credentials resolved dynamically from Supabase Vault at runtime).

BEGIN;

-- Step 1: Preflight dependency check on Vault secret
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets
    WHERE name = 'push_webhook_secret'
      AND decrypted_secret IS NOT NULL
      AND pg_catalog.btrim(decrypted_secret) != ''
  ) THEN
    RAISE EXCEPTION 'Rollback preflight failed: "push_webhook_secret" is missing from vault.decrypted_secrets'
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- Step 2: Drop current replacement trigger
DROP TRIGGER IF EXISTS send_push_notification_on_challenge_completion ON public.challenge_completions;

-- Step 3: Install verified fallback trigger function with COMPLETE PARITY
CREATE OR REPLACE FUNCTION public.notify_push_on_challenge_completion_fallback()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_secret text;
  v_payload jsonb;
  v_headers jsonb;
  v_request_id bigint;
  v_url text := 'https://uyglmszjkkfjeckpwpab.supabase.co/functions/v1/send-push-notification';
BEGIN
  -- 1. Dynamically retrieve the secret from Supabase Vault
  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets
  WHERE name = 'push_webhook_secret'
  LIMIT 1;

  IF v_secret IS NULL OR pg_catalog.btrim(v_secret) = '' THEN
    RAISE WARNING 'Push notification fallback aborted: secret "push_webhook_secret" not found in vault.decrypted_secrets';
    RETURN NEW;
  END IF;

  -- 2. Build headers with dynamic secret
  v_headers := pg_catalog.jsonb_build_object(
    'Content-Type', 'application/json',
    'x-webhook-secret', v_secret
  );

  -- 3. Build payload matching Edge Function WebhookPayload interface
  v_payload := pg_catalog.jsonb_build_object(
    'old_record', CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE pg_catalog.to_jsonb(OLD) END,
    'record', pg_catalog.to_jsonb(NEW),
    'type', TG_OP,
    'table', TG_TABLE_NAME,
    'schema', TG_TABLE_SCHEMA
  );

  -- 4. Dispatch async HTTP request via pg_net with observable secret-free error diagnostics
  BEGIN
    SELECT http_post INTO v_request_id
    FROM net.http_post(
      url := v_url,
      body := v_payload,
      params := '{}'::jsonb,
      headers := v_headers,
      timeout_milliseconds := 5000
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Push notification webhook fallback dispatch warning: [SQLSTATE %] %', SQLSTATE, SQLERRM;
    RETURN NEW;
  END;

  -- 5. Record telemetry in supabase_functions.hooks if the table exists
  BEGIN
    INSERT INTO supabase_functions.hooks (hook_table_id, hook_name, request_id)
    VALUES (TG_RELID, TG_NAME, v_request_id);
  EXCEPTION
    WHEN undefined_table THEN
      NULL; -- In environments where supabase_functions.hooks is absent
    WHEN OTHERS THEN
      RAISE WARNING 'Push notification hook fallback telemetry warning: [SQLSTATE %] %', SQLSTATE, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

ALTER FUNCTION public.notify_push_on_challenge_completion_fallback() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.notify_push_on_challenge_completion_fallback() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.notify_push_on_challenge_completion_fallback() TO postgres, service_role;

-- Step 4: Re-bind trigger to fallback function
CREATE TRIGGER send_push_notification_on_challenge_completion
  AFTER INSERT OR UPDATE ON public.challenge_completions
  FOR EACH ROW
  EXECUTE FUNCTION public.notify_push_on_challenge_completion_fallback();

-- Step 5: Clean up the primary function
DROP FUNCTION IF EXISTS public.notify_push_on_challenge_completion();

COMMIT;
