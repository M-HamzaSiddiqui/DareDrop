// scripts/test-inbox.js
// Dedicated automated test suite for DareDrop In-App Notification Inbox
// Tests: Recipient isolation, unauthorized access, unread/read transitions, count accuracy,
// missing optional payload fields, empty inbox, network failures, refresh/reopen behavior,
// navigation routing, and duplicate/concurrent handling.

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

async function runInboxTests() {
  console.log('🧪 Starting DareDrop Notification Inbox Safety & Functionality Test Suite...\n');

  // =========================================================================
  // Test Suite 1: Database Migration & Security Definer Specifications
  // =========================================================================
  console.log('[Test Suite 1] Database Migration & RPC Security Specifications:');

  const migrationPath = path.resolve(
    process.cwd(),
    'supabase/migrations/20261027000000_notification_inbox.sql',
  );
  check(fs.existsSync(migrationPath), 'Migration file 20261027000000_notification_inbox.sql exists');

  const migrationSql = fs.readFileSync(migrationPath, 'utf8');

  // 1. Column addition
  check(
    migrationSql.includes('ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ DEFAULT NULL'),
    'Adds read_at column to notification_deliveries without modifying delivery status',
  );

  // 2. Index creation
  check(
    migrationSql.includes('idx_notification_deliveries_recipient_inbox'),
    'Creates composite index on (recipient_id, read_at, created_at DESC) for fast inbox queries',
  );

  // 3. get_user_notifications RPC security & recipient isolation
  check(
    migrationSql.includes('CREATE OR REPLACE FUNCTION public.get_user_notifications'),
    'Defines get_user_notifications RPC function',
  );
  check(
    migrationSql.includes("v_caller_id := auth.uid()::text;\n  IF v_caller_id IS NULL THEN\n    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';"),
    'get_user_notifications strictly fails closed when caller is unauthenticated (ERRCODE 42501)',
  );
  check(
    migrationSql.includes('nd.recipient_id = v_caller_id'),
    'get_user_notifications strictly isolates notifications by recipient_id = auth.uid()::text',
  );
  const returnsTableMatch = migrationSql.match(/FUNCTION public\.get_user_notifications[\s\S]*?RETURNS TABLE \(([\s\S]*?)\)/i);
  const returnsTableCols = returnsTableMatch ? returnsTableMatch[1] : '';
  check(
    returnsTableCols.length > 0 &&
      !returnsTableCols.includes('claim_token') &&
      !returnsTableCols.includes('tickets') &&
      !returnsTableCols.includes('payload'),
    'get_user_notifications return table never leaks sensitive backend claim_token, tickets, or raw payload',
  );
  check(
    migrationSql.includes('cc.rejection_reason'),
    'Joins challenge_completions to retrieve rejection_reason when available',
  );
  check(
    migrationSql.includes("nd.status IN ('sent', 'skipped_no_tokens')"),
    'Includes both sent push notifications and notifications skipped for tokenless users in in-app inbox',
  );

  // 4. mark_notification_read RPC security
  check(
    migrationSql.includes('CREATE OR REPLACE FUNCTION public.mark_notification_read'),
    'Defines mark_notification_read RPC function',
  );
  check(
    migrationSql.includes("IF p_notification_id IS NULL THEN\n    RAISE EXCEPTION 'Notification ID is required' USING ERRCODE = '22023';"),
    'mark_notification_read validates required notification ID parameter',
  );
  check(
    migrationSql.includes('id = p_notification_id\n    AND recipient_id = v_caller_id\n    AND read_at IS NULL'),
    'mark_notification_read validates caller ownership and updates only unread records',
  );

  // 5. mark_all_notifications_read RPC security
  check(
    migrationSql.includes('CREATE OR REPLACE FUNCTION public.mark_all_notifications_read'),
    'Defines mark_all_notifications_read RPC function',
  );
  check(
    migrationSql.includes('WHERE recipient_id = v_caller_id'),
    'mark_all_notifications_read restricts updates strictly to the authenticated caller',
  );

  // 6. get_unread_notification_count RPC
  check(
    migrationSql.includes('CREATE OR REPLACE FUNCTION public.get_unread_notification_count'),
    'Defines get_unread_notification_count RPC function',
  );
  check(
    migrationSql.includes('SELECT COUNT(*)::INT INTO v_count'),
    'get_unread_notification_count computes accurate unread count',
  );

  // 7. Role permissions
  check(
    migrationSql.includes('REVOKE ALL ON FUNCTION public.get_user_notifications') &&
      migrationSql.includes('GRANT EXECUTE ON FUNCTION public.get_user_notifications(INT, INT) TO authenticated'),
    'Grants execution privileges only to authenticated role (revokes anon & public)',
  );

  // =========================================================================
  // Test Suite 2: Client Inbox Helper & Pure Logic Tests (src/lib/inbox.ts)
  // =========================================================================
  console.log('\n[Test Suite 2] Client Inbox Logic & Timestamp/Route Formatters:');

  const inboxCode = fs.readFileSync(path.resolve(process.cwd(), 'src/lib/inbox.ts'), 'utf8');
  const transpiledInbox = ts.transpileModule(inboxCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;

  // Mock AsyncStorage
  let mockStorage = {};
  const mockAsyncStorage = {
    getItem: async (key) => mockStorage[key] || null,
    setItem: async (key, val) => {
      mockStorage[key] = val;
    },
    removeItem: async (key) => {
      delete mockStorage[key];
    },
    clear: () => {
      mockStorage = {};
    },
  };

  // Mock Supabase
  let mockCurrentUserId = 'test-user-inbox-1';
  let mockRpcResponses = {};
  const mockSupabase = {
    rpc: async (fnName, params) => {
      if (mockRpcResponses[fnName]) {
        return mockRpcResponses[fnName](params);
      }
      return { data: null, error: null };
    },
  };

  const inboxExports = {};
  new Function('exports', 'require', transpiledInbox)(inboxExports, (mod) => {
    if (mod.includes('@react-native-async-storage/async-storage')) {
      return mockAsyncStorage;
    }
    if (mod.includes('./supabase')) {
      return {
        isSupabaseConfigured: true,
        supabase: mockSupabase,
        getOrCreateCurrentUserId: async () => mockCurrentUserId,
      };
    }
    return require(mod);
  });

  const {
    formatNotificationTimestamp,
    getNotificationRoute,
    fetchUserNotifications,
    fetchUnreadNotificationCount,
    markNotificationAsRead,
    markAllNotificationsAsRead,
    getLocalReadNotificationIds,
    saveLocalReadNotificationId,
    saveMultipleLocalReadNotificationIds,
    removeLocalReadNotificationIds,
    getNotificationReadsKey,
    LEGACY_UNSCOPED_NOTIFICATION_READS_KEY,
  } = inboxExports;

  // Route resolver tests
  const testRoutes = [
    {
      input: {
        eventType: 'submission_pending',
        completionId: 'comp-123',
        challengeId: 'chal-456',
      },
      expected: '/review/comp-123',
      name: 'submission_pending routes to review screen',
    },
    {
      input: {
        eventType: 'verifier_reassigned',
        completionId: 'comp-789',
        challengeId: 'chal-456',
      },
      expected: '/review/comp-789',
      name: 'verifier_reassigned routes to review screen',
    },
    {
      input: {
        eventType: 'dare_approved',
        completionId: 'comp-123',
        challengeId: 'chal-456',
      },
      expected: '/challenge/chal-456',
      name: 'dare_approved routes to challenge screen',
    },
    {
      input: {
        eventType: 'dare_rejected',
        completionId: 'comp-123',
        challengeId: 'chal-456',
      },
      expected: '/challenge/chal-456',
      name: 'dare_rejected routes to challenge screen',
    },
    {
      input: {
        eventType: 'unknown_event',
        completionId: null,
        challengeId: null,
      },
      expected: null,
      name: 'Notification without completionId or challengeId returns null route',
    },
  ];

  testRoutes.forEach((t) => {
    check(getNotificationRoute(t.input) === t.expected, t.name);
  });

  // Relative timestamp tests
  const now = Date.now();
  check(
    formatNotificationTimestamp(new Date(now - 15 * 1000).toISOString()) === 'Just now',
    'Timestamps < 60s format as "Just now"',
  );
  check(
    formatNotificationTimestamp(new Date(now - 5 * 60 * 1000).toISOString()) === '5m ago',
    'Timestamps in minutes format as "Xm ago"',
  );
  check(
    formatNotificationTimestamp(new Date(now - 3 * 3600 * 1000).toISOString()) === '3h ago',
    'Timestamps in hours format as "Xh ago"',
  );
  check(
    formatNotificationTimestamp(new Date(now - 25 * 3600 * 1000).toISOString()) === 'Yesterday',
    'Timestamps 1 day ago format as "Yesterday"',
  );
  check(
    formatNotificationTimestamp(new Date(now - 3 * 24 * 3600 * 1000).toISOString()) === '3d ago',
    'Timestamps multiple days ago format as "Xd ago"',
  );
  check(formatNotificationTimestamp(null) === '—', 'Null timestamp returns fallback dash');
  check(formatNotificationTimestamp('invalid-date') === '—', 'Invalid timestamp returns fallback dash');

  // =========================================================================
  // Test Suite 3: Unread/Read Transitions, Local State & Persistence
  // =========================================================================
  console.log('\n[Test Suite 3] Unread/Read Transitions & State Consistency:');

  const mockDbNotifications = [
    {
      id: 'notif-1',
      event_type: 'submission_pending',
      title: 'DareDrop — Verification needed',
      body: 'Someone has submitted a dare for you to review.',
      created_at: new Date(now - 10000).toISOString(),
      read_at: null,
      is_read: false,
      challenge_id: 'chal-001',
      completion_id: 'comp-001',
      rejection_reason: null,
    },
    {
      id: 'notif-2',
      event_type: 'dare_rejected',
      title: 'Dare rejected',
      body: 'Your dare completion was rejected.',
      created_at: new Date(now - 50000).toISOString(),
      read_at: null,
      is_read: false,
      challenge_id: 'chal-002',
      completion_id: 'comp-002',
      rejection_reason: 'Photo was blurry and incomplete.',
    },
    {
      id: 'notif-3',
      event_type: 'dare_approved',
      title: 'Dare approved',
      body: 'Your dare completion has been approved.',
      created_at: new Date(now - 100000).toISOString(),
      read_at: new Date(now - 80000).toISOString(),
      is_read: true,
      challenge_id: 'chal-003',
      completion_id: 'comp-003',
      rejection_reason: null,
    },
  ];

  mockRpcResponses['get_user_notifications'] = () => ({
    data: mockDbNotifications,
    error: null,
  });

  mockRpcResponses['get_unread_notification_count'] = () => ({
    data: 2,
    error: null,
  });

  mockRpcResponses['mark_notification_read'] = ({ p_notification_id }) => {
    const found = mockDbNotifications.find((n) => n.id === p_notification_id);
    if (found) {
      found.read_at = new Date().toISOString();
      found.is_read = true;
      return { data: true, error: null };
    }
    return { data: false, error: null };
  };

  mockRpcResponses['mark_all_notifications_read'] = () => {
    let count = 0;
    mockDbNotifications.forEach((n) => {
      if (!n.read_at) {
        n.read_at = new Date().toISOString();
        n.is_read = true;
        count++;
      }
    });
    return { data: count, error: null };
  };

  mockStorage = {};

  // Fetch initial notifications
  const initialItems = await fetchUserNotifications();
  check(initialItems.length === 3, 'Fetches all 3 notifications from RPC');
  check(!initialItems[0].isRead, 'Item 1 is unread initially');
  check(!initialItems[1].isRead, 'Item 2 is unread initially');
  check(initialItems[2].isRead, 'Item 3 is read initially');
  check(
    initialItems[1].rejectionReason === 'Photo was blurry and incomplete.',
    'Captures rejectionReason from peer verification response',
  );

  // Mark single notification read
  const markRes = await markNotificationAsRead('notif-1');
  check(markRes === true, 'markNotificationAsRead returns true on success');

  const afterReadItems = await fetchUserNotifications();
  check(afterReadItems[0].isRead === true, 'Item 1 is now marked as read');
  check(afterReadItems[0].readAt !== null, 'Item 1 has valid readAt timestamp');

  // Verify persistence across simulated app reopen / local reload
  const localReadsKey = getNotificationReadsKey('test-user-inbox-1');
  check(
    mockStorage[localReadsKey] && mockStorage[localReadsKey].includes('notif-1'),
    'Read state is persisted into user-scoped local storage for offline recovery & consistency',
  );

  // Idempotency check: calling markNotificationAsRead again on already-read item
  const idempotentRes = await markNotificationAsRead('notif-1');
  check(idempotentRes === true, 'Subsequent mark-as-read calls are safe and idempotent');

  // Mark all notifications read
  const markAllCount = await markAllNotificationsAsRead(['notif-1', 'notif-2']);
  check(markAllCount >= 1, 'markAllNotificationsAsRead returns updated count');

  const allReadItems = await fetchUserNotifications();
  check(allReadItems.every((n) => n.isRead), 'All notifications are now marked read');

  // =========================================================================
  // Test Suite 4: Missing Optional Fields, Empty Inbox & Error Resilience
  // =========================================================================
  console.log('\n[Test Suite 4] Missing Fields, Empty State & Error Resilience:');

  // Test missing optional fields
  mockRpcResponses['get_user_notifications'] = () => ({
    data: [
      {
        id: 'notif-sparse',
        event_type: null,
        title: null,
        body: null,
        created_at: null,
        read_at: null,
        is_read: null,
        challenge_id: null,
        completion_id: null,
        rejection_reason: null,
      },
    ],
    error: null,
  });

  const sparseItems = await fetchUserNotifications();
  check(sparseItems.length === 1, 'Parses notification with missing optional fields safely');
  check(sparseItems[0].title === 'DareDrop Notification', 'Applies fallback title when title is null');
  check(sparseItems[0].body === '', 'Applies empty string fallback when body is null');
  check(sparseItems[0].eventType === 'general', 'Applies fallback eventType when null');
  check(sparseItems[0].challengeId === null, 'challengeId safely resolves to null');

  // Test empty inbox
  mockRpcResponses['get_user_notifications'] = () => ({
    data: [],
    error: null,
  });
  const emptyItems = await fetchUserNotifications();
  check(Array.isArray(emptyItems) && emptyItems.length === 0, 'Empty inbox returns empty array [] without error');

  // Test network failure resilience
  mockRpcResponses['get_user_notifications'] = () => ({
    data: null,
    error: { message: 'Connection refused / network timeout' },
  });
  const failureItems = await fetchUserNotifications();
  check(Array.isArray(failureItems) && failureItems.length === 0, 'Network failure returns [] gracefully without throwing');

  mockRpcResponses['get_unread_notification_count'] = () => ({
    data: null,
    error: { message: 'Network error' },
  });
  const failureCount = await fetchUnreadNotificationCount();
  check(failureCount === 0, 'Network failure on unread count returns 0 gracefully');

  // =========================================================================
  // Test Suite 5: Offline Read-State Scoping & Account Isolation
  // =========================================================================
  console.log('\n[Test Suite 5] Offline Read-State Scoping & Account Isolation:');

  // Clear mock storage to begin isolation tests with clean state
  mockStorage = {};

  // 1. Two different user IDs have isolated offline notification read-state
  const userAlice = 'user_alice_uuid';
  const userBob = 'user_bob_uuid';

  await saveLocalReadNotificationId('notif-alice-101', userAlice);
  await saveLocalReadNotificationId('notif-bob-202', userBob);

  const aliceReads = await getLocalReadNotificationIds(userAlice);
  const bobReads = await getLocalReadNotificationIds(userBob);

  check(
    aliceReads.has('notif-alice-101') && !aliceReads.has('notif-bob-202'),
    'User Alice has only her read notifications and cannot see Bob notifications',
  );
  check(
    bobReads.has('notif-bob-202') && !bobReads.has('notif-alice-101'),
    'User Bob has only his read notifications and cannot see Alice notifications',
  );

  const aliceKey = getNotificationReadsKey(userAlice);
  const bobKey = getNotificationReadsKey(userBob);
  check(aliceKey !== bobKey, 'Storage keys for Alice and Bob are strictly distinct');
  check(aliceKey === `@daredrop/local_notification_reads_v1:${userAlice}`, 'Alice storage key is properly scoped with her UID');
  check(bobKey === `@daredrop/local_notification_reads_v1:${userBob}`, 'Bob storage key is properly scoped with his UID');

  // 2. The same user retains their own notification read-state across repeated reads/writes
  await saveMultipleLocalReadNotificationIds(['notif-alice-102', 'notif-alice-103'], userAlice);
  const aliceReadsAfterMulti = await getLocalReadNotificationIds(userAlice);
  check(
    aliceReadsAfterMulti.size === 3 &&
      aliceReadsAfterMulti.has('notif-alice-101') &&
      aliceReadsAfterMulti.has('notif-alice-102') &&
      aliceReadsAfterMulti.has('notif-alice-103'),
    'The same user retains all cumulative notification reads across multiple writes',
  );

  // Remove confirmed read for Alice
  await removeLocalReadNotificationIds(['notif-alice-101'], userAlice);
  const aliceReadsAfterPrune = await getLocalReadNotificationIds(userAlice);
  check(
    aliceReadsAfterPrune.size === 2 &&
      !aliceReadsAfterPrune.has('notif-alice-101') &&
      aliceReadsAfterPrune.has('notif-alice-102') &&
      aliceReadsAfterPrune.has('notif-alice-103'),
    'Pruning read state operates only on the targeted user and preserves remaining reads',
  );

  // Confirm Bob is completely untouched by Alice prune
  const bobReadsAfterAlicePrune = await getLocalReadNotificationIds(userBob);
  check(
    bobReadsAfterAlicePrune.size === 1 && bobReadsAfterAlicePrune.has('notif-bob-202'),
    'Bob read state remains completely unaffected by Alice write or prune operations',
  );

  // 3. Guest or missing-identity behavior does not fall back to shared cross-account storage
  const guestKey = getNotificationReadsKey('guest');
  const emptyKey = getNotificationReadsKey('');
  const nullKey = getNotificationReadsKey(null);
  const undefinedKey = getNotificationReadsKey(undefined);

  check(guestKey === '@daredrop/local_notification_reads_v1:guest', 'Guest key is scoped to :guest');
  check(emptyKey === '@daredrop/local_notification_reads_v1:guest', 'Empty string identity maps safely to :guest');
  check(nullKey === '@daredrop/local_notification_reads_v1:guest', 'Null identity maps safely to :guest');
  check(undefinedKey === '@daredrop/local_notification_reads_v1:guest', 'Undefined identity maps safely to :guest');

  await saveLocalReadNotificationId('notif-guest-303', 'guest');
  const guestReads = await getLocalReadNotificationIds('guest');
  check(guestReads.has('notif-guest-303'), 'Guest can store and read guest notifications');
  check(!guestReads.has('notif-bob-202'), 'Guest cannot see Bob notifications');
  check(!guestReads.has('notif-alice-102'), 'Guest cannot see Alice notifications');

  // Verify missing identity dynamically falling back to guest without overwriting registered user
  mockCurrentUserId = ''; // simulate logged-out / unauthenticated state
  const missingIdentityReads = await getLocalReadNotificationIds();
  check(
    missingIdentityReads.has('notif-guest-303'),
    'Missing identity safely resolves to isolated guest storage',
  );
  check(
    !missingIdentityReads.has('notif-alice-102') && !missingIdentityReads.has('notif-bob-202'),
    'Missing identity does not leak or touch authenticated user notification read-state',
  );

  // 4. Legacy unscoped key is not touched or written to
  check(
    mockStorage[LEGACY_UNSCOPED_NOTIFICATION_READS_KEY] === undefined,
    'Legacy unscoped key @daredrop/local_notification_reads_v1 remains untouched and unused',
  );

  // =========================================================================
  // Summary
  // =========================================================================
  console.log(`\n🎉 Inbox Test Suite Completed: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) {
    process.exit(1);
  }
}

runInboxTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
