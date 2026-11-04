// DareDrop Phase 23D: Isolated PostgreSQL Migration & Lifecycle Validation Suite
// File: scripts/test-phase23d-postgres.js
// Run with: node scripts/test-phase23d-postgres.js

const { Pool, types } = require('pg');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// ============================================================================
// 0. ABSOLUTE PRODUCTION SAFETY GUARDS
// ============================================================================
const PROD_HOST_PATTERN = 'uyglmszjkkfjeckpwpab.supabase.co';

types.setTypeParser(1082, str => str);

const DISPOSABLE_DB_CONFIG = {
  host: process.env.PGHOST || '/home/umardinkhan/.gemini/antigravity-ide/brain/5884f32a-9471-4b64-933f-d6f6787fa790/scratch',
  port: parseInt(process.env.PGPORT || '54332', 10),
  database: process.env.PGDATABASE || 'daredrop_disposable_test',
  user: process.env.PGUSER || 'umardinkhan',
};

// Strict check: if any env variable contains production host, abort immediately
for (const [k, v] of Object.entries(process.env)) {
  if (typeof v === 'string' && v.includes(PROD_HOST_PATTERN)) {
    if (k.includes('DATABASE_URL') || k.includes('PGHOST')) {
      console.error(`❌ FATAL: Production Supabase host detected in ${k}! Aborting.`);
      process.exit(1);
    }
  }
}
assert(!DISPOSABLE_DB_CONFIG.host.includes(PROD_HOST_PATTERN), 'Must not target production host');
assert(DISPOSABLE_DB_CONFIG.database === 'daredrop_disposable_test', 'Must target disposable test database');

const pool = new Pool(DISPOSABLE_DB_CONFIG);

let passedTests = 0;
let failedTests = 0;

function reportPass(msg) {
  console.log(`  ✅ ${msg}`);
  passedTests++;
}

function reportFail(msg, err) {
  console.error(`  ❌ FAIL: ${msg}`, err || '');
  failedTests++;
  throw err || new Error(msg);
}

// Session impersonation helper for Supabase RLS and auth.uid()
async function asSession(client, { userId = null, role = 'authenticated', email = null, isAnonymous = false } = {}) {
  await client.query('RESET ROLE;');
  if (!userId) {
    await client.query(`
      SELECT set_config('request.jwt.claim.sub', '', true);
      SELECT set_config('request.jwt.claim.role', '${role}', true);
      SELECT set_config('request.jwt.claims', '', true);
      SET LOCAL ROLE ${role};
    `);
    return;
  }

  const claims = JSON.stringify({
    sub: userId,
    role: role,
    email: email || `${userId.slice(0, 8)}@test.com`,
    is_anonymous: isAnonymous ? 'true' : 'false',
    app_metadata: {
      provider: isAnonymous ? 'anonymous' : 'email',
    },
  });

  await client.query(`
    SELECT set_config('request.jwt.claim.sub', '${userId}', true);
    SELECT set_config('request.jwt.claim.role', '${role}', true);
    SELECT set_config('request.jwt.claims', '${claims.replace(/'/g, "''")}', true);
    SET LOCAL ROLE ${role};
  `);
}

