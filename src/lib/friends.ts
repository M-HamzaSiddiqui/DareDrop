import * as Clipboard from 'expo-clipboard';
import { Share } from 'react-native';

import {
  DbUserProfile,
  isSupabaseConfigured,
  PendingChallengeInvitation,
  PendingFriendRequest,
  PublicProfileLookup,
  supabase,
  UserFriend,
} from './supabase';

const CROCKFORD_BASE32_REGEX = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * Normalizes user input into canonical DARE-XXXX-XXXX format.
 * Strips whitespace, 'DARE-', and hyphens, and converts to uppercase.
 * Returns null if the code does not match Crockford Base32 8-char format.
 */
export function normalizeFriendCode(rawInput: string): string | null {
  if (!rawInput || typeof rawInput !== 'string') return null;

  let cleaned = rawInput.trim().toUpperCase();
  cleaned = cleaned.replace(/^DARE-?/, '');
  cleaned = cleaned.replace(/-/g, '');

  if (!CROCKFORD_BASE32_REGEX.test(cleaned)) {
    return null;
  }

  return `DARE-${cleaned.slice(0, 4)}-${cleaned.slice(4, 8)}`;
}

/**
 * Validates whether the given string is a valid friend code.
 */
export function isValidFriendCode(rawInput: string): boolean {
  return normalizeFriendCode(rawInput) !== null;
}

/**
 * Human-readable share text for sharing one's friend code.
 */
export function buildFriendShareText(friendCode: string, displayName?: string): string {
  const name = displayName?.trim() || 'I';
  return `Connect with ${name === 'I' ? 'me' : name} on DareDrop! My Friend Code is: ${friendCode}\n\nEnter it in the DareDrop app to challenge me to dares!`;
}

/**
 * Opens the native share sheet or falls back to clipboard copying.
 */
export async function shareFriendCode(
  friendCode: string,
  displayName?: string,
): Promise<{ shared: boolean; method: 'share' | 'clipboard' }> {
  const normalized = normalizeFriendCode(friendCode) || friendCode;
  const message = buildFriendShareText(normalized, displayName);

  try {
    const result = await Share.share({
      title: 'Connect on DareDrop',
      message,
    });

    if (result.action === Share.sharedAction) {
      return { shared: true, method: 'share' };
    }
  } catch {
    // If native sharing fails or is cancelled, fall back to clipboard
  }

  try {
    await Clipboard.setStringAsync(normalized);
    return { shared: true, method: 'clipboard' };
  } catch {
    return { shared: false, method: 'clipboard' };
  }
}

/**
 * Translates database error messages into user-friendly strings.
 */
export function translateSocialError(err: any): string {
  if (!err) return 'An unexpected error occurred.';
  const msg = typeof err === 'string' ? err : err.message || '';

  if (msg.includes('Cannot send a friend request to yourself')) {
    return 'You cannot send a friend request to yourself!';
  }
  if (msg.includes('No user found with that friend code')) {
    return 'No user found with that friend code. Please check the code and try again.';
  }
  if (msg.includes('You are already friends with this user')) {
    return 'You are already friends with this user.';
  }
  if (msg.includes('Friend request already sent and pending')) {
    return 'You already sent a friend request to this user. It is pending their response.';
  }
  if (msg.includes('Invalid friend code format')) {
    return 'Invalid friend code format. Friend codes look like DARE-XXXX-XXXX.';
  }
  if (msg.includes('Only the recipient can accept')) {
    return 'You are not authorized to accept this friend request.';
  }
  if (msg.includes('Only the sender can cancel')) {
    return 'You are not authorized to cancel this friend request.';
  }
  if (msg.includes('User is already a participant in this challenge')) {
    return 'This friend has already joined this challenge.';
  }
  if (msg.includes('You can only invite accepted friends')) {
    return 'You can only invite accepted friends to challenges.';
  }
  if (msg.includes('Challenge has already ended')) {
    return 'This challenge has already ended and cannot accept new invites.';
  }
  if (msg.includes('This invitation has expired')) {
    return 'This challenge invitation has expired.';
  }
  if (msg.includes('Rate limit exceeded') || msg.includes('Too many lookups')) {
    return 'Too many friend lookups. Please wait a minute before searching again.';
  }
  if (msg.includes('Authentication required') || msg.includes('42501')) {
    return 'Please sign in or wait for your session to connect.';
  }

  return msg || 'An unexpected error occurred. Please try again.';
}

/**
 * Fetches or initializes the authenticated user's profile and unique friend code.
 */
export async function fetchOrCreateUserProfile(
  displayName?: string,
  avatarEmoji?: string,
): Promise<DbUserProfile> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured');
  }

  const { data, error } = await supabase.rpc('get_or_create_user_profile', {
    p_display_name: displayName || null,
    p_avatar_emoji: avatarEmoji || null,
  });

  if (error || !data) {
    throw new Error(error?.message || 'Failed to retrieve profile');
  }

  return data as DbUserProfile;
}

/**
 * Updates the authenticated user's display name and/or avatar emoji via secure RPC.
 * Server validates display_name (2-32 chars, safe chars) and avatar_emoji (max 8 chars).
 */
export async function updateUserProfile(
  displayName: string,
  avatarEmoji?: string,
): Promise<DbUserProfile> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured');
  }

  const { data, error } = await supabase.rpc('update_user_profile', {
    p_display_name: displayName,
    p_avatar_emoji: avatarEmoji || null,
  });

  if (error || !data) {
    throw new Error(error?.message || 'Failed to update profile');
  }

  return data as DbUserProfile;
}

/**
 * Looks up another user by exact friend code. Returns safe public info only.
 */
