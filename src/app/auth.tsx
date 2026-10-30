import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DD } from '@/constants/dd-theme';
import { useAuth } from '@/lib/auth-context';

type AuthMode = 'login' | 'signup' | 'forgot';

export default function AuthScreen() {
  const insets = useSafeAreaInsets();
  const {
    signInWithEmail,
    signUpWithEmail,
    signInWithGoogle,
    linkWithGoogle,
    resetPassword,
    continueAsGuest,
    isAnonymous,
    isRegistered,
  } = useAuth();

  const [mode, setMode] = useState<AuthMode>('login');

  // Form fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // States
  const [isLoading, setIsLoading] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const hasDismissed = useRef(false);

  const showGoogleSpinner = isGoogleLoading && !isRegistered;

  const dismissAuth = () => {
    if (hasDismissed.current) return;
    hasDismissed.current = true;
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(tabs)');
    }
  };

  // Automatically dismiss the auth modal/screen upon confirmed authentication
  useEffect(() => {
    if (isRegistered) {
      dismissAuth();
    }
  }, [isRegistered]);

  const resetMessages = () => {
    setErrorMessage(null);
    setSuccessMessage(null);
  };

  const handleTabSwitch = (newMode: AuthMode) => {
    setMode(newMode);
    resetMessages();
  };

  const validateEmail = (val: string): boolean => {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val.trim());
  };

  const handleSubmit = async () => {
    resetMessages();

    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setErrorMessage('Please enter your email address.');
      return;
    }

    if (!validateEmail(trimmedEmail)) {
      setErrorMessage('Please enter a valid email address.');
      return;
    }

    if (mode === 'forgot') {
      setIsLoading(true);
      try {
        const res = await resetPassword(trimmedEmail);
        if (res.success) {
          setSuccessMessage('Password recovery email sent! Check your inbox for reset instructions.');
        } else {
          setErrorMessage(res.error || 'Failed to send password reset email.');
        }
      } finally {
        setIsLoading(false);
      }
      return;
    }

    if (!password) {
      setErrorMessage('Please enter your password.');
      return;
    }

    if (mode === 'signup') {
      if (password.length < 8) {
        setErrorMessage('Password must be at least 8 characters long.');
        return;
      }
      if (password !== confirmPassword) {
        setErrorMessage('Passwords do not match. Please re-enter your password.');
        return;
      }

      setIsLoading(true);
      try {
        const res = await signUpWithEmail(trimmedEmail, password);
        if (res.success) {
          if (res.upgraded) {
            setSuccessMessage('🎉 Account successfully upgraded! All your dares and streaks are saved.');
            setTimeout(() => {
              dismissAuth();
            }, 1200);
          } else if (res.needsEmailVerification) {
            setSuccessMessage('Account created! Please check your email to confirm your account before logging in.');
          } else {
            setSuccessMessage('Welcome to DareDrop!');
            setTimeout(() => {
              dismissAuth();
            }, 800);
          }
        } else {
          setErrorMessage(res.error || 'Registration failed.');
        }
      } finally {
        setIsLoading(false);
      }
      return;
    }

    // Login mode
    if (isAnonymous) {
      // Warn existing anonymous users about account switching
      const proceed = await new Promise<boolean>((resolve) => {
        if (Platform.OS === 'web') {
          const ok = window.confirm(
            'Notice: You are currently on a guest profile with local progress. Logging into an existing account will switch to that account and will not merge this guest session. Continue?',
          );
          resolve(ok);
        } else {
          Alert.alert(
            'Switching Account',
            'You are currently on a guest profile with local progress. Logging into an existing account will switch to that account and will not merge this guest session. Continue?',
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
              { text: 'Log In & Switch', style: 'destructive', onPress: () => resolve(true) },
            ],
          );
        }
      });
      if (!proceed) return;
    }

    setIsLoading(true);
    try {
      const res = await signInWithEmail(trimmedEmail, password);
      if (res.success) {
        setSuccessMessage('Welcome back!');
        setTimeout(() => {
          dismissAuth();
        }, 600);
      } else {
        setErrorMessage(res.error || 'Login failed. Check your credentials.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    resetMessages();

    // If currently holding an anonymous guest session, warn that signing in switches accounts
    if (isAnonymous) {
      const proceed = await new Promise<boolean>((resolve) => {
        if (Platform.OS === 'web') {
          const ok = window.confirm(
            'Notice: You are currently on a guest profile with local progress. Signing into an existing Google account will switch to that account and will not merge this guest session. Continue?',
          );
          resolve(ok);
        } else {
          Alert.alert(
            'Switching Account',
            'You are currently on a guest profile with local progress. Signing into an existing Google account will switch to that account and will not merge this guest session. Continue?',
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
              { text: 'Sign In & Switch', style: 'destructive', onPress: () => resolve(true) },
            ],
          );
        }
      });
      if (!proceed) return;
    }

    setIsGoogleLoading(true);
    try {
      const res = await signInWithGoogle({ forceSignIn: true });
      if (res.redirecting) {
        // Browser navigation to Google OAuth is in progress; leave spinner active until page unloads
        return;
      }
      if (res.success) {
        setSuccessMessage('Welcome back!');
        setTimeout(() => {
          dismissAuth();
        }, 600);
      } else if (res.error) {
        if (!isRegistered) {
          setErrorMessage(res.error);
        } else {
          dismissAuth();
        }
        setIsGoogleLoading(false);
      } else {
        setIsGoogleLoading(false);
      }
    } catch {
      setIsGoogleLoading(false);
    }
  };

  const handleGoogleLink = async () => {
    resetMessages();
    setIsGoogleLoading(true);
    try {
      const res = await linkWithGoogle();
      if (res.redirecting) {
        return;
      }
      if (res.success) {
        setSuccessMessage('🎉 Google account linked! Your dares and streaks are preserved.');
        setTimeout(() => {
          dismissAuth();
        }, 600);
      } else if (res.error) {
        if (!isRegistered) {
          setErrorMessage(res.error);
        } else {
          dismissAuth();
        }
        setIsGoogleLoading(false);
      } else {
        setIsGoogleLoading(false);
      }
    } catch {
      setIsGoogleLoading(false);
    }
  };

  const handleGuestContinue = () => {
    continueAsGuest();
    dismissAuth();
  };

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar style="light" />

      {/* Background ambient accents */}
      <View style={styles.ambientGlowTop} pointerEvents="none" />
      <View style={styles.ambientGlowBottom} pointerEvents="none" />

      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingTop: insets.top + DD.s6, paddingBottom: insets.bottom + DD.s8 },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        {/* Top bar with back / dismiss if stack can go back */}
        <View style={styles.topBar}>
          <Pressable
            onPress={handleGuestContinue}
            style={styles.topBackBtn}
            accessibilityRole="button"
            accessibilityLabel="Close">
            <Text style={styles.topBackText}>✕</Text>
          </Pressable>
        </View>

        {/* Brand header */}
        <View style={styles.brandingSection}>
          <View style={styles.logoBadge}>
            <Text style={styles.logoIcon}>🔥</Text>
          </View>
          <Text style={styles.brandTitle}>DareDrop</Text>
          <Text style={styles.brandTagline}>Level up your life with social peer challenges</Text>
        </View>

        {/* Existing anonymous user upgrade banner */}
        {isAnonymous && mode === 'signup' && (
          <View style={styles.anonymousUpgradeNotice}>
            <Text style={styles.upgradeNoticeIcon}>✨</Text>
            <View style={styles.upgradeNoticeContent}>
              <Text style={styles.upgradeNoticeTitle}>Save your guest progress</Text>
              <Text style={styles.upgradeNoticeDesc}>
                Creating an account now will link your existing dares, verifications, and streak records to this permanent account!
              </Text>
            </View>
          </View>
        )}

        {/* Main Card */}
        <View style={styles.card}>
          {/* Segmented Mode Selector */}
          {mode !== 'forgot' ? (
            <View style={styles.tabsRow}>
              <Pressable
                style={[styles.tabBtn, mode === 'login' && styles.tabBtnActive]}
                onPress={() => handleTabSwitch('login')}>
                <Text style={[styles.tabBtnText, mode === 'login' && styles.tabBtnTextActive]}>
                  Log In
                </Text>
              </Pressable>
              <Pressable
                style={[styles.tabBtn, mode === 'signup' && styles.tabBtnActive]}
                onPress={() => handleTabSwitch('signup')}>
                <Text style={[styles.tabBtnText, mode === 'signup' && styles.tabBtnTextActive]}>
                  {isAnonymous ? 'Upgrade Account' : 'Create Account'}
                </Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.forgotHeaderRow}>
              <Pressable onPress={() => handleTabSwitch('login')} style={styles.forgotBackBtn}>
                <Text style={styles.forgotBackArrow}>‹</Text>
                <Text style={styles.forgotBackText}>Back to Log In</Text>
              </Pressable>
            </View>
          )}

          {/* Form title */}
          <Text style={styles.formTitle}>
            {mode === 'login'
              ? 'Welcome back'
              : mode === 'signup'
                ? isAnonymous
                  ? 'Upgrade to permanent account'
                  : 'Create your DareDrop account'
                : 'Reset your password'}
          </Text>
          <Text style={styles.formSubtitle}>
            {mode === 'login'
              ? 'Enter your credentials to access your account'
              : mode === 'signup'
                ? 'Join dares, track streaks, and verify friends'
                : 'Enter your email and we will send you a recovery link'}
          </Text>

          {/* Messages */}
          {errorMessage && (
            <View style={styles.errorAlert}>
              <Text style={styles.errorAlertIcon}>⚠️</Text>
              <Text style={styles.errorAlertText}>{errorMessage}</Text>
            </View>
          )}

          {successMessage && (
            <View style={styles.successAlert}>
              <Text style={styles.successAlertIcon}>✅</Text>
              <Text style={styles.successAlertText}>{successMessage}</Text>
            </View>
          )}

          {/* Input Fields */}
          <View style={styles.inputsStack}>
            {/* Email Field */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Email Address</Text>
              <TextInput
                style={styles.input}
                value={email}
                onChangeText={(val) => {
                  setEmail(val);
                  resetMessages();
                }}
                placeholder="name@example.com"
                placeholderTextColor={DD.textMuted}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
              />
            </View>

            {/* Password Field (for login & signup) */}
            {mode !== 'forgot' && (
              <View style={styles.inputGroup}>
                <View style={styles.inputLabelRow}>
                  <Text style={styles.inputLabel}>Password</Text>
                  {mode === 'login' && (
                    <Pressable onPress={() => handleTabSwitch('forgot')}>
                      <Text style={styles.forgotLinkText}>Forgot Password?</Text>
                    </Pressable>
                  )}
                </View>
                <View style={styles.passwordInputWrap}>
                  <TextInput
                    style={[styles.input, styles.passwordInput]}
                    value={password}
                    onChangeText={(val) => {
                      setPassword(val);
                      resetMessages();
                    }}
                    placeholder={mode === 'signup' ? 'Minimum 8 characters' : 'Enter password'}
                    placeholderTextColor={DD.textMuted}
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <Pressable
                    style={styles.passwordToggleBtn}
                    onPress={() => setShowPassword((p) => !p)}>
                    <Text style={styles.passwordToggleText}>{showPassword ? 'Hide' : 'Show'}</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* Confirm Password Field (for signup only) */}
            {mode === 'signup' && (
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Confirm Password</Text>
                <TextInput
                  style={styles.input}
                  value={confirmPassword}
                  onChangeText={(val) => {
                    setConfirmPassword(val);
                    resetMessages();
                  }}
                  placeholder="Re-enter password"
                  placeholderTextColor={DD.textMuted}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </View>
            )}

            {/* Submit Primary Button */}
            <Pressable
              style={({ pressed }) => [
                styles.primaryBtn,
                pressed && { opacity: 0.85 },
                isLoading && styles.primaryBtnDisabled,
              ]}
              onPress={handleSubmit}
              disabled={isLoading}>
              {isLoading ? (
                <ActivityIndicator color="#0A0A0F" size="small" />
              ) : (
                <Text style={styles.primaryBtnText}>
                  {mode === 'login'
                    ? 'Log In'
                    : mode === 'signup'
                      ? isAnonymous
                        ? 'Upgrade Account'
                        : 'Create Account'
                      : 'Send Reset Link'}
                </Text>
              )}
            </Pressable>
          </View>

          {/* Social OAuth Section (only on login & signup) */}
          {mode !== 'forgot' && (
            <>
              <View style={styles.dividerRow}>
                <View style={styles.dividerLine} />
                <Text style={styles.dividerText}>OR</Text>
                <View style={styles.dividerLine} />
              </View>

              {mode === 'login' ? (
                <>
                  <Pressable
                    style={({ pressed }) => [
                      styles.googleBtn,
                      pressed && { opacity: 0.85 },
                      showGoogleSpinner && styles.googleBtnDisabled,
                    ]}
                    onPress={handleGoogleSignIn}
                    disabled={showGoogleSpinner || isRegistered}>
                    {showGoogleSpinner ? (
                      <ActivityIndicator color="#1A1A26" size="small" />
                    ) : (
                      <>
                        <View style={styles.googleIconBadge}>
                          <Text style={styles.googleIconChar}>G</Text>
                        </View>
                        <Text style={styles.googleBtnText}>Sign in with Google</Text>
                      </>
                    )}
                  </Pressable>

                  {isAnonymous && (
                    <View style={styles.oauthHintRow}>
                      <Text style={styles.oauthHintText}>Want to save your current guest dares instead? </Text>
                      <Pressable onPress={() => handleTabSwitch('signup')}>
                        <Text style={styles.oauthHintLink}>Link Google</Text>
                      </Pressable>
                    </View>
                  )}
                </>
              ) : isAnonymous ? (
                <>
                  <Pressable
                    style={({ pressed }) => [
                      styles.googleBtn,
                      pressed && { opacity: 0.85 },
                      showGoogleSpinner && styles.googleBtnDisabled,
                    ]}
                    onPress={handleGoogleLink}
                    disabled={showGoogleSpinner || isRegistered}>
                    {showGoogleSpinner ? (
                      <ActivityIndicator color="#1A1A26" size="small" />
                    ) : (
                      <>
                        <View style={styles.googleIconBadge}>
                          <Text style={styles.googleIconChar}>G</Text>
                        </View>
                        <Text style={styles.googleBtnText}>Link Google to this Account</Text>
                      </>
                    )}
                  </Pressable>

                  <View style={styles.oauthHintRow}>
                    <Text style={styles.oauthHintText}>Already have a DareDrop account? </Text>
                    <Pressable onPress={() => handleTabSwitch('login')}>
                      <Text style={styles.oauthHintLink}>Sign in with Google</Text>
                    </Pressable>
                  </View>
                </>
              ) : (
                <Pressable
                  style={({ pressed }) => [
                    styles.googleBtn,
                    pressed && { opacity: 0.85 },
                    showGoogleSpinner && styles.googleBtnDisabled,
                  ]}
                  onPress={handleGoogleSignIn}
                  disabled={showGoogleSpinner || isRegistered}>
                  {showGoogleSpinner ? (
                    <ActivityIndicator color="#1A1A26" size="small" />
                  ) : (
                    <>
                      <View style={styles.googleIconBadge}>
                        <Text style={styles.googleIconChar}>G</Text>
                      </View>
                      <Text style={styles.googleBtnText}>Continue with Google</Text>
                    </>
                  )}
                </Pressable>
              )}
            </>
          )}

          {/* Continue as Guest Button */}
          <View style={styles.guestSection}>
            <Pressable
              style={({ pressed }) => [styles.guestBtn, pressed && { opacity: 0.7 }]}
              onPress={handleGuestContinue}>
              <Text style={styles.guestBtnText}>Continue as Guest →</Text>
            </Pressable>
            <Text style={styles.guestNoteText}>
              Explore public challenges without signing in. You can register anytime.
            </Text>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: DD.bg,
  },
  ambientGlowTop: {
    position: 'absolute',
    top: -80,
    right: -40,
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: 'rgba(191, 253, 64, 0.08)',
  },
  ambientGlowBottom: {
    position: 'absolute',
    bottom: -60,
    left: -40,
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: 'rgba(155, 89, 255, 0.1)',
  },
  scrollContent: {
    paddingHorizontal: DD.s4,
    alignItems: 'center',
  },
  topBar: {
    width: '100%',
    maxWidth: 440,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: DD.s2,
  },
  topBackBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: DD.bgCard,
    borderWidth: 1,
    borderColor: DD.border,
    justifyContent: 'center',
    alignItems: 'center',
  },
  topBackText: {
    color: DD.textSub,
    fontSize: 16,
    fontWeight: '600',
  },
  brandingSection: {
    alignItems: 'center',
    marginBottom: DD.s6,
  },
  logoBadge: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: DD.bgCard,
    borderWidth: 1.5,
    borderColor: DD.lime,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: DD.s3,
    ...Platform.select({
      ios: {
        shadowColor: DD.lime,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 10,
      },
      android: {
        elevation: 6,
      },
    }),
  },
  logoIcon: {
    fontSize: 28,
  },
  brandTitle: {
    fontSize: 28,
    fontWeight: '900',
    color: DD.text,
    letterSpacing: -0.5,
    marginBottom: DD.s1,
  },
  brandTagline: {
    fontSize: 14,
    color: DD.textSub,
    textAlign: 'center',
  },
  anonymousUpgradeNotice: {
    width: '100%',
    maxWidth: 440,
    flexDirection: 'row',
    backgroundColor: 'rgba(155, 89, 255, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(155, 89, 255, 0.45)',
    borderRadius: DD.radiusLg,
    padding: DD.s4,
    gap: DD.s3,
    marginBottom: DD.s4,
  },
  upgradeNoticeIcon: {
    fontSize: 20,
  },
  upgradeNoticeContent: {
    flex: 1,
  },
  upgradeNoticeTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#D8B4FE',
    marginBottom: 2,
  },
  upgradeNoticeDesc: {
    fontSize: 12,
    color: DD.textSub,
    lineHeight: 17,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    borderWidth: 1,
    borderColor: DD.border,
    padding: DD.s6,
  },
  tabsRow: {
    flexDirection: 'row',
    backgroundColor: DD.bgElement,
    borderRadius: DD.radiusPill,
    padding: 4,
    marginBottom: DD.s5,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: DD.s2 + 2,
    alignItems: 'center',
    borderRadius: DD.radiusPill,
  },
  tabBtnActive: {
    backgroundColor: DD.bgCard,
    borderWidth: 1,
    borderColor: DD.border,
  },
  tabBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: DD.textMuted,
  },
  tabBtnTextActive: {
    color: DD.lime,
    fontWeight: '700',
  },
  forgotHeaderRow: {
    marginBottom: DD.s4,
  },
  forgotBackBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s1,
  },
  forgotBackArrow: {
    fontSize: 20,
    color: DD.lime,
    fontWeight: '700',
  },
  forgotBackText: {
    fontSize: 13,
    color: DD.lime,
    fontWeight: '700',
  },
  formTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: DD.text,
    letterSpacing: -0.4,
    marginBottom: DD.s1,
  },
  formSubtitle: {
    fontSize: 13,
    color: DD.textSub,
    lineHeight: 18,
    marginBottom: DD.s5,
  },
  errorAlert: {
    flexDirection: 'row',
    backgroundColor: 'rgba(255, 68, 102, 0.12)',
    borderRadius: DD.radiusMd,
    borderWidth: 1,
    borderColor: 'rgba(255, 68, 102, 0.4)',
    padding: DD.s3,
    gap: DD.s2,
    marginBottom: DD.s4,
    alignItems: 'center',
  },
  errorAlertIcon: {
    fontSize: 14,
  },
  errorAlertText: {
    flex: 1,
    fontSize: 13,
    color: DD.danger,
    lineHeight: 18,
    fontWeight: '500',
  },
  successAlert: {
    flexDirection: 'row',
    backgroundColor: 'rgba(74, 230, 138, 0.12)',
    borderRadius: DD.radiusMd,
    borderWidth: 1,
    borderColor: 'rgba(74, 230, 138, 0.4)',
    padding: DD.s3,
    gap: DD.s2,
    marginBottom: DD.s4,
    alignItems: 'center',
  },
  successAlertIcon: {
    fontSize: 14,
  },
  successAlertText: {
    flex: 1,
    fontSize: 13,
    color: DD.success,
    lineHeight: 18,
    fontWeight: '500',
  },
  inputsStack: {
    gap: DD.s4,
  },
  inputGroup: {
    gap: DD.s2,
  },
  inputLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: DD.text,
  },
  forgotLinkText: {
    fontSize: 12,
    fontWeight: '600',
    color: DD.purple,
  },
  input: {
    backgroundColor: DD.bgElement,
    borderRadius: DD.radiusLg,
    borderWidth: 1,
    borderColor: DD.border,
    paddingHorizontal: DD.s4,
    paddingVertical: DD.s3 + 2,
    fontSize: 15,
    color: DD.text,
  },
  passwordInputWrap: {
    position: 'relative',
    justifyContent: 'center',
  },
  passwordInput: {
    paddingRight: 60,
  },
  passwordToggleBtn: {
    position: 'absolute',
    right: DD.s3,
    paddingHorizontal: DD.s2,
    paddingVertical: DD.s1,
  },
  passwordToggleText: {
    fontSize: 12,
    fontWeight: '700',
    color: DD.textSub,
  },
  primaryBtn: {
    backgroundColor: DD.lime,
    borderRadius: DD.radiusLg,
    paddingVertical: DD.s4,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: DD.s2,
    ...Platform.select({
      ios: {
        shadowColor: DD.lime,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
      },
      android: {
        elevation: 4,
      },
    }),
  },
  primaryBtnDisabled: {
    opacity: 0.6,
  },
  primaryBtnText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#0A0A0F',
    letterSpacing: 0.2,
  },
  dividerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: DD.s5,
    gap: DD.s3,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: DD.border,
  },
  dividerText: {
    fontSize: 11,
    fontWeight: '700',
    color: DD.textMuted,
    letterSpacing: 0.5,
  },
  googleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: DD.radiusLg,
    paddingVertical: DD.s3 + 2,
    gap: DD.s3,
  },
  googleBtnDisabled: {
    opacity: 0.6,
  },
  googleIconBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#EA4335',
    justifyContent: 'center',
    alignItems: 'center',
  },
  googleIconChar: {
    fontSize: 13,
    fontWeight: '900',
    color: '#FFFFFF',
  },
  googleBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1A1A26',
  },
  oauthHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: DD.s3,
    flexWrap: 'wrap',
  },
  oauthHintText: {
    fontSize: 12,
    color: DD.textMuted,
  },
  oauthHintLink: {
    fontSize: 12,
    fontWeight: '700',
    color: DD.lime,
  },
  guestSection: {
    marginTop: DD.s6,
    paddingTop: DD.s4,
    borderTopWidth: 1,
    borderTopColor: DD.border,
    alignItems: 'center',
    gap: DD.s2,
  },
  guestBtn: {
    paddingVertical: DD.s2,
    paddingHorizontal: DD.s4,
  },
  guestBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: DD.textSub,
  },
  guestNoteText: {
    fontSize: 11,
    color: DD.textMuted,
    textAlign: 'center',
    lineHeight: 16,
    maxWidth: 280,
  },
});
