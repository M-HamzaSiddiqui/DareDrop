// Safe Supabase Verification Script
// Run with: node scripts/verify-supabase.js

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

function getEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    console.error('❌ .env file not found in project root.');
    process.exit(1);
  }
  const content = fs.readFileSync(envPath, 'utf8');
  let url = '';
  let key = '';
  content.split('\n').forEach((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('EXPO_PUBLIC_SUPABASE_URL=')) {
      url = trimmed.split('=')[1].trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
    }
    if (trimmed.startsWith('EXPO_PUBLIC_SUPABASE_ANON_KEY=')) {
      key = trimmed.split('=')[1].trim();
    }
  });
  return { url, key };
}

async function verify() {
  const { url, key } = getEnv();

  console.log('--- DareDrop Supabase Verification ---');
  try {
    const parsed = new URL(url);
    console.log(`📡 Connecting to host: ${parsed.host}`);
  } catch {
    console.error('❌ Invalid EXPO_PUBLIC_SUPABASE_URL');
    return;
  }

  const client = createClient(url, key, {
    auth: { persistSession: false },
    realtime: { transport: class Dummy {} },
  });

  // 1. Check challenges table
  console.log('\n[1/3] Checking challenges table...');
  const cRes = await client.from('challenges').select('id, title, category, duration_days, created_at').limit(1);
  if (cRes.error) {
    console.log(`❌ challenges table: ${cRes.error.message} (code: ${cRes.error.code})`);
  } else {
    console.log(`✅ challenges table exists and is accessible! (Current row count: ${cRes.data.length})`);
  }

  // 2. Check challenge_participants table
  console.log('\n[2/3] Checking challenge_participants table...');
  const pRes = await client.from('challenge_participants').select('id, challenge_id, user_id, joined_at').limit(1);
  if (pRes.error) {
    console.log(`❌ challenge_participants table: ${pRes.error.message} (code: ${pRes.error.code})`);
  } else {
    console.log(`✅ challenge_participants table exists and is accessible! (Current row count: ${pRes.data.length})`);
  }

  // 3. Check Anonymous Auth
  console.log('\n[3/3] Checking Anonymous Sign-in...');
  const authRes = await client.auth.signInAnonymously();
  if (authRes.error) {
    console.log(`⚠️ Anonymous auth: ${authRes.error.message}`);
    console.log('   Tip: In Supabase Dashboard -> Authentication -> Providers -> Anonymous, toggle "Enable Anonymous sign-ins" to ON.');
  } else {
    console.log(`✅ Anonymous auth is enabled! (Assigned user ID: ${authRes.data.user.id})`);
  }

  console.log('\n----------------------------------------');
  if (!cRes.error && !pRes.error) {
    console.log('🎉 ALL DATABASE TABLES ARE READY FOR PRODUCTION!');
  } else {
    console.log('⏳ Tables not detected yet. Please run the SQL migration in Supabase Dashboard -> SQL Editor.');
  }
}

verify().catch((err) => {
  console.error('Fatal error during verification:', err);
});
