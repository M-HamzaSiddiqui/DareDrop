// DareDrop Automated PostgreSQL Migration Runner
// Run with:
//   npm run migrate

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const dns = require('dns');
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {}

function getConnectionString() {
  // 1. From CLI argument
  if (process.argv[2] && process.argv[2].startsWith('postgres')) {
    return process.argv[2].trim();
  }

  // 2. From .env or supabase/.env files
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

  // 3. From environment variable
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL.trim();
  }

  return null;
}

async function connectWithFallback(connStr) {
  try {
    const c = new Client({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000,
    });
    await c.connect();
    return { client: c, activeConnStr: connStr };
  } catch (err) {
    // If direct IPv6 host is unreachable (common on standard IPv4 networks)
    if (err.message.includes('ENETUNREACH') || err.message.includes('ETIMEDOUT') || err.code === 'ECONNREFUSED') {
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
        return { client: poolerClient, activeConnStr: poolerConnStr };
      }
    }
    throw err;
  }
}

async function run() {
  const connectionString = getConnectionString();

  if (!connectionString) {
    console.error('❌ Error: No PostgreSQL connection string provided.');
    console.log('\nUsage:');
    console.log('  node scripts/run-migration.js "postgresql://postgres:[YOUR_PASSWORD]@db.uyglmszjkkfjeckpwpab.supabase.co:5432/postgres"');
    console.log('\nOr add this line to your .env or supabase/.env file:');
    console.log('  DATABASE_URL=postgresql://postgres:[YOUR_PASSWORD]@db.uyglmszjkkfjeckpwpab.supabase.co:5432/postgres');
    console.log('\nThen run:');
    console.log('  npm run migrate\n');
    process.exit(1);
  }

  try {
    const parsedUrl = new URL(connectionString);
    if (!parsedUrl.hostname.includes('uyglmszjkkfjeckpwpab') && !parsedUrl.username.includes('uyglmszjkkfjeckpwpab')) {
      throw new Error(`Target project ref mismatch: expected uyglmszjkkfjeckpwpab, connection string does not match.`);
    }
  } catch (err) {
    console.error('❌ Safety check failed:', err.message);
    process.exit(1);
  }

  const migrationsDir = path.resolve(process.cwd(), 'supabase/migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.error(`❌ Migrations directory not found: ${migrationsDir}`);
    process.exit(1);
  }

  // Determine which migrations to run: specific file passed via CLI or all files in directory
  const argFile = process.argv[2] && process.argv[2].endsWith('.sql') ? process.argv[2] : null;
  const migrationFiles = argFile
    ? [path.resolve(process.cwd(), argFile)]
    : fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => path.join(migrationsDir, f));

  if (migrationFiles.length === 0) {
    console.log('No migration files to run.');
    return;
  }

  console.log('--- Applying Supabase Migration via PostgreSQL Connection ---');

  // Parse connection URL to display host without exposing password
  try {
    const url = new URL(connectionString);
    console.log(`📡 Connecting to PostgreSQL host: ${url.host} (user: ${url.username})`);
  } catch {
    console.log('📡 Connecting with provided connection string...');
  }

  let activeClient = null;
  let activeConnStr = connectionString;

  try {
    const connResult = await connectWithFallback(connectionString);
    activeClient = connResult.client;
    activeConnStr = connResult.activeConnStr;

    console.log('✅ Connected to PostgreSQL database successfully.');

    for (const filePath of migrationFiles) {
      const fileName = path.basename(filePath);
      console.log(`🚀 Executing migration: ${fileName}...`);
      const sql = fs.readFileSync(filePath, 'utf8');
      await activeClient.query(sql);
      console.log(`✅ Applied ${fileName} successfully.`);
    }

    console.log('\n✅ All migrations applied successfully!\n');
    await activeClient.end();

    // Notify PostgREST to reload its schema cache
    console.log('🔄 Reloading PostgREST schema cache...');
    const reloadClient = new Client({
      connectionString: activeConnStr,
      ssl: { rejectUnauthorized: false },
    });
    await reloadClient.connect();
    await reloadClient.query("NOTIFY pgrst, 'reload schema';");
    await reloadClient.end();
    console.log('✅ Schema cache reload signaled.');

    // Run verification
    console.log('\nRunning API verification...');
    // Give PostgREST 1 second to update cache
    await new Promise((res) => setTimeout(res, 1000));
    require('./verify-supabase.js');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    if (err.code === '28P01') {
      console.error('   Hint: Password authentication failed. Double check your database password.');
    } else if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENETUNREACH') {
      console.error('   Hint: Connection unreachable. Ensure your Supabase project is active.');
    }
    if (activeClient) {
      await activeClient.end().catch(() => {});
    }
    process.exit(1);
  }
}

run();
