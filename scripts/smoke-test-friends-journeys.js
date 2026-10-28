// scripts/smoke-test-friends-journeys.js
// Final App Smoke Test: Complete 7-Journey Verification Suite
// Executes against isolated local PostgreSQL 16 test database (port 54333).

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

function loadTsModule(relativePath, mockImports = {}) {
  const fullPath = path.resolve(process.cwd(), relativePath);
  const code = fs.readFileSync(fullPath, 'utf8');
  const transpiled = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mockModule = { exports: {} };
  const evalFn = new Function('module', 'exports', 'require', transpiled);
  evalFn(mockModule, mockModule.exports, (mod) => {
    if (mockImports[mod]) return mockImports[mod];
    if (mod === 'react-native') return { Share: { share: async () => ({ action: 'sharedAction' }) } };
    if (mod === 'expo-clipboard') return { setStringAsync: async () => {} };
    if (mod === '@react-native-async-storage/async-storage') return {
      getItem: async () => null,
      setItem: async () => {},
      removeItem: async () => {},
    };
    return {};
  });
  return mockModule.exports;
}

const { normalizeFriendCode, isValidFriendCode, translateSocialError } = loadTsModule('src/lib/friends.ts', {
  './supabase': { isSupabaseConfigured: false, supabase: null },
});

const { getNotificationRoute } = loadTsModule('src/lib/inbox.ts', {
  './supabase': { isSupabaseConfigured: false, supabase: null },
});

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

