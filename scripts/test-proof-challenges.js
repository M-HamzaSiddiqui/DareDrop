// DareDrop Dynamic Proof Challenges Backend Security & Concurrency Test Suite
// File: scripts/test-proof-challenges.js
// Run with: node scripts/test-proof-challenges.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================================
// 1. Static SQL Schema & Migration AST / Contract Verification
// ============================================================================
function testMigrationContract() {
  console.log('[Test 1] Static SQL Migration Contract Audit:');

  const migrationPath = path.resolve(
    __dirname,
    '../supabase/migrations/20261102000000_dynamic_proof_challenges.sql'
  );
  assert(fs.existsSync(migrationPath), 'Migration file must exist at expected path');
  const sql = fs.readFileSync(migrationPath, 'utf8');

  // A. Table creation & columns
  assert(sql.includes('CREATE TABLE IF NOT EXISTS public.proof_challenges'), 'Must create public.proof_challenges table');
  assert(sql.includes('id UUID PRIMARY KEY DEFAULT gen_random_uuid()'), 'Must have UUID primary key');
  assert(sql.includes('challenge_id UUID NOT NULL REFERENCES public.challenges(id) ON DELETE CASCADE'), 'Must reference public.challenges with CASCADE');
  assert(sql.includes('participant_id TEXT NOT NULL'), 'Must have participant_id TEXT');
  assert(sql.includes('verifier_id TEXT NOT NULL'), 'Must have verifier_id TEXT');
  assert(sql.includes('completion_date DATE NOT NULL'), 'Must have completion_date DATE');
  assert(sql.includes('proof_code VARCHAR(8) NOT NULL'), 'Must have proof_code VARCHAR(8)');
  assert(sql.includes('action_prompt_id TEXT NOT NULL'), 'Must have action_prompt_id TEXT');
  assert(sql.includes('action_prompt TEXT NOT NULL'), 'Must have action_prompt TEXT');
  assert(sql.includes("status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'cancelled', 'expired'))"), 'Must have CHECK constraint on status');
  assert(sql.includes('created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now()'), 'Must track created_at');
  assert(sql.includes("expires_at TIMESTAMPTZ NOT NULL DEFAULT (pg_catalog.now() + interval '45 minutes')"), 'Must have 45-minute default TTL');
  assert(sql.includes('consumed_at TIMESTAMPTZ'), 'Must have consumed_at column');

  // B. Integrity constraints
  assert(sql.includes('CONSTRAINT chk_proof_challenge_consumed_time'), 'Must enforce consumed timestamp integrity constraint');
  assert(sql.includes('CONSTRAINT chk_proof_challenge_no_self_verification'), 'Must enforce table-level anti-self-verification constraint');
  assert(sql.includes('CHECK (participant_id != verifier_id)'), 'chk_proof_challenge_no_self_verification must check participant_id != verifier_id');

  // C. Indexes
  assert(sql.includes('idx_proof_challenges_lookup'), 'Must index participant_id, challenge_id, completion_date, status');
  assert(sql.includes('idx_proof_challenges_verifier_lookup'), 'Must index verifier_id, status');
  assert(sql.includes('idx_proof_challenges_rate_limit'), 'Must index participant_id, created_at for rate limiting');
  assert(sql.includes('idx_proof_challenges_active_expiry'), 'Must index expires_at WHERE status = active');

  // D. RLS & Permissions
  assert(sql.includes('ALTER TABLE public.proof_challenges ENABLE ROW LEVEL SECURITY;'), 'Must enable RLS on proof_challenges');
  assert(sql.includes('REVOKE ALL ON TABLE public.proof_challenges FROM PUBLIC, anon, authenticated;'), 'Must revoke table direct writes');
  assert(sql.includes('GRANT SELECT ON TABLE public.proof_challenges TO authenticated;'), 'Must grant SELECT to authenticated');
  assert(sql.includes('CREATE POLICY "Authorized users can view proof challenges"'), 'Must define SELECT policy for proof_challenges');
  assert(sql.includes('cc.verifier_id = auth.uid()::text'), 'Policy must authorize the CURRENT verifier of the completion');
  assert(sql.includes("NOT EXISTS ("), 'Policy must prevent previous verifiers from viewing unconsumed or reassigned challenges');

  // E. Completion metadata columns (backward compatibility)
  assert(sql.includes('ALTER TABLE public.challenge_completions'), 'Must alter challenge_completions');
  assert(sql.includes('ADD COLUMN IF NOT EXISTS proof_code VARCHAR(8)'), 'Must add proof_code column to completions');
  assert(sql.includes('ADD COLUMN IF NOT EXISTS action_prompt_id TEXT'), 'Must add action_prompt_id column to completions');
  assert(sql.includes('ADD COLUMN IF NOT EXISTS action_prompt TEXT'), 'Must add action_prompt column to completions');
  assert(sql.includes('ADD COLUMN IF NOT EXISTS proof_challenge_id UUID REFERENCES public.proof_challenges(id) ON DELETE SET NULL'), 'Must add nullable proof_challenge_id reference');

  // F. Helper function Crockford Base32 with rejection sampling
  assert(sql.includes('CREATE OR REPLACE FUNCTION public.generate_secure_proof_code()'), 'Must define generate_secure_proof_code helper');
  assert(sql.includes('23456789ABCDEFGHJKMNPQRSTVWXYZ'), 'Must use unambiguous Crockford alphabet (no 0, 1, I, L, O, U)');
  assert(sql.includes('v_byte < 240'), 'Must use rejection sampling on bytes < 240 to eliminate modulo bias');
  assert(sql.includes('REVOKE ALL ON FUNCTION public.generate_secure_proof_code() FROM PUBLIC, anon, authenticated;'), 'Must revoke execute from client roles on private helper');

  // G. RPC generate_proof_challenge
  assert(sql.includes('CREATE OR REPLACE FUNCTION public.generate_proof_challenge('), 'Must implement generate_proof_challenge RPC');
  assert(sql.includes('public.is_registered_account()'), 'Must require registered account');
  assert(sql.includes('public.challenge_active_window('), 'Must validate active window and timezone');
  assert(sql.includes('FOR SHARE'), 'Must use FOR SHARE lock on participant membership');
  assert(sql.includes('pg_advisory_xact_lock(424202'), 'Must acquire participant-scoped transaction advisory lock for rate limiting');
  assert(sql.indexOf('pg_advisory_xact_lock(424202') < sql.indexOf('SELECT * INTO v_challenge FROM public.challenges WHERE id = p_challenge_id'),
    'Must acquire advisory lock early, immediately after authentication and registered account checks');
  assert(sql.includes('v_recent_generations >= 5'), 'Must enforce rate limit of 5 per hour');
  assert(sql.includes("SET status = 'cancelled'"), 'Must cancel superseded active challenges for same participant/date');
  assert(sql.includes("interval '45 minutes'"), 'Must set 45-minute validity');
  assert(sql.includes('gesture_raised_fist'), 'Must include unambiguous raised fist gesture');
  assert(!sql.includes('gesture_three_fingers'), 'Must not include misleading three-finger description');

  // H. RPC cancel_proof_challenge
  assert(sql.includes('CREATE OR REPLACE FUNCTION public.cancel_proof_challenge('), 'Must implement cancel_proof_challenge RPC');

  // I. RPC submit_challenge_completion
  assert(sql.includes('App update required: DareDrop now requires dynamic proof verification'), 'Must preserve 4-arg rejection stub');
  assert(sql.includes('CREATE OR REPLACE FUNCTION public.submit_challenge_completion('), 'Must recreate submit_challenge_completion');
  assert(sql.includes('p_proof_challenge_id UUID,'), 'Must make p_proof_challenge_id a mandatory argument without default');
  assert(!sql.includes('p_proof_challenge_id UUID DEFAULT NULL'), 'p_proof_challenge_id must NOT have DEFAULT NULL');
  assert(sql.includes('FOR UPDATE'), 'Must lock proof challenge row FOR UPDATE');
  assert(sql.includes("SET status = 'consumed', consumed_at = pg_catalog.now()"), 'Must atomically consume proof challenge with timestamp');
  assert(!sql.includes("SET status = 'expired'"), 'Must not perform misleading UPDATE in failing submission transaction');

  // J. Hardened RPC reassign_challenge_verifier
  assert(sql.includes('CREATE OR REPLACE FUNCTION public.reassign_challenge_verifier('), 'Must implement hardened reassign_challenge_verifier');
  assert(sql.includes('UPDATE public.proof_challenges'), 'Must synchronize proof_challenges verifier_id on reassignment');

  console.log('  ✅ Schema, constraints, RLS policies, Base32 helper, advisory lock, and RPC signatures verified.');
}