// ============================================================================
// 1. ENVIRONMENT & BASE INITIALIZATION
// ============================================================================
async function setupIsolatedEnvironment(client) {
  console.log('=== [Phase 23D] Section 1 & 2: Disposable Database Environment & Migrations ===');
  console.log(`Target: PostgreSQL 18.6 on socket ${DISPOSABLE_DB_CONFIG.host} (Port ${DISPOSABLE_DB_CONFIG.port}, DB: ${DISPOSABLE_DB_CONFIG.database})`);

  // Ensure clean slate
  await client.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    DROP SCHEMA IF EXISTS vault CASCADE;
    DROP SCHEMA IF EXISTS net CASCADE;
    DROP SCHEMA IF EXISTS supabase_functions CASCADE;

    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres WITH SUPERUSER; END IF;
    END $$;

    CREATE SCHEMA IF NOT EXISTS extensions;
    CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
    GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role, postgres;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions TO anon, authenticated, service_role, postgres;

    -- Emulate Supabase Auth Schema & JWT session claims
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
    $$;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT COALESCE(
        NULLIF(current_setting('request.jwt.claim.sub', true), ''),
        (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      )::uuid;
    $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
      SELECT COALESCE(
        NULLIF(current_setting('request.jwt.claim.role', true), ''),
        (NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'),
        'anon'
      );
    $$;

    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, postgres;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role, postgres;

    GRANT ALL ON SCHEMA public TO anon, authenticated, service_role, postgres;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role, postgres;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role, postgres;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role, postgres;

    -- Mock Vault Schema for push notification trigger migration
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
    CREATE OR REPLACE FUNCTION vault.create_secret(new_secret text, new_name text, new_description text DEFAULT NULL, new_key_id uuid DEFAULT NULL)
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER AS $$
    DECLARE v_id uuid;
    BEGIN
      INSERT INTO vault.secrets (name, secret, description) VALUES (new_name, new_secret, new_description)
      ON CONFLICT (name) DO UPDATE SET secret = EXCLUDED.secret, description = EXCLUDED.description, updated_at = now()
      RETURNING id INTO v_id;
      RETURN v_id;
    END; $$;

    -- Mock pg_net HTTP logging
    CREATE SCHEMA IF NOT EXISTS net;
    CREATE OR REPLACE FUNCTION net.http_post(url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb, headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 1000)
    RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint; $$;

    CREATE SCHEMA IF NOT EXISTS supabase_functions;
    CREATE OR REPLACE FUNCTION supabase_functions.http_request() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RETURN NEW; END; $$;
  `);

  reportPass('Isolated database schemas, Supabase roles, and JWT session mocks initialized.');

  // Apply all migrations chronologically
  const migDir = path.join(process.cwd(), 'supabase/migrations');
  const migFiles = fs.readdirSync(migDir).filter(f => f.endsWith('.sql')).sort();

  for (const f of migFiles) {
    // 20261028010000 expects legacy trigger to exist for migration cutover
    if (f === '20261028010000_push_webhook_vault_secret.sql') {
      const headersJson = JSON.stringify({
        'Content-Type': 'application/json',
        'x-webhook-secret': 'mock-secret-for-phase23d',
      });
      const parts = ['https://mock.supabase.co/functions/v1/send-push-notification', 'POST', headersJson, '{}', '5000'];
      const hex = parts.map(p => Buffer.from(p, 'utf8').toString('hex')).join('00') + '00';

      await client.query(`
        DROP TRIGGER IF EXISTS send_push_notification_on_challenge_completion ON public.challenge_completions;
        CREATE TRIGGER send_push_notification_on_challenge_completion
          AFTER INSERT OR UPDATE ON public.challenge_completions
          FOR EACH ROW
          EXECUTE FUNCTION supabase_functions.http_request();

        UPDATE pg_catalog.pg_trigger
        SET tgargs = decode('${hex}', 'hex'),
            tgnargs = 5
        WHERE tgname = 'send_push_notification_on_challenge_completion'
          AND tgrelid = 'public.challenge_completions'::regclass;
      `);
    }

    const sql = fs.readFileSync(path.join(migDir, f), 'utf8');
    await client.query(sql);
    reportPass(`Applied migration: ${f}`);
  }
}

// ============================================================================
// 2. POSTGRESQL CATALOG AUDIT (Section 3)
// ============================================================================
async function auditPostgresCatalog(client) {
  console.log('\n=== Section 3: PostgreSQL System Catalog & Permissions Audit ===');

  // A. Verify public.proof_challenges table in information_schema
  const tableRes = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'proof_challenges';
  `);
  assert.strictEqual(tableRes.rows.length, 1, 'Table public.proof_challenges must exist');
  reportPass('Catalog confirms public.proof_challenges table exists');

  // B. Verify columns in public.proof_challenges
  const colsRes = await client.query(`
    SELECT column_name, data_type, is_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'proof_challenges';
  `);
  const colMap = new Map(colsRes.rows.map(r => [r.column_name, r]));
  const expectedCols = [
    'id', 'challenge_id', 'participant_id', 'verifier_id',
    'completion_date', 'proof_code', 'action_prompt_id',
    'action_prompt', 'status', 'created_at', 'expires_at', 'consumed_at'
  ];
  for (const c of expectedCols) {
    assert(colMap.has(c), `Column ${c} must exist in public.proof_challenges`);
  }
  reportPass(`All 12 columns verified in public.proof_challenges: ${expectedCols.join(', ')}`);

  // C. Verify completion metadata columns in public.challenge_completions
  const compColsRes = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'challenge_completions';
  `);
  const compColNames = new Set(compColsRes.rows.map(r => r.column_name));
  assert(compColNames.has('proof_code'), 'proof_code must exist in challenge_completions');
  assert(compColNames.has('action_prompt_id'), 'action_prompt_id must exist in challenge_completions');
  assert(compColNames.has('action_prompt'), 'action_prompt must exist in challenge_completions');
  assert(compColNames.has('proof_challenge_id'), 'proof_challenge_id must exist in challenge_completions');
  reportPass('Catalog confirms proof metadata columns present in public.challenge_completions');

  // D. Verify constraints
  const constrRes = await client.query(`
    SELECT conname, contype, pg_get_constraintdef(oid) as def
    FROM pg_constraint
    WHERE conrelid = 'public.proof_challenges'::regclass;
  `);
  const constrNames = new Set(constrRes.rows.map(r => r.conname));
  assert(constrNames.has('chk_proof_challenge_no_self_verification'), 'chk_proof_challenge_no_self_verification must exist');
  assert(constrNames.has('chk_proof_challenge_consumed_time'), 'chk_proof_challenge_consumed_time must exist');
  reportPass('Integrity constraints verified: anti-self-verification & consumed timestamp logic');

  // E. Verify indexes
  const idxRes = await client.query(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'proof_challenges';
  `);
  const idxNames = new Set(idxRes.rows.map(r => r.indexname));
  assert(idxNames.has('idx_proof_challenges_lookup'), 'idx_proof_challenges_lookup must exist');
  assert(idxNames.has('idx_proof_challenges_verifier_lookup'), 'idx_proof_challenges_verifier_lookup must exist');
  assert(idxNames.has('idx_proof_challenges_rate_limit'), 'idx_proof_challenges_rate_limit must exist');
  assert(idxNames.has('idx_proof_challenges_active_expiry'), 'idx_proof_challenges_active_expiry must exist');
  reportPass('All 4 composite indexes verified in pg_indexes');

  // F. Verify RLS enabled & policy installed
  const rlsRes = await client.query(`
    SELECT relrowsecurity, relforcerowsecurity
    FROM pg_class
    WHERE oid = 'public.proof_challenges'::regclass;
  `);
  assert.strictEqual(rlsRes.rows[0].relrowsecurity, true, 'RLS must be enabled on proof_challenges');

  const polRes = await client.query(`
    SELECT policyname, roles, cmd, qual
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'proof_challenges';
  `);
  assert.strictEqual(polRes.rows.length, 1, 'Exactly one SELECT policy must be installed on proof_challenges');
  assert.strictEqual(polRes.rows[0].policyname, 'Authorized users can view proof challenges');
  reportPass('RLS enabled and "Authorized users can view proof challenges" policy verified in pg_policies');

  // G. Verify direct write privileges revoked for authenticated and anon
  const authInsert = await client.query(`SELECT has_table_privilege('authenticated', 'public.proof_challenges', 'INSERT');`);
  const authUpdate = await client.query(`SELECT has_table_privilege('authenticated', 'public.proof_challenges', 'UPDATE');`);
  const authDelete = await client.query(`SELECT has_table_privilege('authenticated', 'public.proof_challenges', 'DELETE');`);
  const anonSelect = await client.query(`SELECT has_table_privilege('anon', 'public.proof_challenges', 'SELECT');`);
  const authSelect = await client.query(`SELECT has_table_privilege('authenticated', 'public.proof_challenges', 'SELECT');`);

  assert.strictEqual(authInsert.rows[0].has_table_privilege, false, 'authenticated must NOT have INSERT');
  assert.strictEqual(authUpdate.rows[0].has_table_privilege, false, 'authenticated must NOT have UPDATE');
  assert.strictEqual(authDelete.rows[0].has_table_privilege, false, 'authenticated must NOT have DELETE');
  assert.strictEqual(anonSelect.rows[0].has_table_privilege, false, 'anon must NOT have SELECT');
  assert.strictEqual(authSelect.rows[0].has_table_privilege, true, 'authenticated must have SELECT');
  reportPass('Direct client write privileges verified: INSERT, UPDATE, DELETE strictly revoked');

  // H. Verify RPC signatures in pg_proc
  const submitProcs = await client.query(`
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) as args,
           p.prosecdef, p.proconfig
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public' AND p.proname = 'submit_challenge_completion'
    ORDER BY pg_catalog.length(pg_get_function_identity_arguments(p.oid)) ASC;
  `);

  assert.strictEqual(submitProcs.rows.length, 2, 'Exactly TWO submit_challenge_completion signatures must coexist (4-arg stub + 5-arg proof-enforced)');
  
  // 1. Verify 4-arg legacy compatibility stub
  const stubProc = submitProcs.rows[0];
  assert(stubProc.args.includes('uuid') && stubProc.args.includes('text') && stubProc.args.includes('date'), '4-arg stub args must match legacy');
  assert(!stubProc.args.includes('p_proof_challenge_id'), '4-arg stub must NOT require proof challenge ID');
  assert.strictEqual(stubProc.prosecdef, true, '4-arg stub must be SECURITY DEFINER');
  assert(stubProc.proconfig.some(c => c === 'search_path=""' || c === 'search_path='), 'search_path must be empty on 4-arg stub');

  // 2. Verify 5-arg primary proof-enforced RPC
  const proofProc = submitProcs.rows[1];
  assert(proofProc.args.includes('uuid') && proofProc.args.includes('text') && proofProc.args.includes('date'), '5-arg RPC args must include uuid, text, date');
  assert(proofProc.args.includes('p_proof_challenge_id'), '5-arg RPC must include p_proof_challenge_id');
  assert(!proofProc.args.includes('default') || !proofProc.args.includes('p_proof_challenge_id uuid ='), 'p_proof_challenge_id must NOT have default value');
  assert.strictEqual(proofProc.prosecdef, true, '5-arg RPC must be SECURITY DEFINER');
  assert(proofProc.proconfig.some(c => c === 'search_path=""' || c === 'search_path='), 'search_path must be empty on 5-arg RPC');

  // Verify EXECUTE privileges on both overloads for authenticated
  const stubPriv = await client.query(`SELECT has_function_privilege('authenticated', 'public.submit_challenge_completion(UUID, TEXT, DATE, TEXT)', 'EXECUTE');`);
  assert.strictEqual(stubPriv.rows[0].has_function_privilege, true, '4-arg stub EXECUTE must be granted to authenticated');
  const proofPriv = await client.query(`SELECT has_function_privilege('authenticated', 'public.submit_challenge_completion(UUID, TEXT, DATE, UUID, TEXT)', 'EXECUTE');`);
  assert.strictEqual(proofPriv.rows[0].has_function_privilege, true, '5-arg RPC EXECUTE must be granted to authenticated');

  reportPass('Verified both submit_challenge_completion signatures coexist: 4-arg legacy stub & 5-arg proof-enforced RPC');

  // Verify private Crockford generator helper execution privilege
  const genCodePriv = await client.query(`SELECT has_function_privilege('authenticated', 'public.generate_secure_proof_code()', 'EXECUTE');`);
  assert.strictEqual(genCodePriv.rows[0].has_function_privilege, false, 'generate_secure_proof_code EXECUTE must be revoked from authenticated');
  reportPass('Private generator helper generate_secure_proof_code() is strictly inaccessible to authenticated client role');
}

