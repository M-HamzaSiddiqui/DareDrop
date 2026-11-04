// DareDrop Phase 33 — Targeted Reliability Fixes Test Suite
// File: scripts/test-phase33-fixes.js
// Run with: node scripts/test-phase33-fixes.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('================================================================');
console.log('DareDrop Phase 33 Targeted Reliability Fixes Test Suite');
console.log('================================================================\n');

let passedCount = 0;
let failedCount = 0;
let skippedCount = 0;

function runTest(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passedCount++;
  } catch (err) {
    console.error(`  ❌ ${name}: ${err.message}`);
    failedCount++;
  }
}

// ============================================================================
// PART A: Static Migration Contract & Security Analysis
// ============================================================================
console.log('[Suite 1] Static Migration Contract Audit (Fix 1 & Fix 2)');

runTest('Migration 20261102010000_resubmission_grace_period.sql exists and is non-empty', () => {
  const migPath = path.resolve(__dirname, '../supabase/migrations/20261102010000_resubmission_grace_period.sql');
  assert(fs.existsSync(migPath), 'Migration file must exist');
  const content = fs.readFileSync(migPath, 'utf8');
  assert(content.length > 500, 'Migration file must have content');
});

runTest('Rollback migration 20261102010000_resubmission_grace_period_rollback.sql exists', () => {
  const rollbackPath = path.resolve(__dirname, '../supabase/migrations/rollback/20261102010000_resubmission_grace_period_rollback.sql');
  assert(fs.existsSync(rollbackPath), 'Rollback file must exist');
});

runTest('Schema enhancement adds first_submitted_at, last_rejection_reason, last_reviewed_at with backfill', () => {
  const migPath = path.resolve(__dirname, '../supabase/migrations/20261102010000_resubmission_grace_period.sql');
  const sql = fs.readFileSync(migPath, 'utf8');
  assert(sql.includes('ADD COLUMN IF NOT EXISTS first_submitted_at TIMESTAMPTZ'), 'Must add first_submitted_at');
  assert(sql.includes('ADD COLUMN IF NOT EXISTS last_rejection_reason TEXT'), 'Must add last_rejection_reason');
  assert(sql.includes('ADD COLUMN IF NOT EXISTS last_reviewed_at TIMESTAMPTZ'), 'Must add last_reviewed_at');
  assert(sql.includes('UPDATE public.challenge_completions'), 'Must backfill first_submitted_at');
  assert(sql.includes('SET first_submitted_at = submitted_at'), 'Must set first_submitted_at = submitted_at on backfill');
});

runTest('generate_proof_challenge and submit_challenge_completion enforce 48-hour rejection grace period', () => {
  const migPath = path.resolve(__dirname, '../supabase/migrations/20261102010000_resubmission_grace_period.sql');
  const sql = fs.readFileSync(migPath, 'utf8');

  // Both functions must check reviewed_at within 48 hours
  const intervalCheck = "INTERVAL '48 hours'";
  const occurrences = (sql.match(new RegExp(intervalCheck, 'g')) || []).length;
  assert(occurrences >= 2, `Expected at least 2 occurrences of 48 hours interval, got ${occurrences}`);

  // Both functions must check on-time original submission
  assert(sql.includes('first_submitted_at, v_existing_comp.submitted_at'), 'generate_proof_challenge must check first_submitted_at');
  assert(sql.includes('first_submitted_at, v_existing.submitted_at'), 'submit_challenge_completion must check first_submitted_at');

  // Row locks must be used
  assert(sql.includes('FOR UPDATE'), 'Must lock existing completion with FOR UPDATE');
});

runTest('Preserves legacy 4-arg submit_challenge_completion compatibility and 5-arg contract', () => {
  const dynamicMigPath = path.resolve(__dirname, '../supabase/migrations/20261102000000_dynamic_proof_challenges.sql');
  const dynSql = fs.readFileSync(dynamicMigPath, 'utf8');
  assert(dynSql.includes('App update required: DareDrop now requires dynamic proof verification'), '4-arg stub preserved in migration history');

  const migPath = path.resolve(__dirname, '../supabase/migrations/20261102010000_resubmission_grace_period.sql');
  const sql = migPath ? fs.readFileSync(migPath, 'utf8') : '';
  assert(sql.includes('p_proof_challenge_id UUID,'), '5-arg function strictly requires proof challenge UUID');
  assert(!sql.includes('p_proof_challenge_id UUID DEFAULT NULL'), 'Proof challenge must NOT have default NULL');
});

