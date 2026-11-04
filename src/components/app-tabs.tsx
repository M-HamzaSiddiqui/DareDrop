import React from 'react';
import { Tabs } from 'expo-router';

import { FloatingTabBar } from '@/components/floating-tab-bar';

/**
 * DareDrop Main Tab Navigator.
 * Powered by standard Expo Router Tabs with a custom floating dock tab bar.
 * Maintains all existing routes and deep link behaviors.
 */
export default function AppTabs() {
  return (
    <Tabs
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
      }}>
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="create" options={{ title: 'Create' }} />
      <Tabs.Screen name="notifications" options={{ title: 'Alerts' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
      <Tabs.Screen name="discover" options={{ href: null }} />
      <Tabs.Screen name="explore" options={{ href: null }} />
    </Tabs>
  );
}
