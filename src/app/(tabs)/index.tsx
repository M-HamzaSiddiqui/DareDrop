import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CategoryFilter, ChallengeCard } from '@/components/dd/challenge-card';
import {
  CategoryKey,
  DD_COLORS,
  DD_RADII,
  DD_SPACING,
} from '@/constants/dd-theme';
import { DDAvatar } from '@/components/ui/dd-avatar';
import { DDBadge } from '@/components/ui/dd-badge';
import { DDButton } from '@/components/ui/dd-button';
import { DDCard } from '@/components/ui/dd-card';
import { DDIcon } from '@/components/ui/dd-icon';
import { DDSkeleton } from '@/components/ui/dd-skeleton';
import { DDText } from '@/components/ui/dd-text';
import { formatSubmittedAt, isResubmission } from '@/lib/reviews';
import { useAuth } from '@/lib/auth-context';
import { useChallenges } from '@/store/challenges-store';

/**
 * DareDrop Redesigned Home Dashboard.
 *
 * Implements:
 * - Personalized header with branding, user greeting, and notification badge
 * - Prominent Streak Hero Card displaying active streak and motivational encouragement
 * - Compact Quick Statistics strip (Active Dares, Total Available, Pending Verifications)
 * - Verifier Review Queue with clear challenger metadata and direct review actions
 * - User's Active Dares section for quick access to pledged challenges
 * - Interactive Category filter chips with instant feed sorting
 * - Clean loading skeletons, empty states, and dismissible offline notices
 * - 48dp+ touch targets, Android ripple feedback, and safe-area dock clearance
 */
