import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Environment variables for Supabase (client-safe anon credentials only)
const rawSupabaseUrl = (process.env.EXPO_PUBLIC_SUPABASE_URL || '')
  .trim()
  .replace(/^["']|["']$/g, '');
export const SUPABASE_URL = rawSupabaseUrl
  .replace(/\/rest\/v1\/?$/, '')
  .replace(/\/+$/, '');
export const SUPABASE_ANON_KEY = (process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY || '')
  .trim()
  .replace(/^["']|["']$/g, '');

export const isSupabaseConfigured = Boolean(
  SUPABASE_URL &&
    SUPABASE_ANON_KEY &&
    SUPABASE_URL.startsWith('https://') &&
    SUPABASE_ANON_KEY !== 'your_supabase_anon_key_here',
);

// Database record types
export interface DbChallenge {
  id: string;
  title: string;
  description: string;
  category: 'Fitness' | 'Focus' | 'Fun' | 'Learning';
  duration_days: number;
  ends_at: string | null;
  creator_id: string | null;
  creator_name: string;
  created_at: string;
  participants_count?: number;
  challenge_type?: 'daily' | 'one_time';
  timezone?: string;
}

export interface DbParticipant {
  id: string;
  challenge_id: string;
  user_id: string;
  joined_at: string;
}

export type CompletionStatus = 'pending' | 'approved' | 'rejected';

export interface DbCompletion {
  id: string;
  challenge_id: string;
  challenge_type: 'daily' | 'one_time';
  participant_id: string;
  verifier_id: string;
  completion_date: string;
  status: CompletionStatus;
  submission_note: string | null;
  rejection_reason: string | null;
  submitted_at: string;
  reviewed_at: string | null;
}

export interface DbUserPushToken {
  id: string;
  user_id: string;
  expo_push_token: string;
  platform: 'ios' | 'android' | 'web' | 'unknown';
  device_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface EligibleVerifier {
  user_id: string;
  display_name: string;
  is_creator: boolean;
}

export interface ParticipantProgress {
  challenge_type: 'daily' | 'one_time';
  duration_days: number;
  verified_count: number;
  progress_pct: number;
  current_streak: number;
  is_completed: boolean;
  latest_approved_date: string | null;
}

export interface DbUserProfile {
  user_id: string;
  friend_code: string;
  display_name: string;
  avatar_emoji: string;
  created_at: string;
  updated_at: string;
}

export type FriendshipStatus = 'pending' | 'accepted' | 'declined' | 'cancelled';

export interface DbFriendship {
  id: string;
  sender_id: string;
  receiver_id: string;
  status: FriendshipStatus;
  created_at: string;
  updated_at: string;
}

export type ChallengeInvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired';

export interface DbChallengeInvitation {
  id: string;
  challenge_id: string;
  inviter_id: string;
  invitee_id: string;
  status: ChallengeInvitationStatus;
  created_at: string;
  expires_at: string;
}

export interface UserFriend {
  friendship_id: string;
  friend_user_id: string;
  display_name: string;
  avatar_emoji: string;
  friend_code: string;
  friends_since: string;
}

export interface PendingFriendRequest {
  request_id: string;
  direction: 'incoming' | 'outgoing';
  display_name: string;
  avatar_emoji: string;
  friend_code: string;
  created_at: string;
}

export interface PublicProfileLookup {
  display_name: string;
  avatar_emoji: string;
  is_self: boolean;
  friendship_status: 'none' | 'pending' | 'accepted' | 'declined' | 'cancelled' | 'self' | string;
}

export interface PendingChallengeInvitation {
  invitation_id: string;
  challenge_id: string;
  challenge_title: string;
  challenge_category: string;
  challenge_duration_days: number;
  inviter_name: string;
  inviter_avatar: string;
  created_at: string;
  expires_at: string;
}

export interface Database {
  public: {
    Tables: {
      challenges: {
        Row: DbChallenge;
        Insert: Omit<DbChallenge, 'id' | 'created_at'> & { id?: string; created_at?: string };
        Update: Partial<Omit<DbChallenge, 'id'>>;
      };
      challenge_participants: {
        Row: DbParticipant;
        Insert: Omit<DbParticipant, 'id' | 'joined_at'> & { id?: string; joined_at?: string };
        Update: Partial<Omit<DbParticipant, 'id'>>;
      };
      challenge_completions: {
        Row: DbCompletion;
        Insert: Omit<DbCompletion, 'id' | 'submitted_at' | 'reviewed_at'> & {
          id?: string;
          submitted_at?: string;
          reviewed_at?: string | null;
        };
        Update: Partial<Omit<DbCompletion, 'id'>>;
      };
      user_push_tokens: {
        Row: DbUserPushToken;
        Insert: Omit<DbUserPushToken, 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<DbUserPushToken, 'id'>>;
      };
      user_profiles: {
        Row: DbUserProfile;
        Insert: Omit<DbUserProfile, 'created_at' | 'updated_at'> & {
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<DbUserProfile, 'user_id'>>;
      };
      friendships: {
        Row: DbFriendship;
        Insert: Omit<DbFriendship, 'id' | 'created_at' | 'updated_at'> & {
          id?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Omit<DbFriendship, 'id'>>;
      };
      challenge_invitations: {
        Row: DbChallengeInvitation;
        Insert: Omit<DbChallengeInvitation, 'id' | 'created_at'> & {
          id?: string;
          created_at?: string;
        };
        Update: Partial<Omit<DbChallengeInvitation, 'id'>>;
      };
    };
    Functions: {
      register_device_push_token: {
        Args: {
          p_expo_push_token: string;
          p_platform?: string;
          p_device_name?: string | null;
        };
        Returns: DbUserPushToken;
      };
      unregister_device_push_token: {
        Args: {
          p_expo_push_token: string;
        };
        Returns: boolean;
      };
      submit_challenge_completion: {
        Args: {
          p_challenge_id: string;
          p_verifier_id: string;
          p_completion_date: string;
          p_submission_note?: string | null;
        };
        Returns: DbCompletion;
      };
      get_challenge_eligible_verifiers: {
        Args: {
          p_challenge_id: string;
        };
        Returns: EligibleVerifier[];
      };
      get_participant_challenge_progress: {
        Args: {
          p_challenge_id: string;
          p_user_id: string;
        };
        Returns: ParticipantProgress[];
      };
      reassign_challenge_verifier: {
        Args: {
          p_completion_id: string;
          p_new_verifier_id: string;
        };
        Returns: DbCompletion;
      };
      review_challenge_completion: {
        Args: {
          p_completion_id: string;
          p_decision: 'approved' | 'rejected';
          p_rejection_reason?: string | null;
        };
        Returns: DbCompletion;
      };
      get_user_notifications: {
        Args: {
          p_limit?: number;
          p_offset?: number;
        };
        Returns: {
          id: string;
          event_type: string;
          title: string;
          body: string;
          created_at: string;
          read_at: string | null;
          is_read: boolean;
          challenge_id: string | null;
          completion_id: string | null;
          rejection_reason: string | null;
        }[];
      };
      mark_notification_read: {
        Args: {
          p_notification_id: string;
        };
        Returns: boolean;
      };
      mark_all_notifications_read: {
        Args: Record<string, never>;
        Returns: number;
      };
      get_unread_notification_count: {
        Args: Record<string, never>;
        Returns: number;
      };
      get_or_create_user_profile: {
        Args: {
          p_display_name?: string | null;
          p_avatar_emoji?: string | null;
        };
        Returns: DbUserProfile;
      };
      update_user_profile: {
        Args: {
          p_display_name: string;
          p_avatar_emoji?: string | null;
        };
        Returns: DbUserProfile;
      };
      lookup_profile_by_friend_code: {
        Args: {
          p_friend_code: string;
        };
        Returns: PublicProfileLookup[];
      };
      send_friend_request: {
        Args: {
          p_friend_code: string;
        };
        Returns: {
          request_id: string;
          status: string;
          target_display_name: string;
        }[];
      };
      accept_friend_request: {
        Args: {
          p_request_id: string;
        };
        Returns: boolean;
      };
      decline_friend_request: {
        Args: {
          p_request_id: string;
        };
        Returns: boolean;
      };
      cancel_friend_request: {
        Args: {
          p_request_id: string;
        };
        Returns: boolean;
      };
      remove_friend: {
        Args: {
          p_friend_user_id: string;
        };
        Returns: boolean;
      };
      get_user_friends: {
        Args: Record<string, never>;
        Returns: UserFriend[];
      };
      get_pending_friend_requests: {
        Args: Record<string, never>;
        Returns: PendingFriendRequest[];
      };
      send_challenge_invitation: {
        Args: {
          p_challenge_id: string;
          p_invitee_user_id: string;
        };
        Returns: {
          invitation_id: string;
          status: string;
          expires_at: string;
        }[];
      };
      respond_to_challenge_invitation: {
        Args: {
          p_invitation_id: string;
          p_accept: boolean;
        };
        Returns: {
          invitation_id: string;
          status: string;
          challenge_id: string;
        }[];
      };
      get_user_challenge_invitations: {
        Args: Record<string, never>;
        Returns: PendingChallengeInvitation[];
      };
    };
  };
}

const isServerEnvironment = Platform.OS === 'web' && typeof window === 'undefined';

const safeAuthStorage = {
  getItem: async (key: string): Promise<string | null> => {
    if (isServerEnvironment) {
      return null;
    }
    try {
      return await AsyncStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: async (key: string, value: string): Promise<void> => {
    if (isServerEnvironment) {
      return;
    }
    try {
      await AsyncStorage.setItem(key, value);
    } catch {
      // Ignore storage write error in non-supported environments
    }
  },
  removeItem: async (key: string): Promise<void> => {
    if (isServerEnvironment) {
      return;
    }
    try {
      await AsyncStorage.removeItem(key);
    } catch {
      // Ignore
    }
  },
};

let supabaseInstance: SupabaseClient | null = null;

if (isSupabaseConfigured) {
  supabaseInstance = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      storage: safeAuthStorage,
      autoRefreshToken: !isServerEnvironment,
      persistSession: !isServerEnvironment,
      detectSessionInUrl: false,
    },
  });
}

export const supabase = supabaseInstance;

/**
 * Ensures an authentic, valid, registered Supabase session is active.
 * 1. Checks existing session.
 * 2. If session is anonymous, throws an error requiring a full registered account.
 * 3. Does NOT automatically create anonymous sessions for guests.
 * 4. Returns the verified Supabase user ID.
 */
export async function ensureAuthenticatedUser(): Promise<string> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured');
  }

  try {
    const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();
    const activeUser = sessionData?.session?.user;

    if (!sessionErr && activeUser?.id) {
      if (activeUser.is_anonymous) {
        throw new Error('Account required. Please create an account or sign in to continue.');
      }
      return activeUser.id;
    }
  } catch (err: any) {
    if (err?.message?.includes('Account required')) {
      throw err;
    }
  }

  throw new Error('Authentication required. Please create an account or sign in.');
}

/**
 * Returns the current active user ID if a session exists (registered or existing anonymous).
 * Returns an empty string for unauthenticated guests without creating anonymous accounts.
 */
export async function getOrCreateCurrentUserId(): Promise<string> {
  if (isSupabaseConfigured && supabase) {
    try {
      const { data } = await supabase.auth.getSession();
      if (data?.session?.user?.id) {
        return data.session.user.id;
      }
    } catch {
      // Fall through
    }
  }

  return '';
}

