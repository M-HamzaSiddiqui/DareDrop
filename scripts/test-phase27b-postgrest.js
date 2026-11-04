// DareDrop Phase 27B: Standalone PostgREST HTTP Compatibility Validation Suite
// File: scripts/test-phase27b-postgrest.js
// Run with: node scripts/test-phase27b-postgrest.js

const { Pool } = require('pg');
const crypto = require('crypto');
const assert = require('assert');

// ============================================================================
// 0. CONFIGURATION & GUARDS
// ============================================================================
const POSTGREST_URL = process.env.POSTGREST_URL || 'http://127.0.0.1:54333';
const JWT_SECRET = 'daredrop_local_test_jwt_secret_must_be_at_least_32_characters_long!';

const PG_CONFIG = {
  host: '/home/umardinkhan/.gemini/antigravity-ide/brain/5884f32a-9471-4b64-933f-d6f6787fa790/scratch',
  port: 54332,
  database: 'daredrop_disposable_test',
  user: 'umardinkhan',
};

const pool = new Pool(PG_CONFIG);

function makeJwt({ sub, role = 'authenticated', email = 'test@example.com' }) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    role,
    sub,
    email,
    app_metadata: { provider: 'email' },
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(unsigned).digest('base64url');
  return `${unsigned}.${sig}`;
}

