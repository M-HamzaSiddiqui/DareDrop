// scripts/test-friends-db.js
// Dedicated Live PostgreSQL Integration & Concurrency Test Suite
// Executes against an isolated, disposable PostgreSQL 16 database.
// Tests: Genuine concurrent sessions for reciprocal requests, race-condition locking,
// challenge-join invariants & participant counts, invitation expiration persistence,
// profile creation races, direct table write locks, and RLS security.

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DB_CONFIG = {
  host: process.env.TEST_PGHOST || '/home/umardinkhan/.gemini/antigravity-ide/brain/89949ad1-3a09-435c-b590-2815756775fb/scratch',
  port: parseInt(process.env.TEST_PGPORT || '54333', 10),
  database: 'postgres',
  user: 'postgres',
};

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

async function setSession(client, userId) {
  await client.query(`SET request.jwt.claim.sub = '${userId}';`);
  await client.query('SET ROLE authenticated;');
}

async function resetSession(client) {
  await client.query('RESET ROLE;');
  await client.query('RESET request.jwt.claim.sub;');
}

async function runRealDbTests() {
  console.log('🐘 Starting DareDrop Friends & Social Challenges Real PostgreSQL Integration Suite...\n');
  console.log(`Connected to isolated PostgreSQL test instance at ${DB_CONFIG.host}:${DB_CONFIG.port}\n`);

  const pool = new Pool(DB_CONFIG);

  try {
    // Verify connectivity
    const adminClient = await pool.connect();
    const verRes = await adminClient.query('SELECT version();');
    check(verRes.rows.length > 0, `PostgreSQL is online: ${verRes.rows[0].version.split(' ')[0]} ${verRes.rows[0].version.split(' ')[1]}`);

    // Clean test tables to ensure clean state
    await adminClient.query(`
      TRUNCATE TABLE public.challenge_participants, public.challenge_invitations, public.friendships, public.user_profiles, public.notification_deliveries, public.challenges, public.friend_code_lookup_rate_limits CASCADE;
    `);

    // =========================================================================
    // Test 1: Direct Table Write Lockdown & Function Privileges
    // =========================================================================
    console.log('\n[Test 1] Direct Table Write Lockdown & Function Privileges:');

    const authClient = await pool.connect();
    await setSession(authClient, '11111111-1111-1111-1111-111111111111');

    // Attempt direct insert on user_profiles
    let directProfileInsertBlocked = false;
    try {
      await authClient.query(`
        INSERT INTO public.user_profiles (user_id, friend_code, display_name)
        VALUES ('11111111-1111-1111-1111-111111111111', 'DARE-HACK-1234', 'Hacker');
      `);
    } catch (err) {
      directProfileInsertBlocked = err.code === '42501'; // insufficient_privilege
    }
    check(directProfileInsertBlocked, 'Direct INSERT on public.user_profiles is strictly blocked (42501)');

    // Attempt direct update on user_profiles
    let directProfileUpdateBlocked = false;
    try {
      await authClient.query(`
        UPDATE public.user_profiles SET display_name = 'Hacked' WHERE user_id = '11111111-1111-1111-1111-111111111111';
      `);
    } catch (err) {
      directProfileUpdateBlocked = err.code === '42501';
    }
    check(directProfileUpdateBlocked, 'Direct UPDATE on public.user_profiles is strictly blocked (42501)');

    // Attempt direct insert on friendships
    let directFriendshipInsertBlocked = false;
    try {
      await authClient.query(`
        INSERT INTO public.friendships (sender_id, receiver_id, status)
        VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'accepted');
      `);
    } catch (err) {
      directFriendshipInsertBlocked = err.code === '42501';
    }
    check(directFriendshipInsertBlocked, 'Direct INSERT on public.friendships is strictly blocked (42501)');

    // Attempt direct select on friend_code_lookup_rate_limits
    let directRateLimitSelectBlocked = false;
    try {
      await authClient.query('SELECT * FROM public.friend_code_lookup_rate_limits;');
    } catch (err) {
      directRateLimitSelectBlocked = err.code === '42501';
    }
    check(directRateLimitSelectBlocked, 'Direct SELECT on public.friend_code_lookup_rate_limits is strictly blocked (42501)');

    // Attempt direct execute of internal helper generate_secure_friend_code()
    let helperExecutionBlocked = false;
    try {
      await authClient.query('SELECT public.generate_secure_friend_code();');
    } catch (err) {
      helperExecutionBlocked = err.code === '42501';
    }
    check(helperExecutionBlocked, 'Execution of generate_secure_friend_code() is revoked from authenticated (42501)');

    await resetSession(authClient);
    authClient.release();

    // =========================================================================
    // Test 2: Profile Creation, Concurrent Races & Name Validation
    // =========================================================================
    console.log('\n[Test 2] Profile Creation, Concurrent Races & Name Validation:');

    const u1 = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
    const u2 = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb';

    const client1 = await pool.connect();
    const client2 = await pool.connect();

    await setSession(client1, u1);
    await setSession(client2, u1);

    // Genuinely concurrent profile creation for the same user u1
    const [p1Res, p2Res] = await Promise.all([
      client1.query("SELECT * FROM public.get_or_create_user_profile('Alex Runner', '⚡');"),
      client2.query("SELECT * FROM public.get_or_create_user_profile('Alex Runner', '⚡');"),
    ]);

    const prof1 = p1Res.rows[0];
    const prof2 = p2Res.rows[0];

    check(
      prof1.friend_code === prof2.friend_code && prof1.user_id === u1,
      'Concurrent profile creation for same user resolves idempotently with same friend code',
    );

    // Create profile for user 2
    await setSession(client2, u2);
    const p3Res = await client2.query("SELECT * FROM public.get_or_create_user_profile('Bob Walker', '🦁');");
    const profBob = p3Res.rows[0];
    check(profBob.user_id === u2 && profBob.friend_code !== prof1.friend_code, 'User 2 profile created with distinct friend code');

    // Server-side regex validation on profile updates
    // 1. Valid name with apostrophe, dot, hyphen, space
    const updateValid = await client1.query("SELECT * FROM public.update_user_profile('Alex O''Connor-Smith Jr.', '🏃');");
    check(updateValid.rows[0].display_name === "Alex O'Connor-Smith Jr.", 'Profile update allows valid letters, apostrophe, hyphen, dot, space');

    // 2. Invalid name with script or semicolon
    let invalidNameRejected = false;
    try {
      await client1.query("SELECT * FROM public.update_user_profile('<script>alert(1)</script>', '🏃');");
    } catch (err) {
      invalidNameRejected = err.code === '22023';
    }
    check(invalidNameRejected, 'Server-side regex strictly rejects invalid/script characters (22023)');

    // 3. Name length boundary check (< 2 chars)
    let tooShortRejected = false;
    try {
      await client1.query("SELECT * FROM public.update_user_profile('A', '🏃');");
    } catch (err) {
      tooShortRejected = err.code === '22023';
    }
    check(tooShortRejected, 'Server-side validation rejects name shorter than 2 characters (22023)');

    // =========================================================================
    // Test 3: Minimized Friend-Code Lookup Results
    // =========================================================================
    console.log('\n[Test 3] Minimized Friend-Code Lookup Projections:');

    // User 1 looks up User 2's profile by friend code
    const lookupRes = await client1.query(`SELECT * FROM public.lookup_profile_by_friend_code('${profBob.friend_code}');`);
    check(lookupRes.rows.length === 1, 'Lookup returns 1 record for valid friend code');
    const lookupRow = lookupRes.rows[0];
    check(lookupRow.display_name === 'Bob Walker', 'Lookup returns display_name');
    check(lookupRow.avatar_emoji === '🦁', 'Lookup returns avatar_emoji');
    check(lookupRow.is_self === false, 'Lookup returns is_self = false');
    check(lookupRow.friendship_status === 'none', 'Lookup returns friendship_status = none');
    check(lookupRow.user_id === undefined, 'Lookup DOES NOT expose target user_id');
    check(lookupRow.friend_code === undefined, 'Lookup DOES NOT expose target friend_code');

    // Lookup self
    const lookupSelf = await client1.query(`SELECT * FROM public.lookup_profile_by_friend_code('${prof1.friend_code}');`);
    check(lookupSelf.rows[0].is_self === true && lookupSelf.rows[0].friendship_status === 'self', 'Lookup self returns is_self = true, status = self');

    // =========================================================================
    // Test 4: Genuinely Concurrent Reciprocal Friend Requests
    // =========================================================================
    console.log('\n[Test 4] Genuinely Concurrent Reciprocal Friend Requests:');

    // Two parallel clients: client1 represents Alex, client2 represents Bob
    // Both send friend request to each other at the exact same instant!
    await setSession(client1, u1);
    await setSession(client2, u2);

    const [req1, req2] = await Promise.all([
      client1.query(`SELECT * FROM public.send_friend_request('${profBob.friend_code}');`),
      client2.query(`SELECT * FROM public.send_friend_request('${prof1.friend_code}');`),
    ]);

    check(req1.rows.length === 1 && req2.rows.length === 1, 'Both concurrent reciprocal requests execute without error');

    // One must be 'pending' or 'accepted', and the pair resolves to 'accepted'
    const finalStatus = req1.rows[0].status === 'accepted' ? req1.rows[0].status : req2.rows[0].status;
    check(finalStatus === 'accepted', 'Simultaneous reciprocal requests atomically resolve to accepted status');

    // Verify exactly ONE friendship row exists between u1 and u2 in database
    await resetSession(adminClient);
    const countRes = await adminClient.query(`
      SELECT count(*) AS total, status FROM public.friendships
      WHERE (sender_id = '${u1}' AND receiver_id = '${u2}')
         OR (sender_id = '${u2}' AND receiver_id = '${u1}')
      GROUP BY status;
    `);
    check(
      countRes.rows.length === 1 && parseInt(countRes.rows[0].total, 10) === 1 && countRes.rows[0].status === 'accepted',
      'Exactly 1 canonical friendship row exists with status = accepted (no duplicate rows or race leakage)',
    );

    // Verify send_friend_request does NOT expose target_user_id
    check(req1.rows[0].target_user_id === undefined, 'send_friend_request return table does NOT expose target_user_id');

    // Verify friends list
    const friendsRes = await client1.query('SELECT * FROM public.get_user_friends();');
    check(friendsRes.rows.length === 1 && friendsRes.rows[0].friend_user_id === u2, 'User 1 sees User 2 in get_user_friends()');

    // =========================================================================
    // Test 5: Concurrent Accept vs Decline Race
    // =========================================================================
    console.log('\n[Test 5] Concurrent Accept vs Decline Race:');

    const u3 = 'cccccccc-3333-3333-3333-cccccccccccc';
    const u4 = 'dddddddd-4444-4444-4444-dddddddddddd';

    await setSession(client1, u3);
    const pU3 = (await client1.query("SELECT * FROM public.get_or_create_user_profile('Charlie', '🏄');")).rows[0];

    await setSession(client2, u4);
    const pU4 = (await client2.query("SELECT * FROM public.get_or_create_user_profile('Diana', '🎯');")).rows[0];

    // Charlie sends request to Diana
    const sendReqCD = await client1.query(`SELECT * FROM public.send_friend_request('${pU4.friend_code}');`);
    const reqIdCD = sendReqCD.rows[0].request_id;
    check(sendReqCD.rows[0].status === 'pending', 'Charlie sends pending request to Diana');

    // Genuinely concurrent Accept and Decline attempts by Diana
    const client3 = await pool.connect();
    await setSession(client3, u4);

    let acceptWon = false;
    let declineWon = false;

    const [resAccept, resDecline] = await Promise.allSettled([
      client2.query(`SELECT * FROM public.accept_friend_request('${reqIdCD}');`),
      client3.query(`SELECT * FROM public.decline_friend_request('${reqIdCD}');`),
    ]);

    if (resAccept.status === 'fulfilled' && resAccept.value.rows[0].accept_friend_request === true) {
      acceptWon = true;
    }
    if (resDecline.status === 'fulfilled' && resDecline.value.rows[0].decline_friend_request === true) {
      declineWon = true;
    }

    check(
      (acceptWon && !declineWon) || (!acceptWon && declineWon),
      'Concurrent accept vs decline produces exactly one winner (no contradictory state)',
    );

    // If accepted, verify Charlie cannot cancel
    if (acceptWon) {
      let cancelFailed = false;
      try {
        await client1.query(`SELECT * FROM public.cancel_friend_request('${reqIdCD}');`);
      } catch (err) {
        cancelFailed = err.code === '22023';
      }
      check(cancelFailed, 'Sender cannot cancel an accepted request (22023)');
    }

    await resetSession(client3);
    client3.release();

    // =========================================================================
    // Test 6: Re-request After Cancellation & Decline
    // =========================================================================
    console.log('\n[Test 6] Re-request After Cancellation & Decline:');

    const u5 = 'eeeeeeee-5555-5555-5555-eeeeeeeeeeee';
    const u6 = 'ffffffff-6666-6666-6666-ffffffffffff';

    await setSession(client1, u5);
    const pU5 = (await client1.query("SELECT * FROM public.get_or_create_user_profile('Eve', '🦊');")).rows[0];

    await setSession(client2, u6);
    const pU6 = (await client2.query("SELECT * FROM public.get_or_create_user_profile('Frank', '🦉');")).rows[0];

    // 1. Eve sends request -> Eve cancels
    const reqEF1 = await client1.query(`SELECT * FROM public.send_friend_request('${pU6.friend_code}');`);
    const reqIdEF1 = reqEF1.rows[0].request_id;
    await client1.query(`SELECT * FROM public.cancel_friend_request('${reqIdEF1}');`);

    // 2. Eve sends request again -> succeeds!
    const reqEF2 = await client1.query(`SELECT * FROM public.send_friend_request('${pU6.friend_code}');`);
    check(reqEF2.rows[0].status === 'pending', 'Can send new friend request after prior cancellation');

    // 3. Frank declines
    await client2.query(`SELECT * FROM public.decline_friend_request('${reqEF2.rows[0].request_id}');`);

    // 4. Eve sends request again -> succeeds!
    const reqEF3 = await client1.query(`SELECT * FROM public.send_friend_request('${pU6.friend_code}');`);
    check(reqEF3.rows[0].status === 'pending', 'Can send new friend request after prior decline');

    // =========================================================================
    // Test 7: Challenge Invitation Lifecycle & Invariants (Capacity Trigger)
    // =========================================================================
    console.log('\n[Test 7] Challenge Invitation Lifecycle & Trigger Invariants:');

    // User 1 creates a challenge
    await resetSession(adminClient);
    const chalRes = await adminClient.query(`
      INSERT INTO public.challenges (title, description, category, duration_days, creator_id, creator_name)
      VALUES ('Mountain Hike Challenge', 'Hike 10 miles', 'Fitness', 7, '${u1}', 'Alex Runner')
      RETURNING id, participants_count;
    `);
    const challengeId = chalRes.rows[0].id;

    // Join creator to challenge (matches DareDrop challenge creation flow)
    await adminClient.query(`
      INSERT INTO public.challenge_participants (challenge_id, user_id)
      VALUES ('${challengeId}', '${u1}');
    `);

    // Verify initial participants_count = 1 via trigger
    const initialChal = (await adminClient.query(`SELECT participants_count FROM public.challenges WHERE id = '${challengeId}';`)).rows[0];
    check(initialChal.participants_count === 1, 'Initial challenge participants_count is 1 via trg_challenge_participant_count');

    // User 1 invites accepted friend User 2 (u1 and u2 are friends from Test 4)
    await setSession(client1, u1);
    const inviteRes = await client1.query(`
      SELECT * FROM public.send_challenge_invitation('${challengeId}', '${u2}');
    `);
    check(inviteRes.rows.length === 1 && inviteRes.rows[0].status === 'pending', 'User 1 sends challenge invitation to friend User 2');
    const invitationId = inviteRes.rows[0].invitation_id;

    // User 2 accepts invitation
    await setSession(client2, u2);
    const acceptInvRes = await client2.query(`
      SELECT * FROM public.respond_to_challenge_invitation('${invitationId}', true);
    `);
    check(acceptInvRes.rows[0].status === 'accepted', 'User 2 accepts challenge invitation');

    // Verify participants_count automatically incremented to 2 via trigger!
    const updatedChal = (await adminClient.query(`SELECT participants_count FROM public.challenges WHERE id = '${challengeId}';`)).rows[0];
    check(updatedChal.participants_count === 2, 'Challenge participants_count incremented to 2 automatically via trigger');

    // Attempt duplicate invitation to already-joined friend
    let dupInviteBlocked = false;
    try {
      await client1.query(`SELECT * FROM public.send_challenge_invitation('${challengeId}', '${u2}');`);
    } catch (err) {
      dupInviteBlocked = err.code === '23505'; // already participant
    }
    check(dupInviteBlocked, 'Cannot invite a friend who is already a participant (23505)');

    // =========================================================================
    // Test 8: Expired Invitation State Persistence Without Rollback
    // =========================================================================
    console.log('\n[Test 8] Expired Invitation State Persistence Without Rollback:');

    // Make Charlie (u3) and Diana (u4) friends
    await adminClient.query(`
      INSERT INTO public.friendships (sender_id, receiver_id, status)
      VALUES ('${u3}', '${u4}', 'accepted')
      ON CONFLICT DO NOTHING;
    `);

    // Create challenge for Charlie
    const chal2Res = await adminClient.query(`
      INSERT INTO public.challenges (title, description, category, duration_days, creator_id)
      VALUES ('Quick Sprint', 'Sprint 100m', 'Fitness', 1, '${u3}')
      RETURNING id;
    `);
    const challenge2Id = chal2Res.rows[0].id;
    await adminClient.query(`INSERT INTO public.challenge_participants (challenge_id, user_id) VALUES ('${challenge2Id}', '${u3}');`);

    // Create an already-expired invitation directly
    const expInvRes = await adminClient.query(`
      INSERT INTO public.challenge_invitations (challenge_id, inviter_id, invitee_id, status, expires_at)
      VALUES ('${challenge2Id}', '${u3}', '${u4}', 'pending', now() - INTERVAL '1 hour')
      RETURNING id;
    `);
    const expInvId = expInvRes.rows[0].id;

    // Diana responds to expired invitation
    await setSession(client2, u4);
    const respExpRes = await client2.query(`
      SELECT * FROM public.respond_to_challenge_invitation('${expInvId}', true);
    `);
    check(respExpRes.rows[0].status === 'expired', 'Responding to expired invitation returns status = expired without error');

    // Verify the expired status PERSISTS in the database (did not roll back)
    const checkDbExp = (await adminClient.query(`SELECT status FROM public.challenge_invitations WHERE id = '${expInvId}';`)).rows[0];
    check(checkDbExp.status === 'expired', 'Expired status persists in database without transaction rollback');

    // Verify Diana was NOT added to challenge_participants
    const partCheck = await adminClient.query(`
      SELECT count(*) AS count FROM public.challenge_participants
      WHERE challenge_id = '${challenge2Id}' AND user_id = '${u4}';
    `);
    check(parseInt(partCheck.rows[0].count, 10) === 0, 'Expired invitation does NOT register participant');

    // =========================================================================
    // Test 9: Notification Inbox Event Verification
    // =========================================================================
    console.log('\n[Test 9] Notification Inbox Integration:');

    // Verify User 2 received in-app inbox notifications
    await setSession(client2, u2);
    const inboxRes = await client2.query('SELECT * FROM public.get_user_notifications(30, 0);');
    check(inboxRes.rows.length >= 1, 'In-app notification inbox contains social challenge notifications');
    const hasInviteEvent = inboxRes.rows.some((n) => n.event_type === 'challenge_invitation_received');
    check(hasInviteEvent, 'challenge_invitation_received is present in inbox for invitee');

    // =========================================================================
    // Test 10: Server-Side Rate Limiting on lookup_profile_by_friend_code
    // =========================================================================
    console.log('\n[Test 10] Server-Side Rate Limiting (Normal, Repeated, Concurrent, and Window Reset):');

    const uRate = '77777777-7777-7777-7777-777777777777';
    const rateClient1 = await pool.connect();
    const rateClient2 = await pool.connect();
    await setSession(rateClient1, uRate);
    await setSession(rateClient2, uRate);

    // 1. Normal lookups (under limit): Perform 5 normal lookups
    let normalLookupsSuccess = true;
    for (let i = 0; i < 5; i++) {
      const res = await rateClient1.query(`SELECT * FROM public.lookup_profile_by_friend_code('${profBob.friend_code}');`);
      if (res.rows.length !== 1 || res.rows[0].display_name !== 'Bob Walker') {
        normalLookupsSuccess = false;
      }
    }
    check(normalLookupsSuccess, 'Normal lookups (5 requests) succeed without rate limit penalty');

    // Verify minimum profile information exposure
    const sampleLookup = (await rateClient1.query(`SELECT * FROM public.lookup_profile_by_friend_code('${profBob.friend_code}');`)).rows[0];
    const allowedKeys = ['display_name', 'avatar_emoji', 'is_self', 'friendship_status'];
    const actualKeys = Object.keys(sampleLookup);
    const hasOnlyAllowedKeys = actualKeys.every((k) => allowedKeys.includes(k));
    check(hasOnlyAllowedKeys, 'Lookup RPC returns strictly minimal fields (display_name, avatar_emoji, is_self, friendship_status)');
    check(sampleLookup.user_id === undefined, 'Lookup DOES NOT leak internal target user_id');
    check(sampleLookup.friend_code === undefined, 'Lookup DOES NOT leak internal friend_code');

    // 2. Repeated lookups: Consume remaining quota up to limit (15 requests total)
    // We already did 6 lookups (5 in loop + 1 sample). Do 9 more to reach exactly 15.
    for (let i = 7; i <= 15; i++) {
      await rateClient1.query(`SELECT * FROM public.lookup_profile_by_friend_code('${profBob.friend_code}');`);
    }

    // 3. Request 16 must be rejected with rate limit error
    let rateLimitExceeded = false;
    let rateLimitErrorMessage = '';
    try {
      await rateClient1.query(`SELECT * FROM public.lookup_profile_by_friend_code('${profBob.friend_code}');`);
    } catch (err) {
      rateLimitExceeded = err.code === '22023';
      rateLimitErrorMessage = err.message || '';
    }
    check(rateLimitExceeded, 'Repeated lookups exceeding 15/min are strictly blocked (22023)');
    check(rateLimitErrorMessage.includes('Rate limit exceeded'), `Error message correctly reports rate limit: "${rateLimitErrorMessage}"`);

    // 4. Concurrent requests: 5 parallel requests on separate clients while over limit are all serialized and blocked
    const concurrentClients = await Promise.all([
      pool.connect(),
      pool.connect(),
      pool.connect(),
      pool.connect(),
      pool.connect(),
    ]);
    for (const c of concurrentClients) {
      await setSession(c, uRate);
    }

    const concurrentOverLimit = await Promise.allSettled(
      concurrentClients.map((c) => c.query(`SELECT * FROM public.lookup_profile_by_friend_code('${profBob.friend_code}');`)),
    );

    for (const c of concurrentClients) {
      await resetSession(c);
      c.release();
    }

    const allRejected = concurrentOverLimit.every(
      (r) => r.status === 'rejected' && r.reason.code === '22023' && r.reason.message.includes('Rate limit exceeded'),
    );
    check(allRejected, 'Concurrent requests while rate limited are all safely serialized and blocked');

    // 5. Window Reset: Legitimate retries after window expires
    // Simulate window expiry (65 seconds in the past) via administrative update
    await resetSession(adminClient);
    await adminClient.query(`
      UPDATE public.friend_code_lookup_rate_limits
      SET window_start = now() - INTERVAL '65 seconds'
      WHERE user_id = '${uRate}';
    `);

    // New request after reset succeeds!
    let resetSucceeded = false;
    try {
      const resetRes = await rateClient1.query(`SELECT * FROM public.lookup_profile_by_friend_code('${profBob.friend_code}');`);
      resetSucceeded = resetRes.rows.length === 1 && resetRes.rows[0].display_name === 'Bob Walker';
    } catch {
      resetSucceeded = false;
    }
    check(resetSucceeded, 'Legitimate lookup succeeds immediately after rate limit window resets');

    // Verify counter reset to 1 in rate limits table
    const counterRow = (await adminClient.query(`
      SELECT attempt_count FROM public.friend_code_lookup_rate_limits WHERE user_id = '${uRate}';
    `)).rows[0];
    check(parseInt(counterRow.attempt_count, 10) === 1, 'Rate limit attempt_count successfully resets to 1 after window expiry');

    await resetSession(rateClient1);
    await resetSession(rateClient2);
    rateClient1.release();
    rateClient2.release();

    // Clean up
    await resetSession(client1);
    await resetSession(client2);
    await resetSession(adminClient);
    client1.release();
    client2.release();
    adminClient.release();

    console.log(`\n🎉 PostgreSQL Integration Suite Completed: ${passed} passed, ${failed} failed.\n`);
    await pool.end();

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Fatal database test error:', err);
    await pool.end();
    process.exit(1);
  }
}

runRealDbTests().catch((err) => {
  console.error('Test runner failure:', err);
  process.exit(1);
});
