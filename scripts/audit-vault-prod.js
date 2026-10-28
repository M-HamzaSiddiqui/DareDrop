// scripts/audit-vault-prod.js
// Read-only audit of Supabase Vault, trigger definitions, and permissions on production project uyglmszjkkfjeckpwpab
// STRICT RESTRICTIONS:
// - Read-only SELECT queries on system catalogs
// - NEVER query or print secret values

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function getProductionDbConfig() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) throw new Error('.env file not found');

  const content = fs.readFileSync(envPath, 'utf8');
  let rawUrl = null;
  for (const line of content.split('\n')) {
    if (line.trim().startsWith('DATABASE_URL=')) {
      rawUrl = line.split('=')[1].trim().replace(/^['"]|['"]$/g, '');
      break;
    }
  }

  if (!rawUrl) throw new Error('DATABASE_URL not found in .env');

  const parsed = new URL(rawUrl);
  const refMatch = parsed.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co/);
  const projectRef = refMatch ? refMatch[1] : null;

  if (projectRef !== 'uyglmszjkkfjeckpwpab') {
    throw new Error(`Target project ref mismatch: expected uyglmszjkkfjeckpwpab, got ${projectRef}`);
  }

  const host = 'aws-0-ap-south-1.pooler.supabase.com';
  const port = '5432';
  const username = `postgres.${projectRef}`;
  const password = decodeURIComponent(parsed.password);
  const database = 'postgres';

  return { host, port, username, password, database, projectRef };
}

async function runAudit() {
  const config = getProductionDbConfig();
  console.log(`Connecting read-only to ${config.projectRef} via pooler ${config.host}:${config.port}...`);

  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.username,
    password: config.password,
    database: config.database,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log('✅ Connected successfully to PostgreSQL.\n');

  try {
    // 1. Check extensions (supabase_vault, pgsodium, pg_net)
    console.log('=== [1] Installed Extensions Audit ===');
    const extRes = await client.query(`
      SELECT extname, extversion, nspname AS schema_name
      FROM pg_extension e
      JOIN pg_namespace n ON e.extnamespace = n.oid
      WHERE extname IN ('vault', 'supabase_vault', 'pgsodium', 'pg_net')
      ORDER BY extname;
    `);
    console.table(extRes.rows);

    // 2. Check Vault Schema and Objects
    console.log('\n=== [2] Vault Objects and Tables Audit ===');
    const vaultTablesRes = await client.query(`
      SELECT table_schema, table_name, table_type
      FROM information_schema.tables
      WHERE table_schema = 'vault'
      ORDER BY table_name;
    `);
    console.table(vaultTablesRes.rows);

    // 3. Check existing Vault Secret metadata (STRICTLY NO SECRET VALUES)
    console.log('\n=== [3] Existing Vault Secrets (Metadata Only: Names & Descriptions) ===');
    let vaultSecrets = [];
    try {
      const secretsRes = await client.query(`
        SELECT id, name, description, created_at, updated_at
        FROM vault.secrets
        ORDER BY created_at;
      `);
      vaultSecrets = secretsRes.rows;
      console.log(`Total secrets found in vault.secrets: ${vaultSecrets.length}`);
      if (vaultSecrets.length > 0) {
        console.table(vaultSecrets.map(s => ({
          id: s.id,
          name: s.name,
          description: s.description,
          created_at: s.created_at,
          updated_at: s.updated_at,
        })));
      } else {
        console.log('No secrets currently exist in vault.secrets.');
      }
    } catch (vaultErr) {
      console.log('Note on vault.secrets query:', vaultErr.message);
    }

    // 4. Check exact triggers on challenge_completions
    console.log('\n=== [4] Triggers on public.challenge_completions ===');
    const trigRes = await client.query(`
      SELECT
        t.tgname AS trigger_name,
        pg_get_triggerdef(t.oid) AS trigger_definition
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE n.nspname = 'public' AND c.relname = 'challenge_completions' AND NOT t.tgisinternal;
    `);
    for (const r of trigRes.rows) {
      console.log(`Trigger: ${r.trigger_name}`);
      // Sanitize any secret value from display
      const sanitizedDef = r.trigger_definition.replace(
        /("x-webhook-secret":")[^"]+(")/g,
        '$1[REDACTED_SECRET]$2'
      );
      console.log(`Definition: ${sanitizedDef}\n`);
    }

    // 5. Check permissions on vault schema and decrypted_secrets view
    console.log('=== [5] Permissions Audit on Vault & Net ===');
    const permRes = await client.query(`
      SELECT
        grantee, table_schema, table_name, privilege_type
      FROM information_schema.table_privileges
      WHERE table_schema = 'vault' AND table_name IN ('secrets', 'decrypted_secrets')
      ORDER BY table_name, grantee;
    `);
    console.table(permRes.rows);

    // Check function permissions for net.http_post
    const netPermRes = await client.query(`
      SELECT
        p.proname,
        n.nspname AS schema_name,
        pg_catalog.pg_get_function_identity_arguments(p.oid) AS args,
        p.prosecdef AS is_security_definer,
        r.rolname AS owner
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      JOIN pg_roles r ON p.proowner = r.oid
      WHERE n.nspname IN ('net', 'supabase_functions', 'vault')
        AND p.proname IN ('http_post', 'http_request', 'create_secret')
      ORDER BY n.nspname, p.proname;
    `);
    console.table(netPermRes.rows);

    // 6. Check if any other database objects or tables contain the webhook secret
    console.log('\n=== [6] Inspection for other occurrences of send-push-notification ===');
    const otherTrigs = await client.query(`
      SELECT
        t.tgname, c.relname, n.nspname
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE pg_get_triggerdef(t.oid) LIKE '%send-push-notification%'
        AND t.tgname != 'send_push_notification_on_challenge_completion';
    `);
    console.log(`Other triggers calling send-push-notification: ${otherTrigs.rows.length}`);

  } finally {
    await client.end();
  }
}

runAudit().catch(err => {
  console.error('Audit failed:', err.message);
  process.exit(1);
});
