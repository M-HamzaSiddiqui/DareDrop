import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CategoryFilter, ChallengeCard } from '@/components/dd/challenge-card';
import { CATEGORY_COLORS, CategoryKey, DD } from '@/constants/dd-theme';
import { formatSubmittedAt } from '@/lib/reviews';
import { useChallenges } from '@/store/challenges-store';

export default function HomeScreen() {
  const {
    challenges,
    refreshing,
    refreshChallenges,
    isBackendConnected,
    pendingReviews,
    refreshPendingReviews,
    error,
    unreadNotificationsCount,
    refreshUnreadNotificationsCount,
  } = useChallenges();
  const insets = useSafeAreaInsets();
  const [selectedCategory, setSelectedCategory] = useState<CategoryKey | 'All'>('All');
  const [dismissNotice, setDismissNotice] = useState(false);

  // Keep pending reviews and unread notifications fresh when this screen comes into focus
  useFocusEffect(
    useCallback(() => {
      refreshPendingReviews().catch(() => {});
      refreshUnreadNotificationsCount().catch(() => {});
    }, [refreshPendingReviews, refreshUnreadNotificationsCount]),
  );

  const handleRefresh = useCallback(async () => {
    await Promise.all([
      refreshChallenges(),
      refreshPendingReviews(),
      refreshUnreadNotificationsCount(),
    ]);
  }, [refreshChallenges, refreshPendingReviews, refreshUnreadNotificationsCount]);

  const filtered = useMemo(() => {
    if (selectedCategory === 'All') return challenges;
    return challenges.filter((c) => c.category === selectedCategory);
  }, [challenges, selectedCategory]);

  const joinedCount = challenges.filter((c) => c.joined).length;

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ScrollView
        style={styles.scroll}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={DD.lime}
            colors={[DD.lime]}
          />
        }
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + DD.s5,
            paddingBottom: insets.bottom + 100,
          },
        ]}
        showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.tagline}>DARE DROP</Text>
            <Text style={styles.headline}>Make today{'\n'}legendary.</Text>
          </View>
          <View style={styles.headerRight}>
            <Pressable
              onPress={() => router.push('/notifications')}
              style={styles.bellButton}
              accessibilityRole="button"
              accessibilityLabel="Notifications">
              <Text style={styles.bellIcon}>🔔</Text>
              {unreadNotificationsCount > 0 && (
                <View style={styles.bellBadge}>
                  <Text style={styles.bellBadgeText}>
                    {unreadNotificationsCount > 99 ? '99+' : unreadNotificationsCount}
                  </Text>
                </View>
              )}
            </Pressable>
            <View style={styles.statsBadge}>
              <Text style={styles.statsBadgeNumber}>{joinedCount}</Text>
              <Text style={styles.statsBadgeLabel}>Active</Text>
            </View>
          </View>
        </View>

        {/* Backend status banner if running in local mode */}
        {!isBackendConnected && !dismissNotice && (
          <View style={styles.localBanner}>
            <View style={styles.localBannerLeft}>
              <Text style={styles.localBannerIcon}>📱</Text>
              <View style={styles.localBannerTexts}>
                <Text style={styles.localBannerTitle}>Local Storage Mode</Text>
                <Text style={styles.localBannerSubtitle}>
                  Add Supabase keys to .env to sync dares & invite friends across devices.
                </Text>
              </View>
            </View>
            <Pressable
              onPress={() => setDismissNotice(true)}
              style={styles.localBannerDismiss}
              accessibilityRole="button"
              accessibilityLabel="Dismiss notice">
              <Text style={styles.localBannerDismissText}>✕</Text>
            </Pressable>
          </View>
        )}

        {/* Backend connection / auth error banner */}
        {isBackendConnected && Boolean(error) && (
          <View style={styles.errorBanner}>
            <View style={styles.errorBannerLeft}>
              <Text style={styles.errorBannerIcon}>⚠️</Text>
              <View style={styles.errorBannerTexts}>
                <Text style={styles.errorBannerTitle}>Supabase Connection Issue</Text>
                <Text style={styles.errorBannerSubtitle}>{error}</Text>
              </View>
            </View>
            <Pressable
              onPress={handleRefresh}
              style={styles.errorBannerRetry}
              accessibilityRole="button"
              accessibilityLabel="Retry connecting to Supabase">
              <Text style={styles.errorBannerRetryText}>Retry</Text>
            </Pressable>
          </View>
        )}

        {/* Stats strip */}
        <View style={styles.statsStrip}>
          <StatItem value={String(challenges.length)} label="Challenges" color={DD.lime} />
          <View style={styles.divider} />
          <StatItem
            value={String(challenges.reduce((a, c) => a + c.participants, 0))}
            label="Participants"
            color={DD.purple}
          />
          <View style={styles.divider} />
          <StatItem value={String(joinedCount)} label="Joined" color={DD.catFun} />
        </View>

        {/* Pending Reviews Section for Verifier */}
        {pendingReviews.length > 0 && (
          <View style={styles.pendingSection}>
            <View style={styles.pendingSectionHeader}>
              <View style={styles.pendingTitleRow}>
                <Text style={styles.pendingSectionIcon}>📋</Text>
                <Text style={styles.pendingSectionTitle}>Pending Reviews</Text>
                <View style={styles.pendingBadge}>
                  <Text style={styles.pendingBadgeText}>{pendingReviews.length}</Text>
                </View>
              </View>
              <Text style={styles.pendingNoticeText}>Verification Needed</Text>
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
                  style={({ pressed }) => [
                    styles.pendingCard,
                    pressed && { opacity: 0.85, transform: [{ scale: 0.99 }] },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Review completion for ${item.challengeTitle}`}>
                  <View style={styles.pendingCardTop}>
                    <Text style={styles.pendingChallengeTitle} numberOfLines={1}>
                      {item.challengeTitle}
                    </Text>
                    <View style={styles.pendingStatusPill}>
                      <Text style={styles.pendingStatusText}>⏳ Verify</Text>
                    </View>
                  </View>

                  <Text style={styles.pendingChallengerText}>
                    Challenger: <Text style={styles.boldWhite}>{item.participantName}</Text>
                  </Text>

                  <View style={styles.pendingCardFooter}>
                    <Text style={styles.pendingTimestamp}>
                      📅 {item.completion.completion_date} • {formatSubmittedAt(item.completion.submitted_at)}
                    </Text>
                    <Text style={styles.openReviewAction}>Review Dare →</Text>
                  </View>

                  {item.completion.submission_note ? (
                    <Text style={styles.pendingNote} numberOfLines={1}>
                      &quot;{item.completion.submission_note}&quot;
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            </View>
          </View>
        )}

        {/* Section label */}
        <Text style={styles.sectionLabel}>🔥 Trending Challenges</Text>

        {/* Category filter */}
        <CategoryFilter selected={selectedCategory} onSelect={setSelectedCategory} />

        {/* Challenge cards */}
        {filtered.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>
              {selectedCategory !== 'All'
                ? CATEGORY_COLORS[selectedCategory as CategoryKey]
                  ? '🔍'
                  : '🔍'
                : '🔍'}
            </Text>
            <Text style={styles.emptyTitle}>No challenges here</Text>
            <Text style={styles.emptyText}>Try a different category or create your own!</Text>
          </View>
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
      </ScrollView>
    </View>
  );
}

function StatItem({
  value,
  label,
  color,
}: {
  value: string;
  label: string;
  color: string;
}) {
  return (
    <View style={styles.statItem}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: DD.bg,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: DD.s5,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: DD.s5,
  },
  tagline: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 3,
    color: DD.lime,
    marginBottom: DD.s2,
  },
  headline: {
    fontSize: 36,
    fontWeight: '900',
    color: DD.text,
    letterSpacing: -1.2,
    lineHeight: 40,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s2,
  },
  bellButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: DD.bgElement,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: DD.border,
    position: 'relative',
  },
  bellIcon: {
    fontSize: 18,
  },
  bellBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: DD.lime,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: DD.bg,
  },
  bellBadgeText: {
    color: DD.bg,
    fontSize: 10,
    fontWeight: '900',
  },
  statsBadge: {
    backgroundColor: DD.bgElement,
    borderRadius: DD.radiusCard,
    padding: DD.s4,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: DD.border,
    minWidth: 64,
  },
  statsBadgeNumber: {
    fontSize: 24,
    fontWeight: '900',
    color: DD.lime,
  },
  statsBadgeLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: DD.textSub,
    marginTop: 2,
  },
  statsStrip: {
    flexDirection: 'row',
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    borderWidth: 1,
    borderColor: DD.border,
    padding: DD.s5,
    marginBottom: DD.s6,
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  statItem: {
    alignItems: 'center',
    flex: 1,
  },
  statValue: {
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: -0.5,
  },
  statLabel: {
    fontSize: 11,
    color: DD.textSub,
    marginTop: 2,
    fontWeight: '600',
  },
  divider: {
    width: 1,
    height: 32,
    backgroundColor: DD.border,
  },
  sectionLabel: {
    fontSize: 18,
    fontWeight: '800',
    color: DD.text,
    letterSpacing: -0.3,
    marginBottom: DD.s1,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: DD.s10,
    gap: DD.s3,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: DD.text,
  },
  emptyText: {
    fontSize: 14,
    color: DD.textSub,
    textAlign: 'center',
  },
  localBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: DD.bgCard,
    borderWidth: 1,
    borderColor: DD.border,
    padding: DD.s3,
    borderRadius: DD.radiusMd,
    marginBottom: DD.s5,
  },
  localBannerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s3,
    flex: 1,
  },
  localBannerIcon: {
    fontSize: 20,
  },
  localBannerTexts: {
    flex: 1,
  },
  localBannerTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: DD.text,
  },
  localBannerSubtitle: {
    fontSize: 11,
    color: DD.textMuted,
    lineHeight: 15,
    marginTop: 2,
  },
  localBannerDismiss: {
    padding: DD.s2,
  },
  localBannerDismissText: {
    fontSize: 14,
    color: DD.textMuted,
    fontWeight: '800',
  },
  errorBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#FF446618',
    borderWidth: 1,
    borderColor: '#FF446655',
    padding: DD.s3,
    borderRadius: DD.radiusMd,
    marginBottom: DD.s5,
  },
  errorBannerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s3,
    flex: 1,
  },
  errorBannerIcon: {
    fontSize: 20,
  },
  errorBannerTexts: {
    flex: 1,
  },
  errorBannerTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#FF6B81',
  },
  errorBannerSubtitle: {
    fontSize: 11,
    color: DD.textSub,
    lineHeight: 15,
    marginTop: 2,
  },
  errorBannerRetry: {
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s2,
    backgroundColor: DD.bgCard,
    borderWidth: 1,
    borderColor: DD.border,
    borderRadius: DD.radiusSm,
    marginLeft: DD.s2,
  },
  errorBannerRetryText: {
    fontSize: 12,
    color: DD.text,
    fontWeight: '700',
  },
  pendingSection: {
    marginBottom: DD.s6,
    gap: DD.s3,
  },
  pendingSectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: DD.s1,
  },
  pendingTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s2,
  },
  pendingSectionIcon: {
    fontSize: 18,
  },
  pendingSectionTitle: {
    fontSize: 17,
    fontWeight: '900',
    color: DD.text,
    letterSpacing: -0.3,
  },
  pendingBadge: {
    backgroundColor: '#FFB80022',
    paddingHorizontal: DD.s2 + 2,
    paddingVertical: 2,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
    borderColor: '#FFB800',
  },
  pendingBadgeText: {
    color: '#FFB800',
    fontSize: 11,
    fontWeight: '900',
  },
  pendingNoticeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFB800',
    letterSpacing: 0.5,
  },
  pendingList: {
    gap: DD.s3,
  },
  pendingCard: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    padding: DD.s4,
    borderWidth: 1,
    borderColor: '#FFB80055',
    gap: DD.s2,
  },
  pendingCardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: DD.s2,
  },
  pendingChallengeTitle: {
    fontSize: 16,
    fontWeight: '800',
    color: DD.text,
    flex: 1,
  },
  pendingStatusPill: {
    backgroundColor: '#FFB80022',
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s1,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
    borderColor: '#FFB800',
  },
  pendingStatusText: {
    color: '#FFB800',
    fontSize: 11,
    fontWeight: '800',
  },
  pendingChallengerText: {
    fontSize: 13,
    color: DD.textSub,
  },
  boldWhite: {
    color: DD.text,
    fontWeight: '700',
  },
  pendingCardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: DD.s1,
  },
  pendingTimestamp: {
    fontSize: 11,
    color: DD.textMuted,
  },
  openReviewAction: {
    fontSize: 12,
    fontWeight: '800',
    color: DD.lime,
  },
  pendingNote: {
    fontSize: 12,
    color: DD.textSub,
    fontStyle: 'italic',
    backgroundColor: DD.bgElement,
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s2,
    borderRadius: DD.radiusSm,
  },
});
