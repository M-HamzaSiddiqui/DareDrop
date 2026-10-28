import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DD } from '@/constants/dd-theme';
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

  const getEventBadge = (eventType: string) => {
    switch (eventType) {
      case 'submission_pending':
        return { icon: '📋', label: 'Review Request', color: DD.catFun };
      case 'dare_approved':
        return { icon: '🎉', label: 'Dare Approved', color: DD.lime };
      case 'dare_rejected':
        return { icon: '❌', label: 'Dare Rejected', color: '#FF4D4D' };
      case 'verifier_reassigned':
        return { icon: '🔄', label: 'Verifier Assigned', color: DD.purple };
      case 'friend_request_received':
        return { icon: '👋', label: 'Friend Request', color: DD.catFun };
      case 'friend_request_accepted':
        return { icon: '🤝', label: 'Friend Connected', color: DD.lime };
      case 'challenge_invitation_received':
        return { icon: '⚡', label: 'Dare Invitation', color: DD.purple };
      default:
        return { icon: '🔔', label: 'Update', color: DD.textSub };
    }
  };

  const renderItem = ({ item }: { item: AppNotification }) => {
    const badge = getEventBadge(item.eventType);
    const route = getNotificationRoute(item);
    const hasAction = Boolean(route);

    return (
      <Pressable
        onPress={() => handleNotificationPress(item)}
        style={({ pressed }) => [
          styles.itemCard,
          !item.isRead && styles.itemCardUnread,
          pressed && styles.itemCardPressed,
        ]}>
        {/* Unread indicator bar */}
        {!item.isRead && <View style={styles.unreadIndicator} />}

        <View style={styles.cardHeader}>
          <View style={[styles.badgePill, { borderColor: badge.color + '44' }]}>
            <Text style={styles.badgeIcon}>{badge.icon}</Text>
            <Text style={[styles.badgeLabel, { color: badge.color }]}>{badge.label}</Text>
          </View>
          <Text style={styles.timestamp}>{formatNotificationTimestamp(item.createdAt)}</Text>
        </View>

        <Text style={[styles.itemTitle, !item.isRead && styles.itemTitleUnread]}>
          {item.title}
        </Text>
        {Boolean(item.body) && <Text style={styles.itemBody}>{item.body}</Text>}

        {/* Rejection note callout if present */}
        {Boolean(item.rejectionReason) && (
          <View style={styles.rejectionBox}>
            <Text style={styles.rejectionLabel}>Note from Verifier:</Text>
            <Text style={styles.rejectionText}>&ldquo;{item.rejectionReason}&rdquo;</Text>
          </View>
        )}

        {hasAction && (
          <View style={styles.actionFooter}>
            <Text style={styles.actionLink}>
              {item.eventType === 'submission_pending' || item.eventType === 'verifier_reassigned'
                ? 'Review submission →'
                : item.eventType.startsWith('friend_')
                  ? 'View friends →'
                  : 'View dare →'}
            </Text>
          </View>
        )}
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar style="light" />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + DD.s3 }]}>
        <Pressable
          onPress={() => {
            if (router.canGoBack()) {
              router.back();
            } else {
              router.replace('/');
            }
          }}
          hitSlop={12}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel="Back">
          <Text style={styles.backButtonText}>←</Text>
        </Pressable>

        <View style={styles.headerTitleWrap}>
          <Text style={styles.headerTitle}>Notifications</Text>
          {unreadCount > 0 && (
            <View style={styles.headerCountPill}>
              <Text style={styles.headerCountText}>{unreadCount}</Text>
            </View>
          )}
        </View>

        {unreadCount > 0 ? (
          <Pressable
            onPress={handleMarkAllRead}
            hitSlop={8}
            style={styles.markAllButton}
            accessibilityRole="button"
            accessibilityLabel="Mark all as read">
            <Text style={styles.markAllText}>Mark all read</Text>
          </Pressable>
        ) : (
          <View style={styles.headerSpacer} />
        )}
      </View>

      {/* Body */}
      {isGuest ? (
        <View style={styles.centered}>
          <View style={styles.emptyIconWrap}>
            <Text style={styles.emptyIcon}>🔒</Text>
          </View>
          <Text style={styles.emptyTitle}>Sign in to view notifications</Text>
          <Text style={styles.emptySubtitle}>
            Create an account or sign in to receive dare notifications, reviews, and verifier requests.
          </Text>
          <Pressable
            onPress={() =>
              showAuthModal({
                title: 'Sign In for Notifications',
                description: 'Create an account or sign in to stay updated on your dares.',
              })
            }
            style={styles.retryButton}
            accessibilityRole="button"
            accessibilityLabel="Sign in">
            <Text style={styles.retryButtonText}>Sign In / Register</Text>
          </Pressable>
        </View>
      ) : loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={DD.lime} size="large" />
          <Text style={styles.loadingText}>Loading notifications...</Text>
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Text style={styles.errorIcon}>⚠️</Text>
          <Text style={styles.errorTitle}>Could not load inbox</Text>
          <Text style={styles.errorMessage}>{error}</Text>
          <Pressable
            onPress={() => loadNotifications(true)}
            style={styles.retryButton}
            accessibilityRole="button"
            accessibilityLabel="Retry loading notifications">
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : notifications.length === 0 ? (
        <View style={styles.centered}>
          <View style={styles.emptyIconWrap}>
            <Text style={styles.emptyIcon}>🔔</Text>
          </View>
          <Text style={styles.emptyTitle}>All caught up!</Text>
          <Text style={styles.emptySubtitle}>
            When friends submit proof for dares, review your submissions, or assign you as a verifier,
            you&apos;ll see them right here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={notifications}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: insets.bottom + DD.s6 },
          ]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => loadNotifications(true)}
              tintColor={DD.lime}
              colors={[DD.lime]}
            />
          }
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: DD.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: DD.s4,
    paddingBottom: DD.s3,
    borderBottomWidth: 1,
    borderBottomColor: DD.border,
    backgroundColor: DD.bgCard,
  },
  backButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: DD.bgElement,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backButtonText: {
    color: DD.text,
    fontSize: 20,
    fontWeight: '700',
    marginTop: -2,
  },
  headerTitleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s2,
  },
  headerTitle: {
    color: DD.text,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  headerCountPill: {
    backgroundColor: DD.lime,
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: DD.radiusPill,
  },
  headerCountText: {
    color: DD.bg,
    fontSize: 11,
    fontWeight: '800',
  },
  markAllButton: {
    paddingHorizontal: DD.s2,
    paddingVertical: DD.s1,
  },
  markAllText: {
    color: DD.lime,
    fontSize: 12,
    fontWeight: '700',
  },
  headerSpacer: {
    width: 38,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: DD.s6,
  },
  loadingText: {
    marginTop: DD.s3,
    color: DD.textSub,
    fontSize: 14,
  },
  errorIcon: {
    fontSize: 36,
    marginBottom: DD.s2,
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: DD.text,
    marginBottom: DD.s1,
  },
  errorMessage: {
    fontSize: 13,
    color: DD.textSub,
    textAlign: 'center',
    marginBottom: DD.s4,
  },
  retryButton: {
    backgroundColor: DD.lime,
    paddingHorizontal: DD.s5,
    paddingVertical: DD.s2,
    borderRadius: DD.radiusPill,
  },
  retryButtonText: {
    color: DD.bg,
    fontSize: 13,
    fontWeight: '800',
  },
  emptyIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: DD.bgCard,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: DD.border,
    marginBottom: DD.s4,
  },
  emptyIcon: {
    fontSize: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: DD.text,
    marginBottom: DD.s2,
  },
  emptySubtitle: {
    fontSize: 13,
    color: DD.textSub,
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 280,
  },
  listContent: {
    padding: DD.s4,
    gap: DD.s3,
  },
  itemCard: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusMd,
    borderWidth: 1,
    borderColor: DD.border,
    padding: DD.s4,
    position: 'relative',
    overflow: 'hidden',
  },
  itemCardUnread: {
    borderColor: DD.lime + '55',
    backgroundColor: '#181C23',
  },
  itemCardPressed: {
    opacity: 0.85,
  },
  unreadIndicator: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    width: 3,
    backgroundColor: DD.lime,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: DD.s2,
  },
  badgePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: DD.bgElement,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
  },
  badgeIcon: {
    fontSize: 11,
  },
  badgeLabel: {
    fontSize: 11,
    fontWeight: '700',
  },
  timestamp: {
    fontSize: 11,
    color: DD.textSub,
  },
  itemTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: DD.textSub,
    marginBottom: 4,
  },
  itemTitleUnread: {
    color: DD.text,
    fontWeight: '800',
  },
  itemBody: {
    fontSize: 13,
    color: DD.textSub,
    lineHeight: 18,
  },
  rejectionBox: {
    marginTop: DD.s2,
    backgroundColor: '#2A1818',
    borderRadius: DD.radiusSm,
    padding: DD.s2,
    borderLeftWidth: 3,
    borderLeftColor: '#FF4D4D',
  },
  rejectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FF8888',
    marginBottom: 2,
  },
  rejectionText: {
    fontSize: 12,
    color: '#FFEAEA',
    fontStyle: 'italic',
  },
  actionFooter: {
    marginTop: DD.s3,
    paddingTop: DD.s2,
    borderTopWidth: 1,
    borderTopColor: DD.border + '66',
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  actionLink: {
    fontSize: 12,
    fontWeight: '700',
    color: DD.lime,
  },
});
