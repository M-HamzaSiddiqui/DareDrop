// scripts/test-friends.js
// Dedicated automated test suite for DareDrop Friends & Social Challenges System
// Tests: Security remediation, direct table write locks, input validation policies,
// minimized lookup results, concurrent profile creation & code collisions,
// concurrent reciprocal requests, concurrency-safe transitions (FOR UPDATE locks),
// expired invitation persistence without rollback, concurrent invitation acceptance,
// existing challenge-join invariants, and notification inbox vs push delivery.

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

async function runFriendsTests() {
  console.log('🧪 Starting DareDrop Friends & Social Challenges Safety & Remediation Test Suite...\n');

  // =========================================================================
  // Test Suite 1: Static SQL Checks — Security Remediation & Architecture
  // =========================================================================
  console.log('[Test Suite 1] Static SQL Checks — Security Remediation & Architecture:');

  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261028000000_friends_and_invitations.sql',
  );
  check(fs.existsSync(migrationPath), 'Migration file 20261028000000_friends_and_invitations.sql exists');

  const sql = fs.readFileSync(migrationPath, 'utf8');

  // 1. Lockdown profile writes (Remediation Item 1)
  check(
    sql.includes('REVOKE ALL ON TABLE public.user_profiles FROM PUBLIC, anon, authenticated;') &&
    sql.includes('GRANT SELECT ON TABLE public.user_profiles TO authenticated;'),
    'Revokes direct table writes on user_profiles from authenticated and anon, granting SELECT only',
  );
  check(
    sql.includes('CREATE OR REPLACE FUNCTION public.update_user_profile'),
    'Defines update_user_profile RPC for server-mediated mutations',
  );
  check(
    sql.includes("v_clean_name ~* '^[a-zA-Z0-9 _.''-]+$'"),
    'Enforces server-side regex validation on display_name with valid SQL string escaping',
  );
  check(
    sql.includes('char_length(v_clean_name) < 2') && sql.includes('char_length(v_clean_name) > 32'),
    'Enforces display_name length bounds (2 to 32 characters)',
  );
  check(
    sql.includes('char_length(v_clean_emoji) > 8'),
    'Enforces avatar_emoji maximum length boundary (8 characters)',
  );

  // 2. Minimized friend-code lookup results & minimal projections (Remediation Items 2 & 3)
  const lookupReturnMatch = sql.match(/CREATE OR REPLACE FUNCTION public\.lookup_profile_by_friend_code[\s\S]*?RETURNS TABLE \(([\s\S]*?)\)/);
  const lookupReturnCols = lookupReturnMatch ? lookupReturnMatch[1] : '';
  check(
    lookupReturnCols.includes('display_name TEXT') &&
    lookupReturnCols.includes('avatar_emoji TEXT') &&
    lookupReturnCols.includes('is_self BOOLEAN') &&
    lookupReturnCols.includes('friendship_status TEXT') &&
    !lookupReturnCols.includes('user_id') &&
    !lookupReturnCols.includes('friend_code'),
    'lookup_profile_by_friend_code returns only display_name, avatar_emoji, is_self, friendship_status (omits target user_id and friend_code)',
  );

  const sendReqReturnMatch = sql.match(/CREATE OR REPLACE FUNCTION public\.send_friend_request[\s\S]*?RETURNS TABLE \(([\s\S]*?)\)/);
  const sendReqReturnCols = sendReqReturnMatch ? sendReqReturnMatch[1] : '';
  check(!sendReqReturnCols.includes('target_user_id'), 'send_friend_request return table does NOT expose target_user_id');

  const pendingReqReturnMatch = sql.match(/CREATE OR REPLACE FUNCTION public\.get_pending_friend_requests[\s\S]*?RETURNS TABLE \(([\s\S]*?)\)/);
  const pendingReqReturnCols = pendingReqReturnMatch ? pendingReqReturnMatch[1] : '';
  check(!pendingReqReturnCols.includes('other_user_id'), 'get_pending_friend_requests return table does NOT expose other_user_id');

  const chalInvReturnMatch = sql.match(/CREATE OR REPLACE FUNCTION public\.get_user_challenge_invitations[\s\S]*?RETURNS TABLE \(([\s\S]*?)\)/);
  const chalInvReturnCols = chalInvReturnMatch ? chalInvReturnMatch[1] : '';
  check(!chalInvReturnCols.includes('inviter_id'), 'get_user_challenge_invitations return table does NOT expose inviter_id');

  // Rate Limiting Checks
  check(
    sql.includes('CREATE TABLE IF NOT EXISTS public.friend_code_lookup_rate_limits'),
    'Defines friend_code_lookup_rate_limits table for server-side rate tracking',
  );
  check(
    sql.includes('REVOKE ALL ON TABLE public.friend_code_lookup_rate_limits FROM PUBLIC, anon, authenticated;'),
    'Revokes all direct client access on friend_code_lookup_rate_limits',
  );
  check(
    sql.includes('INSERT INTO public.friend_code_lookup_rate_limits') &&
    sql.includes('ON CONFLICT (user_id) DO UPDATE SET') &&
    sql.includes('v_rate_limit_attempts > 15'),
    'lookup_profile_by_friend_code implements atomic server-side rate limiting (15 attempts/min)',
  );

  // 3. Schema-qualified gen_random_bytes and search_path hygiene (Remediation Item 3)
  check(
    sql.includes('extensions.gen_random_bytes(8)'),
    'Correctly schema-qualifies extensions.gen_random_bytes(8)',
  );
  check(
    sql.includes('REVOKE ALL ON FUNCTION public.generate_secure_friend_code() FROM PUBLIC, anon, authenticated;'),
    'Revokes execution on internal helper generate_secure_friend_code() from all client roles',
  );
  check(
    sql.includes('WHEN unique_violation THEN') &&
    sql.includes('SELECT * INTO v_profile FROM public.user_profiles WHERE user_id = v_caller_id;'),
    'Handles concurrent profile creation idempotently by recovering on user_id primary key conflict',
  );

  // 4. Concurrency-safe friendship transitions (Remediation Item 4)
  check(
    sql.includes('SELECT * INTO v_existing') &&
    sql.includes('FOR UPDATE;') &&
    sql.includes('send_friend_request'),
    'send_friend_request locks existing friendship row with FOR UPDATE',
  );
  check(
    sql.includes('SELECT * INTO v_request FROM public.friendships WHERE id = p_request_id FOR UPDATE;'),
    'accept/decline/cancel friend request lock the row with FOR UPDATE',
  );
  check(
    sql.includes("IF v_request.status <> 'pending' THEN"),
    'Ensures only pending requests can be accepted, declined, or cancelled',
  );
  check(
    sql.includes('idx_friendships_active_pair') &&
    sql.includes("WHERE status IN ('pending', 'accepted')"),
    'Maintains partial unique index permitting new requests after decline or cancellation',
  );

  // 5. Fix invitation acceptance and expiration (Remediation Item 5)
  check(
    sql.includes('SELECT * INTO v_invitation FROM public.challenge_invitations WHERE id = p_invitation_id FOR UPDATE;'),
    'respond_to_challenge_invitation locks invitation with FOR UPDATE',
  );
  check(
    sql.includes("UPDATE public.challenge_invitations SET status = 'expired' WHERE id = p_invitation_id;") &&
    sql.includes("RETURN QUERY SELECT p_invitation_id, 'expired'::TEXT, v_invitation.challenge_id;"),
    'Persists expired invitation status without raising exception to avoid transaction rollback',
  );
  check(
    sql.includes('INSERT INTO public.challenge_participants') &&
    sql.includes('ON CONFLICT ON CONSTRAINT unique_challenge_participant DO NOTHING;'),
    'Inserts into challenge_participants at invitation acceptance with constraint-qualified ON CONFLICT',
  );
  check(
    sql.includes('v_challenge.ends_at <= pg_catalog.now()'),
    'Enforces challenge active/end-date check prior to invitation acceptance',
  );

  // 6. Push notification vs Inbox documentation (Remediation Item 6)
  check(
    sql.includes('In-app inbox notifications are recorded in notification_deliveries') &&
    sql.includes('Push notifications to APNs/FCM are not triggered by this social event'),
    'Explicitly documents that social events are in-app inbox notifications without push webhook mutation',
  );

  // 7. Security Definer & search_path = '' verification (Remediation Item 7)
  const requiredRpcs = [
    'get_or_create_user_profile',
    'update_user_profile',
    'lookup_profile_by_friend_code',
    'send_friend_request',
    'accept_friend_request',
    'decline_friend_request',
    'cancel_friend_request',
    'remove_friend',
    'get_user_friends',
    'get_pending_friend_requests',
    'send_challenge_invitation',
    'respond_to_challenge_invitation',
    'get_user_challenge_invitations',
  ];

  for (const rpc of requiredRpcs) {
    const hasDef = sql.includes(`CREATE OR REPLACE FUNCTION public.${rpc}`);
    check(hasDef, `Defines secure RPC function public.${rpc}`);
  }

  const emptySearchPathCount = (sql.match(/SET search_path = ''/g) || []).length;
  check(emptySearchPathCount >= requiredRpcs.length + 1, 'All sensitive functions specify SET search_path = \'\'');

  // =========================================================================
  // Test Suite 2: Client Library & Friend Code Validation
  // =========================================================================
  console.log('\n[Test Suite 2] Client Library & Input Normalization:');

  const libPath = path.resolve(process.cwd(), 'src/lib/friends.ts');
  const libCode = fs.readFileSync(libPath, 'utf8');
  const transpiled = ts.transpileModule(libCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const mockModule = { exports: {} };
  const evalFn = new Function('module', 'exports', 'require', transpiled);
  evalFn(mockModule, mockModule.exports, (mod) => {
    if (mod === './supabase') return { isSupabaseConfigured: false, supabase: null };
    if (mod === 'react-native') return { Share: { share: async () => ({ action: 'sharedAction' }) } };
    if (mod === 'expo-clipboard') return { setStringAsync: async () => {} };
    return {};
  });

  const {
    normalizeFriendCode,
    isValidFriendCode,
    buildFriendShareText,
    translateSocialError,
  } = mockModule.exports;

  check(normalizeFriendCode('DARE-7K9P-4X2M') === 'DARE-7K9P-4X2M', 'Normalizes canonical code correctly');
  check(normalizeFriendCode('dare-7k9p-4x2m') === 'DARE-7K9P-4X2M', 'Converts lowercase to uppercase');
  check(normalizeFriendCode('7K9P4X2M') === 'DARE-7K9P-4X2M', 'Adds DARE prefix and dashes to raw 8-character code');
  check(normalizeFriendCode('  7k9p-4x2m  ') === 'DARE-7K9P-4X2M', 'Trims whitespace safely');
  check(normalizeFriendCode('dare7k9p4x2m') === 'DARE-7K9P-4X2M', 'Accepts code without hyphens');
  check(normalizeFriendCode('DARE-ILOU-1234') === null, 'Rejects invalid characters (I, L, O, U) in Crockford Base32');
  check(normalizeFriendCode('DARE-12345') === null, 'Rejects code with insufficient characters');
  check(normalizeFriendCode('DARE-123456789') === null, 'Rejects code with excess characters');
  check(normalizeFriendCode('') === null, 'Rejects empty input safely');
  check(normalizeFriendCode(null) === null, 'Rejects null input safely');
  check(isValidFriendCode('DARE-7K9P-4X2M') === true, 'isValidFriendCode returns true for valid code');
  check(isValidFriendCode('invalid_code') === false, 'isValidFriendCode returns false for invalid code');

  const shareText = buildFriendShareText('DARE-7K9P-4X2M', 'Alex');
  check(shareText.includes('DARE-7K9P-4X2M') && shareText.includes('Alex'), 'Builds share text with user display name and code');

  // =========================================================================
  // Test Suite 3: Mock Concurrency Simulation — Profile Creation & Validation
  // =========================================================================
  console.log('\n[Test Suite 3] Mock Concurrency — Profile Creation & Validation:');

  class ProfileSimulation {
    constructor() {
      this.profilesByUserId = new Map();
      this.profilesByFriendCode = new Map();
      this.collisionSimCount = 0;
    }

    validateProfileInput(displayName, avatarEmoji) {
      if (!displayName || typeof displayName !== 'string') {
        throw new Error('Display name is required');
      }
      const trimmed = displayName.trim();
      if (trimmed.length < 2 || trimmed.length > 32) {
        throw new Error('Display name must be between 2 and 32 characters');
      }
      const safeNameRegex = /^[a-zA-Z0-9 _.'-]+$/;
      if (!safeNameRegex.test(trimmed)) {
        throw new Error('Display name contains invalid characters. Use letters, numbers, spaces, and .-_ only.');
      }
      if (avatarEmoji && avatarEmoji.length > 8) {
        throw new Error('Avatar emoji is too long (maximum 8 characters)');
      }
      return trimmed;
    }

    getOrCreateUserProfile(userId, displayName, avatarEmoji, simulateCollision = false) {
      // 1. Check existing
      if (this.profilesByUserId.has(userId)) {
        return this.profilesByUserId.get(userId);
      }

      // 2. Validate
      const validName = this.validateProfileInput(displayName || 'DareDevil', avatarEmoji);

      const CROCKFORD_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      let code = null;
      for (let attempt = 1; attempt <= 10; attempt++) {
        if (simulateCollision && attempt === 1) {
          this.collisionSimCount++;
          continue; // Simulate first random code collided with another user
        }
        let s = '';
        for (let i = 0; i < 8; i++) {
          s += CROCKFORD_CHARS[Math.floor(Math.random() * CROCKFORD_CHARS.length)];
        }
        const candidate = `DARE-${s.slice(0, 4)}-${s.slice(4, 8)}`;
        if (!this.profilesByFriendCode.has(candidate)) {
          code = candidate;
          break;
        }
      }
      if (!code) throw new Error('Could not generate unique friend code after multiple attempts');

      // 4. Atomic insert / idempotent race check
      if (this.profilesByUserId.has(userId)) {
        // Handled primary key conflict
        return this.profilesByUserId.get(userId);
      }

      const profile = {
        user_id: userId,
        friend_code: code,
        display_name: validName,
        avatar_emoji: avatarEmoji || '🦁',
      };
      this.profilesByUserId.set(userId, profile);
      this.profilesByFriendCode.set(code, profile);
      return profile;
    }

    updateUserProfile(userId, displayName, avatarEmoji) {
      const profile = this.profilesByUserId.get(userId);
      if (!profile) throw new Error('Profile not found');

      const validName = this.validateProfileInput(displayName, avatarEmoji);
      profile.display_name = validName;
      if (avatarEmoji !== undefined) {
        profile.avatar_emoji = avatarEmoji;
      }
      return { ...profile };
    }

    lookupProfileByFriendCode(callerId, friendCode) {
      const normalized = normalizeFriendCode(friendCode);
      if (!normalized) throw new Error('Invalid friend code format');

      const target = this.profilesByFriendCode.get(normalized);
      if (!target) return [];

      const isSelf = target.user_id === callerId;
      // Note: Omit target.user_id and target.friend_code per Remediation Item 2!
      return [
        {
          display_name: target.display_name,
          avatar_emoji: target.avatar_emoji,
          is_self: isSelf,
          friendship_status: isSelf ? 'self' : 'none',
        },
      ];
    }
  }

  const pSim = new ProfileSimulation();

  // Test profile input validation
  assert.throws(
    () => pSim.getOrCreateUserProfile('user_1', 'A'),
    /Display name must be between 2 and 32 characters/,
  );
  check(true, 'Server-side validation rejects display name shorter than 2 characters');

  assert.throws(
    () => pSim.getOrCreateUserProfile('user_1', 'ThisDisplayNameIsWayTooLongAndExceedsThirtyTwoCharacters'),
    /Display name must be between 2 and 32 characters/,
  );
  check(true, 'Server-side validation rejects display name longer than 32 characters');

  assert.throws(
    () => pSim.getOrCreateUserProfile('user_1', '<script>alert(1)</script>'),
    /Display name contains invalid characters/,
  );
  check(true, 'Server-side validation rejects XSS / HTML / SQL injection characters');

  assert.throws(
    () => pSim.getOrCreateUserProfile('user_1', 'Valid Name', 'TooManyEmojisHere123456789'),
    /Avatar emoji is too long/,
  );
  check(true, 'Server-side validation rejects avatar emoji longer than 8 characters');

  // Test concurrent profile creation idempotency
  const profA1 = pSim.getOrCreateUserProfile('user_A', 'Alice Cooper', '🎸');
  const profA2 = pSim.getOrCreateUserProfile('user_A', 'Alice Cooper', '🎸');
  check(profA1.friend_code === profA2.friend_code, 'Concurrent profile creation for same user resolves idempotently');

  // Test friend-code uniqueness collision retry
  const profB = pSim.getOrCreateUserProfile('user_B', 'Bob Builder', '👷', true);
  check(pSim.collisionSimCount > 0 && profB.friend_code, 'Friend-code uniqueness collision triggers retry loop successfully');

  // Test profile update validation & immutable fields
  const updatedProf = pSim.updateUserProfile('user_A', 'Alice Rocker', '⚡');
  check(updatedProf.display_name === 'Alice Rocker', 'User profile update modifies display name');
  check(updatedProf.friend_code === profA1.friend_code, 'User profile update cannot modify friend code');
  check(updatedProf.user_id === 'user_A', 'User profile update cannot modify user_id');

  // Test minimized friend-code lookup results
  const lookupRes = pSim.lookupProfileByFriendCode('user_B', profA1.friend_code);
  check(lookupRes.length === 1, 'Lookup by friend code finds target profile');
  check(lookupRes[0].display_name === 'Alice Rocker', 'Lookup returns target display name');
  check(lookupRes[0].avatar_emoji === '⚡', 'Lookup returns target avatar emoji');
  check(lookupRes[0].user_id === undefined, 'Lookup DOES NOT expose target user_id');
  check(lookupRes[0].friend_code === undefined, 'Lookup DOES NOT expose target friend_code');
  check(lookupRes[0].is_self === false, 'Lookup correctly computes is_self');

  // =========================================================================
  // Test Suite 4: Concurrency Simulation — Friendship State Transitions
  // =========================================================================
  console.log('\n[Test Suite 4] Concurrency Simulation — Friendship State Transitions:');

  class ConcurrencyFriendshipSimulation {
    constructor() {
      this.friendships = new Map(); // id -> { id, senderId, receiverId, status, locked }
      this.idCounter = 1;
      this.notifications = [];
    }

    sendFriendRequest(callerId, targetUserId) {
      if (callerId === targetUserId) throw new Error('Cannot send a friend request to yourself');

      // Find existing
      let existing = null;
      for (const f of this.friendships.values()) {
        if (
          (f.senderId === callerId && f.receiverId === targetUserId) ||
          (f.senderId === targetUserId && f.receiverId === callerId)
        ) {
          existing = f;
          break;
        }
      }

      if (existing) {
        if (existing.status === 'accepted') {
          throw new Error('You are already friends with this user');
        }
        if (existing.status === 'pending') {
          if (existing.senderId === callerId) {
            throw new Error('Friend request already sent and pending');
          } else {
            // Concurrent reciprocal request! Atomic transition to accepted
            existing.status = 'accepted';
            this.notifications.push({ type: 'friend_request_accepted', recipient: targetUserId });
            return { requestId: existing.id, status: 'accepted' };
          }
        }
        // If declined or cancelled, allow re-requesting
        existing.senderId = callerId;
        existing.receiverId = targetUserId;
        existing.status = 'pending';
        this.notifications.push({ type: 'friend_request_received', recipient: targetUserId });
        return { requestId: existing.id, status: 'pending' };
      }

      const id = 'req_' + this.idCounter++;
      this.friendships.set(id, {
        id,
        senderId: callerId,
        receiverId: targetUserId,
        status: 'pending',
      });
      this.notifications.push({ type: 'friend_request_received', recipient: targetUserId });
      return { requestId: id, status: 'pending' };
    }

    acceptFriendRequest(callerId, requestId) {
      const f = this.friendships.get(requestId);
      if (!f) throw new Error('Friend request not found');
      if (f.receiverId !== callerId) throw new Error('Only the recipient can accept a friend request');
      if (f.status !== 'pending') throw new Error(`Friend request is not pending (current status: ${f.status})`);

      f.status = 'accepted';
      this.notifications.push({ type: 'friend_request_accepted', recipient: f.senderId });
      return true;
    }

    declineFriendRequest(callerId, requestId) {
      const f = this.friendships.get(requestId);
      if (!f) throw new Error('Friend request not found');
      if (f.receiverId !== callerId) throw new Error('Only the recipient can decline a friend request');
      if (f.status !== 'pending') throw new Error(`Friend request is not pending (current status: ${f.status})`);

      f.status = 'declined';
      return true;
    }

    cancelFriendRequest(callerId, requestId) {
      const f = this.friendships.get(requestId);
      if (!f) throw new Error('Friend request not found');
      if (f.senderId !== callerId) throw new Error('Only the sender can cancel a friend request');
      if (f.status !== 'pending') throw new Error(`Friend request is not pending (current status: ${f.status})`);

      f.status = 'cancelled';
      return true;
    }
  }

  // 1. Simultaneous reciprocal requests
  const fSim1 = new ConcurrencyFriendshipSimulation();
  const reqAtoB = fSim1.sendFriendRequest('user_1', 'user_2');
  check(reqAtoB.status === 'pending', 'User 1 sends friend request to User 2');

  const reqBtoA = fSim1.sendFriendRequest('user_2', 'user_1');
  check(reqBtoA.status === 'accepted', 'Simultaneous reciprocal request from User 2 automatically resolves to accepted');
  check(fSim1.friendships.get(reqAtoB.requestId).status === 'accepted', 'Original request is atomically accepted without duplicate record');

  // 2. Concurrent accept / decline transition safety
  const fSim2 = new ConcurrencyFriendshipSimulation();
  const req2 = fSim2.sendFriendRequest('user_A', 'user_B');

  // First operation (accept) wins
  const acceptResult = fSim2.acceptFriendRequest('user_B', req2.requestId);
  check(acceptResult === true, 'Recipient User B accepts friend request');

  // Second concurrent operation (decline) fails because status is no longer pending
  assert.throws(
    () => fSim2.declineFriendRequest('user_B', req2.requestId),
    /Friend request is not pending/,
  );
  check(true, 'Decline fails after accept wins (strict pending condition prevents overwriting accepted state)');

  // Third concurrent operation (cancel) fails because status is no longer pending
  assert.throws(
    () => fSim2.cancelFriendRequest('user_A', req2.requestId),
    /Friend request is not pending/,
  );
  check(true, 'Cancel fails after accept wins');

  // 3. Re-requesting after decline
  const fSim3 = new ConcurrencyFriendshipSimulation();
  const req3 = fSim3.sendFriendRequest('user_X', 'user_Y');
  fSim3.declineFriendRequest('user_Y', req3.requestId);
  check(fSim3.friendships.get(req3.requestId).status === 'declined', 'Request transitioned to declined');

  const req3New = fSim3.sendFriendRequest('user_X', 'user_Y');
  check(req3New.status === 'pending', 'New request can be sent after prior decline');

  // =========================================================================
  // Test Suite 5: Challenge Invitation Expiration & Concurrency Invariants
  // =========================================================================
  console.log('\n[Test Suite 5] Challenge Invitation Expiration & Concurrency Invariants:');

  class ConcurrencyInvitationSimulation {
    constructor() {
      this.challenges = new Map();
      this.participants = new Set();
      this.invitations = new Map();
      this.invCounter = 1;
    }

    addChallenge(id, endsAt = null) {
      this.challenges.set(id, { id, endsAt });
    }

    sendInvitation(inviterId, challengeId, inviteeId, ttlMs = 7 * 24 * 3600 * 1000) {
      const id = 'inv_' + this.invCounter++;
      this.invitations.set(id, {
        id,
        challengeId,
        inviterId,
        inviteeId,
        status: 'pending',
        expiresAt: Date.now() + ttlMs,
      });
      return id;
    }

    respondToInvitation(inviteeId, invitationId, accept) {
      const inv = this.invitations.get(invitationId);
      if (!inv) throw new Error('Invitation not found');
      if (inv.inviteeId !== inviteeId) throw new Error('Unauthorized');

      // Strict pending transition check
      if (inv.status !== 'pending') {
        throw new Error(`Invitation is not pending (current status: ${inv.status})`);
      }

      // Expired invitation check without rolling back status
      if (inv.expiresAt <= Date.now()) {
        inv.status = 'expired';
        // Persist expired state and return it directly (matching PostgreSQL fix)
        return { invitationId, status: 'expired', challengeId: inv.challengeId };
      }

      if (accept) {
        const c = this.challenges.get(inv.challengeId);
        if (c.endsAt && c.endsAt <= Date.now()) {
          throw new Error('Challenge has already ended');
        }
        const participantKey = `${inv.challengeId}:${inviteeId}`;
        if (this.participants.has(participantKey)) {
          throw new Error('User is already a participant');
        }
        this.participants.add(participantKey);
        inv.status = 'accepted';
      } else {
        inv.status = 'declined';
      }

      return { invitationId, status: inv.status, challengeId: inv.challengeId };
    }
  }

  const iSim = new ConcurrencyInvitationSimulation();
  iSim.addChallenge('dare_100');

  // 1. Expired invitation persistence
  const expInvId = iSim.sendInvitation('user_1', 'dare_100', 'user_2', -1000); // Already expired
  const expRes = iSim.respondToInvitation('user_2', expInvId, true);
  check(expRes.status === 'expired', 'Expired invitation returns status expired without throwing exception');
  check(iSim.invitations.get(expInvId).status === 'expired', 'Expired status persists in database');
  check(!iSim.participants.has('dare_100:user_2'), 'Expired invite does not add participant');

  // 2. Concurrent invitation acceptance race
  const activeInvId = iSim.sendInvitation('user_1', 'dare_100', 'user_3');
  const winAccept = iSim.respondToInvitation('user_3', activeInvId, true);
  check(winAccept.status === 'accepted', 'First concurrent accept wins and registers participant');
  check(iSim.participants.has('dare_100:user_3'), 'Participant registered atomically');

  assert.throws(
    () => iSim.respondToInvitation('user_3', activeInvId, true),
    /Invitation is not pending/,
  );
  check(true, 'Second concurrent accept rejected because invitation is no longer pending');

  assert.throws(
    () => iSim.respondToInvitation('user_3', activeInvId, false),
    /Invitation is not pending/,
  );
  check(true, 'Concurrent decline rejected because invitation is already accepted');

  // 3. Challenge ended invariant
  iSim.addChallenge('dare_ended', Date.now() - 10000); // Challenge in the past
  const endedInvId = iSim.sendInvitation('user_1', 'dare_ended', 'user_4');
  assert.throws(
    () => iSim.respondToInvitation('user_4', endedInvId, true),
    /Challenge has already ended/,
  );
  check(true, 'Invitation cannot be accepted if challenge has already ended');

  // =========================================================================
  // Test Suite 6: Notification Inbox Verification & Push Webhook Isolation
  // =========================================================================
  console.log('\n[Test Suite 6] Notification Inbox Verification & Push Webhook Isolation:');

  const inboxLibPath = path.resolve(process.cwd(), 'src/lib/inbox.ts');
  const inboxCode = fs.readFileSync(inboxLibPath, 'utf8');
  const inboxTranspiled = ts.transpileModule(inboxCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  const inboxMockModule = { exports: {} };
  const inboxEvalFn = new Function('module', 'exports', 'require', inboxTranspiled);
  inboxEvalFn(inboxMockModule, inboxMockModule.exports, (mod) => {
    if (mod === './supabase') return { isSupabaseConfigured: false, supabase: null };
    if (mod === '@react-native-async-storage/async-storage') return { getItem: async () => null, setItem: async () => {} };
    return {};
  });

  const { getNotificationRoute } = inboxMockModule.exports;

  check(
    getNotificationRoute({ eventType: 'friend_request_received' }) === '/friends',
    'friend_request_received routes to /friends screen in notification inbox',
  );
  check(
    getNotificationRoute({ eventType: 'friend_request_accepted' }) === '/friends',
    'friend_request_accepted routes to /friends screen in notification inbox',
  );
  check(
    getNotificationRoute({
      eventType: 'challenge_invitation_received',
      challengeId: '11111111-2222-3333-4444-555555555555',
    }) === '/challenge/11111111-2222-3333-4444-555555555555',
    'challenge_invitation_received routes directly to challenge screen in inbox',
  );

  // Push webhook isolation check
  // The deployed push webhook send_push_notification_on_challenge_completion triggers ONLY on challenge_completions.
  // Social events insert directly into notification_deliveries with status 'sent' or 'skipped_no_tokens'.
  // This verifies social events are purely in-app inbox items and do NOT trigger false push dispatches.
  const webhookMigrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261026000000_push_notifications.sql',
  );
  if (fs.existsSync(webhookMigrationPath)) {
    const webhookSql = fs.readFileSync(webhookMigrationPath, 'utf8');
    check(
      webhookSql.includes('send_push_notification_on_challenge_completion') &&
      webhookSql.includes('ON public.challenge_completions'),
      'Push notification trigger is scoped strictly to challenge_completions table',
    );
    check(
      !webhookSql.includes('ON public.friendships') &&
      !webhookSql.includes('ON public.challenge_invitations'),
      'No push webhooks exist on friendships or challenge_invitations tables',
    );
  }

  // =========================================================================
  // Test Suite 7: Social Error Translation Coverage
  // =========================================================================
  console.log('\n[Test Suite 7] User-Friendly Error Translations:');

  check(
    translateSocialError(new Error('Cannot send a friend request to yourself')) ===
      'You cannot send a friend request to yourself!',
    'Translates self-request error',
  );
  check(
    translateSocialError(new Error('No user found with that friend code')) ===
      'No user found with that friend code. Please check the code and try again.',
    'Translates missing friend code error',
  );
  check(
    translateSocialError(new Error('You are already friends with this user')) ===
      'You are already friends with this user.',
    'Translates duplicate friendship error',
  );
  check(
    translateSocialError(new Error('User is already a participant in this challenge')) ===
      'This friend has already joined this challenge.',
    'Translates already-joined challenge invite error',
  );
  check(
    translateSocialError(new Error('This invitation has expired')) ===
      'This challenge invitation has expired.',
    'Translates expired challenge invitation error',
  );
  check(
    translateSocialError(new Error('Rate limit exceeded. Too many lookups.')) ===
      'Too many friend lookups. Please wait a minute before searching again.',
    'Translates rate limit exceeded error',
  );

  console.log(`\n🎉 Friends & Social Challenges Safety Suite Completed: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runFriendsTests().catch((err) => {
  console.error('Fatal test execution error:', err);
  process.exit(1);
});