export async function lookupProfileByCode(
  friendCode: string,
): Promise<PublicProfileLookup | null> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured');
  }

  const normalized = normalizeFriendCode(friendCode);
  if (!normalized) {
    throw new Error('Invalid friend code format');
  }

  const { data, error } = await supabase.rpc('lookup_profile_by_friend_code', {
    p_friend_code: normalized,
  });

  if (error) {
    throw new Error(error.message);
  }

  if (!data || !Array.isArray(data) || data.length === 0) {
    return null;
  }

  return data[0] as PublicProfileLookup;
}

/**
 * Sends a friend request by friend code.
 */
export async function sendFriendRequest(
  friendCode: string,
): Promise<{
  requestId: string;
  status: string;
  targetDisplayName: string;
}> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured');
  }

  const normalized = normalizeFriendCode(friendCode);
  if (!normalized) {
    throw new Error('Invalid friend code format');
  }

  const { data, error } = await supabase.rpc('send_friend_request', {
    p_friend_code: normalized,
  });

  if (error) {
    throw new Error(error.message);
  }

  if (!data || !Array.isArray(data) || data.length === 0) {
    throw new Error('Failed to send friend request');
  }

  const row = data[0];
  return {
    requestId: row.request_id,
    status: row.status,
    targetDisplayName: row.target_display_name,
  };
}

/**
 * Accepts an incoming friend request.
 */
export async function acceptFriendRequest(requestId: string): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured');
  }

  const { data, error } = await supabase.rpc('accept_friend_request', {
    p_request_id: requestId,
  });

  if (error) {
    throw new Error(error.message);
  }

  return Boolean(data);
}

/**
 * Declines an incoming friend request.
 */
export async function declineFriendRequest(requestId: string): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured');
  }

  const { data, error } = await supabase.rpc('decline_friend_request', {
    p_request_id: requestId,
  });

  if (error) {
    throw new Error(error.message);
  }

  return Boolean(data);
}

/**
 * Cancels a pending outgoing friend request.
 */
export async function cancelFriendRequest(requestId: string): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured');
  }

  const { data, error } = await supabase.rpc('cancel_friend_request', {
    p_request_id: requestId,
  });

  if (error) {
    throw new Error(error.message);
  }

  return Boolean(data);
}

/**
 * Removes an accepted friend.
 */
export async function removeFriend(friendUserId: string): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured');
  }

  const { data, error } = await supabase.rpc('remove_friend', {
    p_friend_user_id: friendUserId,
  });

  if (error) {
    throw new Error(error.message);
  }

  return Boolean(data);
}

/**
 * Fetches the user's list of accepted friends.
 */
export async function fetchUserFriends(): Promise<UserFriend[]> {
  if (!isSupabaseConfigured || !supabase) {
    return [];
  }

  const { data, error } = await supabase.rpc('get_user_friends');

  if (error) {
    console.warn('[DareDrop Friends] fetchUserFriends error:', error.message);
    return [];
  }

  return Array.isArray(data) ? (data as UserFriend[]) : [];
}

/**
 * Fetches incoming and outgoing pending friend requests.
 */
export async function fetchPendingFriendRequests(): Promise<{
  incoming: PendingFriendRequest[];
  outgoing: PendingFriendRequest[];
}> {
  if (!isSupabaseConfigured || !supabase) {
    return { incoming: [], outgoing: [] };
  }

  const { data, error } = await supabase.rpc('get_pending_friend_requests');

  if (error) {
    console.warn('[DareDrop Friends] fetchPendingFriendRequests error:', error.message);
    return { incoming: [], outgoing: [] };
  }

  const list = Array.isArray(data) ? (data as PendingFriendRequest[]) : [];
  return {
    incoming: list.filter((r) => r.direction === 'incoming'),
    outgoing: list.filter((r) => r.direction === 'outgoing'),
  };
}

/**
 * Sends a challenge invitation to an accepted friend.
 */
export async function sendChallengeInvitation(
  challengeId: string,
  inviteeUserId: string,
): Promise<{
  invitationId: string;
  status: string;
  expiresAt: string;
}> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured');
  }

  const { data, error } = await supabase.rpc('send_challenge_invitation', {
    p_challenge_id: challengeId,
    p_invitee_user_id: inviteeUserId,
  });

  if (error) {
    throw new Error(error.message);
  }

  if (!data || !Array.isArray(data) || data.length === 0) {
    throw new Error('Failed to send challenge invitation');
  }

  const row = data[0];
  return {
    invitationId: row.invitation_id,
    status: row.status,
    expiresAt: row.expires_at,
  };
}

/**
 * Responds to a challenge invitation (accept or decline).
 */
export async function respondToChallengeInvitation(
  invitationId: string,
  accept: boolean,
): Promise<{
  invitationId: string;
  status: string;
  challengeId: string;
}> {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured');
  }

  const { data, error } = await supabase.rpc('respond_to_challenge_invitation', {
    p_invitation_id: invitationId,
    p_accept: accept,
  });

  if (error) {
    throw new Error(error.message);
  }

  if (!data || !Array.isArray(data) || data.length === 0) {
    throw new Error('Failed to process challenge invitation response');
  }

  const row = data[0];
  return {
    invitationId: row.invitation_id,
    status: row.status,
    challengeId: row.challenge_id,
  };
}

/**
 * Fetches pending challenge invitations for the user.
 */
export async function fetchUserChallengeInvitations(): Promise<PendingChallengeInvitation[]> {
  if (!isSupabaseConfigured || !supabase) {
    return [];
  }

  const { data, error } = await supabase.rpc('get_user_challenge_invitations');

  if (error) {
    console.warn('[DareDrop Friends] fetchUserChallengeInvitations error:', error.message);
    return [];
  }

  return Array.isArray(data) ? (data as PendingChallengeInvitation[]) : [];
}
