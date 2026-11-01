import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  DD_COLORS,
  DD_RADII,
  DD_SPACING,
} from '@/constants/dd-theme';
import { DDButton } from '@/components/ui/dd-button';
import { DDCard } from '@/components/ui/dd-card';
import { DDIcon, type DDIconName } from '@/components/ui/dd-icon';
import { DDSkeleton } from '@/components/ui/dd-skeleton';
import { DDText } from '@/components/ui/dd-text';
import { useAuth } from '@/lib/auth-context';
import {
  AppNotification,
  fetchUserNotifications,
  formatNotificationTimestamp,
  getNotificationRoute,
  markAllNotificationsAsRead,
  markNotificationAsRead,
} from '@/lib/inbox';
import { useChallenges } from '@/store/challenges-store';

interface EventBadgeConfig {
  icon: DDIconName;
  label: string;
  color: string;
}

/**
 * DareDrop Redesigned Notifications Screen.
 *
 * Implements:
 * - Dark-first DareDrop visual language with neon lime & electric violet accents.
 * - Calendar grouping: Today, Yesterday, and Earlier.
 * - Distinct event badges with Phosphor icons (reviews, friend requests, approvals, invites).
 * - Glowing unread indicator bar and 1-tap navigation to deep routes.
 * - Optimistic unread count management and "Mark all read" action.
 * - Empty inbox, guest explorer, and pull-to-refresh states.
 */
