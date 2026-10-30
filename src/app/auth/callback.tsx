import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';

import { DD } from '@/constants/dd-theme';
import { exchangeOAuthCode, useAuth } from '@/lib/auth-context';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

interface AuthCallbackParams {
  code?: string;
  error?: string;
  error_code?: string;
  error_description?: string;
}

export default function AuthCallbackScreen() {
  const params = useLocalSearchParams() as unknown as AuthCallbackParams;
  const { isRegistered } = useAuth();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const exchangeAttempted = useRef(false);
  const hasNavigated = useRef(false);

  const navigateHome = () => {
    if (hasNavigated.current) return;
    hasNavigated.current = true;

    if (Platform.OS !== 'web' && router.canDismiss()) {
      router.dismissAll();
    } else {
      router.replace('/(tabs)');
    }
  };

  // Precedence: confirmed authenticated session immediately navigates Home
  useEffect(() => {
    if (isRegistered) {
      navigateHome();
    }
  }, [isRegistered]);

  useEffect(() => {
    // Notify any pending WebBrowser.openAuthSessionAsync that auth redirect completed
    WebBrowser.maybeCompleteAuthSession();

    async function processCallback() {
      // If already registered, do not process or flash error
      if (isRegistered) {
        setStatus('success');
        navigateHome();
        return;
      }

      // Guard: exchange the authorization code only once per mount
      if (exchangeAttempted.current) return;
      exchangeAttempted.current = true;

      if (!isSupabaseConfigured || !supabase) {
        setStatus('error');
        setErrorMessage('Supabase is not configured.');
        return;
      }

      try {
        // 1. Check for query parameter errors from OAuth provider or Supabase
        if (params.error || params.error_description) {
          // Precedence: check if active registered session exists before showing error
          const { data: sData } = await supabase.auth.getSession();
          if (sData?.session?.user && !sData.session.user.is_anonymous) {
            setStatus('success');
            navigateHome();
            return;
          }

          const desc = params.error_description
            ? decodeURIComponent(params.error_description).replace(/\+/g, ' ')
            : params.error || 'Authentication failed.';
          setStatus('error');
          setErrorMessage(desc);
          return;
        }

        // 2. Check for hash parameters on web (implicit flow or error fragment)
        if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location.hash) {
          const hashString = window.location.hash.substring(1);
          const hashParams = new URLSearchParams(hashString);

          const hashError = hashParams.get('error_description') || hashParams.get('error');
          if (hashError) {
            const { data: sData } = await supabase.auth.getSession();
            if (sData?.session?.user && !sData.session.user.is_anonymous) {
              setStatus('success');
              navigateHome();
              return;
            }
            setStatus('error');
            setErrorMessage(decodeURIComponent(hashError).replace(/\+/g, ' '));
            return;
          }

          const accessToken = hashParams.get('access_token');
          const refreshToken = hashParams.get('refresh_token');
          if (accessToken && refreshToken) {
            const { data, error } = await supabase.auth.setSession({
              access_token: accessToken,
              refresh_token: refreshToken,
            });
            if (error) {
              const { data: sData } = await supabase.auth.getSession();
              if (sData?.session?.user && !sData.session.user.is_anonymous) {
                setStatus('success');
                navigateHome();
                return;
              }
              setStatus('error');
              setErrorMessage(error.message);
              return;
            }
            if (data.session) {
              setStatus('success');
              navigateHome();
              return;
            }
          }
        }

        // 3. PKCE code flow: exchange authorization code via deduplicated coordinator
        const authCode = params.code;
        if (authCode) {
          const res = await exchangeOAuthCode(authCode);

          if (res.success) {
            setStatus('success');
            navigateHome();
            return;
          }

          // If code exchange returned an error, verify if session was established concurrently
          const { data: sData } = await supabase.auth.getSession();
          if (sData?.session?.user && !sData.session.user.is_anonymous) {
            setStatus('success');
            navigateHome();
            return;
          }

          // Allow in-flight session to settle before declaring terminal error
          await new Promise((resolve) => setTimeout(resolve, 350));
          const { data: retrySession } = await supabase.auth.getSession();
          if (retrySession?.session?.user && !retrySession.session.user.is_anonymous) {
            setStatus('success');
            navigateHome();
            return;
          }

          setStatus('error');
          setErrorMessage(res.error || 'Failed to exchange authorization code for session.');
          return;
        }

        // 4. Fallback check: see if a registered session already exists
        const { data: existingSession } = await supabase.auth.getSession();
        if (existingSession?.session?.user && !existingSession.session.user.is_anonymous) {
          setStatus('success');
          navigateHome();
          return;
        }

        // Allow any active in-flight login to settle before declaring terminal error
        await new Promise((resolve) => setTimeout(resolve, 350));
        const { data: retrySession } = await supabase.auth.getSession();
        if (retrySession?.session?.user && !retrySession.session.user.is_anonymous) {
          setStatus('success');
          navigateHome();
          return;
        }

        setStatus('error');
        setErrorMessage('No authorization code or active session found in the callback.');
      } catch (err: any) {
        // Precedence: check if active registered session exists before showing error
        const { data: sData } = await supabase.auth.getSession();
        if (sData?.session?.user && !sData.session.user.is_anonymous) {
          setStatus('success');
          navigateHome();
          return;
        }
        console.warn('[DareDrop Auth Callback] Error processing callback:', err);
        setStatus('error');
        setErrorMessage(err?.message || 'An unexpected error occurred during authentication.');
      }
    }

    processCallback();
  }, [params.code, params.error, params.error_description, isRegistered]);

  // Precedence: if user is confirmed registered or status is success, never show error card
  if (isRegistered || status === 'success') {
    return (
      <View style={styles.root}>
        <ActivityIndicator size="large" color={DD.lime} />
        <Text style={styles.text}>Success! Redirecting...</Text>
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View style={styles.root}>
        <View style={styles.errorCard}>
          <Text style={styles.errorTitle}>Authentication Failed</Text>
          <Text style={styles.errorDescription}>{errorMessage}</Text>
          <Pressable
            style={({ pressed }) => [styles.actionButton, pressed && styles.actionButtonPressed]}
            onPress={() => {
              if (router.canGoBack()) {
                router.back();
              } else {
                router.replace('/auth');
              }
            }}>
            <Text style={styles.actionButtonText}>Return to Sign In</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <ActivityIndicator size="large" color={DD.lime} />
      <Text style={styles.text}>Signing you in to DareDrop...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: DD.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: DD.s5,
    gap: DD.s4,
  },
  text: {
    fontSize: 15,
    fontWeight: '600',
    color: DD.textSub,
  },
  errorCard: {
    backgroundColor: DD.bgCard,
    borderColor: DD.border,
    borderWidth: 1,
    borderRadius: DD.radiusCard,
    padding: DD.s6,
    width: '100%',
    maxWidth: 420,
    alignItems: 'center',
    gap: DD.s4,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: DD.danger,
    textAlign: 'center',
  },
  errorDescription: {
    fontSize: 14,
    color: DD.textSub,
    textAlign: 'center',
    lineHeight: 20,
  },
  actionButton: {
    marginTop: DD.s2,
    backgroundColor: DD.lime,
    paddingVertical: DD.s3,
    paddingHorizontal: DD.s6,
    borderRadius: DD.radiusPill,
    alignItems: 'center',
  },
  actionButtonPressed: {
    opacity: 0.85,
  },
  actionButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#000000',
  },
});
