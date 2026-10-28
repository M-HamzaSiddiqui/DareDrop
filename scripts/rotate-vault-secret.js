// scripts/rotate-vault-secret.js
// Secure, Parameterized Supabase Vault Secret Update Tool
// Updates "push_webhook_secret" in vault.secrets using the supported vault.update_secret() API.
//
// Security Guarantees:
// 1. Reads secret strictly from environment variable or stdin pipe (never CLI arguments).
// 2. Secret is NEVER printed, logged, written to files, or emitted in error messages.
// 3. Executes parameterized query ($1) via node-postgres — zero SQL interpolation.
// 4. Emits only metadata verification (id, name, updated_at).

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

function getConnectionString() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL.trim();
  }
  const candidatePaths = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), 'supabase/.env'),
  ];
  for (const envPath of candidatePaths) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('DATABASE_URL=')) {
          return trimmed.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
        }
      }
    }
  }
  return null;
}

async function readSecretFromStdin() {
  if (process.env.NEW_VAULT_SECRET) {
    return process.env.NEW_VAULT_SECRET.trim();
  }
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      const trimmed = data.trim();
      if (!trimmed) {
        reject(new Error('No secret received on stdin or NEW_VAULT_SECRET env var'));
      } else {
        resolve(trimmed);
      }
    });
  });
}

async function connectWithFallback(connStr) {
  const isLocal = connStr.includes('127.0.0.1') || connStr.includes('localhost') || connStr.startsWith('/');
  let directClient = null;
  try {
    directClient = new Client({
      connectionString: connStr,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000,
    });
    await directClient.connect();
    return directClient;
  } catch (err) {
    if (directClient) {
      await directClient.end().catch(() => {});
    }
    if (!isLocal && (err.message.includes('ENETUNREACH') || err.message.includes('ETIMEDOUT') || err.code === 'ECONNREFUSED')) {
      const parsed = new URL(connStr);
      if (parsed.hostname.startsWith('db.') && parsed.hostname.endsWith('.supabase.co')) {
        const projectRef = parsed.hostname.split('.')[1];
        const poolerHost = 'aws-0-ap-south-1.pooler.supabase.com';
        const poolerUser = `postgres.${projectRef}`;
        console.log(`⚠️ Direct connection to IPv6 host (${parsed.hostname}) is unreachable on this network.`);
        console.log(`🔄 Automatically routing via IPv4 Supabase Pooler (${poolerHost}:5432)...`);

        const poolerConnStr = `postgresql://${encodeURIComponent(poolerUser)}:${encodeURIComponent(decodeURIComponent(parsed.password || ''))}@${poolerHost}:5432/postgres`;
        let poolerClient = null;
        try {
          poolerClient = new Client({
            connectionString: poolerConnStr,
            ssl: { rejectUnauthorized: false },
            connectionTimeoutMillis: 10000,
          });
          await poolerClient.connect();
          return poolerClient;
        } catch (poolerErr) {
          if (poolerClient) {
            await poolerClient.end().catch(() => {});
          }
          throw poolerErr;
        }
      }
    }
    throw err;
  }
}

async function main() {
  const connStr = getConnectionString();
  if (!connStr) {
    console.error('❌ Error: No DATABASE_URL found in environment or .env');
    process.exit(1);
  }

  let newSecret;
  try {
    newSecret = await readSecretFromStdin();
  } catch (err) {
    console.error('❌ Error reading secret:', err.message);
    process.exit(1);
  }

  if (newSecret.length < 16) {
    console.error('❌ Error: Secret must be at least 16 characters long');
    process.exit(1);
  }

  let client;
  try {
    client = await connectWithFallback(connStr);
    console.log('✅ Connected to PostgreSQL database.');

    // Preflight: verify exactly one secret exists in Vault
    const checkRes = await client.query(`
      SELECT id, name, updated_at
      FROM vault.secrets
      WHERE name = 'push_webhook_secret';
    `);

    if (checkRes.rows.length === 0) {
      console.error('❌ Error: Secret "push_webhook_secret" not found in vault.secrets. Apply migration first.');
      process.exit(1);
    }

    if (checkRes.rows.length > 1) {
      console.error(`❌ Error: Ambiguous Vault state. Found ${checkRes.rows.length} duplicate secrets named "push_webhook_secret". Manual resolution required.`);
      process.exit(1);
    }

    const secretId = checkRes.rows[0].id;
    console.log(`🔐 Found unique Vault secret id: ${secretId} (last updated: ${checkRes.rows[0].updated_at})`);

    // Execute supported parameterized Vault update API
    await client.query(
      `SELECT vault.update_secret($1::uuid, $2::text);`,
      [secretId, newSecret]
    );

    // Verify metadata update without printing secret value
    const postCheck = await client.query(`
      SELECT id, name, updated_at
      FROM vault.secrets
      WHERE id = $1::uuid;
    `, [secretId]);

    console.log('✅ Vault secret successfully updated via supported vault.update_secret() API.');
    console.log(`   Secret ID: ${postCheck.rows[0].id}`);
    console.log(`   Updated At: ${postCheck.rows[0].updated_at}`);

  } catch (err) {
    const safeMsg = (err && err.message) ? err.message.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@') : 'Unknown error';
    console.error('❌ Failed to update Vault secret:', safeMsg);
    process.exit(1);
  } finally {
    if (client) {
      await client.end().catch(() => {});
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
