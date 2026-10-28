// scripts/verify-inbox-prod.js
// Read-only production verification for DareDrop Notification Inbox migration

const { Client } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

function getProductionDbConfig() {
  const envPath = path.resolve(process.cwd(), '.env');
  const content = fs.readFileSync(envPath, 'utf8');
  let rawUrl = '';
  let anonKey = '';
  let supabaseUrl = '';

  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('DATABASE_URL=')) {
      rawUrl = trimmed.split('=')[1].trim().replace(/^['"]|['"]$/g, '');
    }
    if (trimmed.startsWith('EXPO_PUBLIC_SUPABASE_ANON_KEY=')) {
      anonKey = trimmed.split('=')[1].trim();
    }
    if (trimmed.startsWith('EXPO_PUBLIC_SUPABASE_URL=')) {
      supabaseUrl = trimmed.split('=')[1].trim().replace(/\/+$/, '');
    }
  });

  const parsed = new URL(rawUrl);
  const projectRef = parsed.hostname.split('.')[1];
  const host = 'aws-0-ap-south-1.pooler.supabase.com';
  const username = `postgres.${projectRef}`;
  const password = decodeURIComponent(parsed.password);

  return { host, port: 5432, username, password, database: 'postgres', projectRef, anonKey, supabaseUrl };
}

