import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChallengeCard } from '@/components/dd/challenge-card';
import {
  CATEGORY_COLORS,
  CategoryKey,
  DD_COLORS,
  DD_RADII,
  DD_SPACING,
} from '@/constants/dd-theme';
import { DDAvatar } from '@/components/ui/dd-avatar';
import { DDBadge } from '@/components/ui/dd-badge';
import { DDButton } from '@/components/ui/dd-button';
import { DDCard } from '@/components/ui/dd-card';
import { DDIcon, type DDIconName } from '@/components/ui/dd-icon';
import { DDText } from '@/components/ui/dd-text';
import { useAuth } from '@/lib/auth-context';
import {
  fetchOrCreateUserProfile,
  fetchPendingFriendRequests,
  fetchUserFriends,
  shareFriendCode,
} from '@/lib/friends';
import {
  getNotificationPermissionStatus,
  isPushNotificationSupported,
  NotificationPermissionStatus,
  registerForPushNotificationsAsync,
} from '@/lib/notifications';
import { DbUserProfile } from '@/lib/supabase';
import { useChallenges } from '@/store/challenges-store';

const CATEGORY_ICONS: Record<CategoryKey, DDIconName> = {
  Fitness: 'flame',
  Focus: 'target',
  Fun: 'sparkle',
  Learning: 'compass',
};

/**
 * DareDrop Redesigned Profile & Social Hub Screen.
 *
 * Implements:
 * - Dark-first DareDrop visual language with neon lime & electric violet accents.
 * - Profile header with DDAvatar, tier status badge, and 1-tap friend code sharing.
 * - Verified statistics grid (joined, active streak, completed dares, connected friends).
 * - High-visibility pending verification review alert for peer proofs.
 * - Dedicated Social & Friends Hub entry card with live friend/request counts.
 * - Push notifications & Notification inbox integration.
 * - Category breakdown and challenge history feeds (active vs created).
 * - Full account session management with sign-out confirmation.
 * - Floating tab bar clearance and accessible >=48dp touch targets.
 */
