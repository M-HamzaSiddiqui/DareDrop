import { DarkTheme, ThemeProvider, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
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
import { DD_COLORS } from '@/constants/dd-theme';

import { ToastProvider } from '@/components/ui/dd-toast';

SplashScreen.preventAutoHideAsync();

const DareDropTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: DD_COLORS.bg,
    card: DD_COLORS.bgCard,
    text: DD_COLORS.text,
    border: DD_COLORS.borderSubtle,
    primary: DD_COLORS.lime,
  },
};

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
    <ThemeProvider value={DareDropTheme}>
      <AuthProvider>
        <ChallengesProvider>
          <ToastProvider>
            <StatusBar style="light" />
            <NotificationSync />
            <AuthPromptModal />
            <AnimatedSplashOverlay />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: DD_COLORS.bg },
                animation: 'fade',
              }}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="auth" options={{ presentation: 'modal', headerShown: false }} />
              <Stack.Screen name="auth/callback" options={{ headerShown: false }} />
              <Stack.Screen name="challenge/[id]" options={{ headerShown: false }} />
              <Stack.Screen name="invite/[id]" options={{ headerShown: false }} />
              <Stack.Screen name="review/[id]" options={{ headerShown: false }} />
              <Stack.Screen name="friends" options={{ headerShown: false }} />
            </Stack>
          </ToastProvider>
        </ChallengesProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
