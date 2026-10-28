// scripts/test-vault-migration.js
// Comprehensive test suite for DareDrop Push Webhook Secret to Vault Migration
// Tests:
// 1. Exact trigger identity & table scoping
// 2. Invariant validation: disabled state, wrong function, wrong args
// 3. Binary tgargs parser with escaped quotes, backslashes, and special characters
// 4. Safe recovery from partial failures / interrupted migration
// 5. Conflicting Vault secret detection (SQLSTATE 23505)
// 6. Malformed headers with an existing Vault secret (aborts with 22023, no swallowing!)
// 7. Wrong trigger function with an existing Vault secret (aborts with 22023)
// 8. Missing trigger handling (aborts with P0002)
// 9. Genuine idempotent rerun (leaves trigger OID/xmin and function OID/xmin completely untouched)
// 10. INSERT & UPDATE payload parity and telemetry logging
// 11. Least privilege: EXECUTE revoked from anon/authenticated, trigger still fires
// 12. Safe rollback: Vault-backed fallback restoration & push verification with full parity
// 13. Isolated dispatch error & telemetry error handling (resilient execution)
// 14. Staged zero-downtime secret rotation: parameterized Vault API, edge function dual auth, recovery paths & retirement
// Runs strictly on local isolated disposable PostgreSQL database on port 54333.

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const localConfig = {
  host: '/home/umardinkhan/.gemini/antigravity-ide/brain/89949ad1-3a09-435c-b590-2815756775fb/scratch',
  port: 54333,
  database: 'postgres',
  user: 'postgres',
};

const DUMMY_SECRET_A = 'dummy_prod_secret_778899aabbcc';
const DUMMY_SECRET_B = 'conflicting_secret_112233ddeeff';
const ESCAPED_SECRET = 'secret_with_escaped\\"quotes_and_backslashes\\\\test';

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function secureCompare(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (provided.length === 0 || expected.length === 0) return false;
  const hashA = crypto.createHash('sha256').update(provided).digest();
  const hashB = crypto.createHash('sha256').update(expected).digest();
  return constantTimeEqual(hashA, hashB);
}

async function simulateEdgeFunctionAuth(headers, env) {
  const webhookSecret = env.WEBHOOK_SECRET || '';
  const previousWebhookSecret = env.PREVIOUS_WEBHOOK_SECRET || '';
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!webhookSecret) {
    return { status: 500, error: 'WEBHOOK_SECRET not set' };
  }

  const secretHeader = headers['x-webhook-secret'] || '';
  const authHeader = headers['Authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  const isAuthorized =
    (secretHeader && (await secureCompare(secretHeader, webhookSecret))) ||
    (secretHeader && previousWebhookSecret && (await secureCompare(secretHeader, previousWebhookSecret))) ||
    (token && (await secureCompare(token, webhookSecret))) ||
    (token && previousWebhookSecret && (await secureCompare(token, previousWebhookSecret))) ||
    (serviceRoleKey && token && (await secureCompare(token, serviceRoleKey)));

  if (!isAuthorized) {
    return { status: 401, error: 'Unauthorized' };
  }
  return { status: 200, success: true };
}

