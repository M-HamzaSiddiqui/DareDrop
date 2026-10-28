-- DareDrop Database Migration: Push Webhook Secret to Supabase Vault
-- File: supabase/migrations/20261028010000_push_webhook_vault_secret.sql
--
-- Objective:
-- Reliably and securely transfer the existing push notification webhook secret from
-- the legacy trigger's binary arguments (pg_trigger.tgargs) into Supabase Vault.
-- Replaces the legacy trigger with a dedicated Vault-backed function that resolves
-- credentials dynamically at runtime.
--
-- Security & Operational Guarantees:
-- 1. No plaintext secrets in SQL definitions, migration scripts, logs, or pg_dump archives.
-- 2. Exact trigger identity validation: matches tgname AND tgrelid ('public.challenge_completions'::regclass).
-- 3. Strict state machine handling:
--    - Fresh Migration: validates legacy trigger (http_request, tgenabled='O', tgtype=21, tgnargs=5) and migrates.
--    - Interrupted Migration Recovery: strictly parses legacy args without swallowing errors, verifies matching secret, completes cutover.
--    - Genuine Idempotent Re-run: validates function definition/security properties and trigger configuration, then exits cleanly WITHOUT executing CREATE OR REPLACE, DROP TRIGGER, or CREATE TRIGGER.
--    - Ambiguous / Malformed States: aborts with explicit SQLSTATE errors.
-- 4. Binary argument parsing: splits bytea on E'\\x00'::bytea without regex or formatting dependencies.
-- 5. Atomic Execution: Entire migration wrapped in BEGIN ... COMMIT transaction block.
-- 6. Least privilege: REVOKES EXECUTE from PUBLIC, anon, and authenticated. Only postgres/service_role have EXECUTE.
-- 7. Diagnostic observability: emits secret-free warnings with SQLSTATE/SQLERRM without breaking transactions.

BEGIN;

DO $migration$
DECLARE
  v_args bytea;
  v_trig_foid oid;
  v_trig_type integer;
  v_trig_enabled char;
  v_trig_nargs integer;
  v_pos integer;
  v_part bytea;
  v_idx integer := 0;
  v_headers jsonb;
  v_extracted_secret text := NULL;
  v_existing_vault_secret text := NULL;
  v_fn_owner oid;
  v_fn_secdef boolean;
  v_fn_config text[];
