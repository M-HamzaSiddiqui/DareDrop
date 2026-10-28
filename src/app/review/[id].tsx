import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CATEGORY_COLORS, CATEGORY_EMOJIS, CategoryKey, DD } from '@/constants/dd-theme';
import { Challenge } from '@/data/challenges';
import {
  canUserReview,
  formatSubmittedAt,
  MAX_REJECTION_REASON_LENGTH,
  participantDisplayName,
} from '@/lib/reviews';
import { buildCompletionsChannelName, subscribeToCompletions } from '@/lib/realtime';
import { DbCompletion, isSupabaseConfigured, supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth-context';
import { useChallenges } from '@/store/challenges-store';

export default function ReviewDetailsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const {
    currentUserId,
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
            // non-fatal
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
          // ignore
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
      showAuthModal('Account required to approve completions. Sign in or register to verify dares.');
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
      showAuthModal('Account required to review completions. Sign in or register to verify dares.');
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
        <ActivityIndicator size="large" color={DD.lime} />
        <Text style={styles.loadingText}>Loading submission review…</Text>
      </View>
    );
  }

  if (fetchError || !completion) {
    return (
      <View style={[styles.root, styles.centerContainer]}>
        <StatusBar style="light" />
        <Text style={styles.errorIcon}>⚠️</Text>
        <Text style={styles.errorTitle}>Submission Unavailable</Text>
        <Text style={styles.errorSubtitle}>
          {fetchError || 'Unable to retrieve this completion record.'}
        </Text>
        <Pressable
          onPress={handleBack}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.8 }]}
          accessibilityRole="button">
          <Text style={styles.backBtnText}>← Back</Text>
        </Pressable>
      </View>
    );
  }

  const isEligibleReviewer = canUserReview(completion, currentUserId);
  const isReviewed = completion.status !== 'pending';
  const catColor = challenge ? CATEGORY_COLORS[challenge.category as CategoryKey] || DD.lime : DD.lime;
  const emoji = challenge ? CATEGORY_EMOJIS[challenge.category as CategoryKey] || '⚡' : '⚡';
  const participantName = participantDisplayName(completion.participant_id, challenge);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      {/* Navigation bar */}
      <View style={[styles.navBar, { paddingTop: insets.top + DD.s2 }]}>
        <Pressable
          onPress={handleBack}
          style={({ pressed }) => [styles.backPill, pressed && { opacity: 0.75 }]}
          accessibilityRole="button"
          accessibilityLabel="Go back">
          <Text style={styles.backPillText}>← Back</Text>
        </Pressable>
        <Text style={styles.navTitle}>Review Dare</Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + DD.s8 },
        ]}
        showsVerticalScrollIndicator={false}>

        {/* Challenge context header card */}
        <View style={styles.challengeCard}>
          <View style={[styles.categoryBadge, { backgroundColor: catColor + '22' }]}>
            <Text style={[styles.categoryBadgeText, { color: catColor }]}>
              {emoji} {challenge?.category || 'Challenge'} • {completion.challenge_type === 'daily' ? 'Daily Dare' : 'One-Time Dare'}
            </Text>
          </View>
          <Text style={styles.challengeTitle}>{challenge?.title || 'Challenge Completion'}</Text>
          {challenge?.description ? (
            <Text style={styles.challengeDescription}>{challenge.description}</Text>
          ) : null}
        </View>

        {/* Success toast banner */}
        {actionSuccess && (
          <View style={styles.successBanner}>
            <Text style={styles.successBannerText}>{actionSuccess}</Text>
          </View>
        )}

        {/* Error banner */}
        {actionError && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{actionError}</Text>
          </View>
        )}

        {/* Submission details card */}
        <View style={styles.detailsCard}>
          <Text style={styles.sectionHeader}>SUBMISSION DETAILS</Text>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Participant</Text>
            <Text style={styles.detailValueBold}>{participantName}</Text>
          </View>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Dare Date</Text>
            <Text style={styles.detailValueBold}>{completion.completion_date}</Text>
          </View>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Submitted At</Text>
            <Text style={styles.detailValue}>{formatSubmittedAt(completion.submitted_at)}</Text>
          </View>

          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Review Status</Text>
            {completion.status === 'pending' && (
              <View style={[styles.statusPill, styles.statusPillPending]}>
                <Text style={styles.statusPillTextPending}>⏳ Pending Review</Text>
              </View>
            )}
            {completion.status === 'approved' && (
              <View style={[styles.statusPill, styles.statusPillApproved]}>
                <Text style={styles.statusPillTextApproved}>✓ Approved</Text>
              </View>
            )}
            {completion.status === 'rejected' && (
              <View style={[styles.statusPill, styles.statusPillRejected]}>
                <Text style={styles.statusPillTextRejected}>✕ Rejected</Text>
              </View>
            )}
          </View>

          {/* Submitter Note */}
          <View style={styles.noteSection}>
            <Text style={styles.noteLabel}>Challenger Note</Text>
            <View style={styles.noteBox}>
              <Text style={styles.noteText}>
                {completion.submission_note ? `"${completion.submission_note}"` : 'No note was provided.'}
              </Text>
            </View>
          </View>

          {/* Rejection feedback if already rejected */}
          {completion.status === 'rejected' && completion.rejection_reason ? (
            <View style={styles.rejectionBox}>
              <Text style={styles.rejectionLabel}>Rejection Reason</Text>
              <Text style={styles.rejectionText}>{completion.rejection_reason}</Text>
            </View>
          ) : null}
        </View>

        {/* WhatsApp proof reminder card */}
        <View style={styles.whatsappCard}>
          <View style={styles.whatsappCardHeader}>
            <Text style={styles.whatsappIcon}>💬</Text>
            <Text style={styles.whatsappCardTitle}>Peer-to-Peer Proof Verification</Text>
          </View>
          <Text style={styles.whatsappCardBody}>
            Proof photos/videos are shared directly via WhatsApp to protect your privacy without cloud media storage. Check that {participantName} sent you proof on WhatsApp before approving this submission.
          </Text>
        </View>

        {/* Action buttons (only when authorized and pending) */}
        {isEligibleReviewer && !isReviewed && (
          <View style={styles.actionsContainer}>
            <Pressable
              onPress={handleApprove}
              disabled={isSubmitting}
              style={({ pressed }) => [
                styles.approveBtn,
                pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
                isSubmitting && { opacity: 0.6 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Approve submission">
              {isSubmitting ? (
                <ActivityIndicator color={DD.bg} />
              ) : (
                <Text style={styles.approveBtnText}>✓ Approve Dare</Text>
              )}
            </Pressable>

            <Pressable
              onPress={openRejectModal}
              disabled={isSubmitting}
              style={({ pressed }) => [
                styles.rejectBtn,
                pressed && { opacity: 0.85 },
                isSubmitting && { opacity: 0.6 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Reject submission">
              <Text style={styles.rejectBtnText}>✕ Reject</Text>
            </Pressable>
          </View>
        )}

        {/* Non-verifier notice */}
        {!isEligibleReviewer && !isReviewed && (
          <View style={styles.noticeBox}>
            <Text style={styles.noticeText}>
              ℹ️ Only the assigned verifier ({completion.verifier_id === currentUserId ? 'You' : 'another verifier'}) can approve or reject this submission.
            </Text>
          </View>
        )}

        {/* Already reviewed banner */}
        {isReviewed && (
          <View style={styles.reviewedNoticeBox}>
            <Text style={styles.reviewedNoticeText}>
              This submission was reviewed on{' '}
              {completion.reviewed_at ? formatSubmittedAt(completion.reviewed_at) : 'record'}.
            </Text>
            <Pressable
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
              style={styles.viewChallengeBtn}>
              <Text style={styles.viewChallengeBtnText}>View Challenge Progress →</Text>
            </Pressable>
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
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Reject Submission</Text>
            <Text style={styles.modalSubtitle}>
              Let {participantName} know what was missing so they can resubmit valid proof.
            </Text>

            <TextInput
              style={styles.modalInput}
              placeholder="e.g., Proof photo was unclear, please resend"
              placeholderTextColor={DD.textMuted}
              value={rejectionReason}
              onChangeText={setRejectionReason}
              maxLength={MAX_REJECTION_REASON_LENGTH}
              multiline
              numberOfLines={3}
              editable={!isSubmitting}
            />

            <Text style={styles.charCount}>
              {rejectionReason.length}/{MAX_REJECTION_REASON_LENGTH}
            </Text>

            <View style={styles.modalActions}>
              <Pressable
                onPress={() => setRejectModalVisible(false)}
                disabled={isSubmitting}
                style={[styles.modalCancelBtn, isSubmitting && { opacity: 0.5 }]}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={handleConfirmReject}
                disabled={isSubmitting}
                style={[styles.modalConfirmRejectBtn, isSubmitting && { opacity: 0.5 }]}>
                {isSubmitting ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.modalConfirmRejectText}>Confirm Reject</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: DD.bg,
  },
  centerContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: DD.s6,
  },
  loadingText: {
    marginTop: DD.s4,
    fontSize: 14,
    color: DD.textSub,
  },
  errorIcon: {
    fontSize: 48,
    marginBottom: DD.s3,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: DD.text,
    marginBottom: DD.s2,
  },
  errorSubtitle: {
    fontSize: 14,
    color: DD.textSub,
    textAlign: 'center',
    marginBottom: DD.s6,
  },
  backBtn: {
    backgroundColor: DD.bgCard,
    paddingHorizontal: DD.s5,
    paddingVertical: DD.s3,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
    borderColor: DD.border,
  },
  backBtnText: {
    color: DD.text,
    fontWeight: '700',
  },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: DD.s5,
    paddingBottom: DD.s3,
    borderBottomWidth: 1,
    borderBottomColor: DD.border,
    backgroundColor: DD.bg,
  },
  backPill: {
    backgroundColor: DD.bgCard,
    paddingHorizontal: DD.s4,
    paddingVertical: DD.s2,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
    borderColor: DD.border,
  },
  backPillText: {
    color: DD.text,
    fontSize: 13,
    fontWeight: '700',
  },
  navTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: DD.text,
  },
  scroll: {
    flex: 1,
  },
  content: {
    padding: DD.s5,
    gap: DD.s4,
  },
  challengeCard: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    padding: DD.s5,
    borderWidth: 1,
    borderColor: DD.border,
    gap: DD.s2,
  },
  categoryBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s1,
    borderRadius: DD.radiusPill,
  },
  categoryBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  challengeTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: DD.text,
    letterSpacing: -0.5,
  },
  challengeDescription: {
    fontSize: 13,
    color: DD.textSub,
    lineHeight: 18,
  },
  successBanner: {
    backgroundColor: DD.success + '22',
    borderWidth: 1,
    borderColor: DD.success,
    borderRadius: DD.radiusMd,
    padding: DD.s4,
  },
  successBannerText: {
    color: DD.success,
    fontWeight: '700',
    fontSize: 13,
    lineHeight: 18,
  },
  errorBanner: {
    backgroundColor: DD.danger + '22',
    borderWidth: 1,
    borderColor: DD.danger,
    borderRadius: DD.radiusMd,
    padding: DD.s4,
  },
  errorBannerText: {
    color: DD.danger,
    fontWeight: '700',
    fontSize: 13,
    lineHeight: 18,
  },
  detailsCard: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    padding: DD.s5,
    borderWidth: 1,
    borderColor: DD.border,
    gap: DD.s3,
  },
  sectionHeader: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.5,
    color: DD.textMuted,
    marginBottom: DD.s1,
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: DD.s2,
    borderBottomWidth: 1,
    borderBottomColor: DD.border,
  },
  detailLabel: {
    fontSize: 13,
    color: DD.textSub,
  },
  detailValue: {
    fontSize: 13,
    color: DD.text,
    fontWeight: '600',
  },
  detailValueBold: {
    fontSize: 14,
    color: DD.text,
    fontWeight: '800',
  },
  statusPill: {
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s1,
    borderRadius: DD.radiusPill,
  },
  statusPillPending: {
    backgroundColor: '#FFB80022',
    borderWidth: 1,
    borderColor: '#FFB800',
  },
  statusPillTextPending: {
    color: '#FFB800',
    fontSize: 11,
    fontWeight: '800',
  },
  statusPillApproved: {
    backgroundColor: DD.success + '22',
    borderWidth: 1,
    borderColor: DD.success,
  },
  statusPillTextApproved: {
    color: DD.success,
    fontSize: 11,
    fontWeight: '800',
  },
  statusPillRejected: {
    backgroundColor: DD.danger + '22',
    borderWidth: 1,
    borderColor: DD.danger,
  },
  statusPillTextRejected: {
    color: DD.danger,
    fontSize: 11,
    fontWeight: '800',
  },
  noteSection: {
    marginTop: DD.s2,
    gap: DD.s2,
  },
  noteLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: DD.textSub,
  },
  noteBox: {
    backgroundColor: DD.bgElement,
    borderRadius: DD.radiusMd,
    padding: DD.s4,
    borderWidth: 1,
    borderColor: DD.border,
  },
  noteText: {
    fontSize: 13,
    color: DD.text,
    fontStyle: 'italic',
    lineHeight: 18,
  },
  rejectionBox: {
    backgroundColor: DD.danger + '18',
    borderRadius: DD.radiusMd,
    padding: DD.s4,
    borderWidth: 1,
    borderColor: DD.danger + '55',
    gap: DD.s1,
  },
  rejectionLabel: {
    fontSize: 12,
    fontWeight: '800',
    color: DD.danger,
  },
  rejectionText: {
    fontSize: 13,
    color: DD.text,
    lineHeight: 18,
  },
  whatsappCard: {
    backgroundColor: '#25D36615',
    borderRadius: DD.radiusCard,
    padding: DD.s5,
    borderWidth: 1,
    borderColor: '#25D36644',
    gap: DD.s2,
  },
  whatsappCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s2,
  },
  whatsappIcon: {
    fontSize: 18,
  },
  whatsappCardTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#25D366',
  },
  whatsappCardBody: {
    fontSize: 12,
    color: DD.textSub,
    lineHeight: 17,
  },
  actionsContainer: {
    gap: DD.s3,
    marginTop: DD.s2,
  },
  approveBtn: {
    backgroundColor: DD.lime,
    borderRadius: DD.radiusCard,
    paddingVertical: DD.s4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  approveBtnText: {
    color: DD.bg,
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0.3,
  },
  rejectBtn: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    paddingVertical: DD.s4,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: DD.danger + '88',
  },
  rejectBtnText: {
    color: DD.danger,
    fontSize: 15,
    fontWeight: '800',
  },
  noticeBox: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusMd,
    padding: DD.s4,
    borderWidth: 1,
    borderColor: DD.border,
  },
  noticeText: {
    fontSize: 12,
    color: DD.textSub,
    lineHeight: 17,
  },
  reviewedNoticeBox: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    padding: DD.s5,
    borderWidth: 1,
    borderColor: DD.border,
    alignItems: 'center',
    gap: DD.s3,
  },
  reviewedNoticeText: {
    fontSize: 13,
    color: DD.textSub,
    textAlign: 'center',
  },
  viewChallengeBtn: {
    backgroundColor: DD.bgElement,
    paddingHorizontal: DD.s4,
    paddingVertical: DD.s2,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
    borderColor: DD.border,
  },
  viewChallengeBtnText: {
    fontSize: 13,
    color: DD.lime,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: DD.s5,
  },
  modalCard: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    padding: DD.s6,
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderColor: DD.border,
    gap: DD.s3,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: DD.text,
  },
  modalSubtitle: {
    fontSize: 13,
    color: DD.textSub,
    lineHeight: 18,
  },
  modalInput: {
    backgroundColor: DD.bgElement,
    borderRadius: DD.radiusMd,
    padding: DD.s4,
    color: DD.text,
    fontSize: 14,
    minHeight: 80,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: DD.border,
  },
  charCount: {
    fontSize: 11,
    color: DD.textMuted,
    textAlign: 'right',
  },
  modalActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: DD.s3,
    marginTop: DD.s2,
  },
  modalCancelBtn: {
    paddingHorizontal: DD.s4,
    paddingVertical: DD.s3,
    borderRadius: DD.radiusPill,
  },
  modalCancelText: {
    color: DD.textSub,
    fontSize: 14,
    fontWeight: '700',
  },
  modalConfirmRejectBtn: {
    backgroundColor: DD.danger,
    paddingHorizontal: DD.s5,
    paddingVertical: DD.s3,
    borderRadius: DD.radiusPill,
    minWidth: 120,
    alignItems: 'center',
  },
  modalConfirmRejectText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
});
