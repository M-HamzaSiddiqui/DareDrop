import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
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
  timeRemaining,
} from '@/data/challenges';
import { copyInviteLink, shareChallenge } from '@/lib/sharing';
import {
  DbChallengeInvitePreview,
  isSupabaseConfigured,
  supabase,
} from '@/lib/supabase';
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

function getProofMethodLabel(method?: string): string {
  switch (method) {
    case 'photo_code':
      return 'Photo + Code';
    case 'text_log':
      return 'Written Log';
    case 'numeric_entry':
      return 'Numeric Entry';
    case 'physical_action':
    default:
      return 'Action + Code';
  }
}

/**
 * DareDrop Redesigned Invitation Screen.
 *
 * Implements:
 * - Clean dark-first aesthetic matching Challenge Details
 * - Neon Lime and Electric Violet accents
 * - Header navigation with Phosphor icons, share trigger, and joined status
 * - Prominent "You've Been Dared" invitation banner with creator avatar
 * - Hero challenge card with category/type badges and creator attribution
 * - 3-metric statistics grid (Challengers, Time Left, Duration)
 * - Challenge timeline progress bar
 * - The DareDrop Pact commitment rules with numbered badges
 * - Quick copy/share link actions
 * - Floating bottom CTA with 48dp touch targets and joining loading state
 */