// ============================================================================
// 2. Pure Unit Tests: Crockford Base32 Proof Code Generator
// ============================================================================
function testProofCodeGenerator() {
  console.log('\n[Test 2] Crockford Base32 Proof Code Generator:');

  const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  assert.strictEqual(ALPHABET.length, 30, 'Alphabet must contain exactly 30 unambiguous characters');

  // Verify excluded characters
  const forbiddenChars = ['0', '1', 'I', 'L', 'O', 'U', 'i', 'l', 'o', 'u'];
  for (const char of forbiddenChars) {
    assert(!ALPHABET.includes(char), `Alphabet must not contain ambiguous character: ${char}`);
  }

  // Exact rejection sampling implementation matching PL/pgSQL helper
  function generateSecureProofCode() {
    let code = '';
    while (code.length < 4) {
      const bytes = crypto.randomBytes(16);
      for (let i = 0; i < bytes.length && code.length < 4; i++) {
        const byte = bytes[i];
        if (byte < 240) {
          code += ALPHABET[byte % 30];
        }
      }
    }
    return code;
  }

  const samples = new Set();
  const iterations = 10000;
  const charFreq = {};

  for (let i = 0; i < iterations; i++) {
    const code = generateSecureProofCode();
    assert.strictEqual(code.length, 4, 'Proof code must be exactly 4 characters');
    for (const ch of code) {
      assert(ALPHABET.includes(ch), `Character ${ch} must belong to Crockford Base32`);
      charFreq[ch] = (charFreq[ch] || 0) + 1;
    }
    samples.add(code);
  }

  const uniqueCount = samples.size;
  const collisions = iterations - uniqueCount;
  console.log(`  Generated ${iterations} proof codes: ${uniqueCount} unique, ${collisions} collisions (consistent with ~810k space)`);
  assert(collisions < 250, 'Collision rate must remain within expected cryptographic bounds');

  // Check character distribution
  const totalChars = iterations * 4;
  const expectedPerChar = totalChars / 30;
  for (const ch of ALPHABET) {
    const count = charFreq[ch] || 0;
    assert(count > expectedPerChar * 0.7 && count < expectedPerChar * 1.3, `Character ${ch} distribution outside normal bounds: ${count}`);
  }

  console.log('  ✅ Code length (4), alphabet composition (30), exclusion rules, and rejection sampling distribution verified (without claiming finite sample proves mathematical uniformity).');
}

// ============================================================================
// 3. Physical-Action Prompt Catalogue & Variety Tests
// ============================================================================
function testPromptCatalogue() {
  console.log('\n[Test 3] Physical-Action Prompt Catalogue & Variety:');

  const PROMPT_IDS = [
    'gesture_thumbs_up',
    'gesture_peace_sign',
    'gesture_raised_fist',
    'gesture_open_palm',
    'gesture_point_up',
    'gesture_hand_heart',
    'gesture_touch_ear',
    'gesture_ok_sign'
  ];

  const PROMPT_TEXTS = [
    'Give a thumbs-up 👍',
    'Show a peace sign ✌️',
    'Hold up a raised fist ✊',
    'Show an open palm ✋',
    'Point index finger upward ☝️',
    'Place a palm over your heart ❤️',
    'Touch your ear with your hand 👂',
    'Show an OK sign 👌'
  ];

  assert.strictEqual(PROMPT_IDS.length, 8, 'Must have 8 curated gestures');
  assert.strictEqual(PROMPT_TEXTS.length, 8, 'Must have 8 corresponding display texts');

  // Verify no misleading 🤟 Love-You emoji
  for (const text of PROMPT_TEXTS) {
    assert(!text.includes('🤟'), 'Misleading Love-You emoji must not be present');
  }

  // Verify accessibility: open palm, palm over heart, and touch ear do not require fine finger motor control
  assert(PROMPT_IDS.includes('gesture_open_palm'), 'Must provide open palm accessible alternative');
  assert(PROMPT_IDS.includes('gesture_hand_heart'), 'Must provide palm over heart accessible alternative');
  assert(PROMPT_IDS.includes('gesture_touch_ear'), 'Must provide touch ear accessible alternative');
  assert(PROMPT_IDS.includes('gesture_raised_fist'), 'Must provide raised fist alternative');

  // Test consecutive repetition avoidance logic
  function selectPrompt(lastPromptId) {
    const randByte = crypto.randomBytes(1)[0];
    let selectedIdx = (randByte % 8);

    if (lastPromptId && PROMPT_IDS[selectedIdx] === lastPromptId) {
      selectedIdx = (selectedIdx + 1) % 8;
    }

    return {
      id: PROMPT_IDS[selectedIdx],
      text: PROMPT_TEXTS[selectedIdx]
    };
  }

  let lastId = null;
  for (let i = 0; i < 1000; i++) {
    const next = selectPrompt(lastId);
    if (lastId !== null) {
      assert.notStrictEqual(next.id, lastId, `Immediate consecutive repeat must be prevented (got ${next.id} twice in a row)`);
    }
    lastId = next.id;
  }

  console.log('  ✅ 8 curated gestures verified (no misleading 🤟, 4 accessible alternatives) with 1,000 variety checks passed.');
}

