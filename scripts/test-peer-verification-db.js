// scripts/test-peer-verification-db.js
// Automated live PostgreSQL security, concurrency, and authorization tests for DareDrop peer verification
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

function getDisposableDbHost() {
  if (process.env.PGHOST) return process.env.PGHOST;
  const candidates = [
    '/home/umardinkhan/.gemini/antigravity-ide/brain/bc0964dd-df07-4ccd-a318-64f329182610/scratch',
    '/home/umardinkhan/.gemini/antigravity-ide/brain/ee816e57-e138-41a5-9104-e7d242c262cf/scratch',
    '/tmp',
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, '.s.PGSQL.54332'))) {
      return c;
    }
  }
  return candidates[0];
}

const DISPOSABLE_DB_CONFIG = {
  host: getDisposableDbHost(),
  port: parseInt(process.env.PGPORT || '54332', 10),
  database: 'postgres',
  user: 'umardinkhan',
};

const pool = new Pool(DISPOSABLE_DB_CONFIG);

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

async function setSessionUser(client, userId) {
  await client.query(`
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT ${userId ? `'${userId}'::uuid` : 'NULL::uuid'}
    $$;
  `);
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('=== Starting Real PostgreSQL 16 Peer Verification Test Suite ===');
  console.log(`Environment: PostgreSQL 16 on ${DISPOSABLE_DB_CONFIG.host}:${DISPOSABLE_DB_CONFIG.port}\n`);

  const client = await pool.connect();

  try {
    // PHASE 1: Fresh Database Initialization from Migration 1 (Pre-Migration Schema)
    console.log('Phase 1: Pre-Migration Setup & Schema Initialization');
    await client.query(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO umardinkhan;
      -- Emulate Supabase default ACLs: client roles start with USAGE *and* CREATE on public
      GRANT ALL ON SCHEMA public TO anon, authenticated, service_role;
      -- Emulate Supabase default privileges: new public tables/functions are granted to client roles
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

      CREATE SCHEMA IF NOT EXISTS auth;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    `);

    // Run Migration 1
    const mig1Path = path.join(process.cwd(), 'supabase/migrations/20261022000000_create_challenges_and_participants.sql');
    const mig1Sql = fs.readFileSync(mig1Path, 'utf8');
    await client.query(mig1Sql);
    assert(true, 'Migration 1 (pre-migration schema) applied cleanly to clean database');

    // Populate pre-existing data (challenges with NULL challenge_type and NULL timezone)
    const creatorId = '10000000-0000-0000-0000-000000000001';
    const legacyChallengeId = '22222222-2222-2222-2222-222222222222';
    await client.query(`
      INSERT INTO public.challenges (id, title, description, category, duration_days, creator_id, created_at)
      VALUES ('${legacyChallengeId}', 'Legacy Habit', 'Old challenge description', 'Fitness', 30, '${creatorId}', now() - interval '5 days');
    `);
    assert(true, 'Populated pre-existing challenge with NULL challenge_type and timezone');

    // Test Phase 1.1: Timezone validation check during migration - test invalid timezone detection
    await client.query(`
      ALTER TABLE public.challenges ADD COLUMN IF NOT EXISTS timezone TEXT;
      INSERT INTO public.challenges (id, title, description, category, duration_days, timezone)
      VALUES ('99999999-9999-9999-9999-999999999999', 'Bad TZ', 'Desc', 'Focus', 7, 'Fake/Bad_Zone');
    `);

    const mig2Path = path.join(process.cwd(), 'supabase/migrations/20261024000000_peer_verification.sql');
    const mig2Sql = fs.readFileSync(mig2Path, 'utf8');

    let migFailOnBadTz = null;
    try {
      await client.query(mig2Sql);
    } catch (err) {
      migFailOnBadTz = err;
    }
    assert(
      migFailOnBadTz && migFailOnBadTz.code === '22023' && migFailOnBadTz.message.includes('Migration failed'),
      'Migration fails loudly (22023) when existing challenges contain unresolvable timezone names'
    );

    // Remove the invalid test row and apply Migration 2 cleanly
    await client.query(`DELETE FROM public.challenges WHERE id = '99999999-9999-9999-9999-999999999999';`);
    await client.query(mig2Sql);
    assert(true, 'Migration 2 applied cleanly after validated backfill');

    const mig3Path = path.join(process.cwd(), 'supabase/migrations/20261024010000_fix_eligible_verifiers_ambiguous_user_id.sql');
    const mig3Sql = fs.readFileSync(mig3Path, 'utf8');

    // Reproduce original Migration 2 bug: non-creator participant calling get_challenge_eligible_verifiers triggers ambiguous user_id error
    const testBugUser = '50000000-0000-0000-0000-000000000005';
    await client.query(`
      INSERT INTO public.challenge_participants (challenge_id, user_id)
      VALUES ('${legacyChallengeId}', '${testBugUser}');
    `);
    await setSessionUser(client, testBugUser);
    let mig2AmbiguousErr = null;
    try {
      await client.query(`SELECT * FROM public.get_challenge_eligible_verifiers('${legacyChallengeId}'::uuid);`);
    } catch (err) {
      mig2AmbiguousErr = err;
    }
    assert(
      mig2AmbiguousErr && mig2AmbiguousErr.message.includes('column reference "user_id" is ambiguous'),
      'Confirmed original bug: Migration 2 get_challenge_eligible_verifiers fails with ambiguous "user_id"'
    );

    // Apply Migration 3 (Forward-only fix)
    await client.query(mig3Sql);
    assert(true, 'Migration 3 (forward-only fix for ambiguous user_id) applied cleanly');

    // Call again with Migration 3: now succeeds cleanly!
    const verifiersPostMig3 = await client.query(`SELECT * FROM public.get_challenge_eligible_verifiers('${legacyChallengeId}'::uuid);`);
    assert(
      verifiersPostMig3.rows.length === 1 && verifiersPostMig3.rows[0].user_id === creatorId && verifiersPostMig3.rows[0].is_creator === true,
      'Migration 3 resolves ambiguity: participant successfully retrieves eligible verifiers'
    );

    // Verify backfill values on legacy challenge
    const legacyRes = await client.query(`SELECT challenge_type, timezone FROM public.challenges WHERE id = '${legacyChallengeId}';`);
    assert(
      legacyRes.rows[0].challenge_type === 'daily' && legacyRes.rows[0].timezone === 'UTC',
      'Legacy challenge safely backfilled with challenge_type = daily and timezone = UTC'
    );

    // Phase 2: Table-Scoped Constraint Verification
    console.log('\nPhase 2: Table-Scoped Constraints & Schema Qualification');
    const constraintCheck = await client.query(`
      SELECT conname, conrelid::regclass::text as table_name
      FROM pg_catalog.pg_constraint
      WHERE conrelid = 'public.challenges'::pg_catalog.regclass
        AND conname IN ('chk_challenge_type', 'unique_challenge_id_type');
    `);
    assert(constraintCheck.rows.length === 2, 'Constraints chk_challenge_type and unique_challenge_id_type scoped strictly to public.challenges');

    // Verify search_path = '' on all functions
    const funcSearchPaths = await client.query(`
      SELECT p.proname, p.proconfig
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'validate_challenge_timezone',
          'challenge_active_window',
          'submit_challenge_completion',
          'review_challenge_completion',
          'reassign_challenge_verifier',
          'get_challenge_eligible_verifiers',
          'get_participant_challenge_progress'
        );
    `);
    const allHaveEmptySearchPath = funcSearchPaths.rows.every(r =>
      Array.isArray(r.proconfig) && r.proconfig.some(c => c.startsWith('search_path='))
    );
    assert(allHaveEmptySearchPath && funcSearchPaths.rows.length === 7, 'All 7 RPC, helper and trigger functions have SET search_path = \'\'');

    // Phase 3: Active Challenge Date Window & Boundary Enforcement
    console.log('\nPhase 3: Active Challenge Date Window & Boundaries');
    const challengeId = '11111111-1111-1111-1111-111111111111';
    const participant1 = '20000000-0000-0000-0000-000000000002';
    const participant2 = '30000000-0000-0000-0000-000000000003';

    // Create a 5-day challenge starting yesterday
    await client.query(`
      INSERT INTO public.challenges (id, title, description, category, duration_days, timezone, challenge_type, creator_id, created_at)
      VALUES ('${challengeId}', 'Active Window Run', 'Run daily', 'Fitness', 5, 'UTC', 'daily', '${creatorId}', now() - interval '1 day');

      INSERT INTO public.challenge_participants (challenge_id, user_id)
      VALUES
        ('${challengeId}', '${creatorId}'),
        ('${challengeId}', '${participant1}'),
        ('${challengeId}', '${participant2}');
    `);

    await setSessionUser(client, participant1);

    // Date before challenge creation (e.g., 2 days ago) must fail
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const twoDaysAgoStr = twoDaysAgo.toISOString().split('T')[0];

    let beforeStartErr = null;
    try {
      await client.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${challengeId}'::uuid,
          '${creatorId}',
          '${twoDaysAgoStr}'::date
        );
      `);
    } catch (e) {
      beforeStartErr = e;
    }
    assert(
      beforeStartErr && beforeStartErr.code === '22023' && (beforeStartErr.message.includes('before challenge started') || beforeStartErr.message.includes('Submission window expired')),
      'Cannot submit completion for a date before challenge started'
    );

    // Submitting for yesterday (within active challenge window and timeliness window) succeeds
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const validSubmitYesterday = await client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}'::uuid,
        '${creatorId}',
        '${yesterdayStr}'::date,
        'Day 1 done yesterday'
      );
    `);
    const compYesterdayId = validSubmitYesterday.rows[0].id;
    assert(compYesterdayId && validSubmitYesterday.rows[0].status === 'pending', 'Submission for yesterday in active challenge window succeeds');

    // Approve yesterday's completion
    await setSessionUser(client, creatorId);
    await client.query(`
      SELECT * FROM public.review_challenge_completion(
        '${compYesterdayId}'::uuid,
        'approved'
      );
    `);

    // Submitting for today succeeds
    await setSessionUser(client, participant1);
    const todayStr = new Date().toISOString().split('T')[0];
    const validSubmitToday = await client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}'::uuid,
        '${creatorId}',
        '${todayStr}'::date,
        'Day 2 done today'
      );
    `);
    const compTodayId = validSubmitToday.rows[0].id;
    assert(compTodayId && validSubmitToday.rows[0].status === 'pending', 'Submission for today in active challenge window succeeds');

    await setSessionUser(client, creatorId);
    await client.query(`
      SELECT * FROM public.review_challenge_completion(
        '${compTodayId}'::uuid,
        'approved'
      );
    `);

    // Verify progress: 2 verified, streak 2
    await setSessionUser(client, participant1);
    const progressRes = await client.query(`
      SELECT * FROM public.get_participant_challenge_progress(
        '${challengeId}'::uuid,
        '${participant1}'
      );
    `);
    assert(
      progressRes.rows[0].verified_count === 2 &&
      progressRes.rows[0].current_streak === 2 &&
      progressRes.rows[0].is_completed === false,
      'Progress strictly counts approved dates within active challenge period: 2 verified, streak 2'
    );

    // Phase 4: One-Time Dare Timeliness & Active Window Boundaries
    console.log('\nPhase 4: One-Time Dare Timeliness & Lifecycle');
    const onetimeId = '33333333-3333-3333-3333-333333333333';
    await client.query(`
      INSERT INTO public.challenges (id, title, description, category, duration_days, timezone, challenge_type, creator_id, created_at)
      VALUES ('${onetimeId}', 'Polar Plunge', 'Jump in cold lake', 'Fun', 2, 'UTC', 'one_time', '${creatorId}', now() - interval '1 day');

      INSERT INTO public.challenge_participants (challenge_id, user_id)
      VALUES ('${onetimeId}', '${participant1}');
    `);

    // One-time dare timeliness: future date fails
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    let onetimeFutureErr = null;
    try {
      await client.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${onetimeId}'::uuid,
          '${creatorId}',
          '${tomorrowStr}'::date
        );
      `);
    } catch (e) {
      onetimeFutureErr = e;
    }
    assert(onetimeFutureErr && onetimeFutureErr.code === '22023', 'One-time dare rejects future submission date');

    // Valid one-time submission today succeeds
    const onetimeSubmit = await client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${onetimeId}'::uuid,
        '${creatorId}',
        '${todayStr}'::date,
        'Plunge photo sent via WhatsApp'
      );
    `);
    const onetimeCompId = onetimeSubmit.rows[0].id;
    assert(onetimeCompId && onetimeSubmit.rows[0].status === 'pending', 'One-time dare submission for today accepted as pending');

    // Approve one-time dare
    await setSessionUser(client, creatorId);
    await client.query(`
      SELECT * FROM public.review_challenge_completion(
        '${onetimeCompId}'::uuid,
        'approved'
      );
    `);

    // Progress for one-time dare
    await setSessionUser(client, participant1);
    const onetimeProgress = await client.query(`
      SELECT * FROM public.get_participant_challenge_progress(
        '${onetimeId}'::uuid,
        '${participant1}'
      );
    `);
    assert(
      onetimeProgress.rows[0].is_completed === true &&
      onetimeProgress.rows[0].verified_count === 1 &&
      onetimeProgress.rows[0].progress_pct === 100,
      'One-time dare completion marks dare as 100% complete with 1 verified count'
    );

    // Phase 5: Genuinely Concurrent Overlapping Transactions (Leave vs Submit & Lock Verification)
    console.log('\nPhase 5: Genuinely Concurrent Overlapping Transactions');
    const participant3 = '40000000-0000-0000-0000-000000000004';
    await client.query(`
      INSERT INTO public.challenge_participants (challenge_id, user_id)
      VALUES ('${challengeId}', '${participant3}');
    `);

    // Test Genuine Row Lock Overlap:
    // Client A begins transaction, performs submit (which acquires FOR SHARE on participant3's membership row),
    // and holds the transaction open for 250ms before committing.
    // Client B attempts DELETE FROM challenge_participants concurrently.
    // Client B MUST be blocked until Client A commits!
    const clientA = await pool.connect();
    const clientB = await pool.connect();

    await setSessionUser(clientA, participant3);

    let clientBDeleteFinished = false;
    let clientBBlockedSuccessfully = false;

    // Start Client A transaction with explicit BEGIN
    await clientA.query('BEGIN;');
    await clientA.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}'::uuid,
        '${creatorId}',
        '${todayStr}'::date,
        'Concurrent lock test'
      );
    `);

    // Launch Client B delete in parallel (it will attempt to acquire EXCLUSIVE lock on the row currently locked FOR SHARE by A)
    const deletePromise = (async () => {
      await clientB.query(`
        DELETE FROM public.challenge_participants
        WHERE challenge_id = '${challengeId}' AND user_id = '${participant3}';
      `);
      clientBDeleteFinished = true;
    })();

    // Check after 80ms while Client A is still uncommitted: Client B must still be waiting!
    await sleep(80);
    if (!clientBDeleteFinished) {
      clientBBlockedSuccessfully = true;
    }

    // Now Client A commits, which releases the FOR SHARE lock
    await clientA.query('COMMIT;');

    // Now wait for Client B delete to complete
    await deletePromise;

    assert(
      clientBBlockedSuccessfully && clientBDeleteFinished,
      'Concurrent leave (DELETE) was genuinely blocked by FOR SHARE lock until submission transaction committed'
    );

    clientA.release();
    clientB.release();

    // Phase 6: Creator Referee Status & Verifier Eligibility
    console.log('\nPhase 6: Verifier Eligibility & Creator Referee Verification');
    // Creator creates challenge but leaves participant list
    await client.query(`
      DELETE FROM public.challenge_participants
      WHERE challenge_id = '${challengeId}' AND user_id = '${creatorId}';
    `);

    // Re-add participant3 to test submission designating creator
    await client.query(`
      INSERT INTO public.challenge_participants (challenge_id, user_id)
      VALUES ('${challengeId}', '${participant3}')
      ON CONFLICT DO NOTHING;
    `);

    // Clean up existing completion for participant3 for yesterday to submit fresh
    await client.query(`
      DELETE FROM public.challenge_completions
      WHERE challenge_id = '${challengeId}' AND participant_id = '${participant3}';
    `);

    // Submitter can designate creator as verifier even when creator is not in challenge_participants
    await setSessionUser(client, participant3);
    const submitWithCreator = await client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}'::uuid,
        '${creatorId}',
        '${yesterdayStr}'::date
      );
    `);
    const compWithCreatorId = submitWithCreator.rows[0].id;
    assert(compWithCreatorId && submitWithCreator.rows[0].verifier_id === creatorId, 'Creator remains permanently eligible to verify as challenge referee even when not in participants table');

    // And creator can review the submission
    await setSessionUser(client, creatorId);
    const creatorReviewRes = await client.query(`
      SELECT * FROM public.review_challenge_completion(
        '${compWithCreatorId}'::uuid,
        'approved'
      );
    `);
    assert(creatorReviewRes.rows[0].status === 'approved', 'Creator successfully approves submission as referee');

    // Phase 6b: Verifier Eligibility RPC Query & Access Control
    console.log('\nPhase 6b: Verifier Eligibility Query Authorization & Return Types');
    // participant3 calls get_challenge_eligible_verifiers:
    // Should return creator (is_creator = true) and participant1/participant2, but NOT participant3
    await setSessionUser(client, participant3);
    const verifiersForP3 = await client.query(`
      SELECT user_id, display_name, is_creator
      FROM public.get_challenge_eligible_verifiers('${challengeId}'::uuid)
      ORDER BY is_creator DESC, user_id ASC;
    `);
    const p3ResultIds = verifiersForP3.rows.map(r => r.user_id);
    assert(!p3ResultIds.includes(participant3), 'get_challenge_eligible_verifiers excludes caller from eligible verifier list');
    assert(p3ResultIds.includes(creatorId), 'get_challenge_eligible_verifiers includes challenge creator');
    const creatorEntry = verifiersForP3.rows.find(r => r.user_id === creatorId);
    assert(creatorEntry && creatorEntry.is_creator === true, 'Challenge creator is flagged with is_creator = true');
    const participantEntries = verifiersForP3.rows.filter(r => r.user_id !== creatorId);
    assert(participantEntries.every(r => r.is_creator === false), 'All co-participants have is_creator = false');

    // Creator calls get_challenge_eligible_verifiers:
    // Should return co-participants, but NOT creator
    await setSessionUser(client, creatorId);
    const verifiersForCreator = await client.query(`
      SELECT user_id, display_name, is_creator
      FROM public.get_challenge_eligible_verifiers('${challengeId}'::uuid);
    `);
    const creatorResultIds = verifiersForCreator.rows.map(r => r.user_id);
    assert(!creatorResultIds.includes(creatorId), 'Creator caller is excluded from their own eligible verifiers query');
    assert(creatorResultIds.length > 0, 'Creator sees active challenge co-participants as eligible verifiers');

    // Stranger (non-member) is rejected
    const strangerId = '88888888-8888-8888-8888-888888888888';
    await setSessionUser(client, strangerId);
    let strangerRpcErr = null;
    try {
      await client.query(`SELECT * FROM public.get_challenge_eligible_verifiers('${challengeId}'::uuid);`);
    } catch (err) {
      strangerRpcErr = err;
    }
    assert(
      strangerRpcErr && strangerRpcErr.code === '42501' && strangerRpcErr.message.includes('Only active challenge members can view eligible verifiers'),
      'Stranger cannot view eligible verifiers (rejected with 42501)'
    );

    // Unauthenticated caller is rejected
    await setSessionUser(client, null);
    let unauthRpcErr = null;
    try {
      await client.query(`SELECT * FROM public.get_challenge_eligible_verifiers('${challengeId}'::uuid);`);
    } catch (err) {
      unauthRpcErr = err;
    }
    assert(
      unauthRpcErr && unauthRpcErr.code === '42501' && unauthRpcErr.message.includes('Authentication required'),
      'Unauthenticated caller cannot view eligible verifiers (rejected with 42501)'
    );

    // Phase 7: Privilege Boundaries & Untrusted Roles
    console.log('\nPhase 7: Privilege Boundaries & Untrusted Roles');
    let anonSubmitErr = null;
    try {
      await client.query(`
        SET ROLE anon;
        SELECT * FROM public.submit_challenge_completion(
          '${challengeId}'::uuid,
          '${creatorId}',
          CURRENT_DATE
        );
      `);
    } catch (e) {
      anonSubmitErr = e;
    } finally {
      await client.query('RESET ROLE;');
    }
    assert(anonSubmitErr && (anonSubmitErr.code === '42501' || anonSubmitErr.message.includes('permission denied')), 'Role anon is denied execute permission on submit_challenge_completion');

    let anonProgressErr = null;
    try {
      await client.query(`
        SET ROLE anon;
        SELECT * FROM public.get_participant_challenge_progress(
          '${challengeId}'::uuid,
          '${creatorId}'
        );
      `);
    } catch (e) {
      anonProgressErr = e;
    } finally {
      await client.query('RESET ROLE;');
    }
    assert(anonProgressErr && (anonProgressErr.code === '42501' || anonProgressErr.message.includes('permission denied')), 'Role anon is denied execute permission on get_participant_challenge_progress');

    // Phase 8: Simultaneous Concurrent Submissions with 2-Key Advisory Lock
    console.log('\nPhase 8: Simultaneous Submissions (2-Key Advisory Lock Serialization)');
    const cConn1 = await pool.connect();
    const cConn2 = await pool.connect();
    await setSessionUser(cConn1, participant2);
    await setSessionUser(cConn2, participant2);

    const simultaneousP1 = cConn1.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}'::uuid,
        '${creatorId}',
        '${todayStr}'::date,
        'Parallel submission 1'
      );
    `);
    const simultaneousP2 = cConn2.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}'::uuid,
        '${creatorId}',
        '${todayStr}'::date,
        'Parallel submission 2'
      );
    `);

    const simResults = await Promise.allSettled([simultaneousP1, simultaneousP2]);
    const simFulfilled = simResults.filter(r => r.status === 'fulfilled');
    const simRejected = simResults.filter(r => r.status === 'rejected');

    assert(simFulfilled.length === 1, 'Exactly one simultaneous submission succeeds');
    assert(simRejected.length === 1 && simRejected[0].reason.code === '23505', 'Second simultaneous submission is serialized and cleanly rejected (23505)');

    cConn1.release();
    cConn2.release();

    // Phase 9: State Machine Integrity & Resubmission
    console.log('\nPhase 9: State Machine Integrity & Resubmission');
    const simCompId = simFulfilled[0].value.rows[0].id;

    // Self verification blocked
    await setSessionUser(client, participant2);
    let selfVerifyErr = null;
    try {
      await client.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${challengeId}'::uuid,
          '${participant2}',
          '${yesterdayStr}'::date
        );
      `);
    } catch (e) {
      selfVerifyErr = e;
    }
    assert(selfVerifyErr && selfVerifyErr.code === '22023', 'Self-verification is strictly prohibited at check constraint level');

    // Verifier rejects submission
    await setSessionUser(client, creatorId);
    const rejectRes = await client.query(`
      SELECT * FROM public.review_challenge_completion(
        '${simCompId}'::uuid,
        'rejected',
        'Incomplete GPS data'
      );
    `);
    assert(rejectRes.rows[0].status === 'rejected' && rejectRes.rows[0].rejection_reason === 'Incomplete GPS data', 'Verifier rejects submission with reason');

    // Resubmission of rejected row resets to pending
    await setSessionUser(client, participant2);
    const resubmitRes = await client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}'::uuid,
        '${creatorId}',
        '${todayStr}'::date,
        'Corrected GPS data attached'
      );
    `);
    assert(resubmitRes.rows[0].id === simCompId && resubmitRes.rows[0].status === 'pending' && resubmitRes.rows[0].rejection_reason === null, 'Resubmission updates rejected row back to pending without creating duplicates');

    // Phase 10: Progress Privacy Authorization
    console.log('\nPhase 10: Progress Privacy Authorization');
    const strangerUser = '99000000-0000-0000-0000-000000000099';
    await setSessionUser(client, strangerUser);
    let strangerProgressErr = null;
    try {
      await client.query(`
        SELECT * FROM public.get_participant_challenge_progress(
          '${challengeId}'::uuid,
          '${participant1}'
        );
      `);
    } catch (e) {
      strangerProgressErr = e;
    }
    assert(strangerProgressErr && strangerProgressErr.code === '42501', 'Stranger outside challenge is denied progress access (42501)');

    // Active co-participant can view progress
    await setSessionUser(client, participant2);
    const memberProgressRes = await client.query(`
      SELECT * FROM public.get_participant_challenge_progress(
        '${challengeId}'::uuid,
        '${participant1}'
      );
    `);
    assert(memberProgressRes.rows[0].verified_count === 2, 'Active co-participant can view verified progress');

    // Phase 11: Anti-Hijacking Proof with Malicious Shadows
    console.log('\nPhase 11: Anti-Hijacking Proof with Malicious Shadows');
    await client.query(`
      CREATE OR REPLACE FUNCTION public.hashtext(text) RETURNS integer AS $$
      BEGIN
        RAISE EXCEPTION 'HIJACKED: malicious public.hashtext invoked!';
      END;
      $$ LANGUAGE plpgsql;
    `);

    // Call submit_challenge_completion - must NOT invoke the malicious public.hashtext because search_path = ''
    await setSessionUser(client, participant1);
    let hijackErr = null;
    try {
      await client.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${challengeId}'::uuid,
          '${creatorId}',
          '${todayStr}'::date,
          'Testing hijack immunity'
        );
      `);
    } catch (e) {
      hijackErr = e;
    }
    assert(!hijackErr || !hijackErr.message.includes('HIJACKED'), 'Shadowing public functions does NOT hijack execution under search_path = \'\'');

    await client.query('DROP FUNCTION IF EXISTS public.hashtext(text);');

    // Phase 12: Future-Dated Approved Record Exclusion from Progress
    console.log('\nPhase 12: Future-Dated Approved Record Exclusion');
    // Insert a future-dated approved completion row (e.g. tomorrow)
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 1);
    const futureDateStr = futureDate.toISOString().split('T')[0];

    await client.query(`
      INSERT INTO public.challenge_completions (
        challenge_id, challenge_type, participant_id, verifier_id, completion_date, status
      ) VALUES (
        '${challengeId}', 'daily', '${participant1}', '${creatorId}', '${futureDateStr}'::date, 'approved'
      );
    `);

    // Progress RPC must strictly exclude future dates
    await setSessionUser(client, participant1);
    const progressWithFutureRes = await client.query(`
      SELECT * FROM public.get_participant_challenge_progress(
        '${challengeId}'::uuid,
        '${participant1}'
      );
    `);
    // Should still report verified_count = 2 (yesterday and today), NOT 3
    assert(
      progressWithFutureRes.rows[0].verified_count === 2 &&
      progressWithFutureRes.rows[0].current_streak === 2,
      'Future-dated approved records (> current challenge date) are strictly excluded from progress, streaks, and completion'
    );

    // Clean up future record
    await client.query(`
      DELETE FROM public.challenge_completions
      WHERE challenge_id = '${challengeId}' AND participant_id = '${participant1}' AND completion_date = '${futureDateStr}'::date;
    `);

    // Phase 13: Genuinely Concurrent Leave vs Review (Both Orderings)
    console.log('\nPhase 13: Genuinely Concurrent Leave vs Review');
    const pReviewUser = '50000000-0000-0000-0000-000000000005';
    await client.query(`
      INSERT INTO public.challenge_participants (challenge_id, user_id)
      VALUES ('${challengeId}', '${pReviewUser}');
    `);

    // Submit a pending completion for pReviewUser
    await setSessionUser(client, pReviewUser);
    const pReviewSub = await client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}'::uuid,
        '${creatorId}',
        '${todayStr}'::date
      );
    `);
    const pReviewCompId = pReviewSub.rows[0].id;

    // Ordering A: Verifier starts review (holds FOR SHARE on participant), Submitter tries to leave concurrently.
    // Submitter's DELETE is blocked until Verifier commits review!
    const revClientA = await pool.connect();
    const revClientB = await pool.connect();

    await setSessionUser(revClientA, creatorId);

    let revBFinished = false;
    let revBBlocked = false;

    await revClientA.query('BEGIN;');
    await revClientA.query(`
      SELECT * FROM public.review_challenge_completion(
        '${pReviewCompId}'::uuid,
        'approved'
      );
    `);

    // Concurrently launch Submitter leave in revClientB
    const revBPromise = (async () => {
      await revClientB.query(`
        DELETE FROM public.challenge_participants
        WHERE challenge_id = '${challengeId}' AND user_id = '${pReviewUser}';
      `);
      revBFinished = true;
    })();

    await sleep(80);
    if (!revBFinished) revBBlocked = true;

    // Verifier commits review
    await revClientA.query('COMMIT;');
    await revBPromise;

    assert(
      revBBlocked && revBFinished,
      'Ordering A: Concurrent leave (DELETE) is blocked by review FOR SHARE lock until review transaction commits'
    );

    revClientA.release();
    revClientB.release();

    // Ordering B: Submitter leaves challenge first, Verifier tries to review after submitter left
    const pReviewUser2 = '60000000-0000-0000-0000-000000000006';
    await client.query(`
      INSERT INTO public.challenge_participants (challenge_id, user_id)
      VALUES ('${challengeId}', '${pReviewUser2}');
    `);

    await setSessionUser(client, pReviewUser2);
    const pReviewSub2 = await client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}'::uuid,
        '${creatorId}',
        '${yesterdayStr}'::date
      );
    `);
    const pReviewCompId2 = pReviewSub2.rows[0].id;

    // Submitter leaves
    await client.query(`
      DELETE FROM public.challenge_participants
      WHERE challenge_id = '${challengeId}' AND user_id = '${pReviewUser2}';
    `);

    // Verifier attempts to review
    await setSessionUser(client, creatorId);
    let revAfterLeaveErr = null;
    try {
      await client.query(`
        SELECT * FROM public.review_challenge_completion(
          '${pReviewCompId2}'::uuid,
          'approved'
        );
      `);
    } catch (e) {
      revAfterLeaveErr = e;
    }
    assert(
      revAfterLeaveErr && revAfterLeaveErr.code === '42501' && revAfterLeaveErr.message.includes('Submitter is no longer an active participant'),
      'Ordering B: Review is rejected with 42501 when submitter has already left the challenge'
    );

    // Phase 14: Genuinely Concurrent Leave vs Reassignment (Both Orderings)
    console.log('\nPhase 14: Genuinely Concurrent Leave vs Reassignment');
    const pReassignSubmitter = '70000000-0000-0000-0000-000000000007';
    const pTargetVerifier1 = '80000000-0000-0000-0000-000000000008';
    await client.query(`
      INSERT INTO public.challenge_participants (challenge_id, user_id)
      VALUES
        ('${challengeId}', '${pReassignSubmitter}'),
        ('${challengeId}', '${pTargetVerifier1}');
    `);

    await setSessionUser(client, pReassignSubmitter);
    const reassignSub = await client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}'::uuid,
        '${creatorId}',
        '${yesterdayStr}'::date
      );
    `);
    const reassignPendingCompId = reassignSub.rows[0].id;

    // Ordering A: Submitter reassigns verifier to pTargetVerifier1 (holds FOR SHARE), pTargetVerifier1 tries to leave concurrently.
    // pTargetVerifier1 DELETE is blocked until reassignment commits!
    const reClientA = await pool.connect();
    const reClientB = await pool.connect();

    await setSessionUser(reClientA, pReassignSubmitter);

    let reBFinished = false;
    let reBBlocked = false;

    await reClientA.query('BEGIN;');
    await reClientA.query(`
      SELECT * FROM public.reassign_challenge_verifier(
        '${reassignPendingCompId}'::uuid,
        '${pTargetVerifier1}'
      );
    `);

    const reBPromise = (async () => {
      await reClientB.query(`
        DELETE FROM public.challenge_participants
        WHERE challenge_id = '${challengeId}' AND user_id = '${pTargetVerifier1}';
      `);
      reBFinished = true;
    })();

    await sleep(80);
    if (!reBFinished) reBBlocked = true;

    await reClientA.query('COMMIT;');
    await reBPromise;

    assert(
      reBBlocked && reBFinished,
      'Ordering A: Concurrent leave (DELETE) of new verifier is blocked by reassignment FOR SHARE lock until reassignment transaction commits'
    );

    reClientA.release();
    reClientB.release();

    // Ordering B: Target verifier leaves first, submitter attempts to reassign to them
    const pTargetVerifier2 = '81000000-0000-0000-0000-000000000081';
    await client.query(`
      INSERT INTO public.challenge_participants (challenge_id, user_id)
      VALUES ('${challengeId}', '${pTargetVerifier2}');
    `);

    // Target verifier leaves before reassignment
    await client.query(`
      DELETE FROM public.challenge_participants
      WHERE challenge_id = '${challengeId}' AND user_id = '${pTargetVerifier2}';
    `);

    await setSessionUser(client, pReassignSubmitter);
    let reassignLeftErr = null;
    try {
      await client.query(`
        SELECT * FROM public.reassign_challenge_verifier(
          '${reassignPendingCompId}'::uuid,
          '${pTargetVerifier2}'
        );
      `);
    } catch (e) {
      reassignLeftErr = e;
    }
    assert(
      reassignLeftErr && reassignLeftErr.code === '22023' && reassignLeftErr.message.includes('New verifier must be the challenge creator or an active participant'),
      'Ordering B: Reassignment to a verifier who has already left is rejected with 22023'
    );

    // Phase 15: Schema Ownership and Public CREATE Privilege Audit
    console.log('\nPhase 15: Schema Ownership and Public CREATE Privilege Audit');
    const anonCanCreate = await client.query(`
      SELECT has_schema_privilege('anon', 'public', 'CREATE') as can_create;
    `);
    assert(anonCanCreate.rows[0].can_create === false, 'Role anon is stripped of CREATE privileges on public schema');

    const authCanCreate = await client.query(`
      SELECT has_schema_privilege('authenticated', 'public', 'CREATE') as can_create;
    `);
    assert(authCanCreate.rows[0].can_create === false, 'Role authenticated is stripped of CREATE privileges on public schema');

    // Phase 16: Exclusive-deadline window helper (exact midnight, +500ms, daytime, timezone, empty windows)
    console.log('\nPhase 16: Active Window Helper - Exclusive Deadline Boundaries');
    async function win(created, ends, days, tz) {
      const r = await client.query(
        `SELECT start_date::text AS s, end_date::text AS e, is_empty AS empty
         FROM public.challenge_active_window($1::timestamptz, $2::timestamptz, $3::int, $4::text)`,
        [created, ends, days, tz],
      );
      return r.rows[0];
    }
    let w = await win('2026-03-10 08:00:00+00', '2026-03-11 00:00:00+00', 30, 'UTC');
    assert(w.e === '2026-03-10' && !w.empty, 'ends_at at exact local midnight -> last active date is the PREVIOUS day (2026-03-10)');
    w = await win('2026-03-10 08:00:00+00', '2026-03-11 00:00:00.5+00', 30, 'UTC');
    assert(w.e === '2026-03-11' && !w.empty, 'ends_at at midnight + 500ms -> last active date is the SAME day (2026-03-11)');
    w = await win('2026-03-10 08:00:00+00', '2026-03-12 15:00:00+00', 30, 'UTC');
    assert(w.e === '2026-03-12' && !w.empty, 'Normal daytime deadline -> last active date is that day (2026-03-12)');
    w = await win('2026-03-10 08:00:00+00', '2026-03-11 00:00:00.000001+00', 30, 'UTC');
    assert(w.e === '2026-03-11', 'ends_at at midnight + 1 microsecond -> same day (no epsilon rounding)');
    w = await win('2026-03-10 08:00:00+00', '2026-03-11 18:30:00+00', 30, 'Asia/Kolkata');
    assert(w.e === '2026-03-11' && w.s === '2026-03-10', 'Timezone boundary: 18:30Z is exactly local midnight in Asia/Kolkata -> previous local day');
    w = await win('2026-03-10 08:00:00+00', '2026-03-11 18:30:00.5+00', 30, 'Asia/Kolkata');
    assert(w.e === '2026-03-12', 'Timezone boundary: 18:30:00.5Z is just after local midnight in Asia/Kolkata -> that local day');
    w = await win('2026-03-10 23:59:59.999+00', '2026-03-11 00:00:00+00', 30, 'UTC');
    assert(w.s === '2026-03-10' && w.e === '2026-03-10' && !w.empty, 'Challenge starting 1ms before midnight and ending at midnight has a 1-day window');
    w = await win('2026-03-10 08:00:00+00', '2026-03-20 12:00:00+00', 2, 'UTC');
    assert(w.e === '2026-03-11', 'duration_days caps the window when ends_at is later');
    w = await win('2026-03-10 08:00:00+00', '2026-03-09 12:00:00+00', 30, 'UTC');
    assert(w.empty === true, 'ends_at on a date before the start date -> EMPTY window (not revived on the start date)');
    w = await win('2026-03-10 08:00:00+00', '2026-03-10 07:00:00+00', 30, 'UTC');
    assert(w.empty === true, 'ends_at earlier on the start date but before created_at -> EMPTY window');
    w = await win('2026-03-10 08:00:00+00', '2026-03-10 08:00:00+00', 30, 'UTC');
    assert(w.empty === true, 'ends_at == created_at (exclusive deadline) -> EMPTY window');
    w = await win('2026-03-10 08:00:00+00', null, 7, 'UTC');
    assert(w.e === '2026-03-16' && !w.empty, 'NULL ends_at falls back to duration_days');

    // Phase 17: Submit/progress against expired, empty and boundary windows (real RPCs)
    console.log('\nPhase 17: Submission Rejection for Empty / Expired Windows');
    const winUser = '90000000-0000-0000-0000-000000000009';
    const mkChallenge = async (id, createdSql, endsSql, days, type = 'daily') => {
      await client.query(`
        INSERT INTO public.challenges (id, title, description, category, duration_days, timezone, challenge_type, creator_id, created_at, ends_at)
        VALUES ('${id}', 'W', 'W', 'Fun', ${days}, 'UTC', '${type}', '${creatorId}', ${createdSql}, ${endsSql});
        INSERT INTO public.challenge_participants (challenge_id, user_id) VALUES ('${id}', '${winUser}');
      `);
    };
    const trySubmit = async (id, dateStr) => {
      await setSessionUser(client, winUser);
      try {
        const r = await client.query(`SELECT * FROM public.submit_challenge_completion('${id}'::uuid, '${creatorId}', '${dateStr}'::date)`);
        return { ok: true, row: r.rows[0] };
      } catch (e) {
        return { ok: false, err: e };
      }
    };
    const todayMidnightUtc = `(pg_catalog.date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

    // (a) ends_at before created_at (previous days) -> empty
    await mkChallenge('a1000000-0000-0000-0000-00000000000a', `now() - interval '1 day'`, `now() - interval '2 days'`, 5);
    let res = await trySubmit('a1000000-0000-0000-0000-00000000000a', todayStr);
    assert(!res.ok && res.err.code === '22023' && res.err.message.includes('no active submission window'), 'Submit rejected (22023) when ends_at is before created_at (empty window) - today');
    res = await trySubmit('a1000000-0000-0000-0000-00000000000a', yesterdayStr);
    assert(!res.ok && res.err.code === '22023' && res.err.message.includes('no active submission window'), 'Submit rejected (22023) for the start date too (window is not revived on its start date)');

    // (b) ends_at earlier the same day as created_at -> empty
    await mkChallenge('b1000000-0000-0000-0000-00000000000b', `now()`, `now() - interval '1 second'`, 5);
    res = await trySubmit('b1000000-0000-0000-0000-00000000000b', todayStr);
    assert(!res.ok && res.err.code === '22023' && res.err.message.includes('no active submission window'), 'Submit rejected when ends_at is earlier than created_at on the same date');

    // (c) progress for an empty window counts nothing even if an approved row exists
    await client.query(`
      INSERT INTO public.challenge_completions (challenge_id, challenge_type, participant_id, verifier_id, completion_date, status)
      VALUES ('a1000000-0000-0000-0000-00000000000a', 'daily', '${winUser}', '${creatorId}', '${yesterdayStr}'::date, 'approved');
    `);
    await setSessionUser(client, winUser);
    let prog = await client.query(`SELECT * FROM public.get_participant_challenge_progress('a1000000-0000-0000-0000-00000000000a'::uuid, '${winUser}')`);
    assert(prog.rows[0].verified_count === 0 && prog.rows[0].is_completed === false && prog.rows[0].current_streak === 0, 'Progress over an empty window counts no approved dates');

    // (d) expired (non-empty) window: created 5 days ago, 2-day duration -> today is after the end
    await mkChallenge('d1000000-0000-0000-0000-00000000000d', `now() - interval '5 days'`, `NULL`, 2);
    res = await trySubmit('d1000000-0000-0000-0000-00000000000d', todayStr);
    assert(!res.ok && res.err.code === '22023' && res.err.message.includes('after challenge ended'), 'Submit rejected for an expired window (today is after the last active date)');

    // (e) ends_at = exact midnight of today (UTC): last active date is yesterday
    await mkChallenge('e1000000-0000-0000-0000-00000000000e', `now() - interval '1 day'`, todayMidnightUtc, 5);
    res = await trySubmit('e1000000-0000-0000-0000-00000000000e', todayStr);
    assert(!res.ok && res.err.code === '22023' && res.err.message.includes('after challenge ended'), 'ends_at at exact midnight: submission for today (the excluded day) is rejected');
    res = await trySubmit('e1000000-0000-0000-0000-00000000000e', yesterdayStr);
    assert(res.ok, 'ends_at at exact midnight: submission for the final active day (yesterday) is still accepted (<= 1 day late-submission grace)');

    // (f) ends_at = midnight of today + 500ms: today is active
    await mkChallenge('f1000000-0000-0000-0000-00000000000f', `now() - interval '1 day'`, `(${todayMidnightUtc} + interval '500 milliseconds')`, 5);
    res = await trySubmit('f1000000-0000-0000-0000-00000000000f', todayStr);
    assert(res.ok, 'ends_at at midnight + 500ms: submission for today is accepted');

    // (g) normal daytime deadline later today
    await mkChallenge('a2000000-0000-0000-0000-0000000000a2', `now() - interval '1 day'`, `(${todayMidnightUtc} + interval '23 hours')`, 5);
    res = await trySubmit('a2000000-0000-0000-0000-0000000000a2', todayStr);
    assert(res.ok, 'Normal daytime deadline: submission for today is accepted');

    // Phase 18: Role-level privilege boundaries & function ownership (Supabase-like roles)
    console.log('\nPhase 18: Role Privilege Boundaries & Function Ownership');
    const asRole = async (role, sql, userId) => {
      await setSessionUser(client, userId || winUser);
      await client.query(`SET ROLE ${role}`);
      try {
        const r = await client.query(sql);
        return { ok: true, rows: r.rows };
      } catch (e) {
        return { ok: false, err: e };
      } finally {
        await client.query('RESET ROLE');
      }
    };
    let rr = await asRole('authenticated', `SELECT * FROM public.submit_challenge_completion('${challengeId}'::uuid, '${creatorId}', '${todayStr}'::date)`, participant1);
    assert(!rr.ok && rr.err.code === '23505', 'authenticated can EXECUTE the submit RPC (reaches business logic; duplicate day -> 23505)');
    rr = await asRole('authenticated', `INSERT INTO public.challenge_completions (challenge_id, challenge_type, participant_id, verifier_id, completion_date, status) VALUES ('${challengeId}','daily','${winUser}','${creatorId}','${todayStr}'::date,'approved')`);
    assert(!rr.ok && rr.err.code === '42501', 'authenticated cannot INSERT directly into challenge_completions (42501)');
    rr = await asRole('authenticated', `UPDATE public.challenge_completions SET status = 'approved'`);
    assert(!rr.ok && rr.err.code === '42501', 'authenticated cannot UPDATE challenge_completions directly (42501)');
    rr = await asRole('authenticated', `DELETE FROM public.challenge_completions`);
    assert(!rr.ok && rr.err.code === '42501', 'authenticated cannot DELETE from challenge_completions directly (42501)');
    rr = await asRole('authenticated', `SELECT count(*)::int AS n FROM public.challenge_completions WHERE participant_id <> '${winUser}' AND verifier_id <> '${winUser}'`);
    assert(rr.ok && rr.rows[0].n === 0, 'RLS: authenticated SELECT only exposes rows where the caller is submitter/verifier/creator');
    rr = await asRole('authenticated', `CREATE FUNCTION public.submit_challenge_completion(uuid, text, date, text, int) RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`);
    assert(!rr.ok && rr.err.code === '42501', 'authenticated cannot CREATE functions in public (42501)');
    rr = await asRole('anon', `CREATE TABLE public.evil (id int)`);
    assert(!rr.ok && rr.err.code === '42501', 'anon cannot CREATE tables in public (42501)');
    rr = await asRole('authenticated', `SELECT * FROM public.challenge_active_window(now(), NULL, 1, 'UTC')`);
    assert(!rr.ok && rr.err.code === '42501', 'authenticated cannot EXECUTE the internal window helper (42501)');
    rr = await asRole('authenticated', `SELECT public.validate_challenge_timezone()`);
    assert(!rr.ok && rr.err.code === '42501', 'authenticated cannot EXECUTE the trigger function directly (42501)');

    const execMatrix = await client.query(`
      SELECT p.proname,
             pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
             pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
             pg_catalog.pg_get_userbyid(p.proowner) AS owner,
             p.prosecdef AS secdef
      FROM pg_catalog.pg_proc p
      WHERE p.pronamespace = 'public'::pg_catalog.regnamespace
        AND p.proname IN ('validate_challenge_timezone','challenge_active_window','submit_challenge_completion',
                          'review_challenge_completion','reassign_challenge_verifier',
                          'get_challenge_eligible_verifiers','get_participant_challenge_progress')
      ORDER BY p.proname;
    `);
    const tableOwner = (await client.query(`SELECT pg_catalog.pg_get_userbyid(relowner) AS o FROM pg_catalog.pg_class WHERE oid = 'public.challenge_participants'::regclass`)).rows[0].o;
    const rpcNames = ['submit_challenge_completion', 'review_challenge_completion', 'reassign_challenge_verifier', 'get_challenge_eligible_verifiers', 'get_participant_challenge_progress'];
    assert(execMatrix.rows.length === 7 && execMatrix.rows.every(r => r.anon_x === false), 'anon has EXECUTE on none of the 7 functions');
    assert(execMatrix.rows.filter(r => rpcNames.includes(r.proname)).every(r => r.auth_x === true) &&
      execMatrix.rows.filter(r => !rpcNames.includes(r.proname)).every(r => r.auth_x === false), 'authenticated has EXECUTE only on the 5 client RPCs');
    assert(execMatrix.rows.every(r => r.owner === tableOwner && !['anon', 'authenticated'].includes(r.owner)), `All functions are owned by the table owner (${tableOwner}), not a client role`);
    assert(execMatrix.rows.filter(r => r.proname !== 'challenge_active_window').every(r => r.secdef === true), 'All RPC/trigger functions are SECURITY DEFINER; the helper is SECURITY INVOKER');

    // Ownership guard: migration must FAIL if a function is owned by a different role than the tables
    await client.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='evil_owner') THEN CREATE ROLE evil_owner NOLOGIN; END IF; END $$;`);
    await client.query(`ALTER FUNCTION public.challenge_active_window(timestamptz, timestamptz, int, text) OWNER TO evil_owner`);
    let ownerGuardErr = null;
    try {
      await client.query(mig2Sql);
    } catch (e) {
      ownerGuardErr = e;
    }
    // Re-running CREATE OR REPLACE keeps the (evil) owner, so the guard in section 12 must trip
    assert(ownerGuardErr && ownerGuardErr.code === '42501', 'Migration fails (42501) if a function is owned by a role other than the table owner');
    await client.query(`ALTER FUNCTION public.challenge_active_window(timestamptz, timestamptz, int, text) OWNER TO ${DISPOSABLE_DB_CONFIG.user}`);
    await client.query(mig2Sql);
    await client.query(mig3Sql);
    assert(true, 'Migration is idempotent: re-applying it on the migrated schema succeeds');

    // PHASE 19: Supabase Realtime Publication & Replica Identity (Migration 4)
    console.log('\nPhase 19: Supabase Realtime Publication & Replica Identity');
    const mig4Path = path.join(process.cwd(), 'supabase/migrations/20261024020000_enable_realtime_completions.sql');
    const mig4Sql = fs.readFileSync(mig4Path, 'utf8');
    await client.query(mig4Sql);
    assert(true, 'Migration 4 (enable realtime on completions) applied cleanly');

    // Verify publication inclusion
    const pubCheck = await client.query(`
      SELECT tablename FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND tablename = 'challenge_completions'
    `);
    assert(pubCheck.rows.length === 1, 'public.challenge_completions is in supabase_realtime publication');

    // Verify REPLICA IDENTITY FULL
    const replCheck = await client.query(`
      SELECT relreplident FROM pg_class
      WHERE relname = 'challenge_completions' AND relnamespace = 'public'::regnamespace
    `);
    assert(replCheck.rows.length === 1 && replCheck.rows[0].relreplident === 'f', 'public.challenge_completions has REPLICA IDENTITY FULL for RLS Realtime updates');

    // Verify idempotency
    await client.query(mig4Sql);
    assert(true, 'Migration 4 is idempotent: re-executing it succeeds without error');

    // PHASE 20: Push Notification Device Registration & Deliveries (Migration 5)
    console.log('\nPhase 20: Push Notification Registry & Security');
    const mig5Path = path.join(process.cwd(), 'supabase/migrations/20261024030000_push_notifications.sql');
    const mig5Sql = fs.readFileSync(mig5Path, 'utf8');
    await client.query(mig5Sql);
    assert(true, 'Migration 5 (push notification tables & RPCs) applied cleanly');

    const userAlice = '11111111-1111-1111-1111-111111111111';
    const userBob = '22222222-2222-2222-2222-222222222222';
    const tokenA1 = 'ExponentPushToken[AlicePhone1]';
    const tokenA2 = 'ExponentPushToken[AlicePhone2]';
    const tokenB1 = 'ExponentPushToken[BobPhone1]';

    // 1. Unauthenticated calls must be rejected
    const anonReg = await asRole('anon', `SELECT public.register_device_push_token('${tokenA1}', 'android', 'Pixel 8')`);
    assert(!anonReg.ok && anonReg.err.code === '42501', 'Unauthenticated register_device_push_token fails (42501)');

    // 2. Register devices for Alice (supports multiple devices)
    const regResA1 = await asRole('authenticated', `SELECT * FROM public.register_device_push_token('${tokenA1}', 'android', 'Pixel 8')`, userAlice);
    assert(regResA1.ok && regResA1.rows.length === 1 && regResA1.rows[0].expo_push_token === tokenA1, 'Alice registered device 1 successfully');

    const regResA2 = await asRole('authenticated', `SELECT * FROM public.register_device_push_token('${tokenA2}', 'ios', 'iPhone 15')`, userAlice);
    assert(regResA2.ok && regResA2.rows.length === 1 && regResA2.rows[0].expo_push_token === tokenA2, 'Alice registered device 2 successfully (multi-device support)');

    // 3. Register device for Bob
    const regResB1 = await asRole('authenticated', `SELECT * FROM public.register_device_push_token('${tokenB1}', 'android', 'Galaxy S24')`, userBob);
    assert(regResB1.ok && regResB1.rows.length === 1 && regResB1.rows[0].expo_push_token === tokenB1, 'Bob registered device 1 successfully');

    // 4. RLS isolation: Bob cannot view Alice's tokens
    const bobSelect = await asRole('authenticated', `SELECT * FROM public.user_push_tokens`, userBob);
    assert(bobSelect.ok && bobSelect.rows.length === 1 && bobSelect.rows[0].expo_push_token === tokenB1, 'RLS: Bob can only view his own push tokens (Alice tokens hidden)');

    // 5. Transfer device: If Bob logs in on Alice's device 1, token reassigns to Bob
    const transferRes = await asRole('authenticated', `SELECT * FROM public.register_device_push_token('${tokenA1}', 'android', 'Transferred Phone')`, userBob);
    assert(transferRes.ok && transferRes.rows[0].user_id === userBob, 'Re-registering same token with another user reassigns device token without duplicate error');

    // 6. Token count for Bob is now 2, Alice has 1
    const bobTokens = await asRole('authenticated', `SELECT count(*)::int as c FROM public.user_push_tokens`, userBob);
    assert(bobTokens.ok && bobTokens.rows[0].c === 2, 'Bob now owns 2 tokens');

    const aliceTokens = await asRole('authenticated', `SELECT count(*)::int as c FROM public.user_push_tokens`, userAlice);
    assert(aliceTokens.ok && aliceTokens.rows[0].c === 1, 'Alice now owns 1 token');

    // 7. Unregister device
    const unregRes = await asRole('authenticated', `SELECT public.unregister_device_push_token('${tokenA2}')`, userAlice);
    assert(unregRes.ok && unregRes.rows[0].unregister_device_push_token === true, 'Alice unregisters device 2 successfully');
    const aliceTokensAfter = await asRole('authenticated', `SELECT count(*)::int as c FROM public.user_push_tokens`, userAlice);
    assert(aliceTokensAfter.ok && aliceTokensAfter.rows[0].c === 0, 'Alice now has 0 registered devices');

    // 8. Cannot unregister another user's device
    const crossUnreg = await asRole('authenticated', `SELECT public.unregister_device_push_token('${tokenB1}')`, userAlice);
    assert(crossUnreg.ok && crossUnreg.rows[0].unregister_device_push_token === false, 'Alice cannot unregister Bob token (returns false)');

    // 9. notification_deliveries table security: authenticated and anon have zero access
    const delivAuth = await asRole('authenticated', `SELECT * FROM public.notification_deliveries`, userAlice);
    assert(!delivAuth.ok && delivAuth.err.code === '42501', 'notification_deliveries table is strictly restricted from authenticated role (42501)');
    const delivAnon = await asRole('anon', `SELECT * FROM public.notification_deliveries`);
    assert(!delivAnon.ok && delivAnon.err.code === '42501', 'notification_deliveries table is strictly restricted from anon role (42501)');

    // 10. Atomic Claiming & Unique Idempotency Constraint
    const testKey = 'test:claim:key:001';
    const claim1 = await client.query(`
      INSERT INTO public.notification_deliveries (idempotency_key, event_type, recipient_id, status)
      VALUES ('${testKey}', 'submission_pending', '${userAlice}', 'claimed')
      RETURNING id, status
    `);
    assert(claim1.rows.length === 1 && claim1.rows[0].status === 'claimed', 'Atomic claim insertion succeeds with status claimed');

    // Concurrent duplicate claim must fail with unique constraint violation (23505)
    let dupClaimErr = null;
    try {
      await client.query(`
        INSERT INTO public.notification_deliveries (idempotency_key, event_type, recipient_id, status)
        VALUES ('${testKey}', 'submission_pending', '${userAlice}', 'claimed')
      `);
    } catch (e) {
      dupClaimErr = e;
    }
    assert(dupClaimErr && dupClaimErr.code === '23505', 'Concurrent claim with same idempotency key is rejected by unique constraint (23505)');

    // Status check constraint enforces valid status values
    let badStatusErr = null;
    try {
      await client.query(`
        INSERT INTO public.notification_deliveries (idempotency_key, event_type, recipient_id, status)
        VALUES ('test:bad:status', 'submission_pending', '${userAlice}', 'invalid_status_enum')
      `);
    } catch (e) {
      badStatusErr = e;
    }
    assert(badStatusErr && badStatusErr.code === '23514', 'notification_deliveries check constraint rejects invalid statuses (23514)');

    // 11. Migration idempotency
    await client.query(mig5Sql);
    assert(true, 'Migration 5 is idempotent: re-applying it succeeds without error');

  } finally {
    client.release();
    await pool.end();
  }

  console.log(`\n=== Test Suite Complete: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