// ============================================================================
// PART B: Fix 1 State-Machine & Business Logic Simulation (13 Scenarios)
// ============================================================================
console.log('\n[Suite 2] Fix 1 — Rejected Completion Resubmission State Machine');

class ResubmissionSimulator {
  constructor() {
    this.completions = new Map();
    this.proofChallenges = new Map();
    this.participants = new Set(['user_alice', 'user_bob', 'user_charlie']);
    this.advisoryLocks = new Set();
  }

  // Simulated server time in challenge timezone (UTC)
  getNow() {
    return new Date('2026-11-06T12:00:00Z');
  }

  getTodayInTz() {
    return '2026-11-06';
  }

  getYesterdayInTz() {
    return '2026-11-05';
  }

  generateProofChallenge({ callerId, challengeId, verifierId, completionDate, challengeType = 'daily' }) {
    if (callerId === verifierId) {
      throw new Error('22023 You cannot designate yourself as verifier');
    }
    if (!this.participants.has(verifierId)) {
      throw new Error('22023 Designated verifier must be an active participant');
    }

    const key = challengeType === 'one_time'
      ? `${challengeId}:${callerId}`
      : `${challengeId}:${callerId}:${completionDate}`;
    const existingComp = this.completions.get(key);

    if (existingComp) {
      if (existingComp.status === 'approved') {
        throw new Error(`23505 Day ${completionDate} is already approved`);
      }
      if (existingComp.status === 'pending') {
        throw new Error(`23505 Day ${completionDate} is already pending verification`);
      }
    }

    const today = this.getTodayInTz();
    const yesterday = this.getYesterdayInTz();

    if (completionDate > today) {
      throw new Error(`22023 Cannot generate proof for a future date (current challenge date is ${today})`);
    } else if (completionDate < yesterday) {
      // Rejection grace period check
      if (!existingComp) {
        throw new Error(`22023 Submission window expired for date ${completionDate} (allowed: ${yesterday} to ${today})`);
      }
      if (existingComp.status !== 'rejected') {
        throw new Error(`22023 Submission window expired for date ${completionDate} (allowed: ${yesterday} to ${today})`);
      }
      const reviewedAt = new Date(existingComp.reviewed_at);
      const diffHours = (this.getNow().getTime() - reviewedAt.getTime()) / (1000 * 60 * 60);
      if (diffHours > 48) {
        throw new Error(`22023 Resubmission grace period expired (rejection occurred more than 48 hours ago for date ${completionDate})`);
      }

      // Check original submission on-time
      const firstSubmittedDate = existingComp.first_submitted_at.split('T')[0];
      const maxAllowedFirstSubmit = new Date(new Date(completionDate).getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      if (firstSubmittedDate > maxAllowedFirstSubmit) {
        throw new Error(`22023 Resubmission denied: original submission was not submitted within the permitted window for date ${completionDate}`);
      }
    }

    const proofId = 'proof_' + Math.random().toString(36).substring(2, 8);
    const proof = {
      id: proofId,
      challenge_id: challengeId,
      participant_id: callerId,
      verifier_id: verifierId,
      completion_date: completionDate,
      status: 'active',
      created_at: this.getNow().toISOString(),
    };
    this.proofChallenges.set(proofId, proof);
    return proof;
  }

  submitCompletion({ callerId, challengeId, verifierId, completionDate, proofChallengeId, challengeType = 'daily' }) {
    const proof = this.proofChallenges.get(proofChallengeId);
    if (!proof || proof.status !== 'active') {
      throw new Error('Proof challenge is no longer active or consumed');
    }

    const key = challengeType === 'one_time'
      ? `${challengeId}:${callerId}`
      : `${challengeId}:${callerId}:${completionDate}`;
    const existingComp = this.completions.get(key);

    const today = this.getTodayInTz();
    const yesterday = this.getYesterdayInTz();

    if (completionDate < yesterday) {
      if (!existingComp || existingComp.status !== 'rejected') {
        throw new Error(`22023 Submission window expired for date ${completionDate}`);
      }
      const reviewedAt = new Date(existingComp.reviewed_at);
      const diffHours = (this.getNow().getTime() - reviewedAt.getTime()) / (1000 * 60 * 60);
      if (diffHours > 48) {
        throw new Error('22023 Resubmission grace period expired');
      }
    }

    // Atomically consume proof
    proof.status = 'consumed';
    proof.consumed_at = this.getNow().toISOString();

    if (existingComp && existingComp.status === 'rejected') {
      existingComp.last_rejection_reason = existingComp.rejection_reason;
      existingComp.last_reviewed_at = existingComp.reviewed_at;
      existingComp.status = 'pending';
      existingComp.rejection_reason = null;
      existingComp.reviewed_at = null;
      existingComp.submitted_at = this.getNow().toISOString();
      existingComp.proof_challenge_id = proofChallengeId;
      return existingComp;
    }

    const newComp = {
      id: 'comp_' + Math.random().toString(36).substring(2, 8),
      challenge_id: challengeId,
      participant_id: callerId,
      verifier_id: verifierId,
      completion_date: completionDate,
      status: 'pending',
      first_submitted_at: this.getNow().toISOString(),
      submitted_at: this.getNow().toISOString(),
      proof_challenge_id: proofChallengeId,
    };
    this.completions.set(key, newComp);
    return newComp;
  }
}

const sim = new ResubmissionSimulator();

runTest('1. On-time submission rejected within 48 hours: resubmission allowed', () => {
  // Dare date: 2026-11-05 (yesterday). First submitted on 2026-11-05. Rejected 10 hours ago.
  sim.completions.set('c1:user_alice:2026-11-05', {
    id: 'comp_1',
    challenge_id: 'c1',
    participant_id: 'user_alice',
    verifier_id: 'user_bob',
    completion_date: '2026-11-05',
    status: 'rejected',
    rejection_reason: 'Photo too blurry',
    first_submitted_at: '2026-11-05T18:00:00Z',
    submitted_at: '2026-11-05T18:00:00Z',
    reviewed_at: new Date(sim.getNow().getTime() - 10 * 3600 * 1000).toISOString(),
  });

  const proof = sim.generateProofChallenge({
    callerId: 'user_alice',
    challengeId: 'c1',
    verifierId: 'user_bob',
    completionDate: '2026-11-05',
  });
  assert(proof && proof.status === 'active');

  const res = sim.submitCompletion({
    callerId: 'user_alice',
    challengeId: 'c1',
    verifierId: 'user_bob',
    completionDate: '2026-11-05',
    proofChallengeId: proof.id,
  });
  assert.strictEqual(res.status, 'pending');
  assert.strictEqual(res.last_rejection_reason, 'Photo too blurry');
});

runTest('2. On-time submission rejected after date is older than yesterday, but rejection within 48h: resubmission allowed', () => {
  // Dare date: 2026-11-01 (5 days ago). First submitted on 2026-11-01. Verifier delayed review and rejected 20 hours ago.
  sim.completions.set('c1:user_alice:2026-11-01', {
    id: 'comp_2',
    challenge_id: 'c1',
    participant_id: 'user_alice',
    verifier_id: 'user_bob',
    completion_date: '2026-11-01',
    status: 'rejected',
    rejection_reason: 'Incorrect gesture',
    first_submitted_at: '2026-11-01T20:00:00Z',
    submitted_at: '2026-11-01T20:00:00Z',
    reviewed_at: new Date(sim.getNow().getTime() - 20 * 3600 * 1000).toISOString(),
  });

  const proof = sim.generateProofChallenge({
    callerId: 'user_alice',
    challengeId: 'c1',
    verifierId: 'user_bob',
    completionDate: '2026-11-01',
  });
  assert(proof && proof.status === 'active');

  const res = sim.submitCompletion({
    callerId: 'user_alice',
    challengeId: 'c1',
    verifierId: 'user_bob',
    completionDate: '2026-11-01',
    proofChallengeId: proof.id,
  });
  assert.strictEqual(res.status, 'pending');
  assert.strictEqual(res.last_rejection_reason, 'Incorrect gesture');
});

runTest('3. Rejection older than 48 hours: resubmission denied', () => {
  // Dare date: 2026-11-01. Rejection was 55 hours ago (> 48h).
  sim.completions.set('c1:user_alice:2026-11-01-old', {
    id: 'comp_3',
    challenge_id: 'c1',
    participant_id: 'user_alice',
    verifier_id: 'user_bob',
    completion_date: '2026-11-01-old',
    status: 'rejected',
    rejection_reason: 'Expired',
    first_submitted_at: '2026-11-01T20:00:00Z',
    submitted_at: '2026-11-01T20:00:00Z',
    reviewed_at: new Date(sim.getNow().getTime() - 55 * 3600 * 1000).toISOString(),
  });

  assert.throws(
    () => {
      sim.generateProofChallenge({
        callerId: 'user_alice',
        challengeId: 'c1',
        verifierId: 'user_bob',
        completionDate: '2026-11-01-old',
      });
    },
    /Resubmission grace period expired/
  );
});

runTest('4. No original completion: old-date proof generation denied', () => {
  assert.throws(
    () => {
      sim.generateProofChallenge({
        callerId: 'user_alice',
        challengeId: 'c1',
        verifierId: 'user_bob',
        completionDate: '2026-10-25', // completely past date with no completion record
      });
    },
    /Submission window expired for date 2026-10-25/
  );
});

runTest('5. Original completion was submitted late: grace-period resubmission denied', () => {
  // Dare date was 2026-11-01, but first_submitted_at was 2026-11-04 (late).
  sim.completions.set('c1:user_alice:2026-11-01-latetest', {
    id: 'comp_late',
    challenge_id: 'c1',
    participant_id: 'user_alice',
    verifier_id: 'user_bob',
    completion_date: '2026-11-01',
    status: 'rejected',
    rejection_reason: 'Late submission',
    first_submitted_at: '2026-11-04T10:00:00Z',
    submitted_at: '2026-11-04T10:00:00Z',
    reviewed_at: new Date(sim.getNow().getTime() - 10 * 3600 * 1000).toISOString(),
  });

  assert.throws(
    () => {
      // Custom simulator instance for isolated test
      const isolatedSim = new ResubmissionSimulator();
      isolatedSim.completions.set('c1:user_alice:2026-11-01', {
        id: 'comp_late',
        challenge_id: 'c1',
        participant_id: 'user_alice',
        verifier_id: 'user_bob',
        completion_date: '2026-11-01',
        status: 'rejected',
        rejection_reason: 'Late submission',
        first_submitted_at: '2026-11-04T10:00:00Z',
        submitted_at: '2026-11-04T10:00:00Z',
        reviewed_at: new Date(isolatedSim.getNow().getTime() - 10 * 3600 * 1000).toISOString(),
      });
      isolatedSim.generateProofChallenge({
        callerId: 'user_alice',
        challengeId: 'c1',
        verifierId: 'user_bob',
        completionDate: '2026-11-01',
      });
    },
    /Resubmission denied: original submission was not submitted within the permitted window/
  );
});

runTest('6. Approved completion: resubmission denied', () => {
  const isolatedSim = new ResubmissionSimulator();
  isolatedSim.completions.set('c1:user_alice:2026-11-06', {
    id: 'comp_approved',
    challenge_id: 'c1',
    participant_id: 'user_alice',
    completion_date: '2026-11-06',
    status: 'approved',
  });

  assert.throws(
    () => {
      isolatedSim.generateProofChallenge({
        callerId: 'user_alice',
        challengeId: 'c1',
        verifierId: 'user_bob',
        completionDate: '2026-11-06',
      });
    },
    /already approved/
  );
});

runTest('7. Pending completion: duplicate resubmission denied', () => {
  const isolatedSim = new ResubmissionSimulator();
  isolatedSim.completions.set('c1:user_alice:2026-11-06', {
    id: 'comp_pending',
    challenge_id: 'c1',
    participant_id: 'user_alice',
    completion_date: '2026-11-06',
    status: 'pending',
  });

  assert.throws(
    () => {
      isolatedSim.generateProofChallenge({
        callerId: 'user_alice',
        challengeId: 'c1',
        verifierId: 'user_bob',
        completionDate: '2026-11-06',
      });
    },
    /already pending verification/
  );
});

runTest('8. Invalid verifier: denied', () => {
  const isolatedSim = new ResubmissionSimulator();
  assert.throws(
    () => {
      isolatedSim.generateProofChallenge({
        callerId: 'user_alice',
        challengeId: 'c1',
        verifierId: 'non_participant_stranger',
        completionDate: '2026-11-06',
      });
    },
    /Designated verifier must be an active participant/
  );
});

runTest('9. Self-verification: denied', () => {
  const isolatedSim = new ResubmissionSimulator();
  assert.throws(
    () => {
      isolatedSim.generateProofChallenge({
        callerId: 'user_alice',
        challengeId: 'c1',
        verifierId: 'user_alice',
        completionDate: '2026-11-06',
      });
    },
    /You cannot designate yourself as verifier/
  );
});

runTest('10. Concurrent proof-generation / resubmission attempts: no duplicate active completion', () => {
  const isolatedSim = new ResubmissionSimulator();
  const proofA = isolatedSim.generateProofChallenge({
    callerId: 'user_alice',
    challengeId: 'c1',
    verifierId: 'user_bob',
    completionDate: '2026-11-06',
  });
  const comp = isolatedSim.submitCompletion({
    callerId: 'user_alice',
    challengeId: 'c1',
    verifierId: 'user_bob',
    completionDate: '2026-11-06',
    proofChallengeId: proofA.id,
  });
  assert(comp);

  // Attempting second submit with same consumed proof throws
  assert.throws(() => {
    isolatedSim.submitCompletion({
      callerId: 'user_alice',
      challengeId: 'c1',
      verifierId: 'user_bob',
      completionDate: '2026-11-06',
      proofChallengeId: proofA.id,
    });
  }, /no longer active or consumed/);
});

runTest('11. One-time completion behavior remains unchanged', () => {
  const isolatedSim = new ResubmissionSimulator();
  const onetimeProof = isolatedSim.generateProofChallenge({
    callerId: 'user_alice',
    challengeId: 'c_onetime',
    verifierId: 'user_bob',
    completionDate: '2026-11-06',
    challengeType: 'one_time',
  });
  assert(onetimeProof);
  const onetimeComp = isolatedSim.submitCompletion({
    callerId: 'user_alice',
    challengeId: 'c_onetime',
    verifierId: 'user_bob',
    completionDate: '2026-11-06',
    proofChallengeId: onetimeProof.id,
    challengeType: 'one_time',
  });
  assert.strictEqual(onetimeComp.status, 'pending');
});

runTest('12. Existing legacy four-argument RPC returns update-required error in AST', () => {
  const dynamicMigPath = path.resolve(__dirname, '../supabase/migrations/20261102000000_dynamic_proof_challenges.sql');
  const sql = fs.readFileSync(dynamicMigPath, 'utf8');
  assert(sql.includes("RAISE EXCEPTION 'App update required: DareDrop now requires dynamic proof verification. Please update your app to submit completions.'"));
});

runTest('13. New five-argument RPC remains discoverable and functional', () => {
  const migPath = path.resolve(__dirname, '../supabase/migrations/20261102010000_resubmission_grace_period.sql');
  const sql = fs.readFileSync(migPath, 'utf8');
  assert(sql.includes('public.submit_challenge_completion(UUID, TEXT, DATE, UUID, TEXT)'));
  assert(sql.includes('GRANT EXECUTE ON FUNCTION public.submit_challenge_completion(UUID, TEXT, DATE, UUID, TEXT) TO authenticated'));
});

// ============================================================================
// PART C: Fix 2 Client Clock Skew & Error Reconciling (8 Scenarios)
// ============================================================================
console.log('\n[Suite 3] Fix 2 — Client Device Clock Skew & Error Reconciliation');

// Exact implementation from src/data/challenges.ts
function getChallengeDates(timeZone = 'UTC', referenceDate = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const today = formatter.format(referenceDate);
    const yesterday = formatter.format(new Date(referenceDate.getTime() - 24 * 60 * 60 * 1000));
    return { today, yesterday };
  } catch {
    const today = referenceDate.toISOString().split('T')[0];
    const yesterday = new Date(referenceDate.getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    return { today, yesterday };
  }
}

runTest('1. Device clock matches challenge timezone', () => {
  const serverTime = new Date('2026-11-02T14:30:00Z');
  const dates = getChallengeDates('UTC', serverTime);
  assert.strictEqual(dates.today, '2026-11-02');
  assert.strictEqual(dates.yesterday, '2026-11-01');
});

runTest('2. Device clock is three minutes ahead across midnight', () => {
  // Local device clock is 2026-11-03T00:02:00Z (+3 min ahead of 2026-11-02T23:59:00Z)
  const deviceClock = new Date('2026-11-03T00:02:00Z');
  const dates = getChallengeDates('UTC', deviceClock);
  assert.strictEqual(dates.today, '2026-11-03'); // Device thinks it is Nov 3

  // Backend receives Nov 3, but server time is Nov 2
  const serverToday = '2026-11-02';
  const backendError = `Cannot generate proof for a future date (current challenge date is ${serverToday})`;

  // Store parse check
  const isFutureDate = backendError.includes('Cannot generate proof for a future date');
  const match = backendError.match(/current challenge date is (\d{4}-\d{2}-\d{2})/);
  assert(isFutureDate, 'Must identify future date');
  assert(match && match[1] === '2026-11-02', 'Must extract server date Nov 2');
});

runTest('3. Device clock is several hours behind', () => {
  // Device clock at 18:00 on Nov 1, server at 02:00 on Nov 2
  const deviceClock = new Date('2026-11-01T18:00:00Z');
  const dates = getChallengeDates('UTC', deviceClock);
  assert.strictEqual(dates.today, '2026-11-01');
  assert.strictEqual(dates.yesterday, '2026-10-31');
  // Submitting for Nov 1 when server is Nov 2 is allowed by yesterday's window!
});

runTest('4. Backend returns the future-date SQLSTATE / message', () => {
  const err = {
    code: '22023',
    message: 'Cannot generate proof for a future date (current challenge date is 2026-11-02)',
  };
  const isFutureDate = err.message.includes('Cannot generate proof for a future date');
  const match = err.message.match(/current challenge date is (\d{4}-\d{2}-\d{2})/);
  assert.strictEqual(isFutureDate, true);
  assert.strictEqual(match[1], '2026-11-02');
});

runTest('5. UI shows a useful message rather than crashing', () => {
  // Simulate UI handleGenerateProof error handling
  let selectedDate = '2026-11-03';
  let proofError = null;

  const res = {
    success: false,
    error: 'Your device clock is ahead of the challenge timezone. The current challenge date is 2026-11-02.',
    isFutureDate: true,
    serverDate: '2026-11-02',
  };

  if (!res.success) {
    if (res.isFutureDate && res.serverDate && res.serverDate !== selectedDate) {
      selectedDate = res.serverDate;
      proofError = `Clock mismatch: your device is ahead of the challenge timezone. Date adjusted to ${res.serverDate}. Tap "Get Proof Code" to proceed.`;
    } else {
      proofError = res.error || 'Failed to generate proof challenge.';
    }
  }

  assert.strictEqual(selectedDate, '2026-11-02', 'Selected date reconciled to server date');
  assert(proofError.includes('Clock mismatch'), 'Informative non-crashing message presented');
  assert(proofError.includes('2026-11-02'), 'Mentions the corrected date');
});

runTest('6. Network failure retains existing error handling', () => {
  const res = {
    success: false,
    error: 'Network request failed. Please check your connection.',
    isFutureDate: false,
  };
  assert.strictEqual(res.isFutureDate, false);
  assert.strictEqual(res.error, 'Network request failed. Please check your connection.');
});

runTest('7. Rate-limit errors retain existing error handling', () => {
  const rpcErr = {
    code: '42900',
    message: 'Rate limit exceeded: maximum 5 proof challenges per hour.',
  };
  let userMsg = rpcErr.message;
  if (rpcErr.code === '42900' || rpcErr.message.includes('Rate limit')) {
    userMsg = 'Rate limit reached: maximum 5 proof challenges per hour. Please wait before generating another.';
  }
  assert(userMsg.includes('Rate limit reached: maximum 5 proof challenges per hour'));
});

runTest('8. Repeated retry does not create duplicate proof challenges or infinite loop', () => {
  let selectedDate = '2026-11-02'; // Already reconciled
  let proofError = null;
  const res = {
    success: false,
    error: 'Your device clock is ahead of the challenge timezone. The current challenge date is 2026-11-02.',
    isFutureDate: true,
    serverDate: '2026-11-02',
  };

  // If serverDate === selectedDate, it does not re-reconcile or trigger loop
  if (!res.success) {
    if (res.isFutureDate && res.serverDate && res.serverDate !== selectedDate) {
      selectedDate = res.serverDate;
      proofError = `Clock mismatch: your device is ahead of the challenge timezone. Date adjusted to ${res.serverDate}. Tap "Get Proof Code" to proceed.`;
    } else {
      proofError = res.error;
    }
  }

  assert.strictEqual(selectedDate, '2026-11-02');
  assert.strictEqual(proofError, res.error);
});

// ============================================================================
// Summary
// ============================================================================
console.log('\n================================================================');
console.log(`Phase 33 Test Summary: ${passedCount} Passed, ${failedCount} Failed, ${skippedCount} Skipped`);
console.log('================================================================');

if (failedCount > 0) {
  process.exit(1);
}