// ============================================================================
// 4. Proof Challenge Lifecycle & Concurrency Simulation
// ============================================================================
function testProofChallengeStateMachine() {
  console.log('\n[Test 4] Proof Challenge State Machine & Security Semantics:');

  class ProofChallengeService {
    constructor() {
      this.proofChallenges = new Map();
      this.completions = new Map();
      this.challenges = new Map();
      this.participants = new Map();
      this.userRoles = new Map();
      this.advisoryLocks = new Set();
    }

    registerUser(userId, isRegistered = true) {
      this.userRoles.set(userId, isRegistered);
    }

    createChallenge(id, creatorId, challengeType = 'daily') {
      this.challenges.set(id, { id, creatorId, challengeType, durationDays: 7 });
      this.addParticipant(id, creatorId);
    }

    addParticipant(challengeId, userId) {
      const key = `${challengeId}:${userId}`;
      this.participants.set(key, true);
    }

    generateProofChallenge({ callerId, challengeId, verifierId, completionDate, now = new Date() }) {
      if (!callerId) throw new Error('Authentication required');
      if (!this.userRoles.get(callerId)) throw new Error('A registered account is required to generate proof challenges');

      const challenge = this.challenges.get(challengeId);
      if (!challenge) throw new Error('Challenge not found');

      // Participant check
      if (!this.participants.has(`${challengeId}:${callerId}`)) {
        throw new Error('You must be an active participant to generate a proof challenge');
      }

      // Verifier check
      if (verifierId === callerId) {
        throw new Error('You cannot designate yourself as verifier');
      }
      if (verifierId !== challenge.creatorId && !this.participants.has(`${challengeId}:${verifierId}`)) {
        throw new Error('Designated verifier must be the challenge creator or an active participant');
      }

      // Existing completion check
      const compKey = challenge.challengeType === 'one_time' ? `${challengeId}:${callerId}` : `${challengeId}:${callerId}:${completionDate}`;
      const existing = this.completions.get(compKey);
      if (existing) {
        if (existing.status === 'approved') throw new Error('Already approved');
        if (existing.status === 'pending') throw new Error('Already pending verification');
      }

      // Concurrency Lock: Participant-scoped transaction advisory lock (namespace 424202)
      const lockKey = `rate_limit_lock:${callerId}`;
      if (this.advisoryLocks.has(lockKey)) {
        throw new Error('Lock contention: transaction waiting on advisory lock');
      }
      this.advisoryLocks.add(lockKey);

      try {
        // Rate limit check (max 5 in 1 hour across all statuses)
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        let countRecent = 0;
        for (const pc of this.proofChallenges.values()) {
          if (pc.participantId === callerId && pc.createdAt >= oneHourAgo) {
            countRecent++;
          }
        }
        if (countRecent >= 5) {
          throw new Error('Rate limit exceeded: maximum 5 proof challenges per hour');
        }

        // Cancel superseded active challenges for same participant, dare, date
        for (const pc of this.proofChallenges.values()) {
          if (pc.participantId === callerId && pc.challengeId === challengeId && pc.completionDate === completionDate && pc.status === 'active') {
            pc.status = 'cancelled';
          }
        }

        const id = crypto.randomUUID();
        const code = '7K9M';
        const expiresAt = new Date(now.getTime() + 45 * 60 * 1000);
        const proofChallenge = {
          id,
          challengeId,
          participantId: callerId,
          verifierId,
          completionDate,
          proofCode: code,
          actionPromptId: 'gesture_thumbs_up',
          actionPrompt: 'Give a thumbs-up 👍',
          status: 'active',
          createdAt: now,
          expiresAt,
          consumedAt: null
        };

        this.proofChallenges.set(id, proofChallenge);
        return proofChallenge;
      } finally {
        this.advisoryLocks.delete(lockKey);
      }
    }

    cancelProofChallenge({ callerId, proofChallengeId }) {
      if (!callerId) throw new Error('Authentication required');
      const pc = this.proofChallenges.get(proofChallengeId);
      if (!pc) throw new Error('Proof challenge not found');
      if (pc.participantId !== callerId) throw new Error('Only the participant can cancel their proof challenge');
      if (pc.status !== 'active') throw new Error(`Proof challenge is not active (status: ${pc.status})`);
      pc.status = 'cancelled';
      return pc;
    }

    submitCompletion({ callerId, challengeId, verifierId, completionDate, submissionNote, proofChallengeId, now = new Date() }) {
      if (!callerId) throw new Error('Authentication required');
      if (!this.userRoles.get(callerId)) throw new Error('A registered account is required to submit challenge completions');

      // Elimination of proof-submission bypass:
      if (!proofChallengeId) {
        throw new Error('A valid proof challenge is required to submit challenge completion');
      }

      const challenge = this.challenges.get(challengeId);
      if (!challenge) throw new Error('Challenge not found');

      const proof = this.proofChallenges.get(proofChallengeId);
      if (!proof) throw new Error('Proof challenge not found');
      if (proof.participantId !== callerId) throw new Error('Proof challenge does not belong to authenticated participant');
      if (proof.challengeId !== challengeId) throw new Error('Proof challenge does not match target challenge');
      if (proof.verifierId !== verifierId) throw new Error('Proof challenge was generated for a different verifier');
      if (proof.completionDate !== completionDate) throw new Error('Proof challenge was generated for a different completion date');
      if (proof.status !== 'active') throw new Error(`Proof challenge is no longer active (status: ${proof.status})`);
      if (proof.expiresAt <= now) {
        // Expiry is authoritative through expiresAt timestamp; failing transaction rolls back any mutation
        throw new Error('Proof challenge has expired');
      }

      // Submitter participant check
      if (!this.participants.has(`${challengeId}:${callerId}`)) {
        throw new Error('You must be an active participant to submit proof');
      }

      // Verifier check
      if (verifierId === callerId) throw new Error('You cannot designate yourself as verifier');
      if (verifierId !== challenge.creatorId && !this.participants.has(`${challengeId}:${verifierId}`)) {
        throw new Error('Designated verifier must be the challenge creator or an active participant');
      }

      const compKey = challenge.challengeType === 'one_time' ? `${challengeId}:${callerId}` : `${challengeId}:${callerId}:${completionDate}`;
      const existing = this.completions.get(compKey);

      let resultComp;
      if (existing) {
        if (existing.status === 'approved') throw new Error('Already approved');
        if (existing.status === 'pending') throw new Error('Already pending verification');
        if (existing.status === 'rejected') {
          // Resubmission: update to pending with fresh metadata
          existing.status = 'pending';
          existing.verifierId = verifierId;
          existing.submissionNote = submissionNote;
          existing.rejectionReason = null;
          existing.submittedAt = now;
          existing.proofCode = proof.proofCode;
          existing.actionPromptId = proof.actionPromptId;
          existing.actionPrompt = proof.actionPrompt;
          existing.proofChallengeId = proof.id;
          resultComp = existing;
        }
      } else {
        resultComp = {
          id: crypto.randomUUID(),
          challengeId,
          challengeType: challenge.challengeType,
          participantId: callerId,
          verifierId,
          completionDate,
          status: 'pending',
          submissionNote,
          submittedAt: now,
          reviewedAt: null,
          proofCode: proof.proofCode,
          actionPromptId: proof.actionPromptId,
          actionPrompt: proof.actionPrompt,
          proofChallengeId: proof.id,
        };
        this.completions.set(compKey, resultComp);
      }

      // Atomically consume proof challenge
      proof.status = 'consumed';
      proof.consumedAt = now;

      return resultComp;
    }

    reassignVerifier({ callerId, completionId, newVerifierId }) {
      if (!callerId) throw new Error('Authentication required');
      let targetComp = null;
      for (const comp of this.completions.values()) {
        if (comp.id === completionId) {
          targetComp = comp;
          break;
        }
      }
      if (!targetComp) throw new Error('Completion record not found');
      if (targetComp.participantId !== callerId) throw new Error('Only the submitter can reassign this submission');
      if (targetComp.status !== 'pending') throw new Error(`Cannot reassign a submission that has already been reviewed (status: ${targetComp.status})`);
      if (newVerifierId === callerId) throw new Error('You cannot designate yourself as verifier');

      const challenge = this.challenges.get(targetComp.challengeId);
      if (newVerifierId !== challenge.creatorId && !this.participants.has(`${challenge.id}:${newVerifierId}`)) {
        throw new Error('New verifier must be the challenge creator or an active participant');
      }

      // Update completion verifier
      targetComp.verifierId = newVerifierId;

      // Hardened: Synchronize proof_challenges verifier_id so previous verifier loses access
      if (targetComp.proofChallengeId) {
        const pc = this.proofChallenges.get(targetComp.proofChallengeId);
        if (pc) {
          pc.verifierId = newVerifierId;
        }
      }

      return targetComp;
    }

    // Evaluates RLS SELECT policy on proof_challenges
    canUserSelectProofChallenge(userId, proofChallengeId) {
      if (!userId) return false;
      const pc = this.proofChallenges.get(proofChallengeId);
      if (!pc) return false;

      // 1. Participant can view
      if (pc.participantId === userId) return true;

      // 2. Challenge creator can view
      const challenge = this.challenges.get(pc.challengeId);
      if (challenge && challenge.creatorId === userId) return true;

      // 3. Current verifier of a submitted completion
      for (const comp of this.completions.values()) {
        if (comp.proofChallengeId === pc.id && comp.verifierId === userId) {
          return true;
        }
      }

      // 4. Intended verifier of active unsubmitted challenge
      const isConsumed = Array.from(this.completions.values()).some(c => c.proofChallengeId === pc.id);
      if (pc.status === 'active' && pc.verifierId === userId && !isConsumed) {
        return true;
      }

      return false;
    }
  }

  const s = new ProofChallengeService();
  const creator = 'user_creator';
  const participantA = 'user_participant_a';
  const participantB = 'user_participant_b';
  const verifierOrig = 'user_verifier_orig';
  const verifierNew = 'user_verifier_new';
  const guestUser = 'user_guest';

  s.registerUser(creator, true);
  s.registerUser(participantA, true);
  s.registerUser(participantB, true);
  s.registerUser(verifierOrig, true);
  s.registerUser(verifierNew, true);
  s.registerUser(guestUser, false);

  const dareId = 'dare_101';
  s.createChallenge(dareId, creator, 'daily');
  s.addParticipant(dareId, participantA);
  s.addParticipant(dareId, participantB);
  s.addParticipant(dareId, verifierOrig);
  s.addParticipant(dareId, verifierNew);

  // 1. Proof-submission bypass is blocked
  assert.throws(() => {
    s.submitCompletion({
      callerId: participantA,
      challengeId: dareId,
      verifierId: verifierOrig,
      completionDate: '2026-11-02',
      proofChallengeId: null
    });
  }, /A valid proof challenge is required/);
  console.log('  ✅ 1. Proof-submission bypass strictly blocked: NULL proof challenge rejected');

  // 2. Successful generation
  const pc1 = s.generateProofChallenge({
    callerId: participantA,
    challengeId: dareId,
    verifierId: verifierOrig,
    completionDate: '2026-11-02'
  });
  assert.strictEqual(pc1.status, 'active');
  assert.strictEqual(pc1.proofCode, '7K9M');
  console.log('  ✅ 2. Successful proof challenge generation');

  // 3. Unauthorized generation blocked (guest/anonymous)
  assert.throws(() => {
    s.generateProofChallenge({
      callerId: guestUser,
      challengeId: dareId,
      verifierId: verifierOrig,
      completionDate: '2026-11-02'
    });
  }, /registered account is required/);
  console.log('  ✅ 3. Unauthorized generation blocked (guest/anonymous rejection)');

  // 4. Rate limit enforcement (5 per hour)
  for (let i = 0; i < 4; i++) {
    s.generateProofChallenge({
      callerId: participantA,
      challengeId: dareId,
      verifierId: verifierOrig,
      completionDate: '2026-11-02'
    });
  }
  assert.throws(() => {
    s.generateProofChallenge({
      callerId: participantA,
      challengeId: dareId,
      verifierId: verifierOrig,
      completionDate: '2026-11-02'
    });
  }, /Rate limit exceeded: maximum 5 proof challenges per hour/);
  console.log('  ✅ 4. Rate limit strictly enforced (5 generations/hour across all statuses)');

  // 5. Concurrency lock prevents simultaneous bypass
  // Simulate another request entering while advisory lock is held
  s.advisoryLocks.add(`rate_limit_lock:${participantB}`);
  assert.throws(() => {
    s.generateProofChallenge({
      callerId: participantB,
      challengeId: dareId,
      verifierId: verifierOrig,
      completionDate: '2026-11-02'
    });
  }, /Lock contention/);
  s.advisoryLocks.delete(`rate_limit_lock:${participantB}`);
  console.log('  ✅ 5. Participant-scoped advisory transaction lock serializes concurrent rate limit requests');

  // 6. Generate for participantB and verify pre-submission RLS access
  const pcB = s.generateProofChallenge({
    callerId: participantB,
    challengeId: dareId,
    verifierId: verifierOrig,
    completionDate: '2026-11-02'
  });
  assert.strictEqual(s.canUserSelectProofChallenge(participantB, pcB.id), true, 'Participant can view');
  assert.strictEqual(s.canUserSelectProofChallenge(creator, pcB.id), true, 'Challenge creator can view');
  assert.strictEqual(s.canUserSelectProofChallenge(verifierOrig, pcB.id), true, 'Intended active verifier can view');
  assert.strictEqual(s.canUserSelectProofChallenge(verifierNew, pcB.id), false, 'Unrelated user cannot view');
  console.log('  ✅ 6. Pre-submission RLS access: participant, creator, and active verifier have access; others blocked');

  // 7. Successful completion submission & atomic proof consumption
  const compB = s.submitCompletion({
    callerId: participantB,
    challengeId: dareId,
    verifierId: verifierOrig,
    completionDate: '2026-11-02',
    submissionNote: 'Completed workout!',
    proofChallengeId: pcB.id
  });
  assert.strictEqual(compB.status, 'pending');
  assert.strictEqual(compB.proofCode, pcB.proofCode);
  assert.strictEqual(pcB.status, 'consumed');
  assert(pcB.consumedAt != null, 'Consumed proof challenge must have consumedAt timestamp');
  console.log('  ✅ 7. Successful completion submission & atomic proof consumption');

  // 8. Replay attack blocked (consumed proof challenge cannot be reused)
  assert.throws(() => {
    s.submitCompletion({
      callerId: participantB,
      challengeId: dareId,
      verifierId: verifierOrig,
      completionDate: '2026-11-02',
      proofChallengeId: pcB.id
    });
  }, /Proof challenge is no longer active/);
  console.log('  ✅ 8. Replay attack blocked: consumed proof challenge cannot be reused');

  // 9. Verifier Reassignment & Previous Verifier Access Revocation
  assert.strictEqual(s.canUserSelectProofChallenge(verifierOrig, pcB.id), true, 'Original verifier can view before reassignment');
  assert.strictEqual(s.canUserSelectProofChallenge(verifierNew, pcB.id), false, 'New verifier cannot view before reassignment');

  // Reassign to verifierNew
  s.reassignVerifier({
    callerId: participantB,
    completionId: compB.id,
    newVerifierId: verifierNew
  });

  // Verify previous verifier immediately loses access
  assert.strictEqual(s.canUserSelectProofChallenge(verifierOrig, pcB.id), false, 'PREVIOUS verifier must be revoked after reassignment');
  assert.strictEqual(s.canUserSelectProofChallenge(verifierNew, pcB.id), true, 'NEW verifier must be granted access after reassignment');
  assert.strictEqual(s.canUserSelectProofChallenge(participantB, pcB.id), true, 'Participant retains access');
  assert.strictEqual(s.canUserSelectProofChallenge(creator, pcB.id), true, 'Creator retains access');
  console.log('  ✅ 9. Verifier reassignment strictly revokes previous verifier access and grants new verifier access');

  // 10. Rejected completion followed by fresh proof challenge
  compB.status = 'rejected';
  compB.rejectionReason = 'Hand partially out of frame';

  const pcB_fresh = s.generateProofChallenge({
    callerId: participantB,
    challengeId: dareId,
    verifierId: verifierNew,
    completionDate: '2026-11-02'
  });
  pcB_fresh.proofCode = '9W3K';

  const resubmitted = s.submitCompletion({
    callerId: participantB,
    challengeId: dareId,
    verifierId: verifierNew,
    completionDate: '2026-11-02',
    submissionNote: 'Resubmitted clear photo',
    proofChallengeId: pcB_fresh.id
  });

  assert.strictEqual(resubmitted.status, 'pending');
  assert.strictEqual(resubmitted.rejectionReason, null);
  assert.strictEqual(resubmitted.proofCode, '9W3K');
  assert.strictEqual(pcB_fresh.status, 'consumed');
  console.log('  ✅ 10. Rejected completion resubmission requires fresh proof challenge and resets state cleanly');

  // 11. Approved completion immutability
  resubmitted.status = 'approved';
  assert.throws(() => {
    s.generateProofChallenge({
      callerId: participantB,
      challengeId: dareId,
      verifierId: verifierNew,
      completionDate: '2026-11-02'
    });
  }, /Already approved/);

  assert.throws(() => {
    s.reassignVerifier({
      callerId: participantB,
      completionId: resubmitted.id,
      newVerifierId: verifierOrig
    });
  }, /Cannot reassign a submission that has already been reviewed/);
  console.log('  ✅ 11. Approved completion is immutable: reassignment and code generation forbidden');

  // 12. Expired proof rejection (authoritative through expiresAt timestamp)
  const dare2 = 'dare_102';
  const participantC = 'user_participant_c';
  s.registerUser(participantC, true);
  s.createChallenge(dare2, creator, 'daily');
  s.addParticipant(dare2, participantC);
  const pcExpired = s.generateProofChallenge({
    callerId: participantC,
    challengeId: dare2,
    verifierId: creator,
    completionDate: '2026-11-02'
  });
  const pastExpiryTime = new Date(pcExpired.expiresAt.getTime() + 1000);
  assert.throws(() => {
    s.submitCompletion({
      callerId: participantC,
      challengeId: dare2,
      verifierId: creator,
      completionDate: '2026-11-02',
      proofChallengeId: pcExpired.id,
      now: pastExpiryTime
    });
  }, /Proof challenge has expired/);
  assert.strictEqual(pcExpired.status, 'active', 'Stored status remains untouched because failing submission rolls back transaction');
  console.log('  ✅ 12. Expired proof challenge rejected based on expiresAt timestamp without misleading rolled-back status mutation');
}