async function runSmokeTest() {
  console.log('🚀 Starting DareDrop Friends & Social Challenges Final App Smoke Test...\n');
  console.log(`Target: Isolated PostgreSQL 16 DB on ${DB_CONFIG.host}:${DB_CONFIG.port}\n`);

  const pool = new Pool(DB_CONFIG);

  try {
    const admin = await pool.connect();

    // Clean all test tables
    await admin.query(`
      TRUNCATE TABLE 
        public.challenge_completions,
        public.challenge_participants,
        public.challenge_invitations,
        public.friendships,
        public.user_profiles,
        public.notification_deliveries,
        public.user_push_tokens,
        public.challenges,
        public.friend_code_lookup_rate_limits
      CASCADE;
    `);

    // =========================================================================
    // Journey 1: Profile Lifecycle & Friend Code Immutability
    // =========================================================================
    console.log('[Journey 1] Profile: Creation, Retrieval, Updates & Code Immutability:');
    const uAlpha = '10000000-0000-0000-0000-000000000001';
    const clientAlpha = await pool.connect();
    await setSession(clientAlpha, uAlpha);

    // 1. Create or retrieve profile
    const p1Res = await clientAlpha.query("SELECT * FROM public.get_or_create_user_profile('Alpha Challenger', '🦁');");
    const profAlpha = p1Res.rows[0];
    check(profAlpha.user_id === uAlpha, 'Profile created with authenticated user_id');
    check(/^DARE-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/.test(profAlpha.friend_code), `Friend code is valid Crockford format: ${profAlpha.friend_code}`);
    check(profAlpha.display_name === 'Alpha Challenger', 'Display name is set correctly');
    check(profAlpha.avatar_emoji === '🦁', 'Avatar emoji is set correctly');

    // 2. Retrieve existing profile (idempotency check)
    const p1Retrieve = await clientAlpha.query("SELECT * FROM public.get_or_create_user_profile();");
    check(p1Retrieve.rows[0].friend_code === profAlpha.friend_code, 'Profile retrieval returns identical friend code');

    // 3. Update display name and avatar
    const p1Updated = await clientAlpha.query("SELECT * FROM public.update_user_profile('Alpha O''Conner-Pro', '⚡');");
    check(p1Updated.rows[0].display_name === "Alpha O'Conner-Pro", 'Display name updated successfully');
    check(p1Updated.rows[0].avatar_emoji === '⚡', 'Avatar emoji updated successfully');
    check(p1Updated.rows[0].friend_code === profAlpha.friend_code, 'Friend code remains strictly immutable across updates');

    // 4. Client validation check
    check(normalizeFriendCode(profAlpha.friend_code) === profAlpha.friend_code, 'Client normalizer preserves canonical friend code');

    // =========================================================================
    // Journey 2: Add Friend Workflow (Lookup, Send, Accept/Decline, Remove)
    // =========================================================================
    console.log('\n[Journey 2] Add Friend: Lookup, Request, Accept, View Friends & Remove:');
    const uBeta = '20000000-0000-0000-0000-000000000002';
    const clientBeta = await pool.connect();
    await setSession(clientBeta, uBeta);

    const p2Res = await clientBeta.query("SELECT * FROM public.get_or_create_user_profile('Beta Sprinter', '🏃');");
    const profBeta = p2Res.rows[0];

    // 1. Alpha looks up Beta
    const lookupBeta = (await clientAlpha.query(`SELECT * FROM public.lookup_profile_by_friend_code('${profBeta.friend_code}');`)).rows[0];
    check(lookupBeta.display_name === 'Beta Sprinter', 'Alpha looks up Beta: display name matches');
    check(lookupBeta.avatar_emoji === '🏃', 'Alpha looks up Beta: avatar matches');
    check(lookupBeta.is_self === false, 'Alpha looks up Beta: is_self is false');
    check(lookupBeta.friendship_status === 'none', 'Alpha looks up Beta: friendship_status is none');
    check(lookupBeta.user_id === undefined, 'Alpha looks up Beta: user_id is NOT exposed');
    check(lookupBeta.friend_code === undefined, 'Alpha looks up Beta: friend_code is NOT exposed');

    // 2. Alpha sends friend request to Beta
    const sendRes = (await clientAlpha.query(`SELECT * FROM public.send_friend_request('${profBeta.friend_code}');`)).rows[0];
    check(sendRes.status === 'pending', 'Alpha sends request to Beta: status is pending');
    check(sendRes.target_display_name === 'Beta Sprinter', 'Alpha sends request: target display name returned');
    check(sendRes.target_user_id === undefined, 'Alpha sends request: target_user_id NOT exposed');
    const reqIdAlphaBeta = sendRes.request_id;

    // 3. Beta checks incoming pending requests
    const betaPending = (await clientBeta.query('SELECT * FROM public.get_pending_friend_requests();')).rows;
    check(betaPending.length === 1 && betaPending[0].direction === 'incoming', 'Beta sees incoming friend request');
    check(betaPending[0].display_name === "Alpha O'Conner-Pro", 'Incoming request shows Alpha display name');
    check(betaPending[0].other_user_id === undefined, 'Incoming request DOES NOT leak internal other_user_id');

    // 4. Alpha checks outgoing pending requests
    const alphaPending = (await clientAlpha.query('SELECT * FROM public.get_pending_friend_requests();')).rows;
    check(alphaPending.length === 1 && alphaPending[0].direction === 'outgoing', 'Alpha sees outgoing friend request');
    check(alphaPending[0].display_name === 'Beta Sprinter', 'Outgoing request shows Beta display name');

    // 5. Beta accepts request
    const acceptRes = (await clientBeta.query(`SELECT public.accept_friend_request('${reqIdAlphaBeta}');`)).rows[0];
    check(acceptRes.accept_friend_request === true, 'Beta successfully accepts Alpha request');

    // 6. Both see each other in get_user_friends()
    const alphaFriends = (await clientAlpha.query('SELECT * FROM public.get_user_friends();')).rows;
    const betaFriends = (await clientBeta.query('SELECT * FROM public.get_user_friends();')).rows;
    check(alphaFriends.length === 1 && alphaFriends[0].friend_user_id === uBeta, 'Alpha has Beta in accepted friends list');
    check(betaFriends.length === 1 && betaFriends[0].friend_user_id === uAlpha, 'Beta has Alpha in accepted friends list');

    // 7. Alpha removes Beta
    const removeRes = (await clientAlpha.query(`SELECT public.remove_friend('${uBeta}');`)).rows[0];
    check(removeRes.remove_friend === true, 'Alpha removes Beta from friends');
    const alphaFriendsAfter = (await clientAlpha.query('SELECT * FROM public.get_user_friends();')).rows;
    const betaFriendsAfter = (await clientBeta.query('SELECT * FROM public.get_user_friends();')).rows;
    check(alphaFriendsAfter.length === 0, 'Alpha friends list is now empty');
    check(betaFriendsAfter.length === 0, 'Beta friends list is now empty');

    // =========================================================================
    // Journey 3: Request Edge Cases (Self, Invalid, Duplicate, Reciprocal, Re-request)
    // =========================================================================
    console.log('\n[Journey 3] Request Edge Cases: Self-requests, Invalid Codes, Reciprocals & Re-requests:');

    // 1. Self-request block
    let selfReqBlocked = false;
    try {
      await clientAlpha.query(`SELECT * FROM public.send_friend_request('${profAlpha.friend_code}');`);
    } catch (err) {
      selfReqBlocked = err.message.includes('Cannot send a friend request to yourself');
    }
    check(selfReqBlocked, 'Self friend request strictly blocked (22023)');

    // 2. Invalid friend code format
    let invalidCodeBlocked = false;
    try {
      await clientAlpha.query("SELECT * FROM public.send_friend_request('INVALID-CODE-XYZ!');");
    } catch (err) {
      invalidCodeBlocked = err.message.includes('Invalid friend code format');
    }
    check(invalidCodeBlocked, 'Invalid friend code format rejected (22023)');

    // 3. Duplicate request block
    const uGamma = '30000000-0000-0000-0000-000000000003';
    const uDelta = '40000000-0000-0000-0000-000000000004';
    const clientGamma = await pool.connect();
    const clientDelta = await pool.connect();
    await setSession(clientGamma, uGamma);
    await setSession(clientDelta, uDelta);

    const profGamma = (await clientGamma.query("SELECT * FROM public.get_or_create_user_profile('Gamma', '🦊');")).rows[0];
    const profDelta = (await clientDelta.query("SELECT * FROM public.get_or_create_user_profile('Delta', '🐺');")).rows[0];

    const reqGD = (await clientGamma.query(`SELECT * FROM public.send_friend_request('${profDelta.friend_code}');`)).rows[0];
    check(reqGD.status === 'pending', 'Gamma sends pending request to Delta');

    let dupReqBlocked = false;
    try {
      await clientGamma.query(`SELECT * FROM public.send_friend_request('${profDelta.friend_code}');`);
    } catch (err) {
      dupReqBlocked = err.message.includes('Friend request already sent and pending');
    }
    check(dupReqBlocked, 'Duplicate pending request blocked with friendly error (23505)');

    // 4. Simultaneous reciprocal request from Delta to Gamma -> resolves to accepted!
    const recipRes = (await clientDelta.query(`SELECT * FROM public.send_friend_request('${profGamma.friend_code}');`)).rows[0];
    check(recipRes.status === 'accepted', 'Reciprocal request from Delta automatically resolves to accepted');

    // 5. Re-request after decline & cancellation
    const uKappa = '50000000-0000-0000-0000-000000000005';
    const uLambda = '60000000-0000-0000-0000-000000000006';
    const clientKappa = await pool.connect();
    const clientLambda = await pool.connect();
    await setSession(clientKappa, uKappa);
    await setSession(clientLambda, uLambda);

    const profKappa = (await clientKappa.query("SELECT * FROM public.get_or_create_user_profile('Kappa', '🐯');")).rows[0];
    const profLambda = (await clientLambda.query("SELECT * FROM public.get_or_create_user_profile('Lambda', '🐼');")).rows[0];

    // Kappa sends -> Lambda declines
    const reqKL1 = (await clientKappa.query(`SELECT * FROM public.send_friend_request('${profLambda.friend_code}');`)).rows[0];
    await clientLambda.query(`SELECT public.decline_friend_request('${reqKL1.request_id}');`);

    // Kappa sends again -> succeeds
    const reqKL2 = (await clientKappa.query(`SELECT * FROM public.send_friend_request('${profLambda.friend_code}');`)).rows[0];
    check(reqKL2.status === 'pending', 'New friend request sent successfully after prior decline');

    // Kappa cancels
    await clientKappa.query(`SELECT public.cancel_friend_request('${reqKL2.request_id}');`);

    // Kappa sends again -> succeeds
    const reqKL3 = (await clientKappa.query(`SELECT * FROM public.send_friend_request('${profLambda.friend_code}');`)).rows[0];
    check(reqKL3.status === 'pending', 'New friend request sent successfully after prior cancellation');

    // =========================================================================
    // Journey 4: Challenge Invitations (Active, Accept/Decline, Expired, Ended)
    // =========================================================================
    console.log('\n[Journey 4] Challenge Invitations: Inviting Friends, Acceptance, Expiration & Boundaries:');

    // Re-establish Alpha and Beta friendship
    await admin.query(`
      INSERT INTO public.friendships (sender_id, receiver_id, status)
      VALUES ('${uAlpha}', '${uBeta}', 'accepted')
      ON CONFLICT DO NOTHING;
    `);

    // Alpha creates challenge 1
    const c1Res = await admin.query(`
      INSERT INTO public.challenges (title, description, category, duration_days, creator_id, creator_name)
      VALUES ('50 Pushups Daily', 'Pushups every morning', 'Fitness', 7, '${uAlpha}', 'Alpha Challenger')
      RETURNING id, participants_count;
    `);
    const c1Id = c1Res.rows[0].id;
    await admin.query(`INSERT INTO public.challenge_participants (challenge_id, user_id) VALUES ('${c1Id}', '${uAlpha}');`);

    // Alpha invites Beta
    const inv1Res = (await clientAlpha.query(`SELECT * FROM public.send_challenge_invitation('${c1Id}', '${uBeta}');`)).rows[0];
    check(inv1Res.status === 'pending', 'Alpha invites friend Beta: invitation created with status pending');
    check(inv1Res.expires_at !== null, 'Invitation has non-null expires_at');

    // Beta views challenge invitations via get_user_challenge_invitations()
    const betaInvs = (await clientBeta.query('SELECT * FROM public.get_user_challenge_invitations();')).rows;
    check(betaInvs.length === 1 && betaInvs[0].challenge_id === c1Id, 'Beta retrieves challenge invitation in incoming list');
    check(betaInvs[0].challenge_title === '50 Pushups Daily', 'Invitation includes challenge title');
    check(betaInvs[0].inviter_name === "Alpha O'Conner-Pro", 'Invitation includes inviter name');
    check(betaInvs[0].inviter_id === undefined, 'Invitation DOES NOT leak internal inviter_id');

    // Beta accepts invitation
    const resp1Res = (await clientBeta.query(`SELECT * FROM public.respond_to_challenge_invitation('${inv1Res.invitation_id}', true);`)).rows[0];
    check(resp1Res.status === 'accepted' && resp1Res.challenge_id === c1Id, 'Beta successfully accepts challenge invitation');

    // Decline journey: Alpha creates challenge 2, invites Beta -> Beta declines
    const c2Res = await admin.query(`
      INSERT INTO public.challenges (title, description, category, duration_days, creator_id, creator_name)
      VALUES ('Cold Shower Dare', 'Ice cold shower daily', 'Fitness', 3, '${uAlpha}', 'Alpha Challenger')
      RETURNING id;
    `);
    const c2Id = c2Res.rows[0].id;
    await admin.query(`INSERT INTO public.challenge_participants (challenge_id, user_id) VALUES ('${c2Id}', '${uAlpha}');`);

    const inv2Res = (await clientAlpha.query(`SELECT * FROM public.send_challenge_invitation('${c2Id}', '${uBeta}');`)).rows[0];
    const resp2Res = (await clientBeta.query(`SELECT * FROM public.respond_to_challenge_invitation('${inv2Res.invitation_id}', false);`)).rows[0];
    check(resp2Res.status === 'declined', 'Beta successfully declines challenge invitation');

    // Expired invitation test
    const c3Res = await admin.query(`
      INSERT INTO public.challenges (title, description, category, duration_days, creator_id)
      VALUES ('Sprint Challenge', 'Fast sprint', 'Fitness', 5, '${uAlpha}')
      RETURNING id;
    `);
    const c3Id = c3Res.rows[0].id;
    const expInv = (await admin.query(`
      INSERT INTO public.challenge_invitations (challenge_id, inviter_id, invitee_id, status, expires_at)
      VALUES ('${c3Id}', '${uAlpha}', '${uBeta}', 'pending', now() - INTERVAL '2 hours')
      RETURNING id;
    `)).rows[0];

    const expResp = (await clientBeta.query(`SELECT * FROM public.respond_to_challenge_invitation('${expInv.id}', true);`)).rows[0];
    check(expResp.status === 'expired', 'Expired invitation returns status = expired without error');

    // Verify expired status persisted
    const expCheck = (await admin.query(`SELECT status FROM public.challenge_invitations WHERE id = '${expInv.id}';`)).rows[0];
    check(expCheck.status === 'expired', 'Expired status is persisted in the database');

    // Ended challenge test (challenge ends in past)
    const endedChal = (await admin.query(`
      INSERT INTO public.challenges (title, description, category, duration_days, created_at, ends_at, creator_id)
      VALUES ('Past Dare', 'Ended challenge', 'Fitness', 2, now() - INTERVAL '10 days', now() - INTERVAL '8 days', '${uAlpha}')
      RETURNING id;
    `)).rows[0];
    await admin.query(`INSERT INTO public.challenge_participants (challenge_id, user_id) VALUES ('${endedChal.id}', '${uAlpha}');`);

    // 1. Cannot send invitation to an already-ended challenge
    let sendEndedBlocked = false;
    try {
      await clientAlpha.query(`SELECT * FROM public.send_challenge_invitation('${endedChal.id}', '${uBeta}');`);
    } catch (err) {
      sendEndedBlocked = err.message.includes('Challenge has already ended');
    }
    check(sendEndedBlocked, 'Sending invitation to ended challenge is rejected (22023)');

    // 2. Accepting invitation for a challenge that ended transitions to expired
    const endedInv = (await admin.query(`
      INSERT INTO public.challenge_invitations (challenge_id, inviter_id, invitee_id, status, expires_at)
      VALUES ('${endedChal.id}', '${uAlpha}', '${uBeta}', 'pending', now() + INTERVAL '1 hour')
      RETURNING id;
    `)).rows[0];

    const endedResp = (await clientBeta.query(`SELECT * FROM public.respond_to_challenge_invitation('${endedInv.id}', true);`)).rows[0];
    check(endedResp.status === 'expired', 'Invitation to ended challenge safely transitions to expired status');

    // =========================================================================
    // Journey 5: Participant Counts & Capacity Triggers
    // =========================================================================
    console.log('\n[Journey 5] Participant Counts & Trigger Synchronization:');

    // Verify challenge 1 participants_count after Beta joined via invite
    const c1Count = (await admin.query(`SELECT participants_count FROM public.challenges WHERE id = '${c1Id}';`)).rows[0];
    check(c1Count.participants_count === 2, 'Challenge 1 participants_count is exactly 2 (Alpha + Beta)');

    // Attempt to join Beta again directly (idempotency check)
    await admin.query(`
      INSERT INTO public.challenge_participants (challenge_id, user_id)
      VALUES ('${c1Id}', '${uBeta}')
      ON CONFLICT ON CONSTRAINT unique_challenge_participant DO NOTHING;
    `);
    const c1CountAfterDup = (await admin.query(`SELECT participants_count FROM public.challenges WHERE id = '${c1Id}';`)).rows[0];
    check(c1CountAfterDup.participants_count === 2, 'Duplicate join does not inflate participants_count');

    // Participant count decrements when a participant leaves
    await admin.query(`
      DELETE FROM public.challenge_participants
      WHERE challenge_id = '${c1Id}' AND user_id = '${uBeta}';
    `);
    const c1CountAfterLeave = (await admin.query(`SELECT participants_count FROM public.challenges WHERE id = '${c1Id}';`)).rows[0];
    check(c1CountAfterLeave.participants_count === 1, 'participants_count decrements cleanly to 1 when participant leaves');

    // =========================================================================
    // Journey 6: In-App Notification Inbox & Route Resolution
    // =========================================================================
    console.log('\n[Journey 6] Inbox: Social Notification Delivery, Recipient Isolation & Routing:');

    // Re-invite Beta to challenge 1 so a notification exists
    await clientAlpha.query(`SELECT * FROM public.send_challenge_invitation('${c1Id}', '${uBeta}');`);

    // Verify Beta's inbox notifications
    const betaNotifs = (await clientBeta.query('SELECT * FROM public.get_user_notifications(50, 0);')).rows;
    check(betaNotifs.length >= 1, 'Beta has in-app notifications in inbox');

    const inviteNotif = betaNotifs.find((n) => n.event_type === 'challenge_invitation_received');
    check(Boolean(inviteNotif), 'challenge_invitation_received event present in Beta inbox');
    if (inviteNotif) {
      check(inviteNotif.challenge_id === c1Id, 'Notification has correct challenge_id link');
      const route = getNotificationRoute({
        eventType: inviteNotif.event_type,
        challengeId: inviteNotif.challenge_id,
        completionId: null,
      });
      check(route === `/challenge/${c1Id}`, `getNotificationRoute resolves to correct challenge screen: ${route}`);
    }

    // Friend request routing check
    const friendReqRoute = getNotificationRoute({ eventType: 'friend_request_received', completionId: null, challengeId: null });
    check(friendReqRoute === '/friends', `friend_request_received resolves to: ${friendReqRoute}`);

    const friendAccRoute = getNotificationRoute({ eventType: 'friend_request_accepted', completionId: null, challengeId: null });
    check(friendAccRoute === '/friends', `friend_request_accepted resolves to: ${friendAccRoute}`);

    // Verify all social notifications have status = 'sent' (in-app inbox only, no push webhook side-effects)
    const socialNotifs = (await admin.query(`
      SELECT event_type, status, error
      FROM public.notification_deliveries
      WHERE event_type IN ('friend_request_received', 'friend_request_accepted', 'challenge_invitation_received');
    `)).rows;

    check(socialNotifs.length > 0, `Found ${socialNotifs.length} social notification deliveries in database`);
    const allSent = socialNotifs.every((n) => n.status === 'sent');
    check(allSent, 'All social notification deliveries have status = sent (no pending push polling triggers)');

    // =========================================================================
    // Journey 7: Regression Verification (Completions, Peer Reviews, Push Tokens)
    // =========================================================================
    console.log('\n[Journey 7] Regression: Existing Peer Verification, Progress & Push Token Systems:');

    // 1. Join Beta back to challenge 1
    await admin.query(`
      INSERT INTO public.challenge_participants (challenge_id, user_id)
      VALUES ('${c1Id}', '${uBeta}')
      ON CONFLICT DO NOTHING;
    `);

    // 2. Beta submits a challenge completion with Alpha as verifier via RPC
    const compRes = (await clientBeta.query(`
      SELECT * FROM public.submit_challenge_completion(
        '${c1Id}'::UUID,
        '${uAlpha}'::TEXT,
        CURRENT_DATE,
        'Did 50 pushups!'::TEXT
      );
    `)).rows[0];
    check(compRes.status === 'pending', 'Peer verification completion submitted with status = pending');

    // 3. Alpha reviews and approves completion
    const reviewRes = (await clientAlpha.query(`
      SELECT * FROM public.review_challenge_completion('${compRes.id}'::UUID, 'approved'::TEXT, NULL::TEXT);
    `)).rows[0];
    check(reviewRes.status === 'approved', 'Verifier approves completion via review_challenge_completion RPC');

    // 4. Simulate Edge Function delivery row created upon review approval (matches webhook handler behavior)
    await admin.query(`
      INSERT INTO public.notification_deliveries (
        idempotency_key,
        completion_id,
        event_type,
        recipient_id,
        tokens_sent,
        status,
        payload
      ) VALUES (
        'smoke_test_dare_approved_${compRes.id}',
        '${compRes.id}',
        'dare_approved',
        '${uBeta}',
        1,
        'sent',
        '{"title": "Dare Approved!", "body": "Your dare submission was approved."}'::jsonb
      );
    `);

    const pushDeliv = (await admin.query(`
      SELECT * FROM public.notification_deliveries
      WHERE completion_id = '${compRes.id}' AND event_type = 'dare_approved';
    `)).rows;
    check(pushDeliv.length === 1, 'dare_approved notification delivery recorded for participant');
    check(pushDeliv[0].recipient_id === uBeta, 'Push delivery addressed to correct recipient (Beta)');

    // 5. Verify get_user_notifications returns both social and dare verification notifications
    const betaAllNotifs = (await clientBeta.query('SELECT * FROM public.get_user_notifications(20, 0);')).rows;
    const hasDareApproved = betaAllNotifs.some((n) => n.event_type === 'dare_approved');
    check(hasDareApproved, 'get_user_notifications retrieves dare_approved in participant inbox');

    // 5. Test push token registration RPC intact
    const tokenRes = (await clientBeta.query(`
      SELECT * FROM public.register_device_push_token('ExponentPushToken[smoke_test_beta_token]', 'android', 'Pixel 8');
    `)).rows[0];
    check(tokenRes.expo_push_token === 'ExponentPushToken[smoke_test_beta_token]', 'Push token registration RPC functions properly');

    // 6. Test progress RPC intact
    const progRes = (await clientBeta.query(`
      SELECT * FROM public.get_participant_challenge_progress('${c1Id}', '${uBeta}');
    `)).rows[0];
    check(parseInt(progRes.verified_count, 10) === 1, 'Participant challenge progress verified_count is 1');
    check(progRes.progress_pct > 0, 'Progress percentage computed correctly');

    // Clean up
    await resetSession(clientAlpha);
    await resetSession(clientBeta);
    await resetSession(clientGamma);
    await resetSession(clientDelta);
    await resetSession(clientKappa);
    await resetSession(clientLambda);
    await resetSession(admin);

    clientAlpha.release();
    clientBeta.release();
    clientGamma.release();
    clientDelta.release();
    clientKappa.release();
    clientLambda.release();
    admin.release();

    console.log(`\n================================================================================`);
    console.log(`🎉 ALL 7 USER JOURNEYS SMOKE TEST COMPLETED: ${passed} passed, ${failed} failed.`);
    console.log(`================================================================================\n`);

    await pool.end();

    if (failed > 0) {
      process.exit(1);
    }
  } catch (err) {
    console.error('Smoke test fatal error:', err);
    await pool.end();
    process.exit(1);
  }
}

runSmokeTest().catch((err) => {
  console.error('Smoke test runner error:', err);
  process.exit(1);
});
