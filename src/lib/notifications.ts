import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { router } from 'expo-router';
import { Platform } from 'react-native';

import { isSupabaseConfigured, supabase } from './supabase';

export type NotificationPermissionStatus = 'granted' | 'undetermined' | 'denied' | 'unsupported';

const PUSH_TOKEN_STORAGE_KEY = '@daredrop/registered_push_token_v1';
const PUSH_PERMISSION_REQUESTED_KEY = '@daredrop/push_permission_requested_v1';

// Safely load the native expo-notifications module to prevent crashes in Expo Go or builds without native code linked
function getNativeNotificationsModule(): typeof import('expo-notifications') | null {
  try {
    // Dynamic require guards module evaluation against missing native module errors
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-notifications');
    return mod;
  } catch (err: any) {
    console.warn(
      '[DareDrop Notifications] Native notifications module is not available in this build (requires Development Build):',
      err?.message || err,
    );
    return null;
  }
}

const Notifications = getNativeNotificationsModule();

// Configure foreground notification presentation behavior if native module is present
if (Notifications?.setNotificationHandler) {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });
  } catch (e) {
    console.warn('[DareDrop Notifications] Failed to set notification handler:', e);
  }
}

/**
 * Returns true if the native notifications module is linked and available in the current binary.
 */
export function isPushNotificationSupported(): boolean {
  return Boolean(Notifications);
}

/**
 * Returns the configured EAS Project ID from Expo Constants.
 */
export function getExpoProjectId(): string | undefined {
  return (
    Constants.expoConfig?.extra?.eas?.projectId ||
    Constants.easConfig?.projectId ||
    undefined
  );
}

/**
 * Ensures the default Android notification channel exists.
 */
export async function setupAndroidNotificationChannel(): Promise<void> {
  if (Platform.OS === 'android' && Notifications?.setNotificationChannelAsync) {
    try {
      await Notifications.setNotificationChannelAsync('daredrop-default', {
        name: 'DareDrop Updates',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#CCFF00', // DareDrop lime accent
        sound: 'default',
        enableVibrate: true,
      });
    } catch (err) {
      console.warn('[DareDrop Notifications] Failed to setup Android notification channel:', err);
    }
  }
}

/**
 * Checks current notification permission without triggering OS prompt.
 */
export async function getNotificationPermissionStatus(): Promise<NotificationPermissionStatus> {
  if (!Notifications?.getPermissionsAsync) {
    return 'unsupported';
  }
  if (!Device.isDevice) {
    return 'undetermined';
  }
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status === 'granted') return 'granted';
    if (status === 'denied') return 'denied';
    return 'undetermined';
  } catch {
    return 'unsupported';
  }
}

/**
 * Requests push notification permissions and registers the Expo push token with Supabase.
 * Returns the registered push token or null if permission was denied / unavailable.
 */
export async function registerForPushNotificationsAsync(userId?: string): Promise<string | null> {
  if (!Notifications) {
    console.log('[DareDrop Notifications] Native notifications module not available in this build (requires Development Build).');
    return null;
  }

  if (!Device.isDevice) {
    console.log('[DareDrop Notifications] Push notifications require a physical device.');
    return null;
  }

  try {
    await setupAndroidNotificationChannel();

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      await AsyncStorage.setItem(PUSH_PERMISSION_REQUESTED_KEY, 'true');
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.log('[DareDrop Notifications] Permission not granted for push notifications.');
      return null;
    }

    const projectId = getExpoProjectId();
    const tokenResponse = await Notifications.getExpoPushTokenAsync({
      projectId,
    });
    const token = tokenResponse.data;

    if (!token) {
      console.warn('[DareDrop Notifications] Empty push token received.');
      return null;
    }

    // Persist token locally
    await AsyncStorage.setItem(PUSH_TOKEN_STORAGE_KEY, token);

    // Register with Supabase if backend is connected and user is authenticated
    if (isSupabaseConfigured && supabase) {
      const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';
      const deviceName = Device.modelName || Device.deviceName || null;

      const { error: rpcErr } = await supabase.rpc('register_device_push_token', {
        p_expo_push_token: token,
        p_platform: platform,
        p_device_name: deviceName,
      });

      if (rpcErr) {
        console.warn('[DareDrop Notifications] Failed to register token with backend:', rpcErr.message);
      } else {
        console.log('[DareDrop Notifications] Push token registered successfully.');
      }
    }

    return token;
  } catch (err: any) {
    console.warn('[DareDrop Notifications] Error registering for push notifications:', err?.message || err);
    return null;
  }
}

/**
 * Unregisters the current device token on sign-out to prevent delivery of subsequent notifications.
 */
export async function unregisterDevicePushTokenAsync(): Promise<void> {
  try {
    const cachedToken = await AsyncStorage.getItem(PUSH_TOKEN_STORAGE_KEY);
    if (!cachedToken) return;

    if (isSupabaseConfigured && supabase) {
      await supabase.rpc('unregister_device_push_token', {
        p_expo_push_token: cachedToken,
      });
    }

    await AsyncStorage.removeItem(PUSH_TOKEN_STORAGE_KEY);
    console.log('[DareDrop Notifications] Device push token unregistered.');
  } catch (err: any) {
    console.warn('[DareDrop Notifications] Error unregistering token:', err?.message || err);
  }
}

/**
 * Subscribes to notification tap events safely. Returns a subscription object with a remove method.
 */
export function addNotificationResponseReceivedListener(
  listener: (response: any) => void,
): { remove: () => void } {
  if (!Notifications?.addNotificationResponseReceivedListener) {
    return { remove: () => {} };
  }
  try {
    return Notifications.addNotificationResponseReceivedListener(listener);
  } catch (err) {
    console.warn('[DareDrop Notifications] Failed to attach notification listener:', err);
    return { remove: () => {} };
  }
}

/**
 * Retrieves the notification response that launched the app from a cold start, if any.
 */
export async function getLastNotificationResponseAsync(): Promise<any | null> {
  if (!Notifications?.getLastNotificationResponseAsync) {
    return null;
  }
  try {
    return await Notifications.getLastNotificationResponseAsync();
  } catch (err) {
    console.warn('[DareDrop Notifications] Failed to get last notification response:', err);
    return null;
  }
}

export interface NotificationPayloadData {
  challengeId?: string;
  completionId?: string;
  type?: 'submission_pending' | 'dare_approved' | 'dare_rejected' | 'verifier_reassigned';
}

/**
 * Handles notification tap responses and routes securely to the relevant screen.
 */
export function handleNotificationTap(response: any): void {
  const data = response?.notification?.request?.content?.data as NotificationPayloadData | undefined;
  if (!data) return;

  const { challengeId, completionId, type } = data;

  try {
    // If verifier needs to review, route to review details
    if (completionId && (type === 'submission_pending' || type === 'verifier_reassigned')) {
      router.push(`/review/${completionId}` as any);
      return;
    }

    // If submitter status updated, route to challenge screen
    if (challengeId) {
      router.push(`/challenge/${challengeId}` as any);
      return;
    }

    // Fallback: route to home reviews tab
    router.push('/');
  } catch (navErr) {
    console.warn('[DareDrop Notifications] Failed to route notification tap:', navErr);
  }
}
