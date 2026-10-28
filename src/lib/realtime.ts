import { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

export type RealtimeConnectionStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

export interface CompletionSubscriptionOptions {
  supabase: SupabaseClient | null;
  channelName: string;
  filter?: string;
  debounceMs?: number;
  onEvent: () => void | Promise<void>;
  onStatusChange?: (status: RealtimeConnectionStatus, err?: Error) => void;
}

/**
 * Generates a sanitized channel identifier for scoping subscriptions.
 */
export function buildCompletionsChannelName(prefix: string, scopeId: string, userId?: string): string {
  const parts = [prefix, scopeId];
  if (userId) parts.push(userId);
  return parts.join(':');
}

/**
 * Subscribes to changes on public.challenge_completions using Supabase Realtime.
 * 
 * - Debounces rapid events to avoid duplicate refetches and free-tier quota exhaustion.
 * - Respects unmounting and guarantees cleanup via supabase.removeChannel().
 * - Treats Realtime events strictly as invalidation signals to refetch authoritative data.
 */
export function subscribeToCompletions(options: CompletionSubscriptionOptions): () => void {
  const {
    supabase,
    channelName,
    filter,
    debounceMs = 250,
    onEvent,
    onStatusChange,
  } = options;

  if (!supabase) {
    return () => {};
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let isTornDown = false;
  let activeChannel: RealtimeChannel | null = null;

  const handleIncomingChange = () => {
    if (isTornDown) return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      if (!isTornDown) {
        try {
          void onEvent();
        } catch (err) {
          console.warn('[DareDrop Realtime] Event callback error:', err);
        }
      }
    }, debounceMs);
  };

  try {
    const postgresChangesConfig: {
      event: '*';
      schema: 'public';
      table: 'challenge_completions';
      filter?: string;
    } = {
      event: '*',
      schema: 'public',
      table: 'challenge_completions',
    };

    if (filter) {
      postgresChangesConfig.filter = filter;
    }

    const channel = supabase
      .channel(channelName)
      .on('postgres_changes', postgresChangesConfig, () => {
        handleIncomingChange();
      });

    channel.subscribe((status, err) => {
      if (isTornDown) return;
      if (onStatusChange) {
        onStatusChange(status as RealtimeConnectionStatus, err);
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn(`[DareDrop Realtime] Channel "${channelName}" error:`, status, err?.message || err);
      }
    });

    activeChannel = channel;
  } catch (setupErr) {
    console.warn(`[DareDrop Realtime] Failed to setup channel "${channelName}":`, setupErr);
  }

  return () => {
    isTornDown = true;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (activeChannel && supabase) {
      try {
        void supabase.removeChannel(activeChannel);
      } catch (removeErr) {
        console.warn(`[DareDrop Realtime] Error removing channel "${channelName}":`, removeErr);
      }
      activeChannel = null;
    }
  };
}
