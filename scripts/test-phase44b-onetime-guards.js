// DareDrop Phase 44B: Targeted One-Time Resubmission Guard Test Suite
// File: scripts/test-phase44b-onetime-guards.js

const { Client, types } = require('pg');
const assert = require('assert');

// Keep dates as ISO strings (YYYY-MM-DD)
types.setTypeParser(1082, str => str);

// ----------------------------------------------------------------------------
// 0. ABSOLUTE PRODUCTION SAFETY GUARDS
// ----------------------------------------------------------------------------
const DB_CONFIG = {
  host: '127.0.0.1',
  port: 54332,
  database: 'daredrop_disposable_test',
  user: 'umardinkhan',
};

assert.strictEqual(DB_CONFIG.host, '127.0.0.1', 'Fatal: Must connect only to localhost 127.0.0.1');
assert.strictEqual(DB_CONFIG.port, 54332, 'Fatal: Must connect only to isolated disposable port 54332');
assert.strictEqual(DB_CONFIG.database, 'daredrop_disposable_test', 'Fatal: Must connect only to daredrop_disposable_test');

const DB_URL = `postgres://${DB_CONFIG.user}@${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`;

let passedCount = 0;
let failedCount = 0;

function report({ testCase, expected, actual, pass, sqlstate, error }) {
  if (pass) {
    passedCount++;
    console.log(`[PASS ✅] ${testCase}`);
  } else {
    failedCount++;
    console.log(`[FAIL ❌] ${testCase}`);
  }
  console.log(`       Expected: ${expected}`);
  console.log(`       Actual:   ${actual}`);
  if (sqlstate) console.log(`       SQLSTATE: ${sqlstate}`);
  if (error) console.log(`       Error:    ${error}`);
  console.log('');
}

async function asSession(client, { userId = null, role = 'authenticated' } = {}) {
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
      aud: 'authenticated',
      email: `${userId}@test.daredrop.local`,
    });
    await client.query(`
      SELECT set_config('request.jwt.claim.sub', '${userId}', false);
      SELECT set_config('request.jwt.claim.role', '${role}', false);
      SELECT set_config('request.jwt.claims', '${claims}', false);
      SET ROLE ${role};
    `);
  }
}

async function createClient(userId, role = 'authenticated') {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  await asSession(c, { userId, role });
  return c;
}

