/**
 * Pure helpers for the peer-review (verifier) experience.
 *
 * This module intentionally has no runtime imports so it can be unit-tested from plain Node
 * (scripts/test-peer-verification.js transpiles it with TypeScript). Authorization is enforced
 * server-side by RLS on public.challenge_completions and by public.review_challenge_completion;
 * the filtering here is only for presentation and never a substitute for those checks.
 */
import type { DbCompletion } from './supabase';

export type ReviewDecision = 'approved' | 'rejected';

export const MAX_REJECTION_REASON_LENGTH = 280;

export interface ReviewChallengeInfo {
  id: string;
  title: string;
  creatorId?: string | null;
  creator?: string;
}

export interface PendingReview {
  completion: DbCompletion;
  challengeTitle: string;
  participantName: string;
  isResubmission?: boolean;
}

export interface ReviewRpcArgs {
  p_completion_id: string;
  p_decision: ReviewDecision;
  p_rejection_reason: string | null;
}

/**
 * Display name for a participant. There is no profiles table, so this mirrors the label produced by
 * public.get_challenge_eligible_verifiers ('Participant ' || first 6 chars of the user id), and uses the
 * challenge's creator_name when the participant is the creator.
 */
export function participantDisplayName(
  participantId: string,
  challenge?: Pick<ReviewChallengeInfo, 'creatorId' | 'creator'> | null,
): string {
  if (challenge?.creatorId && participantId === challenge.creatorId && challenge.creator) {
    return challenge.creator;
  }
  return `Participant ${participantId.slice(0, 6)}`;
}

/**
 * True when the given user is the assigned verifier of a still-pending submission they did not submit.
 * Mirrors the server rules so the UI only offers actions the server would accept.
 */
export function canUserReview(completion: DbCompletion | null | undefined, userId: string): boolean {
  if (!completion || !userId) return false;
  return (
    completion.status === 'pending' &&
    completion.verifier_id === userId &&
    completion.participant_id !== userId
  );
}

/**
 * Builds the Pending Reviews list: only pending submissions assigned to the current user,
 * never the user's own submissions, oldest first (fair review order).
 */
export function buildPendingReviews(
  completions: DbCompletion[],
  challengesById: Record<string, ReviewChallengeInfo | undefined>,
  currentUserId: string,
): PendingReview[] {
  return completions
    .filter((c) => canUserReview(c, currentUserId))
    .sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at))
    .map((completion) => {
      const challenge = challengesById[completion.challenge_id];
      return {
        completion,
        challengeTitle: challenge?.title || 'Challenge',
        participantName: participantDisplayName(completion.participant_id, challenge),
        isResubmission: isResubmission(completion),
      };
    });
}

/**
 * Splits RLS-visible completions for one challenge into the user's own submissions and
 * submissions the user has been asked to review.
 */
export function splitCompletionsForUser(
  completions: DbCompletion[],
  userId: string,
): { mine: DbCompletion[]; toReview: DbCompletion[] } {
  if (!userId) return { mine: completions, toReview: [] };
  return {
    mine: completions.filter((c) => c.participant_id === userId),
    toReview: completions.filter((c) => canUserReview(c, userId)),
  };
}

/**
 * Exact argument object for public.review_challenge_completion(p_completion_id, p_decision, p_rejection_reason).
 * The reason is only sent for rejections; a blank reason is sent as NULL so the server applies its default.
 */
export function buildReviewRpcArgs(
  completionId: string,
  decision: ReviewDecision,
  rejectionReason?: string | null,
): ReviewRpcArgs {
  if (!completionId) {
    throw new Error('A completion id is required to review a submission.');
  }
  if (decision !== 'approved' && decision !== 'rejected') {
    throw new Error('Decision must be approved or rejected.');
  }
  const trimmed = (rejectionReason || '').trim().slice(0, MAX_REJECTION_REASON_LENGTH);
  return {
    p_completion_id: completionId,
    p_decision: decision,
    p_rejection_reason: decision === 'rejected' && trimmed ? trimmed : null,
  };
}

/** Maps errors raised by review_challenge_completion to user-facing messages. */
export function translateReviewError(error: { code?: string; message?: string } | null | undefined): string {
  const message = error?.message || '';
  switch (error?.code) {
    case '42501':
      if (message.includes('Authentication')) return 'Please sign in again to review submissions.';
      if (message.includes('own submissions')) return 'You cannot verify your own submission.';
      if (message.includes('no longer an active participant or creator')) {
        return 'You are no longer a member of this challenge, so you cannot review it.';
      }
      if (message.includes('Submitter is no longer')) {
        return 'The participant has left this challenge, so this submission can no longer be reviewed.';
      }
      return 'Only the assigned verifier can review this submission.';
    case '22000':
      return 'This submission has already been reviewed.';
    case 'P0002':
      return 'This submission no longer exists.';
    case '22023':
      return message || 'Invalid review decision.';
    default:
      return message || 'Failed to submit your review. Please try again.';
  }
}

