import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSupabaseConfigured, supabase } from './supabase';

export interface AppNotification {
  id: string;
  eventType:
    | 'submission_pending'
    | 'dare_approved'
    | 'dare_rejected'
    | 'verifier_reassigned'
    | 'friend_request_received'
    | 'friend_request_accepted'
    | 'challenge_invitation_received'
    | string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  isRead: boolean;
  challengeId?: string | null;
  completionId?: string | null;
  rejectionReason?: string | null;
}

const LOCAL_NOTIFICATION_READS_KEY = '@daredrop/local_notification_reads_v1';
const LOCAL_MOCK_NOTIFICATIONS_KEY = '@daredrop/local_mock_notifications_v1';

/**
 * Returns locally marked read notification IDs from AsyncStorage.
 */
export async function getLocalReadNotificationIds(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(LOCAL_NOTIFICATION_READS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

/**
 * Persists locally marked read notification IDs to AsyncStorage.
 */
export async function saveLocalReadNotificationId(id: string): Promise<void> {
  try {
    const set = await getLocalReadNotificationIds();
    set.add(id);
    await AsyncStorage.setItem(LOCAL_NOTIFICATION_READS_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // Ignore storage errors in non-standard environments
  }
}

/**
 * Persists multiple read notification IDs to AsyncStorage.
 */
export async function saveMultipleLocalReadNotificationIds(ids: string[]): Promise<void> {
  try {
    const set = await getLocalReadNotificationIds();
    ids.forEach((id) => set.add(id));
    await AsyncStorage.setItem(LOCAL_NOTIFICATION_READS_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // Ignore
  }
}

/**
 * Removes confirmed read notification IDs from AsyncStorage so local state does not accumulate indefinitely.
 */
export async function removeLocalReadNotificationIds(ids: string[]): Promise<void> {
  try {
    const set = await getLocalReadNotificationIds();
    let changed = false;
    ids.forEach((id) => {
      if (set.has(id)) {
        set.delete(id);
        changed = true;
      }
    });
    if (changed) {
      await AsyncStorage.setItem(LOCAL_NOTIFICATION_READS_KEY, JSON.stringify(Array.from(set)));
    }
  } catch {
    // Ignore
  }
}

/**
 * Pure route resolver from notification metadata.
 * Prioritizes review details for verifiers and challenge details for submitters.
 */
export function getNotificationRoute(notification: Pick<AppNotification, 'eventType' | 'completionId' | 'challengeId'>): string | null {
  const { eventType, completionId, challengeId } = notification;

  if (eventType === 'friend_request_received' || eventType === 'friend_request_accepted') {
    return '/friends';
  }

  if (completionId && (eventType === 'submission_pending' || eventType === 'verifier_reassigned')) {
    return `/review/${completionId}`;
  }

  if (challengeId) {
    return `/challenge/${challengeId}`;
  }

  return null;
}

/**
 * Human-friendly relative timestamp formatter for notifications.
 */
export function formatNotificationTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return '—';

  const now = Date.now();
  const diffSec = Math.floor((now - timestamp) / 1000);

  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;

  return new Date(timestamp).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Fetches notifications addressed to the currently authenticated user.
 */
export async function fetchUserNotifications(
  limit: number = 30,
  offset: number = 0,
): Promise<AppNotification[]> {
  const localReads = await getLocalReadNotificationIds();

  if (!isSupabaseConfigured || !supabase) {
    // Local / Offline fallback
    try {
      const stored = await AsyncStorage.getItem(LOCAL_MOCK_NOTIFICATIONS_KEY);
      if (stored) {
        const parsed: AppNotification[] = JSON.parse(stored);
        return parsed.map((n) => ({
          ...n,
          isRead: n.isRead || localReads.has(n.id),
          readAt: n.readAt || (localReads.has(n.id) ? new Date().toISOString() : null),
        }));
      }
    } catch {
      // Return empty array
    }
    return [];
  }

  try {
    const { data, error } = await supabase.rpc('get_user_notifications', {
      p_limit: limit,
      p_offset: offset,
    });

    if (error) {
      console.warn('[DareDrop Inbox] RPC get_user_notifications error:', error.message);
      return [];
    }

    if (!Array.isArray(data)) {
      return [];
    }

    const idsToPrune: string[] = [];
    const pendingSyncIds: string[] = [];

    const mapped = data.map((row: any) => {
      const isReadInDb = Boolean(row.is_read || row.read_at);
      const isLocallyRead = localReads.has(row.id);

      if (isReadInDb && isLocallyRead) {
        // Server already authoritatively persisted read status; prune from transient offline store
        idsToPrune.push(row.id);
      } else if (!isReadInDb && isLocallyRead) {
        // Read while offline; queue for background synchronization to server
        pendingSyncIds.push(row.id);
      }

      const isRead = isReadInDb || isLocallyRead;

      return {
        id: row.id,
        eventType: row.event_type || 'general',
        title: row.title || 'DareDrop Notification',
        body: row.body || '',
        createdAt: row.created_at || new Date().toISOString(),
        readAt: row.read_at || (isLocallyRead ? new Date().toISOString() : null),
        isRead,
        challengeId: row.challenge_id || null,
        completionId: row.completion_id || null,
        rejectionReason: row.rejection_reason || null,
      };
    });

    // Prune confirmed reads asynchronously
    if (idsToPrune.length > 0) {
      removeLocalReadNotificationIds(idsToPrune).catch(() => {});
    }

    // Sync pending offline reads to server
    if (pendingSyncIds.length > 0 && supabase) {
      const client = supabase;
      pendingSyncIds.forEach(async (id) => {
        try {
          await client.rpc('mark_notification_read', { p_notification_id: id });
        } catch {
          // Ignore background sync errors
        }
      });
    }

    return mapped;
  } catch (err: any) {
    console.warn('[DareDrop Inbox] Error fetching notifications:', err?.message || err);
    return [];
  }
}

/**
 * Retrieves the count of unread notifications for badge presentation.
 */
export async function fetchUnreadNotificationCount(): Promise<number> {
  const localReads = await getLocalReadNotificationIds();

  if (!isSupabaseConfigured || !supabase) {
    try {
      const stored = await AsyncStorage.getItem(LOCAL_MOCK_NOTIFICATIONS_KEY);
      if (stored) {
        const parsed: AppNotification[] = JSON.parse(stored);
        const unread = parsed.filter((n) => !n.isRead && !localReads.has(n.id));
        return unread.length;
      }
    } catch {
      return 0;
    }
    return 0;
  }

  try {
    const { data, error } = await supabase.rpc('get_unread_notification_count');
    if (error) {
      console.warn('[DareDrop Inbox] RPC get_unread_notification_count error:', error.message);
      return 0;
    }

    const count = typeof data === 'number' ? data : 0;
    return Math.max(0, count);
  } catch (err: any) {
    console.warn('[DareDrop Inbox] Error fetching unread count:', err?.message || err);
    return 0;
  }
}

/**
 * Marks a specific notification as read.
 */
export async function markNotificationAsRead(notificationId: string): Promise<boolean> {
  if (!notificationId) return false;

  // Persist locally first for instant UI response and offline consistency
  await saveLocalReadNotificationId(notificationId);

  if (!isSupabaseConfigured || !supabase) {
    return true;
  }

  try {
    const { data, error } = await supabase.rpc('mark_notification_read', {
      p_notification_id: notificationId,
    });

    if (error) {
      console.warn('[DareDrop Inbox] RPC mark_notification_read error:', error.message);
      return true; // Local read succeeded
    }

    return Boolean(data);
  } catch (err: any) {
    console.warn('[DareDrop Inbox] Error marking notification read:', err?.message || err);
    return true;
  }
}

/**
 * Marks all notifications as read for the active user.
 */
export async function markAllNotificationsAsRead(currentNotificationIds?: string[]): Promise<number> {
  if (currentNotificationIds && currentNotificationIds.length > 0) {
    await saveMultipleLocalReadNotificationIds(currentNotificationIds);
  }

  if (!isSupabaseConfigured || !supabase) {
    return currentNotificationIds?.length || 0;
  }

  try {
    const { data, error } = await supabase.rpc('mark_all_notifications_read');
    if (error) {
      console.warn('[DareDrop Inbox] RPC mark_all_notifications_read error:', error.message);
      return currentNotificationIds?.length || 0;
    }

    return typeof data === 'number' ? data : 0;
  } catch (err: any) {
    console.warn('[DareDrop Inbox] Error marking all notifications read:', err?.message || err);
    return currentNotificationIds?.length || 0;
  }
}
