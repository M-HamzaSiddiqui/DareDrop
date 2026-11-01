import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CATEGORY_COLORS,
  CategoryKey,
  DD_COLORS,
  DD_RADII,
  DD_SPACING,
} from '@/constants/dd-theme';
import { Challenge } from '@/data/challenges';
import { DDButton } from '@/components/ui/dd-button';
import { DDCard } from '@/components/ui/dd-card';
import { DDIcon, type DDIconName } from '@/components/ui/dd-icon';
import { DDText } from '@/components/ui/dd-text';
import { useAuth } from '@/lib/auth-context';
import { buildCompletionsChannelName, subscribeToCompletions } from '@/lib/realtime';
import {
  canUserReview,
  formatSubmittedAt,
  MAX_REJECTION_REASON_LENGTH,
  participantDisplayName,
} from '@/lib/reviews';
import { DbCompletion, isSupabaseConfigured, supabase } from '@/lib/supabase';
import { useChallenges } from '@/store/challenges-store';

const CATEGORY_ICONS: Record<CategoryKey, DDIconName> = {
  Fitness: 'flame',
  Focus: 'target',
  Fun: 'sparkle',
  Learning: 'compass',
};

/**
 * DareDrop Redesigned Peer Review Detail Screen.
 *
 * Implements:
 * - Dark-first DareDrop visual language with neon lime & electric violet accents.
 * - Clear verification status indicators (Pending, Approved, Rejected).
 * - Challenge context card with signature category tints.
 * - Submitter identity, submission timestamp, calendar dare date, and challenger note.
 * - Peer-to-peer WhatsApp proof verification advisory.
 * - Prominent Approve action with duplicate-submission protection.
 * - Secondary Reject action with modal reason input and character counter.
 * - Realtime completion status synchronization and error recovery.
 */
