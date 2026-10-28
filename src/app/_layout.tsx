import { DarkTheme, ThemeProvider, Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import { AuthPromptModal } from '@/components/dd/auth-prompt-modal';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import {
  addNotificationResponseReceivedListener,
  getLastNotificationResponseAsync,
  getNotificationPermissionStatus,
  handleNotificationTap,
  isPushNotificationSupported,
  registerForPushNotificationsAsync,
} from '@/lib/notifications';
import { ChallengesProvider } from '@/store/challenges-store';

SplashScreen.preventAutoHideAsync();

function NotificationSync() {
  const { currentUserId, isGuest, isRegistered } = useAuth();

  useEffect(() => {
    // If native notifications module is not linked in this build (e.g. Expo Go), skip listeners safely
    if (!isPushNotificationSupported()) return;

    // 1. Listen for notification responses (tap)
    const sub = addNotificationResponseReceivedListener(handleNotificationTap);

    // 2. Check for cold-start notification that opened the app
    getLastNotificationResponseAsync()
      .then((res) => {
        if (res) {
          handleNotificationTap(res);
        }
      })
      .catch(() => {});

    // 3. If permissions were previously granted, refresh token registration with backend for registered users
    if (currentUserId && isRegistered) {
      getNotificationPermissionStatus()
        .then((status) => {
          if (status === 'granted') {
            registerForPushNotificationsAsync(currentUserId).catch(() => {});
          }
        })
        .catch(() => {});
    }

    return () => {
      sub.remove();
    };
  }, [currentUserId, isGuest, isRegistered]);

  return null;
}

export default function RootLayout() {
  return (
    <ThemeProvider value={DarkTheme}>
      <AuthProvider>
        <ChallengesProvider>
          <NotificationSync />
          <AuthPromptModal />
          <AnimatedSplashOverlay />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="auth" options={{ presentation: 'modal', headerShown: false }} />
            <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
            <Stack.Screen name="challenge/[id]" options={{ headerShown: false }} />
            <Stack.Screen name="invite/[id]" options={{ headerShown: false }} />
            <Stack.Screen name="review/[id]" options={{ headerShown: false }} />
            <Stack.Screen name="notifications" options={{ headerShown: false }} />
            <Stack.Screen name="friends" options={{ headerShown: false }} />
          </Stack>
        </ChallengesProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}


