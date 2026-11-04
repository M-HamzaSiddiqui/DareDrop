import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  formatReviewedAt,
  formatSubmittedAt,
  getResubmissionGraceStatus,
  isResubmission,
  MAX_REJECTION_REASON_LENGTH,
  participantDisplayName,
  splitCompletionsForUser,
} from '@/lib/reviews';
import { buildCompletionsChannelName, subscribeToCompletions } from '@/lib/realtime';
import {
  DbCompletion,
  DbProofChallenge,
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
import { useToast, sanitizeUserErrorMessage } from '@/components/ui/dd-toast';

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
    generateProofChallenge,
    cancelProofChallenge,
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
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const localChallenge = challenges.find((c) => c.id === id);
  const [loadingRemote, setLoadingRemote] = useState(!localChallenge && Boolean(id));
  const [remoteChallenge, setRemoteChallenge] = useState<Challenge | null>(null);
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
  const [textEntry, setTextEntry] = useState<string>('');
  const [numericValue, setNumericValue] = useState<string>('');
  const [activeProofChallenge, setActiveProofChallenge] = useState<DbProofChallenge | null>(null);
  const [isGeneratingProof, setIsGeneratingProof] = useState(false);
  const [proofError, setProofError] = useState<string | null>(null);
  const [dateChangeNotice, setDateChangeNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitSuccess, setSubmitSuccess] = useState<DbCompletion | null>(null);

  // Resubmission grace period ticker: updates countdown on focus, foreground, and 60s tick
  const [currentTimeMs, setCurrentTimeMs] = useState<number>(Date.now());

  useFocusEffect(
    useCallback(() => {
      setCurrentTimeMs(Date.now());
    }, []),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setCurrentTimeMs(Date.now());
      }
    });
    const interval = setInterval(() => {
      setCurrentTimeMs(Date.now());
    }, 60000);
    return () => {
      sub.remove();
      clearInterval(interval);
    };
  }, []);

  // Account isolation: reset transient proof state when user identity changes during render
  const [prevUserId, setPrevUserId] = useState(currentUserId);
  if (prevUserId !== currentUserId) {
    setPrevUserId(currentUserId);
    setActiveProofChallenge(null);
    setProofError(null);
    setDateChangeNotice(null);
    setSubmitError(null);
    setSubmitSuccess(null);
    setTextEntry('');
    setNumericValue('');
  }

  // Cancellation tracking to prevent duplicate RPC calls
  const cancelledProofIdsRef = useRef<Set<string>>(new Set());

  const cancelProofChallengeSafe = useCallback(
    (proof: DbProofChallenge | null | undefined) => {
      if (!proof || !proof.id) return;
      if (proof.participant_id !== currentUserId) return;
      if (cancelledProofIdsRef.current.has(proof.id)) return;

      cancelledProofIdsRef.current.add(proof.id);
      cancelProofChallenge(proof.id).catch(() => {});
    },
    [cancelProofChallenge, currentUserId],
  );

  // Keep refs for safe cleanup on unmount without unsafe state updates
  const activeProofChallengeRef = useRef<DbProofChallenge | null>(null);
  activeProofChallengeRef.current = activeProofChallenge;
  const submitSuccessRef = useRef<DbCompletion | null>(null);
  submitSuccessRef.current = submitSuccess;

  useEffect(() => {
    return () => {
      const active = activeProofChallengeRef.current;
      const success = submitSuccessRef.current;
      if (active && !success) {
        cancelProofChallengeSafe(active);
      }
    };
  }, [cancelProofChallengeSafe]);

  const closeSubmitModal = useCallback(() => {
    if (activeProofChallenge && !submitSuccess) {
      cancelProofChallengeSafe(activeProofChallenge);
    }
    setActiveProofChallenge(null);
    setSubmitModalVisible(false);
    setSubmitSuccess(null);
    setSubmitError(null);
    setProofError(null);
    setDateChangeNotice(null);
    setTextEntry('');
    setNumericValue('');
  }, [activeProofChallenge, submitSuccess, cancelProofChallengeSafe]);

  const handleSelectDate = useCallback(
    (newDate: string) => {
      if (newDate === selectedDate) return;
      if (activeProofChallenge) {
        cancelProofChallengeSafe(activeProofChallenge);
        setActiveProofChallenge(null);
        setDateChangeNotice('Date changed: proof code reset. Generate a new code to continue.');
      } else {
        setDateChangeNotice(null);
      }
      setSelectedDate(newDate);
      setProofError(null);
    },
    [selectedDate, activeProofChallenge, cancelProofChallengeSafe],
  );

  const handleSelectVerifier = useCallback(
    (newVerifierId: string) => {
      if (newVerifierId === selectedVerifierId) return;
      if (activeProofChallenge) {
        cancelProofChallengeSafe(activeProofChallenge);
        setActiveProofChallenge(null);
      }
      setSelectedVerifierId(newVerifierId);
      setProofError(null);
      setDateChangeNotice(null);
    },
    [selectedVerifierId, activeProofChallenge, cancelProofChallengeSafe],
  );

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
          <DDIcon name="lock" size={40} color={DD_COLORS.textMuted} weight="bold" />
        </View>
        <DDText variant="h2" color="primary">
          Dare Unavailable
        </DDText>
        <DDText variant="bodySm" color="secondary" align="center" style={styles.notFoundSubtext}>
          {"You don't have access to this dare. Ask the creator for an invite link."}
        </DDText>
        <DDButton
          title="Back to Home"
          variant="secondary"
          iconLeft="arrow-left"
          onPress={() => router.replace('/')}
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
      toast.success('Invite link copied to clipboard!');
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
      showAuthModal({
        title: 'Sign In to Invite Friends',
        description: 'Account required to invite friends to a Dare. Sign in or register to connect!',
      });
      return;
    }
    setInvitingFriendId(friend.friend_user_id);
    setInviteFriendError(null);
    try {
      await sendChallengeInvitation(challenge.id, friend.friend_user_id);
      setInvitedFriendIds((prev) => new Set([...prev, friend.friend_user_id]));
      toast.success(`Invitation sent to ${friend.display_name}!`);
    } catch (err: any) {
      setInviteFriendError(translateSocialError(err));
    } finally {
      setInvitingFriendId(null);
    }
  }

  async function handleJoinToggle() {
    if (!challenge || isJoining) return;
    if (isGuest) {
      showAuthModal({
        title: 'Sign In to Join Dare',
        description: 'Account required to join a Dare. Sign in or register to join challenges and track your streaks!',
        onSuccess: handleJoinToggle,
      });
      return;
    }
    setIsJoining(true);
    try {
      const res = await joinChallenge(challenge.id);
      if (res.success) {
        if (res.joined) {
          toast.success('Welcome to the challenge!');
          await refreshVerificationData();
        } else {
          toast.info('You left this challenge.');
          setCompletions([]);
          setEligibleVerifiers([]);
          setParticipantProgress(null);
        }
      } else {
        toast.error(sanitizeUserErrorMessage(res.error, 'Failed to update challenge membership.'));
      }
    } finally {
      setIsJoining(false);
    }
  }

  // Dynamically derive effective proof challenge, binding strictly to current user, selected verifier, and selected date
  const effectiveProofChallenge =
    activeProofChallenge &&
    activeProofChallenge.participant_id === currentUserId &&
    activeProofChallenge.verifier_id === selectedVerifierId &&
    activeProofChallenge.completion_date === selectedDate
      ? activeProofChallenge
      : null;

  const isProofExpired = Boolean(
    effectiveProofChallenge &&
    new Date(effectiveProofChallenge.expires_at).getTime() <= Date.now()
  );

  const proofMethod = challenge?.proofMethod || 'physical_action';
  const isProofCodeRequired = proofMethod === 'physical_action' || proofMethod === 'photo_code';

  async function handleGenerateProof() {
    if (!challenge || !selectedVerifierId || !selectedDate || isGeneratingProof) return;

    if (isGuest) {
      showAuthModal({
        title: 'Sign In to Generate Proof Challenge',
        description: 'A registered account is required to generate dynamic proof challenges.',
      });
      return;
    }

    if (activeProofChallenge) {
      cancelProofChallengeSafe(activeProofChallenge);
    }

    setIsGeneratingProof(true);
    setProofError(null);
    setDateChangeNotice(null);
    try {
      const res = await generateProofChallenge({
        challengeId: challenge.id,
        verifierId: selectedVerifierId,
        completionDate: selectedDate,
      });

      if (!res.success || !res.proofChallenge) {
        if (res.isFutureDate && res.serverDate && res.serverDate !== selectedDate) {
          setSelectedDate(res.serverDate);
          setProofError(
            `Clock mismatch: your device is ahead of the challenge timezone. Date adjusted to ${res.serverDate}. Tap "Get Proof Code" to proceed.`
          );
        } else {
          setProofError(res.error || 'Failed to generate proof challenge.');
        }
        return;
      }

      setActiveProofChallenge(res.proofChallenge);
      setProofError(null);
      setDateChangeNotice(null);
    } catch (err: any) {
      setProofError(err?.message || 'Failed to generate proof challenge.');
    } finally {
      setIsGeneratingProof(false);
    }
  }

  function openSubmitModal(prefillDate?: string) {
    if (isGuest) {
      showAuthModal({
        title: 'Sign In to Submit Proof',
        description: 'Account required to submit completion proof. Sign in to verify your progress!',
        onSuccess: () => setSubmitModalVisible(true),
      });
      return;
    }
    const targetDate = prefillDate || todayDate;
    setSelectedDate(targetDate);
    setSubmissionNote('');
    setTextEntry('');
    setNumericValue('');
    setSubmitError(null);
    setSubmitSuccess(null);
    setProofError(null);
    setDateChangeNotice(null);

    // If an existing proof challenge does not match target date or verifier, cancel and reset it
    if (activeProofChallenge) {
      if (
        activeProofChallenge.completion_date !== targetDate ||
        (selectedVerifierId && activeProofChallenge.verifier_id !== selectedVerifierId)
      ) {
        cancelProofChallengeSafe(activeProofChallenge);
        setActiveProofChallenge(null);
      }
    }

    if (eligibleVerifiers.length > 0) {
      if (!selectedVerifierId || !eligibleVerifiers.some((v) => v.user_id === selectedVerifierId)) {
        setSelectedVerifierId(eligibleVerifiers[0].user_id);
      }
    }
    setSubmitModalVisible(true);
  }

  async function handleSubmitCompletion() {
    if (!challenge || !selectedVerifierId || !selectedDate || isSubmitting) return;

    if (isProofCodeRequired) {
      if (!effectiveProofChallenge) {
        setSubmitError('Please generate a dynamic proof challenge code first.');
        return;
      }

      if (isProofExpired) {
        setSubmitError('This proof challenge has expired. Please tap "Get New Code" to regenerate.');
        return;
      }
    }

    if (proofMethod === 'text_log') {
      const trimmed = textEntry.trim();
      if (trimmed.length < 5 || trimmed.length > 500) {
        setSubmitError('Written log must be between 5 and 500 characters.');
        return;
      }
    }

    if (proofMethod === 'numeric_entry') {
      if (!numericValue.trim()) {
        setSubmitError('Please enter a numeric completion value.');
        return;
      }
      const val = Number(numericValue.trim());
      if (!Number.isFinite(val) || val < 0 || val > 1000000) {
        setSubmitError('Numeric value must be a valid number between 0 and 1,000,000.');
        return;
      }
      if (challenge.proofConfig?.min_value !== undefined && val < challenge.proofConfig.min_value) {
        setSubmitError(
          `Value must be at least ${challenge.proofConfig.min_value}${challenge.proofConfig.unit ? ' ' + challenge.proofConfig.unit : ''}.`
        );
        return;
      }
      if (challenge.proofConfig?.max_value !== undefined && val > challenge.proofConfig.max_value) {
        setSubmitError(
          `Value must be at most ${challenge.proofConfig.max_value}${challenge.proofConfig.unit ? ' ' + challenge.proofConfig.unit : ''}.`
        );
        return;
      }
    }

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const result = await submitCompletion({
        challengeId: challenge.id,
        verifierId: selectedVerifierId,
        completionDate: selectedDate,
        proofChallengeId: isProofCodeRequired ? (effectiveProofChallenge?.id ?? null) : null,
        submissionNote: submissionNote.trim() || undefined,
        numericValue: proofMethod === 'numeric_entry' ? Number(numericValue.trim()) : undefined,
        textEntry: proofMethod === 'text_log' ? textEntry.trim() : undefined,
      });

      if (!result.success || !result.completion) {
        setSubmitError(result.error || 'Failed to submit completion. Please try again.');
        if (
          result.error?.includes('expired') ||
          result.error?.includes('consumed') ||
          result.error?.includes('cancelled')
        ) {
          setActiveProofChallenge(null);
        }
        return;
      }

      const submittedCompletion = result.completion;
      setActiveProofChallenge(null);
      setDateChangeNotice(null);
      setSubmitSuccess(submittedCompletion);
      toast.success('Completion submitted for review!');
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
      proofCode: completion.proof_code || undefined,
      actionPrompt: completion.action_prompt || undefined,
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
      toast.success('Verifier reassigned successfully!');
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
        toast.error(sanitizeUserErrorMessage(res.error, 'Failed to approve'));
        return;
      }
      toast.success('Dare approved successfully!');
      await Promise.all([refreshVerificationData(), refreshPendingReviews()]);
    } catch (err: any) {
      toast.error(sanitizeUserErrorMessage(err?.message, 'Error approving'));
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
        toast.error(sanitizeUserErrorMessage(res.error, 'Failed to reject'));
        return;
      }
      setInlineRejectModalVisible(false);
      setRejectingCompletion(null);
      toast.info('Submission rejected.');
      await Promise.all([refreshVerificationData(), refreshPendingReviews()]);
    } catch (err: any) {
      toast.error(sanitizeUserErrorMessage(err?.message, 'Error rejecting'));
    } finally {
      setIsReviewing(false);
    }
  }

  // Determine current submission state for UI
  const isOneTimeApproved = !isDaily && latestCompletion?.status === 'approved';
  const isOneTimePending = !isDaily && latestCompletion?.status === 'pending';
  const isOneTimeRejected = !isDaily && latestCompletion?.status === 'rejected';
  const isTodayApproved = isDaily && todayCompletion?.status === 'approved';
  const isTodayPending = isDaily && todayCompletion?.status === 'pending';
  const isTodayRejected = isDaily && todayCompletion?.status === 'rejected';

  const isTodayResubmissionPending = isTodayPending && isResubmission(todayCompletion);
  const isOneTimeResubmissionPending = isOneTimePending && isResubmission(latestCompletion);

  const todayGraceStatus = getResubmissionGraceStatus(todayCompletion?.reviewed_at, currentTimeMs);
  const oneTimeGraceStatus = getResubmissionGraceStatus(latestCompletion?.reviewed_at, currentTimeMs);
  const targetCompletionForDate = isDaily
    ? userSubmissions.find((c) => c.completion_date === selectedDate)
    : latestCompletion;
  const isModalResubmission = targetCompletionForDate?.status === 'rejected';
  const modalGraceStatus = getResubmissionGraceStatus(targetCompletionForDate?.reviewed_at, currentTimeMs);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />


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

              <View style={styles.proofMethodPill}>
                <DDIcon
                  name={
                    proofMethod === 'physical_action'
                      ? 'shield-check'
                      : proofMethod === 'photo_code'
                        ? 'sparkle'
                        : proofMethod === 'numeric_entry'
                          ? 'target'
                          : proofMethod === 'text_log'
                            ? 'compass'
                            : 'verify'
                  }
                  size={12}
                  color={DD_COLORS.info}
                  weight="bold"
                />
                <DDText variant="caption" customColor={DD_COLORS.info} style={styles.proofMethodPillText}>
                  {proofMethod === 'physical_action'
                    ? 'Gesture + Code'
                    : proofMethod === 'photo_code'
                      ? 'Photo + Code'
                      : proofMethod === 'numeric_entry'
                        ? 'Number Entry'
                        : proofMethod === 'text_log'
                          ? 'Written Log'
                          : 'Peer Vouch'}
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
                {isProofCodeRequired ? (
                  <DDBadge label="WhatsApp Proof" variant="lime" size="sm" icon="share" />
                ) : proofMethod === 'numeric_entry' ? (
                  <DDBadge label="Numeric Metric" variant="lime" size="sm" icon="target" />
                ) : proofMethod === 'text_log' ? (
                  <DDBadge label="Written Log" variant="lime" size="sm" icon="compass" />
                ) : (
                  <DDBadge label="Peer Vouch" variant="lime" size="sm" icon="check" />
                )}
              </View>
              <DDText variant="h3" color="primary" style={styles.cardMainTitle}>
                Submit Dare Proof
              </DDText>
            </View>

            <DDText variant="bodySm" color="secondary" style={styles.cardDescription}>
              {isProofCodeRequired
                ? 'Submissions require peer verification. Submit completion below, then send your proof photo or video to your assigned verifier via WhatsApp.'
                : 'Submissions require peer verification. Submit your completion details below for your assigned verifier to review.'}
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
              <View
                style={[
                  styles.statusCallout,
                  isTodayResubmissionPending ? styles.statusCalloutResubmission : styles.statusCalloutPending,
                ]}>
                <DDIcon
                  name={isTodayResubmissionPending ? 'refresh' : 'clock'}
                  size={20}
                  color={isTodayResubmissionPending ? DD_COLORS.coral : DD_COLORS.warning}
                  weight="bold"
                />
                <View style={styles.calloutTexts}>
                  <DDText
                    variant="label"
                    color={isTodayResubmissionPending ? 'coral' : 'warning'}
                    bold>
                    {isTodayResubmissionPending
                      ? 'Today’s Resubmission Pending Review'
                      : 'Today is Pending Verification'}
                  </DDText>
                  <DDText variant="caption" color="secondary">
                    Submitted for {todayDate}. Waiting for verifier approval.
                  </DDText>
                  {isTodayResubmissionPending && todayCompletion?.last_rejection_reason ? (
                    <DDText variant="caption" color="coral">
                      Previous feedback: &quot;{todayCompletion.last_rejection_reason}&quot;
                      {todayCompletion.last_reviewed_at
                        ? ` (${formatReviewedAt(todayCompletion.last_reviewed_at)})`
                        : ''}
                    </DDText>
                  ) : null}
                  {todayCompletion && (todayCompletion.proof_code || isProofCodeRequired) && (
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
                    {todayGraceStatus.isUnverifiable
                      ? 'Submission Rejected (Timestamp Unverified)'
                      : todayGraceStatus.isExpired
                        ? 'Submission Rejected (Window Expired)'
                        : 'Submission Needs Resubmission'}
                  </DDText>
                  <DDText variant="caption" color="secondary">
                    Reason: {todayCompletion?.rejection_reason || 'Proof was not approved.'}
                    {todayCompletion?.reviewed_at
                      ? ` • Reviewed ${formatReviewedAt(todayCompletion.reviewed_at)}`
                      : ''}
                  </DDText>
                  <DDText
                    variant="caption"
                    color={todayGraceStatus.isExpired ? 'danger' : 'warning'}
                    bold>
                    {todayGraceStatus.isUnverifiable
                      ? 'The rejection timestamp cannot be verified.'
                      : todayGraceStatus.isExpired
                        ? `48-hour resubmission window expired on ${todayGraceStatus.formattedDeadline}`
                        : `48h window active • ${todayGraceStatus.label} (until ${todayGraceStatus.formattedDeadline})`}
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
              <View
                style={[
                  styles.statusCallout,
                  isOneTimeResubmissionPending ? styles.statusCalloutResubmission : styles.statusCalloutPending,
                ]}>
                <DDIcon
                  name={isOneTimeResubmissionPending ? 'refresh' : 'clock'}
                  size={20}
                  color={isOneTimeResubmissionPending ? DD_COLORS.coral : DD_COLORS.warning}
                  weight="bold"
                />
                <View style={styles.calloutTexts}>
                  <DDText
                    variant="label"
                    color={isOneTimeResubmissionPending ? 'coral' : 'warning'}
                    bold>
                    {isOneTimeResubmissionPending
                      ? 'Dare Resubmission Pending Review'
                      : 'Dare Submission Pending Review'}
                  </DDText>
                  <DDText variant="caption" color="secondary">
                    Your completion is currently awaiting review by your verifier.
                  </DDText>
                  {isOneTimeResubmissionPending && latestCompletion?.last_rejection_reason ? (
                    <DDText variant="caption" color="coral">
                      Previous feedback: &quot;{latestCompletion.last_rejection_reason}&quot;
                      {latestCompletion.last_reviewed_at
                        ? ` (${formatReviewedAt(latestCompletion.last_reviewed_at)})`
                        : ''}
                    </DDText>
                  ) : null}
                  {latestCompletion && (latestCompletion.proof_code || isProofCodeRequired) && (
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

            {!isDaily && isOneTimeRejected && (
              <View style={[styles.statusCallout, styles.statusCalloutRejected]}>
                <DDIcon name="warning" size={20} color={DD_COLORS.danger} weight="bold" />
                <View style={styles.calloutTexts}>
                  <DDText variant="label" color="danger" bold>
                    {oneTimeGraceStatus.isUnverifiable
                      ? 'Dare Rejected (Timestamp Unverified)'
                      : oneTimeGraceStatus.isExpired
                        ? 'Dare Rejected (Window Expired)'
                        : 'Dare Needs Resubmission'}
                  </DDText>
                  <DDText variant="caption" color="secondary">
                    Reason: {latestCompletion?.rejection_reason || 'Proof was not approved.'}
                    {latestCompletion?.reviewed_at
                      ? ` • Reviewed ${formatReviewedAt(latestCompletion.reviewed_at)}`
                      : ''}
                  </DDText>
                  <DDText
                    variant="caption"
                    color={oneTimeGraceStatus.isExpired ? 'danger' : 'warning'}
                    bold>
                    {oneTimeGraceStatus.isUnverifiable
                      ? 'The rejection timestamp cannot be verified. Resubmission is unavailable.'
                      : oneTimeGraceStatus.isExpired
                        ? `48-hour resubmission window expired on ${oneTimeGraceStatus.formattedDeadline}`
                        : `48h window active • ${oneTimeGraceStatus.label} (until ${oneTimeGraceStatus.formattedDeadline})`}
                  </DDText>
                </View>
              </View>
            )}

            {/* Main Submit Action Buttons */}
            {!isOneTimeApproved && !isOneTimePending && (
              <View style={styles.submitActionBox}>
                <DDButton
                  title={
                    isDaily
                      ? isTodayApproved
                        ? 'Submit Another Day'
                        : isTodayRejected
                          ? todayGraceStatus.isExpired
                            ? todayGraceStatus.isUnverifiable
                              ? 'Timestamp Unverified'
                              : 'Resubmission Window Expired'
                            : 'Resubmit Today’s Completion'
                          : 'Submit Completion'
                      : isOneTimeRejected
                        ? oneTimeGraceStatus.isExpired
                          ? oneTimeGraceStatus.isUnverifiable
                            ? 'Timestamp Unverified'
                            : 'Resubmission Window Expired'
                          : 'Resubmit Dare'
                        : 'Submit Completion'
                  }
                  variant={
                    (isDaily && isTodayRejected && todayGraceStatus.isExpired) ||
                    (!isDaily && isOneTimeRejected && oneTimeGraceStatus.isExpired)
                      ? 'outline'
                      : 'primary'
                  }
                  disabled={
                    (isDaily && isTodayRejected && todayGraceStatus.isExpired) ||
                    (!isDaily && isOneTimeRejected && oneTimeGraceStatus.isExpired)
                  }
                  iconLeft={
                    (isDaily && isTodayRejected) || (!isDaily && isOneTimeRejected)
                      ? 'refresh'
                      : 'plus'
                  }
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
                      <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
                        {isResubmission(item) && (
                          <DDBadge label="Resubmission" variant="coral" size="sm" icon="refresh" />
                        )}
                        <DDBadge label="Pending" variant="warning" size="sm" icon="clock" />
                      </View>
                    </View>

                    {item.submission_note ? (
                      <View style={styles.reviewNoteBox}>
                        <DDText variant="caption" color="secondary" style={styles.reviewNoteText}>
                          &quot;{item.submission_note}&quot;
                        </DDText>
                      </View>
                    ) : null}

                    {isResubmission(item) && item.last_rejection_reason ? (
                      <View style={styles.reviewPrevFeedbackBox}>
                        <DDText variant="caption" color="coral" numberOfLines={2}>
                          Previous feedback: &quot;{item.last_rejection_reason}&quot;
                          {item.last_reviewed_at ? ` (${formatReviewedAt(item.last_reviewed_at)})` : ''}
                        </DDText>
                      </View>
                    ) : null}

                    {item.numeric_value !== null && item.numeric_value !== undefined ? (
                      <View style={styles.reviewProofBox}>
                        <DDIcon name="target" size={13} color={DD_COLORS.lime} weight="bold" />
                        <DDText variant="caption" color="lime" bold style={{ marginLeft: 4 }}>
                          Recorded Metric: {item.numeric_value} {challenge?.proofConfig?.unit || ''}
                        </DDText>
                      </View>
                    ) : null}

                    {item.text_entry ? (
                      <View style={styles.reviewProofBox}>
                        <DDIcon name="compass" size={13} color={DD_COLORS.textMuted} weight="bold" />
                        <DDText variant="caption" color="secondary" style={{ marginLeft: 4 }} numberOfLines={3}>
                          &quot;{item.text_entry}&quot;
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
                        <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
                          {isResubmission(item) && (
                            <DDBadge label="Resubmitted" variant="coral" size="sm" icon="refresh" />
                          )}
                          <DDBadge label="Pending" variant="warning" size="sm" icon="clock" />
                        </View>
                      )}
                      {item.status === 'rejected' && (() => {
                        const grace = getResubmissionGraceStatus(item.reviewed_at, currentTimeMs);
                        return (
                          <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center' }}>
                            <DDBadge label="Rejected" variant="danger" size="sm" icon="x-circle" />
                            {grace.isUnverifiable ? (
                              <DDBadge label="Unverifiable" variant="neutral" size="sm" icon="x-circle" />
                            ) : grace.isExpired ? (
                              <DDBadge label="Expired" variant="neutral" size="sm" icon="clock" />
                            ) : (
                              <DDBadge label={grace.label} variant="warning" size="sm" icon="clock" />
                            )}
                          </View>
                        );
                      })()}
                    </View>

                    {item.submission_note ? (
                      <DDText variant="caption" color="secondary" style={styles.historyNote}>
                        Note: &quot;{item.submission_note}&quot;
                      </DDText>
                    ) : null}

                    {item.rejection_reason && item.status === 'rejected' ? (
                      <DDText variant="caption" color="danger" style={styles.rejectionReasonText}>
                        Feedback: {item.rejection_reason}
                        {item.reviewed_at
                          ? ` • Reviewed ${formatReviewedAt(item.reviewed_at)}`
                          : ' • Rejection timestamp cannot be verified'}
                      </DDText>
                    ) : null}

                    {item.status === 'pending' && isResubmission(item) && item.last_rejection_reason ? (
                      <DDText variant="caption" color="coral" style={styles.rejectionReasonText}>
                        Previous Feedback: {item.last_rejection_reason}
                        {item.last_reviewed_at ? ` • Reviewed ${formatReviewedAt(item.last_reviewed_at)}` : ''}
                      </DDText>
                    ) : null}

                    {item.numeric_value !== null && item.numeric_value !== undefined ? (
                      <DDText variant="caption" color="lime" style={styles.historyMetricText}>
                        Metric: {item.numeric_value} {challenge?.proofConfig?.unit || ''}
                      </DDText>
                    ) : null}

                    {item.text_entry ? (
                      <DDText variant="caption" color="secondary" style={styles.historyLogText} numberOfLines={2}>
                        Log: &quot;{item.text_entry}&quot;
                      </DDText>
                    ) : null}

                    {/* Actions on history items */}
                    <View style={styles.historyActionsRow}>
                      {item.status === 'pending' && (
                        <>
                          {(item.proof_code || isProofCodeRequired) && (
                            <DDButton
                              title="WhatsApp Proof"
                              variant="secondary"
                              size="sm"
                              iconLeft="share"
                              onPress={() => handleSendWhatsAppProof(item)}
                            />
                          )}
                          <DDButton
                            title="Reassign Verifier"
                            variant="outline"
                            size="sm"
                            iconLeft="refresh"
                            onPress={() => openReassignModal(item)}
                          />
                        </>
                      )}

                      {item.status === 'rejected' && (() => {
                        const grace = getResubmissionGraceStatus(item.reviewed_at, currentTimeMs);
                        if (grace.isUnverifiable) {
                          return (
                            <DDButton
                              title="Timestamp Unverified"
                              variant="outline"
                              size="sm"
                              disabled
                              style={{ opacity: 0.5 }}
                            />
                          );
                        }
                        if (grace.isExpired) {
                          return (
                            <DDButton
                              title="Resubmission Expired (48h)"
                              variant="outline"
                              size="sm"
                              disabled
                              style={{ opacity: 0.5 }}
                            />
                          );
                        }
                        return (
                          <DDButton
                            title="Resubmit for this date"
                            variant="primary"
                            size="sm"
                            iconLeft="refresh"
                            onPress={() => openSubmitModal(item.completion_date)}
                          />
                        );
                      })()}
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
              isProofCodeRequired
                ? 'Share your photo or video proof directly with your verifier via WhatsApp'
                : 'Submit your completion for your assigned verifier to review in the app',
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
        onRequestClose={closeSubmitModal}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            {/* Modal Header */}
            <View style={styles.modalHeaderRow}>
              <View style={styles.modalHeaderTexts}>
                <DDText variant="h3" color="primary">
                  {isModalResubmission
                    ? isDaily
                      ? 'Resubmit Completion'
                      : 'Resubmit Dare'
                    : isDaily
                      ? 'Submit Completion'
                      : 'Submit Dare'}
                </DDText>
                <DDText variant="caption" color="muted" numberOfLines={1}>
                  {challenge.title}
                </DDText>
              </View>
              <Pressable
                onPress={closeSubmitModal}
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

                {submitSuccess.numeric_value !== null && submitSuccess.numeric_value !== undefined ? (
                  <View style={styles.successProofDetailsBox}>
                    <View style={styles.proofCodeRow}>
                      <DDText variant="caption" color="muted" bold>
                        RECORDED METRIC
                      </DDText>
                      <View style={styles.proofCodeBadge}>
                        <DDText variant="title" color="lime" bold style={styles.proofCodeText}>
                          {submitSuccess.numeric_value} {challenge.proofConfig?.unit || ''}
                        </DDText>
                      </View>
                    </View>
                  </View>
                ) : null}

                {submitSuccess.text_entry ? (
                  <View style={styles.successProofDetailsBox}>
                    <DDText variant="caption" color="muted" bold>
                      SUBMITTED LOG
                    </DDText>
                    <DDText variant="bodySm" color="primary" style={{ marginTop: 4 }}>
                      &quot;{submitSuccess.text_entry}&quot;
                    </DDText>
                  </View>
                ) : null}

                {submitSuccess.proof_code ? (
                  <View style={styles.successProofDetailsBox}>
                    <View style={styles.proofCodeRow}>
                      <DDText variant="caption" color="muted" bold>
                        YOUR PROOF CODE
                      </DDText>
                      <View style={styles.proofCodeBadge}>
                        <DDText variant="title" color="lime" bold style={styles.proofCodeText}>
                          {submitSuccess.proof_code}
                        </DDText>
                      </View>
                    </View>
                    {submitSuccess.action_prompt && submitSuccess.action_prompt_id !== 'write_code_on_paper' ? (
                      <View style={styles.proofActionRow}>
                        <DDText variant="caption" color="muted" bold>
                          ACTION
                        </DDText>
                        <DDText
                          variant="bodySm"
                          color="primary"
                          bold
                          numberOfLines={2}
                          style={{ flex: 1, textAlign: 'right', marginLeft: 8 }}>
                          {submitSuccess.action_prompt}
                        </DDText>
                      </View>
                    ) : null}
                  </View>
                ) : null}

                {isProofCodeRequired ? (
                  <>
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
                  </>
                ) : (
                  <View style={styles.successProofBox}>
                    <DDIcon name="check-circle" size={16} color={DD_COLORS.lime} weight="bold" />
                    <DDText variant="caption" color="secondary" style={styles.successProofNotice}>
                      Your submission has been sent to your assigned verifier for review. Once verified, your progress and streak will update!
                    </DDText>
                  </View>
                )}

                <DDButton
                  title="Done"
                  variant="secondary"
                  onPress={closeSubmitModal}
                  fullWidth
                  style={{ marginTop: isProofCodeRequired ? 0 : 8 }}
                />
              </View>
            ) : (
              /* Form State */
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.formScroll}>
                {isModalResubmission && (
                  <View style={styles.modalResubmitCard}>
                    <View style={styles.modalResubmitHeader}>
                      <DDIcon name="warning" size={16} color={DD_COLORS.coral} weight="bold" />
                      <DDText variant="label" color="coral" bold style={{ marginLeft: 6 }}>
                        {isDaily ? `Resubmitting for ${selectedDate}` : 'Resubmitting Dare'}
                      </DDText>
                    </View>
                    {targetCompletionForDate?.rejection_reason ? (
                      <View style={styles.modalPrevFeedbackBox}>
                        <DDText variant="caption" color="muted" bold>
                          PREVIOUS VERIFIER FEEDBACK
                        </DDText>
                        <DDText variant="bodySm" color="primary" style={{ marginTop: 2 }}>
                          &quot;{targetCompletionForDate.rejection_reason}&quot;
                        </DDText>
                      </View>
                    ) : null}
                    <View style={styles.modalGraceRow}>
                      <DDIcon
                        name="clock"
                        size={12}
                        color={modalGraceStatus.isExpired ? DD_COLORS.danger : DD_COLORS.warning}
                        weight="bold"
                      />
                      <DDText
                        variant="caption"
                        color={modalGraceStatus.isExpired ? 'danger' : 'secondary'}
                        style={{ marginLeft: 4 }}>
                        {modalGraceStatus.isUnverifiable
                          ? 'The rejection timestamp cannot be verified. Resubmission is unavailable.'
                          : modalGraceStatus.isExpired
                            ? `Resubmission window expired on ${modalGraceStatus.formattedDeadline}`
                            : `48h grace window: ${modalGraceStatus.label} (until ${modalGraceStatus.formattedDeadline})`}
                      </DDText>
                    </View>
                  </View>
                )}

                {/* Date Selection (Daily challenge) */}
                {isDaily ? (
                  <View style={styles.formGroup}>
                    <DDText variant="label" color="primary" bold style={styles.formLabel}>
                      Completion Date
                    </DDText>
                    <View style={styles.dateSelectorRow}>
                      <Pressable
                        onPress={() => handleSelectDate(todayDate)}
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
                        onPress={() => handleSelectDate(yesterdayDate)}
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

                      {selectedDate !== todayDate && selectedDate !== yesterdayDate && (
                        <View style={[styles.dateOption, styles.dateOptionActive]}>
                          <DDIcon name="refresh" size={14} color={DD_COLORS.lime} weight="bold" />
                          <DDText variant="caption" bold color="lime">
                            {selectedDate} (Resubmission)
                          </DDText>
                        </View>
                      )}
                    </View>

                    {dateChangeNotice ? (
                      <View style={styles.dateChangeNoticeBox}>
                        <DDIcon name="info" size={14} color={DD_COLORS.warning} weight="bold" />
                        <DDText variant="caption" color="warning" bold style={{ marginLeft: 6, flex: 1 }}>
                          {dateChangeNotice}
                        </DDText>
                      </View>
                    ) : null}

                    <DDText variant="caption" color="muted" style={styles.formHint}>
                      {isModalResubmission
                        ? modalGraceStatus.isUnverifiable
                          ? `Resubmission for ${selectedDate} is unavailable because the rejection timestamp cannot be verified.`
                          : `Resubmitting for ${selectedDate}. 48-hour grace period active.`
                        : `Submissions accepted for today and yesterday in challenge timezone (${challenge.timezone || 'UTC'}).`}
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
                        {selectedDate === todayDate ? `Today: ${todayDate}` : `Dare Date: ${selectedDate}`}
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
                          closeSubmitModal();
                          handleShare();
                        }}
                      />
                    </View>
                  ) : (
                    <View style={styles.verifiersList}>
                      {eligibleVerifiers.map((v) => (
                        <Pressable
                          key={v.user_id}
                          onPress={() => handleSelectVerifier(v.user_id)}
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

                {/* Proof Input Section based on proofMethod */}
                {proofMethod === 'numeric_entry' && (
                  <View style={styles.formGroup}>
                    <DDText variant="label" color="primary" bold style={styles.formLabel}>
                      Recorded Value {challenge.proofConfig?.unit ? `(${challenge.proofConfig.unit})` : ''}
                    </DDText>
                    <TextInput
                      style={styles.textInput}
                      placeholder={
                        challenge.proofConfig?.unit
                          ? `e.g. 50 ${challenge.proofConfig.unit}`
                          : 'e.g. 25'
                      }
                      placeholderTextColor={DD_COLORS.textMuted}
                      value={numericValue}
                      onChangeText={setNumericValue}
                      keyboardType="numeric"
                    />
                    {(challenge.proofConfig?.min_value !== undefined ||
                      challenge.proofConfig?.max_value !== undefined) && (
                      <DDText variant="caption" color="muted" style={styles.formHint}>
                        Allowed range:{' '}
                        {challenge.proofConfig.min_value !== undefined
                          ? `min ${challenge.proofConfig.min_value}`
                          : ''}
                        {challenge.proofConfig.min_value !== undefined &&
                        challenge.proofConfig.max_value !== undefined
                          ? ', '
                          : ''}
                        {challenge.proofConfig.max_value !== undefined
                          ? `max ${challenge.proofConfig.max_value}`
                          : ''}
                        {challenge.proofConfig.unit ? ` ${challenge.proofConfig.unit}` : ''}
                      </DDText>
                    )}
                  </View>
                )}

                {proofMethod === 'text_log' && (
                  <View style={styles.formGroup}>
                    <View style={styles.sectionHeaderRow}>
                      <DDText variant="label" color="primary" bold style={styles.formLabel}>
                        Written Completion Log
                      </DDText>
                      <DDText
                        variant="caption"
                        color={
                          textEntry.trim().length >= 5 && textEntry.trim().length <= 500
                            ? 'muted'
                            : 'warning'
                        }>
                        {textEntry.trim().length}/500 chars (min 5)
                      </DDText>
                    </View>
                    <TextInput
                      style={[styles.textInput, { minHeight: 90, textAlignVertical: 'top' }]}
                      placeholder="Describe what you completed, lessons learned, or details..."
                      placeholderTextColor={DD_COLORS.textMuted}
                      value={textEntry}
                      onChangeText={setTextEntry}
                      multiline
                      numberOfLines={4}
                      maxLength={500}
                    />
                    <DDText variant="caption" color="muted" style={styles.formHint}>
                      Write a brief log of your accomplishment (5–500 characters) for your verifier to read.
                    </DDText>
                  </View>
                )}

                {proofMethod === 'peer_confirmation' && (
                  <View style={styles.formGroup}>
                    <View style={styles.peerConfirmationCard}>
                      <DDIcon name="verify" size={20} color={DD_COLORS.lime} weight="fill" />
                      <View style={{ flex: 1, marginLeft: 10 }}>
                        <DDText variant="label" color="primary" bold>
                          Peer Honor Verification
                        </DDText>
                        <DDText variant="caption" color="secondary" style={{ marginTop: 2 }}>
                          No photo, video, or code required. Your assigned verifier will vouch for your completion based on direct observation or peer trust.
                        </DDText>
                      </View>
                    </View>
                  </View>
                )}

                {isProofCodeRequired && (
                  <View style={styles.formGroup}>
                    <View style={styles.sectionHeaderRow}>
                      <DDText variant="label" color="primary" bold style={styles.formLabel}>
                        {proofMethod === 'photo_code' ? 'Photo Proof Code' : 'Dynamic Proof Challenge'}
                      </DDText>
                      {effectiveProofChallenge && !isProofExpired ? (
                        <Pressable
                          onPress={handleGenerateProof}
                          disabled={isGeneratingProof || isSubmitting}
                          hitSlop={8}>
                          <DDText variant="caption" color="lime" bold>
                            {isGeneratingProof ? 'Regenerating...' : 'Get New Code'}
                          </DDText>
                        </Pressable>
                      ) : null}
                    </View>

                    {!effectiveProofChallenge ? (
                      <View style={styles.generateProofPromptBox}>
                        <View style={styles.generateProofHeaderRow}>
                          <DDIcon name="shield-check" size={18} color={DD_COLORS.lime} weight="bold" />
                          <DDText variant="bodySm" color="primary" bold style={{ flex: 1, marginLeft: 8 }}>
                            {proofMethod === 'photo_code'
                              ? 'Step 1: Generate Proof Code'
                              : 'Step 1: Generate Proof Code & Gesture'}
                          </DDText>
                        </View>
                        <DDText variant="caption" color="secondary" style={styles.generateProofDesc}>
                          {proofMethod === 'photo_code'
                            ? 'To prevent recycled photos, DareDrop generates a fresh 4-character code. Write this code on paper before taking your photo.'
                            : 'To prevent recycled photos, DareDrop requires a unique 4-character code and gesture. Generate your code now before capturing proof.'}
                        </DDText>

                        {proofError ? (
                          <View style={styles.proofErrorBox}>
                            <DDIcon name="warning" size={14} color={DD_COLORS.danger} weight="bold" />
                            <DDText variant="caption" color="danger" style={{ flex: 1, marginLeft: 6 }}>
                              {proofError}
                            </DDText>
                          </View>
                        ) : null}

                        <DDButton
                          title={isGeneratingProof ? 'Generating Code...' : 'Generate Proof Challenge'}
                          variant="primary"
                          iconLeft="sparkle"
                          loading={isGeneratingProof}
                          disabled={isGeneratingProof || !selectedVerifierId || eligibleVerifiers.length === 0}
                          onPress={handleGenerateProof}
                          fullWidth
                          style={styles.generateProofBtn}
                        />
                      </View>
                    ) : (
                      <View style={[styles.proofCard, isProofExpired && styles.proofCardExpired]}>
                        {isProofExpired ? (
                          <View style={styles.proofExpiredBanner}>
                            <DDIcon name="warning" size={16} color={DD_COLORS.danger} weight="bold" />
                            <DDText variant="caption" color="danger" bold style={{ flex: 1, marginLeft: 6 }}>
                              Proof challenge expired (45m TTL). Please generate a new code.
                            </DDText>
                          </View>
                        ) : (
                          <View style={styles.proofHeaderRow}>
                            <View style={styles.proofCodeTag}>
                              <DDText variant="caption" color="muted" bold>
                                PROOF CODE
                              </DDText>
                              <DDText variant="h1" color="lime" bold style={styles.proofCodeMonospace}>
                                {effectiveProofChallenge.proof_code}
                              </DDText>
                            </View>
                            <View style={styles.proofTtlBadge}>
                              <DDIcon name="clock" size={12} color={DD_COLORS.lime} weight="bold" />
                              <DDText variant="caption" color="lime" bold style={{ marginLeft: 4 }}>
                                Valid 45m
                              </DDText>
                            </View>
                          </View>
                        )}

                        {proofMethod === 'physical_action' && (
                          <View style={styles.proofActionBox}>
                            <DDText variant="caption" color="muted" bold style={styles.proofActionLabel}>
                              REQUIRED PHYSICAL ACTION / GESTURE
                            </DDText>
                            <DDText variant="body" color="primary" bold style={styles.proofActionPrompt}>
                              {effectiveProofChallenge.action_prompt}
                            </DDText>
                          </View>
                        )}

                        <DDText variant="caption" color="secondary" style={styles.proofInstructionText}>
                          {proofMethod === 'photo_code'
                            ? '✍️ Write code '
                            : '✍️ Include code '}
                          <DDText variant="caption" color="lime" bold>
                            {effectiveProofChallenge.proof_code}
                          </DDText>
                          {proofMethod === 'photo_code'
                            ? ' on paper or note and include it in your photo for your verifier.'
                            : ' on paper/screen and demonstrate the gesture in your evidence for your verifier.'}
                        </DDText>

                        {isProofExpired ? (
                          <DDButton
                            title="Generate Fresh Code"
                            variant="primary"
                            iconLeft="refresh"
                            loading={isGeneratingProof}
                            disabled={isGeneratingProof}
                            onPress={handleGenerateProof}
                            fullWidth
                            style={{ marginTop: 8 }}
                          />
                        ) : null}
                      </View>
                    )}
                  </View>
                )}

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

                {/* Info Notice Box */}
                <View style={styles.infoNoticeBox}>
                  <DDIcon name="info" size={16} color={DD_COLORS.info} weight="bold" />
                  <DDText variant="caption" color="secondary" style={styles.infoNoticeBody}>
                    {isProofCodeRequired ? (
                      <>
                        1. Tap Submit below to log your dare completion.{"\n"}
                        2. Next, tap &lsquo;Share Proof on WhatsApp&rsquo; to send proof to your verifier.{"\n"}
                        3. Once verified, your streak will instantly update!
                      </>
                    ) : (
                      <>
                        1. Tap Submit below to log your dare completion.{"\n"}
                        2. Your assigned verifier will review and confirm your submission in DareDrop.{"\n"}
                        3. Once verified, your streak will instantly update!
                      </>
                    )}
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
                  title={
                    isProofCodeRequired && !effectiveProofChallenge
                      ? 'Generate Proof Code to Submit'
                      : isModalResubmission
                        ? modalGraceStatus.isExpired
                          ? modalGraceStatus.isUnverifiable
                            ? 'Timestamp Unverified'
                            : 'Resubmission Window Expired'
                          : 'Resubmit for Peer Verification'
                        : 'Submit for Peer Verification'
                  }
                  variant="primary"
                  loading={isSubmitting}
                  disabled={
                    isSubmitting ||
                    isGeneratingProof ||
                    !selectedVerifierId ||
                    eligibleVerifiers.length === 0 ||
                    (isModalResubmission && modalGraceStatus.isExpired) ||
                    (isProofCodeRequired
                      ? !effectiveProofChallenge || isProofExpired
                      : proofMethod === 'text_log'
                        ? textEntry.trim().length < 5 || textEntry.trim().length > 500
                        : proofMethod === 'numeric_entry'
                          ? !numericValue.trim() || !Number.isFinite(Number(numericValue.trim()))
                          : false)
                  }
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

            {/* Reassign Advisory Notice */}
            <View style={styles.reassignNoticeBox}>
              <DDIcon name="info" size={14} color={DD_COLORS.info} weight="bold" />
              <DDText variant="caption" color="secondary" style={styles.reassignNoticeText}>
                {isProofCodeRequired
                  ? 'Reassigning updates who can verify on DareDrop, but does NOT transfer WhatsApp media. You must share your proof photo/video on WhatsApp directly with your newly assigned verifier.'
                  : 'Reassigning updates who can verify your submission on DareDrop. Your new verifier will be able to review your submitted completion directly in the app.'}
              </DDText>
            </View>

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
  proofMethodPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    borderRadius: DD_RADII.pill,
    backgroundColor: 'rgba(0, 212, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.25)',
  },
  proofMethodPillText: {
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
  statusCalloutResubmission: {
    backgroundColor: 'rgba(255, 107, 53, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 107, 53, 0.25)',
  },
  modalResubmitCard: {
    backgroundColor: 'rgba(255, 107, 53, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 107, 53, 0.3)',
    borderRadius: DD_RADII.md,
    padding: DD_SPACING.md,
    marginBottom: DD_SPACING.md,
    gap: 6,
  },
  modalResubmitHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  modalPrevFeedbackBox: {
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    borderRadius: DD_RADII.sm,
    padding: DD_SPACING.sm,
    borderLeftWidth: 2,
    borderLeftColor: DD_COLORS.coral,
    marginTop: 2,
  },
  modalGraceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  reviewPrevFeedbackBox: {
    backgroundColor: 'rgba(255, 107, 53, 0.08)',
    borderRadius: DD_RADII.sm,
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 4,
    borderLeftWidth: 2,
    borderLeftColor: DD_COLORS.coral,
    marginTop: 4,
    marginBottom: 4,
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
  reviewProofBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: DD_COLORS.bgCard,
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: DD_SPACING.xs,
    borderRadius: DD_RADII.sm,
    marginTop: 4,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
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
  historyMetricText: {
    marginTop: 2,
    fontWeight: '700',
  },
  historyLogText: {
    marginTop: 2,
    fontStyle: 'italic',
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
  peerConfirmationCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: DD_COLORS.bgElement,
    padding: DD_SPACING.md,
    borderRadius: DD_RADII.md,
    borderWidth: 1,
    borderColor: 'rgba(191, 253, 64, 0.25)',
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
  successProofDetailsBox: {
    width: '100%',
    backgroundColor: DD_COLORS.bgElement,
    borderRadius: DD_RADII.md,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    padding: DD_SPACING.md,
    gap: DD_SPACING.xs,
    marginVertical: DD_SPACING.xs,
  },
  proofCodeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  proofCodeBadge: {
    backgroundColor: 'rgba(191, 253, 64, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(191, 253, 64, 0.4)',
    paddingHorizontal: DD_SPACING.md,
    paddingVertical: 4,
    borderRadius: DD_RADII.sm,
  },
  proofCodeText: {
    letterSpacing: 2,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  proofActionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },

  /* Dynamic Proof Challenge Styles in Form */
  sectionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: DD_SPACING.xs,
  },
  generateProofPromptBox: {
    backgroundColor: DD_COLORS.bgElement,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    borderRadius: DD_RADII.md,
    padding: DD_SPACING.md,
    gap: DD_SPACING.xs,
  },
  generateProofHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  generateProofDesc: {
    lineHeight: 18,
    marginVertical: DD_SPACING.xs,
  },
  generateProofBtn: {
    marginTop: DD_SPACING.xs,
  },
  proofErrorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 75, 75, 0.1)',
    padding: DD_SPACING.sm,
    borderRadius: DD_RADII.sm,
    marginVertical: DD_SPACING.xs,
  },
  dateChangeNoticeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 184, 0, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255, 184, 0, 0.3)',
    borderRadius: DD_RADII.sm,
    paddingVertical: DD_SPACING.xs,
    paddingHorizontal: DD_SPACING.sm,
    marginTop: DD_SPACING.xs,
    marginBottom: DD_SPACING.xs,
  },
  proofCard: {
    backgroundColor: DD_COLORS.bgHighlight,
    borderWidth: 1,
    borderColor: 'rgba(191, 253, 64, 0.35)',
    borderRadius: DD_RADII.lg,
    padding: DD_SPACING.md,
    gap: DD_SPACING.sm,
  },
  proofCardExpired: {
    borderColor: 'rgba(255, 75, 75, 0.4)',
    backgroundColor: 'rgba(255, 75, 75, 0.05)',
  },
  proofHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  proofCodeTag: {
    gap: 2,
  },
  proofCodeMonospace: {
    fontSize: 28,
    letterSpacing: 4,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  proofTtlBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(191, 253, 64, 0.15)',
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 4,
    borderRadius: DD_RADII.full,
  },
  proofExpiredBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 75, 75, 0.12)',
    padding: DD_SPACING.sm,
    borderRadius: DD_RADII.sm,
  },
  proofActionBox: {
    backgroundColor: DD_COLORS.bgCard,
    padding: DD_SPACING.sm,
    borderRadius: DD_RADII.md,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    gap: 4,
  },
  proofActionLabel: {
    fontSize: 10,
    letterSpacing: 0.5,
  },
  proofActionPrompt: {
    lineHeight: 20,
  },
  proofInstructionText: {
    lineHeight: 17,
  },

  /* Reassign Advisory Notice */
  reassignNoticeBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: DD_SPACING.xs,
    backgroundColor: 'rgba(0, 212, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.25)',
    padding: DD_SPACING.sm,
    borderRadius: DD_RADII.md,
    marginBottom: DD_SPACING.md,
  },
  reassignNoticeText: {
    flex: 1,
    lineHeight: 17,
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
