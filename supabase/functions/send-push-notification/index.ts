// DareDrop Serverless Edge Function: Send Push Notifications via Expo Push API
// Triggered securely via Database Webhook on public.challenge_completions

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const WEBHOOK_SECRET = Deno.env.get('WEBHOOK_SECRET') || '';
const EXPO_ACCESS_TOKEN = Deno.env.get('EXPO_ACCESS_TOKEN') || '';

interface WebhookPayload {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  schema: string;
  record: {
    id: string;
    challenge_id: string;
    challenge_type: 'daily' | 'one_time';
    participant_id: string;
    verifier_id: string;
    completion_date: string;
    status: 'pending' | 'approved' | 'rejected';
    submission_note: string | null;
    rejection_reason: string | null;
    submitted_at: string;
    reviewed_at: string | null;
  };
  old_record?: {
    id: string;
    challenge_id: string;
    challenge_type: 'daily' | 'one_time';
    participant_id: string;
    verifier_id: string;
    status: 'pending' | 'approved' | 'rejected';
    submitted_at: string;
    reviewed_at: string | null;
  } | null;
}

interface NotificationSpec {
  recipientId: string;
  eventType: 'submission_pending' | 'dare_approved' | 'dare_rejected' | 'verifier_reassigned';
  title: string;
  body: string;
  idempotencyKey: string;
  data: {
    challengeId: string;
    completionId: string;
    type: string;
  };
}

/**
 * Constant-time byte comparison function for two buffers of equal length.
 * Accumulates XOR differences across all bytes to prevent short-circuit timing leaks.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Constant-time comparison of two variable-length secrets using SHA-256 digests.
 * 1. Normalizes variable-length inputs into fixed 32-byte buffers to avoid length leakage.
 * 2. Compares the 32-byte digests in constant time.
 * 3. Handles unequal lengths, empty strings, missing values, and invalid types without throwing.
 * 4. Relies strictly on standard W3C Web Cryptography API (crypto.subtle.digest).
 */
export async function secureCompare(provided: string, expected: string): Promise<boolean> {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (provided.length === 0 || expected.length === 0) return false;

  const enc = new TextEncoder();
  const [digestProvided, digestExpected] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(provided)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);

  const bufA = new Uint8Array(digestProvided);
  const bufB = new Uint8Array(digestExpected);

  return constantTimeEqual(bufA, bufB);
}

/**
 * Validates whether a string matches the standard Expo push token format.
 */