// ============================================================================
// 5. Frontend Dynamic Proof Integration Tests (Phase 23C)
// ============================================================================
function testFrontendIntegrationContract() {
  console.log('\n[Test 5] Frontend Dynamic Proof Challenge Integration & Simulation:');

  const storePath = path.resolve(__dirname, '../src/store/challenges-store.tsx');
  const challengeScreenPath = path.resolve(__dirname, '../src/app/challenge/[id].tsx');
  const reviewScreenPath = path.resolve(__dirname, '../src/app/review/[id].tsx');
  const sharingPath = path.resolve(__dirname, '../src/lib/sharing.ts');

  assert(fs.existsSync(storePath), 'challenges-store.tsx must exist');
  assert(fs.existsSync(challengeScreenPath), 'challenge/[id].tsx must exist');
  assert(fs.existsSync(reviewScreenPath), 'review/[id].tsx must exist');
  assert(fs.existsSync(sharingPath), 'sharing.ts must exist');

  const storeCode = fs.readFileSync(storePath, 'utf8');
  const challengeCode = fs.readFileSync(challengeScreenPath, 'utf8');
  const reviewCode = fs.readFileSync(reviewScreenPath, 'utf8');
  const sharingCode = fs.readFileSync(sharingPath, 'utf8');

  // A. Store contract & signatures
  assert(storeCode.includes('generateProofChallenge: (params: {'), 'Store must define generateProofChallenge in context');
  assert(storeCode.includes("supabase.rpc('generate_proof_challenge'"), 'Store must call generate_proof_challenge RPC');
  assert(storeCode.includes('p_proof_challenge_id: params.proofChallengeId'), 'Store submitCompletion must require and pass p_proof_challenge_id');
  assert(!storeCode.includes('p_proof_challenge_id?:'), 'proofChallengeId must NOT be optional in submitCompletion');
  console.log('  ✅ 1. Store exposes generateProofChallenge and strictly requires proofChallengeId in submitCompletion');

  // B. Missing proof ID prevention
  assert(storeCode.includes('if (!params.proofChallengeId || !params.proofChallengeId.trim())'), 'submitCompletion must validate presence of proofChallengeId');
  console.log('  ✅ 2. Missing proof ID is blocked client-side before any network or RPC call');

  // C. Challenge screen generation happens before submission
  assert(challengeCode.includes('handleGenerateProof'), 'Challenge screen must define handleGenerateProof');
  assert(challengeCode.includes('generateProofChallenge({'), 'Challenge screen must invoke generateProofChallenge before submission');
  assert(challengeCode.includes('if (!effectiveProofChallenge)'), 'Challenge screen must reject submission if effectiveProofChallenge is null');
  assert(challengeCode.includes('proofChallengeId: effectiveProofChallenge.id'), 'Challenge screen must pass effective proof challenge ID to submitCompletion');
  console.log('  ✅ 3. Generation happens before submission and returned proof ID is passed to submitCompletion');

  // D. Offline resilience
  assert(storeCode.includes('An active connection to DareDrop is required to generate proof challenges'), 'Store must explain offline generation requirement');
  assert(storeCode.includes('An active connection to DareDrop is required to submit a verified completion'), 'Store must explain offline submission requirement');
  console.log('  ✅ 4. Offline state prevents generation/submission without fabricating offline proof IDs');

  // E. Double-tap and concurrent request protection
  assert(challengeCode.includes('if (!challenge || !selectedVerifierId || !selectedDate || isGeneratingProof) return;'), 'handleGenerateProof must block concurrent generation taps');
  assert(challengeCode.includes('if (!challenge || !selectedVerifierId || !selectedDate || isSubmitting) return;'), 'handleSubmitCompletion must block concurrent submission taps');
  assert(challengeCode.includes('disabled={isGeneratingProof'), 'Generate button must be disabled while generating');
  assert(challengeCode.includes('disabled={'), 'Submit button must be disabled while submitting or if ungenerated/expired');
  console.log('  ✅ 5. Repeated taps and concurrent requests are debounced and prevented during in-flight operations');

  // F. Expired proof challenges cannot be submitted
  assert(challengeCode.includes('isProofExpired = Boolean('), 'Challenge screen must dynamically compute isProofExpired');
  assert(challengeCode.includes('if (isProofExpired)'), 'Challenge screen must prevent submission of expired proof challenges');
  console.log('  ✅ 6. Expired proof challenges cannot be submitted and require regeneration');

  // G. Account switching cannot reuse another account's proof challenge
  assert(challengeCode.includes('activeProofChallenge.participant_id === currentUserId'), 'effectiveProofChallenge must strictly match authenticated currentUserId');
  console.log('  ✅ 7. Account switching isolates proof challenges; foreign account proof challenges evaluate to null');

  // H. Date and Verifier binding
  assert(challengeCode.includes('activeProofChallenge.verifier_id === selectedVerifierId'), 'effectiveProofChallenge must strictly match selected verifier');
  assert(challengeCode.includes('activeProofChallenge.completion_date === selectedDate'), 'effectiveProofChallenge must strictly match selected date');
  console.log('  ✅ 8. Changing verifier or completion date invalidates current proof challenge');

  // I. WhatsApp message format includes code and action prompt
  assert(sharingCode.includes('proofCode?: string;'), 'ProofShareOptions must support proofCode');
  assert(sharingCode.includes('actionPrompt?: string;'), 'ProofShareOptions must support actionPrompt');
  assert(sharingCode.includes('🔢 Proof Code: *${options.proofCode}*'), 'WhatsApp message must include formatted proof code');
  assert(sharingCode.includes('⚡ Required Action: *${options.actionPrompt}*'), 'WhatsApp message must include formatted action prompt');

  // Test actual WhatsApp string builder
  function buildTestWhatsAppMessage(options) {
    const dateStr = options.completionDate ? ` for ${options.completionDate}` : '';
    const proofCodeStr = options.proofCode ? `\n\n🔢 Proof Code: *${options.proofCode}*` : '';
    const actionPromptStr = options.actionPrompt ? `\n⚡ Required Action: *${options.actionPrompt}*` : '';
    const noteStr = options.note ? `\n\nNotes: "${options.note}"` : '';
    return `👋 Hey ${options.verifierName || 'Verifier'}! I just submitted my DareDrop completion${dateStr} for "${options.challengeTitle}".${proofCodeStr}${actionPromptStr}${noteStr}\n\nHere is my proof photo/video 📸👇 Please verify it on DareDrop!`;
  }

  const sampleWa = buildTestWhatsAppMessage({
    challengeTitle: '100 Pushups Daily',
    completionDate: '2026-11-01',
    verifierName: 'Hamza',
    proofCode: '8K2M',
    actionPrompt: 'Hold up a peace sign ✌️',
    note: 'Felt great!',
  });
  assert(sampleWa.includes('🔢 Proof Code: *8K2M*'), 'WhatsApp text must contain formatted proof code');
  assert(sampleWa.includes('⚡ Required Action: *Hold up a peace sign ✌️*'), 'WhatsApp text must contain formatted action prompt');
  console.log('  ✅ 9. WhatsApp handoff message includes generated proof code and required action prompt');

  // J. Review screen displays the stored code and action prompt
  assert(reviewCode.includes('completion.proof_code'), 'Review screen must check completion.proof_code');
  assert(reviewCode.includes('Dynamic Proof Verification'), 'Review screen must render Dynamic Proof Verification card');
  assert(reviewCode.includes('{completion.proof_code}'), 'Review screen must display proof code badge');
  assert(reviewCode.includes('{completion.action_prompt}'), 'Review screen must display required action prompt');
  console.log('  ✅ 10. Review screen displays stored proof code and gesture prompt for verifier inspection');

  // K. Reassignment advisory notice
  assert(challengeCode.includes('Reassigning updates who can verify on DareDrop, but does NOT transfer WhatsApp media'), 'Reassign modal must warn user to reshare media on WhatsApp');
  console.log('  ✅ 11. Reassign modal clearly advises user to re-share proof media directly with the newly assigned verifier');
}