/** Short, locale-aware "submitted" label, e.g. "24 Oct, 12:43". */
export function formatSubmittedAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 48-hour resubmission grace window constants. */
export const RESUBMISSION_GRACE_PERIOD_HOURS = 48;
export const RESUBMISSION_GRACE_PERIOD_MS = RESUBMISSION_GRACE_PERIOD_HOURS * 60 * 60 * 1000;

export interface ResubmissionGraceStatus {
  isExpired: boolean;
  isUnverifiable: boolean;
  hoursRemaining: number;
  minutesRemaining: number;
  label: string;
  formattedDeadline: string;
}

/**
 * Determines whether a completion represents a resubmission (i.e. has archived
 * previous rejection reason, or distinct initial submission timestamp).
 */
export function isResubmission(
  completion:
    | Pick<DbCompletion, 'status' | 'last_rejection_reason' | 'first_submitted_at' | 'submitted_at'>
    | null
    | undefined,
): boolean {
  if (!completion) return false;
  if (completion.last_rejection_reason && completion.last_rejection_reason.trim().length > 0) {
    return true;
  }
  if (
    completion.first_submitted_at &&
    completion.submitted_at &&
    completion.first_submitted_at !== completion.submitted_at
  ) {
    return true;
  }
  return false;
}

/**
 * Calculates the status of the 48-hour resubmission grace window relative to
 * when the submission was rejected (reviewed_at).
 * Informational display only; PostgreSQL remains authoritative.
 */
export function getResubmissionGraceStatus(
  reviewedAt: string | null | undefined,
  nowMs: number = Date.now(),
): ResubmissionGraceStatus {
  if (!reviewedAt || typeof reviewedAt !== 'string' || reviewedAt.trim() === '') {
    return {
      isExpired: true,
      isUnverifiable: true,
      hoursRemaining: 0,
      minutesRemaining: 0,
      label: 'Rejection timestamp unavailable',
      formattedDeadline: '—',
    };
  }

  const reviewedTime = Date.parse(reviewedAt);
  if (Number.isNaN(reviewedTime) || reviewedTime <= 0) {
    return {
      isExpired: true,
      isUnverifiable: true,
      hoursRemaining: 0,
      minutesRemaining: 0,
      label: 'Rejection timestamp invalid',
      formattedDeadline: '—',
    };
  }

  const deadlineTime = reviewedTime + RESUBMISSION_GRACE_PERIOD_MS;
  const remainingMs = deadlineTime - nowMs;

  // Exact 48-hour boundary matching PostgreSQL strict rule:
  // reviewed_at < now() - INTERVAL '48 hours' <=> now() - reviewed_at > 48 hours (remainingMs < 0).
  // At 48h - 1ms: active (isExpired = false).
  // At exactly 48h: active (remainingMs = 0, isExpired = false).
  // At 48h + 1ms: expired (remainingMs = -1ms < 0, isExpired = true).
  const isExpired = remainingMs < 0;

  const deadlineDate = new Date(deadlineTime);
  const formattedDeadline = Number.isNaN(deadlineDate.getTime())
    ? '—'
    : deadlineDate.toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });

  if (isExpired) {
    return {
      isExpired: true,
      isUnverifiable: false,
      hoursRemaining: 0,
      minutesRemaining: 0,
      label: 'Resubmission window expired',
      formattedDeadline,
    };
  }

  const totalMinutes = Math.floor(remainingMs / (60 * 1000));
  const hoursRemaining = Math.floor(totalMinutes / 60);
  const minutesRemaining = totalMinutes % 60;

  let label = '';
  if (hoursRemaining >= 1) {
    label = `${hoursRemaining}h remaining to resubmit`;
  } else if (minutesRemaining > 0) {
    label = `${minutesRemaining}m remaining to resubmit`;
  } else {
    label = '< 1m remaining to resubmit';
  }

  return {
    isExpired: false,
    isUnverifiable: false,
    hoursRemaining,
    minutesRemaining,
    label,
    formattedDeadline,
  };
}

/** Short, locale-aware "reviewed" label, e.g. "24 Oct, 12:43". */
export function formatReviewedAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