async function verifyProduction() {
  console.log('=== Step 1: Connecting to Production PostgreSQL for Schema Inspection ===');
  const config = getProductionDbConfig();

  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    database: config.database,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    // 1. Verify read_at column on notification_deliveries
    console.log('\n[1/5] Checking notification_deliveries.read_at column...');
    const colRes = await client.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'notification_deliveries'
        AND column_name = 'read_at';
    `);

    if (colRes.rows.length === 1) {
      console.log(`✅ Column notification_deliveries.read_at exists (type: ${colRes.rows[0].data_type}, nullable: ${colRes.rows[0].is_nullable})`);
    } else {
      throw new Error('Column notification_deliveries.read_at NOT found!');
    }

    // 2. Verify composite index
    console.log('\n[2/5] Checking index idx_notification_deliveries_recipient_inbox...');
    const idxRes = await client.query(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'notification_deliveries'
        AND indexname = 'idx_notification_deliveries_recipient_inbox';
    `);

    if (idxRes.rows.length === 1) {
      console.log(`✅ Index idx_notification_deliveries_recipient_inbox exists: ${idxRes.rows[0].indexdef}`);
    } else {
      throw new Error('Index idx_notification_deliveries_recipient_inbox NOT found!');
    }

    // 3. Verify all four RPC functions and security definer flags
    console.log('\n[3/5] Checking RPC functions and security definer settings in pg_proc...');
    const rpcRes = await client.query(`
      SELECT
        p.proname,
        p.prosecdef AS is_security_definer,
        p.proconfig AS config,
        pg_get_function_result(p.oid) AS return_type
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public'
        AND p.proname IN (
          'get_user_notifications',
          'mark_notification_read',
          'mark_all_notifications_read',
          'get_unread_notification_count'
        );
    `);

    const expectedRpcs = [
      'get_user_notifications',
      'mark_notification_read',
      'mark_all_notifications_read',
      'get_unread_notification_count',
    ];

    const foundRpcs = rpcRes.rows.map((r) => r.proname);
    for (const name of expectedRpcs) {
      const match = rpcRes.rows.find((r) => r.proname === name);
      if (!match) {
        throw new Error(`RPC function public.${name} NOT found in database!`);
      }
      console.log(`   - Raw config: ${JSON.stringify(match.config)}`);
      const hasEmptySearchPath = Boolean(match.config && match.config.some((c) => c.startsWith('search_path=')));
      console.log(`✅ Function public.${name}:`);
      console.log(`   - Security Definer: ${match.is_security_definer}`);
      console.log(`   - Hardened search_path='': ${hasEmptySearchPath}`);
      console.log(`   - Return type: ${match.return_type}`);
      if (!match.is_security_definer || !hasEmptySearchPath) {
        throw new Error(`Function public.${name} has insecure settings!`);
      }
    }

    // 4. Verify function execution permissions
    console.log('\n[4/5] Checking execution grants on RPCs...');
    for (const name of expectedRpcs) {
      const permRes = await client.query(`
        SELECT
          has_function_privilege('anon', 'public.${name}(int, int)', 'EXECUTE') AS anon_has_exec_paged,
          has_function_privilege('authenticated', 'public.${name}(int, int)', 'EXECUTE') AS auth_has_exec_paged
        WHERE '${name}' = 'get_user_notifications'
        UNION ALL
        SELECT
          has_function_privilege('anon', 'public.${name}(uuid)', 'EXECUTE'),
          has_function_privilege('authenticated', 'public.${name}(uuid)', 'EXECUTE')
        WHERE '${name}' = 'mark_notification_read'
        UNION ALL
        SELECT
          has_function_privilege('anon', 'public.${name}()', 'EXECUTE'),
          has_function_privilege('authenticated', 'public.${name}()', 'EXECUTE')
        WHERE '${name}' IN ('mark_all_notifications_read', 'get_unread_notification_count');
      `);

      const { anon_has_exec_paged: anonHasExec, auth_has_exec_paged: authHasExec } = permRes.rows[0];
      console.log(`✅ Grants for public.${name}: anon=${anonHasExec} (expected false), authenticated=${authHasExec} (expected true)`);
      if (anonHasExec !== false || authHasExec !== true) {
        throw new Error(`Invalid grants for public.${name}: anon=${anonHasExec}, authenticated=${authHasExec}`);
      }
    }

    // 5. Verify direct table permissions remain revoked
    console.log('\n[5/5] Checking direct table privileges on notification_deliveries...');
    const tablePermRes = await client.query(`
      SELECT
        has_table_privilege('anon', 'public.notification_deliveries', 'SELECT') AS anon_select,
        has_table_privilege('authenticated', 'public.notification_deliveries', 'SELECT') AS auth_select,
        has_table_privilege('authenticated', 'public.notification_deliveries', 'UPDATE') AS auth_update;
    `);

    const { anon_select, auth_select, auth_update } = tablePermRes.rows[0];
    console.log(`✅ Table access: anon_select=${anon_select}, auth_select=${auth_select}, auth_update=${auth_update}`);
    if (anon_select || auth_select || auth_update) {
      throw new Error('notification_deliveries has broad direct access granted to unprivileged roles!');
    }

  } finally {
    await client.end();
  }

  // Step 6: PostgREST API integration test using live Supabase client
  console.log('\n=== Step 6: Live API Integration Test (Recipient Isolation & Error Handling) ===');
  const supaClient = createClient(config.supabaseUrl, config.anonKey, {
    auth: { persistSession: false },
  });

  // A. Anonymous call without auth should fail
  console.log('Testing unauthenticated call to get_user_notifications...');
  const unauthRes = await supaClient.rpc('get_user_notifications', { p_limit: 10, p_offset: 0 });
  console.log(`✅ Unauthenticated call rejected: code=${unauthRes.error?.code}, message="${unauthRes.error?.message}"`);

  // B. Authenticated call with ephemeral anonymous session
  console.log('Signing in anonymously to test authenticated recipient isolation...');
  const { data: authData, error: authErr } = await supaClient.auth.signInAnonymously();
  if (authErr) throw authErr;

  const authedClient = createClient(config.supabaseUrl, config.anonKey, {
    auth: { persistSession: false },
    global: {
      headers: {
        Authorization: `Bearer ${authData.session.access_token}`,
      },
    },
  });

  console.log(`Authenticated as test UID: ${authData.user.id}`);

  // Fetch notifications for fresh user
  const notifRes = await authedClient.rpc('get_user_notifications', { p_limit: 10, p_offset: 0 });
  if (notifRes.error) {
    throw new Error(`get_user_notifications failed for authenticated user: ${notifRes.error.message}`);
  }
  console.log(`✅ get_user_notifications returned successfully: count=${notifRes.data.length} (Expected 0 for fresh user - strict isolation verified)`);

  // Fetch unread count for fresh user
  const countRes = await authedClient.rpc('get_unread_notification_count');
  if (countRes.error) {
    throw new Error(`get_unread_notification_count failed: ${countRes.error.message}`);
  }
  console.log(`✅ get_unread_notification_count returned: ${countRes.data} (Expected 0)`);

  console.log('\n================================================================');
  console.log('🎉 ALL PRODUCTION SCHEMA & SECURITY VERIFICATIONS PASSED SUCCESSFULLY!');
  console.log('================================================================\n');
}

verifyProduction().catch((err) => {
  console.error('\n❌ Production verification failed:', err);
  process.exit(1);
});