export default function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const { refreshUnreadNotificationsCount, decrementUnreadCount } = useChallenges();
  const { isGuest, showAuthModal } = useAuth();

  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState<boolean>(!isGuest);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const loadNotifications = useCallback(async (isRefresh = false) => {
    if (isGuest) {
      setNotifications([]);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const data = await fetchUserNotifications();
      setNotifications(data);
      refreshUnreadNotificationsCount().catch(() => {});
    } catch (err: any) {
      setError(err?.message || 'Failed to load notifications. Pull down to retry.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [isGuest, refreshUnreadNotificationsCount]);

  useEffect(() => {
    let isMounted = true;
    if (isGuest) {
      return;
    }

    fetchUserNotifications()
      .then((data) => {
        if (isMounted) {
          setNotifications(data);
          setLoading(false);
        }
      })
      .catch((err: any) => {
        if (isMounted) {
          setError(err?.message || 'Failed to load notifications. Pull down to retry.');
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isGuest]);

  const handleNotificationPress = async (item: AppNotification) => {
    if (!item.isRead) {
      // Optimistically update UI
      setNotifications((prev) =>
        prev.map((n) => (n.id === item.id ? { ...n, isRead: true, readAt: new Date().toISOString() } : n)),
      );
      decrementUnreadCount();

      // Persist read state to server and local storage
      markNotificationAsRead(item.id).catch(() => {});
    }

    const route = getNotificationRoute(item);
    if (route) {
      try {
        router.push(route as any);
      } catch (navErr) {
        console.warn('[DareDrop Notifications] Navigation error:', navErr);
      }
    }
  };

  const handleMarkAllRead = async () => {
    const unreadIds = notifications.filter((n) => !n.isRead).map((n) => n.id);
    if (unreadIds.length === 0) return;

    // Optimistically update all to read
    setNotifications((prev) =>
      prev.map((n) => ({ ...n, isRead: true, readAt: n.readAt || new Date().toISOString() })),
    );

    try {
      await markAllNotificationsAsRead(unreadIds);
      await refreshUnreadNotificationsCount();
    } catch (err) {
      console.warn('[DareDrop Notifications] Error marking all read:', err);
    }
  };

  const unreadCount = notifications.filter((n) => !n.isRead).length;

  const getEventBadge = (eventType: string): EventBadgeConfig => {
    switch (eventType) {
      case 'submission_pending':
        return { icon: 'shield-check', label: 'Review Request', color: DD_COLORS.coral };
      case 'dare_approved':
        return { icon: 'check-circle', label: 'Dare Approved', color: DD_COLORS.lime };
      case 'dare_rejected':
        return { icon: 'x-circle', label: 'Dare Rejected', color: DD_COLORS.danger };
      case 'verifier_reassigned':
        return { icon: 'refresh', label: 'Verifier Assigned', color: DD_COLORS.purple };
      case 'friend_request_received':
        return { icon: 'user-plus', label: 'Friend Request', color: DD_COLORS.catFun };
      case 'friend_request_accepted':
        return { icon: 'handshake', label: 'Friend Connected', color: DD_COLORS.lime };
      case 'challenge_invitation_received':
        return { icon: 'lightning', label: 'Dare Invitation', color: DD_COLORS.purple };
      default:
        return { icon: 'bell', label: 'Update', color: DD_COLORS.textSub };
    }
  };

  // Group notifications chronologically into Today, Yesterday, and Earlier
  const notificationGroups = useMemo(() => {
    if (notifications.length === 0) return [];

    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const yesterday = new Date(now.getTime() - 86400000);
    const yesterdayStr = yesterday.toISOString().split('T')[0];

    const todayItems: AppNotification[] = [];
    const yesterdayItems: AppNotification[] = [];
    const earlierItems: AppNotification[] = [];

    for (const notif of notifications) {
      const itemDateStr = notif.createdAt ? notif.createdAt.split('T')[0] : '';
      if (itemDateStr === todayStr) {
        todayItems.push(notif);
      } else if (itemDateStr === yesterdayStr) {
        yesterdayItems.push(notif);
      } else {
        earlierItems.push(notif);
      }
    }

    const groups: { title: string; data: AppNotification[] }[] = [];
    if (todayItems.length > 0) groups.push({ title: 'TODAY', data: todayItems });
    if (yesterdayItems.length > 0) groups.push({ title: 'YESTERDAY', data: yesterdayItems });
    if (earlierItems.length > 0) groups.push({ title: 'EARLIER', data: earlierItems });

    return groups;
  }, [notifications]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      {/* Navigation Header */}
      <View style={[styles.navBar, { paddingTop: insets.top + DD_SPACING.sm }]}>
        <Pressable
          onPress={() => {
            if (router.canGoBack()) {
              router.back();
            } else {
              router.replace('/');
            }
          }}
          hitSlop={12}
          style={({ pressed }) => [styles.backBtn, pressed && styles.btnPressed]}
          accessibilityRole="button"
          accessibilityLabel="Back">
          <DDIcon name="arrow-left" size={16} color={DD_COLORS.lime} weight="bold" />
          <DDText variant="caption" color="lime" bold>
            Back
          </DDText>
        </Pressable>

        <View style={styles.headerTitleGroup}>
          <DDText variant="h3" color="primary" bold>
            Notifications
          </DDText>
          {unreadCount > 0 && (
            <View style={styles.unreadPill}>
              <DDText variant="caption" color="lime" bold>
                {unreadCount > 99 ? '99+' : `${unreadCount} unread`}
              </DDText>
            </View>
          )}
        </View>

        {unreadCount > 0 ? (
          <Pressable
            onPress={handleMarkAllRead}
            hitSlop={8}
            style={({ pressed }) => [styles.markAllBtn, pressed && styles.btnPressed]}
            accessibilityRole="button"
            accessibilityLabel="Mark all as read">
            <DDText variant="caption" color="lime" bold>
              Mark all read
            </DDText>
          </Pressable>
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
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadNotifications(true)}
            tintColor={DD_COLORS.lime}
            colors={[DD_COLORS.lime]}
          />
        }>

        {/* Guest Explorer Prompt */}
        {isGuest ? (
          <DDCard variant="element" padding="lg" style={styles.guestCard}>
            <View style={styles.guestIconCircle}>
              <DDIcon name="lock" size={28} color={DD_COLORS.purple} weight="bold" />
            </View>
            <DDText variant="h3" color="primary" style={styles.guestTitle}>
              Sign in for notifications
            </DDText>
            <DDText variant="bodySm" color="secondary" style={styles.guestSubtitle}>
              Create an account or sign in to receive live alerts when friends challenge you, submit proof, or verify your dares.
            </DDText>
            <DDButton
              variant="primary"
              title="Sign In / Register"
              iconRight="arrow-right"
              onPress={() =>
                showAuthModal({
                  title: 'Sign In to View Notifications',
                  description: 'Create an account to track peer verifications and friend invites.',
                })
              }
              style={styles.guestBtn}
            />
          </DDCard>
        ) : loading && notifications.length === 0 ? (
          /* Loading Skeletons */
          <View style={styles.skeletonList}>
            <DDSkeleton.Card />
            <DDSkeleton.Card />
            <DDSkeleton.Card />
          </View>
        ) : error ? (
          /* Error State Banner */
          <DDCard variant="element" padding="lg" style={styles.errorCard}>
            <DDIcon name="warning" size={24} color={DD_COLORS.danger} weight="bold" />
            <DDText variant="bodySm" color="danger" style={styles.errorText}>
              {error}
            </DDText>
            <DDButton
              variant="secondary"
              title="Retry Loading"
              iconLeft="refresh"
              onPress={() => loadNotifications(false)}
            />
          </DDCard>
        ) : notifications.length === 0 ? (
          /* Empty State */
          <DDCard variant="element" padding="lg" style={styles.emptyCard}>
            <View style={styles.emptyIconCircle}>
              <DDIcon name="bell" size={28} color={DD_COLORS.textMuted} weight="bold" />
            </View>
            <DDText variant="h3" color="primary" style={styles.emptyTitle}>
              No notifications yet
            </DDText>
            <DDText variant="bodySm" color="secondary" style={styles.emptySubtitle}>
              You&apos;re all caught up! Peer verification requests, friend invites, and dare updates will appear here.
            </DDText>
          </DDCard>
        ) : (
          /* Grouped Notification Feed */
          notificationGroups.map((group) => (
            <View key={group.title} style={styles.groupSection}>
              <View style={styles.groupHeader}>
                <DDText variant="label" color="muted" style={styles.groupTitle}>
                  {group.title}
                </DDText>
              </View>

              {group.data.map((item) => {
                const badge = getEventBadge(item.eventType);
                const route = getNotificationRoute(item);
                const hasAction = Boolean(route);

                return (
                  <Pressable
                    key={item.id}
                    onPress={() => handleNotificationPress(item)}
                    android_ripple={{ color: 'rgba(255, 255, 255, 0.08)' }}
                    style={({ pressed }) => [
                      styles.itemCard,
                      !item.isRead && styles.itemCardUnread,
                      pressed && styles.itemCardPressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={item.title}>
                    {/* Glowing Left Unread Indicator */}
                    {!item.isRead && <View style={styles.unreadBar} />}

                    <View style={styles.itemHeader}>
                      <View style={[styles.badgePill, { borderColor: badge.color + '40', backgroundColor: badge.color + '18' }]}>
                        <DDIcon name={badge.icon} size={12} color={badge.color} weight="fill" />
                        <DDText variant="caption" style={{ color: badge.color }} bold>
                          {badge.label}
                        </DDText>
                      </View>

                      <DDText variant="caption" color="muted">
                        {formatNotificationTimestamp(item.createdAt)}
                      </DDText>
                    </View>

                    <DDText
                      variant="title"
                      color="primary"
                      bold={!item.isRead}
                      style={styles.itemTitle}>
                      {item.title}
                    </DDText>

                    {Boolean(item.body) && (
                      <DDText variant="bodySm" color="secondary" style={styles.itemBody}>
                        {item.body}
                      </DDText>
                    )}

                    {/* Rejection Note Callout */}
                    {Boolean(item.rejectionReason) && (
                      <View style={styles.rejectionBox}>
                        <DDText variant="caption" color="danger" bold>
                          Note from Verifier:
                        </DDText>
                        <DDText variant="bodySm" color="primary" style={styles.rejectionText}>
                          &ldquo;{item.rejectionReason}&rdquo;
                        </DDText>
                      </View>
                    )}

                    {/* Action Route Hint Footer */}
                    {hasAction && (
                      <View style={styles.actionFooter}>
                        <DDText variant="caption" color="lime" bold>
                          {item.eventType === 'submission_pending' || item.eventType === 'verifier_reassigned'
                            ? 'Review submission'
                            : item.eventType.startsWith('friend_')
                              ? 'View friends'
                              : 'View dare'}
                        </DDText>
                        <DDIcon name="arrow-right" size={12} color={DD_COLORS.lime} weight="bold" />
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </View>
          ))
        )}
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
  headerTitleGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
  },
  unreadPill: {
    backgroundColor: 'rgba(191, 253, 64, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(191, 253, 64, 0.3)',
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    borderRadius: DD_RADII.pill,
  },
  markAllBtn: {
    paddingVertical: DD_SPACING.xs,
    paddingLeft: DD_SPACING.sm,
  },
  guestCard: {
    alignItems: 'center',
    textAlign: 'center',
    marginTop: DD_SPACING.md,
  },
  guestIconCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(155, 89, 255, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: DD_SPACING.md,
  },
  guestTitle: {
    textAlign: 'center',
    marginBottom: DD_SPACING.xs,
  },
  guestSubtitle: {
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: DD_SPACING.lg,
  },
  guestBtn: {
    minWidth: 200,
  },
  skeletonList: {
    gap: DD_SPACING.sm,
    marginTop: DD_SPACING.xs,
  },
  errorCard: {
    alignItems: 'center',
    gap: DD_SPACING.sm,
    marginTop: DD_SPACING.md,
  },
  errorText: {
    textAlign: 'center',
  },
  emptyCard: {
    alignItems: 'center',
    textAlign: 'center',
    marginTop: DD_SPACING.md,
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
  emptySubtitle: {
    textAlign: 'center',
    lineHeight: 20,
  },
  groupSection: {
    gap: DD_SPACING.sm,
  },
  groupHeader: {
    marginTop: DD_SPACING.xs,
  },
  groupTitle: {
    letterSpacing: 1.2,
    fontSize: 11,
    textTransform: 'uppercase',
  },
  itemCard: {
    position: 'relative',
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.card,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    padding: DD_SPACING.md,
    gap: 6,
    overflow: 'hidden',
  },
  itemCardUnread: {
    backgroundColor: 'rgba(18, 18, 28, 0.95)',
    borderColor: 'rgba(191, 253, 64, 0.25)',
  },
  itemCardPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.99 }],
  },
  unreadBar: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 3.5,
    backgroundColor: DD_COLORS.lime,
  },
  itemHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  badgePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    borderRadius: DD_RADII.pill,
    borderWidth: 1,
  },
  itemTitle: {
    fontSize: 15,
  },
  itemBody: {
    lineHeight: 19,
  },
  rejectionBox: {
    backgroundColor: 'rgba(255, 59, 86, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 59, 86, 0.25)',
    borderRadius: DD_RADII.md,
    padding: DD_SPACING.sm,
    gap: 2,
    marginTop: DD_SPACING.xs,
  },
  rejectionText: {
    fontStyle: 'italic',
  },
  actionFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: DD_SPACING.xs,
    paddingTop: DD_SPACING.xs,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.04)',
  },
});
