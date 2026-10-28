// DareDrop Serverless Edge Function: Check Expo Push Notification Delayed Receipts
// Periodically invoked via scheduler to retrieve delayed delivery receipts from Expo,
// audit downstream APNs/FCM delivery outcomes, and safely prune permanently revoked tokens.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SCHEDULER_SECRET = Deno.env.get('SCHEDULER_SECRET') || Deno.env.get('CRON_SECRET') || '';
const EXPO_ACCESS_TOKEN = Deno.env.get('EXPO_ACCESS_TOKEN') || '';

// Configurable constants
export const RECEIPT_DELAY_MINUTES = 15;
export const RECEIPT_EXPIRATION_HOURS = 24;
export const MAX_DELIVERIES_PER_BATCH = 50;
export const EXPO_FETCH_TIMEOUT_MS = 10000;
export const RECEIPT_LEASE_SECONDS = 120; // 2 minutes lease for concurrent workers
export const MAX_LEGACY_POLL_ATTEMPTS = 5; // Conservative poll attempts for historical records lacking sent_at

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
 * Prevents timing side-channel attacks against scheduler authentication.
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
 * Validates whether an incoming HTTP request is authorized to invoke the worker.
 * Strictly requires the dedicated SCHEDULER_SECRET (does not accept service-role keys).
 */
export async function authenticateSchedulerRequest(
  req: Request,
  expectedSecret: string,
): Promise<{ authorized: boolean; reason?: string }> {
  if (!expectedSecret) {
    return { authorized: false, reason: 'Scheduler secret not configured on server' };
  }

  const schedulerHeader = req.headers.get('x-scheduler-secret') || req.headers.get('x-cron-secret');
  const authHeader = req.headers.get('authorization');
  let bearerToken: string | null = null;

  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    bearerToken = authHeader.slice(7).trim();
  }

  const tokenToTest = schedulerHeader || bearerToken;
  if (!tokenToTest) {
    return { authorized: false, reason: 'Missing authorization headers' };
  }

  // Strictly check against SCHEDULER_SECRET
  if (await secureCompare(tokenToTest, expectedSecret)) {
    return { authorized: true };
  }

  return { authorized: false, reason: 'Invalid scheduler secret' };
}

export interface TicketAssociation {
  id: string;
  tokenId: string | null; // user_push_tokens.id primary key (UUID), never raw token
  status?: string;
}

/**
 * Extracts ticket IDs and their mapped user_push_tokens.id from a notification_delivery record.
 * Handles:
 * 1. Modern records: payload.tickets with token_id (UUID primary key)
 * 2. Historical records: expoResponse.data (tokenId is null, unmapped)
 */
export function extractTicketAssociations(delivery: any): TicketAssociation[] {
  const associations: TicketAssociation[] = [];
  const payload = delivery?.payload;

  if (Array.isArray(payload?.tickets) && payload.tickets.length > 0) {
    for (const t of payload.tickets) {
      if (t?.id && typeof t.id === 'string' && t.id.trim() !== '') {
        const rowId = typeof t.token_id === 'string' && t.token_id.trim() !== '' ? t.token_id.trim() : null;
        associations.push({
          id: t.id.trim(),
          tokenId: rowId,
          status: t.status,
        });
      }
    }
  } else if (Array.isArray(payload?.expoResponse?.data) && payload.expoResponse.data.length > 0) {
    // Historical record without explicit ticket-to-token map
    for (const t of payload.expoResponse.data) {
      if (t?.id && typeof t.id === 'string' && t.id.trim() !== '') {
        associations.push({
          id: t.id.trim(),
          tokenId: null, // Association unavailable
          status: t.status,
        });
      }
    }
  }

  return associations;
}

/**
 * Returns the authoritative ticket issuance timestamp if recorded, or null for historical records.
 * Only payload.sent_at guarantees the exact time Expo issued the ticket.
 */
export function getAuthoritativeSentTime(delivery: any): number | null {
  if (delivery?.payload?.sent_at) {
    const t = new Date(delivery.payload.sent_at).getTime();
    if (!isNaN(t)) return t;
  }
  return null;
}

/**
 * Primary Edge Function handler for checking push notification receipts.
 */