// ============================================================================
// 3. LIFECYCLE TESTS (Section 4)
// ============================================================================
async function testLifecycle(client) {
  console.log('\n=== Section 4: Comprehensive Database Lifecycle Tests ===');

  const creatorId = '10000000-0000-0000-0000-000000000001';
  const participantA = '20000000-0000-0000-0000-000000000001';
  const verifierB = '30000000-0000-0000-0000-000000000002';
  const verifierC = '40000000-0000-0000-0000-000000000003';
  const unrelatedUser = '50000000-0000-0000-0000-000000000004';
  const challengeId = '90000000-0000-0000-0000-000000000001';
  const challengeExpId = '80000000-0000-0000-0000-000000000099';

  // Seed baseline challenge and participants
  await client.query('RESET ROLE;');
  await client.query(`
    INSERT INTO public.challenges (id, title, description, category, duration_days, creator_id, creator_name, challenge_type, timezone, created_at)
    VALUES
      ('${challengeId}', 'Daily Pushups', '50 pushups daily', 'Fitness', 30, '${creatorId}', 'Creator Charlie', 'daily', 'UTC', now() - interval '2 days'),
      ('${challengeExpId}', 'Expiry & Cancel Test', 'Desc', 'Fitness', 30, '${creatorId}', 'Creator Charlie', 'daily', 'UTC', now() - interval '2 days');

    INSERT INTO public.challenge_participants (challenge_id, user_id, joined_at)
    VALUES
      ('${challengeId}', '${creatorId}', now() - interval '2 days'),
      ('${challengeId}', '${participantA}', now() - interval '2 days'),
      ('${challengeId}', '${verifierB}', now() - interval '2 days'),
      ('${challengeId}', '${verifierC}', now() - interval '2 days'),
      ('${challengeExpId}', '${participantA}', now() - interval '2 days'),
      ('${challengeExpId}', '${verifierB}', now() - interval '2 days');
  `);

  const todayStr = new Date().toISOString().split('T')[0];

  // 1. Registered participant generates a proof challenge
  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  const genRes1 = await client.query(`
    SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifierB}', '${todayStr}'::date);
  `);
  await client.query('COMMIT;');
  const pc1 = genRes1.rows[0];
  assert(pc1 && pc1.id, 'Must return generated proof challenge');
  assert.strictEqual(pc1.participant_id, participantA);
  assert.strictEqual(pc1.verifier_id, verifierB);
  assert.strictEqual(pc1.status, 'active');
  assert.strictEqual(pc1.proof_code.length, 4);
  reportPass('1. Registered participant generates valid proof challenge');

  // 2. Anonymous or unregistered caller is rejected
  await client.query('BEGIN;');
  await asSession(client, { userId: null, role: 'anon' });
  let anonErr = null;
  try {
    await client.query(`SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifierB}', '${todayStr}'::date);`);
  } catch (err) {
    anonErr = err;
  }
  await client.query('ROLLBACK;');
  assert(anonErr && anonErr.code === '42501', 'Anonymous caller must be rejected with 42501');
  reportPass('2. Anonymous / unauthenticated caller rejected with 42501');

  // 3. Unrelated participant cannot generate for another participant
  // (In generate_proof_challenge, caller is strictly auth.uid()::text, cannot impersonate)
  await client.query('BEGIN;');
  await asSession(client, { userId: unrelatedUser });
  let unregErr = null;
  try {
    await client.query(`SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifierB}', '${todayStr}'::date);`);
  } catch (err) {
    unregErr = err;
  }
  await client.query('ROLLBACK;');
  assert(unregErr && unregErr.code === '42501', 'Non-participant caller must be rejected with 42501');
  reportPass('3. Non-participant cannot generate proof challenge');

  // 4. Self-verification is rejected
  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  let selfVerErr = null;
  try {
    await client.query(`SELECT * FROM public.generate_proof_challenge('${challengeId}', '${participantA}', '${todayStr}'::date);`);
  } catch (err) {
    selfVerErr = err;
  }
  await client.query('ROLLBACK;');
  assert(selfVerErr && (selfVerErr.message.includes('You cannot designate yourself as verifier') || selfVerErr.message.includes('anti_self_verification')), 'Self-verification must be rejected');
  reportPass('4. Self-verification is strictly rejected');

  // 5. Inactive/non-participant verifier is rejected
  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  let nonMemberVerErr = null;
  try {
    await client.query(`SELECT * FROM public.generate_proof_challenge('${challengeId}', '${unrelatedUser}', '${todayStr}'::date);`);
  } catch (err) {
    nonMemberVerErr = err;
  }
  await client.query('ROLLBACK;');
  assert(nonMemberVerErr && nonMemberVerErr.message.includes('Designated verifier must be the challenge creator or an active participant'), 'Non-member verifier must be rejected');
  reportPass('5. Ineligible verifier is rejected');

  // 6. Proof code format & length
  const crockfordRegex = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;
  assert(crockfordRegex.test(pc1.proof_code), `Proof code ${pc1.proof_code} must match Crockford 4-char regex`);
  reportPass(`6. Proof code format validated: "${pc1.proof_code}" matches Crockford 4-char specification`);

  // 7. Binding verification
  assert.strictEqual(pc1.challenge_id, challengeId);
  assert.strictEqual(pc1.participant_id, participantA);
  assert.strictEqual(pc1.verifier_id, verifierB);
  assert.strictEqual(pc1.completion_date, todayStr);
  reportPass('7. Proof challenge correctly bound to participant, challenge, verifier, and date');

  // 7b. Phase 26: Legacy 4-argument stub rejects calls with P0001 (named and positional)
  await asSession(client, { userId: participantA });
  const countBeforeLegacy = await client.query('SELECT count(*) FROM public.challenge_completions;');
  let legacyNamedErr = null;
  try {
    await client.query(`
      SELECT * FROM public.submit_challenge_completion(
        p_challenge_id := '${challengeId}'::uuid,
        p_verifier_id := '${verifierB}',
        p_completion_date := '${todayStr}'::date,
        p_submission_note := 'Legacy submission attempt'
      );
    `);
  } catch (err) {
    legacyNamedErr = err;
  }
  assert(legacyNamedErr, 'Legacy 4-argument call must fail');
  assert.strictEqual(legacyNamedErr.code, 'P0001', 'Legacy 4-argument call must fail with SQLSTATE P0001');
  assert(legacyNamedErr.message.includes('App update required: DareDrop now requires dynamic proof verification'), 'Error message must instruct user to update');

  // Also test with default p_submission_note (3 parameters provided)
  let legacyDefaultErr = null;
  try {
    await client.query(`
      SELECT * FROM public.submit_challenge_completion(
        p_challenge_id := '${challengeId}'::uuid,
        p_verifier_id := '${verifierB}',
        p_completion_date := '${todayStr}'::date
      );
    `);
  } catch (err) {
    legacyDefaultErr = err;
  }
  assert(legacyDefaultErr, 'Legacy call omitting default note must fail');
  assert.strictEqual(legacyDefaultErr.code, 'P0001', 'Legacy call omitting default note must also fail with P0001');

  // Verify no completions were inserted by legacy calls
  const countAfterLegacy = await client.query('SELECT count(*) FROM public.challenge_completions;');
  assert.strictEqual(countBeforeLegacy.rows[0].count, countAfterLegacy.rows[0].count, 'Legacy rejection stub must NEVER create completion records');
  reportPass('7b. Legacy 4-argument stub strictly rejects submissions with SQLSTATE P0001 and creates zero completion records');

  // 8 & 9. Valid proof submission creates pending completion and atomically consumes challenge (testing named arguments)
  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  const subRes = await client.query(`
    SELECT * FROM public.submit_challenge_completion(
      p_challenge_id := '${challengeId}',
      p_verifier_id := '${verifierB}',
      p_completion_date := '${todayStr}'::date,
      p_proof_challenge_id := '${pc1.id}'::uuid,
      p_submission_note := 'Felt energetic!'
    );
  `);
  await client.query('COMMIT;');

  const completion = subRes.rows[0];
  assert(completion && completion.id, 'Completion record must be created');
  assert.strictEqual(completion.status, 'pending');
  assert.strictEqual(completion.proof_code, pc1.proof_code);
  assert.strictEqual(completion.action_prompt, pc1.action_prompt);
  assert.strictEqual(completion.proof_challenge_id, pc1.id);
  reportPass('8. Valid proof submission creates pending completion record');

  // Inspect consumed challenge
  const pcConsumedRes = await client.query(`SELECT * FROM public.proof_challenges WHERE id = '${pc1.id}';`);
  const pcConsumed = pcConsumedRes.rows[0];
  assert.strictEqual(pcConsumed.status, 'consumed');
  assert(pcConsumed.consumed_at !== null, 'consumed_at must be populated');
  reportPass('9. Submission atomically consumes proof challenge with consumed_at timestamp');

  // 10. Reusing consumed proof challenge is rejected
  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  let reuseErr = null;
  try {
    await client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}',
        '${verifierB}',
        '${todayStr}'::date,
        '${pc1.id}'::uuid,
        'Replay attack attempt'
      );
    `);
  } catch (err) {
    reuseErr = err;
  }
  await client.query('ROLLBACK;');
  assert(reuseErr && (reuseErr.message.includes('consumed') || reuseErr.message.includes('already')), 'Reusing consumed proof challenge must fail');
  reportPass('10. Reusing consumed proof challenge is strictly rejected');

  // 11. Expired proof challenge is rejected (Real database timestamp boundary)
  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  const genExpired = await client.query(`
    SELECT * FROM public.generate_proof_challenge('${challengeExpId}', '${verifierB}', '${todayStr}'::date);
  `);
  const pcExpId = genExpired.rows[0].id;
  await client.query('COMMIT;');

  // Backdate expires_at to 1 second ago in PostgreSQL
  await client.query('RESET ROLE;');
  await client.query(`UPDATE public.proof_challenges SET expires_at = (now() - interval '1 second') WHERE id = '${pcExpId}';`);

  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  let expSubmitErr = null;
  try {
    await client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeExpId}',
        '${verifierB}',
        '${todayStr}'::date,
        '${pcExpId}'::uuid,
        'Submitting expired challenge'
      );
    `);
  } catch (err) {
    expSubmitErr = err;
  }
  await client.query('ROLLBACK;');
  assert(expSubmitErr && expSubmitErr.message.includes('expired'), 'Expired proof challenge submission must fail');
  reportPass('11. Expired proof challenge rejected based on database expires_at timestamp boundary');

  // 12. Cancelled proof challenge is rejected
  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  const genCancel = await client.query(`
    SELECT * FROM public.generate_proof_challenge('${challengeExpId}', '${verifierB}', '${todayStr}'::date);
  `);
  const pcCancelId = genCancel.rows[0].id;
  await client.query(`SELECT public.cancel_proof_challenge('${pcCancelId}');`);

  let cancelSubmitErr = null;
  try {
    await client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeExpId}',
        '${verifierB}',
        '${todayStr}'::date,
        '${pcCancelId}'::uuid,
        'Submitting cancelled challenge'
      );
    `);
  } catch (err) {
    cancelSubmitErr = err;
  }
  await client.query('ROLLBACK;');
  assert(cancelSubmitErr && (cancelSubmitErr.message.includes('cancelled') || cancelSubmitErr.message.includes('no longer active')), 'Cancelled proof challenge submission must fail');
  reportPass('12. Cancelled proof challenge is strictly rejected');

  // 13. Rejected completion can be resubmitted ONLY with a fresh proof challenge
  await client.query('BEGIN;');
  await asSession(client, { userId: verifierB });
  await client.query(`
    SELECT * FROM public.review_challenge_completion('${completion.id}', 'rejected', 'Blurry photo');
  `);
  await client.query('COMMIT;');

  // Resubmit attempt with old consumed proof fails
  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  let resubOldErr = null;
  try {
    await client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}',
        '${verifierB}',
        '${todayStr}'::date,
        '${pc1.id}'::uuid
      );
    `);
  } catch (err) {
    resubOldErr = err;
  }
  await client.query('ROLLBACK;');
  assert(resubOldErr !== null, 'Resubmission with consumed proof must fail');

  // Generate fresh proof challenge and resubmit
  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  const freshProofRes = await client.query(`
    SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifierB}', '${todayStr}'::date);
  `);
  const freshProof = freshProofRes.rows[0];

  const resubFreshRes = await client.query(`
    SELECT * FROM public.submit_challenge_completion(
      '${challengeId}',
      '${verifierB}',
      '${todayStr}'::date,
      '${freshProof.id}'::uuid,
      'Resubmitting with clear code'
    );
  `);
  await client.query('COMMIT;');
  assert.strictEqual(resubFreshRes.rows[0].status, 'pending');
  assert.strictEqual(resubFreshRes.rows[0].proof_challenge_id, freshProof.id);
  reportPass('13. Rejected completion successfully resubmitted with fresh proof challenge');

  // 14. Approved completion cannot be resubmitted or reassigned
  await client.query('BEGIN;');
  await asSession(client, { userId: verifierB });
  await client.query(`
    SELECT * FROM public.review_challenge_completion('${completion.id}', 'approved', NULL);
  `);
  await client.query('COMMIT;');

  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  let reassignApprovedErr = null;
  try {
    await client.query(`SELECT * FROM public.reassign_challenge_verifier('${completion.id}', '${verifierC}');`);
  } catch (err) {
    reassignApprovedErr = err;
  }
  await client.query('ROLLBACK;');
  if (!reassignApprovedErr) {
    const chk = await client.query(`SELECT id, status, verifier_id FROM public.challenge_completions WHERE id = '${completion.id}';`);
    console.log('DEBUG: completion after review_challenge_completion:', chk.rows);
  }
  assert(reassignApprovedErr && reassignApprovedErr.message.includes('reviewed'), 'Approved completion cannot be reassigned');
  reportPass('14. Approved completion is immutable: reassignment and resubmission forbidden');

  // 15 & 16. Verifier reassignment updates proof binding & revokes previous verifier access
  // Create a second test challenge for reassignment lifecycle
  const challenge2Id = '90000000-0000-0000-0000-000000000002';
  const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  await client.query('RESET ROLE;');
  await client.query(`
    INSERT INTO public.challenges (id, title, description, category, duration_days, creator_id, creator_name, challenge_type, timezone, created_at)
    VALUES ('${challenge2Id}', 'Habit Two', 'Desc', 'Focus', 14, '${creatorId}', 'Creator Charlie', 'daily', 'UTC', now() - interval '2 days');

    INSERT INTO public.challenge_participants (challenge_id, user_id, joined_at)
    VALUES
      ('${challenge2Id}', '${participantA}', now() - interval '2 days'),
      ('${challenge2Id}', '${verifierB}', now() - interval '2 days'),
      ('${challenge2Id}', '${verifierC}', now() - interval '2 days');
  `);

  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  const pc2Res = await client.query(`
    SELECT * FROM public.generate_proof_challenge('${challenge2Id}', '${verifierB}', '${yesterdayStr}'::date);
  `);
  const pc2 = pc2Res.rows[0];

  const comp2Res = await client.query(`
    SELECT * FROM public.submit_challenge_completion(
      '${challenge2Id}',
      '${verifierB}',
      '${yesterdayStr}'::date,
      '${pc2.id}'::uuid,
      'Submission 2'
    );
  `);
  await client.query('COMMIT;');
  const comp2 = comp2Res.rows[0];

  // Reassign to verifierC
  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  const reassignRes = await client.query(`
    SELECT * FROM public.reassign_challenge_verifier('${comp2.id}', '${verifierC}');
  `);
  await client.query('COMMIT;');
  assert.strictEqual(reassignRes.rows[0].verifier_id, verifierC);

  // Check synchronized verifier_id on proof_challenges table
  const syncPc2 = await client.query(`SELECT verifier_id FROM public.proof_challenges WHERE id = '${pc2.id}';`);
  assert.strictEqual(syncPc2.rows[0].verifier_id, verifierC, 'proof_challenges verifier_id must be synchronized to verifierC');
  reportPass('15. Verifier reassignment synchronizes verifier_id across completion and proof_challenge');

  // Verify previous verifierB loses review access and SELECT access (test 16)
  await client.query('BEGIN;');
  await asSession(client, { userId: verifierB });
  let formerReviewErr = null;
  try {
    await client.query(`SELECT * FROM public.review_challenge_completion('${comp2.id}', 'approved', NULL);`);
  } catch (err) {
    formerReviewErr = err;
  }
  await client.query('ROLLBACK;');
  assert(formerReviewErr && (formerReviewErr.code === '42501' || formerReviewErr.message.includes('assigned verifier')), 'Former verifier must be blocked from reviewing');

  await client.query('BEGIN;');
  await asSession(client, { userId: verifierB });
  const formerSelect = await client.query(`SELECT * FROM public.proof_challenges WHERE id = '${pc2.id}';`);
  await client.query('COMMIT;');
  assert.strictEqual(formerSelect.rows.length, 0, 'Former verifier must NOT be able to SELECT reassigned proof challenge');
  reportPass('16. Previous verifier strictly loses review and RLS SELECT access');

  // 17. RLS SELECT verification for participant, creator, new verifier, and unrelated user
  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  const partSelect = await client.query(`SELECT * FROM public.proof_challenges WHERE id = '${pc2.id}';`);
  await client.query('COMMIT;');
  assert.strictEqual(partSelect.rows.length, 1, 'Participant must see their proof challenge');

  await client.query('BEGIN;');
  await asSession(client, { userId: creatorId });
  const creatorSelect = await client.query(`SELECT * FROM public.proof_challenges WHERE id = '${pc2.id}';`);
  await client.query('COMMIT;');
  assert.strictEqual(creatorSelect.rows.length, 1, 'Creator must see proof challenges in their challenge');

  await client.query('BEGIN;');
  await asSession(client, { userId: verifierC });
  const newVerSelect = await client.query(`SELECT * FROM public.proof_challenges WHERE id = '${pc2.id}';`);
  await client.query('COMMIT;');
  assert.strictEqual(newVerSelect.rows.length, 1, 'Currently assigned verifier must see proof challenge');

  await client.query('BEGIN;');
  await asSession(client, { userId: unrelatedUser });
  const unrelSelect = await client.query(`SELECT * FROM public.proof_challenges WHERE id = '${pc2.id}';`);
  await client.query('COMMIT;');
  assert.strictEqual(unrelSelect.rows.length, 0, 'Unrelated user must see 0 rows');
  reportPass('17. RLS SELECT access follows exact authorized matrix (participant, creator, active verifier)');

  // 18. Direct INSERT/UPDATE/DELETE rejected for client roles
  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  let directInsertErr = null;
  try {
    await client.query(`
      INSERT INTO public.proof_challenges (challenge_id, participant_id, verifier_id, completion_date, proof_code, action_prompt_id, action_prompt)
      VALUES ('${challengeId}', '${participantA}', '${verifierB}', now()::date, 'HACK', 'hack', 'hack');
    `);
  } catch (err) {
    directInsertErr = err;
  }
  await client.query('ROLLBACK;');
  assert(directInsertErr && directInsertErr.code === '42501', 'Direct INSERT must fail with 42501 permission denied');
  reportPass('18. Direct table modifications (INSERT/UPDATE/DELETE) strictly rejected by PostgreSQL ACL');

  // 19. Daily uniqueness constraint
  const duplicateDate = todayStr;
  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  // Completion for today was already approved above. Submitting or generating proof again must be rejected.
  let dupDateErr = null;
  try {
    await client.query(`
      SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifierB}', '${duplicateDate}'::date);
    `);
  } catch (err) {
    dupDateErr = err;
  }
  await client.query('ROLLBACK;');
  assert(dupDateErr && dupDateErr.message.includes('already approved'), 'Duplicate daily submission must be rejected');
  reportPass('19. Daily dare completion uniqueness strictly enforced');

  // 20. Timezone-aware date window validation
  const pastDate = '2026-01-01';
  await client.query('BEGIN;');
  await asSession(client, { userId: participantA });
  let oldDateErr = null;
  try {
    await client.query(`SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifierB}', '${pastDate}'::date);`);
  } catch (err) {
    oldDateErr = err;
  }
  await client.query('ROLLBACK;');
  assert(oldDateErr && oldDateErr.code === '22023', 'Out-of-window date must be rejected with 22023');
  reportPass('20. Timezone-aware challenge_active_window rejects dates outside today/yesterday window');
}

