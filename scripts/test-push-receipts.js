// scripts/test-push-receipts.js
// Dedicated offline automated test suite for DareDrop Expo Push Receipt Polling Worker (check-push-receipts)
// Validates 24-hour boundary, ticket issuance time, conservative legacy expiry, CAS with NULL claim_token,
// and token deletion error handling / fence loss.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

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

async function runReceiptWorkerTests() {
  console.log('🧪 Starting DareDrop Push Receipt Polling Worker Safety Test Suite...\n');

  // Load and transpile Edge Function
  const edgeFnPath = path.resolve(process.cwd(), 'supabase/functions/check-push-receipts/index.ts');
  const edgeFnCode = fs.readFileSync(edgeFnPath, 'utf8');
  const transpiled = ts.transpileModule(edgeFnCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  let envState = {
    SCHEDULER_SECRET: 'test_scheduler_secret_12345',
    SUPABASE_SERVICE_ROLE_KEY: 'test_service_role_key_67890',
    SUPABASE_URL: 'https://test.supabase.co',
    EXPO_ACCESS_TOKEN: 'mock_expo_access_token',
  };

  const mockDeno = {
    serve: () => {},
    env: {
      get: (key) => envState[key] || '',
    },
  };

  const edgeExports = {};
  new Function('exports', 'require', 'Deno', 'crypto', transpiled)(
    edgeExports,
    (mod) => {
      if (mod.includes('supabase-js')) {
        return {
          createClient: () => mockSupabaseClient,
        };
      }
      return require(mod);
    },
    mockDeno,
    require('crypto').webcrypto || globalThis.crypto
  );

  const {
    secureCompare,
    authenticateSchedulerRequest,
    extractTicketAssociations,
    getAuthoritativeSentTime,
    checkPushReceiptsHandler,
  } = edgeExports;

  // ----------------------------------------------------
  // Test Suite 1: Authentication Hardening & Constant-Time Security
  // ----------------------------------------------------
  console.log('[Test Suite 1] Scheduler Authentication Hardening:');

  const reqValidScheduler = new Request('https://test.supabase.co/functions/v1/check-push-receipts', {
    method: 'POST',
    headers: { 'x-scheduler-secret': 'test_scheduler_secret_12345' },
  });
  const auth1 = await authenticateSchedulerRequest(reqValidScheduler, envState.SCHEDULER_SECRET);
  check(auth1.authorized === true, 'Accepts valid x-scheduler-secret');

  const reqValidCron = new Request('https://test.supabase.co/functions/v1/check-push-receipts', {
    method: 'POST',
    headers: { 'x-cron-secret': 'test_scheduler_secret_12345' },
  });
  const auth2 = await authenticateSchedulerRequest(reqValidCron, envState.SCHEDULER_SECRET);
  check(auth2.authorized === true, 'Accepts valid x-cron-secret');

  const reqBearerScheduler = new Request('https://test.supabase.co/functions/v1/check-push-receipts', {
    method: 'POST',
    headers: { authorization: 'Bearer test_scheduler_secret_12345' },
  });
  const auth3 = await authenticateSchedulerRequest(reqBearerScheduler, envState.SCHEDULER_SECRET);
  check(auth3.authorized === true, 'Accepts valid Bearer SCHEDULER_SECRET');

  const reqBearerService = new Request('https://test.supabase.co/functions/v1/check-push-receipts', {
    method: 'POST',
    headers: { authorization: 'Bearer test_service_role_key_67890' },
  });
  const auth4 = await authenticateSchedulerRequest(reqBearerService, envState.SCHEDULER_SECRET);
  check(auth4.authorized === false && auth4.reason.includes('Invalid'), 'Rejects service-role key when dedicated SCHEDULER_SECRET is required');

  const reqMissing = new Request('https://test.supabase.co/functions/v1/check-push-receipts', { method: 'POST' });
  const auth5 = await authenticateSchedulerRequest(reqMissing, envState.SCHEDULER_SECRET);
  check(auth5.authorized === false && auth5.reason.includes('Missing'), 'Rejects requests missing authorization headers');

  const reqInvalid = new Request('https://test.supabase.co/functions/v1/check-push-receipts', {
    method: 'POST',
    headers: { 'x-scheduler-secret': 'wrong_secret_12345' },
  });
  const auth6 = await authenticateSchedulerRequest(reqInvalid, envState.SCHEDULER_SECRET);
  check(auth6.authorized === false && auth6.reason.includes('Invalid'), 'Rejects invalid credentials');

  const auth7 = await authenticateSchedulerRequest(reqValidScheduler, '');
  check(auth7.authorized === false && auth7.reason.includes('not configured'), 'Fails closed when scheduler secret is unconfigured');

  // ----------------------------------------------------
  // Test Suite 2: Ticket & Token Row ID Association (Zero Token Exposure)
  // ----------------------------------------------------
  console.log('\n[Test Suite 2] Ticket-to-Row-ID Association (Zero Token Exposure):');

  const modernDelivery = {
    id: 'del-modern-1',
    payload: {
      tickets: [
        { id: 'ticket-phone', token_id: '00000000-0000-0000-0000-000000000001', status: 'ok' },
        { id: 'ticket-tablet', token_id: '00000000-0000-0000-0000-000000000002', status: 'ok' },
      ],
    },
  };
  const modernAssocs = extractTicketAssociations(modernDelivery);
  check(modernAssocs.length === 2, 'Extracts multiple ticket associations');
  check(modernAssocs[0].tokenId === '00000000-0000-0000-0000-000000000001', 'Maps phone ticket to row ID');
  check(modernAssocs[1].tokenId === '00000000-0000-0000-0000-000000000002', 'Maps tablet ticket to row ID');
  check(
    !JSON.stringify(modernDelivery).includes('ExponentPushToken') && !JSON.stringify(modernDelivery).includes('ExpoPushToken'),
    'Verified zero raw push tokens persisted in modern delivery payload'
  );

  const historicalDelivery = {
    id: 'del-hist-1',
    payload: {
      expoResponse: {
        data: [{ status: 'ok', id: 'hist-ticket-1' }],
      },
    },
  };
  const histAssocs = extractTicketAssociations(historicalDelivery);
  check(histAssocs.length === 1, 'Extracts ticket IDs from historical delivery');
  check(histAssocs[0].tokenId === null, 'Identifies token row ID as unavailable (null) for historical records');

  // ----------------------------------------------------
  // Test Suite 3: Authoritative Sent Time Tracing
  // ----------------------------------------------------
  console.log('\n[Test Suite 3] Authoritative Sent Time Tracing:');

  const tSent = new Date('2026-10-27T10:00:00Z').getTime();

  const dWithSentAt = {
    created_at: '2026-10-27T06:00:00Z',
    claimed_at: '2026-10-27T08:00:00Z',
    payload: { sent_at: '2026-10-27T10:00:00Z' },
  };
  check(getAuthoritativeSentTime(dWithSentAt) === tSent, 'Returns payload.sent_at when present');

  const dWithoutSentAt = {
    created_at: '2026-10-27T06:00:00Z',
    claimed_at: '2026-10-27T08:00:00Z',
    payload: {},
  };
  check(getAuthoritativeSentTime(dWithoutSentAt) === null, 'Returns null for legacy records lacking sent_at (no false assumptions)');

  // ----------------------------------------------------
  // Test Suite 4: End-to-End Worker Hardening, CAS & Safety Scenarios
  // ----------------------------------------------------
  console.log('\n[Test Suite 4] Worker Hardening, CAS & Error Handling Scenarios:');

  let dbDeliveries = [];
  let dbTokens = [];
  let expoReceiptResponse = {};
  let expoShouldThrow = false;
  let expoFetchCalled = false;
  let tokenDeleteShouldError = false;

  let mockSupabaseClient = {
    from: (table) => {
      if (table === 'notification_deliveries') {
        let statusFilter = null;
        let lteCreated = null;
        let orFilter = null;
        let limitVal = null;
        let updateData = null;
        let eqId = null;
        let eqClaimToken = undefined;
        let isClaimTokenNull = false;
        let eqStatus = null;

        const builder = {
          select: () => builder,
          eq: (col, val) => {
            if (col === 'status') {
              if (updateData) eqStatus = val;
              else statusFilter = val;
            }
            if (col === 'id') eqId = val;
            if (col === 'claim_token') eqClaimToken = val;
            return builder;
          },
          is: (col, val) => {
            if (col === 'claim_token' && val === null) isClaimTokenNull = true;
            return builder;
          },
          or: (filterStr) => {
            orFilter = filterStr;
            return builder;
          },
          gte: () => builder,
          lte: (col, val) => {
            if (col === 'created_at') lteCreated = val;
            return builder;
          },
          order: () => builder,
          limit: (n) => {
            limitVal = n;
            let results = dbDeliveries.filter((d) => {
              if (statusFilter && d.status !== statusFilter) return false;
              if (lteCreated && d.created_at > lteCreated) return false;
              if (orFilter && orFilter.includes('status.is.null') && orFilter.includes('status.eq.pending')) {
                const rStatus = d.payload?.receipts?.status;
                if (rStatus === 'completed') return false;
              }
              return true;
            });
            if (limitVal) results = results.slice(0, limitVal);
            return Promise.resolve({ data: JSON.parse(JSON.stringify(results)), error: null });
          },
          update: (data) => {
            updateData = data;
            return builder;
          },
          then: (resolve) => {
            if (updateData && eqId) {
              const row = dbDeliveries.find((d) => d.id === eqId);
              let claimTokenMatches = true;

              if (isClaimTokenNull) {
                claimTokenMatches = (row && (row.claim_token === null || row.claim_token === undefined));
              } else if (eqClaimToken !== undefined) {
                claimTokenMatches = (row && row.claim_token === eqClaimToken);
              }

              if (row && (!eqStatus || row.status === eqStatus) && claimTokenMatches) {
                Object.assign(row, updateData);
                resolve({ data: [JSON.parse(JSON.stringify(row))], error: null });
              } else {
                resolve({ data: [], error: null });
              }
            } else {
              resolve({ data: [], error: null });
            }
          },
        };
        return builder;
      }

      if (table === 'user_push_tokens') {
        let inIds = [];
        const builder = {
          delete: () => builder,
          in: (col, vals) => {
            if (col === 'id') inIds = vals;
            return builder;
          },
          select: () => {
            if (tokenDeleteShouldError) {
              return Promise.resolve({ data: null, error: { message: 'Database connection dropped during token delete' } });
            }
            const beforeCount = dbTokens.length;
            const deleted = dbTokens.filter((t) => inIds.includes(t.id));
            dbTokens = dbTokens.filter((t) => !inIds.includes(t.id));
            return Promise.resolve({ data: JSON.parse(JSON.stringify(deleted)), error: null });
          },
        };
        return builder;
      }

      return {};
    },
  };

  globalThis.fetch = async (url) => {
    if (url.includes('getReceipts')) {
      expoFetchCalled = true;
      if (expoShouldThrow) {
        throw new Error('Connection timeout to exp.host');
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: expoReceiptResponse }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const createAuthRequest = () =>
    new Request('https://test.supabase.co/functions/v1/check-push-receipts', {
      method: 'POST',
      headers: { 'x-scheduler-secret': 'test_scheduler_secret_12345' },
    });

  const now = new Date();
  const eligibleDate = new Date(now.getTime() - 20 * 60 * 1000).toISOString();

  // ----------------------------------------------------
  // Scenario 4.1: Delivery claimed over 24h ago but sent recently (No premature expiry)
  // ----------------------------------------------------
  const claimedOld = new Date(now.getTime() - 26 * 60 * 60 * 1000).toISOString(); // 26h ago
  const sentRecent = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(); // 2h ago
  dbDeliveries = [
    {
      id: 'del-claimed-old-sent-recent',
      recipient_id: 'user-claimed-old',
      status: 'sent',
      claim_token: 'claim-token-1',
      created_at: claimedOld,
      claimed_at: claimedOld,
      payload: {
        sent_at: sentRecent, // Only 2 hours ago!
        tickets: [{ id: 'ticket-claimed-old', token_id: 'row-claimed-old', status: 'ok' }],
      },
    },
  ];
  expoFetchCalled = false;
  expoReceiptResponse = { 'ticket-claimed-old': { status: 'ok' } };

  await checkPushReceiptsHandler(createAuthRequest());
  check(expoFetchCalled === true, 'Queries Expo when delivery was claimed >24h ago but sent recently');
  check(dbDeliveries[0].payload.receipts.results['ticket-claimed-old'].status === 'ok', 'Resolves ticket successfully instead of premature expiry');

  // ----------------------------------------------------
  // Scenario 4.2: Legacy record without sent_at - First poll queries Expo and captures valid receipt
  // ----------------------------------------------------
  dbDeliveries = [
    {
      id: 'del-legacy-1',
      recipient_id: 'user-legacy',
      status: 'sent',
      claim_token: 'legacy-token-1',
      created_at: claimedOld,
      claimed_at: claimedOld,
      payload: {
        // No sent_at!
        expoResponse: {
          data: [{ id: 'ticket-legacy-live', status: 'ok' }],
        },
      },
    },
  ];
  expoFetchCalled = false;
  expoReceiptResponse = { 'ticket-legacy-live': { status: 'ok' } };

  await checkPushReceiptsHandler(createAuthRequest());
  check(expoFetchCalled === true, 'Queries Expo for legacy record lacking sent_at rather than guessing expiry');
  check(dbDeliveries[0].payload.receipts.results['ticket-legacy-live'].status === 'ok', 'Successfully captures receipt for legacy record');
  check(dbDeliveries[0].payload.receipts.status === 'completed', 'Marks legacy delivery completed after receipt received');

  // ----------------------------------------------------
  // Scenario 4.3: Legacy record without sent_at - Unresolved receipt retires with LegacyReceiptTimeout
  // ----------------------------------------------------
  dbDeliveries = [
    {
      id: 'del-legacy-timeout',
      recipient_id: 'user-legacy-to',
      status: 'sent',
      claim_token: 'legacy-to-token',
      created_at: claimedOld,
      payload: {
        // No sent_at, poll attempts reached max
        receipts: {
          poll_count: 5, // Reached MAX_LEGACY_POLL_ATTEMPTS
          first_polled_at: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(),
          status: 'pending',
        },
        expoResponse: {
          data: [{ id: 'ticket-legacy-missing', status: 'ok' }],
        },
      },
    },
  ];
  expoFetchCalled = false;

  await checkPushReceiptsHandler(createAuthRequest());
  check(expoFetchCalled === false, 'Does not call Expo after legacy polling window exhausted');
  check(dbDeliveries[0].payload.receipts.status === 'completed', 'Finalizes legacy delivery without looping forever');
  check(
    dbDeliveries[0].payload.receipts.results['ticket-legacy-missing'].status === 'unresolved_legacy_timeout',
    'Marks status as unresolved_legacy_timeout'
  );
  check(
    dbDeliveries[0].payload.receipts.results['ticket-legacy-missing'].error === 'LegacyReceiptTimeout',
    'Uses error LegacyReceiptTimeout rather than falsely claiming ReceiptExpiredAtExpo'
  );

  // ----------------------------------------------------
  // Scenario 4.4: Token Deletion Error Handling - Explicit Failure Handling
  // ----------------------------------------------------
  dbDeliveries = [
    {
      id: 'del-del-err-1',
      recipient_id: 'user-del-err',
      status: 'sent',
      claim_token: 'del-err-token',
      created_at: eligibleDate,
      payload: {
        sent_at: eligibleDate,
        tickets: [{ id: 'ticket-bad-dev', token_id: 'row-to-delete-fail', status: 'ok' }],
      },
    },
  ];
  dbTokens = [{ id: 'row-to-delete-fail', user_id: 'user-del-err' }];
  expoReceiptResponse = {
    'ticket-bad-dev': {
      status: 'error',
      details: { error: 'DeviceNotRegistered' },
    },
  };
  tokenDeleteShouldError = true;

  const resDelErr = await checkPushReceiptsHandler(createAuthRequest());
  const bodyDelErr = await resDelErr.json();
  check(resDelErr.status === 500, 'Returns HTTP 500 when user_push_tokens delete operation encounters an error');
  check(bodyDelErr.tokensCleaned === 0, 'Does NOT report tokensCleaned as successful when deletion failed');
  check(bodyDelErr.tokenCleanupError !== undefined, 'Reports explicit tokenCleanupError message');
  check(dbTokens.length === 1, 'Token row remains in database when delete query failed');
  tokenDeleteShouldError = false;

  // ----------------------------------------------------
  // Scenario 4.5: Token Deletion with Zero Matching Rows (Already deleted by logout/rotation)
  // ----------------------------------------------------
  dbDeliveries = [
    {
      id: 'del-zero-rows-1',
      recipient_id: 'user-zero',
      status: 'sent',
      claim_token: 'zero-token',
      created_at: eligibleDate,
      payload: {
        sent_at: eligibleDate,
        tickets: [{ id: 'ticket-already-gone', token_id: 'row-nonexistent-in-db', status: 'ok' }],
      },
    },
  ];
  dbTokens = []; // Row already deleted
  expoReceiptResponse = {
    'ticket-already-gone': {
      status: 'error',
      details: { error: 'DeviceNotRegistered' },
    },
  };

  const resZero = await checkPushReceiptsHandler(createAuthRequest());
  const bodyZero = await resZero.json();
  check(resZero.status === 200, 'HTTP 200 when deleting already-deleted token');
  check(bodyZero.tokensCleaned === 0, 'Accurately reports tokensCleaned = 0 when 0 matching rows exist');

  // ----------------------------------------------------
  // Scenario 4.6: Lease Loss Aborts Token Deletion
  // ----------------------------------------------------
  // Stale worker tries to process delivery, but delivery in DB has changed claim_token
  dbDeliveries = [
    {
      id: 'del-lease-lost-1',
      recipient_id: 'user-lease-lost',
      status: 'sent',
      claim_token: 'stale-token-worker-a',
      created_at: eligibleDate,
      payload: {
        sent_at: eligibleDate,
        tickets: [{ id: 'ticket-lease-lost', token_id: 'row-must-not-be-deleted', status: 'ok' }],
      },
    },
  ];
  dbTokens = [{ id: 'row-must-not-be-deleted', user_id: 'user-lease-lost' }];
  expoReceiptResponse = {
    'ticket-lease-lost': {
      status: 'error',
      details: { error: 'DeviceNotRegistered' },
    },
  };

  // We simulate worker A having acquired lease with 'stale-token-worker-a',
  // but another worker advanced claim_token in the DB before Worker A writes final results
  const origFrom = mockSupabaseClient.from;
  mockSupabaseClient.from = (table) => {
    const builder = origFrom(table);
    if (table === 'notification_deliveries') {
      const origUpdate = builder.update;
      builder.update = (data) => {
        // When updating with lease, let Worker A think it acquired it,
        // but change the DB's claim_token so the final write fails the fence!
        if (data.payload?.receipts?.lease_until) {
          dbDeliveries[0].claim_token = 'worker-b-stole-lease';
        }
        return origUpdate(data);
      };
    }
    return builder;
  };

  await checkPushReceiptsHandler(createAuthRequest());
  check(dbTokens.length === 1 && dbTokens[0].id === 'row-must-not-be-deleted', 'Token deletion strictly aborted when lease ownership is lost');
  mockSupabaseClient.from = origFrom; // Restore

  console.log(`\n🎉 Push Receipt Polling Safety Test Suite Completed: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    process.exit(1);
  }
}

runReceiptWorkerTests().catch((err) => {
  console.error('Fatal error running push receipt tests:', err);
  process.exit(1);
});
