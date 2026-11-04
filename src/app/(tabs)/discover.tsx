import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useMemo, useState } from 'react';
import {
  Keyboard,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CategoryFilter, ChallengeCard } from '@/components/dd/challenge-card';
import {
  CATEGORY_COLORS,
  CategoryKey,
  DD_COLORS,
  DD_RADII,
  DD_SPACING,
} from '@/constants/dd-theme';
import { Challenge, formatParticipants, timeRemaining } from '@/data/challenges';
import { DDBadge } from '@/components/ui/dd-badge';
import { DDButton } from '@/components/ui/dd-button';
import { DDCard } from '@/components/ui/dd-card';
import { DDIcon, type DDIconName } from '@/components/ui/dd-icon';
import { DDSkeleton } from '@/components/ui/dd-skeleton';
import { DDText } from '@/components/ui/dd-text';
import { useToast, sanitizeUserErrorMessage } from '@/components/ui/dd-toast';
import { useAuth } from '@/lib/auth-context';
import { useChallenges } from '@/store/challenges-store';

type TypeFilterOption = 'all' | 'daily' | 'one_time';

const CATEGORY_ICONS: Record<CategoryKey, DDIconName> = {
  Fitness: 'flame',
  Focus: 'target',
  Fun: 'sparkle',
  Learning: 'compass',
};

/**
 * DareDrop Redesigned Discover Screen.
 *
 * Implements:
 * - Dark-first DareDrop visual language with neon lime & electric violet accents.
 * - Live search with instant clear trigger and touch dismissal.
 * - Horizontal category filtering chips with signature tints and Phosphor icons.
 * - Challenge type quick-toggle (All, Daily Dares, One-Time).
 * - Community Spotlight hero section based on verified engagement.
 * - Streamlined challenge feed cards with creator info, progress, and 1-tap join action.
 * - Pull-to-refresh, skeleton wireframe loading, empty search states, and offline status.
 * - Floating tab bar clearance and accessible >=48dp touch targets.
 */
