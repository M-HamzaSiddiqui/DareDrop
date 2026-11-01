import React from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, Tabs } from 'expo-router';

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

  const currentRouteName = state.routes[state.index]?.name;

  // Determine active tab index among standard routes
  const isHomeActive = currentRouteName === 'index';
  const isDiscoverActive = currentRouteName === 'discover';
  const isCreateActive = currentRouteName === 'create';
  const isProfileActive = currentRouteName === 'profile';

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

  const handleNotificationsPress = () => {
    router.push('/notifications');
  };

  const bottomInset = Math.max(insets.bottom, Platform.OS === 'android' ? 12 : 8);

  return (
    <View style={[styles.outerWrapper, { bottom: bottomInset }]} pointerEvents="box-none">
      <View style={styles.dockSurface}>
        {/* 1. Home Tab */}
        <Pressable
          onPress={() => navigateTab('index')}
          android_ripple={{ color: 'rgba(191, 253, 64, 0.12)', borderless: true, radius: 28 }}
          style={styles.tabItem}
          accessibilityRole="tab"
          accessibilityLabel="Home"
          accessibilityState={{ selected: isHomeActive }}>
          <View style={[styles.iconPill, isHomeActive && styles.iconPillActive]}>
            <DDIcon
              name="home"
              size={22}
              color={isHomeActive ? DD_COLORS.lime : DD_COLORS.textMuted}
              weight={isHomeActive ? 'fill' : 'bold'}
            />
          </View>
          <DDText
            variant="caption"
            color={isHomeActive ? 'lime' : 'muted'}
            style={[styles.tabLabel, isHomeActive && styles.tabLabelActive]}>
            Home
          </DDText>
        </Pressable>

        {/* 2. Discover Tab */}
        <Pressable
          onPress={() => navigateTab('discover')}
          android_ripple={{ color: 'rgba(191, 253, 64, 0.12)', borderless: true, radius: 28 }}
          style={styles.tabItem}
          accessibilityRole="tab"
          accessibilityLabel="Discover challenges"
          accessibilityState={{ selected: isDiscoverActive }}>
          <View style={[styles.iconPill, isDiscoverActive && styles.iconPillActive]}>
            <DDIcon
              name="discover"
              size={22}
              color={isDiscoverActive ? DD_COLORS.lime : DD_COLORS.textMuted}
              weight={isDiscoverActive ? 'fill' : 'bold'}
            />
          </View>
          <DDText
            variant="caption"
            color={isDiscoverActive ? 'lime' : 'muted'}
            style={[styles.tabLabel, isDiscoverActive && styles.tabLabelActive]}>
            Discover
          </DDText>
        </Pressable>

        {/* 3. Center Create Action (Hero Circular Button) */}
        <View style={styles.centerActionWrapper} pointerEvents="box-none">
          <Pressable
            onPress={() => navigateTab('create')}
            android_ripple={{ color: 'rgba(10, 10, 16, 0.25)', borderless: false }}
            style={({ pressed }) => [
              styles.centerCircleButton,
              isCreateActive && styles.centerCircleButtonActive,
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

        {/* 4. Notifications Item (Direct link to /notifications with Badge) */}
        <Pressable
          onPress={handleNotificationsPress}
          android_ripple={{ color: 'rgba(155, 89, 255, 0.15)', borderless: true, radius: 28 }}
          style={styles.tabItem}
          accessibilityRole="button"
          accessibilityLabel={`Notifications, ${unreadNotificationsCount} unread`}>
          <View style={styles.iconPill}>
            <DDIcon
              name="bell"
              size={22}
              color={unreadNotificationsCount > 0 ? DD_COLORS.purple : DD_COLORS.textMuted}
              weight={unreadNotificationsCount > 0 ? 'fill' : 'bold'}
            />
            {unreadNotificationsCount > 0 && (
              <View style={styles.badgeWrapper}>
                <DDText variant="caption" color="inverse" style={styles.badgeText}>
                  {unreadNotificationsCount > 99 ? '99+' : String(unreadNotificationsCount)}
                </DDText>
              </View>
            )}
          </View>
          <DDText variant="caption" color="muted" style={styles.tabLabel}>
            Alerts
          </DDText>
        </Pressable>

        {/* 5. Profile Tab */}
        <Pressable
          onPress={() => navigateTab('profile')}
          android_ripple={{ color: 'rgba(191, 253, 64, 0.12)', borderless: true, radius: 28 }}
          style={styles.tabItem}
          accessibilityRole="tab"
          accessibilityLabel="User profile"
          accessibilityState={{ selected: isProfileActive }}>
          <View style={[styles.iconPill, isProfileActive && styles.iconPillActive]}>
            <DDIcon
              name="user"
              size={22}
              color={isProfileActive ? DD_COLORS.lime : DD_COLORS.textMuted}
              weight={isProfileActive ? 'fill' : 'bold'}
            />
          </View>
          <DDText
            variant="caption"
            color={isProfileActive ? 'lime' : 'muted'}
            style={[styles.tabLabel, isProfileActive && styles.tabLabelActive]}>
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
  iconPill: {
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    borderRadius: DD_RADII.pill,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  iconPillActive: {
    backgroundColor: 'rgba(191, 253, 64, 0.12)',
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
