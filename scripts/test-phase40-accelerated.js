// DareDrop Phase 40: Accelerated Grace-Period Reliability Test Suite
// File: scripts/test-phase40-accelerated.js

const { Client, types } = require('pg');
const assert = require('assert');

// Date parser: keep dates as ISO strings (YYYY-MM-DD)
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

let results = [];

function recordResult({ scenario, setup, rpc, expected, actual, pass, sqlstate, error }) {
  results.push({
    scenario,
    setup,
    rpc,
    expected,
    actual,
    pass,
    sqlstate: sqlstate || null,
    error: error || null,
  });
  console.log(`[${pass ? 'PASS ✅' : 'FAIL ❌'}] ${scenario}`);
  console.log(`       Setup:    ${setup}`);
  console.log(`       RPC:      ${rpc}`);
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
      email: `${userId.slice(0, 8)}@test.com`,
      aud: 'authenticated',
      is_anonymous: false,
      app_metadata: { provider: 'email' },
    });
    await client.query(`
      SELECT set_config('request.jwt.claim.sub', '${userId}', false);
      SELECT set_config('request.jwt.claim.role', '${role}', false);
      SELECT set_config('request.jwt.claims', '${claims.replace(/'/g, "''")}', false);
      SET ROLE ${role};
    `);
  }
}

async function createClient(userId = null, role = 'authenticated') {
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  if (userId) {
    await asSession(client, { userId, role });
  }
  return client;
}