export default function ReviewDetailsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const {
    currentUserId,
    pendingReviews,
    fetchCompletionById,
    fetchChallengeById,
    reviewCompletion,
    refreshChallenges,
    refreshPendingReviews,
  } = useChallenges();
  const { isGuest, showAuthModal } = useAuth();

  const [loading, setLoading] = useState(true);
  const [completion, setCompletion] = useState<DbCompletion | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Review action state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Rejection modal state
  const [rejectModalVisible, setRejectModalVisible] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');

  useEffect(() => {
    let isMounted = true;
    if (!id) return;

    fetchCompletionById(id)
      .then(async (comp) => {
        if (!isMounted) return;
        if (!comp) {
          setFetchError('Submission not found or you are not authorized to view it.');
          setLoading(false);
          return;
        }
        setCompletion(comp);
        if (comp.challenge_id) {
          try {
            const chal = await fetchChallengeById(comp.challenge_id);
            if (isMounted) {
              setChallenge(chal);
            }
          } catch {
            // Non-fatal
          }
        }
        if (isMounted) {
          setLoading(false);
        }
      })
      .catch((err: any) => {
        if (isMounted) {
          setFetchError(err?.message || 'Failed to load submission details.');
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [id, fetchCompletionById, fetchChallengeById]);

  // Realtime subscription for this specific completion
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !id) return;

    const channelName = buildCompletionsChannelName('review-completion', id, currentUserId);
    const unsubscribe = subscribeToCompletions({
      supabase,
      channelName,
      filter: `id=eq.${id}`,
      debounceMs: 150,
      onEvent: async () => {
        try {
          const updated = await fetchCompletionById(id);
          if (updated) {
            setCompletion(updated);
          }
        } catch {
          // Ignore
        }
      },
    });

    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        fetchCompletionById(id)
          .then((c) => {
            if (c) setCompletion(c);
          })
          .catch(() => {});
      }
    });

    return () => {
      appStateSub.remove();
      unsubscribe();
    };
  }, [id, currentUserId, fetchCompletionById]);

  function handleBack() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }

  async function handleApprove() {
    if (!completion || isSubmitting) return;
    if (isGuest) {
      showAuthModal({
        title: 'Account Required',
        description: 'Sign in or register to verify participant dares.',
      });
      return;
    }
    setIsSubmitting(true);
    setActionError(null);
    try {
      const result = await reviewCompletion({
        completionId: completion.id,
        decision: 'approved',
      });
      if (!result.success || !result.completion) {
        setActionError(result.error || 'Failed to approve submission.');
        return;
      }
      setCompletion(result.completion);
      setActionSuccess('✓ Submission approved! The participant’s streak and progress have been updated.');
      await Promise.all([refreshChallenges(), refreshPendingReviews()]);
    } catch (err: any) {
      setActionError(err?.message || 'An unexpected error occurred.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function openRejectModal() {
    if (isGuest) {
      showAuthModal({
        title: 'Account Required',
        description: 'Sign in or register to review completions.',
      });
      return;
    }
    setRejectionReason('');
    setActionError(null);
    setRejectModalVisible(true);
  }

  async function handleConfirmReject() {
    if (!completion || isSubmitting) return;
    setIsSubmitting(true);
    setActionError(null);
    try {
      const reason = rejectionReason.trim() || undefined;
      const result = await reviewCompletion({
        completionId: completion.id,
        decision: 'rejected',
        rejectionReason: reason,
      });
      if (!result.success || !result.completion) {
        setActionError(result.error || 'Failed to reject submission.');
        return;
      }
      setCompletion(result.completion);
      setRejectModalVisible(false);
      setActionSuccess('Submission rejected. The participant can resubmit with updated proof.');
      await Promise.all([refreshChallenges(), refreshPendingReviews()]);
    } catch (err: any) {
      setActionError(err?.message || 'An unexpected error occurred.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (loading) {
    return (
      <View style={[styles.root, styles.centerContainer]}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color={DD_COLORS.lime} />
        <DDText variant="bodySm" color="secondary" style={styles.loadingText}>
          Loading submission review…
        </DDText>
      </View>
    );
  }

  if (fetchError || !completion) {
    return (
      <View style={[styles.root, styles.centerContainer]}>
        <StatusBar style="light" />
        <View style={styles.errorIconWrap}>
          <DDIcon name="warning" size={32} color={DD_COLORS.danger} weight="bold" />
        </View>
        <DDText variant="h2" color="primary" style={styles.errorTitle}>
          Submission Unavailable
        </DDText>
        <DDText variant="bodySm" color="secondary" style={styles.errorSubtitle}>
          {fetchError || 'Unable to retrieve this completion record.'}
        </DDText>
        <DDButton
          variant="secondary"
          title="Go Back"
          iconLeft="arrow-left"
          onPress={handleBack}
          style={styles.errorBackBtn}
        />
      </View>
    );
  }

  const isEligibleReviewer = canUserReview(completion, currentUserId);
  const isReviewed = completion.status !== 'pending';
  const catColor = challenge
    ? CATEGORY_COLORS[challenge.category as CategoryKey] || DD_COLORS.lime
    : DD_COLORS.lime;
  const catIcon = challenge
    ? CATEGORY_ICONS[challenge.category as CategoryKey] || 'sparkle'
    : 'sparkle';
  const participantName = participantDisplayName(completion.participant_id, challenge);
  const otherReviews = pendingReviews.filter((r) => r.completion.id !== completion.id);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      {/* Navigation Header */}
      <View style={[styles.navBar, { paddingTop: insets.top + DD_SPACING.sm }]}>
        <Pressable
          onPress={handleBack}
          hitSlop={12}
          style={({ pressed }) => [styles.backBtn, pressed && styles.btnPressed]}
          accessibilityRole="button"
          accessibilityLabel="Go back">
          <DDIcon name="arrow-left" size={16} color={DD_COLORS.lime} weight="bold" />
          <DDText variant="caption" color="lime" bold>
            Back
          </DDText>
        </Pressable>

        <View style={styles.navTitleGroup}>
          <DDText variant="h3" color="primary" bold>
            Review Dare
          </DDText>
          <DDText variant="caption" color="muted">
            Peer Verification
          </DDText>
        </View>

        {pendingReviews.length > 0 ? (
          <View style={styles.queuePill}>
            <DDText variant="caption" color="lime" bold>
              {pendingReviews.length} in queue
            </DDText>
          </View>
        ) : (
          <View style={{ width: 60 }} />
        )}
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + DD_SPACING['3xl'] },
        ]}
        showsVerticalScrollIndicator={false}>

        {/* Challenge Context Header Card */}
        <DDCard variant="card" padding="lg" style={styles.challengeCard}>
          {/* Top Accent Strip */}
          <View style={[styles.accentStrip, { backgroundColor: catColor }]} />

          <View style={styles.headerBadgesRow}>
            <View style={[styles.catBadge, { backgroundColor: catColor + '1E' }]}>
              <DDIcon name={catIcon} size={13} color={catColor} weight="fill" />
              <DDText variant="caption" style={{ color: catColor }} bold>
                {challenge?.category || 'Challenge'}
              </DDText>
            </View>

            <View style={styles.typeBadge}>
              <DDIcon
                name={completion.challenge_type === 'daily' ? 'flame' : 'target'}
                size={12}
                color={completion.challenge_type === 'daily' ? DD_COLORS.lime : DD_COLORS.purple}
                weight="bold"
              />
              <DDText
                variant="caption"
                color={completion.challenge_type === 'daily' ? 'lime' : 'purple'}
                bold>
                {completion.challenge_type === 'daily' ? 'Daily Dare' : 'One-Time Dare'}
              </DDText>
            </View>
          </View>

          <DDText variant="h2" color="primary" style={styles.challengeTitle}>
            {challenge?.title || 'Challenge Completion'}
          </DDText>

          {challenge?.description ? (
            <DDText variant="bodySm" color="secondary" style={styles.challengeDesc}>
              {challenge.description}
            </DDText>
          ) : null}
        </DDCard>

        {/* Success Banner */}
        {actionSuccess && (
          <View style={styles.successBanner}>
            <DDIcon name="check-circle" size={16} color={DD_COLORS.success} weight="fill" />
            <DDText variant="bodySm" style={styles.successText}>
              {actionSuccess}
            </DDText>
          </View>
        )}

        {/* Error Banner */}
        {actionError && (
          <View style={styles.errorBanner}>
            <DDIcon name="warning" size={16} color={DD_COLORS.danger} weight="bold" />
            <DDText variant="bodySm" style={styles.errorText}>
              {actionError}
            </DDText>
          </View>
        )}

        {/* Submission Details Card */}
        <DDCard variant="element" padding="lg" style={styles.detailsCard}>
          <View style={styles.sectionTitleRow}>
            <DDIcon name="shield-check" size={15} color={DD_COLORS.lime} weight="fill" />
            <DDText variant="label" color="muted" style={styles.sectionTitle}>
              SUBMISSION DETAILS
            </DDText>
          </View>

          <View style={styles.detailRow}>
            <View style={styles.detailLabelGroup}>
              <DDIcon name="user" size={14} color={DD_COLORS.textMuted} weight="bold" />
              <DDText variant="bodySm" color="secondary">
                Participant
              </DDText>
            </View>
            <DDText variant="bodySm" color="primary" bold>
              {participantName}
            </DDText>
          </View>

          <View style={styles.detailRow}>
            <View style={styles.detailLabelGroup}>
              <DDIcon name="calendar" size={14} color={DD_COLORS.textMuted} weight="bold" />
              <DDText variant="bodySm" color="secondary">
                Dare Date
              </DDText>
            </View>
            <DDText variant="bodySm" color="primary" bold>
              {completion.completion_date}
            </DDText>
          </View>

          <View style={styles.detailRow}>
            <View style={styles.detailLabelGroup}>
              <DDIcon name="clock" size={14} color={DD_COLORS.textMuted} weight="bold" />
              <DDText variant="bodySm" color="secondary">
                Submitted At
              </DDText>
            </View>
            <DDText variant="caption" color="secondary">
              {formatSubmittedAt(completion.submitted_at)}
            </DDText>
          </View>

          <View style={styles.detailRow}>
            <DDText variant="bodySm" color="secondary">
              Review Status
            </DDText>
            {completion.status === 'pending' && (
              <View style={styles.statusPendingPill}>
                <DDIcon name="clock" size={12} color={DD_COLORS.warning} weight="bold" />
                <DDText variant="caption" color="warning" bold>
                  Pending Verification
                </DDText>
              </View>
            )}
            {completion.status === 'approved' && (
              <View style={styles.statusApprovedPill}>
                <DDIcon name="check-circle" size={12} color={DD_COLORS.success} weight="fill" />
                <DDText variant="caption" color="success" bold>
                  Approved
                </DDText>
              </View>
            )}
            {completion.status === 'rejected' && (
              <View style={styles.statusRejectedPill}>
                <DDIcon name="x-circle" size={12} color={DD_COLORS.danger} weight="fill" />
                <DDText variant="caption" color="danger" bold>
                  Rejected
                </DDText>
              </View>
            )}
          </View>

          {/* Submitter Note Callout */}
          <View style={styles.noteBox}>
            <DDText variant="caption" color="muted" style={styles.noteHeading}>
              Challenger Note
            </DDText>
            <DDText variant="bodySm" color="primary" style={styles.noteContent}>
              {completion.submission_note ? `"${completion.submission_note}"` : 'No submission note provided.'}
            </DDText>
          </View>

          {/* Rejection reason if already rejected */}
          {completion.status === 'rejected' && completion.rejection_reason ? (
            <View style={styles.rejectionBox}>
              <DDText variant="caption" color="danger" style={styles.noteHeading} bold>
                Rejection Reason
              </DDText>
              <DDText variant="bodySm" color="primary" style={styles.noteContent}>
                {completion.rejection_reason}
              </DDText>
            </View>
          ) : null}
        </DDCard>

        {/* WhatsApp Proof Advisory Card */}
        <DDCard variant="highlight" padding="lg" style={styles.whatsappCard}>
          <View style={styles.whatsappHeader}>
            <View style={styles.whatsappIconCircle}>
              <DDIcon name="send" size={18} color={DD_COLORS.lime} weight="fill" />
            </View>
            <View style={styles.whatsappHeaderText}>
              <DDText variant="title" color="primary" bold>
                Peer-to-Peer Proof Verification
              </DDText>
              <DDText variant="caption" color="lime" bold>
                Zero-Cloud Privacy
              </DDText>
            </View>
          </View>
          <DDText variant="bodySm" color="secondary" style={styles.whatsappDesc}>
            Proof photos and videos are shared directly with you via WhatsApp or messages. Please check that {participantName} sent you proof before approving this dare.
          </DDText>
        </DDCard>

        {/* Review Action Buttons (When authorized and pending) */}
        {isEligibleReviewer && !isReviewed && (
          <View style={styles.actionsGroup}>
            <DDButton
              variant="primary"
              title={isSubmitting ? 'Approving...' : 'Approve Dare'}
              iconLeft="check"
              loading={isSubmitting}
              disabled={isSubmitting}
              onPress={handleApprove}
              style={styles.actionButton}
            />

            <DDButton
              variant="destructive"
              title="Reject Submission"
              iconLeft="x"
              disabled={isSubmitting}
              onPress={openRejectModal}
              style={styles.actionButton}
            />
          </View>
        )}

        {/* Non-verifier notice */}
        {!isEligibleReviewer && !isReviewed && (
          <DDCard variant="element" padding="md" style={styles.noticeCard}>
            <DDIcon name="info" size={16} color={DD_COLORS.info} weight="bold" />
            <DDText variant="caption" color="secondary" style={styles.noticeText}>
              Only the assigned verifier ({completion.verifier_id === currentUserId ? 'You' : 'another participant'}) can review this submission.
            </DDText>
          </DDCard>
        )}

        {/* Already Reviewed Banner */}
        {isReviewed && (
          <DDCard variant="element" padding="lg" style={styles.reviewedNoticeCard}>
            <View style={styles.reviewedHeader}>
              <DDIcon
                name={completion.status === 'approved' ? 'check-circle' : 'x-circle'}
                size={22}
                color={completion.status === 'approved' ? DD_COLORS.success : DD_COLORS.danger}
                weight="fill"
              />
              <View style={styles.reviewedTextGroup}>
                <DDText variant="title" color="primary" bold>
                  Submission {completion.status === 'approved' ? 'Approved' : 'Rejected'}
                </DDText>
                <DDText variant="caption" color="secondary">
                  Reviewed on {completion.reviewed_at ? formatSubmittedAt(completion.reviewed_at) : 'record'}.
                </DDText>
              </View>
            </View>

            <DDButton
              variant="secondary"
              title="View Challenge Progress"
              iconRight="arrow-right"
              onPress={() => {
                if (challenge?.id) {
                  router.push({
                    pathname: '/challenge/[id]',
                    params: { id: challenge.id },
                  });
                } else {
                  handleBack();
                }
              }}
              style={styles.viewChallengeBtn}
            />
          </DDCard>
        )}

        {/* Other Pending Reviews in Queue */}
        {otherReviews.length > 0 && (
          <View style={styles.queueSection}>
            <View style={styles.sectionTitleRow}>
              <DDIcon name="clock" size={14} color={DD_COLORS.lime} weight="bold" />
              <DDText variant="label" color="muted" style={styles.sectionTitle}>
                MORE IN YOUR REVIEW QUEUE ({otherReviews.length})
              </DDText>
            </View>

            {otherReviews.map((rev) => (
              <Pressable
                key={rev.completion.id}
                onPress={() => {
                  router.push({
                    pathname: '/review/[id]',
                    params: { id: rev.completion.id },
                  });
                }}
                android_ripple={{ color: 'rgba(255, 255, 255, 0.08)' }}
                style={({ pressed }) => [
                  styles.queueItemCard,
                  pressed && styles.btnPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={`Review submission for ${rev.challengeTitle}`}>
                <View style={styles.queueItemLeft}>
                  <View style={styles.queueIconCircle}>
                    <DDIcon name="shield-check" size={16} color={DD_COLORS.lime} weight="fill" />
                  </View>
                  <View style={styles.queueInfo}>
                    <DDText variant="title" color="primary" numberOfLines={1} bold>
                      {rev.challengeTitle}
                    </DDText>
                    <DDText variant="caption" color="secondary">
                      {rev.participantName} • {rev.completion.completion_date}
                    </DDText>
                  </View>
                </View>

                <DDIcon name="arrow-right" size={14} color={DD_COLORS.lime} weight="bold" />
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>

      {/* Reject Reason Modal */}
      <Modal
        visible={rejectModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => !isSubmitting && setRejectModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <DDCard variant="card" padding="lg" style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <View style={styles.modalIconWrap}>
                <DDIcon name="x-circle" size={20} color={DD_COLORS.danger} weight="fill" />
              </View>
              <View style={styles.modalTitleGroup}>
                <DDText variant="h3" color="primary" bold>
                  Reject Submission
                </DDText>
                <DDText variant="caption" color="secondary">
                  Let {participantName} know what was missing
                </DDText>
              </View>
            </View>

            <TextInput
              style={styles.modalInput}
              placeholder="e.g. Proof photo on WhatsApp was unclear, please resend"
              placeholderTextColor={DD_COLORS.textMuted}
              value={rejectionReason}
              onChangeText={setRejectionReason}
              maxLength={MAX_REJECTION_REASON_LENGTH}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
              accessibilityLabel="Rejection reason"
            />

            <DDText variant="caption" color="muted" style={styles.charCount}>
              {rejectionReason.length} / {MAX_REJECTION_REASON_LENGTH}
            </DDText>

            <View style={styles.modalActions}>
              <DDButton
                variant="ghost"
                title="Cancel"
                disabled={isSubmitting}
                onPress={() => setRejectModalVisible(false)}
                style={styles.modalBtn}
              />
              <DDButton
                variant="destructive"
                title={isSubmitting ? 'Rejecting...' : 'Confirm Reject'}
                loading={isSubmitting}
                disabled={isSubmitting}
                onPress={handleConfirmReject}
                style={styles.modalBtn}
              />
            </View>
          </DDCard>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: DD_COLORS.bg,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: DD_SPACING.lg,
    gap: DD_SPACING.lg,
  },
  centerContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: DD_SPACING.xl,
    gap: DD_SPACING.md,
  },
  loadingText: {
    marginTop: DD_SPACING.sm,
  },
  errorIconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255, 59, 86, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: DD_SPACING.sm,
  },
  errorTitle: {
    textAlign: 'center',
  },
  errorSubtitle: {
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: DD_SPACING.md,
  },
  errorBackBtn: {
    minWidth: 160,
  },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: DD_SPACING.lg,
    paddingBottom: DD_SPACING.sm,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: DD_SPACING.xs,
    paddingRight: DD_SPACING.sm,
  },
  btnPressed: {
    opacity: 0.8,
  },
  navTitleGroup: {
    alignItems: 'center',
    gap: 2,
  },
  queuePill: {
    backgroundColor: 'rgba(191, 253, 64, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(191, 253, 64, 0.25)',
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 4,
    borderRadius: DD_RADII.pill,
  },
  challengeCard: {
    position: 'relative',
    overflow: 'hidden',
    gap: DD_SPACING.sm,
  },
  accentStrip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 3,
  },
  headerBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    marginTop: DD_SPACING.xs,
  },
  catBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    borderRadius: DD_RADII.pill,
  },
  typeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    borderRadius: DD_RADII.pill,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
  },
  challengeTitle: {
    marginTop: 2,
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: -0.5,
  },
  challengeDesc: {
    lineHeight: 20,
  },
  successBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    backgroundColor: 'rgba(0, 230, 118, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0, 230, 118, 0.3)',
    padding: DD_SPACING.md,
    borderRadius: DD_RADII.card,
  },
  successText: {
    color: DD_COLORS.success,
    fontWeight: '600',
    flex: 1,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    backgroundColor: 'rgba(255, 59, 86, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255, 59, 86, 0.3)',
    padding: DD_SPACING.md,
    borderRadius: DD_RADII.card,
  },
  errorText: {
    color: DD_COLORS.danger,
    fontWeight: '600',
    flex: 1,
  },
  detailsCard: {
    gap: DD_SPACING.md,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sectionTitle: {
    letterSpacing: 1.2,
    fontSize: 11,
    textTransform: 'uppercase',
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 2,
  },
  detailLabelGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusPendingPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255, 184, 0, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255, 184, 0, 0.3)',
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    borderRadius: DD_RADII.pill,
  },
  statusApprovedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0, 230, 118, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0, 230, 118, 0.3)',
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    borderRadius: DD_RADII.pill,
  },
  statusRejectedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255, 59, 86, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255, 59, 86, 0.3)',
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    borderRadius: DD_RADII.pill,
  },
  noteBox: {
    backgroundColor: DD_COLORS.bgCard,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    borderRadius: DD_RADII.md,
    padding: DD_SPACING.md,
    gap: 4,
    marginTop: DD_SPACING.xs,
  },
  noteHeading: {
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  noteContent: {
    fontStyle: 'italic',
    lineHeight: 20,
  },
  rejectionBox: {
    backgroundColor: 'rgba(255, 59, 86, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 59, 86, 0.25)',
    borderRadius: DD_RADII.md,
    padding: DD_SPACING.md,
    gap: 4,
  },
  whatsappCard: {
    gap: DD_SPACING.sm,
  },
  whatsappHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
  },
  whatsappIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(191, 253, 64, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  whatsappHeaderText: {
    gap: 2,
  },
  whatsappDesc: {
    lineHeight: 19,
  },
  actionsGroup: {
    gap: DD_SPACING.sm,
    marginTop: DD_SPACING.xs,
  },
  actionButton: {
    minHeight: 48,
  },
  noticeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
  },
  noticeText: {
    flex: 1,
    lineHeight: 18,
  },
  reviewedNoticeCard: {
    gap: DD_SPACING.md,
  },
  reviewedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.md,
  },
  reviewedTextGroup: {
    flex: 1,
    gap: 2,
  },
  viewChallengeBtn: {
    alignSelf: 'stretch',
  },
  queueSection: {
    gap: DD_SPACING.sm,
    marginTop: DD_SPACING.xs,
  },
  queueItemCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: DD_COLORS.bgCard,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    borderRadius: DD_RADII.card,
    padding: DD_SPACING.md,
  },
  queueItemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.md,
    flex: 1,
  },
  queueIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(191, 253, 64, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  queueInfo: {
    flex: 1,
    gap: 2,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    padding: DD_SPACING.lg,
  },
  modalCard: {
    gap: DD_SPACING.md,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
  },
  modalIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 59, 86, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalTitleGroup: {
    flex: 1,
    gap: 2,
  },
  modalInput: {
    backgroundColor: DD_COLORS.bgElement,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    borderRadius: DD_RADII.md,
    padding: DD_SPACING.md,
    color: DD_COLORS.text,
    fontSize: 14,
    minHeight: 88,
  },
  charCount: {
    alignSelf: 'flex-end',
    marginTop: -DD_SPACING.xs,
  },
  modalActions: {
    flexDirection: 'row',
    gap: DD_SPACING.sm,
    justifyContent: 'flex-end',
    marginTop: DD_SPACING.xs,
  },
  modalBtn: {
    flex: 1,
  },
});