export default function DiscoverScreen() {
  const insets = useSafeAreaInsets();
  const {
    challenges,
    loading,
    refreshing,
    error,
    isBackendConnected,
    refreshChallenges,
    joinChallenge,
  } = useChallenges();

  const { isGuest, showAuthModal } = useAuth();
  const toast = useToast();

  // Search & Filter state
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<CategoryKey | 'All'>('All');
  const [selectedType, setSelectedType] = useState<TypeFilterOption>('all');
  const [joiningId, setJoiningId] = useState<string | null>(null);

  // Clear search and dismiss keyboard
  const handleClearSearch = useCallback(() => {
    setQuery('');
    Keyboard.dismiss();
  }, []);

  // Reset all filters
  const handleResetFilters = useCallback(() => {
    setQuery('');
    setSelectedCategory('All');
    setSelectedType('all');
    Keyboard.dismiss();
  }, []);

  // Execute challenge join request
  const executeJoin = useCallback(
    async (challenge: Challenge) => {
      if (joiningId) return;
      setJoiningId(challenge.id);

      try {
        const res = await joinChallenge(challenge.id);
        if (res.success) {
          toast.success(
            res.joined
              ? `You joined "${challenge.title}"!`
              : `You left "${challenge.title}".`,
          );
        } else {
          toast.error(
            sanitizeUserErrorMessage(
              res.error,
              'Failed to update challenge membership. Please try again.',
            ),
          );
        }
      } catch (err: any) {
        toast.error(
          sanitizeUserErrorMessage(
            err?.message,
            'An unexpected error occurred while updating membership.',
          ),
        );
      } finally {
        setJoiningId(null);
      }
    },
    [joiningId, joinChallenge, toast],
  );

  // Handle direct join action with guest modal check
  const handleJoin = useCallback(
    (challenge: Challenge) => {
      if (isGuest) {
        showAuthModal({
          title: 'Sign In to Join Dare',
          description: 'Create an account or sign in to join challenges, ignite daily streaks, and verify proofs with friends.',
          onSuccess: () => {
            void executeJoin(challenge);
          },
        });
        return;
      }
      void executeJoin(challenge);
    },
    [isGuest, showAuthModal, executeJoin],
  );

  // Filtered challenge feed
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return challenges.filter((c) => {
      // Category filter
      const matchesCat = selectedCategory === 'All' || c.category === selectedCategory;

      // Type filter
      const matchesType =
        selectedType === 'all' ||
        (selectedType === 'daily' && c.challengeType === 'daily') ||
        (selectedType === 'one_time' && c.challengeType === 'one_time');

      // Search query (title, description, creator)
      const matchesQuery =
        q === '' ||
        c.title.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        (c.creator && c.creator.toLowerCase().includes(q));

      return matchesCat && matchesType && matchesQuery;
    });
  }, [challenges, selectedCategory, selectedType, query]);

  // Community Spotlight challenge: Dare with highest participant count
  const spotlightChallenge = useMemo(() => {
    if (challenges.length === 0) return null;
    return [...challenges].sort((a, b) => b.participants - a.participants)[0];
  }, [challenges]);

  // Is user actively filtering or searching
  const isFiltering = query.trim() !== '' || selectedCategory !== 'All' || selectedType !== 'all';

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + DD_SPACING.lg,
            paddingBottom: insets.bottom + 110, // Full floating tab bar clearance
          },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refreshChallenges}
            tintColor={DD_COLORS.lime}
            colors={[DD_COLORS.lime]}
          />
        }>
        {/* ================================================================ */}
        {/* HEADER                                                           */}
        {/* ================================================================ */}
        <View style={styles.header}>
          <View style={styles.headerTitleRow}>
            <View style={styles.headerTextGroup}>
              <View style={styles.brandRow}>
                <DDIcon name="compass" size={16} color={DD_COLORS.lime} weight="fill" />
                <DDText variant="label" color="lime" style={styles.overlineText}>
                  EXPLORE COMMUNITY
                </DDText>
              </View>
              <DDText variant="h1" color="primary" style={styles.headline}>
                Discover Dares
              </DDText>
            </View>

            {/* Offline indicator badge */}
            {!isBackendConnected ? (
              <View style={styles.offlinePill}>
                <DDIcon name="globe" size={12} color={DD_COLORS.warning} weight="bold" />
                <DDText variant="caption" style={styles.offlineText}>
                  Offline Mode
                </DDText>
              </View>
            ) : null}
          </View>

          <DDText variant="bodySm" color="secondary" style={styles.subline}>
            Explore daily habits and milestone dares created by the DareDrop community.
          </DDText>
        </View>

        {/* ================================================================ */}
        {/* SEARCH BAR                                                       */}
        {/* ================================================================ */}
        <View style={styles.searchCard}>
          <View style={styles.searchIconContainer}>
            <DDIcon name="search" size={18} color={DD_COLORS.textMuted} weight="bold" />
          </View>
          <TextInput
            style={styles.searchInput}
            placeholder="Search by title, description or creator..."
            placeholderTextColor={DD_COLORS.textMuted}
            value={query}
            onChangeText={setQuery}
            returnKeyType="search"
            accessibilityLabel="Search challenges"
            accessibilityRole="search"
          />
          {query.length > 0 && (
            <Pressable
              onPress={handleClearSearch}
              hitSlop={12}
              style={styles.clearSearchButton}
              accessibilityRole="button"
              accessibilityLabel="Clear search">
              <DDIcon name="x-circle" size={18} color={DD_COLORS.textSub} weight="fill" />
            </Pressable>
          )}
        </View>

        {/* ================================================================ */}
        {/* CATEGORY FILTER CHIPS (Horizontal Scroll)                        */}
        {/* ================================================================ */}
        <View style={styles.categorySection}>
          <CategoryFilter
            horizontal
            selected={selectedCategory}
            onSelect={setSelectedCategory}
          />
        </View>

        {/* ================================================================ */}
        {/* TYPE FILTER PILLS (All, Daily, One-Time)                         */}
        {/* ================================================================ */}
        <View style={styles.typeFilterRow}>
          <Pressable
            onPress={() => setSelectedType('all')}
            style={[
              styles.typeChip,
              selectedType === 'all' && styles.typeChipActive,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Show all types">
            <DDText
              variant="caption"
              style={[
                styles.typeChipText,
                selectedType === 'all' && styles.typeChipTextActive,
              ]}>
              All Types
            </DDText>
          </Pressable>

          <Pressable
            onPress={() => setSelectedType('daily')}
            style={[
              styles.typeChip,
              selectedType === 'daily' && styles.typeChipActiveLime,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Show daily dares only">
            <DDIcon
              name="flame"
              size={12}
              color={selectedType === 'daily' ? DD_COLORS.lime : DD_COLORS.textMuted}
              weight="bold"
            />
            <DDText
              variant="caption"
              style={[
                styles.typeChipText,
                selectedType === 'daily' && styles.typeChipTextLime,
              ]}>
              Daily Dares
            </DDText>
          </Pressable>

          <Pressable
            onPress={() => setSelectedType('one_time')}
            style={[
              styles.typeChip,
              selectedType === 'one_time' && styles.typeChipActivePurple,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Show one-time dares only">
            <DDIcon
              name="target"
              size={12}
              color={selectedType === 'one_time' ? DD_COLORS.purple : DD_COLORS.textMuted}
              weight="bold"
            />
            <DDText
              variant="caption"
              style={[
                styles.typeChipText,
                selectedType === 'one_time' && styles.typeChipTextPurple,
              ]}>
              One-Time
            </DDText>
          </Pressable>
        </View>


        {/* ================================================================ */}
        {/* COMMUNITY SPOTLIGHT HERO (Shown when not actively searching)     */}
        {/* ================================================================ */}
        {!isFiltering && spotlightChallenge && (
          <View style={styles.spotlightSection}>
            <View style={styles.sectionHeaderRow}>
              <View style={styles.spotlightTitleRow}>
                <DDIcon name="lightning" size={14} color={DD_COLORS.lime} weight="fill" />
                <DDText variant="label" color="lime" style={styles.overlineText}>
                  COMMUNITY SPOTLIGHT
                </DDText>
              </View>
              <DDBadge variant="lime" label="Most Popular" />
            </View>

            <SpotlightCard
              challenge={spotlightChallenge}
              onPress={() =>
                router.push({
                  pathname: '/challenge/[id]',
                  params: { id: spotlightChallenge.id },
                })
              }
              onJoin={() => handleJoin(spotlightChallenge)}
              isJoining={joiningId === spotlightChallenge.id}
            />
          </View>
        )}

        {/* ================================================================ */}
        {/* CHALLENGE FEED HEADER                                            */}
        {/* ================================================================ */}
        <View style={styles.feedHeaderRow}>
          <DDText variant="label" color="muted" style={styles.overlineText}>
            {isFiltering
              ? `SEARCH RESULTS (${filtered.length})`
              : `ALL CHALLENGES (${filtered.length})`}
          </DDText>

          {isFiltering && (
            <Pressable
              onPress={handleResetFilters}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Reset all filters">
              <DDText variant="caption" color="lime" bold>
                Reset filters
              </DDText>
            </Pressable>
          )}
        </View>

        {/* ================================================================ */}
        {/* CHALLENGE FEED ITEMS / LOADING / EMPTY STATES                    */}
        {/* ================================================================ */}
        {loading && challenges.length === 0 ? (
          <View style={styles.skeletonContainer}>
            <DDSkeleton.Card />
            <DDSkeleton.Card />
            <DDSkeleton.Card />
          </View>
        ) : filtered.length === 0 ? (
          <View style={styles.emptyContainer}>
            <DDCard variant="element" padding="lg" style={styles.emptyCard}>
              <View style={styles.emptyIconCircle}>
                <DDIcon name="search" size={28} color={DD_COLORS.textMuted} weight="bold" />
              </View>

              <DDText variant="h3" color="primary" style={styles.emptyTitle}>
                {isFiltering ? 'No matching dares found' : 'No challenges available'}
              </DDText>

              <DDText variant="bodySm" color="secondary" style={styles.emptyDescription}>
                {isFiltering
                  ? `We couldn't find any challenges matching your current search or filters. Try adjusting your query.`
                  : 'Be the first pioneer in the community to create and publish a dare!'}
              </DDText>

              {isFiltering ? (
                <DDButton
                  variant="secondary"
                  title="Clear Search & Filters"
                  iconLeft="refresh"
                  onPress={handleResetFilters}
                  style={styles.emptyActionButton}
                />
              ) : (
                <DDButton
                  variant="primary"
                  title="Create a Dare"
                  iconLeft="plus"
                  onPress={() => router.push('/(tabs)/create')}
                  style={styles.emptyActionButton}
                />
              )}
            </DDCard>
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
              onJoin={() => handleJoin(challenge)}
              isJoining={joiningId === challenge.id}
            />
          ))
        )}

        {/* Backend error notification banner */}
        {error && (
          <View style={styles.errorBanner}>
            <DDIcon name="warning" size={16} color={DD_COLORS.danger} weight="bold" />
            <DDText variant="caption" color="danger" style={styles.errorBannerText}>
              {error}
            </DDText>
            <Pressable
              onPress={refreshChallenges}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Retry loading challenges">
              <DDText variant="caption" color="lime" bold>
                Retry
              </DDText>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * Spotlight Highlight Hero Card.
 * Gives prominent placement to the top community dare with custom visual glow.
 */
function SpotlightCard({
  challenge,
  onPress,
  onJoin,
  isJoining,
}: {
  challenge: Challenge;
  onPress: () => void;
  onJoin: () => void;
  isJoining: boolean;
}) {
  const catColor = CATEGORY_COLORS[challenge.category as CategoryKey] || DD_COLORS.lime;
  const catIcon = CATEGORY_ICONS[challenge.category as CategoryKey] || 'sparkle';
  const timeLeft = timeRemaining(challenge.endsAt);
  const isDaily = challenge.challengeType === 'daily';

  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: 'rgba(255, 255, 255, 0.08)' }}
      style={({ pressed }) => [
        spotlightStyles.card,
        pressed && spotlightStyles.cardPressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Spotlight challenge: ${challenge.title}`}>
      {/* Top Accent Glowing Bar */}
      <View style={[spotlightStyles.accentBar, { backgroundColor: catColor }]} />

      <View style={spotlightStyles.body}>
        {/* Category & Type Row */}
        <View style={spotlightStyles.headerRow}>
          <View style={[spotlightStyles.catChip, { backgroundColor: catColor + '20' }]}>
            <DDIcon name={catIcon} size={13} color={catColor} weight="fill" />
            <DDText variant="caption" style={[spotlightStyles.catText, { color: catColor }]}>
              {challenge.category}
            </DDText>
          </View>

          <View style={spotlightStyles.typeChip}>
            <DDIcon
              name={isDaily ? 'flame' : 'target'}
              size={12}
              color={isDaily ? DD_COLORS.lime : DD_COLORS.purple}
              weight="bold"
            />
            <DDText
              variant="caption"
              color={isDaily ? 'lime' : 'purple'}
              style={spotlightStyles.typeText}>
              {isDaily ? 'Daily Dare' : 'One-Time Milestone'}
            </DDText>
          </View>

          {challenge.joined && (
            <View style={spotlightStyles.joinedPill}>
              <DDIcon name="check-circle" size={12} color={DD_COLORS.success} weight="fill" />
              <DDText variant="caption" color="success" bold>
                Joined
              </DDText>
            </View>
          )}
        </View>

        {/* Title */}
        <DDText variant="h2" color="primary" numberOfLines={2} style={spotlightStyles.title}>
          {challenge.title}
        </DDText>

        {/* Creator Info */}
        {challenge.creator ? (
          <View style={spotlightStyles.creatorRow}>
            <DDIcon name="user" size={13} color={DD_COLORS.textMuted} weight="bold" />
            <DDText variant="caption" color="muted">
              Created by <DDText variant="caption" color="secondary" bold>{challenge.creator}</DDText>
            </DDText>
          </View>
        ) : null}

        {/* Description preview */}
        <DDText
          variant="bodySm"
          color="secondary"
          numberOfLines={2}
          style={spotlightStyles.description}>
          {challenge.description}
        </DDText>

        {/* Footer Metrics & Direct Join Action */}
        <View style={spotlightStyles.footer}>
          <View style={spotlightStyles.metricsGroup}>
            <View style={spotlightStyles.metric}>
              <DDIcon name="users" size={14} color={DD_COLORS.lime} weight="bold" />
              <DDText variant="caption" color="primary" bold>
                {formatParticipants(challenge.participants)}
              </DDText>
            </View>

            <View style={spotlightStyles.metric}>
              <DDIcon name="clock" size={14} color={DD_COLORS.textMuted} weight="bold" />
              <DDText variant="caption" color="secondary">
                {timeLeft}
              </DDText>
            </View>

            <View style={spotlightStyles.metric}>
              <DDIcon name="calendar" size={14} color={DD_COLORS.textMuted} weight="bold" />
              <DDText variant="caption" color="secondary">
                {challenge.durationDays}d
              </DDText>
            </View>
          </View>

          {/* Action button */}
          <Pressable
            onPress={(e) => {
              e.stopPropagation?.();
              onJoin();
            }}
            disabled={isJoining}
            android_ripple={{ color: 'rgba(0, 0, 0, 0.2)' }}
            style={[
              spotlightStyles.joinAction,
              challenge.joined && spotlightStyles.joinedAction,
              isJoining && spotlightStyles.joinActionBusy,
            ]}
            accessibilityRole="button"
            accessibilityLabel={challenge.joined ? 'Already joined challenge' : 'Join challenge'}>
            {isJoining ? (
              <DDText variant="caption" style={spotlightStyles.joinActionText} bold>
                ...
              </DDText>
            ) : challenge.joined ? (
              <>
                <DDIcon name="check" size={13} color={DD_COLORS.success} weight="bold" />
                <DDText variant="caption" color="success" bold>
                  Joined
                </DDText>
              </>
            ) : (
              <>
                <DDIcon name="plus" size={13} color={DD_COLORS.bg} weight="bold" />
                <DDText variant="caption" style={spotlightStyles.joinActionText} bold>
                  Join Dare
                </DDText>
              </>
            )}
          </Pressable>
        </View>
      </View>
    </Pressable>
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
  header: {
    marginBottom: DD_SPACING.lg,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: DD_SPACING.xs,
  },
  headerTextGroup: {
    flex: 1,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  headline: {
    fontSize: 30,
    fontWeight: '900',
    letterSpacing: -0.8,
  },
  subline: {
    marginTop: 2,
    lineHeight: 20,
  },
  offlinePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255, 179, 0, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255, 179, 0, 0.25)',
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 4,
    borderRadius: DD_RADII.pill,
    alignSelf: 'flex-start',
    marginTop: 4,
  },
  offlineText: {
    fontSize: 11,
    fontWeight: '700',
    color: DD_COLORS.warning,
  },
  searchCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.card,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    paddingHorizontal: DD_SPACING.md,
    minHeight: 48,
    marginBottom: DD_SPACING.md,
  },
  searchIconContainer: {
    marginRight: DD_SPACING.sm,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: DD_COLORS.text,
    paddingVertical: DD_SPACING.sm,
  },
  clearSearchButton: {
    padding: DD_SPACING.xs,
    marginLeft: DD_SPACING.xs,
  },
  categorySection: {
    marginBottom: DD_SPACING.sm,
  },
  typeFilterRow: {
    flexDirection: 'row',
    gap: DD_SPACING.sm,
    marginBottom: DD_SPACING.lg,
  },
  typeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: DD_SPACING.md,
    paddingVertical: 6,
    borderRadius: DD_RADII.pill,
    backgroundColor: DD_COLORS.bgElement,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    minHeight: 32,
  },
  typeChipActive: {
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
    borderColor: DD_COLORS.borderProminent,
  },
  typeChipActiveLime: {
    backgroundColor: 'rgba(191, 253, 64, 0.12)',
    borderColor: DD_COLORS.lime,
  },
  typeChipActivePurple: {
    backgroundColor: 'rgba(187, 134, 252, 0.12)',
    borderColor: DD_COLORS.purple,
  },
  typeChipText: {
    fontSize: 11,
    fontWeight: '600',
    color: DD_COLORS.textSub,
  },
  typeChipTextActive: {
    color: DD_COLORS.text,
    fontWeight: '800',
  },
  typeChipTextLime: {
    color: DD_COLORS.lime,
    fontWeight: '800',
  },
  typeChipTextPurple: {
    color: DD_COLORS.purple,
    fontWeight: '800',
  },
  overlineText: {
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  spotlightSection: {
    marginBottom: DD_SPACING.xl,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: DD_SPACING.sm,
  },
  spotlightTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  feedHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: DD_SPACING.sm,
  },
  skeletonContainer: {
    gap: DD_SPACING.sm,
  },
  emptyContainer: {
    paddingVertical: DD_SPACING.md,
  },
  emptyCard: {
    alignItems: 'center',
    textAlign: 'center',
  },
  emptyIconCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: DD_SPACING.md,
  },
  emptyTitle: {
    textAlign: 'center',
    marginBottom: DD_SPACING.xs,
  },
  emptyDescription: {
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: DD_SPACING.lg,
  },
  emptyActionButton: {
    minWidth: 200,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    backgroundColor: 'rgba(255, 82, 82, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 82, 82, 0.25)',
    padding: DD_SPACING.md,
    borderRadius: DD_RADII.card,
    marginTop: DD_SPACING.md,
  },
  errorBannerText: {
    flex: 1,
    fontSize: 12,
  },
});

const spotlightStyles = StyleSheet.create({
  card: {
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.card,
    borderWidth: 1.5,
    borderColor: 'rgba(191, 253, 64, 0.25)',
    overflow: 'hidden',
    shadowColor: DD_COLORS.lime,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 10,
    elevation: 4,
  },
  cardPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.99 }],
  },
  accentBar: {
    height: 4,
    width: '100%',
  },
  body: {
    padding: DD_SPACING.lg,
    gap: DD_SPACING.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    flexWrap: 'wrap',
  },
  catChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    borderRadius: DD_RADII.pill,
  },
  catText: {
    fontSize: 11,
    fontWeight: '700',
  },
  typeChip: {
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
  typeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  joinedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    borderRadius: DD_RADII.pill,
    backgroundColor: 'rgba(0, 230, 118, 0.12)',
    marginLeft: 'auto',
  },
  title: {
    marginTop: 2,
    fontSize: 20,
    fontWeight: '800',
  },
  creatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: -2,
  },
  description: {
    lineHeight: 19,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: DD_SPACING.sm,
    paddingTop: DD_SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.05)',
  },
  metricsGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.md,
  },
  metric: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  joinAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: DD_COLORS.lime,
    paddingHorizontal: DD_SPACING.md,
    paddingVertical: 7,
    borderRadius: DD_RADII.pill,
    minHeight: 34,
  },
  joinedAction: {
    backgroundColor: 'rgba(0, 230, 118, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0, 230, 118, 0.3)',
  },
  joinActionBusy: {
    opacity: 0.6,
  },
  joinActionText: {
    color: DD_COLORS.bg,
    fontWeight: '800',
    fontSize: 12,
  },
});