async function run() {
  console.log('================================================================');
  console.log('DareDrop Phase 44B: One-Time Resubmission Guard Test Suite');
  console.log(`Target: ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
  console.log('================================================================\n');

  const adminClient = new Client({ connectionString: DB_URL });
  await adminClient.connect();

  const dbIdentity = (await adminClient.query('SELECT current_database(), current_user, inet_server_port();')).rows[0];
  console.log('Connected to verified target:', dbIdentity);
  assert.strictEqual(dbIdentity.current_database, 'daredrop_disposable_test', 'Must be daredrop_disposable_test');
  assert.strictEqual(parseInt(dbIdentity.inet_server_port, 10), 54332, 'Must be port 54332');

  const otChallengeId = '44b00000-0000-0000-0000-000000000001';
  const dailyChallengeId = '44b00000-0000-0000-0000-000000000002';
  const creatorId     = '44b00000-0000-0000-0000-000000000003'; // Verifier
  const submitterId   = '44b00000-0000-0000-0000-000000000004'; // Submitter

  try {
    // 1. Setup isolated test challenges
    await adminClient.query(`
      DELETE FROM public.challenge_completions WHERE challenge_id IN ('${otChallengeId}', '${dailyChallengeId}');
      DELETE FROM public.proof_challenges WHERE challenge_id IN ('${otChallengeId}', '${dailyChallengeId}');
      DELETE FROM public.challenge_participants WHERE challenge_id IN ('${otChallengeId}', '${dailyChallengeId}');
      DELETE FROM public.challenges WHERE id IN ('${otChallengeId}', '${dailyChallengeId}');

      -- One-time challenge
      INSERT INTO public.challenges (
        id, creator_id, title, description, category, challenge_type, duration_days, timezone, created_at
      ) VALUES (
        '${otChallengeId}', '${creatorId}', 'Phase 44B One-Time Dare', 'Testing one-time 48h guard',
        'Fitness', 'one_time', 10, 'Asia/Kolkata', now() - interval '5 days'
      );

      -- Daily challenge
      INSERT INTO public.challenges (
        id, creator_id, title, description, category, challenge_type, duration_days, timezone, created_at
      ) VALUES (
        '${dailyChallengeId}', '${creatorId}', 'Phase 44B Daily Dare', 'Testing daily behavior unchanged',
        'Fitness', 'daily', 10, 'Asia/Kolkata', now() - interval '5 days'
      );

      -- Participants
      INSERT INTO public.challenge_participants (challenge_id, user_id, joined_at) VALUES
        ('${otChallengeId}', '${creatorId}', now() - interval '5 days'),
        ('${otChallengeId}', '${submitterId}', now() - interval '5 days'),
        ('${dailyChallengeId}', '${creatorId}', now() - interval '5 days'),
        ('${dailyChallengeId}', '${submitterId}', now() - interval '5 days');
    `);

    const tzRes = await adminClient.query(`
      SELECT
        (now() AT TIME ZONE 'Asia/Kolkata')::date as today,
        ((now() AT TIME ZONE 'Asia/Kolkata')::date - 1)::date as yesterday,
        ((now() AT TIME ZONE 'Asia/Kolkata')::date - 3)::date as three_days_ago;
    `);
    const today = tzRes.rows[0].today;
    const yesterday = tzRes.rows[0].yesterday;
    const threeDaysAgo = tzRes.rows[0].three_days_ago;

    console.log(`Timezone (Asia/Kolkata) Dates: today=${today}, yesterday=${yesterday}, threeDaysAgo=${threeDaysAgo}\n`);

    const submitterClient = await createClient(submitterId);

    // =========================================================================
    // TEST 1: One-time rejection OLDER than 48 hours (e.g. 50h ago)
    // Supplied date is TODAY (testing bypass prevention).
    // Expected: SQLSTATE 22023 for BOTH generate_proof_challenge and submit_challenge_completion
    // =========================================================================
    console.log('--- TEST 1: One-time rejection > 48h ago (supplied date: TODAY) ---');
    const comp1Id = '44c00000-0000-0000-0000-000000000001';
    await adminClient.query(`
      DELETE FROM public.challenge_completions WHERE challenge_id = '${otChallengeId}';
      DELETE FROM public.proof_challenges WHERE challenge_id = '${otChallengeId}';

      INSERT INTO public.challenge_completions (
        id, challenge_id, challenge_type, participant_id, verifier_id, completion_date,
        status, submission_note, proof_code, action_prompt_id, action_prompt,
        rejection_reason, first_submitted_at, submitted_at, reviewed_at
      ) VALUES (
        '${comp1Id}', '${otChallengeId}', 'one_time', '${submitterId}', '${creatorId}', '${threeDaysAgo}',
        'rejected', 'Initial submission note', 'A1B2', 1, 'Sample Prompt',
        'Not satisfactory', now() - interval '52 hours', now() - interval '52 hours', now() - interval '50 hours'
      );
    `);

    // 1A. Test generate_proof_challenge
    let gen1Error = null;
    try {
      await submitterClient.query(`
        SELECT * FROM public.generate_proof_challenge('${otChallengeId}', '${creatorId}', '${today}');
      `);
    } catch (e) {
      gen1Error = e;
    }
    report({
      testCase: '1A: generate_proof_challenge with 50h-old rejection and p_completion_date=today',
      expected: 'SQLSTATE 22023 (Resubmission grace period expired)',
      actual: gen1Error ? `${gen1Error.code}: ${gen1Error.message}` : 'SUCCESS (unexpected bypass)',
      pass: gen1Error && gen1Error.code === '22023' && gen1Error.message.includes('Resubmission grace period expired'),
      sqlstate: gen1Error?.code,
      error: gen1Error?.message,
    });

    // 1B. Test submit_challenge_completion
    const proof1Id = '44e00000-0000-0000-0000-000000000001';
    await adminClient.query(`
      INSERT INTO public.proof_challenges (
        id, challenge_id, participant_id, verifier_id, completion_date,
        proof_code, action_prompt_id, action_prompt, status, expires_at
      ) VALUES (
        '${proof1Id}', '${otChallengeId}', '${submitterId}', '${creatorId}', '${today}',
        'X9Y8', 1, 'Touch nose with left pinky', 'active', now() + interval '45 minutes'
      );
    `);

    let sub1Error = null;
    try {
      await submitterClient.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${otChallengeId}', '${creatorId}', '${today}', '${proof1Id}', 'Resubmitting after 50h'
        );
      `);
    } catch (e) {
      sub1Error = e;
    }
    report({
      testCase: '1B: submit_challenge_completion with 50h-old rejection and p_completion_date=today',
      expected: 'SQLSTATE 22023 (Resubmission grace period expired)',
      actual: sub1Error ? `${sub1Error.code}: ${sub1Error.message}` : 'SUCCESS (unexpected bypass)',
      pass: sub1Error && sub1Error.code === '22023' && sub1Error.message.includes('Resubmission grace period expired'),
      sqlstate: sub1Error?.code,
      error: sub1Error?.message,
    });

    // =========================================================================
    // TEST 2: One-time rejection WITHIN 48 hours (e.g. 47 hours ago)
    // Supplied date is TODAY.
    // Expected: Both generate_proof_challenge and submit_challenge_completion SUCCEED.
    // Audit preservation: first_submitted_at, last_rejection_reason, last_reviewed_at preserved.
    // =========================================================================
    console.log('--- TEST 2: One-time rejection WITHIN 48h (47h ago) ---');
    const comp2Id = '44c00000-0000-0000-0000-000000000002';
    const originalFirstSub2 = new Date(Date.now() - 49 * 3600 * 1000).toISOString();
    const rejectionTime2 = new Date(Date.now() - 47 * 3600 * 1000).toISOString();
    const originalRejectionReason = 'Audio was inaudible; re-record closer to mic';

    await adminClient.query(`
      DELETE FROM public.challenge_completions WHERE challenge_id = '${otChallengeId}';
      DELETE FROM public.proof_challenges WHERE challenge_id = '${otChallengeId}';

      INSERT INTO public.challenge_completions (
        id, challenge_id, challenge_type, participant_id, verifier_id, completion_date,
        status, submission_note, proof_code, action_prompt_id, action_prompt,
        rejection_reason, first_submitted_at, submitted_at, reviewed_at
      ) VALUES (
        '${comp2Id}', '${otChallengeId}', 'one_time', '${submitterId}', '${creatorId}', '${yesterday}',
        'rejected', 'Initial submission note', 'B2C3', 2, 'Sample Prompt 2',
        '${originalRejectionReason}', '${originalFirstSub2}', '${originalFirstSub2}', '${rejectionTime2}'
      );
    `);

    // 2A. generate_proof_challenge within 48h
    let gen2Result = null;
    let gen2Error = null;
    try {
      const res = await submitterClient.query(`
        SELECT * FROM public.generate_proof_challenge('${otChallengeId}', '${creatorId}', '${today}');
      `);
      gen2Result = res.rows[0];
    } catch (e) {
      gen2Error = e;
    }
    report({
      testCase: '2A: generate_proof_challenge with 47h-old rejection and p_completion_date=today',
      expected: 'Active proof challenge generated successfully',
      actual: gen2Result ? `Proof code: ${gen2Result.proof_code}, status: ${gen2Result.status}` : `Error: ${gen2Error?.message}`,
      pass: gen2Result && gen2Result.status === 'active' && !!gen2Result.proof_code,
      sqlstate: gen2Error?.code,
      error: gen2Error?.message,
    });

    // 2B. submit_challenge_completion within 48h
    let sub2Result = null;
    let sub2Error = null;
    try {
      const res = await submitterClient.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${otChallengeId}', '${creatorId}', '${today}', '${gen2Result.id}', 'Resubmitting with clear audio'
        );
      `);
      sub2Result = res.rows[0];
    } catch (e) {
      sub2Error = e;
    }
    report({
      testCase: '2B: submit_challenge_completion with 47h-old rejection and p_completion_date=today',
      expected: 'Status transitions to pending, completion_date updated to today',
      actual: sub2Result ? `Status: ${sub2Result.status}, completion_date: ${sub2Result.completion_date}` : `Error: ${sub2Error?.message}`,
      pass: sub2Result && sub2Result.status === 'pending' && sub2Result.completion_date === today,
      sqlstate: sub2Error?.code,
      error: sub2Error?.message,
    });

    // 2C. Audit trail inspection
    const auditRes = (await adminClient.query(`
      SELECT id, first_submitted_at, submitted_at, reviewed_at, rejection_reason, last_rejection_reason, last_reviewed_at
      FROM public.challenge_completions WHERE id = '${comp2Id}';
    `)).rows[0];

    const firstSubPreserved = new Date(auditRes.first_submitted_at).getTime() === new Date(originalFirstSub2).getTime();
    const lastRejectionPreserved = auditRes.last_rejection_reason === originalRejectionReason;
    const lastReviewedPreserved = new Date(auditRes.last_reviewed_at).getTime() === new Date(rejectionTime2).getTime();
    const activeCleared = auditRes.rejection_reason === null && auditRes.reviewed_at === null;

    report({
      testCase: '2C: Audit preservation: first_submitted_at, last_rejection_reason, last_reviewed_at',
      expected: 'All historical fields preserved, active review fields cleared',
      actual: `first_sub_preserved=${firstSubPreserved}, last_rejection_preserved=${lastRejectionPreserved}, last_reviewed_preserved=${lastReviewedPreserved}, active_cleared=${activeCleared}`,
      pass: firstSubPreserved && lastRejectionPreserved && lastReviewedPreserved && activeCleared,
    });

    // =========================================================================
    // TEST 3: Exactly 48 hours boundary
    // In a transaction, set reviewed_at = now() - interval '48 hours'.
    // In Postgres, pg_catalog.now() returns the transaction start time.
    // Under strict `< (now() - interval '48 hours')`, reviewed_at < reviewed_at is FALSE.
    // Therefore, exactly 48h is ELIGIBLE.
    // =========================================================================
    console.log('--- TEST 3: Exactly 48 hours boundary ---');
    const comp3Id = '44c00000-0000-0000-0000-000000000003';
    await adminClient.query(`
      DELETE FROM public.challenge_completions WHERE challenge_id = '${otChallengeId}';
      DELETE FROM public.proof_challenges WHERE challenge_id = '${otChallengeId}';

      INSERT INTO public.challenge_completions (
        id, challenge_id, challenge_type, participant_id, verifier_id, completion_date,
        status, submission_note, proof_code, action_prompt_id, action_prompt,
        rejection_reason, first_submitted_at, submitted_at, reviewed_at
      ) VALUES (
        '${comp3Id}', '${otChallengeId}', 'one_time', '${submitterId}', '${creatorId}', '${yesterday}',
        'rejected', 'Initial', 'C3D4', 1, 'Action prompt',
        'Boundary test', now() - interval '50 hours', now() - interval '50 hours', now() - interval '47 hours'
      );
    `);

    // Run inside an atomic transaction so now() is identical
    let gen3Result = null;
    let gen3Error = null;
    try {
      await submitterClient.query('BEGIN;');
      await submitterClient.query('RESET ROLE;');
      await submitterClient.query(`
        UPDATE public.challenge_completions
        SET reviewed_at = pg_catalog.now() - INTERVAL '48 hours'
        WHERE id = '${comp3Id}';
      `);
      await asSession(submitterClient, { userId: submitterId });
      const res = await submitterClient.query(`
        SELECT * FROM public.generate_proof_challenge('${otChallengeId}', '${creatorId}', '${today}');
      `);
      gen3Result = res.rows[0];
      await submitterClient.query('COMMIT;');
    } catch (e) {
      await submitterClient.query('ROLLBACK;');
      gen3Error = e;
    }
    report({
      testCase: '3A: generate_proof_challenge at exactly 48 hours is eligible under strict < comparison',
      expected: 'Eligible (active proof generated)',
      actual: gen3Result ? `Status: ${gen3Result.status}` : `Error: ${gen3Error?.message}`,
      pass: gen3Result && gen3Result.status === 'active',
      sqlstate: gen3Error?.code,
      error: gen3Error?.message,
    });

    // 48 hours + 1 second is EXPIRED
    await adminClient.query(`
      UPDATE public.challenge_completions
      SET reviewed_at = now() - interval '48 hours 1 second'
      WHERE id = '${comp3Id}';
      DELETE FROM public.proof_challenges WHERE challenge_id = '${otChallengeId}';
    `);

    let gen3bError = null;
    try {
      await submitterClient.query(`
        SELECT * FROM public.generate_proof_challenge('${otChallengeId}', '${creatorId}', '${today}');
      `);
    } catch (e) {
      gen3bError = e;
    }
    report({
      testCase: '3B: generate_proof_challenge at 48 hours + 1 second is strictly expired',
      expected: 'SQLSTATE 22023 (Resubmission grace period expired)',
      actual: gen3bError ? `${gen3bError.code}: ${gen3bError.message}` : 'SUCCESS (unexpected)',
      pass: gen3bError && gen3bError.code === '22023',
      sqlstate: gen3bError?.code,
      error: gen3bError?.message,
    });

    // =========================================================================
    // TEST 4: Missing reviewed_at timestamp (reviewed_at IS NULL) on rejected record
    // Expected: SQLSTATE 22023 (cannot verify timestamp)
    // =========================================================================
    console.log('--- TEST 4: Missing reviewed_at on rejected record ---');
    const comp4Id = '44c00000-0000-0000-0000-000000000004';
    await adminClient.query(`
      DELETE FROM public.challenge_completions WHERE challenge_id = '${otChallengeId}';
      DELETE FROM public.proof_challenges WHERE challenge_id = '${otChallengeId}';

      INSERT INTO public.challenge_completions (
        id, challenge_id, challenge_type, participant_id, verifier_id, completion_date,
        status, submission_note, proof_code, action_prompt_id, action_prompt,
        rejection_reason, first_submitted_at, submitted_at, reviewed_at
      ) VALUES (
        '${comp4Id}', '${otChallengeId}', 'one_time', '${submitterId}', '${creatorId}', '${yesterday}',
        'rejected', 'Initial', 'D4E5', 1, 'Action prompt',
        'Rejected without reviewed_at', now() - interval '10 hours', now() - interval '10 hours', NULL
      );
    `);

    let gen4Error = null;
    try {
      await submitterClient.query(`
        SELECT * FROM public.generate_proof_challenge('${otChallengeId}', '${creatorId}', '${today}');
      `);
    } catch (e) {
      gen4Error = e;
    }
    report({
      testCase: '4A: generate_proof_challenge with NULL reviewed_at rejected with SQLSTATE 22023',
      expected: 'SQLSTATE 22023',
      actual: gen4Error ? `${gen4Error.code}: ${gen4Error.message}` : 'SUCCESS (unexpected)',
      pass: gen4Error && gen4Error.code === '22023',
      sqlstate: gen4Error?.code,
      error: gen4Error?.message,
    });

    // =========================================================================
    // TEST 5: First-time one-time submission (no existing completion row)
    // Expected: Unaffected, generates proof challenge and inserts new completion record.
    // =========================================================================
    console.log('--- TEST 5: First-time one-time submission ---');
    await adminClient.query(`
      DELETE FROM public.challenge_completions WHERE challenge_id = '${otChallengeId}';
      DELETE FROM public.proof_challenges WHERE challenge_id = '${otChallengeId}';
    `);

    let gen5Result = null;
    let gen5Error = null;
    try {
      const res = await submitterClient.query(`
        SELECT * FROM public.generate_proof_challenge('${otChallengeId}', '${creatorId}', '${today}');
      `);
      gen5Result = res.rows[0];
    } catch (e) {
      gen5Error = e;
    }
    report({
      testCase: '5A: First-time one-time generate_proof_challenge succeeds',
      expected: 'Active proof challenge generated',
      actual: gen5Result ? `Status: ${gen5Result.status}, proof_code: ${gen5Result.proof_code}` : `Error: ${gen5Error?.message}`,
      pass: gen5Result && gen5Result.status === 'active',
      sqlstate: gen5Error?.code,
      error: gen5Error?.message,
    });

    let sub5Result = null;
    let sub5Error = null;
    try {
      const res = await submitterClient.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${otChallengeId}', '${creatorId}', '${today}', '${gen5Result.id}', 'First time dare completion note'
        );
      `);
      sub5Result = res.rows[0];
    } catch (e) {
      sub5Error = e;
    }
    report({
      testCase: '5B: First-time one-time submit_challenge_completion creates pending row with first_submitted_at',
      expected: 'New row with status=pending, first_submitted_at set',
      actual: sub5Result ? `Status: ${sub5Result.status}, first_submitted_at: ${sub5Result.first_submitted_at}` : `Error: ${sub5Error?.message}`,
      pass: sub5Result && sub5Result.status === 'pending' && !!sub5Result.first_submitted_at,
      sqlstate: sub5Error?.code,
      error: sub5Error?.message,
    });

    // =========================================================================
    // TEST 6: Daily challenge first submission & daily resubmission UNCHANGED
    // Expected: Normal daily behavior works exactly as before.
    // =========================================================================
    console.log('--- TEST 6: Daily challenge behavior unchanged ---');
    await adminClient.query(`
      DELETE FROM public.challenge_completions WHERE challenge_id = '${dailyChallengeId}';
      DELETE FROM public.proof_challenges WHERE challenge_id = '${dailyChallengeId}';
    `);

    // 6A. Daily first submission for today
    let gen6Result = null;
    try {
      const res = await submitterClient.query(`
        SELECT * FROM public.generate_proof_challenge('${dailyChallengeId}', '${creatorId}', '${today}');
      `);
      gen6Result = res.rows[0];
    } catch (e) {
      console.error(e);
    }
    const sub6Result = (await submitterClient.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${dailyChallengeId}', '${creatorId}', '${today}', '${gen6Result.id}', 'Daily dare note'
      );
    `)).rows[0];

    report({
      testCase: '6A: Daily first submission for today functions normally',
      expected: 'Status: pending, completion_date: today',
      actual: `Status: ${sub6Result?.status}, completion_date: ${sub6Result?.completion_date}`,
      pass: sub6Result?.status === 'pending' && sub6Result?.completion_date === today,
    });

    // 6B. Daily rejection and resubmission
    await adminClient.query(`
      UPDATE public.challenge_completions
      SET status = 'rejected', reviewed_at = now() - interval '2 hours', rejection_reason = 'Blurry daily photo'
      WHERE id = '${sub6Result.id}';
    `);

    const gen6bRes = (await submitterClient.query(`
      SELECT * FROM public.generate_proof_challenge('${dailyChallengeId}', '${creatorId}', '${today}');
    `)).rows[0];

    const sub6bRes = (await submitterClient.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${dailyChallengeId}', '${creatorId}', '${today}', '${gen6bRes.id}', 'Daily resubmission clear photo'
      );
    `)).rows[0];

    report({
      testCase: '6B: Daily resubmission transitions to pending with audit archived',
      expected: 'Status: pending, last_rejection_reason="Blurry daily photo"',
      actual: `Status: ${sub6bRes?.status}, last_rejection_reason: "${sub6bRes?.last_rejection_reason}"`,
      pass: sub6bRes?.status === 'pending' && sub6bRes?.last_rejection_reason === 'Blurry daily photo',
    });

    // 6C. Daily date uniqueness: cannot create second submission for same day
    let gen6cError = null;
    try {
      await submitterClient.query(`
        SELECT * FROM public.generate_proof_challenge('${dailyChallengeId}', '${creatorId}', '${today}');
      `);
    } catch (e) {
      gen6cError = e;
    }
    report({
      testCase: '6C: Daily date uniqueness: generating proof while pending raises 23505',
      expected: 'SQLSTATE 23505 (Day ... is already pending verification)',
      actual: gen6cError ? `${gen6cError.code}: ${gen6cError.message}` : 'SUCCESS (unexpected)',
      pass: gen6cError && gen6cError.code === '23505',
      sqlstate: gen6cError?.code,
      error: gen6cError?.message,
    });

    console.log('================================================================');
    console.log(`TEST SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
    console.log('================================================================\n');

    assert.strictEqual(failedCount, 0, `Expected 0 failures, got ${failedCount}`);

  } finally {
    // Cleanup isolated test records
    await adminClient.query(`
      DELETE FROM public.challenge_completions WHERE challenge_id IN ('${otChallengeId}', '${dailyChallengeId}');
      DELETE FROM public.proof_challenges WHERE challenge_id IN ('${otChallengeId}', '${dailyChallengeId}');
      DELETE FROM public.challenge_participants WHERE challenge_id IN ('${otChallengeId}', '${dailyChallengeId}');
      DELETE FROM public.challenges WHERE id IN ('${otChallengeId}', '${dailyChallengeId}');
    `);
    await adminClient.end();
  }
}

run().catch(err => {
  console.error('Fatal Test Runner Error:', err);
  process.exit(1);
});