BEGIN
  -- 1. Check if the secret already exists in Supabase Vault
  SELECT decrypted_secret INTO v_existing_vault_secret
  FROM vault.decrypted_secrets
  WHERE name = 'push_webhook_secret'
  LIMIT 1;

  -- 2. Inspect the trigger on public.challenge_completions
  SELECT
    tgargs,
    tgfoid,
    tgtype,
    tgenabled,
    tgnargs
  INTO
    v_args,
    v_trig_foid,
    v_trig_type,
    v_trig_enabled,
    v_trig_nargs
  FROM pg_catalog.pg_trigger
  WHERE tgname = 'send_push_notification_on_challenge_completion'
    AND tgrelid = 'public.challenge_completions'::pg_catalog.regclass
    AND NOT tgisinternal;

  -- ==========================================================================
  -- CASE 1: Secret NOT yet in Vault (Fresh Migration)
  -- ==========================================================================
  IF v_existing_vault_secret IS NULL THEN
    -- In a fresh migration, the legacy trigger MUST exist and be valid
    IF v_args IS NULL THEN
      RAISE EXCEPTION 'Legacy trigger "send_push_notification_on_challenge_completion" not found on table "public.challenge_completions"'
        USING ERRCODE = 'P0002';
    END IF;

    IF v_trig_foid IS DISTINCT FROM to_regproc('supabase_functions.http_request') THEN
      RAISE EXCEPTION 'Unexpected trigger function "%" on legacy trigger; expected "supabase_functions.http_request"', v_trig_foid::pg_catalog.regproc::text
        USING ERRCODE = '22023';
    END IF;

    IF v_trig_enabled != 'O' THEN
      RAISE EXCEPTION 'Legacy trigger is not enabled (tgenabled = "%"); expected "O"', v_trig_enabled
        USING ERRCODE = '22023';
    END IF;

    IF v_trig_type != 21 THEN
      RAISE EXCEPTION 'Unexpected trigger event configuration (tgtype = %); expected 21 (AFTER INSERT OR UPDATE FOR EACH ROW)', v_trig_type
        USING ERRCODE = '22023';
    END IF;

    IF v_trig_nargs != 5 THEN
      RAISE EXCEPTION 'Unexpected trigger argument count (tgnargs = %); expected 5', v_trig_nargs
        USING ERRCODE = '22023';
    END IF;

    -- Parse NUL-separated (0x00) bytea chunks
    WHILE pg_catalog.octet_length(v_args) > 0 LOOP
      v_pos := position(E'\\x00'::bytea in v_args);
      IF v_pos = 0 THEN
        v_part := v_args;
        v_args := E''::bytea;
      ELSE
        v_part := substring(v_args from 1 for v_pos - 1);
        v_args := substring(v_args from v_pos + 1);
      END IF;

      -- TG_ARGV[2] corresponds to the headers JSON string
      IF v_idx = 2 THEN
        BEGIN
          v_headers := pg_catalog.convert_from(v_part, 'UTF8')::jsonb;
          v_extracted_secret := v_headers->>'x-webhook-secret';
        EXCEPTION WHEN OTHERS THEN
          RAISE EXCEPTION 'Failed to parse legacy trigger headers JSON: %', SQLERRM
            USING ERRCODE = '22023';
        END;
        EXIT;
      END IF;
      v_idx := v_idx + 1;
    END LOOP;

    -- Validate extracted secret
    IF v_extracted_secret IS NULL OR pg_catalog.btrim(v_extracted_secret) = '' THEN
      RAISE EXCEPTION 'Could not extract valid "x-webhook-secret" from legacy trigger arguments'
        USING ERRCODE = '22023';
    END IF;

    -- Insert into Supabase Vault
    PERFORM vault.create_secret(
      v_extracted_secret,
      'push_webhook_secret',
      'Webhook authentication secret for Edge Function send-push-notification'
    );

    RAISE NOTICE 'Successfully migrated push webhook secret from legacy trigger arguments into Supabase Vault.';

  -- ==========================================================================
  -- CASE 2: Secret ALREADY exists in Vault (Re-run or Interrupted Migration)
  -- ==========================================================================
  ELSE
    -- Trigger must be present
    IF v_args IS NULL THEN
      RAISE EXCEPTION 'Trigger "send_push_notification_on_challenge_completion" not found on table "public.challenge_completions"'
        USING ERRCODE = 'P0002';
    END IF;

    -- Subcase 2A: Already-migrated Vault-backed trigger (Genuine Idempotent Re-run)
    IF v_trig_foid = to_regproc('public.notify_push_on_challenge_completion') THEN
      IF v_trig_enabled != 'O' THEN
        RAISE EXCEPTION 'Upgraded trigger is not enabled (tgenabled = "%"); expected "O"', v_trig_enabled
          USING ERRCODE = '22023';
      END IF;

      IF v_trig_type != 21 THEN
        RAISE EXCEPTION 'Unexpected upgraded trigger event configuration (tgtype = %); expected 21', v_trig_type
          USING ERRCODE = '22023';
      END IF;

      IF v_trig_nargs != 0 THEN
        RAISE EXCEPTION 'Unexpected upgraded trigger argument count (tgnargs = %); expected 0', v_trig_nargs
          USING ERRCODE = '22023';
      END IF;

      -- Validate function exists in pg_proc and check security properties
      SELECT p.proowner, p.prosecdef, p.proconfig
      INTO v_fn_owner, v_fn_secdef, v_fn_config
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public' AND p.proname = 'notify_push_on_challenge_completion';

      IF v_fn_owner IS NULL THEN
        RAISE EXCEPTION 'Expected trigger function "public.notify_push_on_challenge_completion" not found in pg_proc'
          USING ERRCODE = 'P0002';
      END IF;

      IF NOT v_fn_secdef THEN
        RAISE EXCEPTION 'Trigger function "notify_push_on_challenge_completion" is not SECURITY DEFINER'
          USING ERRCODE = '22023';
      END IF;

      IF v_fn_owner != 'postgres'::pg_catalog.regrole THEN
        RAISE EXCEPTION 'Trigger function "notify_push_on_challenge_completion" is not owned by postgres'
          USING ERRCODE = '22023';
      END IF;

      IF NOT (v_fn_config @> ARRAY['search_path=""'] OR v_fn_config @> ARRAY['search_path=']) THEN
        RAISE EXCEPTION 'Trigger function "notify_push_on_challenge_completion" search_path is not empty'
          USING ERRCODE = '22023';
      END IF;

      RAISE NOTICE 'Migration already applied: function and trigger validated with correct security properties. Exiting without changes.';
      RETURN; -- Pure idempotent exit: does NOT execute CREATE OR REPLACE, DROP TRIGGER, or CREATE TRIGGER!

    -- Subcase 2B: Legacy trigger still active (Recoverable Interrupted Migration)
    ELSIF v_trig_foid = to_regproc('supabase_functions.http_request') THEN
      IF v_trig_enabled != 'O' THEN
        RAISE EXCEPTION 'Legacy trigger is not enabled (tgenabled = "%"); expected "O"', v_trig_enabled
          USING ERRCODE = '22023';
      END IF;

      IF v_trig_type != 21 THEN
        RAISE EXCEPTION 'Unexpected legacy trigger event configuration (tgtype = %); expected 21', v_trig_type
          USING ERRCODE = '22023';
      END IF;

      IF v_trig_nargs != 5 THEN
        RAISE EXCEPTION 'Unexpected legacy trigger argument count (tgnargs = %); expected 5', v_trig_nargs
          USING ERRCODE = '22023';
      END IF;

      -- Parse legacy trigger arguments strictly (DO NOT swallow malformed JSON)
      WHILE pg_catalog.octet_length(v_args) > 0 LOOP
        v_pos := position(E'\\x00'::bytea in v_args);
        IF v_pos = 0 THEN
          v_part := v_args;
          v_args := E''::bytea;
        ELSE
          v_part := substring(v_args from 1 for v_pos - 1);
          v_args := substring(v_args from v_pos + 1);
        END IF;

        IF v_idx = 2 THEN
          BEGIN
            v_headers := pg_catalog.convert_from(v_part, 'UTF8')::jsonb;
            v_extracted_secret := v_headers->>'x-webhook-secret';
          EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'Failed to parse legacy trigger headers JSON during recovery: %', SQLERRM
              USING ERRCODE = '22023';
          END;
          EXIT;
        END IF;
        v_idx := v_idx + 1;
      END LOOP;

      IF v_extracted_secret IS NULL OR pg_catalog.btrim(v_extracted_secret) = '' THEN
        RAISE EXCEPTION 'Could not extract valid "x-webhook-secret" from legacy trigger arguments during recovery'
          USING ERRCODE = '22023';
      END IF;

      -- Strict comparison against existing Vault secret
      IF v_extracted_secret != v_existing_vault_secret THEN
        RAISE EXCEPTION 'Conflict detected: Vault secret "push_webhook_secret" already exists but does not match legacy trigger secret'
          USING ERRCODE = '23505';
      END IF;

      RAISE NOTICE 'Vault secret "push_webhook_secret" verified matching legacy trigger secret; proceeding to complete cutover.';

    -- Subcase 2C: Trigger currently pointing to fallback from prior rollback (Re-migration after rollback)
    ELSIF v_trig_foid = to_regproc('public.notify_push_on_challenge_completion_fallback') THEN
      IF v_trig_enabled != 'O' THEN
        RAISE EXCEPTION 'Fallback trigger is not enabled (tgenabled = "%"); expected "O"', v_trig_enabled
          USING ERRCODE = '22023';
      END IF;

      IF v_trig_type != 21 THEN
        RAISE EXCEPTION 'Unexpected fallback trigger event configuration (tgtype = %); expected 21', v_trig_type
          USING ERRCODE = '22023';
      END IF;

      IF v_trig_nargs != 0 THEN
        RAISE EXCEPTION 'Unexpected fallback trigger argument count (tgnargs = %); expected 0', v_trig_nargs
          USING ERRCODE = '22023';
      END IF;

      RAISE NOTICE 'Trigger currently points to fallback function; upgrading to primary Vault-backed function.';

    -- Subcase 2D: Unknown or unexpected trigger function
    ELSE
      RAISE EXCEPTION 'Unknown or unexpected trigger function "%" on "public.challenge_completions"', v_trig_foid::pg_catalog.regproc::text
        USING ERRCODE = '22023';
    END IF;
  END IF;

  -- 3. Preflight assertion: ensure Vault lookup succeeds before proceeding to trigger replacement
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets
    WHERE name = 'push_webhook_secret' AND decrypted_secret IS NOT NULL AND pg_catalog.btrim(decrypted_secret) != ''
  ) THEN
    RAISE EXCEPTION 'Preflight verification failed: "push_webhook_secret" not accessible in vault.decrypted_secrets'
      USING ERRCODE = 'P0001';
  END IF;

  -- 4. Install Dedicated Vault-Backed Trigger Function via Dynamic DDL
  EXECUTE $ddl$
    CREATE OR REPLACE FUNCTION public.notify_push_on_challenge_completion()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = ''
    AS $fn$
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
        RAISE WARNING 'Push notification aborted: secret "push_webhook_secret" not found in vault.decrypted_secrets';
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
        RAISE WARNING 'Push notification webhook dispatch warning: [SQLSTATE %] %', SQLSTATE, SQLERRM;
        RETURN NEW;
      END;

      -- 5. Record telemetry in supabase_functions.hooks if the table exists
      BEGIN
        INSERT INTO supabase_functions.hooks (hook_table_id, hook_name, request_id)
        VALUES (TG_RELID, TG_NAME, v_request_id);
      EXCEPTION
        WHEN undefined_table THEN
          NULL; -- In test environments where supabase_functions.hooks is absent
        WHEN OTHERS THEN
          RAISE WARNING 'Push notification hook telemetry warning: [SQLSTATE %] %', SQLSTATE, SQLERRM;
      END;

      RETURN NEW;
    END;
    $fn$;
  $ddl$;

  -- 5. Hardened Permissions (Least Privilege)
  EXECUTE 'ALTER FUNCTION public.notify_push_on_challenge_completion() OWNER TO postgres;';
  EXECUTE 'REVOKE ALL ON FUNCTION public.notify_push_on_challenge_completion() FROM PUBLIC, anon, authenticated;';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.notify_push_on_challenge_completion() TO postgres, service_role;';

  -- 6. Trigger Replacement
  EXECUTE 'DROP TRIGGER IF EXISTS send_push_notification_on_challenge_completion ON public.challenge_completions;';
  EXECUTE 'CREATE TRIGGER send_push_notification_on_challenge_completion
    AFTER INSERT OR UPDATE ON public.challenge_completions
    FOR EACH ROW
    EXECUTE FUNCTION public.notify_push_on_challenge_completion();';

  RAISE NOTICE 'Trigger "send_push_notification_on_challenge_completion" successfully migrated to Vault-backed function.';
END $migration$;

COMMIT;