export default function InviteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { fetchChallengeById, joinChallenge, isUserJoined } = useChallenges();
  const { isGuest, showAuthModal } = useAuth();
  const toast = useToast();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [preview, setPreview] = useState<DbChallengeInvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [justJoined, setJustJoined] = useState(false);

  useEffect(() => {
    let isMounted = true;

    async function load() {
      if (!id) {
        setError('No challenge ID provided in invite link.');
        setLoading(false);
        return;
      }

      // If already joined, immediately open the challenge
      if (isUserJoined(id)) {
        router.replace(`/challenge/${id}`);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        if (isSupabaseConfigured && supabase) {
          // 1. Fetch public invite preview (accessible to anon and authenticated)
          const { data, error: rpcErr } = await supabase.rpc('get_challenge_invite_preview', {
            p_challenge_id: id,
          });

          if (!isMounted) return;

          if (rpcErr || !data || data.length === 0) {
            setError('This invite is not available or has already ended.');
            setLoading(false);
            return;
          }

          const previewData = data[0] as DbChallengeInvitePreview;
          setPreview(previewData);

          // 2. Check if current session already has full member/creator access
          try {
            const found = await fetchChallengeById(id);
            if (found && isMounted) {
              if (found.joined) {
                router.replace(`/challenge/${id}`);
                return;
              }
              setChallenge(found);
            }
          } catch {
            // Expected for non-members
          }
        } else {
          // Offline / Local fallback mode
          const found = await fetchChallengeById(id);
          if (!isMounted) return;

          if (found) {
            if (found.joined) {
              router.replace(`/challenge/${id}`);
              return;
            }
            setChallenge(found);
            setPreview({
              id: found.id,
              title: found.title,
              creator_name: found.creator,
              challenge_type: found.challengeType,
              proof_method: found.proofMethod,
            });
          } else {
            setError('This invite is not available or has already ended.');
          }
        }
      } catch (err: any) {
        if (!isMounted) return;
        setError(err?.message || 'Failed to connect. Check your network or credentials.');
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    load();
    return () => {
      isMounted = false;
    };
  }, [id, fetchChallengeById, isUserJoined]);

  async function handleAccept() {
    if (!id || isJoining) return;
    if (isGuest) {
      showAuthModal({
        title: 'Sign In to Accept Dare',
        description: 'Create an account or sign in to join this dare and track your completions.',
        onSuccess: () => {
          handleAccept();
        },
      });
      return;
    }

    setIsJoining(true);
    try {
      const res = await joinChallenge(id);
      if (res.success && res.joined) {
        setJustJoined(true);
        const dareTitle = preview?.title || challenge?.title || 'the dare';
        toast.success(`You joined "${dareTitle}"!`);
        router.replace(`/challenge/${id}`);
      } else {
        const msg = sanitizeUserErrorMessage(res.error, 'Failed to join challenge. Please try again.');
        setError(msg);
        toast.error(msg);
      }
    } catch (err: any) {
      const msg = sanitizeUserErrorMessage(err?.message, 'Error accepting challenge.');
      setError(msg);
      toast.error(msg);
    } finally {
      setIsJoining(false);
    }
  }

  async function handleCopy() {
    if (!targetId) return;
    const dummyChallenge: Challenge = challenge || {
      id: targetId,
      title: dareTitle,
      description,
      category,
      durationDays: 7,
      participants: 1,
      createdAt: new Date(),
      endsAt: new Date(Date.now() + 7 * 86400000),
      creator: creatorName,
      creatorId: null,
      joined: alreadyJoined,
      challengeType,
      timezone: 'UTC',
      proofMethod,
      proofConfig: {},
    };
    const res = await copyInviteLink(dummyChallenge);
    if (res.success) {
      toast.success('Invite link copied to clipboard!');
    }
  }

  async function handleShare() {
    if (!targetId) return;
    const dummyChallenge: Challenge = challenge || {
      id: targetId,
      title: dareTitle,
      description,
      category,
      durationDays: 7,
      participants: 1,
      createdAt: new Date(),
      endsAt: new Date(Date.now() + 7 * 86400000),
      creator: creatorName,
      creatorId: null,
      joined: alreadyJoined,
      challengeType,
      timezone: 'UTC',
      proofMethod,
      proofConfig: {},
    };
    await shareChallenge(dummyChallenge);
  }

  function handleBack() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }

  // 1. Loading State
  if (loading) {
    return (
      <View style={[styles.root, styles.centerContainer]}>
        <StatusBar style="light" />
        <View style={styles.loadingCard}>
          <ActivityIndicator size="large" color={DD_COLORS.lime} />
          <DDText variant="h2" color="primary" style={styles.loadingTitle}>
            Resolving Dare Invite…
          </DDText>
          <DDText variant="caption" color="secondary">
            Fetching challenge details from DareDrop
          </DDText>
        </View>
      </View>
    );
  }

  // 2. Error / Invalid ID State
  if (error || (!challenge && !preview)) {
    return (
      <View style={[styles.root, styles.centerContainer]}>
        <StatusBar style="light" />
        <DDCard variant="card" padding="lg" style={styles.errorCard}>
          <View style={styles.errorIconContainer}>
            <DDIcon name="warning" size={32} color={DD_COLORS.coral} weight="bold" />
          </View>
          <DDText variant="h2" color="primary" align="center" style={styles.errorTitle}>
            Invite Unavailable
          </DDText>
          <DDText variant="body" color="secondary" align="center" style={styles.errorSubtitle}>
            {error || 'This dare invite is not available or has already ended.'}
          </DDText>
          <DDButton
            title="Back to Home"
            variant="primary"
            fullWidth
            onPress={() => router.replace('/')}
            style={styles.errorCta}
          />
        </DDCard>
      </View>
    );
  }

  const targetId = challenge?.id || preview!.id;
  const dareTitle = challenge?.title || preview!.title;
  const creatorName = challenge?.creator || preview!.creator_name;
  const challengeType = challenge?.challengeType || preview!.challenge_type;
  const proofMethod = challenge?.proofMethod || preview!.proof_method;
  const isDaily = challengeType === 'daily';
  const category = challenge?.category || 'Fitness';
  const description =
    challenge?.description ||
    'Private challenge. Accept the invite to unlock full dare details, track your streak, and submit peer-verified proof.';
  const catColor = CATEGORY_COLORS[category as CategoryKey] || DD_COLORS.lime;
  const catIcon = CATEGORY_ICONS[category as CategoryKey] || 'flame';
  const timeLeft = challenge?.endsAt ? timeRemaining(challenge.endsAt) : 'Active';
  const alreadyJoined = isUserJoined(targetId) || Boolean(challenge?.joined) || justJoined;

  const { daysElapsed, progressPct } = challenge
    ? calculateProgress(challenge.createdAt, challenge.durationDays)
    : { daysElapsed: 0, progressPct: 0 };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      {/* Header bar */}
      <View style={[styles.navBar, { paddingTop: insets.top + DD_SPACING.xs }]}>
        <Pressable
          onPress={handleBack}
          android_ripple={{ color: 'rgba(255, 255, 255, 0.12)', borderless: true, radius: 24 }}
          style={styles.navIconButton}
          accessibilityRole="button"
          accessibilityLabel="Go back">
          <DDIcon name="arrow-left" size={20} color={DD_COLORS.text} weight="bold" />
        </Pressable>

        <DDText variant="h3" color="primary" style={styles.navHeaderTitle}>
          Invitation
        </DDText>

        <View style={styles.navRight}>
          <Pressable
            onPress={handleShare}
            android_ripple={{ color: 'rgba(255, 255, 255, 0.12)', borderless: true, radius: 24 }}
            style={styles.navIconButton}
            accessibilityRole="button"
            accessibilityLabel="Share invite">
            <DDIcon name="share" size={20} color={DD_COLORS.text} weight="bold" />
          </Pressable>

          {alreadyJoined && (
            <DDBadge label="Joined" variant="success" size="sm" icon="check" />
          )}
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 120 },
        ]}
        showsVerticalScrollIndicator={false}>
        {/* A. Invitation Hero Greeting */}
        <View style={styles.inviteBanner}>
          <DDBadge label="YOU'VE BEEN DARED" variant="lime" size="sm" icon="flame" />
          <DDText variant="display" color="primary" style={styles.bannerHeadline}>
            Ready to accept?
          </DDText>
          <View style={styles.bannerSubtitleRow}>
            <DDAvatar name={creatorName} size="sm" />
            <DDText variant="body" color="secondary" style={styles.bannerSubtitleText}>
              <DDText variant="body" color="primary" bold>
                {creatorName}
              </DDText>{' '}
              challenged you to take on this dare.
            </DDText>
          </View>
        </View>

        {/* B. Challenge Hero Card */}
        <DDCard variant="card" padding="lg" style={[styles.heroCard, { borderColor: catColor + '44' }]}>
          <View style={[styles.heroAccentBar, { backgroundColor: catColor }]} />

          <View style={styles.heroBadgesRow}>
            <View style={[styles.categoryPill, { backgroundColor: catColor + '1E' }]}>
              <DDIcon name={catIcon} size={13} color={catColor} weight="fill" />
              <DDText variant="caption" style={[styles.categoryPillText, { color: catColor }]}>
                {challenge ? challenge.category : 'Private Dare'}
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

            <View style={[styles.typePill, { backgroundColor: 'rgba(255, 255, 255, 0.06)' }]}>
              <DDIcon name="verify" size={12} color={DD_COLORS.textMuted} weight="bold" />
              <DDText variant="caption" color="secondary" style={styles.typePillText}>
                {getProofMethodLabel(proofMethod)}
              </DDText>
            </View>
          </View>

          <DDText variant="h1" color="primary" style={styles.challengeTitle}>
            {dareTitle}
          </DDText>

          <DDText variant="body" color="secondary" style={styles.challengeDesc}>
            {description}
          </DDText>

          <View style={styles.creatorRow}>
            <DDAvatar name={creatorName} size="sm" />
            <View style={styles.creatorMeta}>
              <DDText variant="caption" color="muted">
                Created by
              </DDText>
              <DDText variant="label" color="primary" bold>
                {creatorName}
              </DDText>
            </View>
          </View>
        </DDCard>

        {/* C. Quick Metrics Row */}
        {challenge ? (
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
        ) : (
          <View style={styles.statsGrid}>
            <DDCard variant="card" padding="sm" style={styles.statBox}>
              <View style={[styles.statIconBadge, { backgroundColor: 'rgba(155, 89, 255, 0.12)' }]}>
                <DDIcon name="shield-check" size={16} color={DD_COLORS.purple} weight="bold" />
              </View>
              <DDText variant="h3" color="primary" style={styles.statValue}>
                {getProofMethodLabel(proofMethod)}
              </DDText>
              <DDText variant="caption" color="secondary" style={styles.statLabel}>
                Proof Mode
              </DDText>
            </DDCard>

            <DDCard variant="card" padding="sm" style={styles.statBox}>
              <View style={[styles.statIconBadge, { backgroundColor: 'rgba(191, 253, 64, 0.12)' }]}>
                <DDIcon name="lock" size={16} color={DD_COLORS.lime} weight="bold" />
              </View>
              <DDText variant="h3" color="primary" style={styles.statValue}>
                Invite Only
              </DDText>
              <DDText variant="caption" color="secondary" style={styles.statLabel}>
                Privacy
              </DDText>
            </DDCard>

            <DDCard variant="card" padding="sm" style={styles.statBox}>
              <View style={[styles.statIconBadge, { backgroundColor: 'rgba(255, 60, 172, 0.12)' }]}>
                <DDIcon name={isDaily ? 'flame' : 'target'} size={16} color={DD_COLORS.catFun} weight="bold" />
              </View>
              <DDText variant="h3" color="primary" style={styles.statValue}>
                {isDaily ? 'Daily' : 'One-Time'}
              </DDText>
              <DDText variant="caption" color="secondary" style={styles.statLabel}>
                Cadence
              </DDText>
            </DDCard>
          </View>
        )}

        {/* D. Challenge Timeline (if full challenge loaded) */}
        {challenge && (
          <DDCard variant="card" padding="md" style={styles.sectionCard}>
            <View style={styles.timelineHeader}>
              <View style={styles.timelineHeaderLeft}>
                <DDIcon name="calendar" size={16} color={DD_COLORS.lime} weight="bold" />
                <DDText variant="h3" color="primary" style={styles.timelineTitle}>
                  Challenge Timeline
                </DDText>
              </View>
              <DDText variant="h3" style={[styles.progressPctText, { color: catColor }]}>
                {progressPct}%
              </DDText>
            </View>

            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.min(100, Math.max(0, progressPct))}%` as any, backgroundColor: catColor },
                ]}
              />
            </View>

            <View style={styles.timelineFooter}>
              <DDText variant="caption" color="muted">
                Day {daysElapsed + 1} of {challenge.durationDays}
              </DDText>
              <DDText variant="caption" color="muted">
                {timeLeft} left
              </DDText>
            </View>
          </DDCard>
        )}

        {/* E. The DareDrop Pact (Rules) */}
        <DDCard variant="card" padding="md" style={styles.sectionCard}>
          <View style={styles.rulesHeader}>
            <DDIcon name="shield-check" size={18} color={DD_COLORS.lime} weight="bold" />
            <DDText variant="h3" color="primary" style={styles.rulesTitle}>
              The DareDrop Pact
            </DDText>
          </View>

          {[
            'Accept the dare and lock in for the full duration',
            'Check in and submit honest peer proof',
            'Hold your squad accountable and stay consistent',
          ].map((rule, idx) => (
            <View key={idx} style={styles.ruleRow}>
              <View style={styles.ruleNumberBadge}>
                <DDText variant="caption" color="lime" bold>
                  {idx + 1}
                </DDText>
              </View>
              <DDText variant="body" color="secondary" style={styles.ruleContent}>
                {rule}
              </DDText>
            </View>
          ))}
        </DDCard>

        {/* F. Share / Copy Link Card */}
        <DDCard variant="card" padding="md" style={styles.shareCard}>
          <View style={styles.shareCardHeader}>
            <DDIcon name="copy" size={18} color={DD_COLORS.purple} weight="bold" />
            <View style={styles.shareCardMeta}>
              <DDText variant="h3" color="primary">
                Invite Other Friends
              </DDText>
              <DDText variant="caption" color="secondary">
                Share this link with your squad to compete together
              </DDText>
            </View>
          </View>
          <DDButton
            title="Copy Invite Link"
            variant="outline"
            iconLeft="copy"
            fullWidth
            onPress={handleCopy}
            style={styles.shareCardBtn}
          />
        </DDCard>
      </ScrollView>

      {/* Floating Bottom CTA */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + DD_SPACING.sm }]}>
        {alreadyJoined ? (
          <DDButton
            title="You're in this dare! View Challenge →"
            variant="secondary"
            iconRight="arrow-right"
            fullWidth
            onPress={() => router.replace(`/challenge/${targetId}`)}
          />
        ) : (
          <DDButton
            title="Accept Dare & Join"
            variant="primary"
            iconLeft="check"
            fullWidth
            loading={isJoining}
            disabled={isJoining}
            onPress={handleAccept}
          />
        )}
      </View>
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
    padding: DD_SPACING.lg,
  },
  loadingCard: {
    alignItems: 'center',
    padding: DD_SPACING.xl,
  },
  loadingTitle: {
    marginTop: DD_SPACING.md,
    marginBottom: DD_SPACING.xs,
  },
  errorCard: {
    width: '100%',
    maxWidth: 380,
    alignItems: 'center',
  },
  errorIconContainer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255, 107, 53, 0.12)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: DD_SPACING.md,
  },
  errorTitle: {
    marginBottom: DD_SPACING.xs,
  },
  errorSubtitle: {
    marginBottom: DD_SPACING.lg,
    lineHeight: 20,
  },
  errorCta: {
    marginTop: DD_SPACING.xs,
  },
  navBar: {
    paddingHorizontal: DD_SPACING.md,
    paddingBottom: DD_SPACING.xs,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: DD_COLORS.bg,
    borderBottomWidth: 1,
    borderBottomColor: DD_COLORS.borderSubtle,
    zIndex: 10,
  },
  navHeaderTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  navIconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: DD_COLORS.bgElement,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    justifyContent: 'center',
    alignItems: 'center',
  },
  navRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingTop: DD_SPACING.md,
    paddingHorizontal: DD_SPACING.md,
  },
  inviteBanner: {
    marginBottom: DD_SPACING.md,
    gap: DD_SPACING.xs,
  },
  bannerHeadline: {
    letterSpacing: -0.8,
    marginTop: DD_SPACING.xs,
  },
  bannerSubtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    marginTop: DD_SPACING.xs,
  },
  bannerSubtitleText: {
    flex: 1,
    lineHeight: 20,
  },
  heroCard: {
    marginBottom: DD_SPACING.md,
    overflow: 'hidden',
    position: 'relative',
  },
  heroAccentBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 3,
  },
  heroBadgesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.xs,
    marginBottom: DD_SPACING.sm,
  },
  categoryPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 3,
    paddingHorizontal: DD_SPACING.sm,
    borderRadius: DD_RADII.pill,
    gap: 5,
  },
  categoryPillText: {
    fontWeight: '800',
    fontSize: 12,
  },
  typePill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 3,
    paddingHorizontal: DD_SPACING.sm,
    borderRadius: DD_RADII.pill,
    backgroundColor: DD_COLORS.bgElement,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    gap: 5,
  },
  typePillText: {
    fontWeight: '700',
    fontSize: 11,
  },
  challengeTitle: {
    marginBottom: DD_SPACING.xs,
    lineHeight: 30,
  },
  challengeDesc: {
    lineHeight: 22,
    marginBottom: DD_SPACING.md,
  },
  creatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    paddingTop: DD_SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: DD_COLORS.borderSubtle,
  },
  creatorMeta: {
    gap: 1,
  },
  statsGrid: {
    flexDirection: 'row',
    gap: DD_SPACING.sm,
    marginBottom: DD_SPACING.md,
  },
  statBox: {
    flex: 1,
    alignItems: 'center',
  },
  statIconBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
  },
  statValue: {
    marginBottom: 2,
  },
  statLabel: {
    fontSize: 11,
  },
  sectionCard: {
    marginBottom: DD_SPACING.md,
  },
  timelineHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: DD_SPACING.sm,
  },
  timelineHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.xs,
  },
  timelineTitle: {
    fontSize: 15,
  },
  progressPctText: {
    fontWeight: '800',
    fontSize: 15,
  },
  progressTrack: {
    height: 8,
    backgroundColor: DD_COLORS.bgElement,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: DD_SPACING.xs,
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
  },
  timelineFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  rulesHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.xs,
    marginBottom: DD_SPACING.md,
  },
  rulesTitle: {
    fontSize: 15,
  },
  ruleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    marginBottom: DD_SPACING.sm,
  },
  ruleNumberBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: DD_COLORS.bgElement,
    borderWidth: 1,
    borderColor: 'rgba(191, 253, 64, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  ruleContent: {
    flex: 1,
    lineHeight: 18,
    fontSize: 13,
  },
  shareCard: {
    marginBottom: DD_SPACING.lg,
  },
  shareCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    marginBottom: DD_SPACING.md,
  },
  shareCardMeta: {
    flex: 1,
    gap: 2,
  },
  shareCardBtn: {
    marginTop: DD_SPACING.xs,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(10, 10, 16, 0.94)',
    paddingHorizontal: DD_SPACING.md,
    paddingTop: DD_SPACING.xs,
    borderTopWidth: 1,
    borderTopColor: DD_COLORS.borderSubtle,
  },
});
