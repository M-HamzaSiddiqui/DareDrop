import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChallengeCard } from '@/components/dd/challenge-card';
import { CATEGORY_COLORS, CATEGORY_EMOJIS, CategoryKey, DD } from '@/constants/dd-theme';
import {
  NotificationPermissionStatus,
  getNotificationPermissionStatus,
  isPushNotificationSupported,
  registerForPushNotificationsAsync,
} from '@/lib/notifications';
import { fetchPendingFriendRequests, fetchUserFriends } from '@/lib/friends';
import { useAuth } from '@/lib/auth-context';
import { useChallenges } from '@/store/challenges-store';

export default function ProfileScreen() {
  const {
    challenges,
    pendingReviews,
    refreshPendingReviews,
    currentUserId,
    unreadNotificationsCount,
    refreshUnreadNotificationsCount,
  } = useChallenges();
  const {
    isGuest,
    isAnonymous,
    isRegistered,
    userEmail,
    userDisplayName,
    signOut,
  } = useAuth();
  const insets = useSafeAreaInsets();
  const [notifStatus, setNotifStatus] = useState<NotificationPermissionStatus | 'checking'>('checking');
  const [isRegisteringNotif, setIsRegisteringNotif] = useState(false);
  const [friendsCount, setFriendsCount] = useState<number>(0);
  const [pendingRequestsCount, setPendingRequestsCount] = useState<number>(0);

  useFocusEffect(
    useCallback(() => {
      refreshPendingReviews().catch(() => {});
      refreshUnreadNotificationsCount().catch(() => {});
      fetchUserFriends()
        .then((f) => setFriendsCount(f.length))
        .catch(() => {});
      fetchPendingFriendRequests()
        .then((r) => setPendingRequestsCount(r.incoming.length))
        .catch(() => {});
      if (!isPushNotificationSupported()) {
        setNotifStatus('unsupported');
        return;
      }
      getNotificationPermissionStatus()
        .then((s) => setNotifStatus(s))
        .catch(() => setNotifStatus('undetermined'));
    }, [refreshPendingReviews, refreshUnreadNotificationsCount]),
  );

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

  const joined = challenges.filter((c) => c.joined);
  const created = challenges.filter((c) => c.creator === 'You');

  const categoryCounts = joined.reduce(
    (acc, c) => {
      acc[c.category as CategoryKey] = (acc[c.category as CategoryKey] || 0) + 1;
      return acc;
    },
    {} as Record<CategoryKey, number>,
  );

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + DD.s5, paddingBottom: insets.bottom + 100 },
        ]}
        showsVerticalScrollIndicator={false}>
        {/* Avatar + name + notification bell */}
        <View style={styles.profileHeader}>
          <View style={styles.profileHeaderLeft}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{isRegistered ? '🦁' : isAnonymous ? '⚡' : '👤'}</Text>
            </View>
            <View style={styles.profileInfo}>
              <Text style={styles.profileName}>
                {isRegistered ? (userDisplayName || 'DareDrop Legend') : isAnonymous ? 'Guest Hero' : 'Guest Explorer'}
              </Text>
              <Text style={styles.profileHandle}>
                {isRegistered ? (userEmail || '@daredropper') : isAnonymous ? 'Guest Session (Temporary)' : 'Browsing as Guest'}
              </Text>
            </View>
          </View>
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
        </View>

        {/* Guest or Anonymous Upgrade Card */}
        {isAnonymous ? (
          <View style={[styles.authActionCard, styles.authActionCardUpgrade]}>
            <View style={styles.authActionLeft}>
              <Text style={styles.authActionIcon}>✨</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.authActionTitle}>Save Your Guest Dares</Text>
                <Text style={styles.authActionSub}>
                  You have active dares! Upgrade to a permanent account with email or Google to keep your streaks and verifications forever.
                </Text>
              </View>
            </View>
            <Pressable
              style={[styles.authActionBtn, styles.authActionBtnUpgrade]}
              onPress={() => router.push('/auth')}>
              <Text style={styles.authActionBtnTextUpgrade}>Upgrade Account</Text>
            </Pressable>
          </View>
        ) : isGuest ? (
          <View style={styles.authActionCard}>
            <View style={styles.authActionLeft}>
              <Text style={styles.authActionIcon}>👋</Text>
              <View style={{ flex: 1 }}>
                <Text style={styles.authActionTitle}>Browsing as Guest</Text>
                <Text style={styles.authActionSub}>
                  Sign in or create an account to create dares, join challenges, and track streaks.
                </Text>
              </View>
            </View>
            <Pressable
              style={styles.authActionBtn}
              onPress={() => router.push('/auth')}>
              <Text style={styles.authActionBtnText}>Sign In / Register</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Stats */}
        <View style={styles.statsRow}>
          <StatBox value={String(joined.length)} label="Joined" color={DD.lime} />
          <StatBox value={String(created.length)} label="Created" color={DD.purple} />
          <StatBox
            value={String(joined.reduce((a, c) => a + c.durationDays, 0))}
            label="Days pledged"
            color={DD.catFun}
          />
        </View>

        {/* Pending Reviews Notice */}
        {pendingReviews.length > 0 && (
          <View style={styles.reviewAlertCard}>
            <View style={styles.reviewAlertLeft}>
              <Text style={styles.reviewAlertIcon}>📋</Text>
              <View>
                <Text style={styles.reviewAlertTitle}>
                  {pendingReviews.length} Dare{pendingReviews.length > 1 ? 's' : ''} Awaiting Review
                </Text>
                <Text style={styles.reviewAlertSub}>
                  You are designated as verifier for active dares.
                </Text>
              </View>
            </View>
            <Pressable
              onPress={() => {
                if (pendingReviews[0]) {
                  router.push({
                    pathname: '/review/[id]',
                    params: { id: pendingReviews[0].completion.id },
                  });
                }
              }}
              style={styles.reviewAlertBtn}>
              <Text style={styles.reviewAlertBtnText}>Review →</Text>
            </Pressable>
          </View>
        )}

        {/* Notification Inbox Shortcut Card */}
        <Pressable
          onPress={() => router.push('/notifications')}
          style={({ pressed }) => [styles.inboxCard, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
          accessibilityLabel="Open Notification Inbox">
          <View style={styles.inboxCardLeft}>
            <View style={styles.inboxCardIconWrap}>
              <Text style={styles.inboxCardIcon}>📬</Text>
            </View>
            <View>
              <Text style={styles.inboxCardTitle}>Notification Inbox</Text>
              <Text style={styles.inboxCardSubtitle}>
                {unreadNotificationsCount > 0
                  ? `${unreadNotificationsCount} unread notification${unreadNotificationsCount > 1 ? 's' : ''}`
                  : 'View verifications, reviews & approvals'}
              </Text>
            </View>
          </View>
          <View style={styles.inboxCardRight}>
            {unreadNotificationsCount > 0 && (
              <View style={styles.inboxBadge}>
                <Text style={styles.inboxBadgeText}>
                  {unreadNotificationsCount > 99 ? '99+' : unreadNotificationsCount}
                </Text>
              </View>
            )}
            <Text style={styles.inboxArrow}>›</Text>
          </View>
        </Pressable>

        {/* Friends & Social Shortcut Card */}
        <Pressable
          onPress={() => router.push('/friends')}
          style={({ pressed }) => [styles.inboxCard, { marginTop: DD.s3 }, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
          accessibilityLabel="Open Friends and Social">
          <View style={styles.inboxCardLeft}>
            <View style={[styles.inboxCardIconWrap, { backgroundColor: DD.bgElement }]}>
              <Text style={styles.inboxCardIcon}>🤝</Text>
            </View>
            <View>
              <Text style={styles.inboxCardTitle}>Friends & Social</Text>
              <Text style={styles.inboxCardSubtitle}>
                {friendsCount > 0
                  ? `${friendsCount} friend${friendsCount !== 1 ? 's' : ''} • Connect & invite to dares`
                  : 'Share code & connect with friends'}
              </Text>
            </View>
          </View>
          <View style={styles.inboxCardRight}>
            {pendingRequestsCount > 0 && (
              <View style={[styles.inboxBadge, { backgroundColor: DD.catFun }]}>
                <Text style={styles.inboxBadgeText}>
                  {pendingRequestsCount > 99 ? '99+' : `${pendingRequestsCount} new`}
                </Text>
              </View>
            )}
            <Text style={styles.inboxArrow}>›</Text>
          </View>
        </Pressable>

        {/* Notifications Setting Card */}
        <View style={styles.notifCard}>
          <View style={styles.notifLeft}>
            <Text style={styles.notifIcon}>🔔</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.notifTitle}>Push Notifications</Text>
              <Text style={styles.notifSub}>
                {notifStatus === 'granted'
                  ? 'Active — You will be notified live when dares need review or are verified.'
                  : notifStatus === 'unsupported'
                    ? 'Requires Development Build. Run npx expo run:android or eas build.'
                    : 'Get instant alerts when someone submits a dare for you or approves your proof.'}
              </Text>
            </View>
          </View>
          {notifStatus === 'granted' ? (
            <View style={styles.notifActiveBadge}>
              <Text style={styles.notifActiveText}>✓ Active</Text>
            </View>
          ) : notifStatus === 'unsupported' ? (
            <View style={[styles.notifActiveBadge, { backgroundColor: DD.bgElement, borderColor: DD.border }]}>
              <Text style={[styles.notifActiveText, { color: DD.textMuted }]}>Dev Build</Text>
            </View>
          ) : (
            <Pressable
              onPress={handleEnableNotifications}
              disabled={isRegisteringNotif}
              style={[styles.notifEnableBtn, isRegisteringNotif && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel="Enable push notifications">
              {isRegisteringNotif ? (
                <ActivityIndicator size="small" color={DD.bg} />
              ) : (
                <Text style={styles.notifEnableBtnText}>Enable</Text>
              )}
            </Pressable>
          )}
        </View>

        {/* Category breakdown */}
        {joined.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>My Categories</Text>
            <View style={styles.categoryBreakdown}>
              {Object.entries(categoryCounts).map(([cat, count]) => {
                const color = CATEGORY_COLORS[cat as CategoryKey];
                return (
                  <View key={cat} style={[styles.categoryBadge, { borderColor: color }]}>
                    <Text style={styles.categoryBadgeEmoji}>{CATEGORY_EMOJIS[cat as CategoryKey]}</Text>
                    <View>
                      <Text style={[styles.categoryBadgeName, { color }]}>{cat}</Text>
                      <Text style={styles.categoryBadgeCount}>{count} active</Text>
                    </View>
                  </View>
                );
              })}
            </View>
          </View>
        )}

        {/* Active challenges */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Active Challenges ({joined.length})</Text>
          {joined.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>💪</Text>
              <Text style={styles.emptyTitle}>No active challenges</Text>
              <Text style={styles.emptyText}>Browse Discover to find your first challenge!</Text>
              <Pressable
                onPress={() => router.push('/discover')}
                style={({ pressed }) => [styles.discoverBtn, pressed && { opacity: 0.8 }]}
                accessibilityRole="button"
                accessibilityLabel="Go to Discover">
                <Text style={styles.discoverBtnText}>Discover Challenges</Text>
              </Pressable>
            </View>
          ) : (
            joined.map((c) => (
              <ChallengeCard
                key={c.id}
                challenge={c}
                onPress={() => router.push(`/challenge/${c.id}`)}
              />
            ))
          )}
        </View>

        {/* Created challenges */}
        {created.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Created by Me ({created.length})</Text>
            {created.map((c) => (
              <ChallengeCard
                key={c.id}
                challenge={c}
                onPress={() => router.push(`/challenge/${c.id}`)}
              />
            ))}
          </View>
        )}

        {/* Account / Session Management */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Account</Text>
          <View style={styles.accountCard}>
            {isRegistered ? (
              <View style={styles.accountRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.accountStatusTitle}>Full Account</Text>
                  <Text style={styles.accountEmailText}>{userEmail || 'Active user'}</Text>
                </View>
                <Pressable
                  style={({ pressed }) => [styles.signOutBtn, pressed && { opacity: 0.8 }]}
                  onPress={signOut}>
                  <Text style={styles.signOutBtnText}>Log Out</Text>
                </Pressable>
              </View>
            ) : isAnonymous ? (
              <View style={styles.accountRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.accountStatusTitle}>Guest Session</Text>
                  <Text style={styles.accountEmailText}>Upgrade to save your progress</Text>
                </View>
                <Pressable
                  style={({ pressed }) => [styles.authActionBtn, styles.authActionBtnUpgrade, pressed && { opacity: 0.8 }]}
                  onPress={() => router.push('/auth')}>
                  <Text style={styles.authActionBtnTextUpgrade}>Upgrade</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.accountRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.accountStatusTitle}>Guest Explorer</Text>
                  <Text style={styles.accountEmailText}>Explore public challenges</Text>
                </View>
                <Pressable
                  style={({ pressed }) => [styles.authActionBtn, pressed && { opacity: 0.8 }]}
                  onPress={() => router.push('/auth')}>
                  <Text style={styles.authActionBtnText}>Sign In</Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function StatBox({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <View style={statStyles.box}>
      <Text style={[statStyles.value, { color }]}>{value}</Text>
      <Text style={statStyles.label}>{label}</Text>
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
    gap: DD.s5,
  },
  profileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  profileHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s4,
    flex: 1,
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
  inboxCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    borderWidth: 1,
    borderColor: DD.border,
    padding: DD.s4,
  },
  inboxCardLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s3,
    flex: 1,
  },
  inboxCardIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: DD.bgElement,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inboxCardIcon: {
    fontSize: 18,
  },
  inboxCardTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: DD.text,
  },
  inboxCardSubtitle: {
    fontSize: 12,
    color: DD.textSub,
    marginTop: 2,
  },
  inboxCardRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s2,
  },
  inboxBadge: {
    backgroundColor: DD.lime,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inboxBadgeText: {
    color: DD.bg,
    fontSize: 11,
    fontWeight: '900',
  },
  inboxArrow: {
    fontSize: 22,
    color: DD.textMuted,
    fontWeight: '600',
  },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: DD.bgElement,
    borderWidth: 2,
    borderColor: DD.lime,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontSize: 34,
  },
  profileInfo: {
    gap: DD.s1,
  },
  profileName: {
    fontSize: 20,
    fontWeight: '800',
    color: DD.text,
    letterSpacing: -0.4,
  },
  profileHandle: {
    fontSize: 13,
    color: DD.textSub,
    fontWeight: '500',
  },
  statsRow: {
    flexDirection: 'row',
    gap: DD.s3,
  },
  section: {
    gap: DD.s3,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: DD.text,
    letterSpacing: -0.3,
  },
  categoryBreakdown: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: DD.s2,
  },
  categoryBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s2,
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusChip,
    borderWidth: 1,
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s2,
  },
  categoryBadgeEmoji: {
    fontSize: 18,
  },
  categoryBadgeName: {
    fontSize: 12,
    fontWeight: '700',
  },
  categoryBadgeCount: {
    fontSize: 10,
    color: DD.textMuted,
    fontWeight: '500',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: DD.s7,
    gap: DD.s3,
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    borderWidth: 1,
    borderColor: DD.border,
    padding: DD.s6,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: DD.text,
  },
  emptyText: {
    fontSize: 13,
    color: DD.textSub,
    textAlign: 'center',
  },
  discoverBtn: {
    backgroundColor: DD.lime,
    borderRadius: DD.radiusPill,
    paddingHorizontal: DD.s6,
    paddingVertical: DD.s3,
    marginTop: DD.s2,
  },
  discoverBtnText: {
    fontSize: 14,
    fontWeight: '800',
    color: DD.bg,
  },
  reviewAlertCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    padding: DD.s4,
    marginBottom: DD.s5,
    borderWidth: 1,
    borderColor: '#FFB80055',
  },
  reviewAlertLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s3,
    flex: 1,
  },
  reviewAlertIcon: {
    fontSize: 22,
  },
  reviewAlertTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: DD.text,
  },
  reviewAlertSub: {
    fontSize: 11,
    color: DD.textSub,
    marginTop: 2,
  },
  reviewAlertBtn: {
    backgroundColor: '#FFB80022',
    paddingHorizontal: DD.s4,
    paddingVertical: DD.s2,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
    borderColor: '#FFB800',
  },
  reviewAlertBtnText: {
    fontSize: 12,
    fontWeight: '800',
    color: '#FFB800',
  },
  notifCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    padding: DD.s4,
    marginBottom: DD.s5,
    borderWidth: 1,
    borderColor: DD.border,
    gap: DD.s3,
  },
  notifLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s3,
    flex: 1,
  },
  notifIcon: {
    fontSize: 22,
  },
  notifTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: DD.text,
  },
  notifSub: {
    fontSize: 11,
    color: DD.textSub,
    marginTop: 2,
  },
  notifActiveBadge: {
    backgroundColor: '#00E67622',
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s2,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
    borderColor: '#00E676',
  },
  notifActiveText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#00E676',
  },
  notifEnableBtn: {
    backgroundColor: DD.lime,
    paddingHorizontal: DD.s4,
    paddingVertical: DD.s2,
    borderRadius: DD.radiusPill,
  },
  notifEnableBtnText: {
    fontSize: 12,
    fontWeight: '800',
    color: DD.bg,
  },
  authActionCard: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    borderWidth: 1,
    borderColor: DD.border,
    padding: DD.s4,
    marginBottom: DD.s4,
    gap: DD.s3,
  },
  authActionCardUpgrade: {
    borderColor: 'rgba(155, 89, 255, 0.5)',
    backgroundColor: 'rgba(155, 89, 255, 0.08)',
  },
  authActionLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s3,
  },
  authActionIcon: {
    fontSize: 22,
  },
  authActionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: DD.text,
    marginBottom: 2,
  },
  authActionSub: {
    fontSize: 12,
    color: DD.textSub,
    lineHeight: 16,
  },
  authActionBtn: {
    backgroundColor: DD.lime,
    borderRadius: DD.radiusLg,
    paddingVertical: DD.s2 + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  authActionBtnUpgrade: {
    backgroundColor: DD.purple,
  },
  authActionBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0A0A0F',
  },
  authActionBtnTextUpgrade: {
    fontSize: 13,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  accountCard: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    borderWidth: 1,
    borderColor: DD.border,
    padding: DD.s4,
  },
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: DD.s3,
  },
  accountStatusTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: DD.text,
  },
  accountEmailText: {
    fontSize: 12,
    color: DD.textSub,
    marginTop: 2,
  },
  signOutBtn: {
    backgroundColor: 'rgba(255, 68, 102, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255, 68, 102, 0.4)',
    borderRadius: DD.radiusLg,
    paddingHorizontal: DD.s4,
    paddingVertical: DD.s2,
  },
  signOutBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: DD.danger,
  },
});

const statStyles = StyleSheet.create({
  box: {
    flex: 1,
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    borderWidth: 1,
    borderColor: DD.border,
    paddingVertical: DD.s4,
    paddingHorizontal: DD.s3,
    alignItems: 'center',
  },
  value: {
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: -0.5,
  },
  label: {
    fontSize: 11,
    color: DD.textSub,
    fontWeight: '600',
    marginTop: 2,
  },
});