async function main() {
  console.log('================================================================');
  console.log('DareDrop Phase 40: Accelerated Grace-Period Test Execution');
  console.log(`Target: ${DB_CONFIG.host}:${DB_CONFIG.port}/${DB_CONFIG.database}`);
  console.log('================================================================\n');

  const adminClient = new Client({ connectionString: DB_URL });
  await adminClient.connect();

  // Verify DB identity directly from server
  const dbIdentity = (await adminClient.query('SELECT current_database(), current_user, inet_server_port();')).rows[0];
  console.log('Connected to verified target:', dbIdentity);
  assert.strictEqual(dbIdentity.current_database, 'daredrop_disposable_test', 'Must be daredrop_disposable_test');
  assert.strictEqual(parseInt(dbIdentity.inet_server_port, 10), 54332, 'Must be port 54332');

  try {
    // -------------------------------------------------------------------------
    // Setup isolated test entities
    // -------------------------------------------------------------------------
    const challengeId = '40a00000-0000-0000-0000-000000000001';
    const creatorId   = '40a00000-0000-0000-0000-000000000002'; // Verifier
    const submitterId = '40a00000-0000-0000-0000-000000000003'; // Submitter
    const outsiderId  = '40a00000-0000-0000-0000-000000000004'; // Non-participant

    // Clean up any previous test run with these specific IDs
    await adminClient.query(`
      DELETE FROM public.challenge_completions WHERE challenge_id = '${challengeId}';
      DELETE FROM public.proof_challenges WHERE challenge_id = '${challengeId}';
      DELETE FROM public.challenge_participants WHERE challenge_id = '${challengeId}';
      DELETE FROM public.challenges WHERE id = '${challengeId}';

      -- Create challenge starting 5 days ago in Asia/Kolkata
      INSERT INTO public.challenges (
        id, creator_id, title, description, category, challenge_type, duration_days, timezone, created_at
      ) VALUES (
        '${challengeId}', '${creatorId}', 'Phase 40 Accelerated Test Dare', 'Testing 48h resubmission grace period',
        'Fitness', 'daily', 10, 'Asia/Kolkata', now() - interval '5 days'
      );

      -- Register participants
      INSERT INTO public.challenge_participants (challenge_id, user_id, joined_at) VALUES
        ('${challengeId}', '${creatorId}', now() - interval '5 days'),
        ('${challengeId}', '${submitterId}', now() - interval '5 days');
    `);

    const tzRes = await adminClient.query(`
      SELECT
        (now() AT TIME ZONE 'Asia/Kolkata')::date as today,
        ((now() AT TIME ZONE 'Asia/Kolkata')::date - 1)::date as yesterday,
        ((now() AT TIME ZONE 'Asia/Kolkata')::date - 2)::date as two_days_ago;
    `);
    const today = tzRes.rows[0].today;
    const yesterday = tzRes.rows[0].yesterday;
    const twoDaysAgo = tzRes.rows[0].two_days_ago;

    console.log(`Dates in Challenge Timezone (Asia/Kolkata):`);
    console.log(`  Today:        ${today}`);
    console.log(`  Yesterday:    ${yesterday} (ordinary window boundary)`);
    console.log(`  Two Days Ago: ${twoDaysAgo} (grace-period boundary, < today - 1)\n`);

    const submitterClient = await createClient(submitterId);
    const verifierClient = await createClient(creatorId);

    // =========================================================================
    // SCENARIO 1, 3, 5, 6, 7, 8: Rejection 47 Hours Ago (Resubmission Must Succeed)
    // =========================================================================
    console.log('--- EXECUTING SCENARIOS 1, 3, 5, 6, 7, 8 ---');
    // Setup: Completion for twoDaysAgo submitted on-time, rejected 47 hours ago
    const comp1Id = '40c00000-0000-0000-0000-000000000001';
    const originalFirstSub = new Date(Date.now() - 49 * 3600 * 1000); // 49h ago (on-time for twoDaysAgo)
    const reviewTime47h = new Date(Date.now() - 47 * 3600 * 1000);    // 47h ago (< 48h)
    const initialRejectFeedback = 'Proof angle was too dark; please resubmit with clear lighting';

    await adminClient.query(`
      INSERT INTO public.challenge_completions (
        id, challenge_id, challenge_type, participant_id, verifier_id, completion_date,
        status, submission_note, rejection_reason, submitted_at, reviewed_at, first_submitted_at
      ) VALUES (
        '${comp1Id}', '${challengeId}', 'daily', '${submitterId}', '${creatorId}', '${twoDaysAgo}',
        'rejected', 'Initial attempt note', '${initialRejectFeedback}',
        '${originalFirstSub.toISOString()}', '${reviewTime47h.toISOString()}', '${originalFirstSub.toISOString()}'
      );
    `);

    // Step A: Generate proof challenge for twoDaysAgo (grace-period path)
    let proof47h = null;
    let gen47hErr = null;
    try {
      const res = await submitterClient.query(`
        SELECT * FROM public.generate_proof_challenge('${challengeId}', '${creatorId}', '${twoDaysAgo}');
      `);
      proof47h = res.rows[0];
    } catch (e) {
      gen47hErr = e;
    }

    recordResult({
      scenario: '1 & 3 & 8: Generate proof challenge 47 hours after rejection for date outside ordinary window (twoDaysAgo)',
      setup: `completion_date = ${twoDaysAgo} (< today - 1), reviewed_at = 47h ago (< 48h)`,
      rpc: `generate_proof_challenge('${challengeId}', '${creatorId}', '${twoDaysAgo}')`,
      expected: 'Status active, 4-char code, physical action prompt, expires in 45m',
      actual: proof47h ? `Active proof ${proof47h.id} (code: ${proof47h.proof_code}, prompt: "${proof47h.action_prompt}")` : 'Failed',
      pass: proof47h !== null && proof47h.status === 'active' && proof47h.proof_code.length === 4,
      sqlstate: gen47hErr?.code,
      error: gen47hErr?.message,
    });

    // Step B: Submit resubmission using fresh proof challenge
    let resub47h = null;
    let resub47hErr = null;
    try {
      const res = await submitterClient.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${challengeId}', '${creatorId}', '${twoDaysAgo}', '${proof47h.id}', 'Resubmission with bright light'
        );
      `);
      resub47h = res.rows[0];
    } catch (e) {
      resub47hErr = e;
    }

    const proof47hDb = (await adminClient.query(`SELECT status, consumed_at FROM public.proof_challenges WHERE id = '${proof47h.id}';`)).rows[0];

    recordResult({
      scenario: '1 & 5: Resubmission within 48 hours transitions rejected row back to pending',
      setup: `submit_challenge_completion with fresh proof ${proof47h.id}`,
      rpc: `submit_challenge_completion('${challengeId}', '${creatorId}', '${twoDaysAgo}', '${proof47h.id}', ...)`,
      expected: 'Status transitions to pending, proof consumed atomically',
      actual: resub47h ? `Status: ${resub47h.status}, proof consumed: ${proof47hDb.status}` : 'Failed',
      pass: resub47h?.status === 'pending' && proof47hDb?.status === 'consumed',
      sqlstate: resub47hErr?.code,
      error: resub47hErr?.message,
    });

    recordResult({
      scenario: '6: Preservation of original first_submitted_at',
      setup: `Original first_submitted_at = ${originalFirstSub.toISOString()}`,
      rpc: `SELECT first_submitted_at, submitted_at FROM challenge_completions WHERE id = '${comp1Id}'`,
      expected: `first_submitted_at matches ${originalFirstSub.toISOString()}`,
      actual: `first_submitted_at = ${resub47h?.first_submitted_at?.toISOString()}`,
      pass: resub47h?.first_submitted_at?.toISOString() === originalFirstSub.toISOString(),
    });

    recordResult({
      scenario: '7: Previous rejection details archived and active fields cleared',
      setup: `Initial rejection: "${initialRejectFeedback}" at ${reviewTime47h.toISOString()}`,
      rpc: `SELECT rejection_reason, last_rejection_reason, reviewed_at, last_reviewed_at FROM challenge_completions`,
      expected: `rejection_reason = NULL, reviewed_at = NULL, last_rejection_reason = "${initialRejectFeedback}", last_reviewed_at = ${reviewTime47h.toISOString()}`,
      actual: `rejection_reason = ${resub47h?.rejection_reason}, last_rejection_reason = "${resub47h?.last_rejection_reason}", reviewed_at = ${resub47h?.reviewed_at}, last_reviewed_at = ${resub47h?.last_reviewed_at?.toISOString()}`,
      pass: resub47h?.rejection_reason === null &&
            resub47h?.reviewed_at === null &&
            resub47h?.last_rejection_reason === initialRejectFeedback &&
            resub47h?.last_reviewed_at?.toISOString() === reviewTime47h.toISOString(),
    });

    // =========================================================================
    // SCENARIO 9: Verifier Reviews and Approves the Resubmission
    // =========================================================================
    console.log('--- EXECUTING SCENARIO 9: VERIFIER APPROVAL ---');
    let approvalRes = null;
    let approvalErr = null;
    try {
      const res = await verifierClient.query(`
        SELECT * FROM public.review_challenge_completion('${comp1Id}', 'approved', null);
      `);
      approvalRes = res.rows[0];
    } catch (e) {
      approvalErr = e;
    }

    recordResult({
      scenario: '9: Verifier reviews and approves the resubmission',
      setup: `Completion ${comp1Id} pending review`,
      rpc: `review_challenge_completion('${comp1Id}', 'approved', null)`,
      expected: 'Status approved, reviewed_at stamped, audit trail preserved',
      actual: approvalRes ? `Status: ${approvalRes.status}, reviewed_at: ${approvalRes.reviewed_at?.toISOString()}, last_rejection: "${approvalRes.last_rejection_reason}"` : 'Failed',
      pass: approvalRes?.status === 'approved' &&
            approvalRes?.reviewed_at !== null &&
            approvalRes?.last_rejection_reason === initialRejectFeedback &&
            approvalRes?.first_submitted_at?.toISOString() === originalFirstSub.toISOString(),
      sqlstate: approvalErr?.code,
      error: approvalErr?.message,
    });

    // =========================================================================
    // SCENARIO 2: Rejection 48 Hours and 1 Second Ago (Must Fail with SQLSTATE 22023)
    // =========================================================================
    console.log('--- EXECUTING SCENARIO 2: 48H + 1S EXPIRY BOUNDARY ---');
    // Setup new rejected completion for submitter on a different date (3 days ago)
    const threeDaysAgo = (await adminClient.query(`SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date - 3)::date as d;`)).rows[0].d;
    const comp2Id = '40c00000-0000-0000-0000-000000000002';
    // Backdate to exactly 48 hours and 1 second ago
    const reviewTime48h1s = new Date(Date.now() - (48 * 3600 + 1) * 1000);
    const subTimeThreeDays = new Date(Date.now() - 72 * 3600 * 1000);

    // Reset rate limit by backdating older proofs
    await adminClient.query(`UPDATE public.proof_challenges SET created_at = created_at - interval '2 hours';`);

    await adminClient.query(`
      INSERT INTO public.challenge_completions (
        id, challenge_id, challenge_type, participant_id, verifier_id, completion_date,
        status, submission_note, rejection_reason, submitted_at, reviewed_at, first_submitted_at
      ) VALUES (
        '${comp2Id}', '${challengeId}', 'daily', '${submitterId}', '${creatorId}', '${threeDaysAgo}',
        'rejected', 'Old attempt', 'Expired rejection',
        '${subTimeThreeDays.toISOString()}', '${reviewTime48h1s.toISOString()}', '${subTimeThreeDays.toISOString()}'
      );
    `);

    let expiredProofGenErr = null;
    try {
      await submitterClient.query(`
        SELECT * FROM public.generate_proof_challenge('${challengeId}', '${creatorId}', '${threeDaysAgo}');
      `);
    } catch (e) {
      expiredProofGenErr = e;
    }

    recordResult({
      scenario: '2: Rejection 48 hours and 1 second ago strictly denied with SQLSTATE 22023',
      setup: `completion_date = ${threeDaysAgo}, reviewed_at = 48h 1s ago (${reviewTime48h1s.toISOString()})`,
      rpc: `generate_proof_challenge('${challengeId}', '${creatorId}', '${threeDaysAgo}')`,
      expected: 'SQLSTATE 22023: Resubmission grace period expired (rejection occurred more than 48 hours ago for date ...)',
      actual: expiredProofGenErr ? `${expiredProofGenErr.code}: ${expiredProofGenErr.message}` : 'Unexpected success',
      pass: expiredProofGenErr?.code === '22023' && expiredProofGenErr?.message?.includes('Resubmission grace period expired'),
      sqlstate: expiredProofGenErr?.code,
      error: expiredProofGenErr?.message,
    });

    // =========================================================================
    // SCENARIO 4: Completion Date Yesterday (Ordinary Submission Window)
    // =========================================================================
    console.log('--- EXECUTING SCENARIO 4: ORDINARY WINDOW (YESTERDAY) ---');
    // Ordinary window allows yesterday without requiring any pre-existing rejection or grace period
    await adminClient.query(`UPDATE public.proof_challenges SET created_at = created_at - interval '2 hours';`);

    let proofYesterday = null;
    let proofYesterdayErr = null;
    try {
      const res = await submitterClient.query(`
        SELECT * FROM public.generate_proof_challenge('${challengeId}', '${creatorId}', '${yesterday}');
      `);
      proofYesterday = res.rows[0];
    } catch (e) {
      proofYesterdayErr = e;
    }

    let subYesterday = null;
    let subYesterdayErr = null;
    try {
      const res = await submitterClient.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${challengeId}', '${creatorId}', '${yesterday}', '${proofYesterday.id}', 'Yesterday ordinary submission'
        );
      `);
      subYesterday = res.rows[0];
    } catch (e) {
      subYesterdayErr = e;
    }

    recordResult({
      scenario: '4: Completion date yesterday evaluates under ordinary submission window (no prior rejection needed)',
      setup: `completion_date = ${yesterday} (ordinary eligible window: yesterday/today)`,
      rpc: `generate_proof_challenge + submit_challenge_completion for yesterday`,
      expected: 'Proof generated and submission succeeds as pending under ordinary window',
      actual: subYesterday ? `Status: ${subYesterday.status}, completion_date: ${subYesterday.completion_date}` : 'Failed',
      pass: subYesterday?.status === 'pending' && subYesterday?.completion_date === yesterday,
      sqlstate: subYesterdayErr?.code,
      error: subYesterdayErr?.message,
    });

    // =========================================================================
    // SCENARIO 10: Authentication, Authorization, and Transaction Constraints
    // =========================================================================
    console.log('--- EXECUTING SCENARIO 10: AUTH & TRANSACTION CONSTRAINTS ---');

    // 10A: Non-participant caller
    const outsiderClient = await createClient(outsiderId);
    let outsiderErr = null;
    try {
      await outsiderClient.query(`
        SELECT * FROM public.generate_proof_challenge('${challengeId}', '${creatorId}', '${today}');
      `);
    } catch (e) {
      outsiderErr = e;
    }

    recordResult({
      scenario: '10A: Non-participant is denied proof generation (authorization guard)',
      setup: `Caller ${outsiderId} is not a member of challenge ${challengeId}`,
      rpc: `generate_proof_challenge('${challengeId}', '${creatorId}', '${today}')`,
      expected: 'SQLSTATE 42501: You must be an active participant to generate a proof challenge',
      actual: outsiderErr ? `${outsiderErr.code}: ${outsiderErr.message}` : 'Unexpected success',
      pass: outsiderErr?.code === '42501' && outsiderErr?.message?.includes('active participant'),
      sqlstate: outsiderErr?.code,
      error: outsiderErr?.message,
    });
    await outsiderClient.end();

    // 10B: Designating oneself as verifier
    let selfVerifierErr = null;
    try {
      await submitterClient.query(`
        SELECT * FROM public.generate_proof_challenge('${challengeId}', '${submitterId}', '${today}');
      `);
    } catch (e) {
      selfVerifierErr = e;
    }

    recordResult({
      scenario: '10B: Designating self as verifier is strictly denied',
      setup: `Submitter ${submitterId} attempts to designate verifier = ${submitterId}`,
      rpc: `generate_proof_challenge('${challengeId}', '${submitterId}', '${today}')`,
      expected: 'SQLSTATE 22023: You cannot designate yourself as verifier',
      actual: selfVerifierErr ? `${selfVerifierErr.code}: ${selfVerifierErr.message}` : 'Unexpected success',
      pass: selfVerifierErr?.code === '22023' && selfVerifierErr?.message?.includes('cannot designate yourself'),
      sqlstate: selfVerifierErr?.code,
      error: selfVerifierErr?.message,
    });

    // 10C: Submitting duplicate completion for an already-approved date
    await adminClient.query(`UPDATE public.proof_challenges SET created_at = created_at - interval '2 hours';`);
    let proofDup = (await submitterClient.query(`
      SELECT * FROM public.generate_proof_challenge('${challengeId}', '${creatorId}', '${today}');
    `)).rows[0];

    // Approve today first
    let compToday = (await submitterClient.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}', '${creatorId}', '${today}', '${proofDup.id}', 'Today first submission'
      );
    `)).rows[0];
    await verifierClient.query(`SELECT * FROM public.review_challenge_completion('${compToday.id}', 'approved', null);`);

    // Now try to generate proof for today again (already approved)
    let approvedDupErr = null;
    try {
      await submitterClient.query(`
        SELECT * FROM public.generate_proof_challenge('${challengeId}', '${creatorId}', '${today}');
      `);
    } catch (e) {
      approvedDupErr = e;
    }

    recordResult({
      scenario: '10C: Attempting proof generation for already-approved date raises 23505',
      setup: `Completion for ${today} is already approved`,
      rpc: `generate_proof_challenge('${challengeId}', '${creatorId}', '${today}')`,
      expected: `SQLSTATE 23505: Day ${today} is already approved`,
      actual: approvedDupErr ? `${approvedDupErr.code}: ${approvedDupErr.message}` : 'Unexpected success',
      pass: approvedDupErr?.code === '23505' && approvedDupErr?.message?.includes('already approved'),
      sqlstate: approvedDupErr?.code,
      error: approvedDupErr?.message,
    });

    // 10D: Reviewing an already-approved completion raises 22000
    let reReviewErr = null;
    try {
      await verifierClient.query(`
        SELECT * FROM public.review_challenge_completion('${compToday.id}', 'rejected', 'Late reject');
      `);
    } catch (e) {
      reReviewErr = e;
    }

    recordResult({
      scenario: '10D: Reviewing an already-approved completion raises SQLSTATE 22000',
      setup: `Completion ${compToday.id} is approved`,
      rpc: `review_challenge_completion('${compToday.id}', 'rejected', ...)`,
      expected: 'SQLSTATE 22000: Only pending submissions can be reviewed (current status: approved)',
      actual: reReviewErr ? `${reReviewErr.code}: ${reReviewErr.message}` : 'Unexpected success',
      pass: reReviewErr?.code === '22000' && reReviewErr?.message?.includes('Only pending submissions'),
      sqlstate: reReviewErr?.code,
      error: reReviewErr?.message,
    });

    // -------------------------------------------------------------------------
    // Final Summary
    // -------------------------------------------------------------------------
    const totalTests = results.length;
    const passedTests = results.filter(r => r.pass).length;
    const failedTests = totalTests - passedTests;

    console.log('================================================================');
    console.log(`TEST EXECUTION COMPLETE: ${passedTests}/${totalTests} PASSED, ${failedTests} FAILED`);
    console.log('================================================================');

    await submitterClient.end();
    await verifierClient.end();

  } finally {
    await adminClient.end();
  }
}

main().catch(err => {
  console.error('\n❌ FATAL TEST EXECUTION ERROR:', err);
  process.exit(1);
});