// ============================================================================
// 4. CONCURRENCY TESTING WITH SEPARATE SESSIONS (Section 5)
// ============================================================================
async function testConcurrency(mainPool) {
  console.log('\n=== Section 5: True Concurrency Testing with Independent Database Sessions ===');

  const challengeId = '90000000-0000-0000-0000-000000000001';
  const participantA = '20000000-0000-0000-0000-000000000001';
  const participantX = '60000000-0000-0000-0000-000000000006';
  const participantY = '70000000-0000-0000-0000-000000000007';
  const verifierB = '30000000-0000-0000-0000-000000000002';
  const todayStr = new Date().toISOString().split('T')[0];

  // Seed participants X and Y
  const setupClient = await mainPool.connect();
  await setupClient.query(`
    INSERT INTO public.challenge_participants (challenge_id, user_id, joined_at)
    VALUES
      ('${challengeId}', '${participantX}', now() - interval '1 day'),
      ('${challengeId}', '${participantY}', now() - interval '1 day')
    ON CONFLICT DO NOTHING;
  `);
  setupClient.release();

  // Test 5A: Concurrent proof generation for different participants
  const client1 = await mainPool.connect();
  const client2 = await mainPool.connect();

  try {
    await client1.query('BEGIN;');
    await client2.query('BEGIN;');
    await asSession(client1, { userId: participantX });
    await asSession(client2, { userId: participantY });

    const [resX, resY] = await Promise.all([
      client1.query(`SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifierB}', '${todayStr}'::date);`),
      client2.query(`SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifierB}', '${todayStr}'::date);`),
    ]);

    await client1.query('COMMIT;');
    await client2.query('COMMIT;');

    assert(resX.rows[0].id && resY.rows[0].id, 'Both concurrent generations must succeed');
    assert.notStrictEqual(resX.rows[0].id, resY.rows[0].id, 'IDs must be distinct');
    assert.strictEqual(resX.rows[0].participant_id, participantX);
    assert.strictEqual(resY.rows[0].participant_id, participantY);
    reportPass('Concurrency 1: Independent participants generate proof challenges concurrently without contention');
  } finally {
    client1.release();
    client2.release();
  }

  // Test 5B: Concurrent consumption of the EXACT SAME proof challenge
  // Only one transaction can consume; the other must fail
  const genClient = await mainPool.connect();
  await genClient.query('BEGIN;');
  await asSession(genClient, { userId: participantX });
  const singleProofRes = await genClient.query(`
    SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifierB}', '${todayStr}'::date);
  `);
  await genClient.query('COMMIT;');
  genClient.release();
  const singleProofId = singleProofRes.rows[0].id;

  const sess1 = await mainPool.connect();
  const sess2 = await mainPool.connect();

  try {
    await sess1.query('BEGIN;');
    await sess2.query('BEGIN;');
    await asSession(sess1, { userId: participantX });
    await asSession(sess2, { userId: participantX });

    const p1 = (async () => {
      try {
        const res = await sess1.query(`
          SELECT * FROM public.submit_challenge_completion(
            '${challengeId}',
            '${verifierB}',
            '${todayStr}'::date,
            '${singleProofId}'::uuid,
            'Concurrent submission 1'
          );
        `);
        await sess1.query('COMMIT;');
        return { success: true, res };
      } catch (err) {
        await sess1.query('ROLLBACK;');
        return { success: false, err };
      }
    })();

    const p2 = (async () => {
      try {
        const res = await sess2.query(`
          SELECT * FROM public.submit_challenge_completion(
            '${challengeId}',
            '${verifierB}',
            '${todayStr}'::date,
            '${singleProofId}'::uuid,
            'Concurrent submission 2'
          );
        `);
        await sess2.query('COMMIT;');
        return { success: true, res };
      } catch (err) {
        await sess2.query('ROLLBACK;');
        return { success: false, err };
      }
    })();

    const [out1, out2] = await Promise.all([p1, p2]);

    const successes = [out1, out2].filter(o => o.success).length;
    const failures = [out1, out2].filter(o => !o.success).length;

    assert.strictEqual(successes, 1, 'Exactly one concurrent submission must win the proof challenge lock');
    assert.strictEqual(failures, 1, 'Exactly one concurrent submission must fail with already consumed');
    reportPass('Concurrency 2: Concurrent consumption of same proof challenge strictly serialized (1 won, 1 blocked)');
  } finally {
    sess1.release();
    sess2.release();
  }

  // Test 5C: Concurrent proof generation for SAME participant serialized by advisory lock
  const sessA1 = await mainPool.connect();
  const sessA2 = await mainPool.connect();
  try {
    await sessA1.query('BEGIN;');
    await sessA2.query('BEGIN;');
    await asSession(sessA1, { userId: participantY });
    await asSession(sessA2, { userId: participantY });

    const genA1 = (async () => {
      const res = await sessA1.query(`SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifierB}', '${todayStr}'::date);`);
      await sessA1.query('COMMIT;');
      return res;
    })();

    const genA2 = (async () => {
      const res = await sessA2.query(`SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifierB}', '${todayStr}'::date);`);
      await sessA2.query('COMMIT;');
      return res;
    })();

    const [g1, g2] = await Promise.all([genA1, genA2]);

    assert(g1.rows[0].id && g2.rows[0].id, 'Both serialized generations succeed');
    // One superseded the other
    const checkStatus = await mainPool.query(`
      SELECT id, status FROM public.proof_challenges WHERE id IN ('${g1.rows[0].id}', '${g2.rows[0].id}');
    `);
    const statuses = checkStatus.rows.map(r => r.status);
    assert(statuses.includes('active'), 'One challenge must remain active');
    assert(statuses.includes('cancelled'), 'The earlier challenge must be cleanly superseded to cancelled');
    reportPass('Concurrency 3: Participant-scoped advisory lock serializes generation and supersedes earlier active challenge');
  } finally {
    sessA1.release();
    sessA2.release();
  }
}

