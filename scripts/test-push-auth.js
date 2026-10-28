// scripts/test-push-auth.js
// Dedicated test suite for DareDrop Edge Function Webhook Authentication & Constant-Time Security

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

async function runPushAuthTests() {
  console.log('🧪 Running DareDrop Webhook Authentication & Security Test Suite...\n');

  // Load and transpile Edge Function
  const edgeFnPath = path.resolve(process.cwd(), 'supabase/functions/send-push-notification/index.ts');
  const edgeFnCode = fs.readFileSync(edgeFnPath, 'utf8');
  const transpiled = ts.transpileModule(edgeFnCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  let envState = {
    WEBHOOK_SECRET: 'super_secret_webhook_key_987654321',
    SUPABASE_SERVICE_ROLE_KEY: 'mock_service_role_key_abcdef123456',
    SUPABASE_URL: 'https://test.supabase.co',
  };

  globalThis.fetch = async () => ({
    json: async () => ({ data: [{ status: 'ok', id: 'ticket-1' }] }),
  });

  let capturedHandler = null;
  const mockDeno = {
    serve: (handler) => {
      capturedHandler = handler;
    },
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
          createClient: () => ({
            rpc: async (fnName, params) => {
              if (fnName === 'complete_notification_delivery') {
                return { data: true, error: null };
              }
              return {
                data: [
                  {
                    delivery_id: 'del-1',
                    claim_token: '00000000-0000-0000-0000-000000000001',
                    claim_status: 'claimed',
                    current_status: 'claimed',
                    tokens_sent: 0,
                  },
                ],
                error: null,
              };
            },
            from: (table) => ({
              insert: () => ({
                select: () => ({ maybeSingle: async () => ({ data: { id: 'del-1' }, error: null }) }),
              }),
              select: () => ({
                eq: () => {
                  const p = Promise.resolve(
                    table === 'user_push_tokens'
                      ? { data: [{ expo_push_token: 'ExponentPushToken[mock_token_123]' }], error: null }
                      : { data: null, error: null }
                  );
                  p.maybeSingle = async () => ({ data: null, error: null });
                  return p;
                },
              }),
              update: () => ({
                eq: () => ({
                  eq: () => ({
                    lte: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'del-1' }, error: null }) }) }),
                    select: () => ({ maybeSingle: async () => ({ data: { id: 'del-1' }, error: null }) }),
                  }),
                  select: () => ({ maybeSingle: async () => ({ data: { id: 'del-1' }, error: null }) }),
                }),
              }),
              delete: () => ({ in: async () => ({ data: null, error: null }) }),
            }),
          }),
        };
      }
      return {};
    },
    mockDeno,
    require('crypto').webcrypto || globalThis.crypto
  );

  const { secureCompare } = edgeExports;
  assert(typeof secureCompare === 'function', 'secureCompare must be exported as a function');

  // 1. Direct secureCompare Tests
  console.log('[Test 1] Constant-Time secureCompare Verification:');
  const actualSecret = 'correct_token_1234567890_abcdef';

  // Correct secret is accepted
  const matchResult = await secureCompare(actualSecret, actualSecret);
  assert.strictEqual(matchResult, true, 'Matching secret must return true');
  console.log('  ✅ Correct secret is accepted.');

  // Incorrect secret of same length is rejected
  const mismatchResult = await secureCompare('wrong___token_1234567890_abcdef', actualSecret);
  assert.strictEqual(mismatchResult, false, 'Mismatched secret must return false');
  console.log('  ✅ Incorrect secret is rejected.');

  // Single bit difference is rejected
  const singleBitDiff = await secureCompare('correct_token_1234567890_abcdee', actualSecret);
  assert.strictEqual(singleBitDiff, false, 'Single character difference must return false');
  console.log('  ✅ Single character difference is rejected.');

  // Unequal length secrets (shorter and longer) handled safely without throwing
  let shorterThrown = false;
  let shorterResult;
  try {
    shorterResult = await secureCompare('short', actualSecret);
  } catch {
    shorterThrown = true;
  }
  assert.strictEqual(shorterThrown, false, 'Shorter secret must not throw an error');
  assert.strictEqual(shorterResult, false, 'Shorter secret must return false');

  let longerThrown = false;
  let longerResult;
  try {
    longerResult = await secureCompare('correct_token_1234567890_abcdef_extra_bytes_appended', actualSecret);
  } catch {
    longerThrown = true;
  }
  assert.strictEqual(longerThrown, false, 'Longer secret must not throw an error');
  assert.strictEqual(longerResult, false, 'Longer secret must return false');
  console.log('  ✅ Different-length secrets are handled safely without throwing.');

  // Empty string inputs
  assert.strictEqual(await secureCompare('', actualSecret), false, 'Empty provided secret must return false');
  assert.strictEqual(await secureCompare(actualSecret, ''), false, 'Empty expected secret must return false');
  assert.strictEqual(await secureCompare('', ''), false, 'Both empty strings must return false');
  console.log('  ✅ Empty strings are safely rejected without throwing.');

  // Non-string inputs
  assert.strictEqual(await secureCompare(null, actualSecret), false, 'null must return false');
  assert.strictEqual(await secureCompare(undefined, actualSecret), false, 'undefined must return false');
  assert.strictEqual(await secureCompare(12345, actualSecret), false, 'number must return false');
  assert.strictEqual(await secureCompare({}, actualSecret), false, 'object must return false');
  console.log('  ✅ Non-string or undefined inputs fail safely without throwing.');

  // 2. HTTP Request Authentication Pipeline Tests
  console.log('\n[Test 2] Edge Function Webhook Request Handler Tests:');
  assert(typeof capturedHandler === 'function', 'Deno.serve handler must be registered');

  const validPayload = JSON.stringify({
    type: 'UPDATE',
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
      submission_note: 'Proof',
      rejection_reason: null,
      submitted_at: '2026-10-24T12:00:00Z',
      reviewed_at: null,
    },
    old_record: null,
  });

  // Case A1: Missing WEBHOOK_SECRET env var (both unset) -> FAILS CLOSED (HTTP 500)
  envState.WEBHOOK_SECRET = '';
  envState.PREVIOUS_WEBHOOK_SECRET = '';
  const noSecretReq = new Request('https://edge.supabase.co/send-push-notification', {
    method: 'POST',
    headers: { 'x-webhook-secret': 'any_secret_attempt', 'Content-Type': 'application/json' },
    body: validPayload,
  });
  const noSecretRes = await capturedHandler(noSecretReq);
  assert.strictEqual(noSecretRes.status, 500, 'Missing server WEBHOOK_SECRET must fail closed with 500');
  const noSecretBody = await noSecretRes.json();
  assert(noSecretBody.error.includes('WEBHOOK_SECRET not set'), 'Error message must specify configuration error');
  console.log('  ✅ Missing WEBHOOK_SECRET (both unset) fails closed (HTTP 500).');

  // Case A2: Missing WEBHOOK_SECRET env var even when PREVIOUS_WEBHOOK_SECRET is set -> FAILS CLOSED (HTTP 500)
  envState.WEBHOOK_SECRET = '';
  envState.PREVIOUS_WEBHOOK_SECRET = 'previous_secret_legacy_value_111';
  const noPrimarySecretReq = new Request('https://edge.supabase.co/send-push-notification', {
    method: 'POST',
    headers: { 'x-webhook-secret': 'previous_secret_legacy_value_111', 'Content-Type': 'application/json' },
    body: validPayload,
  });
  const noPrimarySecretRes = await capturedHandler(noPrimarySecretReq);
  assert.strictEqual(noPrimarySecretRes.status, 500, 'Missing primary WEBHOOK_SECRET must fail closed with 500 even if PREVIOUS is set');
  console.log('  ✅ Missing primary WEBHOOK_SECRET with PREVIOUS_WEBHOOK_SECRET set fails closed (HTTP 500).');

  // Configure dual-secret environment
  const primarySecret = 'super_secret_webhook_key_new_2026';
  const oldSecret = 'legacy_webhook_secret_old_2025';
  envState.WEBHOOK_SECRET = primarySecret;
  envState.PREVIOUS_WEBHOOK_SECRET = oldSecret;

  // Case B: Missing authentication headers -> HTTP 401
  const missingHeaderReq = new Request('https://edge.supabase.co/send-push-notification', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: validPayload,
  });
  const missingHeaderRes = await capturedHandler(missingHeaderReq);
  assert.strictEqual(missingHeaderRes.status, 401, 'Request with missing auth headers must return 401');
  console.log('  ✅ Missing request headers are rejected with 401.');

  // Case C: Malformed Authorization header -> HTTP 401
  const malformedHeaderReq = new Request('https://edge.supabase.co/send-push-notification', {
    method: 'POST',
    headers: { Authorization: 'Basic some_user:some_pass', 'Content-Type': 'application/json' },
    body: validPayload,
  });
  const malformedHeaderRes = await capturedHandler(malformedHeaderReq);
  assert.strictEqual(malformedHeaderRes.status, 401, 'Malformed Authorization header must return 401');
  console.log('  ✅ Malformed request headers are rejected with 401.');

  // Case D: Incorrect x-webhook-secret -> HTTP 401
  const wrongSecretReq = new Request('https://edge.supabase.co/send-push-notification', {
    method: 'POST',
    headers: { 'x-webhook-secret': 'incorrect_secret_guess', 'Content-Type': 'application/json' },
    body: validPayload,
  });
  const wrongSecretRes = await capturedHandler(wrongSecretReq);
  assert.strictEqual(wrongSecretRes.status, 401, 'Incorrect x-webhook-secret must return 401');
  console.log('  ✅ Incorrect webhook secret is rejected with 401.');

  // Case E1: Correct primary secret via x-webhook-secret -> Accepted (HTTP 200)
  const correctPrimaryReq = new Request('https://edge.supabase.co/send-push-notification', {
    method: 'POST',
    headers: { 'x-webhook-secret': primarySecret, 'Content-Type': 'application/json' },
    body: validPayload,
  });
  const correctPrimaryRes = await capturedHandler(correctPrimaryReq);
  assert.strictEqual(correctPrimaryRes.status, 200, 'Valid primary x-webhook-secret must be accepted with 200');
  console.log('  ✅ Primary secret via x-webhook-secret is accepted (HTTP 200).');

  // Case E2: Correct previous secret via x-webhook-secret (when PREVIOUS_WEBHOOK_SECRET set) -> Accepted (HTTP 200)
  const correctPreviousReq = new Request('https://edge.supabase.co/send-push-notification', {
    method: 'POST',
    headers: { 'x-webhook-secret': oldSecret, 'Content-Type': 'application/json' },
    body: validPayload,
  });
  const correctPreviousRes = await capturedHandler(correctPreviousReq);
  assert.strictEqual(correctPreviousRes.status, 200, 'Valid previous x-webhook-secret must be accepted with 200');
  console.log('  ✅ Previous secret via x-webhook-secret is accepted during overlap (HTTP 200).');

  // Case E3: Previous secret via x-webhook-secret when PREVIOUS_WEBHOOK_SECRET is UNSET -> Rejected (HTTP 401)
  envState.PREVIOUS_WEBHOOK_SECRET = '';
  const retiredPreviousReq = new Request('https://edge.supabase.co/send-push-notification', {
    method: 'POST',
    headers: { 'x-webhook-secret': oldSecret, 'Content-Type': 'application/json' },
    body: validPayload,
  });
  const retiredPreviousRes = await capturedHandler(retiredPreviousReq);
  assert.strictEqual(retiredPreviousRes.status, 401, 'Previous secret must be rejected once PREVIOUS_WEBHOOK_SECRET is unset');
  console.log('  ✅ Retired previous secret via x-webhook-secret is rejected after cutoff (HTTP 401).');

  // Restore previous secret for remaining tests
  envState.PREVIOUS_WEBHOOK_SECRET = oldSecret;

  // Case F1: Correct primary secret via Authorization: Bearer -> Accepted (HTTP 200)
  const bearerPrimaryReq = new Request('https://edge.supabase.co/send-push-notification', {
    method: 'POST',
    headers: { Authorization: `Bearer ${primarySecret}`, 'Content-Type': 'application/json' },
    body: validPayload,
  });
  const bearerPrimaryRes = await capturedHandler(bearerPrimaryReq);
  assert.strictEqual(bearerPrimaryRes.status, 200, 'Valid Bearer primary secret must be accepted with 200');
  console.log('  ✅ Primary secret via Bearer token is accepted (HTTP 200).');

  // Case F2: Correct previous secret via Authorization: Bearer -> Accepted (HTTP 200)
  const bearerPreviousReq = new Request('https://edge.supabase.co/send-push-notification', {
    method: 'POST',
    headers: { Authorization: `Bearer ${oldSecret}`, 'Content-Type': 'application/json' },
    body: validPayload,
  });
  const bearerPreviousRes = await capturedHandler(bearerPreviousReq);
  assert.strictEqual(bearerPreviousRes.status, 200, 'Valid Bearer previous secret must be accepted with 200');
  console.log('  ✅ Previous secret via Bearer token is accepted during overlap (HTTP 200).');

  // Case F3: Previous secret via Authorization: Bearer when PREVIOUS_WEBHOOK_SECRET is UNSET -> Rejected (HTTP 401)
  envState.PREVIOUS_WEBHOOK_SECRET = '';
  const retiredBearerPreviousReq = new Request('https://edge.supabase.co/send-push-notification', {
    method: 'POST',
    headers: { Authorization: `Bearer ${oldSecret}`, 'Content-Type': 'application/json' },
    body: validPayload,
  });
  const retiredBearerPreviousRes = await capturedHandler(retiredBearerPreviousReq);
  assert.strictEqual(retiredBearerPreviousRes.status, 401, 'Previous Bearer secret must be rejected once unset');
  console.log('  ✅ Retired previous secret via Bearer token is rejected after cutoff (HTTP 401).');
  envState.PREVIOUS_WEBHOOK_SECRET = oldSecret;

  // Case G: Correct Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY> -> Accepted (HTTP 200)
  const serviceRoleReq = new Request('https://edge.supabase.co/send-push-notification', {
    method: 'POST',
    headers: { Authorization: 'Bearer mock_service_role_key_abcdef123456', 'Content-Type': 'application/json' },
    body: validPayload,
  });
  const serviceRoleRes = await capturedHandler(serviceRoleReq);
  assert.strictEqual(serviceRoleRes.status, 200, 'Valid Service Role Bearer must be accepted with 200');
  console.log('  ✅ Supabase internal Service Role key is accepted via Bearer (HTTP 200).');

  // Case H: Authenticated user JWT (regular user token) -> Rejected (HTTP 401)
  // Ensures regular user sessions CANNOT bypass webhook auth
  const userJwtReq = new Request('https://edge.supabase.co/send-push-notification', {
    method: 'POST',
    headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.regular_user_payload.signature', 'Content-Type': 'application/json' },
    body: validPayload,
  });
  const userJwtRes = await capturedHandler(userJwtReq);
  assert.strictEqual(userJwtRes.status, 401, 'Regular user JWT must NOT bypass webhook authentication');
  console.log('  ✅ Standard user JWT is rejected (cannot bypass webhook auth) (HTTP 401).');

  // Case I: Invalid Bearer token -> Rejected (HTTP 401)
  const invalidBearerReq = new Request('https://edge.supabase.co/send-push-notification', {
    method: 'POST',
    headers: { Authorization: 'Bearer totally_invalid_token_guess', 'Content-Type': 'application/json' },
    body: validPayload,
  });
  const invalidBearerRes = await capturedHandler(invalidBearerReq);
  assert.strictEqual(invalidBearerRes.status, 401, 'Invalid Bearer token must return 401');
  console.log('  ✅ Invalid Bearer token is rejected (HTTP 401).');

  // Case J: OPTIONS preflight is allowed (HTTP 200)
  const optionsReq = new Request('https://edge.supabase.co/send-push-notification', { method: 'OPTIONS' });
  const optionsRes = await capturedHandler(optionsReq);
  assert.strictEqual(optionsRes.status, 200, 'OPTIONS preflight must return 200');
  console.log('  ✅ OPTIONS preflight requests succeed (HTTP 200).');

  console.log('\n🎉 ALL WEBHOOK AUTHENTICATION TESTS PASSED SUCCESSFULLY! (Zero secret values exposed)');
}

runPushAuthTests().catch((err) => {
  console.error('Push auth test failed:', err);
  process.exit(1);
});
