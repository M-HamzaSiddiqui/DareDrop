import * as Clipboard from 'expo-clipboard';
import * as Linking from 'expo-linking';
import { Platform, Share } from 'react-native';

const PUBLIC_APP_URL = (process.env.EXPO_PUBLIC_APP_URL || '').replace(/\/$/, '');

export interface InviteUrls {
  /** The standard deep link handled by Expo Router (e.g. daredrop://invite/<id> or exp://.../--/invite/<id>) */
  deepLink: string;
  /** Public HTTPS URL if EXPO_PUBLIC_APP_URL is configured (e.g. https://daredrop.app/invite/<id>) */
  httpsUrl: string | null;
  /** The primary URL recommended for sharing (HTTPS if available, else deep link) */
  primaryUrl: string;
  /** Friendly text to accompany the link */
  shareMessage: string;
}

/**
 * Returns stable invite URLs for a given challenge.
 */
export function getChallengeInviteUrls(challenge: { id: string; title: string }): InviteUrls {
  const deepLink = Linking.createURL(`invite/${challenge.id}`);
  const httpsUrl = PUBLIC_APP_URL ? `${PUBLIC_APP_URL}/invite/${challenge.id}` : null;
  const primaryUrl = httpsUrl || deepLink;

  const shareMessage = `🔥 I dare you to join "${challenge.title}" on DareDrop!\n\nAccept the challenge: ${primaryUrl}`;

  return {
    deepLink,
    httpsUrl,
    primaryUrl,
    shareMessage,
  };
}

/**
 * Copies the challenge invite URL to the system clipboard.
 */
export async function copyInviteLink(challenge: { id: string; title: string }): Promise<{ success: boolean; url: string }> {
  const { primaryUrl } = getChallengeInviteUrls(challenge);
  try {
    await Clipboard.setStringAsync(primaryUrl);
    return { success: true, url: primaryUrl };
  } catch {
    return { success: false, url: primaryUrl };
  }
}

/**
 * Opens the native share sheet or web navigator.share.
 */
export async function shareChallenge(challenge: { id: string; title: string }): Promise<boolean> {
  const { shareMessage, primaryUrl } = getChallengeInviteUrls(challenge);

  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && (navigator as any).share) {
    try {
      await (navigator as any).share({
        title: `DareDrop: ${challenge.title}`,
        text: shareMessage,
        url: primaryUrl,
      });
      return true;
    } catch {
      // User dismissed share dialog
      return false;
    }
  }

  try {
    const result = await Share.share(
      {
        message: shareMessage,
        title: `Join "${challenge.title}" on DareDrop`,
        url: Platform.OS === 'ios' ? primaryUrl : undefined,
      },
      {
        dialogTitle: `Invite friends to "${challenge.title}"`,
      },
    );
    return result.action === Share.sharedAction;
  } catch {
    return false;
  }
}

export interface ProofShareOptions {
  challengeTitle: string;
  completionDate?: string;
  note?: string;
  verifierName?: string;
}

/**
 * Opens WhatsApp with a pre-filled peer-verification proof message.
 * Proof photos/videos are shared directly peer-to-peer via WhatsApp,
 * keeping the DareDrop database zero-media and privacy-first.
 */
export async function openWhatsAppProofShare(options: ProofShareOptions): Promise<boolean> {
  const dateStr = options.completionDate ? ` for ${options.completionDate}` : '';
  const noteStr = options.note ? `\n\nNotes: "${options.note}"` : '';
  const message = `👋 Hey ${options.verifierName || 'Verifier'}! I just submitted my DareDrop completion${dateStr} for "${options.challengeTitle}".${noteStr}\n\nHere is my proof photo/video 📸👇 Please verify it on DareDrop!`;
  const url = `https://wa.me/?text=${encodeURIComponent(message)}`;

  try {
    const supported = await Linking.canOpenURL(url);
    if (supported) {
      await Linking.openURL(url);
      return true;
    }
  } catch {
    // If canOpenURL check is restricted on iOS, attempt direct open
    try {
      await Linking.openURL(url);
      return true;
    } catch {
      // Fall through
    }
  }
  return false;
}

