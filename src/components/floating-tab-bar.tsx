import React from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Tabs } from 'expo-router';

import { DD, DD_COLORS, DD_RADII, DD_SPACING } from '@/constants/dd-theme';
import { DDIcon } from '@/components/ui/dd-icon';
import { DDText } from '@/components/ui/dd-text';
import { useChallenges } from '@/store/challenges-store';

export type FloatingTabBarProps = Parameters<NonNullable<React.ComponentProps<typeof Tabs>['tabBar']>>[0];
export type FloatingTabRoute = FloatingTabBarProps['state']['routes'][number];

/**
 * Premium Floating Bottom Navigation Dock for DareDrop.
 *
 * Implements:
 * - Floating rounded dock with dark translucent surface
 * - 5 navigation triggers: Home, Discover, Create (Center Hero), Notifications, Profile
 * - Minimum 48dp touch targets on all buttons
 * - Tactile Android press feedback
 * - Dynamic unread notification badge counter
 * - Safe-area inset compensation
 */
export function FloatingTabBar({ state, navigation }: FloatingTabBarProps) {
  const insets = useSafeAreaInsets();
  const { unreadNotificationsCount } = useChallenges();
  const [focusedRoute, setFocusedRoute] = React.useState<string | null>(null);

  const currentRouteName = state.routes[state.index]?.name;

  // Determine active/focused state among standard routes
  const isHomeActive = currentRouteName === 'index';
  const showHomeFill = isHomeActive || focusedRoute === 'index';

  const isDiscoverActive = currentRouteName === 'discover';
  const showDiscoverFill = isDiscoverActive || focusedRoute === 'discover';

  const isCreateActive = currentRouteName === 'create';
  const showCreateActive = isCreateActive || focusedRoute === 'create';

  const isProfileActive = currentRouteName === 'profile';
  const showProfileFill = isProfileActive || focusedRoute === 'profile';

  const isNotificationsActive = currentRouteName === 'notifications';
  const isNotificationsActiveOrFocused = isNotificationsActive || focusedRoute === 'notifications';
  const showNotificationsFill = isNotificationsActive || focusedRoute === 'notifications' || unreadNotificationsCount > 0;

  const navigateTab = (routeName: string) => {
    const route = state.routes.find((r: FloatingTabRoute) => r.name === routeName);
    if (!route) return;

    const event = navigation.emit({
      type: 'tabPress',
      target: route.key,
      canPreventDefault: true,
    });

    if (!event.defaultPrevented) {
      navigation.navigate(route.name);
    }
  };

  const bottomInset = Math.max(insets.bottom, Platform.OS === 'android' ? 12 : 8);

  return (
    <View style={[styles.outerWrapper, { bottom: bottomInset }]} pointerEvents="box-none">
      <View style={styles.dockSurface}>
        {/* 1. Home Tab */}
        <Pressable
          onPress={() => navigateTab('index')}
          onFocus={() => setFocusedRoute('index')}
          onBlur={() => setFocusedRoute((prev) => (prev === 'index' ? null : prev))}
          android_ripple={{ color: 'rgba(191, 253, 64, 0.12)', borderless: true, radius: 28 }}
          style={({ pressed }) => [styles.tabItem, pressed && styles.tabItemPressed]}
          accessibilityRole="tab"
          accessibilityLabel="Home"
          accessibilityState={{ selected: isHomeActive }}>
          <View style={styles.iconPill}>
            <DDIcon
              name="home"
              size={22}
              color={showHomeFill ? DD_COLORS.lime : DD_COLORS.textMuted}
              weight={showHomeFill ? 'fill' : 'regular'}
            />
          </View>
          <DDText
            variant="caption"
            color={showHomeFill ? 'lime' : 'muted'}
            style={[styles.tabLabel, showHomeFill && styles.tabLabelActive]}>
            Home
          </DDText>
        </Pressable>

        {/* 2. Discover Tab */}
        <Pressable
          onPress={() => navigateTab('discover')}
          onFocus={() => setFocusedRoute('discover')}
          onBlur={() => setFocusedRoute((prev) => (prev === 'discover' ? null : prev))}
          android_ripple={{ color: 'rgba(191, 253, 64, 0.12)', borderless: true, radius: 28 }}
          style={({ pressed }) => [styles.tabItem, pressed && styles.tabItemPressed]}
          accessibilityRole="tab"
          accessibilityLabel="Discover challenges"
          accessibilityState={{ selected: isDiscoverActive }}>
          <View style={styles.iconPill}>
            <DDIcon
              name="discover"
              size={22}
              color={showDiscoverFill ? DD_COLORS.lime : DD_COLORS.textMuted}
              weight={showDiscoverFill ? 'fill' : 'regular'}
            />
          </View>
          <DDText
            variant="caption"
            color={showDiscoverFill ? 'lime' : 'muted'}
            style={[styles.tabLabel, showDiscoverFill && styles.tabLabelActive]}>
            Discover
          </DDText>
        </Pressable>

        {/* 3. Center Create Action (Hero Circular Button) */}
        <View style={styles.centerActionWrapper} pointerEvents="box-none">
          <Pressable
            onPress={() => navigateTab('create')}
            onFocus={() => setFocusedRoute('create')}
            onBlur={() => setFocusedRoute((prev) => (prev === 'create' ? null : prev))}
            android_ripple={{ color: 'rgba(10, 10, 16, 0.25)', borderless: false }}
            style={({ pressed }) => [
              styles.centerCircleButton,
              showCreateActive && styles.centerCircleButtonActive,
              pressed && styles.centerButtonPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Create challenge"
            accessibilityState={{ selected: isCreateActive }}>
            <DDIcon
              name="plus"
              size={26}
              color={DD_COLORS.textInverse}
              weight="bold"
            />
          </Pressable>
        </View>

        {/* 4. Alerts / Notifications Tab */}
        <Pressable
          onPress={() => navigateTab('notifications')}
          onFocus={() => setFocusedRoute('notifications')}
          onBlur={() => setFocusedRoute((prev) => (prev === 'notifications' ? null : prev))}
          android_ripple={{ color: 'rgba(155, 89, 255, 0.15)', borderless: true, radius: 28 }}
          style={({ pressed }) => [styles.tabItem, pressed && styles.tabItemPressed]}
          accessibilityRole="tab"
          accessibilityLabel={`Notifications, ${unreadNotificationsCount} unread`}
          accessibilityState={{ selected: isNotificationsActive }}>
          <View style={styles.iconPill}>
            <DDIcon
              name="bell"
              size={22}
              color={
                isNotificationsActiveOrFocused
                  ? DD_COLORS.lime
                  : unreadNotificationsCount > 0
                    ? DD_COLORS.purple
                    : DD_COLORS.textMuted
              }
              weight={showNotificationsFill ? 'fill' : 'regular'}
            />
            {unreadNotificationsCount > 0 && (
              <View style={styles.badgeWrapper}>
                <DDText variant="caption" color="inverse" style={styles.badgeText}>
                  {unreadNotificationsCount > 99 ? '99+' : String(unreadNotificationsCount)}
                </DDText>
              </View>
            )}
          </View>
          <DDText
            variant="caption"
            color={isNotificationsActiveOrFocused ? 'lime' : 'muted'}
            style={[styles.tabLabel, isNotificationsActiveOrFocused && styles.tabLabelActive]}>
            Alerts
          </DDText>
        </Pressable>

        {/* 5. Profile Tab */}
        <Pressable
          onPress={() => navigateTab('profile')}
          onFocus={() => setFocusedRoute('profile')}
          onBlur={() => setFocusedRoute((prev) => (prev === 'profile' ? null : prev))}
          android_ripple={{ color: 'rgba(191, 253, 64, 0.12)', borderless: true, radius: 28 }}
          style={({ pressed }) => [styles.tabItem, pressed && styles.tabItemPressed]}
          accessibilityRole="tab"
          accessibilityLabel="User profile"
          accessibilityState={{ selected: isProfileActive }}>
          <View style={styles.iconPill}>
            <DDIcon
              name="user"
              size={22}
              color={showProfileFill ? DD_COLORS.lime : DD_COLORS.textMuted}
              weight={showProfileFill ? 'fill' : 'regular'}
            />
          </View>
          <DDText
            variant="caption"
            color={showProfileFill ? 'lime' : 'muted'}
            style={[styles.tabLabel, showProfileFill && styles.tabLabelActive]}>
            Profile
          </DDText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outerWrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: DD_SPACING.lg,
    zIndex: 90,
  },
  dockSurface: {
    height: 66,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: 'rgba(18, 18, 28, 0.94)',
    borderRadius: DD_RADII.card + 14, // 34px smooth pill dock
    borderWidth: 1.5,
    borderColor: 'rgba(46, 46, 68, 0.75)',
    paddingHorizontal: DD_SPACING.xs,
    ...Platform.select({
      android: {
        elevation: 10,
      },
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.45,
        shadowRadius: 18,
      },
      default: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.45,
        shadowRadius: 18,
      },
    }),
  },
  tabItem: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: DD.touchTarget.min,
    minHeight: DD.touchTarget.min,
  },
  tabItemPressed: {
    opacity: 0.72,
  },
  iconPill: {
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  tabLabel: {
    fontSize: 10,
    fontWeight: '700',
    marginTop: 2,
    letterSpacing: 0.2,
  },
  tabLabelActive: {
    fontWeight: '800',
  },
  centerActionWrapper: {
    width: 60,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerCircleButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: DD_COLORS.lime,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ translateY: -10 }],
    ...DD.elevation.fab,
  },
  centerCircleButtonActive: {
    borderWidth: 2.5,
    borderColor: DD_COLORS.text,
  },
  centerButtonPressed: {
    opacity: 0.88,
    transform: [{ translateY: -8 }, { scale: 0.96 }],
  },
  badgeWrapper: {
    position: 'absolute',
    top: -3,
    right: -6,
    backgroundColor: DD_COLORS.lime,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: DD_COLORS.bgCard,
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '900',
    lineHeight: 11,
  },
});