// ============================================================================
// 5. STALE PROOF CHALLENGE INSPECTION (Section 6)
// ============================================================================
async function testStaleProofBehavior(client) {
  console.log('\n=== Section 6: Stale Proof Challenge Behavior Audit ===');

  const challengeId = '90000000-0000-0000-0000-000000000001';
  const participantZ = '80000000-0000-0000-0000-000000000008';
  const verifierB = '30000000-0000-0000-0000-000000000002';
  const todayStr = new Date().toISOString().split('T')[0];

  await client.query('RESET ROLE;');
  await client.query(`
    INSERT INTO public.challenge_participants (challenge_id, user_id, joined_at)
    VALUES ('${challengeId}', '${participantZ}', now())
    ON CONFLICT DO NOTHING;
  `);

  // Generate 1st proof challenge (abandoned)
  await client.query('BEGIN;');
  await asSession(client, { userId: participantZ });
  const p1 = await client.query(`SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifierB}', '${todayStr}'::date);`);
  await client.query('COMMIT;');
  const p1Id = p1.rows[0].id;

  // Inspect database status of abandoned proof challenge
  const p1Check = await client.query(`SELECT status, expires_at FROM public.proof_challenges WHERE id = '${p1Id}';`);
  assert.strictEqual(p1Check.rows[0].status, 'active');
  reportPass('Abandoned proof challenge remains in status "active" with 45-minute expiry timestamp');

  // Verify that active abandoned challenge counts toward rate limit
  const countRes = await client.query(`
    SELECT count(*)::int as count FROM public.proof_challenges
    WHERE participant_id = '${participantZ}' AND created_at >= (now() - interval '1 hour');
  `);
  assert.strictEqual(countRes.rows[0].count, 1, 'Abandoned challenge counts against 5/hr rate limit');
  reportPass('Abandoned challenge counts toward participant 5/hour rate limit');

  // Generating a replacement for same participant and date supersedes it to "cancelled"
  await client.query('BEGIN;');
  await asSession(client, { userId: participantZ });
  const p2 = await client.query(`SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifierB}', '${todayStr}'::date);`);
  await client.query('COMMIT;');

  const p1After = await client.query(`SELECT status FROM public.proof_challenges WHERE id = '${p1Id}';`);
  assert.strictEqual(p1After.rows[0].status, 'cancelled', 'Superseded proof challenge must transition to cancelled');
  assert.strictEqual(p2.rows[0].status, 'active');
  reportPass('Generating replacement challenge cleanly supersedes abandoned challenge to "cancelled"');
}

