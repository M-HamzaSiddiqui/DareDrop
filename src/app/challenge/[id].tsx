import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CATEGORY_COLORS, CATEGORY_EMOJIS, CategoryKey, DD } from '@/constants/dd-theme';
import {
  calculateProgress,
  Challenge,
  formatParticipants,
  getChallengeDates,
  timeRemaining,
} from '@/data/challenges';
import {
  copyInviteLink,
  getChallengeInviteUrls,
  openWhatsAppProofShare,
  shareChallenge,
} from '@/lib/sharing';
import {
  formatSubmittedAt,
  MAX_REJECTION_REASON_LENGTH,
  participantDisplayName,
  splitCompletionsForUser,
} from '@/lib/reviews';
import { buildCompletionsChannelName, subscribeToCompletions } from '@/lib/realtime';
import {
  DbCompletion,
  EligibleVerifier,
  isSupabaseConfigured,
  ParticipantProgress,
  supabase,
  UserFriend,
} from '@/lib/supabase';
import {
  fetchUserFriends,
  sendChallengeInvitation,
  translateSocialError,
} from '@/lib/friends';
import { useAuth } from '@/lib/auth-context';
import { useChallenges } from '@/store/challenges-store';

export default function ChallengeDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const {
    challenges,
    joinChallenge,
    fetchChallengeById,
    submitCompletion,
    fetchCompletions,
    fetchEligibleVerifiers,
    fetchParticipantProgress,
    reassignVerifier,
    currentUserId,
    reviewCompletion,
    refreshPendingReviews,
  } = useChallenges();
  const { isGuest, showAuthModal } = useAuth();
  const insets = useSafeAreaInsets();

  const localChallenge = challenges.find((c) => c.id === id);
  const [loadingRemote, setLoadingRemote] = useState(!localChallenge && Boolean(id));
  const [remoteChallenge, setRemoteChallenge] = useState<Challenge | null>(null);
  const [copiedToast, setCopiedToast] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [showLinkInfo, setShowLinkInfo] = useState(false);

  // Verification & Completion state
  const [completions, setCompletions] = useState<DbCompletion[]>([]);
  const [eligibleVerifiers, setEligibleVerifiers] = useState<EligibleVerifier[]>([]);
  const [participantProgress, setParticipantProgress] = useState<ParticipantProgress | null>(null);

  // Submit Modal state
  const [submitModalVisible, setSubmitModalVisible] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [selectedVerifierId, setSelectedVerifierId] = useState<string>('');
  const [submissionNote, setSubmissionNote] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<DbCompletion | null>(null);

  // Reassign Modal state
  const [reassignModalVisible, setReassignModalVisible] = useState(false);
  const [reassigningCompletion, setReassigningCompletion] = useState<DbCompletion | null>(null);
  const [newVerifierId, setNewVerifierId] = useState<string>('');
  const [isReassigning, setIsReassigning] = useState(false);
  const [reassignError, setReassignError] = useState<string | null>(null);

  // Review state (inline quick approve / reject)
  const [rejectingCompletion, setRejectingCompletion] = useState<DbCompletion | null>(null);
  const [inlineRejectModalVisible, setInlineRejectModalVisible] = useState(false);
  const [inlineRejectionReason, setInlineRejectionReason] = useState('');
  const [isReviewing, setIsReviewing] = useState(false);

  // Invite Friends Modal state
  const [inviteModalVisible, setInviteModalVisible] = useState(false);
  const [myFriends, setMyFriends] = useState<UserFriend[]>([]);
  const [loadingFriends, setLoadingFriends] = useState(false);
  const [invitingFriendId, setInvitingFriendId] = useState<string | null>(null);
  const [invitedFriendIds, setInvitedFriendIds] = useState<Set<string>>(new Set());
  const [inviteFriendError, setInviteFriendError] = useState<string | null>(null);

  // Split completions into user's own submissions and submissions awaiting this user's review
  const { mine: userSubmissions, toReview: reviewableSubmissions } = useMemo(
    () => splitCompletionsForUser(completions, currentUserId),
    [completions, currentUserId],
  );

  // If not in local store, fetch from Supabase
  useEffect(() => {
    let isMounted = true;
    if (localChallenge || !id) return;

    fetchChallengeById(id)
      .then((found) => {
        if (isMounted) {
          setRemoteChallenge(found);
          setLoadingRemote(false);
        }
      })
      .catch(() => {
        if (isMounted) {
          setLoadingRemote(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [id, localChallenge, fetchChallengeById]);

  const challenge = (id ? challenges.find((c) => c.id === id) : null) || remoteChallenge;
  const challengeId = challenge?.id;
  const challengeJoined = challenge?.joined;

  // Fetch completions, verifiers, and progress for joined participants
  useEffect(() => {
    let isMounted = true;
    if (!challengeId || !challengeJoined) {
      return;
    }

    Promise.all([
      fetchCompletions(challengeId),
      fetchEligibleVerifiers(challengeId),
      fetchParticipantProgress(challengeId),
    ])
      .then(([compList, verifierList, prog]) => {
        if (!isMounted) return;
        setCompletions(compList);
        setEligibleVerifiers(verifierList);
        setParticipantProgress(prog);
        if (verifierList.length > 0) {
          setSelectedVerifierId((curr) => curr || verifierList[0].user_id);
        }
      })
      .catch((err) => {
        console.warn('[DareDrop] Failed to load verification data:', err);
      });

    return () => {
      isMounted = false;
    };
  }, [
    challengeId,
    challengeJoined,
    fetchCompletions,
    fetchEligibleVerifiers,
    fetchParticipantProgress,
  ]);

  const refreshVerificationData = useCallback(async () => {
    if (!challengeId) return;
    try {
      const [compList, verifierList, prog] = await Promise.all([
        fetchCompletions(challengeId),
        fetchEligibleVerifiers(challengeId),
        fetchParticipantProgress(challengeId),
      ]);
      setCompletions(compList);
      setEligibleVerifiers(verifierList);
      setParticipantProgress(prog);
    } catch (err) {
      console.warn('[DareDrop] Failed to refresh verification data:', err);
    }
  }, [challengeId, fetchCompletions, fetchEligibleVerifiers, fetchParticipantProgress]);

  // Live Supabase Realtime subscription for this challenge's completions
  // Instantly updates status, streak, progress, and review cards when submissions are made, reviewed, or reassigned
  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !challengeId) return;

    const channelName = buildCompletionsChannelName('challenge-completions', challengeId, currentUserId);
    const unsubscribe = subscribeToCompletions({
      supabase,
      channelName,
      filter: `challenge_id=eq.${challengeId}`,
      debounceMs: 200,
      onEvent: () => {
        refreshVerificationData().catch(() => {});
        refreshPendingReviews().catch(() => {});
      },
    });

    const appStateSub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        refreshVerificationData().catch(() => {});
      }
    });

    return () => {
      appStateSub.remove();
      unsubscribe();
    };
  }, [challengeId, currentUserId, refreshVerificationData, refreshPendingReviews]);

  function handleBack() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }

  if (loadingRemote) {
    return (
      <View style={[styles.root, styles.centerContainer]}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color={DD.lime} />
        <Text style={styles.loadingText}>Loading challenge…</Text>
      </View>
    );
  }

  if (!challenge) {
    return (
      <View style={[styles.root, styles.notFound]}>
        <StatusBar style="light" />
        <Text style={styles.notFoundIcon}>🔍</Text>
        <Text style={styles.notFoundText}>Challenge not found</Text>
        <Text style={styles.notFoundSubtext}>
          This challenge may have been removed or the link is invalid.
        </Text>
        <Pressable
          onPress={handleBack}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.8 }]}
          accessibilityRole="button"
          accessibilityLabel="Go back">
          <Text style={styles.backBtnText}>← Go Back</Text>
        </Pressable>
      </View>
    );
  }

  const catColor = CATEGORY_COLORS[challenge.category as CategoryKey] || DD.lime;
  const emoji = CATEGORY_EMOJIS[challenge.category as CategoryKey] || '⚡';
  const timeLeft = timeRemaining(challenge.endsAt);

  const { daysElapsed, progressPct: timeProgressPct } = calculateProgress(
    challenge.createdAt,
    challenge.durationDays,
  );

  const inviteUrls = getChallengeInviteUrls(challenge);
  const challengeDates = getChallengeDates(challenge.timezone || 'UTC');
  const todayDate = challengeDates.today;
  const yesterdayDate = challengeDates.yesterday;


  // Completion statuses (derived from user's OWN submissions)
  const isDaily = challenge.challengeType !== 'one_time';
  const todayCompletion = userSubmissions.find((c) => c.completion_date === todayDate);
  const yesterdayCompletion = userSubmissions.find((c) => c.completion_date === yesterdayDate);
  const latestCompletion = userSubmissions[0];

  // Verified progress details
  const displayProgressPct =
    participantProgress && typeof participantProgress.progress_pct === 'number'
      ? participantProgress.progress_pct
      : timeProgressPct;

  const displayVerifiedCount =
    participantProgress && typeof participantProgress.verified_count === 'number'
      ? participantProgress.verified_count
      : 0;

  const displayStreak =
    participantProgress && typeof participantProgress.current_streak === 'number'
      ? participantProgress.current_streak
      : 0;

  const isCompletedVerified = Boolean(participantProgress?.is_completed);

  async function handleCopy() {
    if (!challenge) return;
    const res = await copyInviteLink(challenge);
    if (res.success) {
      setCopiedToast('✓ Invite link copied to clipboard!');
      setTimeout(() => setCopiedToast(null), 3000);
    }
  }

  async function handleShare() {
    if (!challenge) return;
    await shareChallenge(challenge);
  }

  async function openInviteFriendsModal() {
    setInviteFriendError(null);
    setInviteModalVisible(true);
    setLoadingFriends(true);
    try {
      const friends = await fetchUserFriends();
      setMyFriends(friends);
    } catch (err: any) {
      setInviteFriendError(translateSocialError(err));
    } finally {
      setLoadingFriends(false);
    }
  }

  async function handleInviteFriend(friend: UserFriend) {
    if (!challenge) return;
    if (isGuest) {
      showAuthModal('Account required to invite friends to a Dare. Sign in or register to connect!');
      return;
    }
    setInvitingFriendId(friend.friend_user_id);
    setInviteFriendError(null);
    try {
      await sendChallengeInvitation(challenge.id, friend.friend_user_id);
      setInvitedFriendIds((prev) => new Set([...prev, friend.friend_user_id]));
      setCopiedToast(`⚡ Invitation sent to ${friend.display_name}!`);
      setTimeout(() => setCopiedToast(null), 3000);
    } catch (err: any) {
      setInviteFriendError(translateSocialError(err));
    } finally {
      setInvitingFriendId(null);
    }
  }

  async function handleJoinToggle() {
    if (!challenge || isJoining) return;
    if (isGuest) {
      showAuthModal('Account required to join a Dare. Sign in or register to join challenges and track your streaks!');
      return;
    }
    setIsJoining(true);
    try {
      const res = await joinChallenge(challenge.id);
      if (res.success) {
        setCopiedToast(res.joined ? '🎉 Welcome to the challenge!' : 'You left this challenge');
        setTimeout(() => setCopiedToast(null), 2500);
        if (res.joined) {
          await refreshVerificationData();
        } else {
          setCompletions([]);
          setEligibleVerifiers([]);
          setParticipantProgress(null);
        }
      }
    } finally {
      setIsJoining(false);
    }
  }

  function openSubmitModal(prefillDate?: string) {
    if (isGuest) {
      showAuthModal('Account required to submit completion proof. Sign in to verify your progress!');
      return;
    }
    const targetDate = prefillDate || todayDate;
    setSelectedDate(targetDate);
    setSubmissionNote('');
    setSubmitError(null);
    setSubmitSuccess(null);

    if (eligibleVerifiers.length > 0) {
      if (!selectedVerifierId || !eligibleVerifiers.some((v) => v.user_id === selectedVerifierId)) {
        setSelectedVerifierId(eligibleVerifiers[0].user_id);
      }
    }
    setSubmitModalVisible(true);
  }

  async function handleSubmitCompletion() {
    if (!challenge || !selectedVerifierId || !selectedDate || isSubmitting) return;

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const result = await submitCompletion({
        challengeId: challenge.id,
        verifierId: selectedVerifierId,
        completionDate: selectedDate,
        submissionNote: submissionNote.trim() || undefined,
      });

      if (!result.success || !result.completion) {
        setSubmitError(result.error || 'Failed to submit completion. Please try again.');
        return;
      }

      setSubmitSuccess(result.completion);
      setCopiedToast('✓ Completion submitted for review!');
      setTimeout(() => setCopiedToast(null), 3000);
      await refreshVerificationData();
    } catch (err: any) {
      setSubmitError(err?.message || 'An unexpected error occurred during submission.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSendWhatsAppProof(completion: DbCompletion) {
    if (!challenge) return;
    const verifierObj = eligibleVerifiers.find((v) => v.user_id === completion.verifier_id);
    const verifierName = verifierObj?.display_name || 'Verifier';
    await openWhatsAppProofShare({
      challengeTitle: challenge.title,
      completionDate: completion.completion_date,
      note: completion.submission_note || undefined,
      verifierName,
    });
  }

  function openReassignModal(completion: DbCompletion) {
    if (isGuest) {
      showAuthModal('Account required to reassign verifiers.');
      return;
    }
    setReassigningCompletion(completion);
    const alternate = eligibleVerifiers.find((v) => v.user_id !== completion.verifier_id);
    setNewVerifierId(alternate ? alternate.user_id : '');
    setReassignError(null);
    setReassignModalVisible(true);
  }

  async function handleReassignSubmit() {
    if (!reassigningCompletion || !newVerifierId || isReassigning) return;

    setIsReassigning(true);
    setReassignError(null);
    try {
      const res = await reassignVerifier(reassigningCompletion.id, newVerifierId);
      if (!res.success) {
        setReassignError(res.error || 'Failed to reassign verifier.');
        return;
      }

      setReassignModalVisible(false);
      setReassigningCompletion(null);
      setCopiedToast('✓ Verifier reassigned successfully!');
      setTimeout(() => setCopiedToast(null), 3000);
      await refreshVerificationData();
    } catch (err: any) {
      setReassignError(err?.message || 'Failed to reassign verifier.');
    } finally {
      setIsReassigning(false);
    }
  }

  async function handleQuickApprove(comp: DbCompletion) {
    if (isGuest) {
      showAuthModal('Account required to verify peer dare submissions.');
      return;
    }
    if (isReviewing) return;
    setIsReviewing(true);
    try {
      const res = await reviewCompletion({
        completionId: comp.id,
        decision: 'approved',
      });
      if (!res.success) {
        setCopiedToast(`❌ ${res.error || 'Failed to approve'}`);
        setTimeout(() => setCopiedToast(null), 3500);
        return;
      }
      setCopiedToast('✓ Dare approved successfully!');
      setTimeout(() => setCopiedToast(null), 3000);
      await Promise.all([refreshVerificationData(), refreshPendingReviews()]);
    } catch (err: any) {
      setCopiedToast(`❌ ${err?.message || 'Error approving'}`);
      setTimeout(() => setCopiedToast(null), 3500);
    } finally {
      setIsReviewing(false);
    }
  }

  function openInlineRejectModal(comp: DbCompletion) {
    if (isGuest) {
      showAuthModal('Account required to verify peer dare submissions.');
      return;
    }
    setRejectingCompletion(comp);
    setInlineRejectionReason('');
    setInlineRejectModalVisible(true);
  }

  async function handleConfirmInlineReject() {
    if (!rejectingCompletion || isReviewing) return;
    setIsReviewing(true);
    try {
      const res = await reviewCompletion({
        completionId: rejectingCompletion.id,
        decision: 'rejected',
        rejectionReason: inlineRejectionReason.trim() || undefined,
      });
      if (!res.success) {
        setCopiedToast(`❌ ${res.error || 'Failed to reject'}`);
        setTimeout(() => setCopiedToast(null), 3500);
        return;
      }
      setInlineRejectModalVisible(false);
      setRejectingCompletion(null);
      setCopiedToast('Submission rejected.');
      setTimeout(() => setCopiedToast(null), 3000);
      await Promise.all([refreshVerificationData(), refreshPendingReviews()]);
    } catch (err: any) {
      setCopiedToast(`❌ ${err?.message || 'Error rejecting'}`);
      setTimeout(() => setCopiedToast(null), 3500);
    } finally {
      setIsReviewing(false);
    }
  }

  // Determine current submission state for UI
  const isOneTimeApproved = !isDaily && latestCompletion?.status === 'approved';
  const isOneTimePending = !isDaily && latestCompletion?.status === 'pending';
  const isTodayApproved = isDaily && todayCompletion?.status === 'approved';
  const isTodayPending = isDaily && todayCompletion?.status === 'pending';
  const isTodayRejected = isDaily && todayCompletion?.status === 'rejected';

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      {/* Floating feedback toast */}
      {copiedToast ? (
        <View style={[styles.toastContainer, { top: insets.top + DD.s6 }]}>
          <Text style={styles.toastText}>{copiedToast}</Text>
        </View>
      ) : null}

      {/* Back button floating header */}
      <View style={[styles.navBar, { paddingTop: insets.top + DD.s2 }]}>
        <Pressable
          onPress={handleBack}
          style={({ pressed }) => [styles.backPill, pressed && { opacity: 0.75 }]}
          accessibilityRole="button"
          accessibilityLabel="Go back">
          <Text style={styles.backPillText}>← Back</Text>
        </Pressable>

        <View style={styles.navRight}>
          <Pressable
            onPress={handleShare}
            style={({ pressed }) => [styles.shareNavBtn, pressed && { opacity: 0.75 }]}
            accessibilityRole="button"
            accessibilityLabel="Share challenge">
            <Text style={styles.shareNavBtnText}>📤 Share</Text>
          </Pressable>

          {challenge.joined && (
            <View style={styles.joinedPill}>
              <Text style={styles.joinedPillText}>✓ Joined</Text>
            </View>
          )}
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 160 },
        ]}
        showsVerticalScrollIndicator={false}>
        {/* Hero section */}
        <View style={[styles.hero, { borderBottomColor: catColor }]}>
          <View style={[styles.categoryTag, { backgroundColor: catColor + '22' }]}>
            <Text style={[styles.categoryTagText, { color: catColor }]}>
              {emoji} {challenge.category} • {isDaily ? 'Daily Dare' : 'One-Time Dare'}
            </Text>
          </View>
          <Text style={styles.title}>{challenge.title}</Text>
          <Text style={styles.creatorText}>by {challenge.creator}</Text>
        </View>

        {/* Stats grid */}
        <View style={styles.statsGrid}>
          <DetailStat
            icon="👥"
            value={formatParticipants(challenge.participants)}
            label="Challengers"
            color={DD.purple}
          />
          <DetailStat
            icon="⏱"
            value={timeLeft}
            label="Time left"
            color={DD.catFun}
          />
          <DetailStat
            icon="📅"
            value={`${challenge.durationDays}d`}
            label="Duration"
            color={DD.lime}
          />
        </View>

        {/* Verified Progress Section */}
        <View style={styles.section}>
          <View style={styles.progressHeader}>
            <View>
              <Text style={styles.sectionTitle}>
                {challenge.joined ? 'Verified Progress' : 'Challenge Progress'}
              </Text>
              {displayStreak > 0 && (
                <View style={styles.streakBadge}>
                  <Text style={styles.streakText}>🔥 {displayStreak} Day Streak</Text>
                </View>
              )}
            </View>
            <Text style={[styles.progressPct, { color: catColor }]}>
              {displayProgressPct}%
            </Text>
          </View>

          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${displayProgressPct}%` as any, backgroundColor: catColor },
              ]}
            />
          </View>

          <View style={styles.progressSubrow}>
            <Text style={styles.progressLabel}>
              {challenge.joined && participantProgress
                ? isDaily
                  ? `${displayVerifiedCount} of ${challenge.durationDays} days verified`
                  : `${displayVerifiedCount > 0 ? '1 of 1' : '0 of 1'} dare verified`
                : `${daysElapsed} of ${challenge.durationDays} days elapsed`}
            </Text>
            {isCompletedVerified && (
              <Text style={styles.completedBadgeText}>🏆 Completed!</Text>
            )}
          </View>

          {challenge.joined && (
            <Text style={styles.progressDisclaimer}>
              ℹ️ Only verifier-approved submissions count toward your verified progress and streak.
            </Text>
          )}
        </View>

        {/* PEER VERIFICATION & SUBMIT COMPLETION ACTION (For active participants) */}
        {challenge.joined && (
          <View style={styles.submissionSectionCard}>
            <View style={styles.cardHeaderRow}>
              <View>
                <View style={styles.badgeRow}>
                  <Text style={styles.verificationBadge}>PEER VERIFICATION</Text>
                  <Text style={styles.whatsappBadge}>💬 WhatsApp Proof</Text>
                </View>
                <Text style={styles.cardMainTitle}>Submit Challenge Completion</Text>
              </View>
            </View>

            <Text style={styles.cardDescription}>
              Submissions require peer verification. Submit below, then send your proof photo or video to your assigned verifier via WhatsApp. Progress counts once approved.
            </Text>

            {/* Daily Challenge Today Status Callouts */}
            {isDaily && isTodayApproved && (
              <View style={[styles.statusBanner, styles.statusBannerApproved]}>
                <Text style={styles.statusBannerIcon}>✅</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.statusBannerTitle}>Today is Verified!</Text>
                  <Text style={styles.statusBannerSub}>
                    Your completion for today ({todayDate}) has been approved by your verifier.
                  </Text>
                </View>
              </View>
            )}

            {isDaily && isTodayPending && (
              <View style={[styles.statusBanner, styles.statusBannerPending]}>
                <Text style={styles.statusBannerIcon}>⏳</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.statusBannerTitle}>Today is Pending Verification</Text>
                  <Text style={styles.statusBannerSub}>
                    Submitted for {todayDate}. Waiting for verifier approval.
                  </Text>
                  {todayCompletion && (
                    <Pressable
                      onPress={() => handleSendWhatsAppProof(todayCompletion)}
                      style={styles.remindBtn}>
                      <Text style={styles.remindBtnText}>📲 Send WhatsApp Proof</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            )}

            {isDaily && isTodayRejected && (
              <View style={[styles.statusBanner, styles.statusBannerRejected]}>
                <Text style={styles.statusBannerIcon}>❌</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.statusBannerTitle}>Submission Needs Resubmission</Text>
                  <Text style={styles.statusBannerSub}>
                    Reason: {todayCompletion?.rejection_reason || 'Proof was not approved.'}
                  </Text>
                </View>
              </View>
            )}

            {/* One-Time Dare Status Callouts */}
            {!isDaily && isOneTimeApproved && (
              <View style={[styles.statusBanner, styles.statusBannerApproved]}>
                <Text style={styles.statusBannerIcon}>🏆</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.statusBannerTitle}>Dare Completed & Verified!</Text>
                  <Text style={styles.statusBannerSub}>
                    Your completion has been approved. You conquered this dare!
                  </Text>
                </View>
              </View>
            )}

            {!isDaily && isOneTimePending && (
              <View style={[styles.statusBanner, styles.statusBannerPending]}>
                <Text style={styles.statusBannerIcon}>⏳</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.statusBannerTitle}>Dare Submission Pending Review</Text>
                  <Text style={styles.statusBannerSub}>
                    Your completion is currently awaiting review by your verifier.
                  </Text>
                  {latestCompletion && (
                    <Pressable
                      onPress={() => handleSendWhatsAppProof(latestCompletion)}
                      style={styles.remindBtn}>
                      <Text style={styles.remindBtnText}>📲 Send WhatsApp Proof</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            )}

            {/* Main Submit Button */}
            {(!isOneTimeApproved && !isOneTimePending) && (
              <View style={styles.submitActionBox}>
                <Pressable
                  onPress={() => openSubmitModal()}
                  style={({ pressed }) => [
                    styles.primarySubmitBtn,
                    pressed && { opacity: 0.88, transform: [{ scale: 0.98 }] },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Submit Completion">
                  <Text style={styles.primarySubmitBtnText}>
                    {isTodayApproved
                      ? '⚡ Submit Another Day'
                      : isTodayRejected
                        ? '🔄 Resubmit Today’s Completion'
                        : '⚡ Submit Completion'}
                  </Text>
                </Pressable>

                {/* Quick option to submit yesterday for daily dare grace window */}
                {isDaily && !yesterdayCompletion && isTodayApproved && (
                  <Pressable
                    onPress={() => openSubmitModal(yesterdayDate)}
                    style={styles.yesterdayBtn}>
                    <Text style={styles.yesterdayBtnText}>
                      ⏮️ Submit for Yesterday ({yesterdayDate})
                    </Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
        )}

        {/* SUBMISSIONS AWAITING REVIEW (for assigned verifiers) */}
        {reviewableSubmissions.length > 0 && (
          <View style={styles.reviewSectionCard}>
            <View style={styles.reviewSectionHeader}>
              <View style={styles.reviewTitleRow}>
                <Text style={styles.reviewIcon}>📋</Text>
                <Text style={styles.reviewMainTitle}>Awaiting Your Review</Text>
              </View>
              <View style={styles.reviewBadge}>
                <Text style={styles.reviewBadgeText}>{reviewableSubmissions.length} Pending</Text>
              </View>
            </View>

            <Text style={styles.reviewSubtext}>
              You were selected as verifier for these completions. Confirm that the challenger sent you proof before approving.
            </Text>

            <View style={styles.reviewList}>
              {reviewableSubmissions.map((item) => {
                const submitterName = participantDisplayName(item.participant_id, challenge);
                return (
                  <View key={item.id} style={styles.reviewItemCard}>
                    <View style={styles.reviewItemTop}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.reviewSubmitterName}>{submitterName}</Text>
                        <Text style={styles.reviewDateText}>
                          Date: {item.completion_date} • {formatSubmittedAt(item.submitted_at)}
                        </Text>
                      </View>
                      <View style={[styles.badgePill, styles.badgePending]}>
                        <Text style={styles.badgePendingText}>⏳ Pending</Text>
                      </View>
                    </View>

                    {item.submission_note ? (
                      <View style={styles.reviewNoteBox}>
                        <Text style={styles.reviewNoteText}>&quot;{item.submission_note}&quot;</Text>
                      </View>
                    ) : null}

                    {/* Review actions */}
                    <View style={styles.reviewButtonsRow}>
                      <Pressable
                        onPress={() => handleQuickApprove(item)}
                        disabled={isReviewing}
                        style={({ pressed }) => [
                          styles.quickApproveBtn,
                          pressed && { opacity: 0.8 },
                          isReviewing && { opacity: 0.6 },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel="Approve submission">
                        <Text style={styles.quickApproveText}>✓ Approve</Text>
                      </Pressable>

                      <Pressable
                        onPress={() => openInlineRejectModal(item)}
                        disabled={isReviewing}
                        style={({ pressed }) => [
                          styles.quickRejectBtn,
                          pressed && { opacity: 0.8 },
                          isReviewing && { opacity: 0.6 },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel="Reject submission">
                        <Text style={styles.quickRejectText}>✕ Reject</Text>
                      </Pressable>

                      <Pressable
                        onPress={() =>
                          router.push({
                            pathname: '/review/[id]',
                            params: { id: item.id },
                          })
                        }
                        style={styles.detailsReviewBtn}>
                        <Text style={styles.detailsReviewBtnText}>Details →</Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {/* SUBMISSION HISTORY & STATUS LIST (User's own records) */}
        {challenge.joined && userSubmissions.length > 0 && (
          <View style={styles.historyCard}>
            <View style={styles.historyHeader}>
              <Text style={styles.historyTitle}>Your Submissions & History</Text>
              <Text style={styles.historyCount}>{userSubmissions.length} logged</Text>
            </View>

            <View style={styles.historyList}>
              {userSubmissions.map((item) => {
                const verifierObj = eligibleVerifiers.find((v) => v.user_id === item.verifier_id);
                const verifierName =
                  verifierObj?.display_name ||
                  (item.verifier_id === challenge.creatorId ? challenge.creator : 'Peer Verifier');

                return (
                  <View key={item.id} style={styles.historyItem}>
                    <View style={styles.historyItemTop}>
                      <View>
                        <Text style={styles.historyDate}>
                          {item.completion_date === todayDate
                            ? `Today (${item.completion_date})`
                            : item.completion_date === yesterdayDate
                              ? `Yesterday (${item.completion_date})`
                              : item.completion_date}
                        </Text>
                        <Text style={styles.historyVerifier}>
                          Verifier: {verifierName}
                        </Text>
                      </View>

                      {/* Status Badges */}
                      {item.status === 'approved' && (
                        <View style={[styles.badgePill, styles.badgeApproved]}>
                          <Text style={styles.badgeApprovedText}>✓ Approved</Text>
                        </View>
                      )}
                      {item.status === 'pending' && (
                        <View style={[styles.badgePill, styles.badgePending]}>
                          <Text style={styles.badgePendingText}>⏳ Pending</Text>
                        </View>
                      )}
                      {item.status === 'rejected' && (
                        <View style={[styles.badgePill, styles.badgeRejected]}>
                          <Text style={styles.badgeRejectedText}>❌ Rejected</Text>
                        </View>
                      )}
                    </View>

                    {item.submission_note ? (
                      <Text style={styles.historyNote}>
                        Note: &quot;{item.submission_note}&quot;
                      </Text>
                    ) : null}

                    {item.rejection_reason && item.status === 'rejected' ? (
                      <Text style={styles.rejectionReasonText}>
                        Feedback: {item.rejection_reason}
                      </Text>
                    ) : null}

                    {/* Actions on items */}
                    <View style={styles.historyActionsRow}>
                      {item.status === 'pending' && (
                        <>
                          <Pressable
                            onPress={() => handleSendWhatsAppProof(item)}
                            style={styles.historyActionBtn}>
                            <Text style={styles.historyActionBtnText}>💬 WhatsApp Proof</Text>
                          </Pressable>
                          <Pressable
                            onPress={() => openReassignModal(item)}
                            style={styles.historyActionBtnSecondary}>
                            <Text style={styles.historyActionBtnSecondaryText}>
                              🔄 Reassign Verifier
                            </Text>
                          </Pressable>
                        </>
                      )}

                      {item.status === 'rejected' && (
                        <Pressable
                          onPress={() => openSubmitModal(item.completion_date)}
                          style={styles.historyActionBtn}>
                          <Text style={styles.historyActionBtnText}>🔄 Resubmit for this date</Text>
                        </Pressable>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {/* Invite Friends Card */}
        <View style={styles.inviteCard}>
          <View style={styles.inviteHeader}>
            <View>
              <Text style={styles.inviteTitle}>Invite Challengers</Text>
              <Text style={styles.inviteSubtitle}>
                Dares are 3x more likely to be completed with friends.
              </Text>
            </View>
            <Text style={styles.inviteBadge}>🔥 Active</Text>
          </View>

          <View style={styles.inviteButtonsRow}>
            <Pressable
              onPress={handleCopy}
              style={({ pressed }) => [
                styles.inviteBtn,
                styles.inviteBtnCopy,
                pressed && { opacity: 0.85 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Copy invite link">
              <Text style={styles.inviteBtnCopyText}>🔗 Copy Link</Text>
            </Pressable>

            <Pressable
              onPress={handleShare}
              style={({ pressed }) => [
                styles.inviteBtn,
                styles.inviteBtnShare,
                pressed && { opacity: 0.85 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Native share challenge">
              <Text style={styles.inviteBtnShareText}>📤 Share Dare</Text>
            </Pressable>

            <Pressable
              onPress={openInviteFriendsModal}
              style={({ pressed }) => [
                styles.inviteBtn,
                { backgroundColor: DD.purple + '22', borderColor: DD.purple },
                pressed && { opacity: 0.85 },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Invite accepted friends to challenge">
              <Text style={[styles.inviteBtnShareText, { color: DD.purple }]}>👥 Invite Friends</Text>
            </Pressable>
          </View>

          {/* Toggle technical link details */}
          <Pressable
            onPress={() => setShowLinkInfo(!showLinkInfo)}
            style={styles.linkInfoToggle}>
            <Text style={styles.linkInfoToggleText}>
              {showLinkInfo ? 'Hide URL details ▲' : 'Show URL & deep link details ▼'}
            </Text>
          </Pressable>

          {showLinkInfo && (
            <View style={styles.linkDetailsBox}>
              <View style={styles.urlItem}>
                <Text style={styles.urlLabel}>Primary Invite URL:</Text>
                <Text style={styles.urlValue} numberOfLines={2} selectable>
                  {inviteUrls.primaryUrl}
                </Text>
              </View>
              <View style={styles.urlItem}>
                <Text style={styles.urlLabel}>Native Deep Link:</Text>
                <Text style={styles.urlValue} numberOfLines={2} selectable>
                  {inviteUrls.deepLink}
                </Text>
              </View>
              <Text style={styles.urlNote}>
                {inviteUrls.httpsUrl
                  ? '🌐 Public HTTPS invite link active. Anyone can open this on web or mobile.'
                  : 'ℹ️ Using local deep link scheme (`daredrop://`). Set EXPO_PUBLIC_APP_URL in .env to enable public HTTPS links.'}
              </Text>
            </View>
          )}
        </View>

        {/* Description */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>About this challenge</Text>
          <View style={styles.descriptionCard}>
            <Text style={styles.description}>{challenge.description}</Text>
          </View>
        </View>

        {/* Rules */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>How it works</Text>
          <View style={styles.rulesList}>
            {[
              'Commit to the duration before joining',
              'Submit completion daily and assign a peer verifier',
              'Share your photo or video proof directly with your verifier via WhatsApp',
              'Only verifier-approved submissions count toward your streak and badge',
            ].map((rule, i) => (
              <View key={i} style={styles.ruleItem}>
                <View style={[styles.ruleNumber, { backgroundColor: catColor + '22' }]}>
                  <Text style={[styles.ruleNumberText, { color: catColor }]}>{i + 1}</Text>
                </View>
                <Text style={styles.ruleText}>{rule}</Text>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>

      {/* CTA Bottom Bar */}
      <View style={[styles.ctaContainer, { paddingBottom: insets.bottom + DD.s4 }]}>
        {challenge.joined ? (
          <View style={styles.joinedCtaRow}>
            <Pressable
              onPress={() => openSubmitModal()}
              style={({ pressed }) => [
                styles.bottomSubmitBtn,
                pressed && { opacity: 0.9, transform: [{ scale: 0.98 }] },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Submit Completion">
              <Text style={styles.bottomSubmitBtnText}>⚡ Submit Completion</Text>
            </Pressable>

            <Pressable
              onPress={handleJoinToggle}
              disabled={isJoining}
              style={styles.leaveTextBtn}>
              {isJoining ? (
                <ActivityIndicator color={DD.textMuted} size="small" />
              ) : (
                <Text style={styles.leaveText}>Leave Dare</Text>
              )}
            </Pressable>
          </View>
        ) : (
          <Pressable
            onPress={handleJoinToggle}
            disabled={isJoining}
            style={({ pressed }) => [
              styles.ctaButton,
              styles.ctaButtonJoin,
              { backgroundColor: catColor },
              pressed && !isJoining && { opacity: 0.88, transform: [{ scale: 0.98 }] },
              isJoining && { opacity: 0.7 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Join challenge">
            {isJoining ? (
              <ActivityIndicator color={DD.bg} size="small" />
            ) : (
              <Text style={[styles.ctaText, styles.ctaTextJoin]}>
                🚀 Join Challenge
              </Text>
            )}
          </Pressable>
        )}
      </View>

      {/* SUBMISSION MODAL */}
      <Modal
        visible={submitModalVisible}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setSubmitModalVisible(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {/* Modal Header */}
            <View style={styles.modalHeaderRow}>
              <View>
                <Text style={styles.modalTitle}>Submit Completion</Text>
                <Text style={styles.modalSubtitle}>
                  {challenge.title}
                </Text>
              </View>
              <Pressable
                onPress={() => setSubmitModalVisible(false)}
                style={styles.modalCloseBtn}>
                <Text style={styles.modalCloseBtnText}>✕</Text>
              </Pressable>
            </View>

            {submitSuccess ? (
              /* Success State */
              <View style={styles.successStateBox}>
                <Text style={styles.successIcon}>🎉</Text>
                <Text style={styles.successTitle}>Completion Submitted!</Text>
                <Text style={styles.successMsg}>
                  Your submission for {submitSuccess.completion_date} is now pending peer review.
                </Text>

                <View style={styles.successProofBox}>
                  <Text style={styles.successProofNotice}>
                    📸 Proof photos and videos are not uploaded to Supabase. Please send your proof directly to your assigned verifier via WhatsApp!
                  </Text>
                </View>

                <Pressable
                  onPress={() => handleSendWhatsAppProof(submitSuccess)}
                  style={styles.whatsAppShareBtn}>
                  <Text style={styles.whatsAppShareBtnText}>📲 Share Proof on WhatsApp</Text>
                </Pressable>

                <Pressable
                  onPress={() => setSubmitModalVisible(false)}
                  style={styles.modalDoneBtn}>
                  <Text style={styles.modalDoneBtnText}>Done</Text>
                </Pressable>
              </View>
            ) : (
              /* Form State */
              <ScrollView showsVerticalScrollIndicator={false}>
                {/* Date Selection (Daily challenge) */}
                {isDaily ? (
                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>Completion Date</Text>
                    <View style={styles.dateSelectorRow}>
                      <Pressable
                        onPress={() => setSelectedDate(todayDate)}
                        style={[
                          styles.dateOption,
                          selectedDate === todayDate && styles.dateOptionActive,
                        ]}>
                        <Text
                          style={[
                            styles.dateOptionText,
                            selectedDate === todayDate && styles.dateOptionTextActive,
                          ]}>
                          📅 Today ({todayDate})
                        </Text>
                      </Pressable>

                      <Pressable
                        onPress={() => setSelectedDate(yesterdayDate)}
                        style={[
                          styles.dateOption,
                          selectedDate === yesterdayDate && styles.dateOptionActive,
                        ]}>
                        <Text
                          style={[
                            styles.dateOptionText,
                            selectedDate === yesterdayDate && styles.dateOptionTextActive,
                          ]}>
                          ⏮️ Yesterday ({yesterdayDate})
                        </Text>
                      </Pressable>
                    </View>
                    <Text style={styles.formHint}>
                      Challenges allow submissions for today and yesterday in the challenge timezone ({challenge.timezone || 'UTC'}).
                    </Text>
                  </View>
                ) : (
                  <View style={styles.formGroup}>
                    <Text style={styles.formLabel}>Dare Date</Text>
                    <Text style={styles.staticDateText}>📅 Today: {todayDate}</Text>
                  </View>
                )}

                {/* Verifier Selection */}
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Assign Peer Verifier</Text>
                  {eligibleVerifiers.length === 0 ? (
                    <View style={styles.noVerifiersBox}>
                      <Text style={styles.noVerifiersText}>
                        ⚠️ No eligible verifiers found. Peer verification requires at least one other participant or referee.
                      </Text>
                      <Pressable
                        onPress={() => {
                          setSubmitModalVisible(false);
                          handleShare();
                        }}
                        style={styles.inviteFriendsAction}>
                        <Text style={styles.inviteFriendsActionText}>
                          📤 Invite a friend to this challenge
                        </Text>
                      </Pressable>
                    </View>
                  ) : (
                    <View style={styles.verifiersList}>
                      {eligibleVerifiers.map((v) => (
                        <Pressable
                          key={v.user_id}
                          onPress={() => setSelectedVerifierId(v.user_id)}
                          style={[
                            styles.verifierOption,
                            selectedVerifierId === v.user_id && styles.verifierOptionActive,
                          ]}>
                          <View style={styles.verifierOptionLeft}>
                            <Text style={styles.verifierOptionAvatar}>
                              {v.is_creator ? '👑' : '👤'}
                            </Text>
                            <View>
                              <Text
                                style={[
                                  styles.verifierOptionName,
                                  selectedVerifierId === v.user_id && styles.verifierOptionNameActive,
                                ]}>
                                {v.display_name}
                              </Text>
                              <Text style={styles.verifierOptionRole}>
                                {v.is_creator ? 'Challenge Referee / Creator' : 'Fellow Participant'}
                              </Text>
                            </View>
                          </View>

                          <View
                            style={[
                              styles.radioCircle,
                              selectedVerifierId === v.user_id && styles.radioCircleActive,
                            ]}>
                            {selectedVerifierId === v.user_id && <View style={styles.radioDot} />}
                          </View>
                        </Pressable>
                      ))}
                    </View>
                  )}
                </View>

                {/* Optional Submission Note */}
                <View style={styles.formGroup}>
                  <Text style={styles.formLabel}>Submission Note (Optional)</Text>
                  <TextInput
                    style={styles.textInput}
                    placeholder="e.g. 50 pushups completed, 3 sets. Felt great!"
                    placeholderTextColor={DD.textMuted}
                    value={submissionNote}
                    onChangeText={setSubmissionNote}
                    multiline
                    numberOfLines={3}
                    maxLength={300}
                  />
                </View>

                {/* WhatsApp Info Notice */}
                <View style={styles.infoNoticeBox}>
                  <Text style={styles.infoNoticeTitle}>💬 How Peer Verification Works:</Text>
                  <Text style={styles.infoNoticeBody}>
                    {"1. Tap Submit below to log your completion on DareDrop.\n2. Next, tap 'Share Proof on WhatsApp' to send your photo/video directly to your verifier.\n3. Once your verifier approves it, your streak and progress will update!"}
                  </Text>
                </View>

                {/* Error Banner */}
                {submitError && (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorText}>⚠️ {submitError}</Text>
                  </View>
                )}

                {/* Action Button */}
                <Pressable
                  onPress={handleSubmitCompletion}
                  disabled={isSubmitting || !selectedVerifierId || eligibleVerifiers.length === 0}
                  style={({ pressed }) => [
                    styles.modalSubmitActionBtn,
                    (isSubmitting || !selectedVerifierId || eligibleVerifiers.length === 0) &&
                      styles.btnDisabled,
                    pressed && !isSubmitting && { opacity: 0.88 },
                  ]}>
                  {isSubmitting ? (
                    <ActivityIndicator color={DD.bg} size="small" />
                  ) : (
                    <Text style={styles.modalSubmitActionBtnText}>
                      Submit for Peer Verification
                    </Text>
                  )}
                </Pressable>
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* REASSIGN VERIFIER MODAL */}
      <Modal
        visible={reassignModalVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setReassignModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeaderRow}>
              <View>
                <Text style={styles.modalTitle}>Reassign Verifier</Text>
                <Text style={styles.modalSubtitle}>
                  Choose a new peer to verify this submission
                </Text>
              </View>
              <Pressable
                onPress={() => setReassignModalVisible(false)}
                style={styles.modalCloseBtn}>
                <Text style={styles.modalCloseBtnText}>✕</Text>
              </Pressable>
            </View>

            <View style={{ marginVertical: DD.s3 }}>
              {eligibleVerifiers
                .filter((v) => v.user_id !== reassigningCompletion?.verifier_id)
                .map((v) => (
                  <Pressable
                    key={v.user_id}
                    onPress={() => setNewVerifierId(v.user_id)}
                    style={[
                      styles.verifierOption,
                      newVerifierId === v.user_id && styles.verifierOptionActive,
                    ]}>
                    <Text style={styles.verifierOptionAvatar}>
                      {v.is_creator ? '👑' : '👤'}
                    </Text>
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[
                          styles.verifierOptionName,
                          newVerifierId === v.user_id && styles.verifierOptionNameActive,
                        ]}>
                        {v.display_name}
                      </Text>
                      <Text style={styles.verifierOptionRole}>
                        {v.is_creator ? 'Referee' : 'Participant'}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.radioCircle,
                        newVerifierId === v.user_id && styles.radioCircleActive,
                      ]}>
                      {newVerifierId === v.user_id && <View style={styles.radioDot} />}
                    </View>
                  </Pressable>
                ))}

              {eligibleVerifiers.filter(
                (v) => v.user_id !== reassigningCompletion?.verifier_id,
              ).length === 0 && (
                <Text style={styles.noVerifiersText}>
                  No other eligible verifiers available. Invite more participants to the challenge to reassign.
                </Text>
              )}
            </View>

            {reassignError && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>⚠️ {reassignError}</Text>
              </View>
            )}

            <Pressable
              onPress={handleReassignSubmit}
              disabled={isReassigning || !newVerifierId}
              style={[
                styles.modalSubmitActionBtn,
                (!newVerifierId || isReassigning) && styles.btnDisabled,
              ]}>
              {isReassigning ? (
                <ActivityIndicator color={DD.bg} size="small" />
              ) : (
                <Text style={styles.modalSubmitActionBtnText}>Confirm Reassignment</Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Inline Reject Modal */}
      <Modal
        visible={inlineRejectModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => !isReviewing && setInlineRejectModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.modalTitle}>Reject Submission</Text>
                <Text style={styles.modalSubtitle}>
                  Provide feedback to the participant so they can submit valid proof.
                </Text>
              </View>
              <Pressable
                onPress={() => setInlineRejectModalVisible(false)}
                disabled={isReviewing}
                style={styles.modalCloseBtn}>
                <Text style={styles.modalCloseBtnText}>✕</Text>
              </Pressable>
            </View>

            <View style={{ marginVertical: DD.s4 }}>
              <TextInput
                style={styles.textInput}
                placeholder="e.g., Proof photo was missing or incomplete"
                placeholderTextColor={DD.textMuted}
                value={inlineRejectionReason}
                onChangeText={setInlineRejectionReason}
                maxLength={MAX_REJECTION_REASON_LENGTH}
                multiline
                numberOfLines={3}
                editable={!isReviewing}
              />
            </View>

            <Pressable
              onPress={handleConfirmInlineReject}
              disabled={isReviewing}
              style={[styles.modalConfirmRejectBtn, isReviewing && { opacity: 0.5 }]}>
              {isReviewing ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.modalConfirmRejectText}>Confirm Reject</Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* Invite Friends Modal */}
      <Modal
        visible={inviteModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setInviteModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '80%' }]}>
            <View style={styles.modalHeaderRow}>
              <View>
                <Text style={styles.modalTitle}>Invite Friends</Text>
                <Text style={styles.modalSubtitle}>
                  Select friends to challenge them to &ldquo;{challenge?.title}&rdquo;
                </Text>
              </View>
              <Pressable
                onPress={() => setInviteModalVisible(false)}
                hitSlop={8}
                style={styles.modalCloseBtn}>
                <Text style={styles.modalCloseBtnText}>✕</Text>
              </Pressable>
            </View>

            {inviteFriendError && (
              <View style={[styles.errorBox, { marginVertical: DD.s2 }]}>
                <Text style={styles.errorText}>⚠️ {inviteFriendError}</Text>
              </View>
            )}

            {loadingFriends ? (
              <View style={{ paddingVertical: DD.s8, alignItems: 'center' }}>
                <ActivityIndicator color={DD.lime} size="large" />
                <Text style={{ color: DD.textMuted, marginTop: DD.s2, fontSize: 13 }}>
                  Loading your friends...
                </Text>
              </View>
            ) : myFriends.length === 0 ? (
              <View style={{ paddingVertical: DD.s6, alignItems: 'center' }}>
                <Text style={{ fontSize: 32, marginBottom: DD.s2 }}>🤝</Text>
                <Text style={{ fontSize: 16, fontWeight: '800', color: DD.text, marginBottom: DD.s1 }}>
                  No friends added yet
                </Text>
                <Text style={{ fontSize: 13, color: DD.textSub, textAlign: 'center', marginBottom: DD.s4 }}>
                  Connect with friends using Friend Codes to invite them directly to dares!
                </Text>
                <Pressable
                  onPress={() => {
                    setInviteModalVisible(false);
                    router.push('/friends');
                  }}
                  style={{
                    backgroundColor: DD.lime,
                    paddingHorizontal: DD.s4,
                    paddingVertical: DD.s2,
                    borderRadius: DD.radiusPill,
                  }}>
                  <Text style={{ color: DD.bg, fontWeight: '800', fontSize: 13 }}>Go to Friends & Social →</Text>
                </Pressable>
              </View>
            ) : (
              <ScrollView style={{ marginTop: DD.s3 }} showsVerticalScrollIndicator={false}>
                {myFriends.map((f) => {
                  const isInvited = invitedFriendIds.has(f.friend_user_id);
                  const isAlreadyParticipant = eligibleVerifiers.some((v) => v.user_id === f.friend_user_id);
                  const isInviting = invitingFriendId === f.friend_user_id;

                  return (
                    <View
                      key={f.friendship_id}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        backgroundColor: DD.bgElement,
                        padding: DD.s3,
                        borderRadius: DD.radiusMd,
                        marginBottom: DD.s2,
                        borderWidth: 1,
                        borderColor: DD.border,
                      }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: DD.s3, flex: 1 }}>
                        <Text style={{ fontSize: 24 }}>{f.avatar_emoji || '🦁'}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 14, fontWeight: '800', color: DD.text }} numberOfLines={1}>
                            {f.display_name}
                          </Text>
                          <Text style={{ fontSize: 11, color: DD.textMuted }}>{f.friend_code}</Text>
                        </View>
                      </View>

                      {isInvited ? (
                        <View
                          style={{
                            paddingHorizontal: DD.s3,
                            paddingVertical: DD.s1,
                            borderRadius: DD.radiusPill,
                            backgroundColor: DD.lime + '22',
                            borderWidth: 1,
                            borderColor: DD.lime,
                          }}>
                          <Text style={{ color: DD.lime, fontSize: 11, fontWeight: '800' }}>Invited ✓</Text>
                        </View>
                      ) : isAlreadyParticipant ? (
                        <View
                          style={{
                            paddingHorizontal: DD.s3,
                            paddingVertical: DD.s1,
                            borderRadius: DD.radiusPill,
                            backgroundColor: DD.bgCard,
                            borderWidth: 1,
                            borderColor: DD.border,
                          }}>
                          <Text style={{ color: DD.textMuted, fontSize: 11, fontWeight: '700' }}>Joined ✓</Text>
                        </View>
                      ) : (
                        <Pressable
                          onPress={() => handleInviteFriend(f)}
                          disabled={isInviting}
                          style={({ pressed }) => [
                            {
                              backgroundColor: DD.purple,
                              paddingHorizontal: DD.s3,
                              paddingVertical: DD.s2,
                              borderRadius: DD.radiusPill,
                              minWidth: 70,
                              alignItems: 'center',
                            },
                            pressed && { opacity: 0.8 },
                          ]}>
                          {isInviting ? (
                            <ActivityIndicator size="small" color="#fff" />
                          ) : (
                            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800' }}>Invite ⚡</Text>
                          )}
                        </Pressable>
                      )}
                    </View>
                  );
                })}
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

function DetailStat({
  icon,
  value,
  label,
  color,
}: {
  icon: string;
  value: string;
  label: string;
  color: string;
}) {
  return (
    <View style={detailStatStyles.box}>
      <Text style={detailStatStyles.icon}>{icon}</Text>
      <Text style={[detailStatStyles.value, { color }]}>{value}</Text>
      <Text style={detailStatStyles.label}>{label}</Text>
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
    gap: DD.s3,
  },
  loadingText: {
    color: DD.textSub,
    fontSize: 15,
    fontWeight: '600',
  },
  notFound: {
    justifyContent: 'center',
    alignItems: 'center',
    gap: DD.s4,
    paddingHorizontal: DD.s5,
  },
  notFoundIcon: {
    fontSize: 48,
  },
  notFoundText: {
    fontSize: 20,
    fontWeight: '800',
    color: DD.text,
  },
  notFoundSubtext: {
    fontSize: 14,
    color: DD.textSub,
    textAlign: 'center',
    maxWidth: 280,
  },
  toastContainer: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 999,
    backgroundColor: DD.bgCard,
    borderWidth: 1.5,
    borderColor: DD.lime,
    paddingVertical: DD.s2,
    paddingHorizontal: DD.s4,
    borderRadius: DD.radiusPill,
    shadowColor: DD.lime,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 8,
  },
  toastText: {
    color: DD.lime,
    fontSize: 13,
    fontWeight: '800',
  },
  navBar: {
    paddingHorizontal: DD.s5,
    paddingBottom: DD.s3,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: DD.bg,
    borderBottomWidth: 1,
    borderBottomColor: DD.border,
    zIndex: 10,
  },
  navRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s2,
  },
  backPill: {
    backgroundColor: DD.bgCard,
    paddingVertical: DD.s2,
    paddingHorizontal: DD.s3,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
    borderColor: DD.border,
  },
  backPillText: {
    fontSize: 13,
    fontWeight: '700',
    color: DD.text,
  },
  shareNavBtn: {
    backgroundColor: DD.bgCard,
    paddingVertical: DD.s2,
    paddingHorizontal: DD.s3,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
    borderColor: DD.border,
  },
  shareNavBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: DD.text,
  },
  joinedPill: {
    backgroundColor: DD.lime + '22',
    borderWidth: 1,
    borderColor: DD.lime,
    paddingVertical: DD.s2,
    paddingHorizontal: DD.s3,
    borderRadius: DD.radiusPill,
  },
  joinedPillText: {
    fontSize: 12,
    fontWeight: '800',
    color: DD.lime,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingTop: DD.s4,
    paddingHorizontal: DD.s5,
  },
  hero: {
    paddingBottom: DD.s5,
    borderBottomWidth: 2,
    marginBottom: DD.s5,
  },
  categoryTag: {
    alignSelf: 'flex-start',
    paddingVertical: DD.s1,
    paddingHorizontal: DD.s3,
    borderRadius: DD.radiusPill,
    marginBottom: DD.s3,
  },
  categoryTagText: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  title: {
    fontSize: 26,
    fontWeight: '900',
    color: DD.text,
    letterSpacing: -0.5,
    lineHeight: 32,
    marginBottom: DD.s2,
  },
  creatorText: {
    fontSize: 13,
    color: DD.textSub,
    fontWeight: '500',
  },
  statsGrid: {
    flexDirection: 'row',
    gap: DD.s2,
    marginBottom: DD.s6,
  },
  section: {
    marginBottom: DD.s6,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: DD.text,
    letterSpacing: -0.3,
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: DD.s2,
  },
  progressPct: {
    fontSize: 16,
    fontWeight: '900',
  },
  progressTrack: {
    height: 10,
    backgroundColor: DD.bgCard,
    borderRadius: 5,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: DD.border,
  },
  progressFill: {
    height: '100%',
    borderRadius: 5,
  },
  progressSubrow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: DD.s2,
  },
  progressLabel: {
    fontSize: 12,
    color: DD.textSub,
    fontWeight: '600',
  },
  streakBadge: {
    marginTop: 2,
    alignSelf: 'flex-start',
  },
  streakText: {
    fontSize: 12,
    color: DD.lime,
    fontWeight: '800',
  },
  completedBadgeText: {
    fontSize: 12,
    color: DD.lime,
    fontWeight: '800',
  },
  progressDisclaimer: {
    fontSize: 11,
    color: DD.textMuted,
    fontStyle: 'italic',
    marginTop: 4,
  },
  submissionSectionCard: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    padding: DD.s5,
    borderWidth: 1.5,
    borderColor: DD.lime + '55',
    marginBottom: DD.s6,
    shadowColor: DD.lime,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 4,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: DD.s2,
  },
  badgeRow: {
    flexDirection: 'row',
    gap: DD.s2,
    marginBottom: DD.s2,
  },
  verificationBadge: {
    fontSize: 10,
    fontWeight: '900',
    color: DD.lime,
    backgroundColor: DD.lime + '18',
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: DD.radiusPill,
    letterSpacing: 0.5,
  },
  whatsappBadge: {
    fontSize: 10,
    fontWeight: '800',
    color: DD.success,
    backgroundColor: DD.success + '18',
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: DD.radiusPill,
  },
  cardMainTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: DD.text,
    letterSpacing: -0.3,
  },
  cardDescription: {
    fontSize: 13,
    color: DD.textSub,
    lineHeight: 18,
    marginBottom: DD.s4,
  },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s3,
    padding: DD.s3,
    borderRadius: DD.radiusMd,
    marginBottom: DD.s4,
    borderWidth: 1,
  },
  statusBannerApproved: {
    backgroundColor: DD.success + '15',
    borderColor: DD.success + '44',
  },
  statusBannerPending: {
    backgroundColor: '#FFB80015',
    borderColor: '#FFB80044',
  },
  statusBannerRejected: {
    backgroundColor: DD.danger + '15',
    borderColor: DD.danger + '44',
  },
  statusBannerIcon: {
    fontSize: 20,
  },
  statusBannerTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: DD.text,
  },
  statusBannerSub: {
    fontSize: 12,
    color: DD.textSub,
    marginTop: 2,
  },
  remindBtn: {
    marginTop: DD.s2,
    alignSelf: 'flex-start',
    backgroundColor: DD.success,
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: DD.radiusPill,
  },
  remindBtnText: {
    color: DD.bg,
    fontSize: 11,
    fontWeight: '800',
  },
  submitActionBox: {
    gap: DD.s2,
  },
  primarySubmitBtn: {
    backgroundColor: DD.lime,
    paddingVertical: DD.s4,
    borderRadius: DD.radiusPill,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: DD.lime,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 5,
  },
  primarySubmitBtnText: {
    color: DD.bg,
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.3,
  },
  yesterdayBtn: {
    alignItems: 'center',
    paddingVertical: DD.s2,
  },
  yesterdayBtnText: {
    color: DD.textSub,
    fontSize: 12,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  historyCard: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusLg,
    padding: DD.s4,
    borderWidth: 1,
    borderColor: DD.border,
    marginBottom: DD.s6,
  },
  historyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: DD.s3,
    paddingBottom: DD.s2,
    borderBottomWidth: 1,
    borderBottomColor: DD.border,
  },
  historyTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: DD.text,
  },
  historyCount: {
    fontSize: 12,
    color: DD.textMuted,
    fontWeight: '600',
  },
  historyList: {
    gap: DD.s3,
  },
  historyItem: {
    backgroundColor: DD.bgElement,
    borderRadius: DD.radiusMd,
    padding: DD.s3,
    borderWidth: 1,
    borderColor: DD.border,
  },
  historyItemTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  historyDate: {
    fontSize: 13,
    fontWeight: '800',
    color: DD.text,
  },
  historyVerifier: {
    fontSize: 11,
    color: DD.textSub,
    marginTop: 2,
  },
  badgePill: {
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
  },
  badgeApproved: {
    backgroundColor: DD.success + '22',
    borderColor: DD.success,
  },
  badgeApprovedText: {
    fontSize: 11,
    fontWeight: '800',
    color: DD.success,
  },
  badgePending: {
    backgroundColor: '#FFB80022',
    borderColor: '#FFB800',
  },
  badgePendingText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#FFB800',
  },
  badgeRejected: {
    backgroundColor: DD.danger + '22',
    borderColor: DD.danger,
  },
  badgeRejectedText: {
    fontSize: 11,
    fontWeight: '800',
    color: DD.danger,
  },
  historyNote: {
    fontSize: 12,
    color: DD.textSub,
    fontStyle: 'italic',
    marginTop: DD.s2,
  },
  rejectionReasonText: {
    fontSize: 12,
    color: DD.danger,
    marginTop: 4,
    fontWeight: '600',
  },
  historyActionsRow: {
    flexDirection: 'row',
    gap: DD.s2,
    marginTop: DD.s3,
    paddingTop: DD.s2,
    borderTopWidth: 1,
    borderTopColor: DD.border,
  },
  historyActionBtn: {
    backgroundColor: DD.lime,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: DD.radiusPill,
  },
  historyActionBtnText: {
    color: DD.bg,
    fontSize: 11,
    fontWeight: '800',
  },
  historyActionBtnSecondary: {
    backgroundColor: DD.bgCard,
    borderWidth: 1,
    borderColor: DD.border,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: DD.radiusPill,
  },
  historyActionBtnSecondaryText: {
    color: DD.textSub,
    fontSize: 11,
    fontWeight: '700',
  },
  inviteCard: {
    backgroundColor: DD.bgCard,
    borderWidth: 1.5,
    borderColor: DD.border,
    borderRadius: DD.radiusLg,
    padding: DD.s4,
    marginBottom: DD.s6,
  },
  inviteHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: DD.s3,
  },
  inviteTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: DD.text,
  },
  inviteSubtitle: {
    fontSize: 12,
    color: DD.textSub,
    marginTop: 2,
    maxWidth: 240,
  },
  inviteBadge: {
    fontSize: 11,
    fontWeight: '800',
    color: DD.lime,
    backgroundColor: DD.lime + '18',
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
    borderColor: DD.lime + '33',
  },
  inviteButtonsRow: {
    flexDirection: 'row',
    gap: DD.s2,
    marginTop: DD.s2,
  },
  inviteBtn: {
    flex: 1,
    paddingVertical: DD.s3,
    borderRadius: DD.radiusPill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inviteBtnCopy: {
    backgroundColor: DD.bgElement,
    borderWidth: 1,
    borderColor: DD.border,
  },
  inviteBtnCopyText: {
    color: DD.text,
    fontSize: 13,
    fontWeight: '700',
  },
  inviteBtnShare: {
    backgroundColor: DD.lime,
  },
  inviteBtnShareText: {
    color: DD.bg,
    fontSize: 13,
    fontWeight: '800',
  },
  linkInfoToggle: {
    marginTop: DD.s3,
    alignItems: 'center',
  },
  linkInfoToggleText: {
    fontSize: 11,
    color: DD.textMuted,
    fontWeight: '600',
  },
  linkDetailsBox: {
    marginTop: DD.s3,
    paddingTop: DD.s3,
    borderTopWidth: 1,
    borderTopColor: DD.border,
    gap: DD.s2,
  },
  urlItem: {
    gap: 2,
  },
  urlLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: DD.textMuted,
    textTransform: 'uppercase',
  },
  urlValue: {
    fontSize: 11,
    color: DD.lime,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    backgroundColor: DD.bgElement,
    padding: DD.s2,
    borderRadius: DD.radiusSm,
  },
  urlNote: {
    fontSize: 11,
    color: DD.textSub,
    fontStyle: 'italic',
    marginTop: 2,
  },
  descriptionCard: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusLg,
    padding: DD.s4,
    borderWidth: 1,
    borderColor: DD.border,
  },
  description: {
    fontSize: 14,
    color: DD.textSub,
    lineHeight: 22,
  },
  rulesList: {
    gap: DD.s2,
  },
  ruleItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s3,
    backgroundColor: DD.bgCard,
    padding: DD.s3,
    borderRadius: DD.radiusMd,
    borderWidth: 1,
    borderColor: DD.border,
  },
  ruleNumber: {
    width: 26,
    height: 26,
    borderRadius: 13,
    justifyContent: 'center',
    alignItems: 'center',
  },
  ruleNumberText: {
    fontSize: 12,
    fontWeight: '800',
  },
  ruleText: {
    flex: 1,
    fontSize: 13,
    color: DD.text,
    fontWeight: '500',
  },
  ctaContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: DD.bg + 'F0',
    paddingHorizontal: DD.s5,
    paddingTop: DD.s3,
    borderTopWidth: 1,
    borderTopColor: DD.border,
  },
  joinedCtaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s3,
  },
  bottomSubmitBtn: {
    flex: 2,
    backgroundColor: DD.lime,
    borderRadius: DD.radiusPill,
    paddingVertical: DD.s4,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: DD.lime,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  bottomSubmitBtnText: {
    color: DD.bg,
    fontSize: 15,
    fontWeight: '900',
  },
  leaveTextBtn: {
    flex: 1,
    backgroundColor: DD.bgCard,
    borderWidth: 1,
    borderColor: DD.border,
    paddingVertical: DD.s4,
    borderRadius: DD.radiusPill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  leaveText: {
    color: DD.textSub,
    fontSize: 13,
    fontWeight: '700',
  },
  ctaButton: {
    borderRadius: DD.radiusPill,
    paddingVertical: DD.s4,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  ctaButtonJoin: {
    shadowColor: DD.lime,
  },
  ctaText: {
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0.3,
  },
  ctaTextJoin: {
    color: DD.bg,
  },
  backBtn: {
    backgroundColor: DD.bgCard,
    borderWidth: 1,
    borderColor: DD.border,
    paddingVertical: DD.s3,
    paddingHorizontal: DD.s5,
    borderRadius: DD.radiusPill,
  },
  backBtnText: {
    color: DD.text,
    fontSize: 14,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: DD.bgCard,
    borderTopLeftRadius: DD.radiusCard,
    borderTopRightRadius: DD.radiusCard,
    paddingHorizontal: DD.s5,
    paddingTop: DD.s5,
    paddingBottom: DD.s8,
    maxHeight: '90%',
    borderWidth: 1,
    borderColor: DD.border,
  },
  modalHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: DD.s4,
    paddingBottom: DD.s3,
    borderBottomWidth: 1,
    borderBottomColor: DD.border,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '900',
    color: DD.text,
  },
  modalSubtitle: {
    fontSize: 12,
    color: DD.textSub,
    marginTop: 2,
  },
  modalCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: DD.bgElement,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalCloseBtnText: {
    color: DD.textSub,
    fontSize: 14,
    fontWeight: '700',
  },
  formGroup: {
    marginBottom: DD.s4,
  },
  formLabel: {
    fontSize: 13,
    fontWeight: '800',
    color: DD.text,
    marginBottom: DD.s2,
    letterSpacing: 0.2,
  },
  formHint: {
    fontSize: 11,
    color: DD.textMuted,
    marginTop: 4,
  },
  dateSelectorRow: {
    flexDirection: 'row',
    gap: DD.s2,
  },
  dateOption: {
    flex: 1,
    backgroundColor: DD.bgElement,
    borderWidth: 1.5,
    borderColor: DD.border,
    paddingVertical: DD.s3,
    paddingHorizontal: DD.s2,
    borderRadius: DD.radiusMd,
    alignItems: 'center',
  },
  dateOptionActive: {
    borderColor: DD.lime,
    backgroundColor: DD.lime + '15',
  },
  dateOptionText: {
    fontSize: 12,
    fontWeight: '700',
    color: DD.textSub,
  },
  dateOptionTextActive: {
    color: DD.lime,
    fontWeight: '800',
  },
  staticDateText: {
    color: DD.lime,
    fontSize: 13,
    fontWeight: '800',
    backgroundColor: DD.bgElement,
    padding: DD.s3,
    borderRadius: DD.radiusMd,
  },
  verifiersList: {
    gap: DD.s2,
  },
  verifierOption: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: DD.bgElement,
    padding: DD.s3,
    borderRadius: DD.radiusMd,
    borderWidth: 1.5,
    borderColor: DD.border,
  },
  verifierOptionActive: {
    borderColor: DD.lime,
    backgroundColor: DD.lime + '12',
  },
  verifierOptionLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s3,
  },
  verifierOptionAvatar: {
    fontSize: 20,
  },
  verifierOptionName: {
    fontSize: 13,
    fontWeight: '800',
    color: DD.text,
  },
  verifierOptionNameActive: {
    color: DD.lime,
  },
  verifierOptionRole: {
    fontSize: 11,
    color: DD.textSub,
    marginTop: 2,
  },
  radioCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: DD.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioCircleActive: {
    borderColor: DD.lime,
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: DD.lime,
  },
  noVerifiersBox: {
    backgroundColor: DD.bgElement,
    padding: DD.s4,
    borderRadius: DD.radiusMd,
    borderWidth: 1,
    borderColor: DD.border,
    gap: DD.s3,
  },
  noVerifiersText: {
    fontSize: 12,
    color: DD.textSub,
    lineHeight: 18,
  },
  inviteFriendsAction: {
    backgroundColor: DD.lime + '22',
    borderWidth: 1,
    borderColor: DD.lime,
    paddingVertical: DD.s2,
    paddingHorizontal: DD.s3,
    borderRadius: DD.radiusPill,
    alignSelf: 'flex-start',
  },
  inviteFriendsActionText: {
    color: DD.lime,
    fontSize: 12,
    fontWeight: '800',
  },
  textInput: {
    backgroundColor: DD.bgElement,
    borderRadius: DD.radiusMd,
    borderWidth: 1,
    borderColor: DD.border,
    padding: DD.s3,
    color: DD.text,
    fontSize: 13,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  infoNoticeBox: {
    backgroundColor: DD.bgElevated,
    borderRadius: DD.radiusMd,
    padding: DD.s3,
    marginBottom: DD.s4,
    borderWidth: 1,
    borderColor: DD.border,
  },
  infoNoticeTitle: {
    fontSize: 12,
    fontWeight: '800',
    color: DD.lime,
    marginBottom: 4,
  },
  infoNoticeBody: {
    fontSize: 11,
    color: DD.textSub,
    lineHeight: 16,
  },
  errorBox: {
    backgroundColor: DD.danger + '22',
    borderWidth: 1,
    borderColor: DD.danger,
    padding: DD.s3,
    borderRadius: DD.radiusMd,
    marginBottom: DD.s4,
  },
  errorText: {
    fontSize: 12,
    color: DD.danger,
    fontWeight: '600',
  },
  modalSubmitActionBtn: {
    backgroundColor: DD.lime,
    paddingVertical: DD.s4,
    borderRadius: DD.radiusPill,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: DD.s2,
  },
  modalSubmitActionBtnText: {
    color: DD.bg,
    fontSize: 15,
    fontWeight: '900',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  successStateBox: {
    alignItems: 'center',
    paddingVertical: DD.s4,
    gap: DD.s3,
  },
  successIcon: {
    fontSize: 48,
  },
  successTitle: {
    fontSize: 20,
    fontWeight: '900',
    color: DD.text,
  },
  successMsg: {
    fontSize: 13,
    color: DD.textSub,
    textAlign: 'center',
    maxWidth: 280,
  },
  successProofBox: {
    backgroundColor: DD.bgElement,
    padding: DD.s3,
    borderRadius: DD.radiusMd,
    borderWidth: 1,
    borderColor: DD.border,
    marginVertical: DD.s2,
  },
  successProofNotice: {
    fontSize: 12,
    color: DD.lime,
    textAlign: 'center',
    fontWeight: '600',
    lineHeight: 18,
  },
  whatsAppShareBtn: {
    backgroundColor: DD.success,
    paddingVertical: DD.s4,
    paddingHorizontal: DD.s6,
    borderRadius: DD.radiusPill,
    width: '100%',
    alignItems: 'center',
    shadowColor: DD.success,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  whatsAppShareBtnText: {
    color: DD.bg,
    fontSize: 15,
    fontWeight: '900',
  },
  modalDoneBtn: {
    paddingVertical: DD.s3,
  },
  modalDoneBtnText: {
    color: DD.textSub,
    fontSize: 14,
    fontWeight: '700',
  },
  reviewSectionCard: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    padding: DD.s5,
    borderWidth: 1,
    borderColor: '#FFB80066',
    gap: DD.s3,
  },
  reviewSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  reviewTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s2,
  },
  reviewIcon: {
    fontSize: 20,
  },
  reviewMainTitle: {
    fontSize: 17,
    fontWeight: '900',
    color: DD.text,
  },
  reviewBadge: {
    backgroundColor: '#FFB80022',
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s1,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
    borderColor: '#FFB800',
  },
  reviewBadgeText: {
    color: '#FFB800',
    fontSize: 11,
    fontWeight: '800',
  },
  reviewSubtext: {
    fontSize: 12,
    color: DD.textSub,
    lineHeight: 17,
  },
  reviewList: {
    gap: DD.s3,
  },
  reviewItemCard: {
    backgroundColor: DD.bgElement,
    borderRadius: DD.radiusMd,
    padding: DD.s4,
    borderWidth: 1,
    borderColor: DD.border,
    gap: DD.s2,
  },
  reviewItemTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  reviewSubmitterName: {
    fontSize: 14,
    fontWeight: '800',
    color: DD.text,
  },
  reviewDateText: {
    fontSize: 11,
    color: DD.textMuted,
    marginTop: 2,
  },
  reviewNoteBox: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusSm,
    padding: DD.s3,
    borderWidth: 1,
    borderColor: DD.border,
  },
  reviewNoteText: {
    fontSize: 12,
    color: DD.text,
    fontStyle: 'italic',
  },
  reviewButtonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s2,
    marginTop: DD.s1,
  },
  quickApproveBtn: {
    flex: 1,
    backgroundColor: DD.lime,
    paddingVertical: DD.s2 + 2,
    borderRadius: DD.radiusPill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickApproveText: {
    color: DD.bg,
    fontWeight: '800',
    fontSize: 13,
  },
  quickRejectBtn: {
    flex: 1,
    backgroundColor: DD.bgCard,
    paddingVertical: DD.s2 + 2,
    borderRadius: DD.radiusPill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: DD.danger + '88',
  },
  quickRejectText: {
    color: DD.danger,
    fontWeight: '800',
    fontSize: 13,
  },
  detailsReviewBtn: {
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s2,
  },
  detailsReviewBtnText: {
    color: DD.lime,
    fontWeight: '700',
    fontSize: 12,
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

const detailStatStyles = StyleSheet.create({
  box: {
    flex: 1,
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusLg,
    paddingVertical: DD.s3,
    paddingHorizontal: DD.s2,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: DD.border,
  },
  icon: {
    fontSize: 20,
    marginBottom: DD.s1,
  },
  value: {
    fontSize: 17,
    fontWeight: '900',
    letterSpacing: -0.5,
  },
  label: {
    fontSize: 11,
    color: DD.textMuted,
    fontWeight: '600',
    marginTop: 2,
  },
});
