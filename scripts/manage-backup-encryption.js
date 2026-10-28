// scripts/manage-backup-encryption.js
// Secure encryption and verification for DareDrop database backups
// Uses GPG AES-256 symmetric encryption with stdin passphrase delivery
// Never prints, commits, or stores passphrases on disk

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BACKUP_DIR = path.resolve(process.cwd(), 'backups');

function getPassphrase() {
  const envPass = process.env.BACKUP_ENCRYPTION_PASSPHRASE;
  if (envPass && envPass.trim().length > 0) {
    return envPass;
  }
  // Generate high-entropy 256-bit passphrase for local operational encryption if not provided
  return crypto.randomBytes(32).toString('hex');
}

function encryptBackup(dumpPath, customPassphrase = null) {
  if (!fs.existsSync(dumpPath)) {
    throw new Error(`Dump file not found: ${dumpPath}`);
  }

  const outputPath = `${dumpPath}.gpg`;
  const passphrase = customPassphrase || getPassphrase();

  console.log(`🔐 Encrypting backup with GPG AES-256:`);
  console.log(`   Source: ${path.basename(dumpPath)} (${fs.statSync(dumpPath).size} bytes)`);
  console.log(`   Destination: ${path.basename(outputPath)}`);

  const gpgArgs = [
    '--batch',
    '--yes',
    '--passphrase-fd', '0',
    '--symmetric',
    '--cipher-algo', 'AES256',
    '-o', outputPath,
    dumpPath,
  ];

  const res = spawnSync('/usr/bin/gpg', gpgArgs, {
    input: passphrase,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  if (res.status !== 0) {
    throw new Error(`GPG encryption failed: ${res.stderr}`);
  }

  // Ensure restrictive file permissions (0600)
  fs.chmodSync(outputPath, 0o600);
  const outStats = fs.statSync(outputPath);
  console.log(`✅ Successfully encrypted: ${outStats.size} bytes (mode 0600)`);

  return { outputPath, passphrase };
}

function verifyEncryptedBackup(gpgPath, passphrase) {
  if (!fs.existsSync(gpgPath)) {
    throw new Error(`Encrypted backup file not found: ${gpgPath}`);
  }

  console.log(`🔍 Verifying encrypted backup decryption & TOC listing:`);
  console.log(`   Target: ${path.basename(gpgPath)} (${fs.statSync(gpgPath).size} bytes)`);

  // Stream decrypt directly into pg_restore -l without writing decrypted data to disk
  const gpgArgs = [
    '--batch',
    '--yes',
    '--passphrase-fd', '0',
    '--decrypt',
    gpgPath,
  ];

  const gpgProc = spawnSync('/usr/bin/gpg', gpgArgs, {
    input: passphrase,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  });

  if (gpgProc.status !== 0) {
    throw new Error(`GPG decryption failed: ${gpgProc.stderr ? gpgProc.stderr.toString() : 'Unknown error'}`);
  }

  const decryptedBuffer = gpgProc.stdout;
  if (!decryptedBuffer || decryptedBuffer.length === 0) {
    throw new Error('Decrypted output is empty');
  }

  // Run pg_restore -l on the decrypted buffer via stdin
  const restoreProc = spawnSync('/usr/bin/pg_restore', ['-l'], {
    input: decryptedBuffer,
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });

  if (restoreProc.status !== 0) {
    throw new Error(`pg_restore TOC read failed: ${restoreProc.stderr}`);
  }

  const toc = restoreProc.stdout;
  const requiredTables = ['challenges', 'challenge_participants', 'challenge_completions'];
  const verifiedTables = [];

  for (const line of toc.split('\n')) {
    for (const t of requiredTables) {
      if (line.includes(`TABLE public ${t}`) && !verifiedTables.includes(t)) {
        verifiedTables.push(t);
      }
    }
  }

  const missing = requiredTables.filter((t) => !verifiedTables.includes(t));
  if (missing.length > 0) {
    throw new Error(`Missing expected tables in decrypted archive: ${missing.join(', ')}`);
  }

  const entryCount = (toc.match(/^\d+;/gm) || []).length;
  console.log(`✅ Decryption & TOC listing verified:`);
  console.log(`   - TOC entries count: ${entryCount}`);
  console.log(`   - Verified required tables: ${verifiedTables.join(', ')}`);
  console.log(`   - Stream-verified without leaving decrypted artifacts on disk.`);

  return true;
}

function auditPermissions() {
  console.log('🔒 Auditing security permissions and exclusion rules:');
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    fs.chmodSync(envPath, 0o600);
    const mode = (fs.statSync(envPath).mode & 0o777).toString(8);
    console.log(`   - .env permissions: 0${mode} (verified restricted)`);
  }

  if (fs.existsSync(BACKUP_DIR)) {
    fs.chmodSync(BACKUP_DIR, 0o700);
    const dirMode = (fs.statSync(BACKUP_DIR).mode & 0o777).toString(8);
    console.log(`   - backups/ directory: 0${dirMode} (verified restricted)`);

    const files = fs.readdirSync(BACKUP_DIR);
    for (const f of files) {
      const p = path.join(BACKUP_DIR, f);
      fs.chmodSync(p, 0o600);
      const fMode = (fs.statSync(p).mode & 0o777).toString(8);
      console.log(`     * ${f}: 0${fMode}`);
    }
  }

  const gitignorePath = path.resolve(process.cwd(), '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const gi = fs.readFileSync(gitignorePath, 'utf8');
    const hasEnv = gi.includes('.env');
    const hasBackups = gi.includes('backups/');
    const hasDumps = gi.includes('*.dump');
    const hasGpg = gi.includes('*.gpg');
    console.log(`   - Git exclusion checks:`);
    console.log(`     * .env excluded: ${hasEnv}`);
    console.log(`     * backups/ excluded: ${hasBackups}`);
    console.log(`     * *.dump excluded: ${hasDumps}`);
    console.log(`     * *.gpg excluded: ${hasGpg}`);
  }
}

async function main() {
  const command = process.argv[2] || 'audit-and-secure';

  if (command === 'audit-and-secure') {
    auditPermissions();
    console.log('');
    const latestDump = path.join(BACKUP_DIR, 'daredrop_prod_backup_20261027_150254.dump');
    if (fs.existsSync(latestDump)) {
      const { outputPath, passphrase } = encryptBackup(latestDump);
      verifyEncryptedBackup(outputPath, passphrase);
    }
  } else if (command === 'audit') {
    auditPermissions();
  } else {
    console.log(`Usage: node scripts/manage-backup-encryption.js [audit-and-secure|audit]`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Error:', err.message);
    process.exit(1);
  });
}

module.exports = { encryptBackup, verifyEncryptedBackup, auditPermissions };