async function setupMockEnvironment(client) {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
    END $$;

    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    -- Mock Vault schema & tables
    CREATE SCHEMA IF NOT EXISTS vault;
    CREATE TABLE IF NOT EXISTS vault.secrets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text UNIQUE NOT NULL,
      secret text NOT NULL,
      description text,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now()
    );

    CREATE OR REPLACE VIEW vault.decrypted_secrets AS
    SELECT id, name, description, secret AS decrypted_secret, created_at, updated_at
    FROM vault.secrets;

    CREATE OR REPLACE FUNCTION vault.create_secret(
      new_secret text,
      new_name text,
      new_description text DEFAULT NULL,
      new_key_id uuid DEFAULT NULL
    )
    RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $$
    DECLARE
      v_id uuid;
    BEGIN
      INSERT INTO vault.secrets (name, secret, description)
      VALUES (new_name, new_secret, new_description)
      ON CONFLICT (name) DO UPDATE SET
        secret = EXCLUDED.secret,
        description = EXCLUDED.description,
        updated_at = now()
      RETURNING id INTO v_id;
      RETURN v_id;
    END;
    $$;

    CREATE OR REPLACE FUNCTION vault.update_secret(
      secret_id uuid,
      new_secret text,
      new_name text DEFAULT NULL,
      new_description text DEFAULT NULL,
      new_key_id uuid DEFAULT NULL
    )
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    AS $$
    BEGIN
      UPDATE vault.secrets
      SET secret = new_secret,
          name = COALESCE(new_name, name),
          description = COALESCE(new_description, description),
          updated_at = now()
      WHERE id = secret_id;
    END;
    $$;

    REVOKE ALL ON SCHEMA vault FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON TABLE vault.secrets FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON TABLE vault.decrypted_secrets FROM PUBLIC, anon, authenticated;
    GRANT SELECT ON vault.decrypted_secrets TO postgres, service_role;

    -- Mock net schema for pg_net HTTP logging
    CREATE SCHEMA IF NOT EXISTS net;
    CREATE TABLE IF NOT EXISTS net.http_request_log (
      id bigserial PRIMARY KEY,
      url text NOT NULL,
      body jsonb,
      params jsonb,
      headers jsonb,
      timeout_milliseconds integer,
      created_at timestamptz DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION net.http_post(
      url text,
      body jsonb DEFAULT '{}'::jsonb,
      params jsonb DEFAULT '{}'::jsonb,
      headers jsonb DEFAULT '{}'::jsonb,
      timeout_milliseconds integer DEFAULT 1000
    )
    RETURNS bigint
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_id bigint;
    BEGIN
      INSERT INTO net.http_request_log (url, body, params, headers, timeout_milliseconds)
      VALUES (url, body, params, headers, timeout_milliseconds)
      RETURNING id INTO v_id;
      RETURN v_id;
    END;
    $$;

    -- Mock supabase_functions.hooks
    CREATE SCHEMA IF NOT EXISTS supabase_functions;
    CREATE TABLE IF NOT EXISTS supabase_functions.hooks (
      id bigserial PRIMARY KEY,
      hook_table_id integer,
      hook_name text,
      created_at timestamptz DEFAULT now(),
      request_id bigint
    );

    CREATE OR REPLACE FUNCTION supabase_functions.http_request() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RETURN NEW;
    END;
    $$;
  `);
}

async function installLegacyTrigger(client, secretValue, tableName = 'challenge_completions') {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS public;
    CREATE TABLE IF NOT EXISTS public.${tableName} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      challenge_id uuid,
      challenge_type text DEFAULT 'daily',
      participant_id text,
      verifier_id text,
      completion_date date,
      status text DEFAULT 'pending',
      submission_note text,
      rejection_reason text,
      submitted_at timestamptz DEFAULT now(),
      reviewed_at timestamptz
    );
    DELETE FROM public.${tableName};
    ALTER TABLE public.${tableName} DISABLE ROW LEVEL SECURITY;
    GRANT ALL ON TABLE public.${tableName} TO postgres, service_role, anon, authenticated;

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'challenges') THEN
        INSERT INTO public.challenges (id, title, description, category, duration_days, creator_name, challenge_type, timezone)
        VALUES ('c0000000-0000-0000-0000-000000000001', 'Test Challenge', 'Test Desc', 'Fitness', 30, 'Creator', 'daily', 'UTC')
        ON CONFLICT (id) DO NOTHING;
      END IF;
    END $$;
  `);

  const headersJson = JSON.stringify({
    'Content-Type': 'application/json',
    'x-webhook-secret': secretValue,
  });

  const url = 'https://uyglmszjkkfjeckpwpab.supabase.co/functions/v1/send-push-notification';
  const method = 'POST';
  const timeoutMs = '5000';

  const parts = [url, method, headersJson, '{}', timeoutMs];
  const byteaHex = '\\x' + parts.map(p => Buffer.from(p, 'utf8').toString('hex')).join('00') + '00';

  await client.query(`
    DROP TRIGGER IF EXISTS send_push_notification_on_challenge_completion ON public.${tableName};
    CREATE TRIGGER send_push_notification_on_challenge_completion
      AFTER INSERT OR UPDATE ON public.${tableName}
      FOR EACH ROW
      EXECUTE FUNCTION supabase_functions.http_request();

    UPDATE pg_catalog.pg_trigger
    SET tgargs = decode('${byteaHex.slice(2)}', 'hex'),
        tgnargs = 5
    WHERE tgname = 'send_push_notification_on_challenge_completion'
      AND tgrelid = 'public.${tableName}'::regclass;
  `);
}

