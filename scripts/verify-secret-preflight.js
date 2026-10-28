// scripts/verify-secret-preflight.js
// Read-only pre-deployment consistency check
// Verifies that a candidate OLD_PUSH_SECRET matches the secret currently in:
// - pg_trigger.tgargs (if legacy trigger is active) OR
// - vault.decrypted_secrets (if Vault secret already exists)
//
// Guarantees:
// 1. Parameterized execution ($1) — zero SQL string interpolation.
// 2. Compares via SHA-256 bytea hashes inside PostgreSQL — zero secret disclosure.
// 3. Exits with code 0 if matching; exits with code 1 if mismatch or missing.
// 4. Temporary PL/pgSQL function in pg_temp — automatically dropped on disconnect.

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

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
  if (process.env.OLD_PUSH_SECRET) {
    return process.env.OLD_PUSH_SECRET.trim();
  }
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      const trimmed = data.trim();
      if (!trimmed) {
        reject(new Error('No secret received on stdin or OLD_PUSH_SECRET env var'));
      } else {
        resolve(trimmed);
      }
    });
  });
}

async function connectWithFallback(connStr) {
  const isLocal = connStr.includes('127.0.0.1') || connStr.includes('localhost') || connStr.startsWith('/');
  try {
    const c = new Client({
      connectionString: connStr,
      ssl: isLocal ? false : { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000,
    });
    await c.connect();
    return c;
  } catch (err) {
    if (!isLocal && (err.message.includes('ENETUNREACH') || err.message.includes('ETIMEDOUT') || err.code === 'ECONNREFUSED')) {
      const parsed = new URL(connStr);
      if (parsed.hostname.startsWith('db.') && parsed.hostname.endsWith('.supabase.co')) {
        const projectRef = parsed.hostname.split('.')[1];
        const poolerHost = 'aws-0-ap-south-1.pooler.supabase.com';
        const poolerUser = `postgres.${projectRef}`;
        console.log(`⚠️ Direct connection to IPv6 host (${parsed.hostname}) is unreachable on this network.`);
        console.log(`🔄 Automatically routing via IPv4 Supabase Pooler (${poolerHost}:5432)...`);

        const poolerConnStr = `postgresql://${encodeURIComponent(poolerUser)}:${encodeURIComponent(decodeURIComponent(parsed.password))}@${poolerHost}:5432/postgres`;
        const poolerClient = new Client({
          connectionString: poolerConnStr,
          ssl: { rejectUnauthorized: false },
          connectionTimeoutMillis: 10000,
        });
        await poolerClient.connect();
        return poolerClient;
      }
    }
    throw err;
  }
}

async function verify() {
  const connStr = getConnectionString();
  if (!connStr) {
    console.error('❌ Error: No DATABASE_URL found in environment or .env');
    process.exit(1);
  }

  let candidateSecret;
  try {
    candidateSecret = await readSecretFromStdin();
  } catch (err) {
    console.error('❌ Error reading candidate secret:', err.message);
    process.exit(1);
  }

  const isLocal = connStr.includes('127.0.0.1') || connStr.includes('localhost') || connStr.startsWith('/');
  if (!isLocal) {
    try {
      const parsedUrl = new URL(connStr);
      if (!parsedUrl.hostname.includes('uyglmszjkkfjeckpwpab') && !parsedUrl.username.includes('uyglmszjkkfjeckpwpab')) {
        console.error('❌ Safety check failed: Target project ref mismatch: expected uyglmszjkkfjeckpwpab.');
        process.exit(1);
      }
    } catch (err) {
      console.error('❌ URL parse error:', err.message);
      process.exit(1);
    }
  }

  let client = null;
  try {
    client = await connectWithFallback(connStr);

    // Inspect the active trigger on public.challenge_completions
    const trigInspect = await client.query(`
      SELECT
        tgname,
        tgenabled,
        tgtype,
        tgnargs,
        tgfoid::regproc::text AS fn_name
      FROM pg_catalog.pg_trigger
      WHERE tgname = 'send_push_notification_on_challenge_completion'
        AND tgrelid = 'public.challenge_completions'::pg_catalog.regclass
        AND NOT tgisinternal;
    `);

    if (trigInspect.rows.length === 0) {
      console.error('❌ Preflight Check FAILED: Trigger "send_push_notification_on_challenge_completion" not found on "public.challenge_completions".');
      process.exit(1);
    }

    const trig = trigInspect.rows[0];
    if (trig.tgenabled !== 'O') {
      console.error(`❌ Preflight Check FAILED: Trigger is disabled (tgenabled='${trig.tgenabled}').`);
      process.exit(1);
    }

    if (trig.fn_name === 'supabase_functions.http_request') {
      // Case A: Legacy trigger is active. Must compare strictly against pg_trigger.tgargs!
      if (trig.tgnargs !== 5) {
        console.error(`❌ Preflight Check FAILED: Legacy trigger has unexpected argument count (${trig.tgnargs}, expected 5).`);
        process.exit(1);
      }

      await client.query(`
        CREATE OR REPLACE FUNCTION pg_temp.verify_trigger_secret(p_candidate text)
        RETURNS boolean
        LANGUAGE plpgsql
        AS $fn$
        DECLARE
          v_args bytea;
          v_pos integer;
          v_part bytea;
          v_idx integer := 0;
          v_headers jsonb;
          v_extracted_secret text;
        BEGIN
          SELECT tgargs INTO v_args
          FROM pg_catalog.pg_trigger
          WHERE tgname = 'send_push_notification_on_challenge_completion'
            AND tgrelid = 'public.challenge_completions'::pg_catalog.regclass
            AND NOT tgisinternal;

          IF v_args IS NULL THEN
            RETURN FALSE;
          END IF;

          WHILE pg_catalog.octet_length(v_args) > 0 LOOP
            v_pos := position(decode('00', 'hex') in v_args);
            IF v_pos = 0 THEN
              v_part := v_args;
              v_args := E''::bytea;
            ELSE
              v_part := substring(v_args from 1 for v_pos - 1);
              v_args := substring(v_args from v_pos + 1);
            END IF;

            IF v_idx = 2 THEN
              BEGIN
                v_headers := pg_catalog.convert_from(v_part, 'UTF8')::jsonb;
                v_extracted_secret := v_headers->>'x-webhook-secret';
              EXCEPTION WHEN OTHERS THEN
                RETURN FALSE;
              END;
              EXIT;
            END IF;
            v_idx := v_idx + 1;
          END LOOP;

          IF v_extracted_secret IS NULL THEN
            RETURN FALSE;
          END IF;

          RETURN sha256(v_extracted_secret::bytea) = sha256(p_candidate::bytea);
        END;
        $fn$;
      `);

      const trigRes = await client.query('SELECT pg_temp.verify_trigger_secret($1) AS legacy_matches;', [candidateSecret]);

      if (trigRes.rows[0].legacy_matches) {
        console.log('✅ Preflight Check Passed: Candidate secret matches active secret in legacy database trigger (pg_trigger.tgargs).');
        process.exit(0);
      } else {
        console.error('❌ Preflight Check FAILED: Supplied secret does NOT match active secret in legacy database trigger.');
        console.error('   HALT: Deploying with a mismatched secret will break push notification authentication.');
        process.exit(1);
      }

    } else if (trig.fn_name === 'public.notify_push_on_challenge_completion' || trig.fn_name === 'notify_push_on_challenge_completion') {
      // Case B: Trigger is already Vault-backed. Must compare strictly against vault.decrypted_secrets!
      const vaultRes = await client.query(`
        SELECT EXISTS (
          SELECT 1 FROM vault.decrypted_secrets
          WHERE name = 'push_webhook_secret'
            AND sha256(decrypted_secret::bytea) = sha256($1::bytea)
        ) AS vault_matches;
      `, [candidateSecret]).catch(() => ({ rows: [{ vault_matches: false }] }));

      if (vaultRes.rows[0].vault_matches) {
        console.log('✅ Preflight Check Passed: Candidate secret matches active secret in vault.decrypted_secrets.');
        process.exit(0);
      } else {
        console.error('❌ Preflight Check FAILED: Supplied secret does NOT match active secret in vault.decrypted_secrets.');
        console.error('   HALT: Vault secret mismatch detected.');
        process.exit(1);
      }

    } else {
      console.error(`❌ Preflight Check FAILED: Trigger executes unexpected function "${trig.fn_name}".`);
      process.exit(1);
    }

  } catch (err) {
    console.error('❌ Preflight check error:', err.message);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  verify();
}

module.exports = { verify };