export default function HomeScreen() {
  const {
    challenges,
    loading,
    refreshing,
    refreshChallenges,
    isBackendConnected,
    pendingReviews,
    refreshPendingReviews,
    error,
    unreadNotificationsCount,
    refreshUnreadNotificationsCount,
    fetchParticipantProgress,
  } = useChallenges();
  const { userDisplayName, isRegistered, isAnonymous } = useAuth();
  const insets = useSafeAreaInsets();

  const [selectedCategory, setSelectedCategory] = useState<CategoryKey | 'All'>('All');
  const [dismissNotice, setDismissNotice] = useState(false);
  const [activeStreak, setActiveStreak] = useState<number>(0);
  const [streakChallengeTitle, setStreakChallengeTitle] = useState<string>('');

  // Joined challenges
  const joinedChallenges = useMemo(
    () => challenges.filter((c) => c.joined),
    [challenges],
  );
  const joinedCount = joinedChallenges.length;

  // Compute active streak for joined daily challenges
  const loadStreakInfo = useCallback(async () => {
    if (joinedChallenges.length === 0) {
      setActiveStreak(0);
      setStreakChallengeTitle('');
      return;
    }

    try {
      // Find highest streak among active joined challenges
      let maxStreak = 0;
      let topTitle = '';

      for (const c of joinedChallenges) {
        if (c.challengeType === 'daily') {
          const progress = await fetchParticipantProgress(c.id);
          if (progress && typeof progress.current_streak === 'number') {
            if (progress.current_streak > maxStreak) {
              maxStreak = progress.current_streak;
              topTitle = c.title;
            }
          }
        }
      }

      setActiveStreak(maxStreak);
      setStreakChallengeTitle(topTitle || joinedChallenges[0]?.title || '');
    } catch {
      // Graceful fallback to 0 streak on error
      setActiveStreak(0);
    }
  }, [joinedChallenges, fetchParticipantProgress]);

  // Keep pending reviews, unread count, and streak fresh when focused
  useFocusEffect(
    useCallback(() => {
      refreshPendingReviews().catch(() => {});
      refreshUnreadNotificationsCount().catch(() => {});
      loadStreakInfo().catch(() => {});
    }, [refreshPendingReviews, refreshUnreadNotificationsCount, loadStreakInfo]),
  );

  const handleRefresh = useCallback(async () => {
    await Promise.all([
      refreshChallenges(),
      refreshPendingReviews(),
      refreshUnreadNotificationsCount(),
      loadStreakInfo(),
    ]);
  }, [refreshChallenges, refreshPendingReviews, refreshUnreadNotificationsCount, loadStreakInfo]);

  // Category filter
  const filtered = useMemo(() => {
    if (selectedCategory === 'All') return challenges;
    return challenges.filter((c) => c.category === selectedCategory);
  }, [challenges, selectedCategory]);

  // User greeting name
  const greetingName = useMemo(() => {
    if (userDisplayName && userDisplayName.trim()) {
      return userDisplayName.trim().split(' ')[0];
    }
    if (isRegistered) return 'Challenger';
    if (isAnonymous) return 'Hero';
    return 'Guest';
  }, [userDisplayName, isRegistered, isAnonymous]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ScrollView
        style={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={DD_COLORS.lime}
            colors={[DD_COLORS.lime]}
          />
        }
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + DD_SPACING.lg,
            paddingBottom: insets.bottom + 108, // Generous clearance above floating bottom dock
          },
        ]}
        showsVerticalScrollIndicator={false}>
        {/* A. Header Section */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <View style={styles.brandRow}>
              <View style={styles.flameIconWrapper}>
                <DDIcon name="flame" size={16} color={DD_COLORS.lime} weight="fill" />
              </View>
              <DDText variant="caption" color="lime" bold style={styles.tagline}>
                DARE DROP
              </DDText>
            </View>
            <DDText variant="display" color="primary" style={styles.greetingTitle}>
              Hey, {greetingName}
            </DDText>
            <DDText variant="bodySm" color="secondary" style={styles.greetingSubtitle}>
              Make today legendary.
            </DDText>
          </View>

          <View style={styles.headerRight}>
            {/* Notification Bell Shortcut */}
            <Pressable
              onPress={() => router.push('/notifications')}
              android_ripple={{ color: 'rgba(255, 255, 255, 0.1)', borderless: true, radius: 24 }}
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel={`Notifications, ${unreadNotificationsCount} unread`}>
              <DDIcon
                name="bell"
                size={20}
                color={unreadNotificationsCount > 0 ? DD_COLORS.lime : DD_COLORS.textSub}
                weight={unreadNotificationsCount > 0 ? 'fill' : 'bold'}
              />
              {unreadNotificationsCount > 0 && (
                <View style={styles.bellBadge}>
                  <DDText variant="caption" color="inverse" style={styles.bellBadgeText}>
                    {unreadNotificationsCount > 99 ? '99+' : unreadNotificationsCount}
                  </DDText>
                </View>
              )}
            </Pressable>

            {/* Profile Avatar Shortcut */}
            <Pressable
              onPress={() => router.push('/profile')}
              android_ripple={{ color: 'rgba(255, 255, 255, 0.1)', borderless: true, radius: 24 }}
              style={styles.avatarButton}
              accessibilityRole="button"
              accessibilityLabel="View profile">
              <DDAvatar
                name={userDisplayName || 'Challenger'}
                size="sm"
                borderColor={DD_COLORS.borderProminent}
              />
            </Pressable>
          </View>
        </View>

        {/* Offline / Local mode notice banner */}
        {!isBackendConnected && !dismissNotice && (
          <View style={styles.noticeBanner}>
            <View style={styles.noticeIconWrapper}>
              <DDIcon name="info" size={18} color={DD_COLORS.info} weight="bold" />
            </View>
            <View style={styles.noticeTexts}>
              <DDText variant="label" customColor={DD_COLORS.info} bold>
                Local Storage Mode
              </DDText>
              <DDText variant="caption" color="secondary">
                Configure Supabase to sync dares & invite friends across devices.
              </DDText>
            </View>
            <Pressable
              onPress={() => setDismissNotice(true)}
              hitSlop={12}
              style={styles.noticeDismiss}
              accessibilityRole="button"
              accessibilityLabel="Dismiss notice">
              <DDIcon name="x" size={16} color={DD_COLORS.textMuted} weight="bold" />
            </Pressable>
          </View>
        )}

        {/* Connection / Backend Error Banner */}
        {isBackendConnected && Boolean(error) && (
          <View style={styles.errorBanner}>
            <View style={styles.errorIconWrapper}>
              <DDIcon name="warning" size={18} color={DD_COLORS.warning} weight="bold" />
            </View>
            <View style={styles.errorTexts}>
              <DDText variant="label" color="warning" bold>
                Connection Interrupted
              </DDText>
              <DDText variant="caption" color="secondary" numberOfLines={2}>
                {error}
              </DDText>
            </View>
            <Pressable
              onPress={handleRefresh}
              style={styles.errorRetryButton}
              accessibilityRole="button"
              accessibilityLabel="Retry connection">
              <DDText variant="caption" color="warning" bold>
                Retry
              </DDText>
            </Pressable>
          </View>
        )}

        {/* B. Streak Hero Card */}
        <View style={styles.streakCardWrapper}>
          <View style={styles.streakGlow} />
          <DDCard variant="highlight" padding="none" style={styles.streakCard}>
            <View style={styles.streakInner}>
              <View style={styles.streakLeft}>
                <View style={styles.streakBadgePill}>
                  <DDIcon name="flame" size={18} color={DD_COLORS.lime} weight="fill" />
                  <DDText variant="caption" color="lime" bold style={styles.streakPillText}>
                    DAILY MOMENTUM
                  </DDText>
                </View>

                <View style={styles.streakCountRow}>
                  <DDText variant="display" color="primary" style={styles.streakNumber}>
                    {activeStreak}
                  </DDText>
                  <View style={styles.streakLabelCol}>
                    <DDText variant="h3" color="lime" style={styles.streakDaysLabel}>
                      {activeStreak === 1 ? 'DAY STREAK' : 'DAYS STREAK'}
                    </DDText>
                    <DDText variant="caption" color="secondary">
                      {activeStreak > 0
                        ? 'Unstoppable consistency'
                        : joinedCount > 0
                          ? 'Complete today’s dare'
                          : 'Ignite your first streak'}
                    </DDText>
                  </View>
                </View>

                <DDText variant="bodySm" color="secondary" style={styles.streakMotivation}>
                  {activeStreak > 0
                    ? `You're on fire! Keep crushing "${streakChallengeTitle}" today.`
                    : joinedCount > 0
                      ? `You have ${joinedCount} active dare${joinedCount > 1 ? 's' : ''}. Submit proof to level up your streak!`
                      : 'Take on a challenge from below and submit your first proof to ignite your flame.'}
                </DDText>
              </View>

              <View style={styles.streakRight}>
                <View style={styles.flameArtCircle}>
                  <DDIcon
                    name="flame"
                    size={46}
                    color={activeStreak > 0 ? DD_COLORS.lime : DD_COLORS.textMuted}
                    weight="fill"
                  />
                </View>
              </View>
            </View>
          </DDCard>
        </View>

        {/* C. Quick Statistics Strip */}
        <View style={styles.statsStrip}>
          {/* 1. Active Dares */}
          <DDCard variant="card" padding="sm" style={styles.statCard}>
            <View style={styles.statIconBadge}>
              <DDIcon name="target" size={16} color={DD_COLORS.lime} weight="bold" />
            </View>
            <DDText variant="h2" color="primary" style={styles.statNumber}>
              {joinedCount}
            </DDText>
            <DDText variant="caption" color="secondary" style={styles.statLabel}>
              Active Dares
            </DDText>
          </DDCard>

          {/* 2. Total Challenges */}
          <DDCard variant="card" padding="sm" style={styles.statCard}>
            <View style={[styles.statIconBadge, { backgroundColor: 'rgba(155, 89, 255, 0.12)' }]}>
              <DDIcon name="compass" size={16} color={DD_COLORS.purple} weight="bold" />
            </View>
            <DDText variant="h2" color="primary" style={styles.statNumber}>
              {challenges.length}
            </DDText>
            <DDText variant="caption" color="secondary" style={styles.statLabel}>
              Available Dares
            </DDText>
          </DDCard>

          {/* 3. Pending Reviews */}
          <DDCard variant="card" padding="sm" style={styles.statCard}>
            <View
              style={[
                styles.statIconBadge,
                {
                  backgroundColor:
                    pendingReviews.length > 0
                      ? 'rgba(255, 107, 53, 0.15)'
                      : 'rgba(112, 112, 148, 0.12)',
                },
              ]}>
              <DDIcon
                name="verify"
                size={16}
                color={pendingReviews.length > 0 ? DD_COLORS.coral : DD_COLORS.textMuted}
                weight="bold"
              />
            </View>
            <DDText variant="h2" color="primary" style={styles.statNumber}>
              {pendingReviews.length}
            </DDText>
            <DDText variant="caption" color="secondary" style={styles.statLabel}>
              Reviews Due
            </DDText>
          </DDCard>
        </View>

        {/* D. Pending Verifier Reviews Section */}
        {pendingReviews.length > 0 && (
          <View style={styles.sectionContainer}>
            <View style={styles.sectionHeaderRow}>
              <View style={styles.sectionTitleGroup}>
                <DDIcon name="verify" size={20} color={DD_COLORS.coral} weight="fill" />
                <DDText variant="h3" color="primary" style={styles.sectionTitle}>
                  Pending Verifications
                </DDText>
                <DDBadge
                  label={String(pendingReviews.length)}
                  variant="coral"
                  size="sm"
                  style={styles.sectionCounterBadge}
                />
              </View>
              <DDText variant="caption" color="secondary">
                Action Required
              </DDText>
            </View>

            <View style={styles.pendingList}>
              {pendingReviews.map((item) => (
                <Pressable
                  key={item.completion.id}
                  onPress={() =>
                    router.push({
                      pathname: '/review/[id]',
                      params: { id: item.completion.id },
                    })
                  }
                  android_ripple={{ color: 'rgba(255, 107, 53, 0.1)' }}
                  style={({ pressed }) => [
                    styles.pendingCardPressable,
                    pressed && styles.cardPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Review completion for ${item.challengeTitle}`}>
                  <DDCard variant="card" padding="md" style={styles.pendingCardBody}>
                    <View style={styles.pendingCardTop}>
                      <View style={styles.pendingUserRow}>
                        <DDAvatar name={item.participantName} size="sm" />
                        <View style={styles.pendingUserMeta}>
                          <DDText variant="label" color="primary" bold numberOfLines={1}>
                            {item.participantName}
                          </DDText>
                          <DDText variant="caption" color="muted">
                            Submitted proof
                          </DDText>
                        </View>
                      </View>

                      <View style={styles.pendingBadgeRow}>
                        {isResubmission(item.completion) && (
                          <DDBadge
                            label="Resubmission"
                            variant="coral"
                            size="sm"
                            icon="refresh"
                          />
                        )}
                        <DDBadge
                          label="Verify Dare"
                          variant="warning"
                          size="sm"
                          icon="verify"
                        />
                      </View>
                    </View>

                    <DDText variant="h3" color="primary" numberOfLines={1} style={styles.pendingChallengeTitle}>
                      {item.challengeTitle}
                    </DDText>

                    {item.completion.submission_note ? (
                      <View style={styles.pendingNoteContainer}>
                        <DDText variant="caption" color="secondary" numberOfLines={2} style={styles.pendingNoteText}>
                          &quot;{item.completion.submission_note}&quot;
                        </DDText>
                      </View>
                    ) : null}

                    {isResubmission(item.completion) && item.completion.last_rejection_reason ? (
                      <View style={styles.pendingResubmitNoteContainer}>
                        <DDText variant="caption" color="coral" numberOfLines={2}>
                          Previous feedback: &quot;{item.completion.last_rejection_reason}&quot;
                        </DDText>
                      </View>
                    ) : null}

                    <View style={styles.pendingCardFooter}>
                      <View style={styles.pendingTimeRow}>
                        <DDIcon name="clock" size={13} color={DD_COLORS.textMuted} weight="bold" />
                        <DDText variant="caption" color="muted">
                          {formatSubmittedAt(item.completion.submitted_at)}
                        </DDText>
                      </View>

                      <View style={styles.pendingActionCTA}>
                        <DDText variant="caption" color="coral" bold>
                          Review Now
                        </DDText>
                        <DDIcon name="arrow-right" size={13} color={DD_COLORS.coral} weight="bold" />
                      </View>
                    </View>
                  </DDCard>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* E. My Active Dares (if user has joined any) */}
        {joinedChallenges.length > 0 && (
          <View style={styles.sectionContainer}>
            <View style={styles.sectionHeaderRow}>
              <View style={styles.sectionTitleGroup}>
                <DDIcon name="target" size={20} color={DD_COLORS.lime} weight="fill" />
                <DDText variant="h3" color="primary" style={styles.sectionTitle}>
                  My Active Dares
                </DDText>
                <DDBadge
                  label={String(joinedCount)}
                  variant="lime"
                  size="sm"
                  style={styles.sectionCounterBadge}
                />
              </View>
            </View>

            <View style={styles.activeChallengesList}>
              {joinedChallenges.slice(0, 3).map((challenge) => (
                <ChallengeCard
                  key={`active_${challenge.id}`}
                  challenge={challenge}
                  onPress={() =>
                    router.push({
                      pathname: '/challenge/[id]',
                      params: { id: challenge.id },
                    })
                  }
                />
              ))}
            </View>
          </View>
        )}

        {/* F. Categories & User Dares */}
        <View style={styles.sectionContainer}>
          <View style={styles.sectionHeaderRow}>
            <View style={styles.sectionTitleGroup}>
              <DDIcon name="flame" size={20} color={DD_COLORS.lime} weight="fill" />
              <DDText variant="h3" color="primary" style={styles.sectionTitle}>
                Your Dares
              </DDText>
            </View>

            <Pressable
              onPress={() => router.push('/create')}
              hitSlop={8}
              style={styles.browseAllButton}
              accessibilityRole="button"
              accessibilityLabel="Create a new dare">
              <DDText variant="caption" color="lime" bold>
                + New Dare
              </DDText>
            </Pressable>
          </View>

          {/* Interactive Category Filter Chips */}
          <CategoryFilter selected={selectedCategory} onSelect={setSelectedCategory} />

          {/* Challenge Feed Cards / Loading / Empty States */}
          {loading && challenges.length === 0 ? (
            <View style={styles.skeletonList}>
              <DDSkeleton.Card />
              <DDSkeleton.Card />
            </View>
          ) : filtered.length === 0 ? (
            <DDCard variant="element" padding="lg" style={styles.emptyCard}>
              <View style={styles.emptyIconCircle}>
                <DDIcon name="search" size={26} color={DD_COLORS.textMuted} weight="bold" />
              </View>
              <DDText variant="h3" color="primary" align="center" style={styles.emptyTitle}>
                No challenges found
              </DDText>
              <DDText variant="bodySm" color="secondary" align="center" style={styles.emptyDescription}>
                {selectedCategory !== 'All'
                  ? `There are currently no challenges in the ${selectedCategory} category.`
                  : 'No challenges are currently active. Be the first to start a dare!'}
              </DDText>

              <View style={styles.emptyActionsRow}>
                {selectedCategory !== 'All' && (
                  <DDButton
                    title="Clear Filter"
                    variant="secondary"
                    size="sm"
                    onPress={() => setSelectedCategory('All')}
                  />
                )}
                <DDButton
                  title="Create a Dare"
                  variant="primary"
                  size="sm"
                  iconLeft="plus"
                  onPress={() => router.push('/create')}
                />
              </View>
            </DDCard>
          ) : (
            filtered.map((challenge) => (
              <ChallengeCard
                key={challenge.id}
                challenge={challenge}
                onPress={() =>
                  router.push({
                    pathname: '/challenge/[id]',
                    params: { id: challenge.id },
                  })
                }
              />
            ))
          )}
        </View>
      </ScrollView>
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
  },

  /* Header */
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: DD_SPACING.xl,
  },
  headerLeft: {
    flex: 1,
    paddingRight: DD_SPACING.md,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: DD_SPACING.xs,
  },
  flameIconWrapper: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(191, 253, 64, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagline: {
    fontSize: 11,
    letterSpacing: 2.5,
  },
  greetingTitle: {
    letterSpacing: -1,
    lineHeight: 38,
  },
  greetingSubtitle: {
    marginTop: 2,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    paddingTop: 4,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: DD_COLORS.bgElement,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    position: 'relative',
  },
  bellBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    backgroundColor: DD_COLORS.lime,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: DD_COLORS.bg,
  },
  bellBadgeText: {
    fontSize: 9,
    fontWeight: '900',
    lineHeight: 11,
  },
  avatarButton: {
    padding: 2,
  },

  /* Banners */
  noticeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 212, 255, 0.08)',
    borderRadius: DD_RADII.md,
    borderWidth: 1,
    borderColor: 'rgba(0, 212, 255, 0.25)',
    padding: DD_SPACING.md,
    marginBottom: DD_SPACING.lg,
    gap: DD_SPACING.sm,
  },
  noticeIconWrapper: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 212, 255, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  noticeTexts: {
    flex: 1,
    gap: 2,
  },
  noticeDismiss: {
    padding: DD_SPACING.xs,
  },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 184, 0, 0.08)',
    borderRadius: DD_RADII.md,
    borderWidth: 1,
    borderColor: 'rgba(255, 184, 0, 0.25)',
    padding: DD_SPACING.md,
    marginBottom: DD_SPACING.lg,
    gap: DD_SPACING.sm,
  },
  errorIconWrapper: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 184, 0, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorTexts: {
    flex: 1,
    gap: 2,
  },
  errorRetryButton: {
    paddingHorizontal: DD_SPACING.md,
    paddingVertical: DD_SPACING.xs,
    borderRadius: DD_RADII.pill,
    backgroundColor: 'rgba(255, 184, 0, 0.15)',
  },

  /* Streak Hero Card */
  streakCardWrapper: {
    position: 'relative',
    marginBottom: DD_SPACING.xl,
  },
  streakGlow: {
    position: 'absolute',
    top: 0,
    left: 20,
    right: 20,
    bottom: 0,
    backgroundColor: 'rgba(191, 253, 64, 0.05)',
    borderRadius: DD_RADII.card,
  },
  streakCard: {
    backgroundColor: 'rgba(18, 18, 28, 0.96)',
    borderRadius: DD_RADII.card,
    borderWidth: 1.5,
    borderColor: 'rgba(191, 253, 64, 0.35)',
    overflow: 'hidden',
  },
  streakInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: DD_SPACING.xl,
  },
  streakLeft: {
    flex: 1,
    paddingRight: DD_SPACING.md,
  },
  streakBadgePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(191, 253, 64, 0.12)',
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    borderRadius: DD_RADII.pill,
    marginBottom: DD_SPACING.sm,
  },
  streakPillText: {
    fontSize: 10,
    letterSpacing: 1.2,
  },
  streakCountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    marginBottom: DD_SPACING.xs,
  },
  streakNumber: {
    fontSize: 44,
    lineHeight: 48,
    fontWeight: '900',
    color: DD_COLORS.lime,
  },
  streakLabelCol: {
    justifyContent: 'center',
  },
  streakDaysLabel: {
    fontSize: 16,
    letterSpacing: 0.5,
    lineHeight: 20,
  },
  streakMotivation: {
    lineHeight: 18,
    marginTop: 4,
  },
  streakRight: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  flameArtCircle: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: 'rgba(191, 253, 64, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(191, 253, 64, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* Stats Strip */
  statsStrip: {
    flexDirection: 'row',
    gap: DD_SPACING.sm,
    marginBottom: DD_SPACING.xl,
  },
  statCard: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: DD_SPACING.md,
    paddingHorizontal: DD_SPACING.xs,
    borderRadius: DD_RADII.lg,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
  },
  statIconBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(191, 253, 64, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  statNumber: {
    fontSize: 22,
    lineHeight: 26,
    fontWeight: '900',
  },
  statLabel: {
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 2,
  },

  /* Section Containers */
  sectionContainer: {
    marginBottom: DD_SPACING.xl,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: DD_SPACING.md,
  },
  sectionTitleGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
  },
  sectionTitle: {
    letterSpacing: -0.2,
  },
  sectionCounterBadge: {
    marginLeft: 2,
  },
  browseAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },

  /* Pending Reviews */
  pendingList: {
    gap: DD_SPACING.md,
  },
  pendingCardPressable: {
    borderRadius: DD_RADII.card,
  },
  cardPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.985 }],
  },
  pendingCardBody: {
    borderColor: 'rgba(255, 107, 53, 0.3)',
    borderWidth: 1.2,
  },
  pendingCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: DD_SPACING.sm,
  },
  pendingBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.xs,
  },
  pendingUserRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
  },
  pendingUserMeta: {
    justifyContent: 'center',
  },
  pendingChallengeTitle: {
    marginBottom: DD_SPACING.xs,
  },
  pendingNoteContainer: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    paddingHorizontal: DD_SPACING.md,
    paddingVertical: DD_SPACING.xs,
    borderRadius: DD_RADII.sm,
    borderLeftWidth: 2,
    borderLeftColor: DD_COLORS.coral,
    marginBottom: DD_SPACING.sm,
  },
  pendingNoteText: {
    fontStyle: 'italic',
  },
  pendingResubmitNoteContainer: {
    backgroundColor: 'rgba(255, 107, 53, 0.08)',
    paddingHorizontal: DD_SPACING.md,
    paddingVertical: DD_SPACING.xs,
    borderRadius: DD_RADII.sm,
    borderLeftWidth: 2,
    borderLeftColor: DD_COLORS.coral,
    marginBottom: DD_SPACING.sm,
  },
  pendingCardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: DD_SPACING.xs,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.04)',
  },
  pendingTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  pendingActionCTA: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },

  /* Active Challenges */
  activeChallengesList: {
    gap: DD_SPACING.sm,
  },

  /* Empty and Loading States */
  skeletonList: {
    gap: DD_SPACING.md,
  },
  emptyCard: {
    alignItems: 'center',
    paddingVertical: DD_SPACING['2xl'],
    gap: DD_SPACING.sm,
  },
  emptyIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: DD_COLORS.bgHighlight,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: DD_SPACING.xs,
  },
  emptyTitle: {
    marginTop: DD_SPACING.xs,
  },
  emptyDescription: {
    maxWidth: 280,
    lineHeight: 18,
    marginBottom: DD_SPACING.sm,
  },
  emptyActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
  },
});