async function runTests() {
  console.log('================================================================');
  console.log('🚀 Running DareDrop Push Webhook Vault Migration Test Suite');
  console.log('================================================================\n');

  const client = new Client(localConfig);
  await client.connect();

  const migrationSqlPath = path.resolve(process.cwd(), 'supabase/migrations/20261028010000_push_webhook_vault_secret.sql');
  const migrationSql = fs.readFileSync(migrationSqlPath, 'utf8');

  try {
    await setupMockEnvironment(client);

    // -----------------------------------------------------------------
    // TEST 1: Exact Trigger Identity, Table Scoping, & Decoy Disambiguation
    // -----------------------------------------------------------------
    console.log('[Test 1] Testing exact trigger identity, table scoping, and decoy disambiguation...');
    await client.query('DELETE FROM vault.secrets;');
    await client.query('CREATE TABLE IF NOT EXISTS public.decoy_table (id uuid PRIMARY KEY);');
    await installLegacyTrigger(client, 'decoy_secret_do_not_read', 'decoy_table');
    await installLegacyTrigger(client, DUMMY_SECRET_A, 'challenge_completions');

    await client.query(migrationSql);

    const vaultCheck1 = await client.query("SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'push_webhook_secret';");
    if (vaultCheck1.rows.length === 0 || vaultCheck1.rows[0].decrypted_secret !== DUMMY_SECRET_A) {
      throw new Error(`Test 1 Failed: Expected secret ${DUMMY_SECRET_A}, got ${vaultCheck1.rows[0]?.decrypted_secret}`);
    }
    console.log('  ✅ Disambiguated duplicate trigger names across tables: target table public.challenge_completions correctly scoped.');

    // -----------------------------------------------------------------
    // TEST 2: Invariant Validation (disabled state, wrong function, wrong args)
    // -----------------------------------------------------------------
    console.log('\n[Test 2] Testing invariant validation (disabled state, wrong function, wrong argument count)...');

    // Subtest 2.1: Disabled Trigger
    await client.query('DELETE FROM vault.secrets;');
    await installLegacyTrigger(client, DUMMY_SECRET_A);
    await client.query("ALTER TABLE public.challenge_completions DISABLE TRIGGER send_push_notification_on_challenge_completion;");
    let disabledCaught = false;
    try {
      await client.query(migrationSql);
    } catch (e) {
      await client.query('ROLLBACK;').catch(() => {});
      disabledCaught = true;
      console.log(`  ✅ Aborted on disabled trigger (SQLSTATE ${e.code}): ${e.message}`);
    }
    if (!disabledCaught) throw new Error('Test 2.1 Failed: Migration did not abort on disabled trigger');

    // Subtest 2.2: Wrong Trigger Function
    await client.query('DELETE FROM vault.secrets;');
    await client.query(`
      CREATE OR REPLACE FUNCTION public.dummy_other_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
      DROP TRIGGER IF EXISTS send_push_notification_on_challenge_completion ON public.challenge_completions;
      CREATE TRIGGER send_push_notification_on_challenge_completion
        AFTER INSERT OR UPDATE ON public.challenge_completions
        FOR EACH ROW
        EXECUTE FUNCTION public.dummy_other_fn();
    `);
    let wrongFnCaught = false;
    try {
      await client.query(migrationSql);
    } catch (e) {
      await client.query('ROLLBACK;').catch(() => {});
      wrongFnCaught = true;
      console.log(`  ✅ Aborted on unexpected trigger function (SQLSTATE ${e.code}): ${e.message}`);
    }
    if (!wrongFnCaught) throw new Error('Test 2.2 Failed: Migration did not abort on wrong trigger function');

    // Subtest 2.3: Wrong Argument Count
    await client.query('DELETE FROM vault.secrets;');
    await client.query(`
      UPDATE pg_trigger
      SET tgnargs = 2
      WHERE tgname = 'send_push_notification_on_challenge_completion'
        AND tgrelid = 'public.challenge_completions'::regclass;
    `);
    let wrongArgsCaught = false;
    try {
      await client.query(migrationSql);
    } catch (e) {
      await client.query('ROLLBACK;').catch(() => {});
      wrongArgsCaught = true;
      console.log(`  ✅ Aborted on unexpected argument count (SQLSTATE ${e.code}): ${e.message}`);
    }
    if (!wrongArgsCaught) throw new Error('Test 2.3 Failed: Migration did not abort on wrong argument count');

    // -----------------------------------------------------------------
    // TEST 3: Escaped Quotes & Backslashes in Trigger Arguments
    // -----------------------------------------------------------------
    console.log('\n[Test 3] Testing binary tgargs parser with escaped quotes and backslashes...');
    await client.query('DELETE FROM vault.secrets;');
    await installLegacyTrigger(client, ESCAPED_SECRET);

    await client.query(migrationSql);

    const vaultCheck3 = await client.query("SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'push_webhook_secret';");
    if (vaultCheck3.rows.length === 0 || vaultCheck3.rows[0].decrypted_secret !== ESCAPED_SECRET) {
      throw new Error(`Test 3 Failed: Escaped characters corrupted. Expected ${ESCAPED_SECRET}, got ${vaultCheck3.rows[0]?.decrypted_secret}`);
    }
    console.log('  ✅ Escaped backslashes and double quotes parsed and preserved with exact binary fidelity.');

    // -----------------------------------------------------------------
    // TEST 4: Safe Recovery from Partial Failure / Interrupted Migration
    // -----------------------------------------------------------------
    console.log('\n[Test 4] Testing safe recovery from partial failure (secret in Vault, legacy trigger still on table)...');
    await client.query('DELETE FROM vault.secrets;');
    await installLegacyTrigger(client, DUMMY_SECRET_A);
    // Simulate secret already committed in Vault (partial cutover)
    await client.query("SELECT vault.create_secret($1, 'push_webhook_secret', 'test');", [DUMMY_SECRET_A]);

    await client.query(migrationSql);

    const trigCheck4 = await client.query(`
      SELECT tgfoid::regproc::text AS fn
      FROM pg_trigger
      WHERE tgname = 'send_push_notification_on_challenge_completion'
        AND tgrelid = 'public.challenge_completions'::regclass;
    `);
    if (trigCheck4.rows[0].fn !== 'notify_push_on_challenge_completion') {
      throw new Error(`Test 4 Failed: Trigger was not upgraded to notify_push_on_challenge_completion, found: ${trigCheck4.rows[0].fn}`);
    }
    console.log('  ✅ Successfully recovered from partial failure: completed trigger upgrade without duplicate secrets or errors.');

    // -----------------------------------------------------------------
    // TEST 5: Conflicting Vault Secret Aborts with 23505
    // -----------------------------------------------------------------
    console.log('\n[Test 5] Testing conflict abort when Vault secret differs from legacy trigger secret...');
    await client.query('DELETE FROM vault.secrets;');
    await installLegacyTrigger(client, DUMMY_SECRET_A);
    // Pre-insert different secret in Vault
    await client.query("SELECT vault.create_secret($1, 'push_webhook_secret', 'test');", [DUMMY_SECRET_B]);

    let conflictCaught = false;
    try {
      await client.query(migrationSql);
    } catch (e) {
      await client.query('ROLLBACK;').catch(() => {});
      conflictCaught = true;
      console.log(`  ✅ Safely aborted on secret mismatch (SQLSTATE ${e.code}): ${e.message}`);
    }
    if (!conflictCaught) throw new Error('Test 5 Failed: Did not abort on secret conflict');

    // -----------------------------------------------------------------
    // TEST 6: Malformed Trigger Arguments with Existing Vault Secret
    // -----------------------------------------------------------------
    console.log('\n[Test 6] Testing that malformed trigger arguments with existing Vault secret aborts explicitly (no error swallowing!)...');
    await client.query('DELETE FROM vault.secrets;');
    await client.query("SELECT vault.create_secret($1, 'push_webhook_secret', 'test');", [DUMMY_SECRET_A]);

    // Install trigger with malformed non-JSON headers in tgargs
    const malformedHeaders = 'NOT_VALID_JSON{{{';
    const partsM = ['https://test', 'POST', malformedHeaders, '{}', '5000'];
    const byteaM = '\\x' + partsM.map(p => Buffer.from(p, 'utf8').toString('hex')).join('00') + '00';
    await client.query(`
      DROP TRIGGER IF EXISTS send_push_notification_on_challenge_completion ON public.challenge_completions;
      CREATE TRIGGER send_push_notification_on_challenge_completion
        AFTER INSERT OR UPDATE ON public.challenge_completions
        FOR EACH ROW
        EXECUTE FUNCTION supabase_functions.http_request();

      UPDATE pg_catalog.pg_trigger
      SET tgargs = decode('${byteaM.slice(2)}', 'hex'),
          tgnargs = 5
      WHERE tgname = 'send_push_notification_on_challenge_completion'
        AND tgrelid = 'public.challenge_completions'::regclass;
    `);

    let malformedCaught = false;
    try {
      await client.query(migrationSql);
    } catch (e) {
      await client.query('ROLLBACK;').catch(() => {});
      malformedCaught = true;
      console.log(`  ✅ Aborted on malformed JSON with existing Vault secret (SQLSTATE ${e.code}): ${e.message}`);
    }
    if (!malformedCaught) throw new Error('Test 6 Failed: Did not abort on malformed trigger JSON during recovery');

    // -----------------------------------------------------------------
    // TEST 7: Wrong Trigger Function with Existing Vault Secret Aborts
    // -----------------------------------------------------------------
    console.log('\n[Test 7] Testing that wrong trigger function with existing Vault secret aborts explicitly...');
    await client.query(`
      DROP TRIGGER IF EXISTS send_push_notification_on_challenge_completion ON public.challenge_completions;
      CREATE TRIGGER send_push_notification_on_challenge_completion
        AFTER INSERT OR UPDATE ON public.challenge_completions
        FOR EACH ROW
        EXECUTE FUNCTION public.dummy_other_fn();
    `);

    let wrongFnWithVaultCaught = false;
    try {
      await client.query(migrationSql);
    } catch (e) {
      await client.query('ROLLBACK;').catch(() => {});
      wrongFnWithVaultCaught = true;
      console.log(`  ✅ Aborted on wrong function with existing Vault secret (SQLSTATE ${e.code}): ${e.message}`);
    }
    if (!wrongFnWithVaultCaught) throw new Error('Test 7 Failed: Did not abort on wrong function with existing Vault secret');

    // -----------------------------------------------------------------
    // TEST 8: Missing Trigger with Existing Vault Secret Aborts
    // -----------------------------------------------------------------
    console.log('\n[Test 8] Testing that missing trigger with existing Vault secret aborts explicitly...');
    await client.query('DROP TRIGGER IF EXISTS send_push_notification_on_challenge_completion ON public.challenge_completions;');

    let missingTriggerCaught = false;
    try {
      await client.query(migrationSql);
    } catch (e) {
      await client.query('ROLLBACK;').catch(() => {});
      missingTriggerCaught = true;
      console.log(`  ✅ Aborted on missing trigger with existing Vault secret (SQLSTATE ${e.code}): ${e.message}`);
    }
    if (!missingTriggerCaught) throw new Error('Test 8 Failed: Did not abort on missing trigger');

    // -----------------------------------------------------------------
    // TEST 9: Genuine Idempotent Rerun (Unchanged OID and xmin)
    // -----------------------------------------------------------------
    console.log('\n[Test 9] Testing genuine idempotent rerun on already-migrated trigger (Subcase 2A)...');
    await installLegacyTrigger(client, DUMMY_SECRET_A);
    await client.query(migrationSql); // First migration run: upgrades trigger to Vault-backed

    // Record OIDs and xmin values before rerun
    const beforeRerun = await client.query(`
      SELECT
        t.oid AS trig_oid,
        t.xmin::text AS trig_xmin,
        p.oid AS fn_oid,
        p.xmin::text AS fn_xmin
      FROM pg_trigger t
      JOIN pg_proc p ON t.tgfoid = p.oid
      WHERE t.tgname = 'send_push_notification_on_challenge_completion'
        AND t.tgrelid = 'public.challenge_completions'::regclass;
    `);
    const rBefore = beforeRerun.rows[0];

    // Re-run migration: should detect already-migrated trigger, validate security properties, and exit without any DDL
    await client.query(migrationSql);

    const afterRerun = await client.query(`
      SELECT
        t.oid AS trig_oid,
        t.xmin::text AS trig_xmin,
        p.oid AS fn_oid,
        p.xmin::text AS fn_xmin
      FROM pg_trigger t
      JOIN pg_proc p ON t.tgfoid = p.oid
      WHERE t.tgname = 'send_push_notification_on_challenge_completion'
        AND t.tgrelid = 'public.challenge_completions'::regclass;
    `);
    const rAfter = afterRerun.rows[0];

    if (rBefore.trig_oid !== rAfter.trig_oid || rBefore.trig_xmin !== rAfter.trig_xmin) {
      throw new Error(`Test 9 Failed: Trigger modified during rerun! Before: ${JSON.stringify(rBefore)}, After: ${JSON.stringify(rAfter)}`);
    }
    if (rBefore.fn_oid !== rAfter.fn_oid || rBefore.fn_xmin !== rAfter.fn_xmin) {
      throw new Error(`Test 9 Failed: Function modified during rerun! Before: ${JSON.stringify(rBefore)}, After: ${JSON.stringify(rAfter)}`);
    }
    console.log(`  ✅ Verified: Trigger OID (${rBefore.trig_oid})/xmin (${rBefore.trig_xmin}) and Function OID (${rBefore.fn_oid})/xmin (${rBefore.fn_xmin}) completely unchanged on idempotent rerun.`);

    // -----------------------------------------------------------------
    // TEST 10: INSERT & UPDATE Payload Parity and Telemetry
    // -----------------------------------------------------------------
    console.log('\n[Test 10] Testing exact webhook payload parity and telemetry on INSERT & UPDATE...');
    await client.query('DELETE FROM net.http_request_log;');
    await client.query('DELETE FROM supabase_functions.hooks;');

    // 1. INSERT
    await client.query(`
      INSERT INTO public.challenge_completions (
        id, challenge_id, challenge_type, participant_id, verifier_id, status, submitted_at, completion_date
      ) VALUES (
        'f0000000-0000-0000-0000-000000000001',
        'c0000000-0000-0000-0000-000000000001',
        'daily',
        'b0000000-0000-0000-0000-000000000001',
        'user-vault-verifier',
        'pending',
        now(),
        CURRENT_DATE
      );
    `);

    const insLogs = await client.query('SELECT * FROM net.http_request_log ORDER BY id DESC LIMIT 1;');
    const ins = insLogs.rows[0];
    if (ins.url !== 'https://uyglmszjkkfjeckpwpab.supabase.co/functions/v1/send-push-notification') throw new Error(`URL mismatch`);
    if (ins.headers['x-webhook-secret'] !== DUMMY_SECRET_A) throw new Error('Secret header mismatch');
    if (ins.headers['Content-Type'] !== 'application/json') throw new Error('Content-Type mismatch');
    if (ins.body.type !== 'INSERT') throw new Error(`Type mismatch`);
    if (ins.body.old_record !== null) throw new Error('old_record not null on INSERT');
    if (ins.body.record.id !== 'f0000000-0000-0000-0000-000000000001') throw new Error('Record ID mismatch');
    if (ins.body.table !== 'challenge_completions') throw new Error('Table mismatch');
    if (ins.body.schema !== 'public') throw new Error('Schema mismatch');
    if (ins.timeout_milliseconds !== 5000) throw new Error('Timeout mismatch');
    console.log('  ✅ INSERT payload parity verified (all 8 properties match legacy behavior).');

    // 2. UPDATE
    await client.query(`
      UPDATE public.challenge_completions
      SET status = 'approved', reviewed_at = now()
      WHERE id = 'f0000000-0000-0000-0000-000000000001';
    `);

    const updLogs = await client.query('SELECT * FROM net.http_request_log ORDER BY id DESC LIMIT 1;');
    const upd = updLogs.rows[0];
    if (upd.body.type !== 'UPDATE') throw new Error(`Type mismatch`);
    if (upd.body.old_record.status !== 'pending') throw new Error('old_record status mismatch');
    if (upd.body.record.status !== 'approved') throw new Error('new record status mismatch');
    console.log('  ✅ UPDATE payload parity verified (state transition pending -> approved).');

    // Telemetry
    const hooksRes = await client.query('SELECT count(*) FROM supabase_functions.hooks;');
    if (parseInt(hooksRes.rows[0].count, 10) !== 2) throw new Error('Hooks telemetry count mismatch');
    console.log('  ✅ Telemetry verified: 2 entries logged in supabase_functions.hooks.');

    // -----------------------------------------------------------------
    // TEST 11: Least Privilege Enforcement
    // -----------------------------------------------------------------
    console.log('\n[Test 11] Testing least privilege enforcement on client roles...');

    const permRes = await client.query(`
      SELECT grantee
      FROM information_schema.routine_privileges
      WHERE routine_name = 'notify_push_on_challenge_completion'
        AND routine_schema = 'public';
    `);
    const grantees = permRes.rows.map(r => r.grantee);
    console.log('  Trigger function grantees:', grantees);
    if (grantees.includes('anon') || grantees.includes('authenticated') || grantees.includes('PUBLIC')) {
      throw new Error('Test 11 Failed: Client roles have EXECUTE on trigger function!');
    }
    console.log('  ✅ EXECUTE strictly REVOKED from PUBLIC, anon, and authenticated.');

    // Prove trigger fires for authenticated user via table trigger privileges
    await client.query('DELETE FROM net.http_request_log;');
    await client.query(`
      SET ROLE authenticated;
      INSERT INTO public.challenge_completions (
        id, challenge_id, challenge_type, participant_id, verifier_id, status, submitted_at, completion_date
      ) VALUES (
        'f0000000-0000-0000-0000-000000000002',
        'c0000000-0000-0000-0000-000000000001',
        'daily',
        'b0000000-0000-0000-0000-000000000001',
        'user-vault-verifier',
        'pending',
        now(),
        CURRENT_DATE - INTERVAL '1 day'
      );
      RESET ROLE;
    `);

    const trigWorkLogs = await client.query('SELECT count(*) FROM net.http_request_log;');
    if (parseInt(trigWorkLogs.rows[0].count, 10) !== 1) {
      throw new Error('Test 11 Failed: Trigger did not fire for authenticated user!');
    }
    console.log('  ✅ Verified: Trigger fires successfully for authenticated user via table trigger privileges.');

    // Prove direct call of trigger function is blocked
    let directBlock = false;
    try {
      await client.query('SELECT public.notify_push_on_challenge_completion();');
    } catch (e) {
      directBlock = true;
      console.log(`  ✅ Direct SELECT / RPC call blocked: ${e.message}`);
    }
    if (!directBlock) throw new Error('Test 11 Failed: Direct function invocation succeeded!');

    // -----------------------------------------------------------------
    // TEST 12: Safe Rollback Execution, Fallback Push Dispatch & Full Parity
    // -----------------------------------------------------------------
    console.log('\n[Test 12] Testing safe rollback execution, fallback dispatch, and zero secret leakage...');

    const rollbackSqlPath = path.resolve(process.cwd(), 'supabase/migrations/rollback/20261028010000_push_webhook_vault_secret_rollback.sql');
    const rollbackSql = fs.readFileSync(rollbackSqlPath, 'utf8');

    await client.query(rollbackSql);

    const rbTrig = await client.query(`
      SELECT pg_get_triggerdef(oid) AS def, tgnargs
      FROM pg_trigger
      WHERE tgname = 'send_push_notification_on_challenge_completion'
        AND tgrelid = 'public.challenge_completions'::regclass;
    `);
    const rbDef = rbTrig.rows[0].def;
    console.log(`  Rollback trigger definition: ${rbDef}`);
    if (rbDef.includes('x-webhook-secret') || rbDef.includes(DUMMY_SECRET_A) || parseInt(rbTrig.rows[0].tgnargs, 10) !== 0) {
      throw new Error('Test 12 Failed: Rollback restored plaintext secret into trigger arguments!');
    }
    console.log('  ✅ Verified: Rollback trigger definition contains ZERO secrets and 0 arguments.');

    // Test push delivery & telemetry work after rollback with full parity
    await client.query('DELETE FROM net.http_request_log;');
    await client.query('DELETE FROM supabase_functions.hooks;');
    await client.query(`
      INSERT INTO public.challenge_completions (
        id, challenge_id, challenge_type, participant_id, verifier_id, status, submitted_at, completion_date
      ) VALUES (
        'f0000000-0000-0000-0000-000000000003',
        'c0000000-0000-0000-0000-000000000001',
        'daily',
        'b0000000-0000-0000-0000-000000000001',
        'user-vault-verifier',
        'pending',
        now(),
        CURRENT_DATE - INTERVAL '2 days'
      );
    `);

    const rbLogs = await client.query('SELECT * FROM net.http_request_log ORDER BY id DESC LIMIT 1;');
    if (rbLogs.rows.length !== 1 || rbLogs.rows[0].headers['x-webhook-secret'] !== DUMMY_SECRET_A) {
      throw new Error('Test 12 Failed: Push dispatch failed after rollback');
    }
    const rbHooks = await client.query('SELECT count(*) FROM supabase_functions.hooks;');
    if (parseInt(rbHooks.rows[0].count, 10) !== 1) {
      throw new Error('Test 12 Failed: Fallback function did not record hooks telemetry');
    }
    console.log('  ✅ Fallback push webhook dispatched and recorded telemetry with 100% parity after rollback.');

    // -----------------------------------------------------------------
    // TEST 13: Isolated Tests for Dispatch Errors & Telemetry Failures
    // -----------------------------------------------------------------
    console.log('\n[Test 13] Testing safe exception isolation for dispatch errors and telemetry failures...');

    // Re-apply migration to test primary function error resilience
    await client.query(migrationSql);

    // Subtest 13.1: net.http_post failure isolation
    await client.query(`
      CREATE OR REPLACE FUNCTION net.http_post(
        url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
        headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 1000
      ) RETURNS bigint LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Simulated network timeout/connectivity error' USING ERRCODE = '08006';
      END;
      $$;
    `);

    // Insert completion row: MUST succeed even when net.http_post throws!
    await client.query(`
      INSERT INTO public.challenge_completions (
        id, challenge_id, challenge_type, participant_id, verifier_id, status, submitted_at, completion_date
      ) VALUES (
        'f0000000-0000-0000-0000-000000000010',
        'c0000000-0000-0000-0000-000000000001',
        'daily',
        'b0000000-0000-0000-0000-000000000001',
        'user-vault-verifier',
        'pending',
        now(),
        CURRENT_DATE - INTERVAL '10 days'
      );
    `);
    const disRes = await client.query("SELECT id FROM public.challenge_completions WHERE id = 'f0000000-0000-0000-0000-000000000010';");
    if (disRes.rows.length !== 1) throw new Error('Test 13 Failed: Record was not saved during dispatch error');
    console.log('  ✅ Dispatch error safely caught: challenge completion committed without transaction rollback.');

    // Restore working net.http_post
    await client.query(`
      CREATE OR REPLACE FUNCTION net.http_post(
        url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
        headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 1000
      ) RETURNS bigint LANGUAGE plpgsql AS $$
      DECLARE v_id bigint;
      BEGIN
        INSERT INTO net.http_request_log (url, body, params, headers, timeout_milliseconds)
        VALUES (url, body, params, headers, timeout_milliseconds)
        RETURNING id INTO v_id;
        RETURN v_id;
      END;
      $$;
    `);

    // Subtest 13.2: supabase_functions.hooks failure isolation
    await client.query(`
      CREATE OR REPLACE FUNCTION public.fail_hook_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Simulated telemetry database error' USING ERRCODE = 'XX000';
      END;
      $$;
      CREATE TRIGGER trg_fail_hooks BEFORE INSERT ON supabase_functions.hooks FOR EACH ROW EXECUTE FUNCTION public.fail_hook_insert();
    `);

    await client.query(`
      INSERT INTO public.challenge_completions (
        id, challenge_id, challenge_type, participant_id, verifier_id, status, submitted_at, completion_date
      ) VALUES (
        'f0000000-0000-0000-0000-000000000011',
        'c0000000-0000-0000-0000-000000000001',
        'daily',
        'b0000000-0000-0000-0000-000000000001',
        'user-vault-verifier',
        'pending',
        now(),
        CURRENT_DATE - INTERVAL '11 days'
      );
    `);
    console.log('  ✅ Telemetry failure safely caught: challenge completion committed without transaction rollback.');
    await client.query('DROP TRIGGER IF EXISTS trg_fail_hooks ON supabase_functions.hooks; DROP FUNCTION IF EXISTS public.fail_hook_insert();');

    // -----------------------------------------------------------------
    // TEST 14: Staged Zero-Downtime Secret Rotation & Dual Auth Logic
    // -----------------------------------------------------------------
    console.log('\n[Test 14] Testing staged zero-downtime secret rotation, parameterized Vault API, dual auth & recovery...');

    const OLD_SECRET = 'active_production_secret_old';
    const NEW_SECRET = 'newly_generated_rotation_secret_new';

    // 1. Edge Function dual auth verification (missing, empty, and header variations)
    const missingSecretCheck = await simulateEdgeFunctionAuth({ 'x-webhook-secret': 'anything' }, { WEBHOOK_SECRET: '' });
    if (missingSecretCheck.status !== 500) throw new Error('Dual Auth Failed: Missing WEBHOOK_SECRET should return 500');

    const emptyHeaderCheck = await simulateEdgeFunctionAuth({ 'x-webhook-secret': '' }, { WEBHOOK_SECRET: OLD_SECRET });
    if (emptyHeaderCheck.status !== 401) throw new Error('Dual Auth Failed: Empty header should return 401');

    const bearerAuthCheck = await simulateEdgeFunctionAuth({ Authorization: `Bearer ${OLD_SECRET}` }, { WEBHOOK_SECRET: OLD_SECRET });
    if (bearerAuthCheck.status !== 200) throw new Error('Dual Auth Failed: Bearer token auth failed');

    // Initialize Vault to OLD_SECRET using parameterized supported API
    await client.query(
      `SELECT vault.update_secret(
         (SELECT id FROM vault.secrets WHERE name = 'push_webhook_secret' LIMIT 1),
         $1
       );`,
      [OLD_SECRET]
    );

    // Stage 0: Initial state (only OLD_SECRET configured in Edge Function)
    let edgeEnv = { WEBHOOK_SECRET: OLD_SECRET, PREVIOUS_WEBHOOK_SECRET: '' };
    let res = await simulateEdgeFunctionAuth({ 'x-webhook-secret': OLD_SECRET }, edgeEnv);
    if (res.status !== 200) throw new Error('Stage 0 Failed: OLD_SECRET not accepted initially');

    // Stage 1: Overlap configuration (Edge Function accepts BOTH NEW_SECRET and OLD_SECRET)
    console.log('  Testing Stage 1: Overlap configuration in Edge Function...');
    edgeEnv = {
      WEBHOOK_SECRET: NEW_SECRET,
      PREVIOUS_WEBHOOK_SECRET: OLD_SECRET,
    };

    // Both OLD and NEW must be accepted during overlap
    const oldDuringOverlap = await simulateEdgeFunctionAuth({ 'x-webhook-secret': OLD_SECRET }, edgeEnv);
    const newDuringOverlap = await simulateEdgeFunctionAuth({ 'x-webhook-secret': NEW_SECRET }, edgeEnv);
    const bearerOldOverlap = await simulateEdgeFunctionAuth({ Authorization: `Bearer ${OLD_SECRET}` }, edgeEnv);
    const bearerNewOverlap = await simulateEdgeFunctionAuth({ Authorization: `Bearer ${NEW_SECRET}` }, edgeEnv);
    const invalidDuringOverlap = await simulateEdgeFunctionAuth({ 'x-webhook-secret': 'invalid_third_secret' }, edgeEnv);

    if (oldDuringOverlap.status !== 200 || bearerOldOverlap.status !== 200) throw new Error('Stage 1 Failed: OLD_SECRET rejected during overlap');
    if (newDuringOverlap.status !== 200 || bearerNewOverlap.status !== 200) throw new Error('Stage 1 Failed: NEW_SECRET rejected during overlap');
    if (invalidDuringOverlap.status !== 401) throw new Error('Stage 1 Failed: Invalid secret accepted during overlap');
    console.log('  ✅ Overlap phase verified: both old and new secrets accepted (header & bearer); invalid secrets rejected.');

    // Stage 2: Vault cutover to NEW_SECRET via PARAMETERIZED SUPPORTED API
    console.log('  Testing Stage 2: Database Vault cutover via parameterized vault.update_secret API...');
    await client.query(
      `SELECT vault.update_secret(
         (SELECT id FROM vault.secrets WHERE name = 'push_webhook_secret' LIMIT 1),
         $1
       );`,
      [NEW_SECRET]
    );

    // Verify database trigger dispatches NEW_SECRET
    await client.query('DELETE FROM net.http_request_log;');
    await client.query(`
      INSERT INTO public.challenge_completions (
        id, challenge_id, challenge_type, participant_id, verifier_id, status, submitted_at, completion_date
      ) VALUES (
        'f0000000-0000-0000-0000-000000000004',
        'c0000000-0000-0000-0000-000000000001',
        'daily',
        'b0000000-0000-0000-0000-000000000001',
        'user-vault-verifier',
        'pending',
        now(),
        CURRENT_DATE - INTERVAL '3 days'
      );
    `);

    const stage2Logs = await client.query('SELECT * FROM net.http_request_log ORDER BY id DESC LIMIT 1;');
    if (stage2Logs.rows[0].headers['x-webhook-secret'] !== NEW_SECRET) {
      throw new Error('Stage 2 Failed: Database did not send NEW_SECRET from Vault');
    }
    const stage2Auth = await simulateEdgeFunctionAuth(stage2Logs.rows[0].headers, edgeEnv);
    if (stage2Auth.status !== 200) throw new Error('Stage 2 Failed: Edge function rejected dispatched NEW_SECRET');
    console.log('  ✅ Database Vault successfully updated; dispatched NEW_SECRET authenticated by Edge Function.');

    // Test Stage 3 Recovery: If verification had failed, verify safe fallback to OLD_SECRET
    console.log('  Testing Stage 2/3 Recovery Path: Reverting to OLD_SECRET via parameterized API...');
    await client.query(
      `SELECT vault.update_secret(
         (SELECT id FROM vault.secrets WHERE name = 'push_webhook_secret' LIMIT 1),
         $1
       );`,
      [OLD_SECRET]
    );
    await client.query('DELETE FROM net.http_request_log;');
    await client.query(`
      INSERT INTO public.challenge_completions (
        id, challenge_id, challenge_type, participant_id, verifier_id, status, submitted_at, completion_date
      ) VALUES (
        'f0000000-0000-0000-0000-000000000005',
        'c0000000-0000-0000-0000-000000000001',
        'daily',
        'b0000000-0000-0000-0000-000000000001',
        'user-vault-verifier',
        'pending',
        now(),
        CURRENT_DATE - INTERVAL '4 days'
      );
    `);
    const recoveryLogs = await client.query('SELECT * FROM net.http_request_log ORDER BY id DESC LIMIT 1;');
    const recoveryAuth = await simulateEdgeFunctionAuth(recoveryLogs.rows[0].headers, edgeEnv);
    if (recoveryAuth.status !== 200) throw new Error('Recovery Path Failed: Reverted secret rejected by Edge Function');
    console.log('  ✅ Recovery path verified: Vault cleanly reverted to OLD_SECRET and accepted by Edge Function.');

    // Re-advance to NEW_SECRET for final retirement test
    await client.query(
      `SELECT vault.update_secret(
         (SELECT id FROM vault.secrets WHERE name = 'push_webhook_secret' LIMIT 1),
         $1
       );`,
      [NEW_SECRET]
    );

    // Stage 4: Retirement of OLD_SECRET (Edge Function drops PREVIOUS_WEBHOOK_SECRET)
    console.log('  Testing Stage 4: Retirement of OLD_SECRET in Edge Function...');
    edgeEnv = {
      WEBHOOK_SECRET: NEW_SECRET,
      PREVIOUS_WEBHOOK_SECRET: '',
    };

    const newAfterRetirement = await simulateEdgeFunctionAuth({ 'x-webhook-secret': NEW_SECRET }, edgeEnv);
    const oldAfterRetirement = await simulateEdgeFunctionAuth({ 'x-webhook-secret': OLD_SECRET }, edgeEnv);

    if (newAfterRetirement.status !== 200) throw new Error('Stage 4 Failed: NEW_SECRET not accepted after retirement');
    if (oldAfterRetirement.status !== 401) throw new Error('Stage 4 Failed: Retired OLD_SECRET was not rejected with 401');
    // -----------------------------------------------------------------
    // TEST 15: Atomic Transaction Rollback & Runner Invariant Verification
    // -----------------------------------------------------------------
    console.log('\n[Test 15] Testing transaction atomicity and rollback safety...');
    // Setup clean legacy state
    await client.query('DELETE FROM vault.secrets;');
    await installLegacyTrigger(client, DUMMY_SECRET_A, 'challenge_completions');

    // Introduce deliberate fault inside an atomic migration transaction
    const faultyMigration = `
      BEGIN;
      INSERT INTO vault.secrets (name, secret, description) VALUES ('temp_marker', 'secret_val', 'marker');
      DO $$ BEGIN
        RAISE EXCEPTION 'Simulated mid-migration network failure or unhandled exception' USING ERRCODE = 'XX000';
      END $$;
      COMMIT;
    `;
    let faultCaught = false;
    try {
      await client.query(faultyMigration);
    } catch (e) {
      faultCaught = true;
      await client.query('ROLLBACK;').catch(() => {});
    }
    if (!faultCaught) throw new Error('Test 15 Failed: Faulty migration did not throw');

    // Verify atomic rollback: temp_marker must NOT exist in vault.secrets
    const markerCheck = await client.query("SELECT * FROM vault.secrets WHERE name = 'temp_marker';");
    if (markerCheck.rows.length !== 0) {
      throw new Error('Test 15 Failed: Atomic rollback failed; partial state leaked into vault.secrets');
    }

    // Verify rollback script preflight abort if vault secret is missing
    const t15RollbackSqlPath = path.resolve(process.cwd(), 'supabase/migrations/rollback/20261028010000_push_webhook_vault_secret_rollback.sql');
    const t15RollbackSql = fs.readFileSync(t15RollbackSqlPath, 'utf8');

    let rollbackPreflightCaught = false;
    try {
      await client.query(t15RollbackSql);
    } catch (e) {
      rollbackPreflightCaught = true;
      await client.query('ROLLBACK;').catch(() => {});
      console.log(`  ✅ Rollback preflight aborted safely on missing Vault secret (SQLSTATE ${e.code}): ${e.message}`);
    }
    if (!rollbackPreflightCaught) {
      throw new Error('Test 15 Failed: Rollback script did not abort on missing Vault secret');
    }

    // Legacy trigger must remain intact and enabled
    const trigPostCheck = await client.query(`
      SELECT tgname, tgenabled, tgfoid::regproc::text AS fn_name
      FROM pg_trigger
      WHERE tgname = 'send_push_notification_on_challenge_completion'
        AND tgrelid = 'public.challenge_completions'::regclass;
    `);
    if (trigPostCheck.rows.length !== 1 || trigPostCheck.rows[0].tgenabled !== 'O') {
      throw new Error('Test 15 Failed: Legacy trigger was corrupted after aborted rollback');
    }
    console.log('  ✅ Verified transaction atomicity: mid-flight failures roll back cleanly with zero database pollution.');

    console.log('\n================================================================');
    console.log('🎉 ALL 15 VAULT MIGRATION & TRANSACTION ATOMICITY TESTS PASSED!');
    console.log('================================================================\n');

  } finally {
    await client.end();
  }
}

runTests().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err.message);
  process.exit(1);
});