export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const {
    challenges,
    pendingReviews,
    refreshPendingReviews,
    currentUserId,
    unreadNotificationsCount,
    refreshUnreadNotificationsCount,
    refreshChallenges,
    fetchParticipantProgress,
  } = useChallenges();

  const {
    isGuest,
    isAnonymous,
    isRegistered,
    userEmail,
    userDisplayName,
    avatarUrl,
    signOut,
  } = useAuth();

  // Social & profile states
  const [userProfile, setUserProfile] = useState<DbUserProfile | null>(null);
  const [friendsCount, setFriendsCount] = useState<number>(0);
  const [pendingRequestsCount, setPendingRequestsCount] = useState<number>(0);
  const [activeStreak, setActiveStreak] = useState<number>(0);
  const [completedCount, setCompletedCount] = useState<number>(0);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [copiedToast, setCopiedToast] = useState<string | null>(null);

  // Push notification states
  const [notifStatus, setNotifStatus] = useState<NotificationPermissionStatus | 'checking'>('checking');
  const [isRegisteringNotif, setIsRegisteringNotif] = useState(false);

  // Segmented dare selection tab: 'created' | 'joined'
  const [selectedDareTab, setSelectedDareTab] = useState<'created' | 'joined'>('created');

  // Joined and Created challenges
  const joined = useMemo(() => challenges.filter((c) => Boolean(c.joined)), [challenges]);
  const created = useMemo(() => {
    return challenges.filter((c) => Boolean(currentUserId != null && c.creatorId === currentUserId));
  }, [challenges, currentUserId]);

  // Category commitments
  const categoryCounts = useMemo(() => {
    return joined.reduce(
      (acc, c) => {
        acc[c.category as CategoryKey] = (acc[c.category as CategoryKey] || 0) + 1;
        return acc;
      },
      {} as Record<CategoryKey, number>,
    );
  }, [joined]);

  // Fetch verified participant progress and streak
  const loadStatsAndProgress = useCallback(async () => {
    if (joined.length === 0) {
      setActiveStreak(0);
      setCompletedCount(0);
      return;
    }

    try {
      let maxStreak = 0;
      let completedDares = 0;

      for (const c of joined) {
        try {
          const progress = await fetchParticipantProgress(c.id);
          if (progress) {
            if (typeof progress.current_streak === 'number' && progress.current_streak > maxStreak) {
              maxStreak = progress.current_streak;
            }
            if (progress.is_completed === true) {
              completedDares += 1;
            }
          }
        } catch {
          // Graceful fallback per challenge
        }
      }

      setActiveStreak(maxStreak);
      setCompletedCount(completedDares);
    } catch {
      setActiveStreak(0);
      setCompletedCount(0);
    }
  }, [joined, fetchParticipantProgress]);

  // Load friends and profile info
  const loadSocialData = useCallback(async () => {
    try {
      const [friends, requests, prof] = await Promise.all([
        fetchUserFriends().catch(() => []),
        fetchPendingFriendRequests().catch(() => ({ incoming: [], outgoing: [] })),
        fetchOrCreateUserProfile().catch(() => null),
      ]);

      setFriendsCount(friends.length);
      setPendingRequestsCount(requests.incoming.length);
      if (prof) setUserProfile(prof);
    } catch {
      // Graceful error state
    }
  }, []);

  // Check notification status
  const checkNotifications = useCallback(async () => {
    if (!isPushNotificationSupported()) {
      setNotifStatus('unsupported');
      return;
    }
    try {
      const s = await getNotificationPermissionStatus();
      setNotifStatus(s);
    } catch {
      setNotifStatus('undetermined');
    }
  }, []);

  // Refresh all profile data when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      refreshPendingReviews().catch(() => {});
      refreshUnreadNotificationsCount().catch(() => {});
      loadSocialData().catch(() => {});
      loadStatsAndProgress().catch(() => {});
      checkNotifications().catch(() => {});
    }, [
      refreshPendingReviews,
      refreshUnreadNotificationsCount,
      loadSocialData,
      loadStatsAndProgress,
      checkNotifications,
    ]),
  );

  // Pull-to-refresh
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        refreshChallenges().catch(() => {}),
        refreshPendingReviews().catch(() => {}),
        refreshUnreadNotificationsCount().catch(() => {}),
        loadSocialData().catch(() => {}),
        loadStatsAndProgress().catch(() => {}),
        checkNotifications().catch(() => {}),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, [
    refreshChallenges,
    refreshPendingReviews,
    refreshUnreadNotificationsCount,
    loadSocialData,
    loadStatsAndProgress,
    checkNotifications,
  ]);

  // Enable push notifications
  const handleEnableNotifications = async () => {
    setIsRegisteringNotif(true);
    try {
      await registerForPushNotificationsAsync(currentUserId);
      const status = await getNotificationPermissionStatus();
      setNotifStatus(status);
    } finally {
      setIsRegisteringNotif(false);
    }
  };

  // Share Friend Code
  const handleShareFriendCode = async () => {
    if (!userProfile?.friend_code) return;
    const name = userProfile.display_name || userDisplayName || undefined;
    const res = await shareFriendCode(userProfile.friend_code, name);
    if (res.method === 'clipboard') {
      setCopiedToast('Friend code copied to clipboard!');
      setTimeout(() => setCopiedToast(null), 3000);
    }
  };

  // Sign out confirmation
  const handleSignOut = () => {
    Alert.alert(
      'Log Out',
      'Are you sure you want to log out of DareDrop?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Log Out',
          style: 'destructive',
          onPress: async () => {
            try {
              await signOut();
            } catch (err: any) {
              Alert.alert('Error', err?.message || 'Failed to sign out.');
            }
          },
        },
      ],
    );
  };

  // Display metadata
  const effectiveDisplayName =
    userProfile?.display_name || userDisplayName || (isRegistered ? 'DareDrop Legend' : isAnonymous ? 'Guest Hero' : 'Guest Explorer');
  const effectiveSubtitle =
    isRegistered ? (userEmail || '@daredropper') : isAnonymous ? 'Guest Session (Local Device)' : 'Browsing as Guest';

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + DD_SPACING.lg,
            paddingBottom: insets.bottom + 110, // Full clearance above floating tab bar
          },
        ]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={DD_COLORS.lime}
            colors={[DD_COLORS.lime]}
          />
        }>
        {/* ================================================================ */}
        {/* PROFILE HEADER                                                   */}
        {/* ================================================================ */}
        <View style={styles.header}>
          <View style={styles.headerMain}>
            <DDAvatar
              size="lg"
              name={effectiveDisplayName}
              uri={avatarUrl}
              fallbackIcon={isRegistered ? 'trophy' : isAnonymous ? 'lightning' : 'user'}
              borderColor={isRegistered ? DD_COLORS.lime : DD_COLORS.purple}
              statusDot="active"
            />

            <View style={styles.headerInfo}>
              <View style={styles.nameRow}>
                <DDText variant="h2" color="primary" numberOfLines={1} style={styles.displayName}>
                  {effectiveDisplayName}
                </DDText>
              </View>

              <DDText variant="bodySm" color="secondary" numberOfLines={1} style={styles.subTitle}>
                {effectiveSubtitle}
              </DDText>

              {/* Tier/Status Badge */}
              <View style={styles.badgeRow}>
                {isRegistered ? (
                  <DDBadge variant="lime" label="Registered Legend" />
                ) : isAnonymous ? (
                  <DDBadge variant="purple" label="Guest Session" />
                ) : (
                  <DDBadge variant="neutral" label="Guest Explorer" />
                )}
              </View>
            </View>
          </View>

          {/* Top Notification Bell */}
          <Pressable
            onPress={() => router.push('/notifications')}
            style={styles.bellButton}
            accessibilityRole="button"
            accessibilityLabel="Notifications">
            <DDIcon name="bell" size={18} color={DD_COLORS.text} weight="bold" />
            {unreadNotificationsCount > 0 && (
              <View style={styles.bellBadge}>
                <DDText variant="caption" style={styles.bellBadgeText}>
                  {unreadNotificationsCount > 99 ? '99+' : String(unreadNotificationsCount)}
                </DDText>
              </View>
            )}
          </Pressable>
        </View>

        {/* ================================================================ */}
        {/* COPIED TOAST BANNER                                              */}
        {/* ================================================================ */}
        {copiedToast && (
          <View style={styles.toastBanner}>
            <DDIcon name="check-circle" size={16} color={DD_COLORS.success} weight="fill" />
            <DDText variant="bodySm" style={styles.toastBannerText}>
              {copiedToast}
            </DDText>
          </View>
        )}

        {/* ================================================================ */}
        {/* FRIEND CODE BAR (If available)                                   */}
        {/* ================================================================ */}
        {userProfile?.friend_code && (
          <DDCard variant="card" padding="md" style={styles.friendCodeCard}>
            <View style={styles.friendCodeLeft}>
              <DDText variant="label" color="muted" style={styles.codeLabel}>
                MY FRIEND CODE
              </DDText>
              <DDText variant="h3" color="lime" style={styles.codeValue}>
                {userProfile.friend_code}
              </DDText>
            </View>

            <Pressable
              onPress={handleShareFriendCode}
              android_ripple={{ color: 'rgba(255, 255, 255, 0.1)' }}
              style={styles.codeShareBtn}
              accessibilityRole="button"
              accessibilityLabel="Share friend code">
              <DDIcon name="share" size={14} color={DD_COLORS.lime} weight="bold" />
              <DDText variant="caption" color="lime" bold>
                Share
              </DDText>
            </Pressable>
          </DDCard>
        )}

        {/* ================================================================ */}
        {/* GUEST / ANONYMOUS ACCOUNT UPGRADE BANNER                         */}
        {/* ================================================================ */}
        {isAnonymous ? (
          <DDCard variant="highlight" padding="md" style={styles.upgradeCard}>
            <View style={styles.upgradeContent}>
              <View style={styles.upgradeIconWrap}>
                <DDIcon name="lightning" size={20} color={DD_COLORS.lime} weight="fill" />
              </View>
              <View style={styles.upgradeTextGroup}>
                <DDText variant="title" color="primary" bold>
                  Save Your Streaks & Dares
                </DDText>
                <DDText variant="bodySm" color="secondary" style={styles.upgradeSub}>
                  Upgrade to a permanent email or Google account to keep your streaks, dares, and verifications safe forever.
                </DDText>
              </View>
            </View>
            <DDButton
              variant="primary"
              title="Upgrade Account"
              iconRight="arrow-right"
              onPress={() => router.push('/auth')}
              style={styles.upgradeButton}
            />
          </DDCard>
        ) : isGuest ? (
          <DDCard variant="element" padding="md" style={styles.upgradeCard}>
            <View style={styles.upgradeContent}>
              <View style={[styles.upgradeIconWrap, { backgroundColor: 'rgba(155, 89, 255, 0.15)' }]}>
                <DDIcon name="user" size={20} color={DD_COLORS.purple} weight="bold" />
              </View>
              <View style={styles.upgradeTextGroup}>
                <DDText variant="title" color="primary" bold>
                  Join the DareDrop Community
                </DDText>
                <DDText variant="bodySm" color="secondary" style={styles.upgradeSub}>
                  Sign in or register to join challenges, ignite daily streaks, and verify proofs with friends.
                </DDText>
              </View>
            </View>
            <DDButton
              variant="secondary"
              title="Sign In / Register"
              iconRight="arrow-right"
              onPress={() => router.push('/auth')}
              style={styles.upgradeButton}
            />
          </DDCard>
        ) : null}

        {/* ================================================================ */}
        {/* VERIFIED PROFILE STATISTICS (2x2 Grid)                           */}
        {/* ================================================================ */}
        <View style={styles.statsSection}>
          <View style={styles.statsGrid}>
            {/* Stat 1: Joined */}
            <View style={styles.statCard}>
              <View style={styles.statIconRow}>
                <DDIcon name="target" size={16} color={DD_COLORS.lime} weight="bold" />
                <DDText variant="caption" color="muted">
                  JOINED
                </DDText>
              </View>
              <DDText variant="display" color="lime" style={styles.statNumber}>
                {String(joined.length)}
              </DDText>
              <DDText variant="caption" color="secondary">
                Active Dares
              </DDText>
            </View>

            {/* Stat 2: Active Streak */}
            <View style={styles.statCard}>
              <View style={styles.statIconRow}>
                <DDIcon name="flame" size={16} color={DD_COLORS.coral} weight="fill" />
                <DDText variant="caption" color="muted">
                  STREAK
                </DDText>
              </View>
              <DDText
                variant="display"
                style={[styles.statNumber, { color: DD_COLORS.coral }]}>
                {String(activeStreak)}
              </DDText>
              <DDText variant="caption" color="secondary">
                Best Days Streak
              </DDText>
            </View>

            {/* Stat 3: Completed */}
            <View style={styles.statCard}>
              <View style={styles.statIconRow}>
                <DDIcon name="trophy" size={16} color={DD_COLORS.purple} weight="fill" />
                <DDText variant="caption" color="muted">
                  COMPLETED
                </DDText>
              </View>
              <DDText variant="display" color="purple" style={styles.statNumber}>
                {String(completedCount)}
              </DDText>
              <DDText variant="caption" color="secondary">
                Verified Finished
              </DDText>
            </View>

            {/* Stat 4: Friends */}
            <View style={styles.statCard}>
              <View style={styles.statIconRow}>
                <DDIcon name="users" size={16} color={DD_COLORS.info} weight="bold" />
                <DDText variant="caption" color="muted">
                  FRIENDS
                </DDText>
              </View>
              <DDText
                variant="display"
                style={[styles.statNumber, { color: DD_COLORS.info }]}>
                {String(friendsCount)}
              </DDText>
              <DDText variant="caption" color="secondary">
                Connected
              </DDText>
            </View>
          </View>
        </View>

        {/* ================================================================ */}
        {/* PENDING PEER REVIEWS ALERT CARD (If verifier has pending tasks)  */}
        {/* ================================================================ */}
        {pendingReviews.length > 0 && (
          <Pressable
            onPress={() => {
              if (pendingReviews[0]) {
                router.push({
                  pathname: '/review/[id]',
                  params: { id: pendingReviews[0].completion.id },
                });
              }
            }}
            android_ripple={{ color: 'rgba(255, 255, 255, 0.08)' }}
            style={({ pressed }) => [
              styles.reviewAlertCard,
              pressed && styles.cardPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Review pending peer verifications">
            <View style={styles.reviewAlertLeft}>
              <View style={styles.reviewAlertIconCircle}>
                <DDIcon name="shield-check" size={20} color={DD_COLORS.lime} weight="fill" />
              </View>
              <View style={styles.reviewAlertTextGroup}>
                <View style={styles.reviewAlertHeader}>
                  <DDText variant="title" color="primary" bold>
                    {pendingReviews.length} Dare{pendingReviews.length > 1 ? 's' : ''} Awaiting Review
                  </DDText>
                  <DDBadge variant="lime" label="Action Needed" />
                </View>
                <DDText variant="bodySm" color="secondary">
                  You are designated verifier. Confirm proof submissions to keep friend streaks alive.
                </DDText>
              </View>
            </View>

            <View style={styles.reviewAlertArrow}>
              <DDIcon name="arrow-right" size={16} color={DD_COLORS.lime} weight="bold" />
            </View>
          </Pressable>
        )}

        {/* ================================================================ */}
        {/* SOCIAL & FRIENDS HUB ENTRY                                       */}
        {/* ================================================================ */}
        <View style={styles.sectionHeader}>
          <DDText variant="label" color="muted" style={styles.sectionLabel}>
            SOCIAL & COMMUNITY
          </DDText>
        </View>

        <Pressable
          onPress={() => router.push('/friends')}
          android_ripple={{ color: 'rgba(255, 255, 255, 0.08)' }}
          style={({ pressed }) => [styles.hubCard, pressed && styles.cardPressed]}
          accessibilityRole="button"
          accessibilityLabel="Open Friends and Social Hub">
          <View style={styles.hubCardLeft}>
            <View style={[styles.hubIconCircle, { backgroundColor: 'rgba(155, 89, 255, 0.15)' }]}>
              <DDIcon name="handshake" size={20} color={DD_COLORS.purple} weight="fill" />
            </View>

            <View style={styles.hubTextGroup}>
              <View style={styles.hubTitleRow}>
                <DDText variant="title" color="primary" bold>
                  Friends & Social Hub
                </DDText>
                {pendingRequestsCount > 0 && (
                  <View style={styles.requestCountBadge}>
                    <DDText variant="caption" style={styles.requestCountText} bold>
                      {pendingRequestsCount > 99 ? '99+' : `${pendingRequestsCount} new`}
                    </DDText>
                  </View>
                )}
              </View>

              <DDText variant="bodySm" color="secondary">
                {friendsCount > 0
                  ? `${friendsCount} friend${friendsCount !== 1 ? 's' : ''} connected • Send dares & challenge friends`
                  : 'Add friends by code, accept requests & challenge buddies'}
              </DDText>
            </View>
          </View>

          <View style={styles.hubArrowWrap}>
            <DDIcon name="arrow-right" size={16} color={DD_COLORS.purple} weight="bold" />
          </View>
        </Pressable>

        {/* ================================================================ */}
        {/* NOTIFICATION INBOX CARD                                          */}
        {/* ================================================================ */}
        <Pressable
          onPress={() => router.push('/notifications')}
          android_ripple={{ color: 'rgba(255, 255, 255, 0.08)' }}
          style={({ pressed }) => [styles.hubCard, styles.notifHubCard, pressed && styles.cardPressed]}
          accessibilityRole="button"
          accessibilityLabel="Open Notification Inbox">
          <View style={styles.hubCardLeft}>
            <View style={[styles.hubIconCircle, { backgroundColor: 'rgba(191, 253, 64, 0.12)' }]}>
              <DDIcon name="bell" size={20} color={DD_COLORS.lime} weight="bold" />
            </View>

            <View style={styles.hubTextGroup}>
              <View style={styles.hubTitleRow}>
                <DDText variant="title" color="primary" bold>
                  Notification Inbox
                </DDText>
                {unreadNotificationsCount > 0 && (
                  <View style={styles.unreadBadge}>
                    <DDText variant="caption" style={styles.unreadBadgeText} bold>
                      {unreadNotificationsCount > 99 ? '99+' : `${unreadNotificationsCount} unread`}
                    </DDText>
                  </View>
                )}
              </View>

              <DDText variant="bodySm" color="secondary">
                {unreadNotificationsCount > 0
                  ? `${unreadNotificationsCount} unread alert${unreadNotificationsCount > 1 ? 's' : ''} • Review verifications & invites`
                  : 'View verifications, reviews & approval alerts'}
              </DDText>
            </View>
          </View>

          <View style={styles.hubArrowWrap}>
            <DDIcon name="arrow-right" size={16} color={DD_COLORS.lime} weight="bold" />
          </View>
        </Pressable>

        {/* ================================================================ */}
        {/* PUSH NOTIFICATIONS SETTING CARD                                  */}
        {/* ================================================================ */}
        <DDCard variant="element" padding="md" style={styles.notifCard}>
          <View style={styles.notifLeft}>
            <DDIcon name="bell" size={18} color={DD_COLORS.textMuted} weight="bold" />
            <View style={styles.notifTextGroup}>
              <DDText variant="title" color="primary" bold>
                Push Notifications
              </DDText>
              <DDText variant="bodySm" color="secondary" style={styles.notifDescription}>
                {notifStatus === 'granted'
                  ? 'Active — You will receive instant alerts when dares need review or are verified.'
                  : notifStatus === 'unsupported'
                    ? 'Requires Android Development Build or EAS standalone build.'
                    : 'Get live alerts when friends submit proofs or approve your dares.'}
              </DDText>
            </View>
          </View>

          {notifStatus === 'granted' ? (
            <View style={styles.notifActivePill}>
              <DDIcon name="check-circle" size={14} color={DD_COLORS.success} weight="fill" />
              <DDText variant="caption" color="success" bold>
                Active
              </DDText>
            </View>
          ) : notifStatus === 'unsupported' ? (
            <View style={styles.notifDevPill}>
              <DDText variant="caption" color="muted" bold>
                Dev Build
              </DDText>
            </View>
          ) : (
            <Pressable
              onPress={handleEnableNotifications}
              disabled={isRegisteringNotif}
              android_ripple={{ color: 'rgba(0, 0, 0, 0.2)' }}
              style={[styles.notifEnableBtn, isRegisteringNotif && styles.btnDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Enable push notifications">
              {isRegisteringNotif ? (
                <ActivityIndicator size="small" color={DD_COLORS.bg} />
              ) : (
                <DDText variant="caption" style={styles.notifEnableBtnText} bold>
                  Enable
                </DDText>
              )}
            </Pressable>
          )}
        </DDCard>

        {/* ================================================================ */}
        {/* MY CATEGORIES BREAKDOWN                                          */}
        {/* ================================================================ */}
        {joined.length > 0 && (
          <View style={styles.categoriesSection}>
            <View style={styles.sectionHeader}>
              <DDText variant="label" color="muted" style={styles.sectionLabel}>
                MY ACTIVE CATEGORIES
              </DDText>
            </View>

            <View style={styles.categoryGrid}>
              {Object.entries(categoryCounts).map(([cat, count]) => {
                const color = CATEGORY_COLORS[cat as CategoryKey] || DD_COLORS.lime;
                const icon = CATEGORY_ICONS[cat as CategoryKey] || 'sparkle';

                return (
                  <View
                    key={cat}
                    style={[styles.categoryCard, { borderColor: color + '40' }]}>
                    <View style={[styles.categoryIconWrap, { backgroundColor: color + '1E' }]}>
                      <DDIcon name={icon} size={16} color={color} weight="fill" />
                    </View>
                    <View style={styles.categoryInfo}>
                      <DDText variant="title" color="primary" bold>
                        {cat}
                      </DDText>
                      <DDText variant="caption" style={{ color }} bold>
                        {count} active dare{count > 1 ? 's' : ''}
                      </DDText>
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {/* ================================================================ */}
        {/* DARE SELECTION TABS (Created by You vs Joined by You)            */}
        {/* ================================================================ */}
        <View style={styles.challengesSection}>
          <View style={styles.sectionHeader}>
            <DDText variant="label" color="muted" style={styles.sectionLabel}>
              MY DARES
            </DDText>
          </View>

          {/* Segmented Pill Tabs */}
          <View style={styles.segmentedDock} accessibilityRole="tablist">
            <Pressable
              onPress={() => setSelectedDareTab('created')}
              android_ripple={{ color: 'rgba(191, 253, 64, 0.15)' }}
              style={({ pressed }) => [
                styles.segmentTab,
                selectedDareTab === 'created' && styles.segmentTabActive,
                pressed && styles.segmentTabPressed,
              ]}
              accessibilityRole="tab"
              accessibilityLabel={`Created by You, ${created.length} challenges`}
              accessibilityState={{ selected: selectedDareTab === 'created' }}>
              <DDIcon
                name="plus"
                size={16}
                color={selectedDareTab === 'created' ? DD_COLORS.textInverse : DD_COLORS.textMuted}
                weight="bold"
              />
              <DDText
                variant="buttonSm"
                color={selectedDareTab === 'created' ? 'inverse' : 'muted'}
                style={[styles.segmentLabel, selectedDareTab === 'created' && styles.segmentLabelActive]}>
                Created by You
              </DDText>
              <View style={[styles.segmentBadge, selectedDareTab === 'created' && styles.segmentBadgeActive]}>
                <DDText
                  variant="caption"
                  style={[styles.segmentBadgeText, selectedDareTab === 'created' && styles.segmentBadgeTextActive]}>
                  {String(created.length)}
                </DDText>
              </View>
            </Pressable>

            <Pressable
              onPress={() => setSelectedDareTab('joined')}
              android_ripple={{ color: 'rgba(191, 253, 64, 0.15)' }}
              style={({ pressed }) => [
                styles.segmentTab,
                selectedDareTab === 'joined' && styles.segmentTabActive,
                pressed && styles.segmentTabPressed,
              ]}
              accessibilityRole="tab"
              accessibilityLabel={`Joined by You, ${joined.length} challenges`}
              accessibilityState={{ selected: selectedDareTab === 'joined' }}>
              <DDIcon
                name="target"
                size={16}
                color={selectedDareTab === 'joined' ? DD_COLORS.textInverse : DD_COLORS.textMuted}
                weight="bold"
              />
              <DDText
                variant="buttonSm"
                color={selectedDareTab === 'joined' ? 'inverse' : 'muted'}
                style={[styles.segmentLabel, selectedDareTab === 'joined' && styles.segmentLabelActive]}>
                Joined by You
              </DDText>
              <View style={[styles.segmentBadge, selectedDareTab === 'joined' && styles.segmentBadgeActive]}>
                <DDText
                  variant="caption"
                  style={[styles.segmentBadgeText, selectedDareTab === 'joined' && styles.segmentBadgeTextActive]}>
                  {String(joined.length)}
                </DDText>
              </View>
            </Pressable>
          </View>

          {/* Dare List / Empty State */}
          {selectedDareTab === 'created' ? (
            created.length === 0 ? (
              <DDCard variant="element" padding="lg" style={styles.emptyCard}>
                <View style={styles.emptyIconCircle}>
                  <DDIcon name="plus" size={26} color={DD_COLORS.lime} weight="bold" />
                </View>
                <DDText variant="h3" color="primary" style={styles.emptyTitle}>
                  No created dares
                </DDText>
                <DDText variant="bodySm" color="secondary" style={styles.emptyDescription}>
                  You have not created any challenges yet. Spark a dare and challenge your friends to join!
                </DDText>
                <DDButton
                  variant="primary"
                  title="Create a Dare"
                  iconRight="arrow-right"
                  onPress={() => router.push('/(tabs)/create')}
                  style={styles.emptyButton}
                />
              </DDCard>
            ) : (
              created.map((c) => (
                <ChallengeCard
                  key={c.id}
                  challenge={c}
                  onPress={() =>
                    router.push({
                      pathname: '/challenge/[id]',
                      params: { id: c.id },
                    })
                  }
                />
              ))
            )
          ) : joined.length === 0 ? (
            <DDCard variant="element" padding="lg" style={styles.emptyCard}>
              <View style={styles.emptyIconCircle}>
                <DDIcon name="target" size={26} color={DD_COLORS.textMuted} weight="bold" />
              </View>
              <DDText variant="h3" color="primary" style={styles.emptyTitle}>
                No joined dares
              </DDText>
              <DDText variant="bodySm" color="secondary" style={styles.emptyDescription}>
                You have not joined any challenges yet. Browse Discover to take on your first dare!
              </DDText>
              <DDButton
                variant="primary"
                title="Discover Challenges"
                iconRight="arrow-right"
                onPress={() => router.push('/(tabs)/discover')}
                style={styles.emptyButton}
              />
            </DDCard>
          ) : (
            joined.map((c) => (
              <ChallengeCard
                key={c.id}
                challenge={c}
                onPress={() =>
                  router.push({
                    pathname: '/challenge/[id]',
                    params: { id: c.id },
                  })
                }
              />
            ))
          )}
        </View>

        {/* ================================================================ */}
        {/* ACCOUNT & SECURITY SESSION MANAGEMENT                            */}
        {/* ================================================================ */}
        <View style={styles.challengesSection}>
          <View style={styles.sectionHeader}>
            <DDText variant="label" color="muted" style={styles.sectionLabel}>
              ACCOUNT & SESSION
            </DDText>
          </View>

          <DDCard variant="element" padding="md" style={styles.accountCard}>
            {isRegistered ? (
              <View style={styles.accountRow}>
                <View style={styles.accountInfo}>
                  <DDText variant="title" color="primary" bold>
                    Full Registered Account
                  </DDText>
                  <DDText variant="bodySm" color="secondary">
                    {userEmail || 'Active authenticated user'}
                  </DDText>
                </View>

                <Pressable
                  onPress={handleSignOut}
                  android_ripple={{ color: 'rgba(255, 59, 86, 0.2)' }}
                  style={styles.signOutBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Log out of DareDrop">
                  <DDIcon name="sign-out" size={14} color={DD_COLORS.danger} weight="bold" />
                  <DDText variant="caption" color="danger" bold>
                    Log Out
                  </DDText>
                </Pressable>
              </View>
            ) : isAnonymous ? (
              <View style={styles.accountRow}>
                <View style={styles.accountInfo}>
                  <DDText variant="title" color="primary" bold>
                    Guest Session
                  </DDText>
                  <DDText variant="bodySm" color="secondary">
                    Upgrade to secure your progress permanently
                  </DDText>
                </View>

                <DDButton
                  variant="violet"
                  size="sm"
                  title="Upgrade"
                  onPress={() => router.push('/auth')}
                />
              </View>
            ) : (
              <View style={styles.accountRow}>
                <View style={styles.accountInfo}>
                  <DDText variant="title" color="primary" bold>
                    Guest Explorer
                  </DDText>
                  <DDText variant="bodySm" color="secondary">
                    Sign in to track progress and challenge friends
                  </DDText>
                </View>

                <DDButton
                  variant="primary"
                  size="sm"
                  title="Sign In"
                  onPress={() => router.push('/auth')}
                />
              </View>
            )}
          </DDCard>
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
    gap: DD_SPACING.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: DD_SPACING.xs,
  },
  headerMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.md,
    flex: 1,
  },
  headerInfo: {
    flex: 1,
    gap: 2,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  displayName: {
    fontSize: 22,
    fontWeight: '900',
    letterSpacing: -0.5,
  },
  subTitle: {
    fontSize: 13,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  bellButton: {
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
    color: DD_COLORS.bg,
    fontSize: 10,
    fontWeight: '900',
  },
  toastBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    backgroundColor: 'rgba(0, 230, 118, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0, 230, 118, 0.3)',
    paddingHorizontal: DD_SPACING.md,
    paddingVertical: DD_SPACING.sm,
    borderRadius: DD_RADII.card,
  },
  toastBannerText: {
    color: DD_COLORS.success,
    fontWeight: '600',
  },
  friendCodeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: DD_COLORS.bgCard,
    borderWidth: 1,
    borderColor: 'rgba(191, 253, 64, 0.25)',
  },
  friendCodeLeft: {
    gap: 2,
  },
  codeLabel: {
    letterSpacing: 1,
    fontSize: 10,
    textTransform: 'uppercase',
  },
  codeValue: {
    letterSpacing: 1.5,
    fontWeight: '900',
  },
  codeShareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(191, 253, 64, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(191, 253, 64, 0.3)',
    paddingHorizontal: DD_SPACING.md,
    paddingVertical: 8,
    borderRadius: DD_RADII.pill,
    minHeight: 36,
  },
  upgradeCard: {
    gap: DD_SPACING.md,
  },
  upgradeContent: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: DD_SPACING.md,
  },
  upgradeIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(191, 253, 64, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  upgradeTextGroup: {
    flex: 1,
    gap: 4,
  },
  upgradeSub: {
    lineHeight: 18,
  },
  upgradeButton: {
    alignSelf: 'stretch',
  },
  statsSection: {
    marginTop: DD_SPACING.xs,
  },
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: DD_SPACING.sm,
  },
  statCard: {
    flex: 1,
    minWidth: '47%',
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.card,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    padding: DD_SPACING.md,
    gap: 4,
  },
  statIconRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  statNumber: {
    fontSize: 26,
    fontWeight: '900',
    letterSpacing: -0.5,
  },
  reviewAlertCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.card,
    borderWidth: 1.5,
    borderColor: 'rgba(191, 253, 64, 0.3)',
    padding: DD_SPACING.md,
  },
  reviewAlertLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.md,
    flex: 1,
  },
  reviewAlertIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(191, 253, 64, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reviewAlertTextGroup: {
    flex: 1,
    gap: 2,
  },
  reviewAlertHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  reviewAlertArrow: {
    marginLeft: DD_SPACING.sm,
  },
  cardPressed: {
    opacity: 0.88,
    transform: [{ scale: 0.99 }],
  },
  sectionHeader: {
    marginTop: DD_SPACING.xs,
  },
  sectionLabel: {
    letterSpacing: 1.2,
    fontSize: 11,
    textTransform: 'uppercase',
  },
  hubCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.card,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    padding: DD_SPACING.md,
  },
  notifHubCard: {
    marginTop: -DD_SPACING.sm,
  },
  hubCardLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.md,
    flex: 1,
  },
  hubIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hubTextGroup: {
    flex: 1,
    gap: 3,
  },
  hubTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  requestCountBadge: {
    backgroundColor: 'rgba(255, 60, 172, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255, 60, 172, 0.4)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: DD_RADII.pill,
  },
  requestCountText: {
    color: DD_COLORS.catFun,
    fontSize: 10,
  },
  unreadBadge: {
    backgroundColor: 'rgba(191, 253, 64, 0.18)',
    borderWidth: 1,
    borderColor: 'rgba(191, 253, 64, 0.4)',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: DD_RADII.pill,
  },
  unreadBadgeText: {
    color: DD_COLORS.lime,
    fontSize: 10,
  },
  hubArrowWrap: {
    marginLeft: DD_SPACING.sm,
  },
  notifCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: DD_SPACING.md,
  },
  notifLeft: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: DD_SPACING.md,
    flex: 1,
  },
  notifTextGroup: {
    flex: 1,
    gap: 3,
  },
  notifDescription: {
    lineHeight: 18,
  },
  notifActivePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0, 230, 118, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0, 230, 118, 0.3)',
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 4,
    borderRadius: DD_RADII.pill,
  },
  notifDevPill: {
    backgroundColor: DD_COLORS.bgHighlight,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 4,
    borderRadius: DD_RADII.pill,
  },
  notifEnableBtn: {
    backgroundColor: DD_COLORS.lime,
    paddingHorizontal: DD_SPACING.md,
    paddingVertical: 7,
    borderRadius: DD_RADII.pill,
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: {
    opacity: 0.6,
  },
  notifEnableBtnText: {
    color: DD_COLORS.bg,
    fontSize: 12,
  },
  categoriesSection: {
    gap: DD_SPACING.sm,
  },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: DD_SPACING.sm,
  },
  categoryCard: {
    flex: 1,
    minWidth: '47%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.card,
    borderWidth: 1,
    padding: DD_SPACING.md,
  },
  categoryIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryInfo: {
    gap: 2,
  },
  challengesSection: {
    gap: DD_SPACING.sm,
  },
  segmentedDock: {
    flexDirection: 'row',
    backgroundColor: DD_COLORS.bgElement,
    borderRadius: DD_RADII.pill,
    padding: 4,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    marginBottom: DD_SPACING.xs,
  },
  segmentTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: DD_SPACING.sm,
    borderRadius: DD_RADII.pill,
    minHeight: 42,
  },
  segmentTabActive: {
    backgroundColor: DD_COLORS.lime,
  },
  segmentTabPressed: {
    opacity: 0.8,
  },
  segmentLabel: {
    fontWeight: '700',
  },
  segmentLabelActive: {
    fontWeight: '900',
  },
  segmentBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: DD_RADII.pill,
    minWidth: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentBadgeActive: {
    backgroundColor: 'rgba(10, 10, 16, 0.2)',
  },
  segmentBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: DD_COLORS.textMuted,
  },
  segmentBadgeTextActive: {
    color: DD_COLORS.textInverse,
  },
  emptyCard: {
    alignItems: 'center',
    textAlign: 'center',
  },
  emptyIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
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
    lineHeight: 19,
    marginBottom: DD_SPACING.lg,
  },
  emptyButton: {
    minWidth: 190,
  },
  accountCard: {
    backgroundColor: DD_COLORS.bgCard,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: DD_SPACING.md,
  },
  accountInfo: {
    flex: 1,
    gap: 2,
  },
  signOutBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255, 59, 86, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255, 59, 86, 0.3)',
    paddingHorizontal: DD_SPACING.md,
    paddingVertical: 7,
    borderRadius: DD_RADII.pill,
    minHeight: 34,
  },
});