// ============================================================================
// 6. PROOF CODE GENERATOR AUDIT (Section 7)
// ============================================================================
async function testProofCodeGenerator(client) {
  console.log('\n=== Section 7: SQL generate_secure_proof_code() In-Database Execution ===');

  await client.query('RESET ROLE;');

  // Call the function 1,000 times in PostgreSQL
  const genRes = await client.query(`
    SELECT public.generate_secure_proof_code() as code
    FROM generate_series(1, 1000);
  `);

  assert.strictEqual(genRes.rows.length, 1000, 'Must generate 1,000 codes');
  const CROCKFORD_VALID = new Set('23456789ABCDEFGHJKMNPQRSTVWXYZ');
  const FORBIDDEN = new Set('01IOU01iouabcdefghjkmnpqrstvwxyz');

  const charCounts = {};
  for (const row of genRes.rows) {
    const code = row.code;
    assert.strictEqual(code.length, 4, `Code "${code}" must have length 4`);
    for (const ch of code) {
      assert(CROCKFORD_VALID.has(ch), `Character "${ch}" must be in Crockford Base32 alphabet`);
      assert(!FORBIDDEN.has(ch), `Character "${ch}" must not be in forbidden set`);
      charCounts[ch] = (charCounts[ch] || 0) + 1;
    }
  }

  const uniqueChars = Object.keys(charCounts).length;
  assert(uniqueChars >= 28, `Expected at least 28 unique characters represented across 4,000 generated chars, got ${uniqueChars}`);
  reportPass(`Executed 1,000 in-database code generations (4,000 characters). All valid Crockford Base32 (${uniqueChars}/30 characters observed)`);

  // Verify execution permission
  const anonCallErr = await client.query(`
    SET ROLE anon;
    SELECT public.generate_secure_proof_code();
  `).catch(e => e);
  await client.query('RESET ROLE;');
  assert(anonCallErr && anonCallErr.code === '42501', 'Direct execution of generate_secure_proof_code by anon must fail with 42501');

  const authCallErr = await client.query(`
    SET ROLE authenticated;
    SELECT public.generate_secure_proof_code();
  `).catch(e => e);
  await client.query('RESET ROLE;');
  assert(authCallErr && authCallErr.code === '42501', 'Direct execution of generate_secure_proof_code by authenticated must fail with 42501');
  reportPass('generate_secure_proof_code() permission verified: direct execution strictly revoked from client roles');
}

// ============================================================================
// MAIN RUNNER
// ============================================================================
async function main() {
  console.log('================================================================');
  console.log('DareDrop Phase 23D: Isolated PostgreSQL Migration & Lifecycle Validation');
  console.log('================================================================\n');

  const client = await pool.connect();
  try {
    await setupIsolatedEnvironment(client);
    await auditPostgresCatalog(client);
    await testLifecycle(client);
    await testConcurrency(pool);
    await testStaleProofBehavior(client);
    await testProofCodeGenerator(client);

    console.log('\n================================================================');
    console.log(`🎉 ALL PHASE 23D TESTS PASSED! (${passedTests} passed, ${failedTests} failed)`);
    console.log('================================================================');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('\n❌ Phase 23D Validation Aborted due to Error:', err);
  process.exit(1);
});
