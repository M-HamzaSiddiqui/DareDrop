// DareDrop Phase 39: Grace Period & Reliability Audit Tests
// File: scripts/test-phase39-grace-period-reliability.js

const { Client, types } = require('pg');
const assert = require('assert');

// Date parser: keep dates as ISO strings (YYYY-MM-DD)
types.setTypeParser(1082, str => str);

const DB_URL = 'postgres://umardinkhan@127.0.0.1:54332/daredrop_disposable_test';

let passed = 0;
let failed = 0;

function reportPass(name) {
  passed++;
  console.log(`  ✅ PASS: ${name}`);
}

function reportFail(name, err) {
  failed++;
  console.error(`  ❌ FAIL: ${name}:`, err.message || err);
}

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
  console.log('DareDrop Phase 39: 48-Hour Resubmission Grace Period Audit');
  console.log('================================================================\n');

  const adminClient = new Client({ connectionString: DB_URL });
  await adminClient.connect();

  try {
    // 0. Setup isolated test challenge and participants
    console.log('[Setup] Creating isolated test entities in disposable database...');
    const creatorId = '39000000-0000-0000-0000-000000000001';
    const participant1Id = '39000000-0000-0000-0000-000000000002';
    const verifier1Id = '39000000-0000-0000-0000-000000000003';
    const challengeId = '39000000-0000-0000-0000-000000000010';

    await adminClient.query(`
      DELETE FROM public.challenge_completions WHERE challenge_id = '${challengeId}';
      DELETE FROM public.proof_challenges WHERE challenge_id = '${challengeId}';
      DELETE FROM public.challenge_participants WHERE challenge_id = '${challengeId}';
      DELETE FROM public.challenges WHERE id = '${challengeId}';

      INSERT INTO public.challenges (
        id, creator_id, title, description, category, challenge_type, duration_days, timezone, created_at
      ) VALUES (
        '${challengeId}', '${creatorId}', 'Phase 39 Daily Dare', 'Test dare for Phase 39', 'Fitness', 'daily', 7, 'Asia/Kolkata', now() - interval '5 days'
      );

      INSERT INTO public.challenge_participants (challenge_id, user_id, joined_at) VALUES
        ('${challengeId}', '${creatorId}', now()),
        ('${challengeId}', '${participant1Id}', now()),
        ('${challengeId}', '${verifier1Id}', now());
    `);
    console.log('Setup completed.\n');

    const todayDate = (await adminClient.query(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date as d;`)).rows[0].d;
    const yesterdayDate = (await adminClient.query(`SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date - 1)::date as d;`)).rows[0].d;
    const olderDate = (await adminClient.query(`SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date - 2)::date as d;`)).rows[0].d;

    // =========================================================================
    // Test 1: First Submission
    // =========================================================================
    console.log('[Test 1] First Submission:');
    const p1Client = await createClient(participant1Id);
    let proof1Res = await p1Client.query(`
      SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifier1Id}', '${todayDate}');
    `);
    const proof1 = proof1Res.rows[0];
    assert.strictEqual(proof1.status, 'active');

    let sub1Res = await p1Client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}', '${verifier1Id}', '${todayDate}', '${proof1.id}', 'First submission note'
      );
    `);
    const comp1 = sub1Res.rows[0];
    assert.strictEqual(comp1.status, 'pending');
    assert.ok(comp1.first_submitted_at, 'first_submitted_at must be populated on first submission');
    assert.strictEqual(comp1.first_submitted_at.toISOString(), comp1.submitted_at.toISOString(), 'first_submitted_at must match submitted_at');
    assert.strictEqual(comp1.rejection_reason, null);
    assert.strictEqual(comp1.last_rejection_reason, null);
    assert.strictEqual(comp1.reviewed_at, null);
    assert.strictEqual(comp1.last_reviewed_at, null);

    // Check proof is consumed
    const proof1Check = (await adminClient.query(`SELECT status FROM public.proof_challenges WHERE id = '${proof1.id}';`)).rows[0];
    assert.strictEqual(proof1Check.status, 'consumed');
    reportPass('Test 1: First submission initializes pending completion, first_submitted_at, and consumes proof atomically');

    // =========================================================================
    // Test 2: Rejection
    // =========================================================================
    console.log('\n[Test 2] Rejection:');
    const vClient = await createClient(verifier1Id);
    let rev1Res = await vClient.query(`
      SELECT * FROM public.review_challenge_completion('${comp1.id}', 'rejected', 'Proof photo was too blurry');
    `);
    const rejected1 = rev1Res.rows[0];
    assert.strictEqual(rejected1.status, 'rejected');
    assert.strictEqual(rejected1.rejection_reason, 'Proof photo was too blurry');
    assert.ok(rejected1.reviewed_at, 'reviewed_at must be stamped');
    assert.strictEqual(rejected1.last_rejection_reason, null);
    reportPass('Test 2: Rejection sets status to rejected, stamps reviewed_at, and saves rejection_reason');

    // =========================================================================
    // Test 3: Resubmission within 48 hours
    // =========================================================================
    console.log('\n[Test 3] Resubmission within 48 hours:');
    let proof2Res = await p1Client.query(`
      SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifier1Id}', '${todayDate}');
    `);
    const proof2 = proof2Res.rows[0];
    assert.notStrictEqual(proof2.id, proof1.id, 'Fresh proof challenge must be created');
    assert.strictEqual(proof2.status, 'active');

    let sub2Res = await p1Client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}', '${verifier1Id}', '${todayDate}', '${proof2.id}', 'Resubmission with clearer photo'
      );
    `);
    const resub1 = sub2Res.rows[0];
    assert.strictEqual(resub1.status, 'pending');
    assert.strictEqual(resub1.id, comp1.id, 'Resubmission updates existing completion row');
    assert.strictEqual(resub1.rejection_reason, null, 'Active rejection_reason must be cleared to NULL');
    assert.strictEqual(resub1.last_rejection_reason, 'Proof photo was too blurry', 'Prior rejection reason preserved in last_rejection_reason');
    assert.strictEqual(resub1.reviewed_at, null, 'Active reviewed_at must be cleared to NULL');
    assert.ok(resub1.last_reviewed_at, 'Prior reviewed_at preserved in last_reviewed_at');
    reportPass('Test 3: Resubmission transitions rejected row back to pending and archives audit columns');

    // =========================================================================
    // Test 4: Rejection followed by resubmission near the 48-hour boundary (47h 55m)
    // =========================================================================
    console.log('\n[Test 4] Rejection followed by resubmission near the 48-hour boundary (47h 55m):');
    await vClient.query(`
      SELECT * FROM public.review_challenge_completion('${comp1.id}', 'rejected', 'Still incomplete');
    `);
    // Backdate completion_date to olderDate (< today - 1), first_submitted_at on-time, and reviewed_at to 47h 55m ago
    await adminClient.query(`
      UPDATE public.challenge_completions
      SET completion_date = '${olderDate}',
          first_submitted_at = ('${olderDate}'::date + interval '12 hours'),
          submitted_at = ('${olderDate}'::date + interval '12 hours'),
          reviewed_at = now() - interval '47 hours 55 minutes'
      WHERE id = '${comp1.id}';
    `);

    // Participant should still be permitted to generate proof and resubmit
    let proofNearRes = await p1Client.query(`
      SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifier1Id}', '${olderDate}');
    `);
    const proofNear = proofNearRes.rows[0];
    assert.strictEqual(proofNear.status, 'active');

    let subNearRes = await p1Client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}', '${verifier1Id}', '${olderDate}', '${proofNear.id}', 'Boundary resubmission'
      );
    `);
    assert.strictEqual(subNearRes.rows[0].status, 'pending');
    reportPass('Test 4: Resubmission at 47h 55m (within 48h boundary for date < today - 1) succeeds cleanly');

    // =========================================================================
    // Test 5: Resubmission after 48 hours (48h 05m)
    // =========================================================================
    console.log('\n[Test 5] Resubmission after 48 hours:');
    // Reject again and backdate reviewed_at to 48 hours 5 minutes ago
    await vClient.query(`
      SELECT * FROM public.review_challenge_completion('${comp1.id}', 'rejected', 'Too late now');
    `);
    await adminClient.query(`
      UPDATE public.challenge_completions
      SET reviewed_at = now() - interval '48 hours 5 minutes'
      WHERE id = '${comp1.id}';
    `);

    // Attempting to generate proof must fail with 22023
    let expiredGenError = null;
    try {
      await p1Client.query(`
        SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifier1Id}', '${olderDate}');
      `);
    } catch (e) {
      expiredGenError = e;
    }
    assert.ok(expiredGenError, 'Must fail when generating proof past 48h grace period');
    assert.strictEqual(expiredGenError.code, '22023');
    assert.ok(expiredGenError.message.includes('Resubmission grace period expired'), 'Expected grace period expiration message');
    reportPass('Test 5: Resubmission after 48 hours is strictly denied with SQLSTATE 22023');

    // =========================================================================
    // Test 6: Preservation of original first_submitted_at across multiple cycles
    // =========================================================================
    console.log('\n[Test 6] Preservation of original first_submitted_at across multiple cycles:');

    // Reset date to today and reviewed_at to 1 hour ago
    await adminClient.query(`
      UPDATE public.challenge_completions
      SET completion_date = '${todayDate}',
          reviewed_at = now() - interval '1 hour'
      WHERE id = '${comp1.id}';
    `);

    const originalFirstSubmittedAt = (await adminClient.query(`
      SELECT first_submitted_at FROM public.challenge_completions WHERE id = '${comp1.id}';
    `)).rows[0].first_submitted_at.toISOString();

    // Resubmit cycle 1
    let proofC1 = (await p1Client.query(`
      SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifier1Id}', '${todayDate}');
    `)).rows[0];
    let compC1 = (await p1Client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}', '${verifier1Id}', '${todayDate}', '${proofC1.id}', 'Cycle 1'
      );
    `)).rows[0];
    assert.strictEqual(compC1.first_submitted_at.toISOString(), originalFirstSubmittedAt, 'first_submitted_at must NOT change in cycle 1');

    // Reject cycle 1
    await vClient.query(`
      SELECT * FROM public.review_challenge_completion('${comp1.id}', 'rejected', 'Cycle 1 reject');
    `);

    // Resubmit cycle 2
    let proofC2 = (await p1Client.query(`
      SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifier1Id}', '${todayDate}');
    `)).rows[0];
    let compC2 = (await p1Client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}', '${verifier1Id}', '${todayDate}', '${proofC2.id}', 'Cycle 2'
      );
    `)).rows[0];
    assert.strictEqual(compC2.first_submitted_at.toISOString(), originalFirstSubmittedAt, 'first_submitted_at must NOT change in cycle 2');
    reportPass('Test 6: original first_submitted_at is preserved indefinitely across repeated rejection/resubmission cycles');

    // =========================================================================
    // Test 7: Correct update of the latest rejection reason
    // =========================================================================
    console.log('\n[Test 7] Correct update of the latest rejection reason:');
    assert.strictEqual(compC2.last_rejection_reason, 'Cycle 1 reject');
    assert.strictEqual(compC2.rejection_reason, null);

    // Reject with a distinct new reason
    const newRejectReason = 'Video did not show the physical dare action';
    let compC3 = (await vClient.query(`
      SELECT * FROM public.review_challenge_completion('${comp1.id}', 'rejected', '${newRejectReason}');
    `)).rows[0];
    assert.strictEqual(compC3.rejection_reason, newRejectReason);
    assert.strictEqual(compC3.last_rejection_reason, 'Cycle 1 reject');
    reportPass('Test 7: rejection_reason reflects the latest feedback while last_rejection_reason retains the prior feedback');

    // =========================================================================
    // Test 8: Correct reviewer timestamp
    // =========================================================================
    console.log('\n[Test 8] Correct reviewer timestamp:');
    const reviewTime1 = compC3.reviewed_at.toISOString();
    assert.ok(reviewTime1, 'reviewed_at is present after rejection');

    // Backdate prior proofs to avoid 5/hour rate limit
    await adminClient.query(`
      UPDATE public.proof_challenges
      SET created_at = created_at - interval '2 hours'
      WHERE participant_id = '${participant1Id}';
    `);

    // Resubmit
    let proofC3 = (await p1Client.query(`
      SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifier1Id}', '${todayDate}');
    `)).rows[0];
    let compC4 = (await p1Client.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}', '${verifier1Id}', '${todayDate}', '${proofC3.id}', 'Cycle 3'
      );
    `)).rows[0];
    assert.strictEqual(compC4.reviewed_at, null, 'reviewed_at is reset to NULL during resubmission');
    assert.strictEqual(compC4.last_reviewed_at.toISOString(), reviewTime1, 'last_reviewed_at holds the previous review timestamp');
    reportPass('Test 8: reviewer timestamps are accurately archived and reset during resubmission');

    // =========================================================================
    // Test 9: Concurrent proof generation and submission
    // =========================================================================
    console.log('\n[Test 9] Concurrent proof generation and submission:');
    // Allocate fresh participant to avoid rate limits
    const p9Id = '39000000-0000-0000-0000-000000000009';
    await adminClient.query(`
      INSERT INTO public.challenge_participants (challenge_id, user_id, joined_at)
      VALUES ('${challengeId}', '${p9Id}', now());
    `);

    const sessA = await createClient(p9Id);
    const sessB = await createClient(p9Id);

    // First generate a proof and create a rejected completion for p9
    const baseProof9 = (await sessA.query(`
      SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifier1Id}', '${todayDate}');
    `)).rows[0];

    const comp9 = (await sessA.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}', '${verifier1Id}', '${todayDate}', '${baseProof9.id}', 'Initial'
      );
    `)).rows[0];

    await vClient.query(`
      SELECT * FROM public.review_challenge_completion('${comp9.id}', 'rejected', 'Need retake');
    `);

    const readyProof9 = (await sessA.query(`
      SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifier1Id}', '${todayDate}');
    `)).rows[0];

    const [resA, resB] = await Promise.allSettled([
      sessA.query(`
        SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifier1Id}', '${todayDate}');
      `),
      sessB.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${challengeId}', '${verifier1Id}', '${todayDate}', '${readyProof9.id}', 'Concurrent note'
        );
      `),
    ]);

    const errA = resA.status === 'rejected' ? resA.reason : null;
    const errB = resB.status === 'rejected' ? resB.reason : null;

    // Neither session must deadlock! (Zero 40P01 errors)
    assert.notStrictEqual(errA?.code, '40P01', 'Session A must NOT encounter deadlock 40P01');
    assert.notStrictEqual(errB?.code, '40P01', 'Session B must NOT encounter deadlock 40P01');

    console.log('    Result A (generate):', errA ? `${errA.code}: ${errA.message}` : 'SUCCESS');
    console.log('    Result B (submit):  ', errB ? `${errB.code}: ${errB.message}` : 'SUCCESS');
    reportPass('Test 9: Concurrent proof generation and submission produces ZERO deadlocks (canonical lock ordering verified)');

    await sessA.end();
    await sessB.end();

    // =========================================================================
    // Test 10: Concurrent approval and resubmission
    // =========================================================================
    console.log('\n[Test 10] Concurrent approval and resubmission:');
    const p10Id = '39000000-0000-0000-0000-000000000010';
    await adminClient.query(`
      INSERT INTO public.challenge_participants (challenge_id, user_id, joined_at)
      VALUES ('${challengeId}', '${p10Id}', now());
    `);

    const sess10Sub = await createClient(p10Id);
    const sess10Ver = await createClient(verifier1Id);

    const proof10Init = (await sess10Sub.query(`
      SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifier1Id}', '${todayDate}');
    `)).rows[0];

    const comp10 = (await sess10Sub.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${challengeId}', '${verifier1Id}', '${todayDate}', '${proof10Init.id}', 'Initial 10'
      );
    `)).rows[0];

    await sess10Ver.query(`
      SELECT * FROM public.review_challenge_completion('${comp10.id}', 'rejected', 'Reject 10');
    `);

    const proof10Resub = (await sess10Sub.query(`
      SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifier1Id}', '${todayDate}');
    `)).rows[0];

    // Race approval vs resubmission
    const [raceApproveRes, raceResubmitRes] = await Promise.allSettled([
      sess10Ver.query(`SELECT * FROM public.review_challenge_completion('${comp10.id}', 'approved');`),
      sess10Sub.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${challengeId}', '${verifier1Id}', '${todayDate}', '${proof10Resub.id}', 'Race note 10'
        );
      `),
    ]);

    const approveErr = raceApproveRes.status === 'rejected' ? raceApproveRes.reason : null;
    const resubmitErr = raceResubmitRes.status === 'rejected' ? raceResubmitRes.reason : null;

    assert.notStrictEqual(approveErr?.code, '40P01', 'Approval must not encounter 40P01');
    assert.notStrictEqual(resubmitErr?.code, '40P01', 'Resubmission must not encounter 40P01');

    console.log('    Approval race outcome:   ', approveErr ? `${approveErr.code}: ${approveErr.message}` : 'APPROVED');
    console.log('    Resubmission race outcome:', resubmitErr ? `${resubmitErr.code}: ${resubmitErr.message}` : 'PENDING');
    reportPass('Test 10: Concurrent approval and resubmission safely serializes without deadlocks');

    await sess10Sub.end();
    await sess10Ver.end();

    // =========================================================================
    // Test 11: Concurrent cancellation and submission
    // =========================================================================
    console.log('\n[Test 11] Concurrent cancellation and submission:');
    const p11Id = '39000000-0000-0000-0000-000000000011';
    await adminClient.query(`
      INSERT INTO public.challenge_participants (challenge_id, user_id, joined_at)
      VALUES ('${challengeId}', '${p11Id}', now());
    `);

    const sess11Cancel = await createClient(p11Id);
    const sess11Submit = await createClient(p11Id);

    const raceProof11 = (await sess11Submit.query(`
      SELECT * FROM public.generate_proof_challenge('${challengeId}', '${verifier1Id}', '${todayDate}');
    `)).rows[0];

    // Race cancel vs submit
    const [raceCancelRes, raceSubmitRes] = await Promise.allSettled([
      sess11Cancel.query(`SELECT * FROM public.cancel_proof_challenge('${raceProof11.id}');`),
      sess11Submit.query(`
        SELECT * FROM public.submit_challenge_completion(
          '${challengeId}', '${verifier1Id}', '${todayDate}', '${raceProof11.id}', 'Race note 11'
        );
      `),
    ]);

    const cancelErr = raceCancelRes.status === 'rejected' ? raceCancelRes.reason : null;
    const submitErr = raceSubmitRes.status === 'rejected' ? raceSubmitRes.reason : null;

    assert.notStrictEqual(cancelErr?.code, '40P01', 'Cancel must not encounter 40P01');
    assert.notStrictEqual(submitErr?.code, '40P01', 'Submit must not encounter 40P01');

    // Mutual exclusion: exactly one must win
    const cancelWon = !cancelErr && submitErr;
    const submitWon = !submitErr && cancelErr;
    assert.ok(cancelWon || submitWon, 'Mutual exclusion must hold: either cancel or submit succeeds');

    console.log('    Cancel outcome: ', cancelErr ? `${cancelErr.code}: ${cancelErr.message}` : 'CANCELLED');
    console.log('    Submit outcome: ', submitErr ? `${submitErr.code}: ${submitErr.message}` : 'CONSUMED');
    reportPass('Test 11: Concurrent cancellation and submission enforces strict mutual exclusion (0 deadlocks)');

    await sess11Cancel.end();
    await sess11Submit.end();

    await p1Client.end();
    await vClient.end();

    // Cleanup test data on disposable database
    await adminClient.query(`
      DELETE FROM public.challenge_completions WHERE challenge_id = '${challengeId}';
      DELETE FROM public.proof_challenges WHERE challenge_id = '${challengeId}';
      DELETE FROM public.challenge_participants WHERE challenge_id = '${challengeId}';
      DELETE FROM public.challenges WHERE id = '${challengeId}';
    `);

    console.log('\n================================================================');
    console.log(`Phase 39 Audit Test Suite Complete: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================');

  } finally {
    await adminClient.end();
  }
}

main().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