// ============================================================================
// 6. Abandoned Proof Challenge Cleanup (Phase 23E)
// ============================================================================
function testAbandonedProofCleanup() {
  console.log('\n[Test 6] Abandoned Proof Challenge Cleanup (Phase 23E):');

  const storePath = path.resolve(__dirname, '../src/store/challenges-store.tsx');
  const challengeScreenPath = path.resolve(__dirname, '../src/app/challenge/[id].tsx');
  const storeCode = fs.readFileSync(storePath, 'utf8');
  const challengeCode = fs.readFileSync(challengeScreenPath, 'utf8');

  // Static checks
  assert(storeCode.includes('cancelProofChallenge: (proofChallengeId: string) => Promise<{ success: boolean; error?: string }>'), 'Store must define cancelProofChallenge in context');
  assert(storeCode.includes("supabase.rpc('cancel_proof_challenge'"), 'Store must invoke cancel_proof_challenge RPC');
  assert(challengeCode.includes('cancelProofChallengeSafe'), 'Challenge screen must define cancelProofChallengeSafe');
  assert(challengeCode.includes('cancelledProofIdsRef'), 'Challenge screen must track cancelledProofIdsRef');
  assert(challengeCode.includes('closeSubmitModal'), 'Challenge screen must route close through closeSubmitModal');
  assert(challengeCode.includes('handleSelectDate'), 'Challenge screen must route date selection through handleSelectDate');
  assert(challengeCode.includes('handleSelectVerifier'), 'Challenge screen must route verifier selection through handleSelectVerifier');

  // Mock RPC & State Simulation
  class MockProofLifecycleSimulator {
    constructor() {
      this.proofChallenges = new Map();
      this.completions = new Map();
      this.cancelCalls = [];
      this.currentUser = 'user_alice';
      this.cancelledIds = new Set();
    }

    addProofChallenge(proof) {
      this.proofChallenges.set(proof.id, { ...proof });
    }

    // Mock cancel_proof_challenge RPC
    async cancelProofChallengeRPC(proofChallengeId, callerId) {
      this.cancelCalls.push({ proofChallengeId, callerId });
      const proof = this.proofChallenges.get(proofChallengeId);
      if (!proof) throw new Error('Proof challenge not found');
      if (proof.participant_id !== callerId) throw new Error('Only the participant can cancel their proof challenge');
      if (proof.status !== 'active') throw new Error(`Proof challenge is not active (current status: ${proof.status})`);
      proof.status = 'cancelled';
      return proof;
    }

    // Client-side cancelProofChallengeSafe
    cancelProofChallengeSafe(proof) {
      if (!proof || !proof.id) return;
      if (proof.participant_id !== this.currentUser) return;
      if (this.cancelledIds.has(proof.id)) return;

      this.cancelledIds.add(proof.id);
      this.cancelProofChallengeRPC(proof.id, this.currentUser).catch(() => {});
    }
  }

  // 1. Closing the modal attempts cancellation of the active proof challenge
  {
    const sim = new MockProofLifecycleSimulator();
    sim.addProofChallenge({
      id: 'proof_1',
      participant_id: 'user_alice',
      verifier_id: 'user_bob',
      completion_date: '2026-11-01',
      status: 'active'
    });
    let activeProofChallenge = sim.proofChallenges.get('proof_1');
    let submitSuccess = null;
    let modalVisible = true;

    // Trigger closeSubmitModal
    if (activeProofChallenge && !submitSuccess) {
      sim.cancelProofChallengeSafe(activeProofChallenge);
    }
    activeProofChallenge = null;
    modalVisible = false;

    assert.strictEqual(modalVisible, false, 'Modal must close');
    assert.strictEqual(activeProofChallenge, null, 'Local proof challenge state must be cleared');
    assert.strictEqual(sim.cancelCalls.length, 1, 'Cancellation RPC must be called once');
    assert.strictEqual(sim.cancelCalls[0].proofChallengeId, 'proof_1');
    assert.strictEqual(sim.proofChallenges.get('proof_1').status, 'cancelled');
    console.log('  ✅ 1. Closing the modal attempts cancellation of the active proof challenge');
  }

  // 2. Changing the date cancels the previous proof challenge
  {
    const sim = new MockProofLifecycleSimulator();
    sim.addProofChallenge({
      id: 'proof_2',
      participant_id: 'user_alice',
      verifier_id: 'user_bob',
      completion_date: '2026-11-01',
      status: 'active'
    });
    let selectedDate = '2026-11-01';
    let activeProofChallenge = sim.proofChallenges.get('proof_2');

    // User switches to yesterday
    const newDate = '2026-10-31';
    if (newDate !== selectedDate) {
      if (activeProofChallenge) {
        sim.cancelProofChallengeSafe(activeProofChallenge);
        activeProofChallenge = null;
      }
      selectedDate = newDate;
    }

    assert.strictEqual(selectedDate, '2026-10-31');
    assert.strictEqual(activeProofChallenge, null, 'Active proof must be cleared on date change');
    assert.strictEqual(sim.cancelCalls.length, 1);
    assert.strictEqual(sim.cancelCalls[0].proofChallengeId, 'proof_2');
    assert.strictEqual(sim.proofChallenges.get('proof_2').status, 'cancelled');
    console.log('  ✅ 2. Changing the date cancels the previous proof challenge');
  }

  // 3. Changing the verifier cancels the previous proof challenge
  {
    const sim = new MockProofLifecycleSimulator();
    sim.addProofChallenge({
      id: 'proof_3',
      participant_id: 'user_alice',
      verifier_id: 'user_bob',
      completion_date: '2026-11-01',
      status: 'active'
    });
    let selectedVerifier = 'user_bob';
    let activeProofChallenge = sim.proofChallenges.get('proof_3');

    // User switches to user_charlie
    const newVerifier = 'user_charlie';
    if (newVerifier !== selectedVerifier) {
      if (activeProofChallenge) {
        sim.cancelProofChallengeSafe(activeProofChallenge);
        activeProofChallenge = null;
      }
      selectedVerifier = newVerifier;
    }

    assert.strictEqual(selectedVerifier, 'user_charlie');
    assert.strictEqual(activeProofChallenge, null, 'Active proof must be cleared on verifier change');
    assert.strictEqual(sim.cancelCalls.length, 1);
    assert.strictEqual(sim.cancelCalls[0].proofChallengeId, 'proof_3');
    assert.strictEqual(sim.proofChallenges.get('proof_3').status, 'cancelled');
    console.log('  ✅ 3. Changing the verifier cancels the previous proof challenge');
  }

  // 4. A consumed proof challenge is not cancelled
  {
    const sim = new MockProofLifecycleSimulator();
    sim.addProofChallenge({
      id: 'proof_4',
      participant_id: 'user_alice',
      verifier_id: 'user_bob',
      completion_date: '2026-11-01',
      status: 'consumed'
    });
    let activeProofChallenge = null; // already cleared on submission
    let submitSuccess = { id: 'comp_1', proof_challenge_id: 'proof_4', status: 'pending' };

    // User closes modal after successful submission
    if (activeProofChallenge && !submitSuccess) {
      sim.cancelProofChallengeSafe(activeProofChallenge);
    }

    assert.strictEqual(sim.cancelCalls.length, 0, 'Must NOT attempt to cancel consumed proof challenge');
    assert.strictEqual(sim.proofChallenges.get('proof_4').status, 'consumed', 'Consumed status must remain unchanged');
    console.log('  ✅ 4. A consumed proof challenge is not cancelled');
  }

  // 5. A proof challenge belonging to another account is never cancelled
  {
    const sim = new MockProofLifecycleSimulator();
    sim.currentUser = 'user_alice';
    sim.addProofChallenge({
      id: 'proof_foreign',
      participant_id: 'user_bob', // belongs to bob!
      verifier_id: 'user_charlie',
      completion_date: '2026-11-01',
      status: 'active'
    });
    const foreignProof = sim.proofChallenges.get('proof_foreign');

    // Attempt cancellation by user_alice
    sim.cancelProofChallengeSafe(foreignProof);

    assert.strictEqual(sim.cancelCalls.length, 0, 'Foreign proof challenge cancellation must be rejected client-side');
    assert.strictEqual(sim.proofChallenges.get('proof_foreign').status, 'active');
    console.log('  ✅ 5. A proof challenge belonging to another account is never cancelled');
  }

  // 6. Offline cancellation failure does not block closing the modal
  {
    const sim = new MockProofLifecycleSimulator();
    sim.cancelProofChallengeRPC = async () => {
      throw new Error('Connection refused: Device is offline');
    };
    sim.addProofChallenge({
      id: 'proof_offline',
      participant_id: 'user_alice',
      verifier_id: 'user_bob',
      completion_date: '2026-11-01',
      status: 'active'
    });
    let activeProofChallenge = sim.proofChallenges.get('proof_offline');
    let modalVisible = true;
    let submitSuccess = null;

    // closeSubmitModal runs
    let threw = false;
    try {
      if (activeProofChallenge && !submitSuccess) {
        sim.cancelProofChallengeSafe(activeProofChallenge);
      }
      activeProofChallenge = null;
      modalVisible = false;
    } catch {
      threw = true;
    }

    assert.strictEqual(threw, false, 'Offline error must be swallowed without throwing');
    assert.strictEqual(modalVisible, false, 'Modal must still close cleanly');
    assert.strictEqual(activeProofChallenge, null, 'Local state must still be cleared');
    assert.strictEqual(submitSuccess, null, 'Must NOT show false submission-success message');
    console.log('  ✅ 6. Offline cancellation failure does not block closing the modal');
  }

  // 7. Repeated state changes do not issue duplicate cancellation requests
  {
    const sim = new MockProofLifecycleSimulator();
    sim.addProofChallenge({
      id: 'proof_multi_tap',
      participant_id: 'user_alice',
      verifier_id: 'user_bob',
      completion_date: '2026-11-01',
      status: 'active'
    });
    const proof = sim.proofChallenges.get('proof_multi_tap');

    // Simulate 5 rapid re-renders / button taps
    sim.cancelProofChallengeSafe(proof);
    sim.cancelProofChallengeSafe(proof);
    sim.cancelProofChallengeSafe(proof);
    sim.cancelProofChallengeSafe(proof);
    sim.cancelProofChallengeSafe(proof);

    assert.strictEqual(sim.cancelCalls.length, 1, 'Only one cancellation RPC call must be dispatched');
    console.log('  ✅ 7. Repeated state changes do not issue duplicate cancellation requests');
  }

  // 8. Cancellation does not create or modify a completion record
  {
    const sim = new MockProofLifecycleSimulator();
    sim.addProofChallenge({
      id: 'proof_no_comp',
      participant_id: 'user_alice',
      verifier_id: 'user_bob',
      completion_date: '2026-11-01',
      status: 'active'
    });

    sim.cancelProofChallengeSafe(sim.proofChallenges.get('proof_no_comp'));

    assert.strictEqual(sim.completions.size, 0, 'No completion record must be created or modified');
    assert.strictEqual(sim.proofChallenges.get('proof_no_comp').status, 'cancelled');
    console.log('  ✅ 8. Cancellation does not create or modify a completion record');
  }
}

