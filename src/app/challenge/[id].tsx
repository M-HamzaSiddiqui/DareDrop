import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  KeyboardAvoidingView,
  Modal,
  Platform,
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
import { DDAvatar } from '@/components/ui/dd-avatar';
import { DDBadge } from '@/components/ui/dd-badge';
import { DDButton } from '@/components/ui/dd-button';
import { DDCard } from '@/components/ui/dd-card';
import { DDIcon, type DDIconName } from '@/components/ui/dd-icon';
import { DDText } from '@/components/ui/dd-text';

const CATEGORY_ICONS: Record<CategoryKey, DDIconName> = {
  Fitness: 'flame',
  Focus: 'target',
  Fun: 'sparkle',
  Learning: 'compass',
};

/**
 * DareDrop Redesigned Challenge Details Screen.
 *
 * Implements:
 * - Clean dark-first aesthetic with Neon Lime and Electric Violet accents
 * - Header navigation with Phosphor icons, share action, and joined status
 * - Hero banner with category/type badges and creator attribution
 * - 3-metric statistics grid (Challengers, Time Left, Duration)
 * - Verified progress tracker with streak flame indicator and progress bar
 * - Peer verification proof submission card with WhatsApp handoff and real-time status banners
 * - Verifier review queue for assigned peer approvals
 * - User submission log with verifier reassignment and resubmission triggers
 * - Friend invitation card with direct invite modal and deep-link copying
 * - Sticky bottom CTA with safe-area clearance
 */
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
        <ActivityIndicator size="large" color={DD_COLORS.lime} />
        <DDText variant="body" color="secondary" style={styles.loadingText}>
          Loading challenge…
        </DDText>
      </View>
    );
  }

  if (!challenge) {
    return (
      <View style={[styles.root, styles.notFound]}>
        <StatusBar style="light" />
        <View style={styles.notFoundIconCircle}>
          <DDIcon name="search" size={40} color={DD_COLORS.textMuted} weight="bold" />
        </View>
        <DDText variant="h2" color="primary">
          Challenge not found
        </DDText>
        <DDText variant="bodySm" color="secondary" align="center" style={styles.notFoundSubtext}>
          This challenge may have been removed or the link is invalid.
        </DDText>
        <DDButton
          title="Go Back"
          variant="secondary"
          iconLeft="arrow-left"
          onPress={handleBack}
          style={styles.backBtn}
        />
      </View>
    );
  }

  const catColor = CATEGORY_COLORS[challenge.category as CategoryKey] || DD_COLORS.lime;
  const catIcon = CATEGORY_ICONS[challenge.category as CategoryKey] || 'sparkle';
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
      setCopiedToast('Invite link copied to clipboard!');
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
      setCopiedToast(`Invitation sent to ${friend.display_name}!`);
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
        setCopiedToast(res.joined ? 'Welcome to the challenge!' : 'You left this challenge');
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
      setCopiedToast('Completion submitted for review!');
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
      setCopiedToast('Verifier reassigned successfully!');
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
        setCopiedToast(`Error: ${res.error || 'Failed to approve'}`);
        setTimeout(() => setCopiedToast(null), 3500);
        return;
      }
      setCopiedToast('Dare approved successfully!');
      setTimeout(() => setCopiedToast(null), 3000);
      await Promise.all([refreshVerificationData(), refreshPendingReviews()]);
    } catch (err: any) {
      setCopiedToast(`Error: ${err?.message || 'Error approving'}`);
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
        setCopiedToast(`Error: ${res.error || 'Failed to reject'}`);
        setTimeout(() => setCopiedToast(null), 3500);
        return;
      }
      setInlineRejectModalVisible(false);
      setRejectingCompletion(null);
      setCopiedToast('Submission rejected.');
      setTimeout(() => setCopiedToast(null), 3000);
      await Promise.all([refreshVerificationData(), refreshPendingReviews()]);
    } catch (err: any) {
      setCopiedToast(`Error: ${err?.message || 'Error rejecting'}`);
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
        <View style={[styles.toastContainer, { top: insets.top + DD_SPACING.sm }]}>
          <DDIcon name="check-circle" size={16} color={DD_COLORS.lime} weight="fill" />
          <DDText variant="caption" color="lime" bold style={styles.toastText}>
            {copiedToast}
          </DDText>
        </View>
      ) : null}

      {/* Header navigation bar */}
      <View style={[styles.navBar, { paddingTop: insets.top + DD_SPACING.xs }]}>
        <Pressable
          onPress={handleBack}
          android_ripple={{ color: 'rgba(255, 255, 255, 0.12)', borderless: true, radius: 24 }}
          style={styles.navIconButton}
          accessibilityRole="button"
          accessibilityLabel="Go back">
          <DDIcon name="arrow-left" size={20} color={DD_COLORS.text} weight="bold" />
        </Pressable>

        <View style={styles.navRight}>
          <Pressable
            onPress={handleShare}
            android_ripple={{ color: 'rgba(255, 255, 255, 0.12)', borderless: true, radius: 24 }}
            style={styles.navIconButton}
            accessibilityRole="button"
            accessibilityLabel="Share challenge">
            <DDIcon name="share" size={20} color={DD_COLORS.text} weight="bold" />
          </Pressable>

          {challenge.joined && (
            <DDBadge label="Joined" variant="success" size="sm" icon="check" />
          )}
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 110 },
        ]}
        showsVerticalScrollIndicator={false}>
        {/* A. Challenge Hero Section */}
        <View style={[styles.heroCard, { borderColor: catColor + '44' }]}>
          <View style={[styles.heroAccentBar, { backgroundColor: catColor }]} />

          <View style={styles.heroBody}>
            {/* Badges Row */}
            <View style={styles.heroBadgesRow}>
              <View style={[styles.categoryPill, { backgroundColor: catColor + '1E' }]}>
                <DDIcon name={catIcon} size={13} color={catColor} weight="fill" />
                <DDText variant="caption" style={[styles.categoryPillText, { color: catColor }]}>
                  {challenge.category}
                </DDText>
              </View>

              <View style={styles.typePill}>
                <DDIcon
                  name={isDaily ? 'flame' : 'target'}
                  size={12}
                  color={isDaily ? DD_COLORS.lime : DD_COLORS.purple}
                  weight="bold"
                />
                <DDText
                  variant="caption"
                  color={isDaily ? 'lime' : 'purple'}
                  style={styles.typePillText}>
                  {isDaily ? 'Daily Dare' : 'One-Time Dare'}
                </DDText>
              </View>
            </View>

            {/* Title */}
            <DDText variant="display" color="primary" style={styles.heroTitle}>
              {challenge.title}
            </DDText>

            {/* Creator Attribution */}
            <View style={styles.creatorRow}>
              <DDAvatar name={challenge.creator} size="sm" />
              <View style={styles.creatorMeta}>
                <DDText variant="caption" color="muted">
                  Created by
                </DDText>
                <DDText variant="label" color="primary" bold>
                  {challenge.creator}
                </DDText>
              </View>
            </View>
          </View>
        </View>

        {/* B. Stats Grid */}
        <View style={styles.statsGrid}>
          <DDCard variant="card" padding="sm" style={styles.statBox}>
            <View style={[styles.statIconBadge, { backgroundColor: 'rgba(155, 89, 255, 0.12)' }]}>
              <DDIcon name="users" size={16} color={DD_COLORS.purple} weight="bold" />
            </View>
            <DDText variant="h2" color="primary" style={styles.statValue}>
              {formatParticipants(challenge.participants)}
            </DDText>
            <DDText variant="caption" color="secondary" style={styles.statLabel}>
              Challengers
            </DDText>
          </DDCard>

          <DDCard variant="card" padding="sm" style={styles.statBox}>
            <View style={[styles.statIconBadge, { backgroundColor: 'rgba(255, 60, 172, 0.12)' }]}>
              <DDIcon name="clock" size={16} color={DD_COLORS.catFun} weight="bold" />
            </View>
            <DDText variant="h2" color="primary" style={styles.statValue}>
              {timeLeft}
            </DDText>
            <DDText variant="caption" color="secondary" style={styles.statLabel}>
              Remaining
            </DDText>
          </DDCard>

          <DDCard variant="card" padding="sm" style={styles.statBox}>
            <View style={[styles.statIconBadge, { backgroundColor: 'rgba(191, 253, 64, 0.12)' }]}>
              <DDIcon name="calendar" size={16} color={DD_COLORS.lime} weight="bold" />
            </View>
            <DDText variant="h2" color="primary" style={styles.statValue}>
              {challenge.durationDays}d
            </DDText>
            <DDText variant="caption" color="secondary" style={styles.statLabel}>
              Duration
            </DDText>
          </DDCard>
        </View>

        {/* C. Verified Progress Section */}
        <DDCard variant="card" padding="md" style={styles.sectionCard}>
          <View style={styles.progressHeader}>
            <View style={styles.progressHeaderLeft}>
              <DDText variant="h3" color="primary">
                {challenge.joined ? 'Verified Progress' : 'Challenge Timeline'}
              </DDText>
              {displayStreak > 0 && (
                <View style={styles.streakBadge}>
                  <DDIcon name="flame" size={14} color={DD_COLORS.lime} weight="fill" />
                  <DDText variant="caption" color="lime" bold style={styles.streakText}>
                    {displayStreak} Day Streak
                  </DDText>
                </View>
              )}
            </View>
            <DDText variant="h2" style={[styles.progressPctText, { color: catColor }]}>
              {displayProgressPct}%
            </DDText>
          </View>

          {/* Progress Track */}
          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                { width: `${Math.min(100, Math.max(0, displayProgressPct))}%` as any, backgroundColor: catColor },
              ]}
            />
          </View>

          <View style={styles.progressSubrow}>
            <DDText variant="bodySm" color="secondary">
              {challenge.joined && participantProgress
                ? isDaily
                  ? `${displayVerifiedCount} of ${challenge.durationDays} days verified`
                  : `${displayVerifiedCount > 0 ? '1 of 1' : '0 of 1'} dare verified`
                : `${daysElapsed} of ${challenge.durationDays} days elapsed`}
            </DDText>
            {isCompletedVerified && (
              <View style={styles.completedBadge}>
                <DDIcon name="trophy" size={13} color={DD_COLORS.lime} weight="fill" />
                <DDText variant="caption" color="lime" bold>
                  Completed!
                </DDText>
              </View>
            )}
          </View>

          {challenge.joined && (
            <View style={styles.disclaimerRow}>
              <DDIcon name="info" size={13} color={DD_COLORS.textMuted} weight="bold" />
              <DDText variant="caption" color="muted" style={styles.disclaimerText}>
                Only verifier-approved submissions count toward your verified progress and streak.
              </DDText>
            </View>
          )}
        </DDCard>

        {/* D. Peer Verification & Submit Section (for active participants) */}
        {challenge.joined && (
          <DDCard variant="highlight" padding="md" style={styles.submissionSectionCard}>
            <View style={styles.cardHeaderRow}>
              <View style={styles.verificationBadgesRow}>
                <DDBadge label="Peer Verification" variant="purple" size="sm" icon="verify" />
                <DDBadge label="WhatsApp Proof" variant="lime" size="sm" icon="share" />
              </View>
              <DDText variant="h3" color="primary" style={styles.cardMainTitle}>
                Submit Dare Proof
              </DDText>
            </View>

            <DDText variant="bodySm" color="secondary" style={styles.cardDescription}>
              Submissions require peer verification. Submit completion below, then send your proof photo or video to your assigned verifier via WhatsApp.
            </DDText>

            {/* Daily Challenge Today Status Callouts */}
            {isDaily && isTodayApproved && (
              <View style={[styles.statusCallout, styles.statusCalloutApproved]}>
                <DDIcon name="check-circle" size={20} color={DD_COLORS.success} weight="fill" />
                <View style={styles.calloutTexts}>
                  <DDText variant="label" color="success" bold>
                    Today is Verified!
                  </DDText>
                  <DDText variant="caption" color="secondary">
                    Your completion for today ({todayDate}) has been approved by your verifier.
                  </DDText>
                </View>
              </View>
            )}

            {isDaily && isTodayPending && (
              <View style={[styles.statusCallout, styles.statusCalloutPending]}>
                <DDIcon name="clock" size={20} color={DD_COLORS.warning} weight="bold" />
                <View style={styles.calloutTexts}>
                  <DDText variant="label" color="warning" bold>
                    Today is Pending Verification
                  </DDText>
                  <DDText variant="caption" color="secondary">
                    Submitted for {todayDate}. Waiting for verifier approval.
                  </DDText>
                  {todayCompletion && (
                    <DDButton
                      title="Send WhatsApp Proof"
                      variant="secondary"
                      size="sm"
                      iconLeft="share"
                      onPress={() => handleSendWhatsAppProof(todayCompletion)}
                      style={styles.calloutActionBtn}
                    />
                  )}
                </View>
              </View>
            )}

            {isDaily && isTodayRejected && (
              <View style={[styles.statusCallout, styles.statusCalloutRejected]}>
                <DDIcon name="warning" size={20} color={DD_COLORS.danger} weight="bold" />
                <View style={styles.calloutTexts}>
                  <DDText variant="label" color="danger" bold>
                    Submission Needs Resubmission
                  </DDText>
                  <DDText variant="caption" color="secondary">
                    Reason: {todayCompletion?.rejection_reason || 'Proof was not approved.'}
                  </DDText>
                </View>
              </View>
            )}

            {/* One-Time Dare Status Callouts */}
            {!isDaily && isOneTimeApproved && (
              <View style={[styles.statusCallout, styles.statusCalloutApproved]}>
                <DDIcon name="trophy" size={20} color={DD_COLORS.lime} weight="fill" />
                <View style={styles.calloutTexts}>
                  <DDText variant="label" color="lime" bold>
                    Dare Completed & Verified!
                  </DDText>
                  <DDText variant="caption" color="secondary">
                    Your completion has been approved. You conquered this dare!
                  </DDText>
                </View>
              </View>
            )}

            {!isDaily && isOneTimePending && (
              <View style={[styles.statusCallout, styles.statusCalloutPending]}>
                <DDIcon name="clock" size={20} color={DD_COLORS.warning} weight="bold" />
                <View style={styles.calloutTexts}>
                  <DDText variant="label" color="warning" bold>
                    Dare Submission Pending Review
                  </DDText>
                  <DDText variant="caption" color="secondary">
                    Your completion is currently awaiting review by your verifier.
                  </DDText>
                  {latestCompletion && (
                    <DDButton
                      title="Send WhatsApp Proof"
                      variant="secondary"
                      size="sm"
                      iconLeft="share"
                      onPress={() => handleSendWhatsAppProof(latestCompletion)}
                      style={styles.calloutActionBtn}
                    />
                  )}
                </View>
              </View>
            )}

            {/* Main Submit Action Buttons */}
            {!isOneTimeApproved && !isOneTimePending && (
              <View style={styles.submitActionBox}>
                <DDButton
                  title={
                    isTodayApproved
                      ? 'Submit Another Day'
                      : isTodayRejected
                        ? 'Resubmit Today’s Completion'
                        : 'Submit Completion'
                  }
                  variant="primary"
                  iconLeft="plus"
                  onPress={() => openSubmitModal()}
                  fullWidth
                />

                {isDaily && !yesterdayCompletion && isTodayApproved && (
                  <DDButton
                    title={`Submit for Yesterday (${yesterdayDate})`}
                    variant="outline"
                    size="sm"
                    iconLeft="clock"
                    onPress={() => openSubmitModal(yesterdayDate)}
                    style={styles.yesterdaySubmitBtn}
                  />
                )}
              </View>
            )}
          </DDCard>
        )}

        {/* E. Submissions Awaiting Your Review (for assigned verifiers) */}
        {reviewableSubmissions.length > 0 && (
          <DDCard variant="card" padding="md" style={styles.sectionCard}>
            <View style={styles.reviewSectionHeader}>
              <View style={styles.reviewTitleGroup}>
                <DDIcon name="verify" size={20} color={DD_COLORS.coral} weight="fill" />
                <DDText variant="h3" color="primary">
                  Awaiting Your Review
                </DDText>
                <DDBadge
                  label={`${reviewableSubmissions.length} Pending`}
                  variant="coral"
                  size="sm"
                />
              </View>
            </View>

            <DDText variant="bodySm" color="secondary" style={styles.reviewSubtext}>
              You were selected as verifier for these completions. Confirm that the challenger sent you proof before approving.
            </DDText>

            <View style={styles.reviewList}>
              {reviewableSubmissions.map((item) => {
                const submitterName = participantDisplayName(item.participant_id, challenge);
                return (
                  <View key={item.id} style={styles.reviewItemCard}>
                    <View style={styles.reviewItemTop}>
                      <DDAvatar name={submitterName} size="sm" />
                      <View style={styles.reviewItemMeta}>
                        <DDText variant="label" color="primary" bold numberOfLines={1}>
                          {submitterName}
                        </DDText>
                        <DDText variant="caption" color="muted">
                          {item.completion_date} • {formatSubmittedAt(item.submitted_at)}
                        </DDText>
                      </View>
                      <DDBadge label="Pending" variant="warning" size="sm" icon="clock" />
                    </View>

                    {item.submission_note ? (
                      <View style={styles.reviewNoteBox}>
                        <DDText variant="caption" color="secondary" style={styles.reviewNoteText}>
                          &quot;{item.submission_note}&quot;
                        </DDText>
                      </View>
                    ) : null}

                    {/* Review Actions Row */}
                    <View style={styles.reviewButtonsRow}>
                      <DDButton
                        title="Approve"
                        variant="primary"
                        size="sm"
                        iconLeft="check"
                        loading={isReviewing}
                        onPress={() => handleQuickApprove(item)}
                        style={styles.reviewBtnFlex}
                      />

                      <DDButton
                        title="Reject"
                        variant="destructive"
                        size="sm"
                        iconLeft="x"
                        disabled={isReviewing}
                        onPress={() => openInlineRejectModal(item)}
                        style={styles.reviewBtnFlex}
                      />

                      <DDButton
                        title="Details"
                        variant="ghost"
                        size="sm"
                        iconRight="arrow-right"
                        onPress={() =>
                          router.push({
                            pathname: '/review/[id]',
                            params: { id: item.id },
                          })
                        }
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          </DDCard>
        )}

        {/* F. Submissions & History (User's own records) */}
        {challenge.joined && userSubmissions.length > 0 && (
          <DDCard variant="card" padding="md" style={styles.sectionCard}>
            <View style={styles.historyHeader}>
              <DDText variant="h3" color="primary">
                Your Submission History
              </DDText>
              <DDBadge label={`${userSubmissions.length} logged`} variant="neutral" size="sm" />
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
                        <DDText variant="label" color="primary" bold>
                          {item.completion_date === todayDate
                            ? `Today (${item.completion_date})`
                            : item.completion_date === yesterdayDate
                              ? `Yesterday (${item.completion_date})`
                              : item.completion_date}
                        </DDText>
                        <DDText variant="caption" color="muted">
                          Verifier: {verifierName}
                        </DDText>
                      </View>

                      {/* Status Badges */}
                      {item.status === 'approved' && (
                        <DDBadge label="Approved" variant="success" size="sm" icon="check-circle" />
                      )}
                      {item.status === 'pending' && (
                        <DDBadge label="Pending" variant="warning" size="sm" icon="clock" />
                      )}
                      {item.status === 'rejected' && (
                        <DDBadge label="Rejected" variant="danger" size="sm" icon="x-circle" />
                      )}
                    </View>

                    {item.submission_note ? (
                      <DDText variant="caption" color="secondary" style={styles.historyNote}>
                        Note: &quot;{item.submission_note}&quot;
                      </DDText>
                    ) : null}

                    {item.rejection_reason && item.status === 'rejected' ? (
                      <DDText variant="caption" color="danger" style={styles.rejectionReasonText}>
                        Feedback: {item.rejection_reason}
                      </DDText>
                    ) : null}

                    {/* Actions on history items */}
                    <View style={styles.historyActionsRow}>
                      {item.status === 'pending' && (
                        <>
                          <DDButton
                            title="WhatsApp Proof"
                            variant="secondary"
                            size="sm"
                            iconLeft="share"
                            onPress={() => handleSendWhatsAppProof(item)}
                          />
                          <DDButton
                            title="Reassign Verifier"
                            variant="outline"
                            size="sm"
                            iconLeft="refresh"
                            onPress={() => openReassignModal(item)}
                          />
                        </>
                      )}

                      {item.status === 'rejected' && (
                        <DDButton
                          title="Resubmit for this date"
                          variant="primary"
                          size="sm"
                          iconLeft="refresh"
                          onPress={() => openSubmitModal(item.completion_date)}
                        />
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          </DDCard>
        )}

        {/* G. Invite Challengers Section */}
        <DDCard variant="card" padding="md" style={styles.sectionCard}>
          <View style={styles.inviteHeader}>
            <View style={styles.inviteHeaderLeft}>
              <View style={styles.inviteTitleRow}>
                <DDIcon name="friends" size={18} color={DD_COLORS.lime} weight="fill" />
                <DDText variant="h3" color="primary">
                  Invite Challengers
                </DDText>
              </View>
              <DDText variant="bodySm" color="secondary">
                Dares are 3x more likely to be completed with friends.
              </DDText>
            </View>
          </View>

          <View style={styles.inviteButtonsRow}>
            <DDButton
              title="Copy Link"
              variant="secondary"
              size="sm"
              iconLeft="copy"
              onPress={handleCopy}
              style={styles.inviteBtnFlex}
            />

            <DDButton
              title="Share Dare"
              variant="secondary"
              size="sm"
              iconLeft="share"
              onPress={handleShare}
              style={styles.inviteBtnFlex}
            />

            <DDButton
              title="Invite Friends"
              variant="violet"
              size="sm"
              iconLeft="user-plus"
              onPress={openInviteFriendsModal}
              style={styles.inviteBtnFlex}
            />
          </View>

          {/* Toggle URL Details */}
          <Pressable
            onPress={() => setShowLinkInfo(!showLinkInfo)}
            style={styles.linkInfoToggle}
            accessibilityRole="button">
            <DDText variant="caption" color="lime" bold>
              {showLinkInfo ? 'Hide deep link details ▲' : 'Show deep link details ▼'}
            </DDText>
          </Pressable>

          {showLinkInfo && (
            <View style={styles.linkDetailsBox}>
              <View style={styles.urlItem}>
                <DDText variant="caption" color="muted">
                  Primary Invite URL:
                </DDText>
                <DDText variant="caption" color="primary" numberOfLines={2} selectable>
                  {inviteUrls.primaryUrl}
                </DDText>
              </View>
              <View style={styles.urlItem}>
                <DDText variant="caption" color="muted">
                  Native Deep Link:
                </DDText>
                <DDText variant="caption" color="primary" numberOfLines={2} selectable>
                  {inviteUrls.deepLink}
                </DDText>
              </View>
            </View>
          )}
        </DDCard>

        {/* H. Description Section */}
        <DDCard variant="card" padding="md" style={styles.sectionCard}>
          <DDText variant="h3" color="primary" style={styles.sectionHeading}>
            About this challenge
          </DDText>
          <DDText variant="body" color="secondary" style={styles.descriptionText}>
            {challenge.description}
          </DDText>
        </DDCard>

        {/* I. Rules / How It Works */}
        <DDCard variant="card" padding="md" style={styles.sectionCard}>
          <DDText variant="h3" color="primary" style={styles.sectionHeading}>
            How it works
          </DDText>
          <View style={styles.rulesList}>
            {[
              'Commit to the duration before joining',
              'Submit completion daily and assign a peer verifier',
              'Share your photo or video proof directly with your verifier via WhatsApp',
              'Only verifier-approved submissions count toward your streak and badge',
            ].map((rule, i) => (
              <View key={i} style={styles.ruleItem}>
                <View style={[styles.ruleNumberCircle, { backgroundColor: catColor + '22' }]}>
                  <DDText variant="caption" bold style={{ color: catColor }}>
                    {i + 1}
                  </DDText>
                </View>
                <DDText variant="bodySm" color="secondary" style={styles.ruleText}>
                  {rule}
                </DDText>
              </View>
            ))}
          </View>
        </DDCard>
      </ScrollView>

      {/* Sticky Bottom CTA Bar */}
      <View style={[styles.ctaContainer, { paddingBottom: insets.bottom + DD_SPACING.sm }]}>
        {challenge.joined ? (
          <View style={styles.joinedCtaRow}>
            <DDButton
              title="Submit Completion"
              variant="primary"
              iconLeft="plus"
              onPress={() => openSubmitModal()}
              style={styles.bottomMainBtn}
            />

            <DDButton
              title="Leave"
              variant="ghost"
              loading={isJoining}
              disabled={isJoining}
              onPress={handleJoinToggle}
              style={styles.leaveDareBtn}
            />
          </View>
        ) : (
          <DDButton
            title="Join Challenge"
            variant="primary"
            iconLeft="plus"
            loading={isJoining}
            disabled={isJoining}
            onPress={handleJoinToggle}
            fullWidth
            style={{ backgroundColor: catColor }}
          />
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
              <View style={styles.modalHeaderTexts}>
                <DDText variant="h3" color="primary">
                  Submit Completion
                </DDText>
                <DDText variant="caption" color="muted" numberOfLines={1}>
                  {challenge.title}
                </DDText>
              </View>
              <Pressable
                onPress={() => setSubmitModalVisible(false)}
                hitSlop={8}
                style={styles.modalCloseBtn}
                accessibilityRole="button"
                accessibilityLabel="Close modal">
                <DDIcon name="x" size={18} color={DD_COLORS.textMuted} weight="bold" />
              </Pressable>
            </View>

            {submitSuccess ? (
              /* Success State */
              <View style={styles.successStateBox}>
                <View style={styles.successIconCircle}>
                  <DDIcon name="check-circle" size={44} color={DD_COLORS.lime} weight="fill" />
                </View>
                <DDText variant="h2" color="primary" align="center">
                  Completion Submitted!
                </DDText>
                <DDText variant="bodySm" color="secondary" align="center" style={styles.successMsg}>
                  Your submission for {submitSuccess.completion_date} is now pending peer review.
                </DDText>

                <View style={styles.successProofBox}>
                  <DDIcon name="info" size={16} color={DD_COLORS.info} weight="bold" />
                  <DDText variant="caption" color="secondary" style={styles.successProofNotice}>
                    Proof photos and videos are not uploaded to our servers. Send your proof directly to your assigned verifier via WhatsApp!
                  </DDText>
                </View>

                <DDButton
                  title="Share Proof on WhatsApp"
                  variant="primary"
                  iconLeft="share"
                  onPress={() => handleSendWhatsAppProof(submitSuccess)}
                  fullWidth
                  style={styles.modalSuccessBtn}
                />

                <DDButton
                  title="Done"
                  variant="secondary"
                  onPress={() => setSubmitModalVisible(false)}
                  fullWidth
                />
              </View>
            ) : (
              /* Form State */
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.formScroll}>
                {/* Date Selection (Daily challenge) */}
                {isDaily ? (
                  <View style={styles.formGroup}>
                    <DDText variant="label" color="primary" bold style={styles.formLabel}>
                      Completion Date
                    </DDText>
                    <View style={styles.dateSelectorRow}>
                      <Pressable
                        onPress={() => setSelectedDate(todayDate)}
                        style={[
                          styles.dateOption,
                          selectedDate === todayDate && styles.dateOptionActive,
                        ]}>
                        <DDIcon
                          name="calendar"
                          size={14}
                          color={selectedDate === todayDate ? DD_COLORS.lime : DD_COLORS.textMuted}
                          weight="bold"
                        />
                        <DDText
                          variant="caption"
                          bold
                          color={selectedDate === todayDate ? 'lime' : 'secondary'}>
                          Today ({todayDate})
                        </DDText>
                      </Pressable>

                      <Pressable
                        onPress={() => setSelectedDate(yesterdayDate)}
                        style={[
                          styles.dateOption,
                          selectedDate === yesterdayDate && styles.dateOptionActive,
                        ]}>
                        <DDIcon
                          name="clock"
                          size={14}
                          color={selectedDate === yesterdayDate ? DD_COLORS.lime : DD_COLORS.textMuted}
                          weight="bold"
                        />
                        <DDText
                          variant="caption"
                          bold
                          color={selectedDate === yesterdayDate ? 'lime' : 'secondary'}>
                          Yesterday ({yesterdayDate})
                        </DDText>
                      </Pressable>
                    </View>
                    <DDText variant="caption" color="muted" style={styles.formHint}>
                      Submissions accepted for today and yesterday in timezone ({challenge.timezone || 'UTC'}).
                    </DDText>
                  </View>
                ) : (
                  <View style={styles.formGroup}>
                    <DDText variant="label" color="primary" bold style={styles.formLabel}>
                      Dare Date
                    </DDText>
                    <View style={styles.staticDateBox}>
                      <DDIcon name="calendar" size={14} color={DD_COLORS.lime} weight="bold" />
                      <DDText variant="caption" color="lime" bold>
                        Today: {todayDate}
                      </DDText>
                    </View>
                  </View>
                )}

                {/* Verifier Selection */}
                <View style={styles.formGroup}>
                  <DDText variant="label" color="primary" bold style={styles.formLabel}>
                    Assign Peer Verifier
                  </DDText>
                  {eligibleVerifiers.length === 0 ? (
                    <View style={styles.noVerifiersBox}>
                      <DDIcon name="warning" size={18} color={DD_COLORS.warning} weight="bold" />
                      <DDText variant="caption" color="secondary" style={styles.noVerifiersText}>
                        No eligible verifiers found. Peer verification requires at least one other participant or referee.
                      </DDText>
                      <DDButton
                        title="Invite a friend"
                        variant="secondary"
                        size="sm"
                        iconLeft="user-plus"
                        onPress={() => {
                          setSubmitModalVisible(false);
                          handleShare();
                        }}
                      />
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
                          <DDAvatar name={v.display_name} size="sm" />
                          <View style={styles.verifierOptionMeta}>
                            <DDText
                              variant="label"
                              bold
                              color={selectedVerifierId === v.user_id ? 'lime' : 'primary'}>
                              {v.display_name}
                            </DDText>
                            <DDText variant="caption" color="muted">
                              {v.is_creator ? 'Challenge Creator / Referee' : 'Fellow Participant'}
                            </DDText>
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
                  <DDText variant="label" color="primary" bold style={styles.formLabel}>
                    Submission Note (Optional)
                  </DDText>
                  <TextInput
                    style={styles.textInput}
                    placeholder="e.g. 50 pushups completed, felt great!"
                    placeholderTextColor={DD_COLORS.textMuted}
                    value={submissionNote}
                    onChangeText={setSubmissionNote}
                    multiline
                    numberOfLines={3}
                    maxLength={300}
                  />
                </View>

                {/* WhatsApp Info Notice */}
                <View style={styles.infoNoticeBox}>
                  <DDIcon name="info" size={16} color={DD_COLORS.info} weight="bold" />
                  <DDText variant="caption" color="secondary" style={styles.infoNoticeBody}>
                    1. Tap Submit below to log your dare completion.{"\n"}
                    2. Next, tap &lsquo;Share Proof on WhatsApp&rsquo; to send proof to your verifier.{"\n"}
                    3. Once verified, your streak will instantly update!
                  </DDText>
                </View>

                {/* Error Banner */}
                {submitError && (
                  <View style={styles.errorBox}>
                    <DDIcon name="warning" size={16} color={DD_COLORS.danger} weight="bold" />
                    <DDText variant="caption" color="danger" style={styles.errorText}>
                      {submitError}
                    </DDText>
                  </View>
                )}

                {/* Submit Action */}
                <DDButton
                  title="Submit for Peer Verification"
                  variant="primary"
                  loading={isSubmitting}
                  disabled={isSubmitting || !selectedVerifierId || eligibleVerifiers.length === 0}
                  onPress={handleSubmitCompletion}
                  fullWidth
                  style={styles.modalSubmitActionBtn}
                />
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
              <View style={styles.modalHeaderTexts}>
                <DDText variant="h3" color="primary">
                  Reassign Verifier
                </DDText>
                <DDText variant="caption" color="muted">
                  Choose a new peer to verify this submission
                </DDText>
              </View>
              <Pressable
                onPress={() => setReassignModalVisible(false)}
                hitSlop={8}
                style={styles.modalCloseBtn}>
                <DDIcon name="x" size={18} color={DD_COLORS.textMuted} weight="bold" />
              </Pressable>
            </View>

            <View style={styles.modalListContainer}>
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
                    <DDAvatar name={v.display_name} size="sm" />
                    <View style={styles.verifierOptionMeta}>
                      <DDText
                        variant="label"
                        bold
                        color={newVerifierId === v.user_id ? 'lime' : 'primary'}>
                        {v.display_name}
                      </DDText>
                      <DDText variant="caption" color="muted">
                        {v.is_creator ? 'Referee / Creator' : 'Participant'}
                      </DDText>
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
                <DDText variant="bodySm" color="muted" align="center" style={styles.noVerifiersText}>
                  No other eligible verifiers available. Invite more participants to reassign.
                </DDText>
              )}
            </View>

            {reassignError && (
              <View style={styles.errorBox}>
                <DDIcon name="warning" size={16} color={DD_COLORS.danger} weight="bold" />
                <DDText variant="caption" color="danger" style={styles.errorText}>
                  {reassignError}
                </DDText>
              </View>
            )}

            <DDButton
              title="Confirm Reassignment"
              variant="primary"
              loading={isReassigning}
              disabled={isReassigning || !newVerifierId}
              onPress={handleReassignSubmit}
              fullWidth
            />
          </View>
        </View>
      </Modal>

      {/* INLINE REJECT MODAL */}
      <Modal
        visible={inlineRejectModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => !isReviewing && setInlineRejectModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeaderRow}>
              <View style={styles.modalHeaderTexts}>
                <DDText variant="h3" color="primary">
                  Reject Submission
                </DDText>
                <DDText variant="caption" color="muted">
                  Provide feedback so the challenger can resubmit valid proof.
                </DDText>
              </View>
              <Pressable
                onPress={() => setInlineRejectModalVisible(false)}
                disabled={isReviewing}
                hitSlop={8}
                style={styles.modalCloseBtn}>
                <DDIcon name="x" size={18} color={DD_COLORS.textMuted} weight="bold" />
              </Pressable>
            </View>

            <View style={styles.modalInputBox}>
              <TextInput
                style={styles.textInput}
                placeholder="e.g. Proof photo was missing or incomplete"
                placeholderTextColor={DD_COLORS.textMuted}
                value={inlineRejectionReason}
                onChangeText={setInlineRejectionReason}
                maxLength={MAX_REJECTION_REASON_LENGTH}
                multiline
                numberOfLines={3}
                editable={!isReviewing}
              />
            </View>

            <DDButton
              title="Confirm Reject"
              variant="destructive"
              loading={isReviewing}
              disabled={isReviewing}
              onPress={handleConfirmInlineReject}
              fullWidth
            />
          </View>
        </View>
      </Modal>

      {/* INVITE FRIENDS MODAL */}
      <Modal
        visible={inviteModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setInviteModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '82%' }]}>
            <View style={styles.modalHeaderRow}>
              <View style={styles.modalHeaderTexts}>
                <DDText variant="h3" color="primary">
                  Invite Friends
                </DDText>
                <DDText variant="caption" color="muted" numberOfLines={1}>
                  Challenge your friends to &ldquo;{challenge.title}&rdquo;
                </DDText>
              </View>
              <Pressable
                onPress={() => setInviteModalVisible(false)}
                hitSlop={8}
                style={styles.modalCloseBtn}>
                <DDIcon name="x" size={18} color={DD_COLORS.textMuted} weight="bold" />
              </Pressable>
            </View>

            {inviteFriendError && (
              <View style={styles.errorBox}>
                <DDIcon name="warning" size={16} color={DD_COLORS.danger} weight="bold" />
                <DDText variant="caption" color="danger" style={styles.errorText}>
                  {inviteFriendError}
                </DDText>
              </View>
            )}

            {loadingFriends ? (
              <View style={styles.friendsLoadingBox}>
                <ActivityIndicator color={DD_COLORS.lime} size="large" />
                <DDText variant="caption" color="secondary" style={{ marginTop: DD_SPACING.sm }}>
                  Loading friends…
                </DDText>
              </View>
            ) : myFriends.length === 0 ? (
              <View style={styles.friendsEmptyBox}>
                <View style={styles.friendsEmptyIconCircle}>
                  <DDIcon name="friends" size={32} color={DD_COLORS.textMuted} weight="bold" />
                </View>
                <DDText variant="h3" color="primary" align="center">
                  No friends added yet
                </DDText>
                <DDText variant="bodySm" color="secondary" align="center" style={styles.friendsEmptyDesc}>
                  Connect with friends using Friend Codes to invite them directly to dares!
                </DDText>
                <DDButton
                  title="Go to Friends & Social"
                  variant="primary"
                  iconRight="arrow-right"
                  onPress={() => {
                    setInviteModalVisible(false);
                    router.push('/friends');
                  }}
                />
              </View>
            ) : (
              <ScrollView style={styles.friendsListScroll} showsVerticalScrollIndicator={false}>
                {myFriends.map((f) => {
                  const isInvited = invitedFriendIds.has(f.friend_user_id);
                  const isAlreadyParticipant = eligibleVerifiers.some((v) => v.user_id === f.friend_user_id);
                  const isInviting = invitingFriendId === f.friend_user_id;

                  return (
                    <View key={f.friendship_id} style={styles.friendRow}>
                      <View style={styles.friendRowLeft}>
                        <DDAvatar name={f.display_name} size="sm" />
                        <View style={styles.friendMeta}>
                          <DDText variant="label" color="primary" bold numberOfLines={1}>
                            {f.display_name}
                          </DDText>
                          <DDText variant="caption" color="muted">
                            {f.friend_code}
                          </DDText>
                        </View>
                      </View>

                      {isInvited ? (
                        <DDBadge label="Invited" variant="lime" size="sm" icon="check" />
                      ) : isAlreadyParticipant ? (
                        <DDBadge label="Joined" variant="neutral" size="sm" icon="check" />
                      ) : (
                        <DDButton
                          title="Invite"
                          variant="violet"
                          size="sm"
                          iconLeft="plus"
                          loading={isInviting}
                          disabled={isInviting}
                          onPress={() => handleInviteFriend(f)}
                        />
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

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: DD_COLORS.bg,
  },
  centerContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    gap: DD_SPACING.sm,
  },
  loadingText: {
    marginTop: DD_SPACING.xs,
  },
  notFound: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: DD_SPACING.xl,
    gap: DD_SPACING.md,
  },
  notFoundIconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: DD_COLORS.bgElement,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notFoundSubtext: {
    maxWidth: 280,
    lineHeight: 18,
  },
  backBtn: {
    marginTop: DD_SPACING.sm,
  },
  toastContainer: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 999,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: DD_COLORS.bgCard,
    borderWidth: 1.5,
    borderColor: DD_COLORS.lime,
    paddingVertical: DD_SPACING.xs,
    paddingHorizontal: DD_SPACING.md,
    borderRadius: DD_RADII.pill,
    ...DD_COLORS.limeGlow ? { elevation: 6 } : {},
  },
  toastText: {
    letterSpacing: 0.2,
  },
  navBar: {
    paddingHorizontal: DD_SPACING.lg,
    paddingBottom: DD_SPACING.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: DD_COLORS.bg,
    borderBottomWidth: 1,
    borderBottomColor: DD_COLORS.borderSubtle,
    zIndex: 10,
  },
  navRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
  },
  navIconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: DD_COLORS.bgElement,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingTop: DD_SPACING.md,
    paddingHorizontal: DD_SPACING.lg,
  },

  /* Hero Section */
  heroCard: {
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.card,
    borderWidth: 1,
    overflow: 'hidden',
    marginBottom: DD_SPACING.lg,
  },
  heroAccentBar: {
    height: 4,
    width: '100%',
  },
  heroBody: {
    padding: DD_SPACING.lg,
    gap: DD_SPACING.sm,
  },
  heroBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    flexWrap: 'wrap',
  },
  categoryPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    borderRadius: DD_RADII.pill,
  },
  categoryPillText: {
    fontSize: 11,
    fontWeight: '700',
  },
  typePill: {
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
  typePillText: {
    fontSize: 11,
    fontWeight: '700',
  },
  heroTitle: {
    marginTop: 2,
    lineHeight: 34,
  },
  creatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    marginTop: DD_SPACING.xs,
    paddingTop: DD_SPACING.xs,
  },
  creatorMeta: {
    justifyContent: 'center',
  },

  /* Stats Grid */
  statsGrid: {
    flexDirection: 'row',
    gap: DD_SPACING.sm,
    marginBottom: DD_SPACING.lg,
  },
  statBox: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: DD_SPACING.md,
    paddingHorizontal: DD_SPACING.xs,
  },
  statIconBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  statValue: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '900',
  },
  statLabel: {
    fontSize: 11,
    marginTop: 2,
  },

  /* Section Cards */
  sectionCard: {
    marginBottom: DD_SPACING.lg,
  },
  sectionHeading: {
    marginBottom: DD_SPACING.sm,
  },

  /* Progress Section */
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: DD_SPACING.sm,
  },
  progressHeaderLeft: {
    flex: 1,
    gap: 4,
  },
  streakBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(191, 253, 64, 0.12)',
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 2,
    borderRadius: DD_RADII.pill,
  },
  streakText: {
    fontSize: 10,
    letterSpacing: 0.5,
  },
  progressPctText: {
    fontSize: 22,
    lineHeight: 26,
    fontWeight: '900',
  },
  progressTrack: {
    height: 8,
    backgroundColor: DD_COLORS.bgElement,
    borderRadius: 4,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    marginBottom: DD_SPACING.sm,
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
  },
  progressSubrow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  completedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(191, 253, 64, 0.15)',
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 2,
    borderRadius: DD_RADII.pill,
  },
  disclaimerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: DD_SPACING.sm,
    paddingTop: DD_SPACING.xs,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.04)',
  },
  disclaimerText: {
    flex: 1,
    lineHeight: 14,
  },

  /* Peer Verification & Submission */
  submissionSectionCard: {
    marginBottom: DD_SPACING.lg,
    borderWidth: 1.5,
    borderColor: 'rgba(191, 253, 64, 0.35)',
  },
  cardHeaderRow: {
    marginBottom: DD_SPACING.sm,
  },
  verificationBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    marginBottom: DD_SPACING.xs,
  },
  cardMainTitle: {
    marginTop: 2,
  },
  cardDescription: {
    lineHeight: 18,
    marginBottom: DD_SPACING.md,
  },
  statusCallout: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: DD_SPACING.md,
    borderRadius: DD_RADII.md,
    gap: DD_SPACING.sm,
    marginBottom: DD_SPACING.md,
  },
  statusCalloutApproved: {
    backgroundColor: 'rgba(0, 230, 118, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(0, 230, 118, 0.25)',
  },
  statusCalloutPending: {
    backgroundColor: 'rgba(255, 184, 0, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 184, 0, 0.25)',
  },
  statusCalloutRejected: {
    backgroundColor: 'rgba(255, 59, 86, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 59, 86, 0.25)',
  },
  calloutTexts: {
    flex: 1,
    gap: 4,
  },
  calloutActionBtn: {
    marginTop: DD_SPACING.xs,
    alignSelf: 'flex-start',
  },
  submitActionBox: {
    gap: DD_SPACING.sm,
  },
  yesterdaySubmitBtn: {
    alignSelf: 'center',
  },

  /* Reviewable Submissions Section */
  reviewSectionHeader: {
    marginBottom: DD_SPACING.xs,
  },
  reviewTitleGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
  },
  reviewSubtext: {
    lineHeight: 18,
    marginBottom: DD_SPACING.md,
  },
  reviewList: {
    gap: DD_SPACING.md,
  },
  reviewItemCard: {
    backgroundColor: DD_COLORS.bgElement,
    padding: DD_SPACING.md,
    borderRadius: DD_RADII.md,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    gap: DD_SPACING.sm,
  },
  reviewItemTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
  },
  reviewItemMeta: {
    flex: 1,
  },
  reviewNoteBox: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    paddingHorizontal: DD_SPACING.md,
    paddingVertical: DD_SPACING.xs,
    borderRadius: DD_RADII.xs,
    borderLeftWidth: 2,
    borderLeftColor: DD_COLORS.coral,
  },
  reviewNoteText: {
    fontStyle: 'italic',
  },
  reviewButtonsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    marginTop: DD_SPACING.xs,
  },
  reviewBtnFlex: {
    flex: 1,
  },

  /* History Section */
  historyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: DD_SPACING.md,
  },
  historyList: {
    gap: DD_SPACING.sm,
  },
  historyItem: {
    backgroundColor: DD_COLORS.bgElement,
    padding: DD_SPACING.md,
    borderRadius: DD_RADII.md,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    gap: DD_SPACING.xs,
  },
  historyItemTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  historyNote: {
    fontStyle: 'italic',
    marginTop: 2,
  },
  rejectionReasonText: {
    marginTop: 2,
  },
  historyActionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: DD_SPACING.sm,
    marginTop: DD_SPACING.xs,
  },

  /* Invite Section */
  inviteHeader: {
    marginBottom: DD_SPACING.md,
  },
  inviteHeaderLeft: {
    gap: 4,
  },
  inviteTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  inviteButtonsRow: {
    flexDirection: 'row',
    gap: DD_SPACING.sm,
    marginBottom: DD_SPACING.sm,
  },
  inviteBtnFlex: {
    flex: 1,
  },
  linkInfoToggle: {
    paddingVertical: DD_SPACING.xs,
    alignSelf: 'flex-start',
  },
  linkDetailsBox: {
    backgroundColor: DD_COLORS.bgElement,
    padding: DD_SPACING.md,
    borderRadius: DD_RADII.md,
    gap: DD_SPACING.sm,
    marginTop: DD_SPACING.xs,
  },
  urlItem: {
    gap: 2,
  },

  /* Description & Rules */
  descriptionText: {
    lineHeight: 22,
  },
  rulesList: {
    gap: DD_SPACING.sm,
  },
  ruleItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: DD_SPACING.md,
  },
  ruleNumberCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  ruleText: {
    flex: 1,
    lineHeight: 19,
  },

  /* Bottom CTA Bar */
  ctaContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: DD_COLORS.bgCard,
    borderTopWidth: 1,
    borderTopColor: DD_COLORS.borderSubtle,
    paddingHorizontal: DD_SPACING.lg,
    paddingTop: DD_SPACING.sm,
    ...Platform.select({
      android: { elevation: 12 },
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: -4 },
        shadowOpacity: 0.35,
        shadowRadius: 10,
      },
      default: {},
    }),
  },
  joinedCtaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.md,
  },
  bottomMainBtn: {
    flex: 1,
  },
  leaveDareBtn: {
    paddingHorizontal: DD_SPACING.sm,
  },

  /* Modals */
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: DD_COLORS.bgCard,
    borderTopLeftRadius: DD_RADII.card,
    borderTopRightRadius: DD_RADII.card,
    borderWidth: 1,
    borderColor: DD_COLORS.borderProminent,
    padding: DD_SPACING.xl,
    maxHeight: '90%',
  },
  modalHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: DD_SPACING.md,
  },
  modalHeaderTexts: {
    flex: 1,
    paddingRight: DD_SPACING.sm,
    gap: 2,
  },
  modalCloseBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: DD_COLORS.bgElement,
    alignItems: 'center',
    justifyContent: 'center',
  },
  formScroll: {
    gap: DD_SPACING.md,
    paddingBottom: DD_SPACING.lg,
  },
  formGroup: {
    gap: DD_SPACING.xs,
  },
  formLabel: {
    marginBottom: 2,
  },
  dateSelectorRow: {
    flexDirection: 'row',
    gap: DD_SPACING.sm,
  },
  dateOption: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: DD_COLORS.bgElement,
    padding: DD_SPACING.md,
    borderRadius: DD_RADII.md,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    minHeight: 48,
  },
  dateOptionActive: {
    borderColor: DD_COLORS.lime,
    backgroundColor: 'rgba(191, 253, 64, 0.08)',
  },
  formHint: {
    marginTop: 2,
    lineHeight: 14,
  },
  staticDateBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: DD_COLORS.bgElement,
    padding: DD_SPACING.md,
    borderRadius: DD_RADII.md,
  },
  noVerifiersBox: {
    backgroundColor: DD_COLORS.bgElement,
    padding: DD_SPACING.md,
    borderRadius: DD_RADII.md,
    gap: DD_SPACING.sm,
    borderWidth: 1,
    borderColor: 'rgba(255, 184, 0, 0.25)',
  },
  noVerifiersText: {
    lineHeight: 18,
  },
  verifiersList: {
    gap: DD_SPACING.xs,
  },
  verifierOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    backgroundColor: DD_COLORS.bgElement,
    padding: DD_SPACING.md,
    borderRadius: DD_RADII.md,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    minHeight: 52,
  },
  verifierOptionActive: {
    borderColor: DD_COLORS.lime,
    backgroundColor: 'rgba(191, 253, 64, 0.06)',
  },
  verifierOptionMeta: {
    flex: 1,
  },
  radioCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: DD_COLORS.borderProminent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioCircleActive: {
    borderColor: DD_COLORS.lime,
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: DD_COLORS.lime,
  },
  textInput: {
    backgroundColor: DD_COLORS.bgElement,
    borderRadius: DD_RADII.md,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    padding: DD_SPACING.md,
    color: DD_COLORS.text,
    fontSize: 14,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  infoNoticeBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: DD_SPACING.sm,
    backgroundColor: 'rgba(0, 212, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.2)',
    padding: DD_SPACING.md,
    borderRadius: DD_RADII.md,
  },
  infoNoticeBody: {
    flex: 1,
    lineHeight: 18,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255, 59, 86, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255, 59, 86, 0.3)',
    padding: DD_SPACING.md,
    borderRadius: DD_RADII.md,
  },
  errorText: {
    flex: 1,
  },
  modalSubmitActionBtn: {
    marginTop: DD_SPACING.xs,
  },
  modalListContainer: {
    gap: DD_SPACING.xs,
    marginVertical: DD_SPACING.md,
  },
  modalInputBox: {
    marginVertical: DD_SPACING.md,
  },

  /* Success State in Modal */
  successStateBox: {
    alignItems: 'center',
    paddingVertical: DD_SPACING.lg,
    gap: DD_SPACING.sm,
  },
  successIconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(191, 253, 64, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: DD_SPACING.xs,
  },
  successMsg: {
    maxWidth: 280,
    lineHeight: 18,
  },
  successProofBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: DD_SPACING.sm,
    backgroundColor: 'rgba(0, 212, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.25)',
    padding: DD_SPACING.md,
    borderRadius: DD_RADII.md,
    marginVertical: DD_SPACING.sm,
  },
  successProofNotice: {
    flex: 1,
    lineHeight: 18,
  },
  modalSuccessBtn: {
    marginTop: DD_SPACING.xs,
  },

  /* Invite Friends Modal */
  friendsLoadingBox: {
    paddingVertical: DD_SPACING['3xl'],
    alignItems: 'center',
  },
  friendsEmptyBox: {
    paddingVertical: DD_SPACING.xl,
    alignItems: 'center',
    gap: DD_SPACING.sm,
  },
  friendsEmptyIconCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: DD_COLORS.bgHighlight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  friendsEmptyDesc: {
    maxWidth: 280,
    lineHeight: 18,
    marginBottom: DD_SPACING.sm,
  },
  friendsListScroll: {
    marginTop: DD_SPACING.xs,
  },
  friendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: DD_COLORS.bgElement,
    padding: DD_SPACING.md,
    borderRadius: DD_RADII.md,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    marginBottom: DD_SPACING.xs,
    minHeight: 56,
  },
  friendRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    flex: 1,
    paddingRight: DD_SPACING.sm,
  },
  friendMeta: {
    flex: 1,
  },
});
