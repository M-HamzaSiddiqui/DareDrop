import { router } from 'expo-router';
import React, { useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { DD } from '@/constants/dd-theme';
import { useAuth } from '@/lib/auth-context';

export function AuthPromptModal() {
  const {
    authModalVisible,
    authModalReason,
    hideAuthModal,
    signInWithGoogle,
    continueAsGuest,
    isAnonymous,
  } = useAuth();

  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(null);

  if (!authModalVisible) return null;

  const handleGooglePress = async () => {
    setIsGoogleLoading(true);
    setGoogleError(null);
    try {
      const res = await signInWithGoogle();
      if (!res.success && res.error) {
        setGoogleError(res.error);
      }
    } finally {
      setIsGoogleLoading(false);
    }
  };

  const handleEmailPress = () => {
    hideAuthModal();
    router.push('/auth');
  };

  return (
    <Modal
      visible={authModalVisible}
      transparent
      animationType="fade"
      onRequestClose={hideAuthModal}>
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={hideAuthModal} />

        <View style={styles.card}>
          {/* Header icon + brand */}
          <View style={styles.headerRow}>
            <View style={styles.brandBadge}>
              <Text style={styles.brandIcon}>🔥</Text>
              <Text style={styles.brandTitle}>DareDrop Account</Text>
            </View>
            <Pressable
              onPress={hideAuthModal}
              style={styles.closeBtn}
              accessibilityRole="button"
              accessibilityLabel="Close">
              <Text style={styles.closeBtnText}>✕</Text>
            </Pressable>
          </View>

          {/* Prompt reason & explanation */}
          <Text style={styles.title}>{authModalReason}</Text>
          <Text style={styles.subtitle}>
            Create an account or sign in to join challenges, submit proof, review friend dares, and earn streaks.
          </Text>

          {isAnonymous && (
            <View style={styles.anonymousBanner}>
              <Text style={styles.anonymousBannerIcon}>💡</Text>
              <Text style={styles.anonymousBannerText}>
                You have active guest progress! Registering or logging in with Google will save your existing dares and streaks to your account.
              </Text>
            </View>
          )}

          {googleError && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{googleError}</Text>
            </View>
          )}

          {/* Action buttons */}
          <View style={styles.buttonStack}>
            {/* Google OAuth Button */}
            <Pressable
              style={({ pressed }) => [styles.googleBtn, pressed && { opacity: 0.85 }]}
              onPress={handleGooglePress}
              disabled={isGoogleLoading}>
              {isGoogleLoading ? (
                <ActivityIndicator color="#FFFFFF" size="small" />
              ) : (
                <>
                  <Text style={styles.googleIconText}>G</Text>
                  <Text style={styles.googleBtnText}>Continue with Google</Text>
                </>
              )}
            </Pressable>

            {/* Email/Password Button */}
            <Pressable
              style={({ pressed }) => [styles.emailBtn, pressed && { opacity: 0.85 }]}
              onPress={handleEmailPress}>
              <Text style={styles.emailBtnText}>Sign In or Register with Email</Text>
            </Pressable>

            {/* Guest Dismiss Button */}
            <Pressable
              style={({ pressed }) => [styles.guestBtn, pressed && { opacity: 0.7 }]}
              onPress={continueAsGuest}>
              <Text style={styles.guestBtnText}>Keep Browsing as Guest</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(5, 5, 10, 0.82)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: DD.s4,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    borderWidth: 1,
    borderColor: DD.border,
    padding: DD.s6,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.45,
        shadowRadius: 20,
      },
      android: {
        elevation: 12,
      },
      web: {
        boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
      },
    }),
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: DD.s4,
  },
  brandBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: DD.bgElement,
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s1,
    borderRadius: DD.radiusPill,
    gap: DD.s2,
  },
  brandIcon: {
    fontSize: 16,
  },
  brandTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: DD.lime,
    letterSpacing: 0.3,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: DD.bgElement,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeBtnText: {
    color: DD.textSub,
    fontSize: 14,
    fontWeight: '600',
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    color: DD.text,
    marginBottom: DD.s2,
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 14,
    color: DD.textSub,
    lineHeight: 20,
    marginBottom: DD.s5,
  },
  anonymousBanner: {
    flexDirection: 'row',
    backgroundColor: 'rgba(155, 89, 255, 0.12)',
    borderRadius: DD.radiusMd,
    borderWidth: 1,
    borderColor: 'rgba(155, 89, 255, 0.35)',
    padding: DD.s3,
    gap: DD.s2,
    marginBottom: DD.s4,
  },
  anonymousBannerIcon: {
    fontSize: 16,
  },
  anonymousBannerText: {
    flex: 1,
    fontSize: 12,
    color: '#D8B4FE',
    lineHeight: 17,
  },
  errorBox: {
    backgroundColor: 'rgba(255, 68, 102, 0.12)',
    borderRadius: DD.radiusMd,
    borderWidth: 1,
    borderColor: 'rgba(255, 68, 102, 0.35)',
    padding: DD.s3,
    marginBottom: DD.s4,
  },
  errorText: {
    fontSize: 13,
    color: DD.danger,
    lineHeight: 18,
  },
  buttonStack: {
    gap: DD.s3,
  },
  googleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: DD.radiusLg,
    paddingVertical: DD.s3 + 2,
    gap: DD.s2,
  },
  googleIconText: {
    fontSize: 16,
    fontWeight: '900',
    color: '#1A1A26',
  },
  googleBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1A1A26',
  },
  emailBtn: {
    backgroundColor: DD.bgElement,
    borderRadius: DD.radiusLg,
    borderWidth: 1,
    borderColor: DD.lime,
    paddingVertical: DD.s3 + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emailBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: DD.lime,
  },
  guestBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: DD.s2,
  },
  guestBtnText: {
    fontSize: 13,
    color: DD.textMuted,
    fontWeight: '600',
  },
});