async function postgrestRpc(rpcName, body, jwtToken) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (jwtToken) {
    headers['Authorization'] = `Bearer ${jwtToken}`;
  }

  const res = await fetch(`${POSTGREST_URL}/rpc/${rpcName}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }

  return {
    status: res.status,
    ok: res.ok,
    data: json,
  };
}

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

// ============================================================================
// MAIN SUITE
// ============================================================================
async function main() {
  console.log('================================================================');
  console.log('DareDrop Phase 27B: Standalone PostgREST HTTP Compatibility Suite');
  console.log('================================================================\n');

  console.log(`Target PostgREST: ${POSTGREST_URL}`);
  console.log(`Target Database: PostgreSQL 18.6 on port 54332 (${PG_CONFIG.database})\n`);

  // 1. Verify PostgREST Health
  console.log('--- Section 1: PostgREST API Health & Schema Verification ---');
  const rootRes = await fetch(`${POSTGREST_URL}/`);
  assert.strictEqual(rootRes.status, 200, 'Root endpoint must return 200 OK');
  reportPass('PostgREST HTTP root endpoint online (HTTP 200 OK)');

  // 2. Setup Test Data in PostgreSQL
  console.log('\n--- Section 2: Fixture Setup in Disposable PostgreSQL ---');
  await pool.query('TRUNCATE TABLE public.challenge_completions, public.proof_challenges CASCADE;');
  const creatorId = '11111111-0000-0000-0000-000000000001';
  const participantA = '22222222-0000-0000-0000-000000000001';
  const verifierB = '33333333-0000-0000-0000-000000000002';
  const unrelatedUser = '44444444-0000-0000-0000-000000000003';

  // Ensure profiles and challenge exist
  await pool.query(`
    INSERT INTO public.user_profiles (user_id, display_name, friend_code)
    VALUES 
      ('${creatorId}', 'Creator Charlie', 'DARE-CHRL-0001'),
      ('${participantA}', 'Participant Alice', 'DARE-ALIC-0002'),
      ('${verifierB}', 'Verifier Bob', 'DARE-BOBB-0003'),
      ('${unrelatedUser}', 'Stranger Sam', 'DARE-STRG-0004')
    ON CONFLICT (user_id) DO NOTHING;
  `);

  const chalRes = await pool.query(`
    INSERT INTO public.challenges (
      title, description, category, duration_days, creator_id, creator_name,
      challenge_type, timezone, created_at, ends_at
    ) VALUES (
      'PostgREST HTTP Dare', 'Testing real PostgREST HTTP RPCs', 'Fitness',
      7, '${creatorId}', 'Creator Charlie', 'daily', 'UTC',
      NOW() - interval '1 day', NOW() + interval '6 days'
    ) RETURNING id;
  `);
  const challengeId = chalRes.rows[0].id;

  await pool.query(`
    INSERT INTO public.challenge_participants (challenge_id, user_id, joined_at)
    VALUES
      ('${challengeId}', '${creatorId}', NOW() - interval '1 day'),
      ('${challengeId}', '${participantA}', NOW() - interval '1 day'),
      ('${challengeId}', '${verifierB}', NOW() - interval '1 day')
    ON CONFLICT (challenge_id, user_id) DO NOTHING;
  `);

  const todayStr = new Date().toISOString().split('T')[0];
  const tokenAlice = makeJwt({ sub: participantA });
  const tokenBob = makeJwt({ sub: verifierB });
  const tokenStranger = makeJwt({ sub: unrelatedUser });

  reportPass(`Created test challenge ${challengeId} with participants Alice and Bob.`);

  // 3. Exercise Legacy 4-Argument HTTP Calls
  console.log('\n--- Section 3: Legacy 4-Argument RPC HTTP Testing ---');

  // Test 3a: Legacy 4-arg call with submission note
  const countCompsBefore = await pool.query('SELECT count(*) FROM public.challenge_completions;');
  const legacyNoteRes = await postgrestRpc(
    'submit_challenge_completion',
    {
      p_challenge_id: challengeId,
      p_verifier_id: verifierB,
      p_completion_date: todayStr,
      p_submission_note: 'Legacy HTTP submission with note',
    },
    tokenAlice
  );

  assert.strictEqual(legacyNoteRes.status, 400, 'Legacy call must return HTTP 400 Bad Request');
  assert.strictEqual(legacyNoteRes.data.code, 'P0001', 'Legacy call must return SQLSTATE P0001');
  assert(
    legacyNoteRes.data.message.includes('App update required: DareDrop now requires dynamic proof verification'),
    `Message must advise user to update app. Got: ${legacyNoteRes.data.message}`
  );
  reportPass('Legacy 4-arg HTTP RPC (with note) correctly resolves rejection stub and returns HTTP 400 P0001 with update message');

  // Test 3b: Legacy 4-arg call omitting optional submission note (3 parameters provided)
  const legacyNoNoteRes = await postgrestRpc(
    'submit_challenge_completion',
    {
      p_challenge_id: challengeId,
      p_verifier_id: verifierB,
      p_completion_date: todayStr,
    },
    tokenAlice
  );

  assert.strictEqual(legacyNoNoteRes.status, 400, 'Legacy call omitting optional note must return HTTP 400');
  assert.strictEqual(legacyNoNoteRes.data.code, 'P0001', 'Legacy call omitting optional note must return P0001');
  assert(
    legacyNoNoteRes.data.message.includes('App update required: DareDrop now requires dynamic proof verification'),
    'Legacy call omitting optional note must advise user to update'
  );
  reportPass('Legacy 4-arg HTTP RPC (omitting optional note) correctly resolves rejection stub with default parameter');

  // Verify zero completion records created
  const countCompsAfter = await pool.query('SELECT count(*) FROM public.challenge_completions;');
  assert.strictEqual(
    countCompsBefore.rows[0].count,
    countCompsAfter.rows[0].count,
    'Zero completion records must be created by legacy 4-arg RPC calls'
  );
  reportPass('Verified database integrity: Zero completion records inserted by legacy calls');

  // 4. Exercise New 5-Argument HTTP Calls
  console.log('\n--- Section 4: Primary 5-Argument Proof RPC HTTP Testing ---');

  // Test 4a: Generate dynamic proof challenge via HTTP RPC
  const genRes = await postgrestRpc(
    'generate_proof_challenge',
    {
      p_challenge_id: challengeId,
      p_verifier_id: verifierB,
      p_completion_date: todayStr,
    },
    tokenAlice
  );

  assert.strictEqual(genRes.status, 200, 'Proof challenge generation must succeed with HTTP 200');
  const proofChallenge = genRes.data;
  assert(proofChallenge && proofChallenge.id, 'Proof challenge record must have an id');
  assert.strictEqual(proofChallenge.status, 'active');
  assert.strictEqual(proofChallenge.participant_id, participantA);
  assert.strictEqual(proofChallenge.verifier_id, verifierB);
  assert(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/.test(proofChallenge.proof_code), 'Code must be 4-char Crockford Base32');
  reportPass(`Proof challenge generated via HTTP: code="${proofChallenge.proof_code}", prompt="${proofChallenge.action_prompt}"`);

  // Test 4b: Submit valid 5-argument completion via HTTP RPC
  const submit5Res = await postgrestRpc(
    'submit_challenge_completion',
    {
      p_challenge_id: challengeId,
      p_verifier_id: verifierB,
      p_completion_date: todayStr,
      p_proof_challenge_id: proofChallenge.id,
      p_submission_note: 'Verified with dynamic gesture!',
    },
    tokenAlice
  );

  assert.strictEqual(submit5Res.status, 200, 'Valid 5-arg submission must succeed with HTTP 200');
  const completion = submit5Res.data;
  assert(completion && completion.id, 'Completion record must be created');
  assert.strictEqual(completion.status, 'pending');
  assert.strictEqual(completion.proof_code, proofChallenge.proof_code);
  assert.strictEqual(completion.action_prompt, proofChallenge.action_prompt);
  assert.strictEqual(completion.proof_challenge_id, proofChallenge.id);
  reportPass('New 5-arg HTTP RPC successfully creates pending completion with matching proof metadata');

  // Test 4c: Verify atomic proof consumption in database
  const pcCheck = await pool.query(`SELECT status, consumed_at FROM public.proof_challenges WHERE id = '${proofChallenge.id}';`);
  assert.strictEqual(pcCheck.rows[0].status, 'consumed', 'Proof challenge status must be "consumed"');
  assert(pcCheck.rows[0].consumed_at !== null, 'consumed_at timestamp must be populated');
  reportPass('Database confirms proof challenge was atomically consumed with timestamp');

  // 5. Invalid Proof Challenges via HTTP
  console.log('\n--- Section 5: Invalid & Tampered Proof HTTP Testing ---');
  const yesterdayStr = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  // Test 5a: Reusing consumed proof challenge
  const reuseRes = await postgrestRpc(
    'submit_challenge_completion',
    {
      p_challenge_id: challengeId,
      p_verifier_id: verifierB,
      p_completion_date: todayStr,
      p_proof_challenge_id: proofChallenge.id,
      p_submission_note: 'Replay attempt',
    },
    tokenAlice
  );
  assert.strictEqual(reuseRes.status, 400, 'Replay attempt must return HTTP 400');
  assert(reuseRes.data.message.includes('no longer active') || reuseRes.data.message.includes('consumed'), 'Replay must be rejected');
  reportPass('HTTP rejection: Consumed proof challenge cannot be reused (replay attack blocked)');

  // Test 5b: Null proof challenge ID
  const nullProofRes = await postgrestRpc(
    'submit_challenge_completion',
    {
      p_challenge_id: challengeId,
      p_verifier_id: verifierB,
      p_completion_date: yesterdayStr,
      p_proof_challenge_id: null,
      p_submission_note: 'Null proof attempt',
    },
    tokenAlice
  );
  assert.strictEqual(nullProofRes.status, 400, 'Null proof must return HTTP 400');
  assert(nullProofRes.data.message.includes('valid proof challenge is required'), 'Null proof must be rejected');
  reportPass('HTTP rejection: Explicit null proof challenge ID rejected with 22023');

  // Test 5c: Expired proof challenge
  const genExpRes = await postgrestRpc(
    'generate_proof_challenge',
    {
      p_challenge_id: challengeId,
      p_verifier_id: verifierB,
      p_completion_date: yesterdayStr,
    },
    tokenAlice
  );
  const pcExpId = genExpRes.data.id;
  // Mutate expires_at to 10 minutes in the past
  await pool.query(`UPDATE public.proof_challenges SET expires_at = NOW() - interval '10 minutes' WHERE id = '${pcExpId}';`);

  const expRes = await postgrestRpc(
    'submit_challenge_completion',
    {
      p_challenge_id: challengeId,
      p_verifier_id: verifierB,
      p_completion_date: yesterdayStr,
      p_proof_challenge_id: pcExpId,
      p_submission_note: 'Expired proof attempt',
    },
    tokenAlice
  );
  assert.strictEqual(expRes.status, 400, 'Expired proof must return HTTP 400');
  assert(expRes.data.message.includes('expired'), 'Expired proof challenge must be rejected');
  reportPass('HTTP rejection: Expired proof challenge rejected based on database expires_at');

  // Test 5d: Cancelled proof challenge
  const genCancelRes = await postgrestRpc(
    'generate_proof_challenge',
    {
      p_challenge_id: challengeId,
      p_verifier_id: verifierB,
      p_completion_date: yesterdayStr,
    },
    tokenAlice
  );
  const pcCancelId = genCancelRes.data.id;
  const cancelRes = await postgrestRpc(
    'cancel_proof_challenge',
    { p_proof_challenge_id: pcCancelId },
    tokenAlice
  );
  assert.strictEqual(cancelRes.status, 200, 'Cancellation must succeed with HTTP 200');

  const submitCancelRes = await postgrestRpc(
    'submit_challenge_completion',
    {
      p_challenge_id: challengeId,
      p_verifier_id: verifierB,
      p_completion_date: yesterdayStr,
      p_proof_challenge_id: pcCancelId,
      p_submission_note: 'Cancelled proof attempt',
    },
    tokenAlice
  );
  assert.strictEqual(submitCancelRes.status, 400, 'Cancelled proof must return HTTP 400');
  assert(submitCancelRes.data.message.includes('no longer active') || submitCancelRes.data.message.includes('cancelled'), 'Cancelled proof must be rejected');
  reportPass('HTTP rejection: Cancelled proof challenge cannot be submitted');

  // Test 5e: Unknown parameter name (PostgREST schema mismatch)
  const unknownParamRes = await postgrestRpc(
    'submit_challenge_completion',
    {
      p_challenge_id: challengeId,
      p_verifier_id: verifierB,
      p_completion_date: yesterdayStr,
      p_fake_parameter: 'injected',
    },
    tokenAlice
  );
  assert.strictEqual(unknownParamRes.status, 404, 'Unknown parameters must return HTTP 404 Function not found');
  assert.strictEqual(unknownParamRes.data.code, 'PGRST202', 'Must return PostgREST error PGRST202');
  reportPass('HTTP rejection: Unknown parameter shapes fail with PostgREST 404 PGRST202 (strict parameter signature matching)');

  // 6. Schema-Cache Reload Behavior
  console.log('\n--- Section 6: PostgREST Schema-Cache Reload Behavior ---');
  // Fire schema reload via Postgres NOTIFY channel 'pgrst'
  await pool.query("NOTIFY pgrst, 'reload schema';");
  // Give PostgREST 200ms to process notification
  await new Promise(r => setTimeout(r, 200));

  // Verify both overloads remain functional after schema reload
  const reloadLegacyRes = await postgrestRpc(
    'submit_challenge_completion',
    {
      p_challenge_id: challengeId,
      p_verifier_id: verifierB,
      p_completion_date: todayStr,
    },
    tokenAlice
  );
  assert.strictEqual(reloadLegacyRes.status, 400);
  assert.strictEqual(reloadLegacyRes.data.code, 'P0001');

  const reload5GenRes = await postgrestRpc(
    'generate_proof_challenge',
    {
      p_challenge_id: challengeId,
      p_verifier_id: verifierB,
      p_completion_date: yesterdayStr,
    },
    tokenAlice
  );
  assert.strictEqual(reload5GenRes.status, 200);
  reportPass('PostgREST schema cache reload via NOTIFY pgrst, "reload schema" observed; both overloads remain discoverable');

  // 7. Authorization & Security Enforcement via HTTP
  console.log('\n--- Section 7: Authorization & Security Enforcement via HTTP ---');

  // 7a. Non-participant cannot generate proof challenge
  const strangerGenRes = await postgrestRpc(
    'generate_proof_challenge',
    {
      p_challenge_id: challengeId,
      p_verifier_id: verifierB,
      p_completion_date: todayStr,
    },
    tokenStranger
  );
  assert.strictEqual(strangerGenRes.status, 403, 'Non-participant generation must fail with HTTP 403 Forbidden');
  assert.strictEqual(strangerGenRes.data.code, '42501', 'Must fail with 42501 Insufficient Privilege');
  reportPass('HTTP authorization: Non-participant cannot generate proof challenge (HTTP 403 / 42501)');

  // 7b. Self-verification is rejected via HTTP
  const selfVerRes = await postgrestRpc(
    'generate_proof_challenge',
    {
      p_challenge_id: challengeId,
      p_verifier_id: participantA, // Alice designating Alice
      p_completion_date: todayStr,
    },
    tokenAlice
  );
  assert.strictEqual(selfVerRes.status, 400, 'Self-verification must fail');
  assert(selfVerRes.data.message.includes('cannot designate yourself as verifier'), 'Self-verification must be rejected');
  reportPass('HTTP authorization: Anti-self-verification strictly enforced (22023)');

  // 7c. Direct table writes on proof_challenges blocked via HTTP
  const directInsertRes = await fetch(`${POSTGREST_URL}/proof_challenges`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${tokenAlice}`,
    },
    body: JSON.stringify({
      challenge_id: challengeId,
      participant_id: participantA,
      verifier_id: verifierB,
      completion_date: todayStr,
      proof_code: 'FAKE',
      action_prompt_id: 'fake',
      action_prompt: 'fake',
    }),
  });
  assert(directInsertRes.status === 401 || directInsertRes.status === 403, `Direct INSERT must fail with HTTP 401 or 403 (got ${directInsertRes.status})`);
  reportPass('HTTP authorization: Direct table INSERT on public.proof_challenges strictly blocked by PostgREST');

  console.log('\n================================================================');
  console.log(`🎉 ALL PHASE 27B POSTGREST HTTP TESTS PASSED! (${passedTests} passed, ${failedTests} failed)`);
  console.log('================================================================');
}

main()
  .then(() => pool.end())
  .catch(err => {
    console.error('\n❌ Suite Error:', err);
    pool.end();
    process.exit(1);
  });