export async function checkPushReceiptsHandler(req: Request): Promise<Response> {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-scheduler-secret, x-cron-secret',
      },
    });
  }

  // 1. Authenticate Request strictly with SCHEDULER_SECRET
  const authResult = await authenticateSchedulerRequest(req, SCHEDULER_SECRET);
  if (!authResult.authorized) {
    const status = authResult.reason?.includes('not configured') ? 500 : 401;
    return new Response(JSON.stringify({ error: authResult.reason }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return new Response(JSON.stringify({ error: 'Supabase credentials not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const now = new Date();
  const nowMs = now.getTime();
  const maxEligibleDateIso = new Date(nowMs - RECEIPT_DELAY_MINUTES * 60 * 1000).toISOString();

  // 2. Query Candidate Notification Deliveries
  // Select deliveries where status = 'sent', created_at <= (now - 15 minutes),
  // and receipts status is NOT 'completed' (so completed rows do not block polling queue).
  const { data: candidateDeliveries, error: fetchErr } = await supabaseAdmin
    .from('notification_deliveries')
    .select('id, created_at, claimed_at, status, recipient_id, payload, claim_token')
    .eq('status', 'sent')
    .lte('created_at', maxEligibleDateIso)
    .or('payload->receipts->>status.is.null,payload->receipts->>status.eq.pending')
    .order('created_at', { ascending: true })
    .limit(MAX_DELIVERIES_PER_BATCH);

  if (fetchErr) {
    console.error('[check-push-receipts] Error querying eligible deliveries:', fetchErr.message);
    return new Response(JSON.stringify({ error: 'Database query failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!candidateDeliveries || candidateDeliveries.length === 0) {
    return new Response(
      JSON.stringify({
        success: true,
        message: 'No eligible deliveries awaiting receipt polling',
        processed: 0,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // 3. Filter and Atomically Claim Deliveries using CAS on claim_token
  const activeWorkerId = crypto.randomUUID();
  const leaseUntilIso = new Date(nowMs + RECEIPT_LEASE_SECONDS * 1000).toISOString();
  const expirationWindowMs = RECEIPT_EXPIRATION_HOURS * 60 * 60 * 1000;

  const claimedDeliveries: any[] = [];
  const claimedFencingTokens = new Map<string, string>(); // deliveryId -> new claim_token

  for (const delivery of candidateDeliveries) {
    const receiptsState = delivery.payload?.receipts;
    if (receiptsState?.status === 'completed') {
      continue; // Already finished
    }

    // Check if an active lease is held by another worker
    if (receiptsState?.lease_until) {
      const leaseExpiry = new Date(receiptsState.lease_until).getTime();
      if (leaseExpiry > nowMs) {
        continue; // Under active lease by another worker
      }
    }

    // Attempt atomic lease acquisition using Compare-And-Swap (CAS) on claim_token
    // Handles both non-null claim_token and NULL claim_token (legacy records)
    const nextFencingToken = crypto.randomUUID();
    const updatedPayload = {
      ...(delivery.payload || {}),
      receipts: {
        ...(receiptsState || {}),
        status: receiptsState?.status || 'pending',
        lease_until: leaseUntilIso,
        worker_id: activeWorkerId,
        last_attempt_at: now.toISOString(),
      },
    };

    let claimQuery = supabaseAdmin
      .from('notification_deliveries')
      .update({
        claim_token: nextFencingToken,
        payload: updatedPayload,
      })
      .eq('id', delivery.id)
      .eq('status', 'sent');

    if (delivery.claim_token !== null && delivery.claim_token !== undefined) {
      claimQuery = claimQuery.eq('claim_token', delivery.claim_token);
    } else {
      claimQuery = claimQuery.is('claim_token', null);
    }

    const { data: claimedRows, error: claimErr } = await claimQuery.select('id, claim_token, payload');

    if (!claimErr && claimedRows && claimedRows.length > 0) {
      delivery.payload = updatedPayload;
      claimedFencingTokens.set(delivery.id, nextFencingToken);
      claimedDeliveries.push(delivery);
    }
  }

  if (claimedDeliveries.length === 0) {
    return new Response(
      JSON.stringify({
        success: true,
        message: 'All candidate deliveries are completed or currently leased by other workers',
        processed: 0,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // 4. Collect ticket IDs across claimed deliveries
  const deliveryTicketMap = new Map<string, TicketAssociation[]>();
  const allTicketIdsToFetch: string[] = [];

  for (const delivery of claimedDeliveries) {
    const associations = extractTicketAssociations(delivery);
    deliveryTicketMap.set(delivery.id, associations);

    const sentTime = getAuthoritativeSentTime(delivery);
    const isExpiredAtExpo = sentTime !== null && (nowMs - sentTime) >= expirationWindowMs;

    // Check if legacy record has exhausted polling window
    const firstPolledAt = delivery.payload?.receipts?.first_polled_at
      ? new Date(delivery.payload.receipts.first_polled_at).getTime()
      : nowMs;
    const pollAttempts = (delivery.payload?.receipts?.poll_count || 0);
    const isLegacyTimedOut = sentTime === null && (pollAttempts >= MAX_LEGACY_POLL_ATTEMPTS || (nowMs - firstPolledAt) >= expirationWindowMs);

    if (isExpiredAtExpo || isLegacyTimedOut) {
      // Excluded from Expo fetch: either verified expired at Expo, or legacy polling window timed out
      continue;
    }

    const existingResults = delivery.payload?.receipts?.results || {};
    for (const assoc of associations) {
      if (!existingResults[assoc.id] || existingResults[assoc.id].status === 'pending') {
        if (!allTicketIdsToFetch.includes(assoc.id)) {
          allTicketIdsToFetch.push(assoc.id);
        }
      }
    }
  }

  // 5. Query Expo Push Receipts API
  let expoReceiptsData: Record<string, any> = {};
  let expoFetchSucceeded = true;

  if (allTicketIdsToFetch.length > 0) {
    const expoHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (EXPO_ACCESS_TOKEN) {
      expoHeaders['Authorization'] = `Bearer ${EXPO_ACCESS_TOKEN}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EXPO_FETCH_TIMEOUT_MS);

    try {
      const res = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
        method: 'POST',
        headers: expoHeaders,
        body: JSON.stringify({ ids: allTicketIdsToFetch }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        expoFetchSucceeded = false;
        console.error(`[check-push-receipts] Expo receipt API returned HTTP ${res.status}`);
      } else {
        const json = await res.json();
        if (json?.data && typeof json.data === 'object') {
          expoReceiptsData = json.data;
        }
      }
    } catch (fetchErr: any) {
      clearTimeout(timeoutId);
      expoFetchSucceeded = false;
      console.error('[check-push-receipts] Error contacting Expo receipt API:', fetchErr?.message || fetchErr);
    }
  }

  // If Expo fetch failed completely, release leases to leave deliveries immediately eligible for retry
  if (!expoFetchSucceeded) {
    for (const delivery of claimedDeliveries) {
      const fencingToken = claimedFencingTokens.get(delivery.id);
      if (fencingToken) {
        await supabaseAdmin
          .from('notification_deliveries')
          .update({
            payload: {
              ...delivery.payload,
              receipts: {
                ...(delivery.payload?.receipts || {}),
                lease_until: null, // Clear lease
              },
            },
          })
          .eq('id', delivery.id)
          .eq('claim_token', fencingToken)
          .eq('status', 'sent');
      }
    }

    return new Response(
      JSON.stringify({
        success: false,
        error: 'Expo receipt service unavailable; leases released for retry',
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // 6. Evaluate Receipts and Collect Revoked Token IDs
  const tokenRowIdsToDelete = new Set<string>();
  let totalReceiptsProcessed = 0;
  let totalTokensCleaned = 0;
  let pendingReceiptsCount = 0;

  for (const delivery of claimedDeliveries) {
    const fencingToken = claimedFencingTokens.get(delivery.id);
    if (!fencingToken) continue;

    const associations = deliveryTicketMap.get(delivery.id) || [];
    const currentResults = { ...(delivery.payload?.receipts?.results || {}) };

    const sentTime = getAuthoritativeSentTime(delivery);
    const isExpiredAtExpo = sentTime !== null && (nowMs - sentTime) >= expirationWindowMs;

    const currentPollCount = (delivery.payload?.receipts?.poll_count || 0) + 1;
    const firstPolledAtIso = delivery.payload?.receipts?.first_polled_at || now.toISOString();
    const firstPolledAtMs = new Date(firstPolledAtIso).getTime();
    const isLegacyTimedOut = sentTime === null && (currentPollCount >= MAX_LEGACY_POLL_ATTEMPTS || (nowMs - firstPolledAtMs) >= expirationWindowMs);

    let allTicketsResolved = associations.length > 0;
    let okCount = 0;
    let errorCount = 0;
    let pendingCount = 0;
    let expiredCount = 0;
    let legacyTimeoutCount = 0;

    for (const assoc of associations) {
      const receipt = expoReceiptsData[assoc.id];

      if (receipt) {
        totalReceiptsProcessed++;
        if (receipt.status === 'ok') {
          okCount++;
          currentResults[assoc.id] = {
            status: 'ok',
            checked_at: now.toISOString(),
          };
        } else if (receipt.status === 'error') {
          errorCount++;
          const errCode = receipt.details?.error || 'unknown_error';

          // Critical Rule: Only delete token if confirmed DeviceNotRegistered AND token row ID is verified
          let tokenRemoved = false;
          let note: string | undefined;

          if (errCode === 'DeviceNotRegistered') {
            if (assoc.tokenId && typeof assoc.tokenId === 'string') {
              tokenRowIdsToDelete.add(assoc.tokenId);
              tokenRemoved = true;
            } else {
              note = 'unmapped_historical_ticket_skipped_token_deletion';
            }
          }

          currentResults[assoc.id] = {
            status: 'error',
            error: errCode,
            message: receipt.message || null,
            token_removed: tokenRemoved,
            ...(note ? { note } : {}),
            checked_at: now.toISOString(),
          };
        }
      } else if (currentResults[assoc.id]?.status === 'ok' || currentResults[assoc.id]?.status === 'error') {
        // Already resolved in an earlier run
        if (currentResults[assoc.id].status === 'ok') okCount++;
        else errorCount++;
      } else if (isExpiredAtExpo) {
        // Authoritative Expo 24h expiration (verified sent_at >= 24h)
        expiredCount++;
        currentResults[assoc.id] = {
          status: 'expired',
          error: 'ReceiptExpiredAtExpo',
          message: 'Expo receipts expire after 24 hours and can no longer be retrieved',
          checked_at: now.toISOString(),
        };
      } else if (isLegacyTimedOut) {
        // Conservative Legacy Timeout: Legacy record without sent_at could not be found at Expo after polling window
        legacyTimeoutCount++;
        currentResults[assoc.id] = {
          status: 'unresolved_legacy_timeout',
          error: 'LegacyReceiptTimeout',
          message: 'Legacy record without sent_at could not be retrieved from Expo after polling window',
          checked_at: now.toISOString(),
        };
      } else {
        // Receipt not ready yet (Expo returns empty or partial response)
        pendingCount++;
        pendingReceiptsCount++;
        allTicketsResolved = false;
        currentResults[assoc.id] = {
          status: 'pending',
          checked_at: now.toISOString(),
        };
      }
    }

    // Delivery is completed only if all tickets have final outcomes (or zero ticket IDs)
    if (associations.length === 0 || isExpiredAtExpo || isLegacyTimedOut) {
      allTicketsResolved = true;
    }

    const deliveryStatus = allTicketsResolved ? 'completed' : 'pending';

    const finalPayload = {
      ...(delivery.payload || {}),
      receipts: {
        status: deliveryStatus,
        checked_at: now.toISOString(),
        first_polled_at: firstPolledAtIso,
        poll_count: currentPollCount,
        lease_until: null, // Clear lease
        worker_id: activeWorkerId,
        results: currentResults,
        summary: {
          total: associations.length,
          ok: okCount,
          error: errorCount,
          pending: pendingCount,
          ...(expiredCount > 0 ? { expired: expiredCount } : {}),
          ...(legacyTimeoutCount > 0 ? { legacy_timeout: legacyTimeoutCount } : {}),
        },
      },
    };

    // Update notification_delivery record guarded strictly by the active fencing token
    const { data: finalizedRows, error: finalizeErr } = await supabaseAdmin
      .from('notification_deliveries')
      .update({ payload: finalPayload })
      .eq('id', delivery.id)
      .eq('claim_token', fencingToken) // Fencing check prevents stale-worker overwrites
      .eq('status', 'sent') // Guaranteed: status = 'sent' remains untouched
      .select('id');

    if (finalizeErr || !finalizedRows || finalizedRows.length === 0) {
      console.warn(`[check-push-receipts] Lease fence violation or update error: Delivery ${delivery.id}. Aborting token deletion.`);
      // Abort token deletion for this delivery
      for (const assoc of associations) {
        if (assoc.tokenId) tokenRowIdsToDelete.delete(assoc.tokenId);
      }
    }
  }

  // 7. Safely Remove Revoked Tokens by primary key ID (never exposing raw tokens)
  let deletionError: string | null = null;

  if (tokenRowIdsToDelete.size > 0) {
    const rowIdList = Array.from(tokenRowIdsToDelete);
    const { data: deletedRows, error: delErr } = await supabaseAdmin
      .from('user_push_tokens')
      .delete()
      .in('id', rowIdList)
      .select('id');

    if (delErr) {
      deletionError = delErr.message;
      totalTokensCleaned = 0;
      console.error('[check-push-receipts] Error deleting revoked token rows:', delErr.message);
    } else {
      totalTokensCleaned = deletedRows ? deletedRows.length : 0;
      console.log(`[check-push-receipts] Confirmed removal of ${totalTokensCleaned} unregistered device token rows.`);
    }
  }

  const responseStatus = deletionError ? 500 : 200;
  return new Response(
    JSON.stringify({
      success: deletionError === null,
      deliveriesEvaluated: claimedDeliveries.length,
      receiptsProcessed: totalReceiptsProcessed,
      tokensCleaned: totalTokensCleaned,
      pendingReceipts: pendingReceiptsCount,
      ...(deletionError ? { tokenCleanupError: deletionError } : {}),
    }),
    { status: responseStatus, headers: { 'Content-Type': 'application/json' } },
  );
}

// Serve HTTP handler in Deno runtime
if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  Deno.serve(checkPushReceiptsHandler);
}
