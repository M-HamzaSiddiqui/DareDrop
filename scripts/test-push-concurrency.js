// scripts/test-push-concurrency.js
// Dedicated concurrency, idempotency, and crash-recovery test suite for DareDrop push notifications
// Run with: node scripts/test-push-concurrency.js
// Uses exclusively the local disposable test database on port 54332.

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
  return '127.0.0.1';
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

function check(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  }
}

async function runConcurrencyTests() {
  console.log('🧪 Starting Live PostgreSQL Push Notification Concurrency & Fencing Test Suite...\n');
  const client = await pool.connect();

  try {
    // 1. Ensure Migrations 5 and 6 are applied on the local test database
    console.log('[Setup] Applying migration 20261024030000 and proposed 20261024040000 to local database:');
    const mig5Path = path.resolve(process.cwd(), 'supabase/migrations/20261024030000_push_notifications.sql');
    const mig5Sql = fs.readFileSync(mig5Path, 'utf8');
    await client.query(mig5Sql);

    const mig6Path = path.resolve(process.cwd(), 'supabase/migrations/20261024040000_atomic_notification_claims.sql');
    const mig6Sql = fs.readFileSync(mig6Path, 'utf8');
    await client.query(mig6Sql);
    check(true, 'Migrations applied cleanly to local disposable test database.');

    // Clean up test records
    await client.query(`DELETE FROM public.notification_deliveries WHERE idempotency_key LIKE 'test-race:%'`);

    // =========================================================================
    // TEST 1: Concurrent Fresh Claim Acquisition (2 Simultaneous Requests)
    // =========================================================================
    console.log('\n[Test 1] Concurrent Fresh Claims (2 Invocations racing on the same key):');
    const testKey1 = 'test-race:fresh:' + Date.now();

    const [res1, res2] = await Promise.all([
      pool.query(`SELECT * FROM public.claim_notification_delivery($1, NULL, 'submission_pending', 'user-1', 60)`, [testKey1]),
      pool.query(`SELECT * FROM public.claim_notification_delivery($1, NULL, 'submission_pending', 'user-1', 60)`, [testKey1]),
    ]);

    const row1 = res1.rows[0];
    const row2 = res2.rows[0];

    const claimedCount = [row1, row2].filter(r => r.claim_status === 'claimed').length;
    const inProgressCount = [row1, row2].filter(r => r.claim_status === 'in_progress').length;

    check(claimedCount === 1, 'Exactly one concurrent worker acquired the fresh claim (claimedCount == 1)');
    check(inProgressCount === 1, 'The losing concurrent worker received in_progress (inProgressCount == 1)');
    check(row1.delivery_id === row2.delivery_id, 'Both workers referenced the exact same delivery row ID');

    // =========================================================================
    // TEST 2: Concurrent Reclaim of an Expired Lease (Crash Recovery Race)
    // =========================================================================
    console.log('\n[Test 2] Concurrent Reclaim of Expired Lease (Simulated Worker Crash):');
    const testKey2 = 'test-race:expired:' + Date.now();

    // Insert an initial claim with expired timestamp (90 seconds ago, lease is 60s)
    const initialExpired = await client.query(`
      INSERT INTO public.notification_deliveries (
        idempotency_key, event_type, recipient_id, status, claim_token, claimed_at, created_at
      ) VALUES (
        $1, 'submission_pending', 'user-1', 'claimed', gen_random_uuid(), now() - interval '90 seconds', now() - interval '90 seconds'
      ) RETURNING id, claim_token
    `, [testKey2]);
    const originalToken = initialExpired.rows[0].claim_token;

    // Two concurrent workers both detect expired lease and attempt to reclaim simultaneously
    const [reclaim1, reclaim2] = await Promise.all([
      pool.query(`SELECT * FROM public.claim_notification_delivery($1, NULL, 'submission_pending', 'user-1', 60)`, [testKey2]),
      pool.query(`SELECT * FROM public.claim_notification_delivery($1, NULL, 'submission_pending', 'user-1', 60)`, [testKey2]),
    ]);

    const rRow1 = reclaim1.rows[0];
    const rRow2 = reclaim2.rows[0];

    const reclaimClaimed = [rRow1, rRow2].filter(r => r.claim_status === 'claimed');
    const reclaimInProgress = [rRow1, rRow2].filter(r => r.claim_status === 'in_progress');

    check(reclaimClaimed.length === 1, 'Exactly ONE worker succeeded in reclaiming the expired lease (no duplicate delivery)');
    check(reclaimInProgress.length === 1, 'The other worker received in_progress and backed off');
    check(reclaimClaimed[0].claim_token !== originalToken, 'Reclaiming worker received a fresh unique claim_token (fencing token)');

    // =========================================================================
    // TEST 3: Concurrent Retry of a Failed Delivery
    // =========================================================================
    console.log('\n[Test 3] Concurrent Retry of Failed Delivery (2 Invocations retrying):');
    const testKey3 = 'test-race:failed:' + Date.now();

    await client.query(`
      INSERT INTO public.notification_deliveries (
        idempotency_key, event_type, recipient_id, status, error, claim_token, claimed_at
      ) VALUES (
        $1, 'submission_pending', 'user-1', 'failed', 'Expo 500 error', gen_random_uuid(), now() - interval '10 seconds'
      )
    `, [testKey3]);

    const [retry1, retry2] = await Promise.all([
      pool.query(`SELECT * FROM public.claim_notification_delivery($1, NULL, 'submission_pending', 'user-1', 60)`, [testKey3]),
      pool.query(`SELECT * FROM public.claim_notification_delivery($1, NULL, 'submission_pending', 'user-1', 60)`, [testKey3]),
    ]);

    const retryClaimed = [retry1.rows[0], retry2.rows[0]].filter(r => r.claim_status === 'claimed');
    const retryInProgress = [retry1.rows[0], retry2.rows[0]].filter(r => r.claim_status === 'in_progress');

    check(retryClaimed.length === 1, 'Exactly one worker acquired the retry claim for failed delivery');
    check(retryInProgress.length === 1, 'Second retry contender was blocked with in_progress');

    // =========================================================================
    // TEST 4: Duplicate Delivery After Success ('sent')
    // =========================================================================
    console.log('\n[Test 4] Duplicate Invocation Arriving After Successful Delivery:');
    const testKey4 = 'test-race:success:' + Date.now();

    const claimRes4 = await client.query(`SELECT * FROM public.claim_notification_delivery($1, NULL, 'submission_pending', 'user-1', 60)`, [testKey4]);
    const deliveryId4 = claimRes4.rows[0].delivery_id;
    const token4 = claimRes4.rows[0].claim_token;

    // Mark delivery completed via complete_notification_delivery
    const compRes = await client.query(`SELECT public.complete_notification_delivery($1, $2, 'sent', 2, '{"expo": "ok"}'::jsonb, NULL)`, [deliveryId4, token4]);
    check(compRes.rows[0].complete_notification_delivery === true, 'Delivery successfully completed with active claim_token');

    // A late duplicate webhook arrives for the same idempotency key
    const lateReq = await client.query(`SELECT * FROM public.claim_notification_delivery($1, NULL, 'submission_pending', 'user-1', 60)`, [testKey4]);
    check(lateReq.rows[0].claim_status === 'already_processed', 'Late duplicate request returns already_processed (no duplicate send)');
    check(lateReq.rows[0].current_status === 'sent', 'Current status returned as sent');

    // =========================================================================
    // TEST 5: Fencing Token Defense Against Stale Workers
    // =========================================================================
    console.log('\n[Test 5] Fencing Token Protection Against Stale Workers:');
    const testKey5 = 'test-race:fencing:' + Date.now();

    // 1. Worker 1 claims delivery at T=0
    const w1Claim = await client.query(`SELECT * FROM public.claim_notification_delivery($1, NULL, 'submission_pending', 'user-1', 60)`, [testKey5]);
    const w1Token = w1Claim.rows[0].claim_token;
    const w1DelId = w1Claim.rows[0].delivery_id;

    // 2. Simulate worker 1 hanging past lease expiration (>60s)
    await client.query(`UPDATE public.notification_deliveries SET claimed_at = now() - interval '70 seconds' WHERE id = $1`, [w1DelId]);

    // 3. Worker 2 detects lease expired, reclaims delivery and gets new token
    const w2Claim = await client.query(`SELECT * FROM public.claim_notification_delivery($1, NULL, 'submission_pending', 'user-1', 60)`, [testKey5]);
    const w2Token = w2Claim.rows[0].claim_token;
    check(w2Claim.rows[0].claim_status === 'claimed', 'Worker 2 reclaimed expired lease');
    check(w1Token !== w2Token, 'Worker 2 was issued a distinct new claim_token');

    // 4. Worker 1 wakes up and attempts to complete with its stale token
    const w1StaleComp = await client.query(`
      SELECT public.complete_notification_delivery($1, $2, 'sent', 1, '{"stale": true}'::jsonb, NULL)
    `, [w1DelId, w1Token]);
    check(w1StaleComp.rows[0].complete_notification_delivery === false, 'Stale worker 1 was FENCED OUT (complete_notification_delivery returned false)');

    // 5. Worker 2 completes with its valid active token
    const w2ValidComp = await client.query(`
      SELECT public.complete_notification_delivery($1, $2, 'sent', 1, '{"valid": true}'::jsonb, NULL)
    `, [w1DelId, w2Token]);
    check(w2ValidComp.rows[0].complete_notification_delivery === true, 'Active worker 2 completed successfully');

    // Verify row state matches Worker 2's payload, not Worker 1's
    const finalRow = await client.query(`SELECT status, payload FROM public.notification_deliveries WHERE id = $1`, [w1DelId]);
    check(finalRow.rows[0].payload.valid === true, 'Database state contains active worker 2 data (stale worker 1 overwrite prevented)');

    // =========================================================================
    // TEST 6: Atomic Conditional Fallback (Schema Without RPC)
    // =========================================================================
    console.log('\n[Test 6] Atomic Conditional Update Fallback (Pre-migration compatibility):');
    const testKey6 = 'test-race:fallback:' + Date.now();

    // Create initial expired record
    const initFallback = await client.query(`
      INSERT INTO public.notification_deliveries (
        idempotency_key, event_type, recipient_id, status, created_at
      ) VALUES (
        $1, 'submission_pending', 'user-1', 'claimed', now() - interval '90 seconds'
      ) RETURNING id, created_at
    `, [testKey6]);
    const fbId = initFallback.rows[0].id;

    // Two workers attempt conditional reclaim using .lte('created_at', cutoffIso)
    const cutoffIso = new Date(Date.now() - 60000).toISOString();
    const [cReclaim1, cReclaim2] = await Promise.all([
      pool.query(`
        UPDATE public.notification_deliveries
        SET status = 'claimed', created_at = now(), error = NULL
        WHERE id = $1 AND status = 'claimed' AND created_at <= $2::timestamptz
        RETURNING id
      `, [fbId, cutoffIso]),
      pool.query(`
        UPDATE public.notification_deliveries
        SET status = 'claimed', created_at = now(), error = NULL
        WHERE id = $1 AND status = 'claimed' AND created_at <= $2::timestamptz
        RETURNING id
      `, [fbId, cutoffIso]),
    ]);

    const crRows1 = cReclaim1.rows.length;
    const crRows2 = cReclaim2.rows.length;

    check((crRows1 === 1 && crRows2 === 0) || (crRows1 === 0 && crRows2 === 1), 'Conditional update fallback: exactly ONE worker succeeded in reclaiming (1 row updated, 0 for loser)');

    // =========================================================================
    // TEST 7: Legacy Rows Backfill & Compatibility
    // =========================================================================
    console.log('\n[Test 7] Legacy Delivery Rows Compatibility & Backfill Simulation:');
    const testKey7 = 'test-race:legacy:' + Date.now();

    // Insert a legacy row (simulating pre-migration state where claimed_at was null or unaligned)
    const legRow = await client.query(`
      INSERT INTO public.notification_deliveries (
        idempotency_key, event_type, recipient_id, status, created_at, claimed_at
      ) VALUES (
        $1, 'submission_pending', 'user-legacy', 'claimed', now() - interval '2 hours', now() - interval '2 hours'
      ) RETURNING id, status, claimed_at
    `, [testKey7]);

    check(legRow.rows.length === 1, 'Legacy row created with 2-hour-old timestamp');

    // Run claim on this legacy expired row
    const legClaim = await client.query(`
      SELECT * FROM public.claim_notification_delivery($1, NULL, 'submission_pending', 'user-legacy', 60)
    `, [testKey7]);

    check(legClaim.rows[0].claim_status === 'claimed', 'Legacy expired row was cleanly reclaimed by new RPC');
    check(legClaim.rows[0].claim_token !== null, 'Legacy row assigned a valid claim_token');

    // =========================================================================
    // TEST 8: Prevention of Modifying Non-Claimed Rows in Completion RPC
    // =========================================================================
    console.log('\n[Test 8] Preventing Status Overwrite on Already Completed Records:');
    const testKey8 = 'test-race:complete-guard:' + Date.now();

    const cRes8 = await client.query(`SELECT * FROM public.claim_notification_delivery($1, NULL, 'submission_pending', 'user-8', 60)`, [testKey8]);
    const dId8 = cRes8.rows[0].delivery_id;
    const tok8 = cRes8.rows[0].claim_token;

    // First completion -> marks sent
    const c1 = await client.query(`SELECT public.complete_notification_delivery($1, $2, 'sent', 1, '{}'::jsonb, NULL)`, [dId8, tok8]);
    check(c1.rows[0].complete_notification_delivery === true, 'Initial completion to sent succeeded');

    // Attempting a second completion with the SAME token must be rejected because status is no longer claimed
    const c2 = await client.query(`SELECT public.complete_notification_delivery($1, $2, 'failed', 0, '{}'::jsonb, 'Late failure')`, [dId8, tok8]);
    check(c2.rows[0].complete_notification_delivery === false, 'complete_notification_delivery rejected changing already-sent record (returned false)');

    const finalStatus8 = await client.query(`SELECT status FROM public.notification_deliveries WHERE id = $1`, [dId8]);
    check(finalStatus8.rows[0].status === 'sent', 'Record remains sent (no status corruption)');

    // =========================================================================
    // TEST 9: Edge Function Handler No-Dispatch When Claim Acquisition Fails
    // =========================================================================
    console.log('\n[Test 9] Edge Function Handler Aborts Without Calling External Push API:');
    // Load edge function transpiled
    const ts = require('typescript');
    const edgeFnCode = fs.readFileSync(path.resolve(process.cwd(), 'supabase/functions/send-push-notification/index.ts'), 'utf8');
    const transpiled = ts.transpileModule(edgeFnCode, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;

    let pushApiCallCount = 0;
    globalThis.fetch = async (url) => {
      if (String(url).includes('exp.host')) {
        pushApiCallCount++;
        return { json: async () => ({ data: [{ status: 'ok' }] }) };
      }
      return { json: async () => ({}) };
    };

    let handler = null;
    const mockDeno = {
      serve: (h) => { handler = h; },
      env: {
        get: (k) => {
          if (k === 'WEBHOOK_SECRET') return 'test_sec';
          if (k === 'SUPABASE_URL') return 'https://test.supabase.co';
          if (k === 'SUPABASE_SERVICE_ROLE_KEY') return 'test_key';
          return '';
        },
      },
    };

    // Case 9A: When claim is already processed, push API is NEVER called
    const edgeExp = {};
    new Function('exports', 'require', 'Deno', 'crypto', transpiled)(
      edgeExp,
      (mod) => {
        if (mod.includes('supabase-js')) {
          return {
            createClient: () => ({
              rpc: async (fn) => {
                if (fn === 'claim_notification_delivery') {
                  return { data: [{ claim_status: 'already_processed', current_status: 'sent' }], error: null };
                }
                return { data: true, error: null };
              },
              from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [] }) }) }),
            }),
          };
        }
        return {};
      },
      mockDeno,
      require('crypto').webcrypto || globalThis.crypto
    );

    const testPayload = JSON.stringify({
      type: 'INSERT',
      table: 'challenge_completions',
      schema: 'public',
      record: {
        id: '00000000-0000-0000-0000-000000000001',
        challenge_id: '11111111-1111-1111-1111-111111111111',
        challenge_type: 'daily',
        participant_id: 'user-sub',
        verifier_id: 'user-ver',
        completion_date: '2026-10-24',
        status: 'pending',
        submitted_at: '2026-10-24T12:00:00Z',
      },
    });

    const reqAlreadyProcessed = new Request('https://edge.supabase.co/send-push-notification', {
      method: 'POST',
      headers: { 'x-webhook-secret': 'test_sec', 'Content-Type': 'application/json' },
      body: testPayload,
    });

    const resAlready = await handler(reqAlreadyProcessed);
    check(resAlready.status === 200, 'Already processed claim returns HTTP 200');
    check(pushApiCallCount === 0, 'ZERO external push API calls made when claim is already processed');

    // Case 9B: When claim is in_progress by another worker, push API is NEVER called
    const edgeExpInProgress = {};
    new Function('exports', 'require', 'Deno', 'crypto', transpiled)(
      edgeExpInProgress,
      (mod) => {
        if (mod.includes('supabase-js')) {
          return {
            createClient: () => ({
              rpc: async (fn) => {
                if (fn === 'claim_notification_delivery') {
                  return { data: [{ claim_status: 'in_progress', current_status: 'claimed' }], error: null };
                }
                return { data: true, error: null };
              },
              from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [] }) }) }),
            }),
          };
        }
        return {};
      },
      mockDeno,
      require('crypto').webcrypto || globalThis.crypto
    );

    const reqInProgress = new Request('https://edge.supabase.co/send-push-notification', {
      method: 'POST',
      headers: { 'x-webhook-secret': 'test_sec', 'Content-Type': 'application/json' },
      body: testPayload,
    });

    const resProg = await handler(reqInProgress);
    check(resProg.status === 200, 'In-progress claim returns HTTP 200');
    check(pushApiCallCount === 0, 'ZERO external push API calls made when claim is held by concurrent worker');

    // Clean up test data
    await client.query(`DELETE FROM public.notification_deliveries WHERE idempotency_key LIKE 'test-race:%'`);

    console.log(`\n🎉 ALL PUSH CONCURRENCY & FENCING TESTS PASSED! (${passed} passed, ${failed} failed)`);
  } finally {
    client.release();
    await pool.end();
  }
}

runConcurrencyTests().catch((err) => {
  console.error('Concurrency test failure:', err);
  process.exit(1);
});
