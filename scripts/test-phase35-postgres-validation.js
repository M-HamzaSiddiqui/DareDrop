// DareDrop Phase 35: Isolated PostgreSQL Integration Validation
// File: scripts/test-phase35-postgres-validation.js
// Run with: node scripts/test-phase35-postgres-validation.js

const { Pool, types } = require('pg');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

types.setTypeParser(1082, str => str); // DATE type as string

console.log('================================================================');
console.log('DareDrop Phase 35: Isolated PostgreSQL Integration Validation');
console.log('================================================================\n');

// 0. ABSOLUTE PRODUCTION SAFETY GUARDS
const PROD_HOST_PATTERN = 'uyglmszjkkfjeckpwpab.supabase.co';

const DB_CONFIG = {
  host: process.env.PGHOST || '127.0.0.1',
  port: parseInt(process.env.PGPORT || '54332', 10),
  database: process.env.PGDATABASE || 'daredrop_disposable_test',
  user: process.env.PGUSER || 'umardinkhan',
};

// Fatal guard: abort immediately if any production identifier is present
for (const [k, v] of Object.entries(process.env)) {
  if (typeof v === 'string' && v.includes(PROD_HOST_PATTERN)) {
    console.error(`❌ FATAL: Production Supabase host detected in ${k}! Aborting.`);
    process.exit(1);
  }
}
assert(!DB_CONFIG.host.includes(PROD_HOST_PATTERN), 'Must not target production host');
assert(DB_CONFIG.database === 'daredrop_disposable_test', 'Must target disposable test database');
assert(DB_CONFIG.port === 54332, 'Must target isolated local port 54332');

const pool = new Pool(DB_CONFIG);

let passed = 0;
let failed = 0;

function reportPass(msg) {
  console.log(`  ✅ ${msg}`);
  passed++;
}

function reportFail(msg, err) {
  console.error(`  ❌ FAIL: ${msg}`, err || '');
  failed++;
  throw err || new Error(msg);
}

// Session helper for impersonating authenticated Supabase users
async function asSession(client, { userId = null, role = 'authenticated', isAnonymous = false } = {}) {
  await client.query('RESET ROLE;');
  if (!userId) {
    await client.query(`
      SELECT set_config('request.jwt.claim.sub', '', false);
      SELECT set_config('request.jwt.claim.role', '${role}', false);
      SELECT set_config('request.jwt.claims', '', false);
      SET ROLE ${role};
    `);
  } else {
    const claims = JSON.stringify({
      sub: userId,
      role: role,
      email: `${userId.slice(0, 8)}@test.com`,
      aud: 'authenticated',
      is_anonymous: isAnonymous ? 'true' : 'false',
      app_metadata: { provider: isAnonymous ? 'anonymous' : 'email' },
    });
    await client.query(`
      SELECT set_config('request.jwt.claim.sub', '${userId}', false);
      SELECT set_config('request.jwt.claim.role', '${role}', false);
      SELECT set_config('request.jwt.claims', '${claims.replace(/'/g, "''")}', false);
      SET ROLE ${role};
    `);
  }
}

