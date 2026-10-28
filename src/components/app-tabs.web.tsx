import {
  Tabs,
  TabList,
  TabTrigger,
  TabSlot,
  TabTriggerSlotProps,
  TabListProps,
} from 'expo-router/ui';
import { forwardRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { DD } from '@/constants/dd-theme';
import { useChallenges } from '@/store/challenges-store';

export default function AppTabs() {
  const { unreadNotificationsCount } = useChallenges();

  return (
    <Tabs>
      <TabSlot style={{ height: '100%' }} />
      <TabList asChild>
        <CustomTabList>
          <TabTrigger name="home" href="/" asChild>
            <TabButton icon="🏠">Home</TabButton>
          </TabTrigger>
          <TabTrigger name="discover" href="/discover" asChild>
            <TabButton icon="🔍">Discover</TabButton>
          </TabTrigger>
          <TabTrigger name="create" href="/create" asChild>
            <TabButton icon="➕">Create</TabButton>
          </TabTrigger>
          <TabTrigger name="profile" href="/profile" asChild>
            <TabButton icon="👤" badge={unreadNotificationsCount}>
              Profile
            </TabButton>
          </TabTrigger>
        </CustomTabList>
      </TabList>
    </Tabs>
  );
}

export const TabButton = forwardRef<
  View,
  TabTriggerSlotProps & { icon: string; badge?: number | string }
>(function TabButtonInner({ children, icon, isFocused, badge, ...props }, ref) {
  const hasBadge = typeof badge === 'number' ? badge > 0 : Boolean(badge);
  const badgeLabel = typeof badge === 'number' && badge > 99 ? '99+' : badge;

  return (
    <Pressable {...props} ref={ref as any} style={({ pressed }) => pressed && styles.pressed}>
      <View style={[styles.tabButtonView, isFocused && styles.tabButtonActive]}>
        <Text style={styles.tabIcon}>{icon}</Text>
        <Text style={[styles.tabLabel, isFocused && styles.tabLabelActive]}>{children}</Text>
        {hasBadge && (
          <View style={styles.badgePill}>
            <Text style={styles.badgeText}>{badgeLabel}</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
});

export function CustomTabList(props: TabListProps) {
  return (
    <View {...props} style={styles.tabListContainer}>
      <Text style={styles.brandText}>DARE DROP</Text>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create({
  tabListContainer: {
    position: 'absolute',
    bottom: 0,
    width: '100%',
    flexDirection: 'row',
    backgroundColor: DD.bgCard,
    borderTopWidth: 1,
    borderTopColor: DD.border,
    paddingVertical: DD.s3,
    paddingHorizontal: DD.s4,
    alignItems: 'center',
    gap: DD.s2,
  },
  brandText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 2,
    color: DD.lime,
    marginRight: 'auto',
  },
  pressed: {
    opacity: 0.7,
  },
  tabButtonView: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s1,
    paddingVertical: DD.s1,
    paddingHorizontal: DD.s3,
    borderRadius: DD.radiusPill,
  },
  tabButtonActive: {
    backgroundColor: DD.lime + '22',
  },
  tabIcon: {
    fontSize: 14,
  },
  tabLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: DD.textSub,
  },
  tabLabelActive: {
    color: DD.lime,
  },
  badgePill: {
    backgroundColor: DD.lime,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: DD.radiusPill,
    marginLeft: 4,
    minWidth: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: DD.bg,
    fontSize: 10,
    fontWeight: '800',
  },
});