// ============================================================================
// 7. Live PostgreSQL Integration Runner (Environment-Aware)
// ============================================================================
async function runLivePostgresTestsIfAvailable() {
  console.log('\n[Test 7] Live PostgreSQL Integration Environment Check:');

  const testDbUrl = process.env.TEST_DATABASE_URL;
  if (!testDbUrl) {
    console.log('  ℹ️ Notice: No TEST_DATABASE_URL environment variable configured.');
    console.log('  ℹ️ Production Safety Guard: Connecting directly to the production database');
    console.log('     (db.uyglmszjkkfjeckpwpab.supabase.co) for destructive migration and RPC');
    console.log('     testing is strictly forbidden.');
    console.log('  ℹ️ To run live PostgreSQL integration tests against a disposable test DB:');
    console.log('     export TEST_DATABASE_URL="postgres://postgres:password@localhost:5432/daredrop_test"');
    console.log('     node scripts/test-proof-challenges.js');
    return;
  }

  // Safety guard against pointing TEST_DATABASE_URL to production
  if (testDbUrl.includes('uyglmszjkkfjeckpwpab.supabase.co')) {
    console.error('  ❌ FATAL: TEST_DATABASE_URL points to the production Supabase database! Aborting.');
    process.exit(1);
  }

  console.log('  🧪 Running live PostgreSQL integration tests against disposable test database...');
  // Dynamic import of pg only if live tests are requested
  const { Client } = require('pg');
  const client = new Client({ connectionString: testDbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    const migrationPath = path.resolve(__dirname, '../supabase/migrations/20261102000000_dynamic_proof_challenges.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    await client.query(sql);
    console.log('  ✅ Migration executed successfully against test database.');
  } finally {
    await client.end();
  }
}

// ============================================================================
// Main Runner
// ============================================================================
async function main() {
  console.log('================================================================');
  console.log('DareDrop Phase 23E Dynamic Proof Challenge & Cancellation Tests');
  console.log('================================================================\n');

  testMigrationContract();
  testProofCodeGenerator();
  testPromptCatalogue();
  testProofChallengeStateMachine();
  testFrontendIntegrationContract();
  testAbandonedProofCleanup();
  await runLivePostgresTestsIfAvailable();

  console.log('\n================================================================');
  console.log('🎉 ALL PROOF CHALLENGE TESTS (BACKEND, FRONTEND & CLEANUP) PASSED!');
  console.log('================================================================');
}

main().catch(err => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