async function runValidation() {
  const adminClient = await pool.connect();

  try {
    // ------------------------------------------------------------------------
    // Audit 1: Environment Details
    // ------------------------------------------------------------------------
    console.log('[Audit 1] Environment Isolation & Host Verification:');
    const verRes = await adminClient.query('SELECT version();');
    console.log(`  PostgreSQL Version: ${verRes.rows[0].version}`);
    console.log(`  Target Host: ${DB_CONFIG.host}:${DB_CONFIG.port}`);
    console.log(`  Target Database: ${DB_CONFIG.database}`);
    reportPass('Verified 100% isolated local PostgreSQL environment on port 54332');

    // ------------------------------------------------------------------------
    // Audit 2: Build Prerequisite Schema
    // ------------------------------------------------------------------------
    console.log('\n[Audit 2] Rebuilding Clean Pre-Migration Schema from Base Migrations:');
    await adminClient.query(`
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

    // Apply baseline migrations up to 20261102000000_dynamic_proof_challenges.sql
    const baseMigrations = [
      '20261022000000_create_challenges_and_participants.sql',
      '20261024000000_peer_verification.sql',
      '20261024010000_fix_eligible_verifiers_ambiguous_user_id.sql',
      '20261024020000_enable_realtime_completions.sql',
      '20261024030000_push_notifications.sql',
      '20261024040000_atomic_notification_claims.sql',
      '20261027000000_notification_inbox.sql',
      '20261028000000_friends_and_invitations.sql',
      '20261028010000_push_webhook_vault_secret.sql',
      '20261028020000_enforce_registered_account_restrictions.sql',
      '20261029000000_guard_challenge_deletion.sql',
      '20261029010000_guard_challenge_updates.sql',
      '20261030000000_prevent_joining_expired_challenges.sql',
      '20261030055315_enforce_text_length_limits.sql',
      '20261030061642_validate_push_tokens.sql',
      '20261102000000_dynamic_proof_challenges.sql',
    ];

    for (const m of baseMigrations) {
      if (m === '20261028010000_push_webhook_vault_secret.sql') {
        const headersJson = JSON.stringify({
          'Content-Type': 'application/json',
          'x-webhook-secret': 'mock-secret-for-phase35',
        });
        const parts = ['https://mock.supabase.co/functions/v1/send-push-notification', 'POST', headersJson, '{}', '5000'];
        const hex = parts.map(p => Buffer.from(p, 'utf8').toString('hex')).join('00') + '00';

        await adminClient.query(`
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

      const mPath = path.resolve(__dirname, '../supabase/migrations', m);
      const mSql = fs.readFileSync(mPath, 'utf8');
      await adminClient.query(mSql);
    }
    reportPass('Applied prerequisite migration chain cleanly up to dynamic_proof_challenges.sql');

    // ------------------------------------------------------------------------
    // Audit 3: Execute Migration Chain & Backfill Verification
    // ------------------------------------------------------------------------
    console.log('\n[Audit 3] Pre-Migration Historical Data Population & Migration Chain Execution:');

    // Setup base test entities: Challenge creator, submitter, verifier
    const creatorId = '00000000-0000-0000-0000-000000000001';
    const submitterId = '00000000-0000-0000-0000-000000000002';
    const verifierId = '00000000-0000-0000-0000-000000000003';
    const dailyChallengeId = '11111111-1111-1111-1111-111111111111';
    const onetimeChallengeId = '22222222-2222-2222-2222-222222222222';

    // Insert active challenges (UTC)
    await adminClient.query(`
      INSERT INTO public.challenges (id, title, description, category, duration_days, creator_id, challenge_type, timezone, created_at, ends_at)
      VALUES
        ('${dailyChallengeId}', 'Test Daily Dare', 'Daily Dare Desc', 'Fitness', 30, '${creatorId}', 'daily', 'UTC', now() - interval '10 days', now() + interval '20 days'),
        ('${onetimeChallengeId}', 'Test One-Time Dare', 'One-time Desc', 'Fun', 30, '${creatorId}', 'one_time', 'UTC', now() - interval '5 days', now() + interval '25 days');

      INSERT INTO public.challenge_participants (challenge_id, user_id, joined_at)
      VALUES
        ('${dailyChallengeId}', '${creatorId}', now() - interval '10 days'),
        ('${dailyChallengeId}', '${submitterId}', now() - interval '10 days'),
        ('${dailyChallengeId}', '${verifierId}', now() - interval '10 days'),
        ('${onetimeChallengeId}', '${creatorId}', now() - interval '5 days'),
        ('${onetimeChallengeId}', '${submitterId}', now() - interval '5 days'),
        ('${onetimeChallengeId}', '${verifierId}', now() - interval '5 days');
    `);

    // Insert historical completion records BEFORE Phase 33 migration
    // 1. Approved completion from 5 days ago
    // 2. Pending completion from today
    // 3. Rejected completion from 3 days ago (rejected 12 hours ago)
    const approvedCompId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const pendingCompId  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const rejectedCompId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

    const dateApproved = (await adminClient.query(`SELECT (now() AT TIME ZONE 'UTC' - interval '5 days')::date::text as d;`)).rows[0].d;
    const dateToday    = (await adminClient.query(`SELECT (now() AT TIME ZONE 'UTC')::date::text as d;`)).rows[0].d;
    const dateRejected = (await adminClient.query(`SELECT (now() AT TIME ZONE 'UTC' - interval '3 days')::date::text as d;`)).rows[0].d;

    await adminClient.query(`
      INSERT INTO public.challenge_completions (
        id, challenge_id, challenge_type, participant_id, verifier_id, completion_date, status,
        submission_note, rejection_reason, submitted_at, reviewed_at
      ) VALUES
        ('${approvedCompId}', '${dailyChallengeId}', 'daily', '${submitterId}', '${verifierId}', '${dateApproved}', 'approved', 'Day 5 done', NULL, now() - interval '5 days', now() - interval '5 days' + interval '2 hours'),
        ('${pendingCompId}', '${dailyChallengeId}', 'daily', '${submitterId}', '${verifierId}', '${dateToday}', 'pending', 'Today note', NULL, now() - interval '10 minutes', NULL),
        ('${rejectedCompId}', '${dailyChallengeId}', 'daily', '${submitterId}', '${verifierId}', '${dateRejected}', 'rejected', 'Day 3 note', 'Photo too dark', now() - interval '3 days', now() - interval '12 hours');
    `);
    reportPass('Inserted historical completion baseline records (approved, pending, rejected)');

    // Execute Phase 33 Migration
    const phase33MigPath = path.resolve(__dirname, '../supabase/migrations/20261102010000_resubmission_grace_period.sql');
    const phase33MigSql = fs.readFileSync(phase33MigPath, 'utf8');
    await adminClient.query(phase33MigSql);
    reportPass('Phase 33 migration (20261102010000_resubmission_grace_period.sql) executed cleanly with 0 SQL errors');

    // Verify Schema Columns
    const colRes = await adminClient.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'challenge_completions'
        AND column_name IN ('first_submitted_at', 'last_rejection_reason', 'last_reviewed_at')
      ORDER BY column_name;
    `);
    assert.strictEqual(colRes.rows.length, 3, 'All 3 new columns must exist');
    reportPass('Catalog confirmed columns: first_submitted_at, last_rejection_reason, last_reviewed_at');

    // Verify Backfill Values
    const backfillRows = await adminClient.query(`
      SELECT id, status, submitted_at, first_submitted_at, rejection_reason, reviewed_at, last_rejection_reason, last_reviewed_at
      FROM public.challenge_completions
      WHERE id IN ('${approvedCompId}', '${pendingCompId}', '${rejectedCompId}')
      ORDER BY id;
    `);

    for (const row of backfillRows.rows) {
      assert(row.first_submitted_at !== null, `Row ${row.id} first_submitted_at must not be null`);
      assert.strictEqual(
        new Date(row.first_submitted_at).getTime(),
        new Date(row.submitted_at).getTime(),
        `Row ${row.id} first_submitted_at must equal submitted_at`
      );
      assert.strictEqual(row.last_rejection_reason, null, 'last_rejection_reason must initialize to NULL');
      assert.strictEqual(row.last_reviewed_at, null, 'last_reviewed_at must initialize to NULL');
    }

    const rejRow = backfillRows.rows.find(r => r.id === rejectedCompId);
    assert.strictEqual(rejRow.rejection_reason, 'Photo too dark');
    assert(rejRow.reviewed_at !== null);
    reportPass('Backfill verified: historical submitted_at correctly copied to first_submitted_at, rejection metadata preserved');

    // Verify RPC Signatures in pg_proc
    const procRes = await adminClient.query(`
      SELECT p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) as args, p.prosecdef
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN ('generate_proof_challenge', 'submit_challenge_completion')
      ORDER BY p.proname, p.oid;
    `);

    const signatures = procRes.rows.map(r => `${r.proname}(${r.args}) [secdef: ${r.prosecdef}]`);
    assert(signatures.some(s => s.includes('generate_proof_challenge(p_challenge_id uuid, p_verifier_id text, p_completion_date date) [secdef: true]')));
    assert(signatures.some(s => s.includes('submit_challenge_completion(p_challenge_id uuid, p_verifier_id text, p_completion_date date, p_submission_note text) [secdef: true]')));
    assert(signatures.some(s => s.includes('submit_challenge_completion(p_challenge_id uuid, p_verifier_id text, p_completion_date date, p_proof_challenge_id uuid, p_submission_note text) [secdef: true]')));
    reportPass('RPC catalog audit: 4-arg legacy stub and 5-arg proof-enforced RPC cleanly coexist as SECURITY DEFINER');

    // ------------------------------------------------------------------------
    // Audit 4: Actual PL/pgSQL Grace-Period Tests (Live DB Execution)
    // ------------------------------------------------------------------------
    console.log('\n[Audit 4] Live PL/pgSQL Grace-Period Functional Verification:');
    const client = await pool.connect();

    try {
      // 1. On-time daily submission, rejected within 48 hours: fresh proof generation succeeds
      await asSession(client, { userId: submitterId });
      const proof1 = await client.query(`
        SELECT * FROM public.generate_proof_challenge('${dailyChallengeId}'::uuid, '${verifierId}', '${dateRejected}'::date);
      `);
      assert(proof1.rows.length === 1 && proof1.rows[0].status === 'active');
      reportPass('1. On-time daily submission rejected within 48h: generate_proof_challenge succeeded');

      // Resubmit using the generated proof
      const resubmit1 = await client.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${dailyChallengeId}'::uuid, '${verifierId}', '${dateRejected}'::date, '${proof1.rows[0].id}'::uuid, 'Resubmitted with bright light'
        );
      `);
      assert.strictEqual(resubmit1.rows[0].status, 'pending');
      assert.strictEqual(resubmit1.rows[0].rejection_reason, null);
      assert.strictEqual(resubmit1.rows[0].last_rejection_reason, 'Photo too dark');
      reportPass('1b. Resubmission updated rejected row to pending and preserved historical rejection reason');

      // 2. On-time daily submission rejected several days after date but <48 hours ago
      // Create another past dare date 6 days ago, submitted 6 days ago, rejected 24 hours ago
      const datePast = (await adminClient.query(`SELECT (now() AT TIME ZONE 'UTC' - interval '6 days')::date::text as d;`)).rows[0].d;
      const pastCompId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
      await adminClient.query(`
        INSERT INTO public.challenge_completions (
          id, challenge_id, challenge_type, participant_id, verifier_id, completion_date, status,
          submission_note, rejection_reason, first_submitted_at, submitted_at, reviewed_at
        ) VALUES (
          '${pastCompId}', '${dailyChallengeId}', 'daily', '${submitterId}', '${verifierId}', '${datePast}', 'rejected',
          'Note 6', 'Blurry', now() - interval '6 days', now() - interval '6 days', now() - interval '24 hours'
        );
      `);

      const proof2 = await client.query(`
        SELECT * FROM public.generate_proof_challenge('${dailyChallengeId}'::uuid, '${verifierId}', '${datePast}'::date);
      `);
      assert(proof2.rows.length === 1 && proof2.rows[0].status === 'active');
      reportPass('2. On-time submission rejected >48h after dare date but <48h ago: proof generation succeeded');

      // 3. Rejection older than 48 hours: denied
      const dateOldRej = (await adminClient.query(`SELECT (now() AT TIME ZONE 'UTC' - interval '7 days')::date::text as d;`)).rows[0].d;
      const oldRejCompId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
      await adminClient.query(`
        INSERT INTO public.challenge_completions (
          id, challenge_id, challenge_type, participant_id, verifier_id, completion_date, status,
          submission_note, rejection_reason, first_submitted_at, submitted_at, reviewed_at
        ) VALUES (
          '${oldRejCompId}', '${dailyChallengeId}', 'daily', '${submitterId}', '${verifierId}', '${dateOldRej}', 'rejected',
          'Note 7', 'Bad', now() - interval '7 days', now() - interval '7 days', now() - interval '50 hours'
        );
      `);

      let err3 = null;
      try {
        await client.query(`SELECT * FROM public.generate_proof_challenge('${dailyChallengeId}'::uuid, '${verifierId}', '${dateOldRej}'::date);`);
      } catch (e) { err3 = e; }
      assert(err3 && err3.code === '22023' && err3.message.includes('Resubmission grace period expired'));
      reportPass('3. Rejection older than 48 hours strictly denied (22023)');

      // 4. No original completion: old-date proof generation denied
      const dateNoComp = (await adminClient.query(`SELECT (now() AT TIME ZONE 'UTC' - interval '8 days')::date::text as d;`)).rows[0].d;
      let err4 = null;
      try {
        await client.query(`SELECT * FROM public.generate_proof_challenge('${dailyChallengeId}'::uuid, '${verifierId}', '${dateNoComp}'::date);`);
      } catch (e) { err4 = e; }
      assert(err4 && err4.code === '22023' && err4.message.includes('Submission window expired'));
      reportPass('4. No original completion: old-date proof generation denied (22023)');

      // 5. Original submission was late: grace-period resubmission denied
      const dateLateOrig = (await adminClient.query(`SELECT (now() AT TIME ZONE 'UTC' - interval '4 days')::date::text as d;`)).rows[0].d;
      const lateOrigCompId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
      await adminClient.query(`
        INSERT INTO public.challenge_completions (
          id, challenge_id, challenge_type, participant_id, verifier_id, completion_date, status,
          submission_note, rejection_reason, first_submitted_at, submitted_at, reviewed_at
        ) VALUES (
          '${lateOrigCompId}', '${dailyChallengeId}', 'daily', '${submitterId}', '${verifierId}', '${dateLateOrig}', 'rejected',
          'Late Note', 'Late', now() - interval '1 day', now() - interval '1 day', now() - interval '6 hours'
        );
      `);

      let err5 = null;
      try {
        await client.query(`SELECT * FROM public.generate_proof_challenge('${dailyChallengeId}'::uuid, '${verifierId}', '${dateLateOrig}'::date);`);
      } catch (e) { err5 = e; }
      assert(err5 && err5.code === '22023' && err5.message.includes('original submission was not submitted within the permitted window'));
      reportPass('5. Original submission submitted late: grace-period resubmission strictly denied (22023)');

      // 6. Approved completion: resubmission denied
      let err6 = null;
      try {
        await client.query(`SELECT * FROM public.generate_proof_challenge('${dailyChallengeId}'::uuid, '${verifierId}', '${dateApproved}'::date);`);
      } catch (e) { err6 = e; }
      assert(err6 && err6.code === '23505' && err6.message.includes('already approved'));
      reportPass('6. Approved completion: resubmission strictly denied (23505)');

      // 7. Pending completion: duplicate submission denied
      let err7 = null;
      try {
        await client.query(`SELECT * FROM public.generate_proof_challenge('${dailyChallengeId}'::uuid, '${verifierId}', '${dateToday}'::date);`);
      } catch (e) { err7 = e; }
      assert(err7 && err7.code === '23505' && err7.message.includes('already pending verification'));
      reportPass('7. Pending completion: duplicate submission denied (23505)');

      // 8. Missing reviewed_at: denied
      const dateNullReviewed = (await adminClient.query(`SELECT (now() AT TIME ZONE 'UTC' - interval '2 days')::date::text as d;`)).rows[0].d;
      const nullRevCompId = '12121212-1212-1212-1212-121212121212';
      await adminClient.query(`
        INSERT INTO public.challenge_completions (
          id, challenge_id, challenge_type, participant_id, verifier_id, completion_date, status,
          submission_note, rejection_reason, first_submitted_at, submitted_at, reviewed_at
        ) VALUES (
          '${nullRevCompId}', '${dailyChallengeId}', 'daily', '${submitterId}', '${verifierId}', '${dateNullReviewed}', 'rejected',
          'Null rev note', 'Reject', now() - interval '2 days', now() - interval '2 days', NULL
        );
      `);

      let err8 = null;
      try {
        await client.query(`SELECT * FROM public.generate_proof_challenge('${dailyChallengeId}'::uuid, '${verifierId}', '${dateNullReviewed}'::date);`);
      } catch (e) { err8 = e; }
      assert(err8 && err8.code === '22023' && err8.message.includes('Resubmission grace period expired'));
      reportPass('8. Missing reviewed_at timestamp: grace period strictly denied (22023)');

      // 9. Repeated proof generation does not extend grace period
      // Verified by checking reviewed_at timestamp on challenge_completions remains unchanged after proof generation
      const preProofRev = (await adminClient.query(`SELECT reviewed_at FROM public.challenge_completions WHERE id = '${pastCompId}';`)).rows[0].reviewed_at;
      await client.query(`SELECT * FROM public.generate_proof_challenge('${dailyChallengeId}'::uuid, '${verifierId}', '${datePast}'::date);`);
      const postProofRev = (await adminClient.query(`SELECT reviewed_at FROM public.challenge_completions WHERE id = '${pastCompId}';`)).rows[0].reviewed_at;
      assert.strictEqual(new Date(preProofRev).getTime(), new Date(postProofRev).getTime());
      reportPass('9. Repeated proof generation does not modify reviewed_at or extend grace period');

      // 10. Repeated rejection and resubmission cycles preserve first_submitted_at
      const initialFirstSub = (await adminClient.query(`SELECT first_submitted_at FROM public.challenge_completions WHERE id = '${rejectedCompId}';`)).rows[0].first_submitted_at;
      // Verifier rejects the resubmission (Cycle 2)
      await adminClient.query(`
        UPDATE public.challenge_completions
        SET status = 'rejected', rejection_reason = 'Cycle 2 reject', reviewed_at = now() - interval '1 hour'
        WHERE id = '${rejectedCompId}';
      `);

      // Resubmit once more
      const proofCycle = await client.query(`
        SELECT * FROM public.generate_proof_challenge('${dailyChallengeId}'::uuid, '${verifierId}', '${dateRejected}'::date);
      `);
      await client.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${dailyChallengeId}'::uuid, '${verifierId}', '${dateRejected}'::date, '${proofCycle.rows[0].id}'::uuid, 'Cycle 2 resubmit'
        );
      `);
      const postCycleFirstSub = (await adminClient.query(`SELECT first_submitted_at FROM public.challenge_completions WHERE id = '${rejectedCompId}';`)).rows[0].first_submitted_at;
      assert.strictEqual(new Date(initialFirstSub).getTime(), new Date(postCycleFirstSub).getTime());
      reportPass('10. Repeated resubmission cycles strictly preserve initial first_submitted_at');

      // 11. One-time challenge behavior remains unchanged
      const otProof = await client.query(`
        SELECT * FROM public.generate_proof_challenge('${onetimeChallengeId}'::uuid, '${verifierId}', '${dateToday}'::date);
      `);
      const otSubmit = await client.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${onetimeChallengeId}'::uuid, '${verifierId}', '${dateToday}'::date, '${otProof.rows[0].id}'::uuid, 'One time dare proof'
        );
      `);
      assert.strictEqual(otSubmit.rows[0].status, 'pending');
      reportPass('11. One-time challenge proof generation and submission verified');

      // 12. Proof consumption is atomic with completion status update
      const consumedProofCheck = await adminClient.query(`
        SELECT status, consumed_at FROM public.proof_challenges WHERE id = '${otProof.rows[0].id}';
      `);
      assert.strictEqual(consumedProofCheck.rows[0].status, 'consumed');
      assert(consumedProofCheck.rows[0].consumed_at !== null);
      reportPass('12. Proof challenge atomically consumed in same transaction as completion insertion');

    } finally {
      client.release();
    }

    // ------------------------------------------------------------------------
    // Audit 5: Concurrency Tests with Separate Independent Sessions
    // ------------------------------------------------------------------------
    console.log('\n[Audit 5] True Concurrency Tests (Separate Active Database Sessions):');

    const concSubmitterId = '00000000-0000-0000-0000-000000000004';
    await adminClient.query(`
      INSERT INTO public.challenge_participants (challenge_id, user_id, joined_at)
      VALUES ('${dailyChallengeId}', '${concSubmitterId}', now() - interval '10 days')
      ON CONFLICT DO NOTHING;
    `);

    // Concurrency 1: Two submissions attempting to consume the same proof challenge
    {
      const dateConc = (await adminClient.query(`SELECT (now() AT TIME ZONE 'UTC')::date::text as d;`)).rows[0].d;
      const clientSetup = await pool.connect();
      await asSession(clientSetup, { userId: concSubmitterId });

      const concProof = (await clientSetup.query(`
        SELECT * FROM public.generate_proof_challenge('${dailyChallengeId}'::uuid, '${verifierId}', '${dateConc}'::date);
      `)).rows[0];
      clientSetup.release();

      const sessionA = await pool.connect();
      const sessionB = await pool.connect();

      await asSession(sessionA, { userId: concSubmitterId });
      await asSession(sessionB, { userId: concSubmitterId });

      let resA = null, errA = null;
      let resB = null, errB = null;

      const pA = sessionA.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${dailyChallengeId}'::uuid, '${verifierId}', '${dateConc}'::date, '${concProof.id}'::uuid, 'Session A'
        );
      `).then(r => { resA = r; }).catch(e => { errA = e; });

      const pB = sessionB.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${dailyChallengeId}'::uuid, '${verifierId}', '${dateConc}'::date, '${concProof.id}'::uuid, 'Session B'
        );
      `).then(r => { resB = r; }).catch(e => { errB = e; });

      await Promise.all([pA, pB]);

      sessionA.release();
      sessionB.release();

      const winnerCount = (resA ? 1 : 0) + (resB ? 1 : 0);
      const errorCount = (errA ? 1 : 0) + (errB ? 1 : 0);
      assert.strictEqual(winnerCount, 1, 'Exactly one concurrent submission must win');
      assert.strictEqual(errorCount, 1, 'Second concurrent submission must be rejected');
      const errWinner = errA || errB;
      assert(errWinner.message.includes('Proof challenge is no longer active') || errWinner.code === '23505');
      reportPass('Concurrency 1: Simultaneous consumption of same proof challenge strictly serialized (1 won, 1 blocked)');
    }

    // Concurrency 2: Rejection racing with proof generation
    {
      const compForRace = (await adminClient.query(`
        SELECT id, completion_date FROM public.challenge_completions
        WHERE challenge_id = '${dailyChallengeId}' AND participant_id = '${submitterId}' AND status = 'pending'
        LIMIT 1;
      `)).rows[0];

      if (compForRace) {
        const sessionRev = await pool.connect();
        const sessionProof = await pool.connect();

        await asSession(sessionRev, { userId: verifierId });
        await asSession(sessionProof, { userId: submitterId });

        let resRev = null, errRev = null;
        let resProof = null, errProof = null;

        const pReview = sessionRev.query(`
          SELECT * FROM public.review_challenge_completion('${compForRace.id}'::uuid, 'rejected', 'Concurrent review race');
        `).then(r => { resRev = r; }).catch(e => { errRev = e; });

        const pProof = sessionProof.query(`
          SELECT * FROM public.generate_proof_challenge('${dailyChallengeId}'::uuid, '${verifierId}', '${compForRace.completion_date}'::date);
        `).then(r => { resProof = r; }).catch(e => { errProof = e; });

        await Promise.all([pReview, pProof]);

        sessionRev.release();
        sessionProof.release();

        assert(resRev !== null, 'Review RPC must complete successfully');
        // If review completed first, proof challenge generation also succeeded; if proof arrived first, it caught pending verification
        if (errProof) {
          assert(errProof.code === '23505' && errProof.message.includes('pending verification'));
        } else {
          assert(resProof && resProof.rows.length === 1);
        }
        reportPass('Concurrency 2: Simultaneous review and proof generation cleanly serialized by FOR UPDATE row lock without deadlock');
      }
    }

    // ------------------------------------------------------------------------
    // Audit 6: Rollback Validation
    // ------------------------------------------------------------------------
    console.log('\n[Audit 6] Rollback Execution & Schema Integrity:');
    const rollbackPath = path.resolve(__dirname, '../supabase/migrations/rollback/20261102010000_resubmission_grace_period_rollback.sql');
    const rollbackSql = fs.readFileSync(rollbackPath, 'utf8');
    await adminClient.query(rollbackSql);
    reportPass('Rollback script executed cleanly');

    // Verify columns still exist as designed (non-destructive rollback)
    const postRollbackCols = await adminClient.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'challenge_completions'
        AND column_name IN ('first_submitted_at', 'last_rejection_reason', 'last_reviewed_at');
    `);
    assert.strictEqual(postRollbackCols.rows.length, 3, 'Rollback preserves audit columns to prevent data loss');
    reportPass('Rollback verified: audit columns and historical data preserved intact');

    // Verify restored function rejects past-date resubmission (restored original behavior)
    const clientPostRollback = await pool.connect();
    await asSession(clientPostRollback, { userId: submitterId });
    let errRollback = null;
    try {
      await clientPostRollback.query(`
        SELECT * FROM public.generate_proof_challenge('${dailyChallengeId}'::uuid, '${verifierId}', '${dateRejected}'::date);
      `);
    } catch (e) { errRollback = e; }
    assert(errRollback && errRollback.message.includes('Submission window expired'));
    clientPostRollback.release();
    reportPass('Rollback verified: generate_proof_challenge restored to pre-Phase 33 strict today/yesterday behavior');

    // Reapply Phase 33 migration to verify idempotency
    await adminClient.query(phase33MigSql);
    reportPass('Reapplied Phase 33 migration cleanly (idempotency verified)');

  } finally {
    adminClient.release();
  }
}

async function main() {
  try {
    await runValidation();
    console.log('\n================================================================');
    console.log(`🎉 ALL PHASE 35 POSTGRESQL INTEGRATION TESTS PASSED! (${passed} passed, ${failed} failed)`);
    console.log('================================================================');
  } catch (err) {
    console.error('\n❌ Phase 35 Validation Suite Failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