function isExpoPushToken(token: string): boolean {
  return typeof token === 'string' && (token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken['));
}

/**
 * Detects the notification event and recipient based on completion record state transitions.
 * Guaranteed to use deterministic schema columns (submitted_at, reviewed_at, verifier_id).
 */
export function detectNotificationEvent(payload: WebhookPayload): NotificationSpec | null {
  const { record, old_record } = payload;
  if (!record || !record.id) return null;

  let spec: NotificationSpec | null = null;

  // Case 1: Completion transitions to pending (new submission or resubmission after rejection)
  // Target: verifier_id
  if (record.status === 'pending' && (!old_record || old_record.status !== 'pending')) {
    spec = {
      recipientId: record.verifier_id,
      eventType: 'submission_pending',
      title: 'DareDrop — Verification needed',
      body: 'Someone has submitted a dare for you to review.',
      idempotencyKey: `pending:${record.id}:${record.submitted_at || 'initial'}`,
      data: {
        challengeId: record.challenge_id,
        completionId: record.id,
        type: 'submission_pending',
      },
    };
  } else if (record.status === 'approved' && old_record && old_record.status !== 'approved') {
    // Case 2: Completion transitions to approved
    // Target: participant_id
    spec = {
      recipientId: record.participant_id,
      eventType: 'dare_approved',
      title: 'Dare approved',
      body: 'Your dare completion has been approved.',
      idempotencyKey: `approved:${record.id}:${record.reviewed_at || 'reviewed'}`,
      data: {
        challengeId: record.challenge_id,
        completionId: record.id,
        type: 'dare_approved',
      },
    };
  } else if (record.status === 'rejected' && old_record && old_record.status !== 'rejected') {
    // Case 3: Completion transitions to rejected
    // Target: participant_id
    spec = {
      recipientId: record.participant_id,
      eventType: 'dare_rejected',
      title: 'Dare rejected',
      body: 'Your dare completion was rejected. Open DareDrop to view the details.',
      idempotencyKey: `rejected:${record.id}:${record.reviewed_at || 'reviewed'}`,
      data: {
        challengeId: record.challenge_id,
        completionId: record.id,
        type: 'dare_rejected',
      },
    };
  } else if (
    record.status === 'pending' &&
    old_record &&
    old_record.status === 'pending' &&
    record.verifier_id !== old_record.verifier_id
  ) {
    // Case 4: Verifier reassigned while completion is pending
    // Target: NEW verifier_id (NOT old verifier)
    spec = {
      recipientId: record.verifier_id,
      eventType: 'verifier_reassigned',
      title: 'New verifier assigned',
      body: 'A dare is waiting for your verification.',
      idempotencyKey: `reassigned:${record.id}:${record.verifier_id}:${record.submitted_at || 'reassigned'}`,
      data: {
        challengeId: record.challenge_id,
        completionId: record.id,
        type: 'verifier_reassigned',
      },
    };
  }

  // Strictly validate recipient isolation
  if (!spec || !spec.recipientId || typeof spec.recipientId !== 'string' || spec.recipientId.trim() === '') {
    return null;
  }

  return spec;
}

Deno.serve(async (req: Request) => {
  // Allow health checks / preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const webhookSecret = Deno.env.get('WEBHOOK_SECRET') ?? '';
  const previousWebhookSecret = Deno.env.get('PREVIOUS_WEBHOOK_SECRET') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const expoAccessToken = Deno.env.get('EXPO_ACCESS_TOKEN') ?? '';

  // 1. Authorize webhook request (Strict Fail-Closed Check)
  if (!webhookSecret) {
    console.error('[send-push-notification] Misconfiguration: WEBHOOK_SECRET is not configured.');
    return new Response(JSON.stringify({ error: 'Server misconfiguration: WEBHOOK_SECRET not set' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const secretHeader = req.headers.get('x-webhook-secret') || '';
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  const isAuthorized =
    (secretHeader && (await secureCompare(secretHeader, webhookSecret))) ||
    (secretHeader && previousWebhookSecret && (await secureCompare(secretHeader, previousWebhookSecret))) ||
    (token && (await secureCompare(token, webhookSecret))) ||
    (token && previousWebhookSecret && (await secureCompare(token, previousWebhookSecret))) ||
    (serviceRoleKey && token && (await secureCompare(token, serviceRoleKey)));

  if (!isAuthorized) {
    return new Response(JSON.stringify({ error: 'Unauthorized: missing or invalid webhook credentials' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let payload: WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. Detect notification event
  const spec = detectNotificationEvent(payload);
  if (!spec) {
    return new Response(
      JSON.stringify({ message: 'No notification needed for this transition' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // 3. Initialize Supabase Admin client
  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

  // 4. Atomic Event Claiming: Prevent concurrent duplicate dispatches & race conditions
  const CLAIM_LEASE_SECONDS = 60;
  const CLAIM_LEASE_MS = CLAIM_LEASE_SECONDS * 1000;
  const claimStartTime = Date.now();
  const workerClaimToken = crypto.randomUUID();

  let deliveryId: string | null = null;
  let activeClaimToken: string = workerClaimToken;
  let acquiredClaim = false;

  // Attempt atomic claim via RPC first (available when migration 20261024040000 is applied)
  const { data: rpcClaims, error: rpcErr } = await supabaseAdmin.rpc('claim_notification_delivery', {
    p_idempotency_key: spec.idempotencyKey,
    p_completion_id: spec.data.completionId,
    p_event_type: spec.eventType,
    p_recipient_id: spec.recipientId,
    p_lease_seconds: CLAIM_LEASE_SECONDS,
    p_payload: { spec, claim_token: workerClaimToken, claimed_at: new Date().toISOString() },
  });

  const isRpcAvailable = !rpcErr && Array.isArray(rpcClaims) && rpcClaims.length > 0;

  if (isRpcAvailable) {
    const claim = rpcClaims[0];
    if (claim.claim_status === 'already_processed') {
      return new Response(
        JSON.stringify({ message: 'Event already processed', idempotencyKey: spec.idempotencyKey, status: claim.current_status }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (claim.claim_status === 'in_progress') {
      return new Response(
        JSON.stringify({ message: 'Delivery currently in progress by concurrent worker', idempotencyKey: spec.idempotencyKey }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (claim.claim_status === 'claimed') {
      deliveryId = claim.delivery_id;
      activeClaimToken = claim.claim_token || workerClaimToken;
      acquiredClaim = true;
    }
  } else {
    // Fallback: If RPC does not exist (pre-migration schema), execute atomic conditional insert/update
    const { data: claimData, error: claimErr } = await supabaseAdmin
      .from('notification_deliveries')
      .insert({
        idempotency_key: spec.idempotencyKey,
        completion_id: spec.data.completionId,
        event_type: spec.eventType,
        recipient_id: spec.recipientId,
        tokens_sent: 0,
        status: 'claimed',
        payload: { spec, claim_token: workerClaimToken, claimed_at: new Date().toISOString() },
      })
      .select('id, status, created_at')
      .maybeSingle();

    if (claimData) {
      deliveryId = claimData.id;
      acquiredClaim = true;
    } else if (claimErr && claimErr.code === '23505') {
      // Unique constraint violation (code 23505) indicates event was already claimed or processed
      const { data: existing } = await supabaseAdmin
        .from('notification_deliveries')
        .select('id, status, created_at, payload')
        .eq('idempotency_key', spec.idempotencyKey)
        .maybeSingle();

      if (!existing) {
        return new Response(JSON.stringify({ error: 'Contention during idempotency claim' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // If already sent or intentionally skipped, return 200 without resending
      if (existing.status === 'sent' || existing.status === 'skipped_no_tokens' || existing.status === 'already_processed') {
        return new Response(
          JSON.stringify({ message: 'Event already processed', idempotencyKey: spec.idempotencyKey, status: existing.status }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }

      // If claimed by another concurrent worker, check lease age (60 seconds)
      if (existing.status === 'claimed') {
        const claimAgeMs = Date.now() - new Date(existing.created_at).getTime();
        if (claimAgeMs < CLAIM_LEASE_MS) {
          return new Response(
            JSON.stringify({ message: 'Delivery currently in progress by concurrent worker', idempotencyKey: spec.idempotencyKey }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        // Lease expired; recover after crash with conditional update enforcing exclusive ownership
        const leaseCutoffIso = new Date(Date.now() - CLAIM_LEASE_MS).toISOString();
        const { data: reclaimed } = await supabaseAdmin
          .from('notification_deliveries')
          .update({
            status: 'claimed',
            created_at: new Date().toISOString(),
            error: null,
            payload: { spec, claim_token: workerClaimToken, claimed_at: new Date().toISOString() },
          })
          .eq('id', existing.id)
          .eq('status', 'claimed')
          .lte('created_at', leaseCutoffIso)
          .select('id, status')
          .maybeSingle();

        if (!reclaimed) {
          return new Response(
            JSON.stringify({ message: 'Delivery claimed by concurrent worker during reclaim', idempotencyKey: spec.idempotencyKey }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        deliveryId = reclaimed.id;
        acquiredClaim = true;
      } else if (existing.status === 'failed') {
        // Previous attempt failed; retry with conditional update
        const { data: reclaimed } = await supabaseAdmin
          .from('notification_deliveries')
          .update({
            status: 'claimed',
            created_at: new Date().toISOString(),
            error: null,
            payload: { spec, claim_token: workerClaimToken, claimed_at: new Date().toISOString() },
          })
          .eq('id', existing.id)
          .eq('status', 'failed')
          .select('id, status')
          .maybeSingle();

        if (!reclaimed) {
          return new Response(
            JSON.stringify({ message: 'Delivery retry claimed by concurrent worker', idempotencyKey: spec.idempotencyKey }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }

        deliveryId = reclaimed.id;
        acquiredClaim = true;
      }
    } else if (claimErr) {
      console.error('[send-push-notification] Error creating delivery claim:', claimErr.message);
      return new Response(JSON.stringify({ error: claimErr.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  if (!acquiredClaim || !deliveryId) {
    return new Response(
      JSON.stringify({ message: 'Claim not acquired', idempotencyKey: spec.idempotencyKey }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Helper function to record terminal delivery outcome with fencing token verification
  async function recordDeliveryOutcome(
    status: 'sent' | 'failed' | 'skipped_no_tokens',
    tokensSent: number,
    payloadData: any,
    errorMessage: string | null = null,
  ): Promise<boolean> {
    if (!deliveryId) return false;

    if (isRpcAvailable) {
      const { data: ok, error: compErr } = await supabaseAdmin.rpc('complete_notification_delivery', {
        p_delivery_id: deliveryId,
        p_claim_token: activeClaimToken,
        p_status: status,
        p_tokens_sent: tokensSent,
        p_payload: payloadData,
        p_error: errorMessage,
      });

      if (!compErr && typeof ok === 'boolean') {
        if (!ok) {
          console.warn(`[send-push-notification] Worker fencing: Claim ${deliveryId} was reclaimed after lease expiry.`);
        }
        return ok;
      }
    }

    // Fallback completion update: guarded by status = 'claimed' to prevent stale overwrites
    const { data: updatedRows } = await supabaseAdmin
      .from('notification_deliveries')
      .update({
        status,
        tokens_sent: tokensSent,
        payload: payloadData,
        error: errorMessage,
      })
      .eq('id', deliveryId)
      .eq('status', 'claimed')
      .select('id');

    const ok = Boolean(updatedRows && updatedRows.length > 0);
    if (!ok) {
      console.warn(`[send-push-notification] Worker fencing (fallback): Claim ${deliveryId} was superseded or already completed.`);
    }
    return ok;
  }

  // 5. Query recipient device tokens
  const { data: tokenRows, error: tokenErr } = await supabaseAdmin
    .from('user_push_tokens')
    .select('id, expo_push_token')
    .eq('user_id', spec.recipientId);

  if (tokenErr) {
    console.error('[send-push-notification] Error fetching push tokens:', tokenErr.message);
    await recordDeliveryOutcome('failed', 0, { spec, error: tokenErr.message }, tokenErr.message);
    return new Response(JSON.stringify({ error: tokenErr.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const validTokenRows = (tokenRows || []).filter(
    (r: { id: string; expo_push_token: string }) => isExpoPushToken(r.expo_push_token),
  );
  const validTokens = validTokenRows.map((r: { expo_push_token: string }) => r.expo_push_token);

  if (validTokens.length === 0) {
    // Record skipped delivery so duplicate webhooks do not repeat queries
    await recordDeliveryOutcome('skipped_no_tokens', 0, { spec, reason: 'no_valid_tokens' });
    return new Response(
      JSON.stringify({ message: 'No registered push tokens for recipient', recipientId: spec.recipientId }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // 6. Fencing Pre-Check: If worker was stalled and lease is within 5 seconds of expiry, abort before calling external provider
  const elapsedSinceClaim = Date.now() - claimStartTime;
  if (elapsedSinceClaim >= CLAIM_LEASE_MS - 5000) {
    console.warn(`[send-push-notification] Lease near expiry (${elapsedSinceClaim}ms elapsed), aborting external dispatch.`);
    return new Response(
      JSON.stringify({ error: 'Claim lease expired before dispatch' }),
      { status: 408, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // 7. Build Expo Push API request
  const messages = validTokens.map((token: string) => ({
    to: token,
    sound: 'default',
    title: spec.title,
    body: spec.body,
    data: spec.data,
    channelId: 'daredrop-default',
    priority: 'high',
  }));

  const expoHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (expoAccessToken) {
    expoHeaders['Authorization'] = `Bearer ${expoAccessToken}`;
  }

  let expoResponseData: any = null;
  const invalidTokenRowIdsToRemove: string[] = [];

  try {
    const expoRes = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: expoHeaders,
      body: JSON.stringify(messages),
    });

    expoResponseData = await expoRes.json();

    // Check for invalid or revoked tokens (DeviceNotRegistered) and map tickets to token row IDs
    const tickets: Array<{ id?: string; token_id: string; status: string }> = [];
    if (expoResponseData?.data && Array.isArray(expoResponseData.data)) {
      expoResponseData.data.forEach((ticket: any, index: number) => {
        const row = validTokenRows[index];
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          if (row?.id) invalidTokenRowIdsToRemove.push(row.id);
        }
        if (row?.id && ticket.id) {
          tickets.push({
            id: ticket.id,
            token_id: row.id,
            status: ticket.status,
          });
        }
      });
    }

    // Clean up revoked tokens asynchronously by row ID (without exposing raw tokens)
    if (invalidTokenRowIdsToRemove.length > 0) {
      await supabaseAdmin
        .from('user_push_tokens')
        .delete()
        .in('id', invalidTokenRowIdsToRemove);
      console.log(`[send-push-notification] Removed ${invalidTokenRowIdsToRemove.length} unregistered device tokens.`);
    }

    // Record successful delivery with ticket-to-row-ID mapping and sent_at timestamp
    const updated = await recordDeliveryOutcome('sent', validTokens.length, {
      spec,
      sent_at: new Date().toISOString(),
      expoResponse: expoResponseData,
      tickets,
    });
    if (!updated && isRpcAvailable) {
      console.warn(`[send-push-notification] Warning: delivery was recorded as superseded by another worker for ${deliveryId}.`);
    }

    return new Response(
      JSON.stringify({ success: true, tokensSent: validTokens.length, data: expoResponseData }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  } catch (pushErr: any) {
    console.error('[send-push-notification] Error calling Expo Push API:', pushErr?.message || pushErr);

    await recordDeliveryOutcome('failed', 0, { spec, error: pushErr?.message || String(pushErr) }, pushErr?.message || String(pushErr));

    return new Response(
      JSON.stringify({ error: pushErr?.message || 'Failed to dispatch push notifications' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
});
