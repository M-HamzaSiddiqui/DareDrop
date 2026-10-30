import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import type { Session, User } from '@supabase/supabase-js';

import { isSupabaseConfigured, supabase } from './supabase';
import { unregisterDevicePushTokenAsync } from './notifications';

WebBrowser.maybeCompleteAuthSession();

export type AuthStatus = 'loading' | 'guest' | 'anonymous' | 'authenticated';

export type AuthPromptOptions =
  | string
  | {
      title?: string;
      description?: string;
      reason?: string;
      onSuccess?: () => void;
      onAuthenticated?: () => void;
    };

export interface AuthContextValue {
  user: User | null;
  session: Session | null;
  authStatus: AuthStatus;
  isGuest: boolean;        // true if not a full registered account (guest or anonymous)
  isAnonymous: boolean;    // true if currently holding an anonymous Supabase session
  isRegistered: boolean;   // true if logged in with email/password or Google OAuth
  currentUserId: string;   // active Supabase user ID, or empty string if unauthenticated guest
  userEmail: string | null;
  userDisplayName: string | null;
  avatarUrl: string | null;

  // Authentication actions
  signInWithEmail: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  signUpWithEmail: (email: string, password: string) => Promise<{
    success: boolean;
    error?: string;
    upgraded?: boolean;
    needsEmailVerification?: boolean;
  }>;
  signInWithGoogle: (options?: { forceSignIn?: boolean }) => Promise<{
    success: boolean;
    error?: string;
    upgraded?: boolean;
    redirecting?: boolean;
  }>;
  linkWithGoogle: () => Promise<{
    success: boolean;
    error?: string;
    upgraded?: boolean;
    redirecting?: boolean;
  }>;
  resetPassword: (email: string) => Promise<{ success: boolean; error?: string }>;
  signOut: () => Promise<void>;
  continueAsGuest: () => void;

  // Interceptor modal for restricted actions
  authModalVisible: boolean;
  authModalReason: string;
  showAuthModal: (options?: AuthPromptOptions, onAuthenticated?: () => void) => void;
  hideAuthModal: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const GUEST_BROWSED_KEY = '@daredrop/guest_browsed_v1';

const inFlightExchanges = new Map<string, Promise<{ success: boolean; error?: string }>>();
const completedCodes = new Set<string>();

/**
 * Deduplicated OAuth authorization code exchange.
 * Guarantees that single-use PKCE codes are sent to Supabase only once,
 * even when both WebBrowser.openAuthSessionAsync and the Android deep link intent
 * receive the callback URL concurrently.
 */
export async function exchangeOAuthCode(code: string): Promise<{ success: boolean; error?: string }> {
  if (!supabase) return { success: false, error: 'Supabase is not configured' };
  if (!code) return { success: false, error: 'No authorization code provided' };

  // If this code was already successfully exchanged, check active registered session
  if (completedCodes.has(code)) {
    const { data } = await supabase.auth.getSession();
    if (data?.session?.user && !data.session.user.is_anonymous) {
      return { success: true };
    }
  }

  // If an exchange for this code is already in flight, share the existing promise
  const inFlight = inFlightExchanges.get(code);
  if (inFlight) {
    return inFlight;
  }

  const exchangePromise = (async () => {
    try {
      const { data, error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error && data?.session?.user && !data.session.user.is_anonymous) {
        completedCodes.add(code);
        return { success: true };
      }

      // Check if session was updated/established (e.g. concurrent write or identity link)
      const { data: sData } = await supabase.auth.getSession();
      if (sData?.session?.user && !sData.session.user.is_anonymous) {
        completedCodes.add(code);
        return { success: true };
      }

      return {
        success: false,
        error: error?.message || 'Failed to exchange authorization code for session.',
      };
    } catch (err: any) {
      const { data: sData } = await supabase.auth.getSession();
      if (sData?.session?.user && !sData.session.user.is_anonymous) {
        completedCodes.add(code);
        return { success: true };
      }
      return { success: false, error: err?.message || 'An error occurred during code exchange.' };
    } finally {
      inFlightExchanges.delete(code);
    }
  })();

  inFlightExchanges.set(code, exchangePromise);
  return exchangePromise;
}

async function handleOAuthCallbackUrl(urlStr: string): Promise<boolean> {
  if (!supabase) return false;
  try {
    // 1. Check for query parameters (PKCE code flow: ?code=...)
    const parsed = Linking.parse(urlStr);
    const code = (parsed.queryParams?.code as string) || '';
    if (code) {
      const res = await exchangeOAuthCode(code);
      if (res.success) return true;
      const { data: sData } = await supabase.auth.getSession();
      if (sData?.session?.user && !sData.session.user.is_anonymous) return true;
    }

    // 2. Check for hash parameters (implicit token flow: #access_token=...&refresh_token=...)
    const hashIndex = urlStr.indexOf('#');
    if (hashIndex !== -1) {
      const hashPart = urlStr.substring(hashIndex + 1);
      const params = new URLSearchParams(hashPart);
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      if (accessToken && refreshToken) {
        const { data, error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        if (!error && data.session) return true;
        const { data: sData } = await supabase.auth.getSession();
        if (sData?.session?.user && !sData.session.user.is_anonymous) return true;
      }
    }
    return false;
  } catch (e) {
    console.warn('[DareDrop Auth] Error processing OAuth callback URL:', e);
    return false;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>('loading');

  // Modal prompt state
  const [authModalVisible, setAuthModalVisible] = useState(false);
  const [authModalReason, setAuthModalReason] = useState('Sign in to access this feature');
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  // Initialize session without automatically creating anonymous accounts
  useEffect(() => {
    let isMounted = true;

    async function initAuth() {
      if (!isSupabaseConfigured || !supabase) {
        if (isMounted) setAuthStatus('guest');
        return;
      }

      try {
        const { data: sessionData, error } = await supabase.auth.getSession();
        if (error) {
          console.warn('[DareDrop Auth] Error getting session:', error.message);
        }

        const activeSession = sessionData?.session || null;
        const activeUser = activeSession?.user || null;

        if (isMounted) {
          setSession(activeSession);
          setUser(activeUser);

          if (!activeUser) {
            // No session exists: browse safely as a guest.
            // DO NOT automatically create an anonymous account!
            setAuthStatus('guest');
          } else if (activeUser.is_anonymous) {
            // Existing anonymous session from prior sessions
            setAuthStatus('anonymous');
          } else {
            // Verified registered account (email/password or Google)
            setAuthStatus('authenticated');
          }
        }
      } catch (err) {
        console.warn('[DareDrop Auth] Session initialization error:', err);
        if (isMounted) setAuthStatus('guest');
      }
    }

    initAuth();

    if (isSupabaseConfigured && supabase) {
      const {
        data: { subscription },
      } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
        if (!isMounted) return;

        const newUser = newSession?.user || null;
        setSession(newSession);
        setUser(newUser);

        if (!newUser) {
          setAuthStatus('guest');
        } else if (newUser.is_anonymous) {
          setAuthStatus('anonymous');
        } else {
          setAuthStatus('authenticated');
          // If a pending action was queued, execute it
          if (pendingAction) {
            try {
              pendingAction();
            } catch {
              // Ignore
            }
            setPendingAction(null);
          }
        }
      });

      return () => {
        isMounted = false;
        subscription.unsubscribe();
      };
    }

    return () => {
      isMounted = false;
    };
  }, [pendingAction]);

  const continueAsGuest = useCallback(() => {
    setAuthStatus('guest');
    setAuthModalVisible(false);
    AsyncStorage.setItem(GUEST_BROWSED_KEY, 'true').catch(() => {});
  }, []);

  const showAuthModal = useCallback((options?: AuthPromptOptions, onAuthenticated?: () => void) => {
    if (typeof options === 'string') {
      setAuthModalReason(options);
      if (onAuthenticated) setPendingAction(() => onAuthenticated);
    } else if (options && typeof options === 'object') {
      const msg = options.description || options.reason || options.title || '';
      if (msg) setAuthModalReason(msg);
      const cb = options.onSuccess || options.onAuthenticated || onAuthenticated;
      if (cb) setPendingAction(() => cb);
    }
    setAuthModalVisible(true);
  }, []);

  const hideAuthModal = useCallback(() => {
    setAuthModalVisible(false);
    setPendingAction(null);
  }, []);

  const signInWithEmail = useCallback(async (email: string, password: string): Promise<{ success: boolean; error?: string }> => {
    if (!isSupabaseConfigured || !supabase) {
      return { success: false, error: 'Supabase is not configured' };
    }

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) return { success: false, error: 'Please enter your email address.' };
    if (!password) return { success: false, error: 'Please enter your password.' };

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: trimmedEmail,
        password,
      });

      if (error) {
        return { success: false, error: error.message };
      }

      if (data.session) {
        setSession(data.session);
        setUser(data.session.user);
        setAuthStatus('authenticated');
        setAuthModalVisible(false);
        return { success: true };
      }

      return { success: false, error: 'Login completed but no session was established.' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Login failed.' };
    }
  }, []);

  const signUpWithEmail = useCallback(
    async (
      email: string,
      password: string,
    ): Promise<{ success: boolean; error?: string; upgraded?: boolean; needsEmailVerification?: boolean }> => {
      if (!isSupabaseConfigured || !supabase) {
        return { success: false, error: 'Supabase is not configured' };
      }

      const trimmedEmail = email.trim().toLowerCase();
      if (!trimmedEmail) return { success: false, error: 'Please enter an email address.' };
      if (!password || password.length < 8) {
        return { success: false, error: 'Password must be at least 8 characters long.' };
      }

      try {
        // CASE A: Existing anonymous user upgrading in-place
        // Preserves exact user.id so all challenges, streaks, verifications, and progress are preserved!
        if (user && user.is_anonymous) {
          const { data, error } = await supabase.auth.updateUser({
            email: trimmedEmail,
            password,
          });

          if (error) {
            if (error.message.toLowerCase().includes('already') || error.status === 422) {
              return {
                success: false,
                error:
                  'An account with this email already exists. Log in instead to access that account, or use a different email to upgrade this profile.',
              };
            }
            return { success: false, error: error.message };
          }

          if (data.user) {
            setUser(data.user);
            setAuthStatus('authenticated');
            setAuthModalVisible(false);
            return { success: true, upgraded: true };
          }
        }

        // CASE B: Fresh registration for a guest visitor
        const { data, error } = await supabase.auth.signUp({
          email: trimmedEmail,
          password,
        });

        if (error) {
          return { success: false, error: error.message };
        }

        if (data.session) {
          setSession(data.session);
          setUser(data.session.user);
          setAuthStatus('authenticated');
          setAuthModalVisible(false);
          return { success: true };
        }

        if (data.user && !data.session) {
          // Email confirmation is required by Supabase settings
          return {
            success: true,
            needsEmailVerification: true,
          };
        }

        return { success: false, error: 'Sign-up completed without active session.' };
      } catch (err: any) {
        return { success: false, error: err?.message || 'Registration failed.' };
      }
    },
    [user],
  );

  const signInWithGoogle = useCallback(
    async (options?: { forceSignIn?: boolean }): Promise<{
      success: boolean;
      error?: string;
      upgraded?: boolean;
      redirecting?: boolean;
    }> => {
      if (!isSupabaseConfigured || !supabase) {
        return { success: false, error: 'Supabase is not configured' };
      }

      try {
        let redirectUrl: string;
        if (Platform.OS === 'web') {
          const origin =
            typeof window !== 'undefined' && window.location.origin
              ? window.location.origin.replace(/\/+$/, '')
              : 'http://localhost:8081';
          redirectUrl = `${origin}/auth/callback`;
        } else {
          redirectUrl = Linking.createURL('auth/callback', { scheme: 'daredrop' });
        }

        // Check if we should attempt identity linking:
        // Only link when the current session is anonymous AND caller did NOT request forceSignIn
        const shouldLink = !options?.forceSignIn && Boolean(user && user.is_anonymous);

        // CASE A: Existing anonymous user intentionally linking Google identity in-place
        if (shouldLink) {
          try {
            const { data, error } = await supabase.auth.linkIdentity({
              provider: 'google',
              options: {
                redirectTo: redirectUrl,
                skipBrowserRedirect: true,
              },
            });

            if (error) {
              const errCode = (error as any)?.code || '';
              const errMsg = error.message?.toLowerCase() || '';
              if (errCode === 'manual_linking_disabled' || errMsg.includes('manual linking')) {
                return {
                  success: false,
                  error:
                    'Manual identity linking is disabled in your Supabase project. Please enable "Allow manual linking" in your Supabase Dashboard under Authentication -> Providers.',
                };
              }
              if (errMsg.includes('already') || errCode.includes('identity_already_exists')) {
                return {
                  success: false,
                  error:
                    'This Google account is already linked to another DareDrop account. Use "Sign in with Google" to access that account, or link a different Google account to preserve your current guest progress.',
                };
              }
              return { success: false, error: error.message || 'Failed to link Google account.' };
            }

            if (!data?.url) {
              return { success: false, error: 'Google authentication URL was not returned by Supabase.' };
            }

            // Web environment: explicitly navigate the window to Google OAuth
            if (Platform.OS === 'web') {
              if (typeof window !== 'undefined') {
                window.location.assign(data.url);
                return { success: false, redirecting: true };
              }
              return { success: false, error: 'Web browser window is not available.' };
            }

            // Native environment: open in-app auth browser
            const authRes = await WebBrowser.openAuthSessionAsync(data.url, redirectUrl);
            if (authRes.type === 'success' && authRes.url) {
              const ok = await handleOAuthCallbackUrl(authRes.url);
              if (ok) {
                const { data: sData } = await supabase.auth.getSession();
                if (sData?.session?.user) {
                  setSession(sData.session);
                  setUser(sData.session.user);
                  setAuthStatus(sData.session.user.is_anonymous ? 'anonymous' : 'authenticated');
                } else {
                  setAuthStatus('authenticated');
                }
                setAuthModalVisible(false);
                return { success: true, upgraded: true };
              }
            }

            // Fallback: Check if the user was already upgraded/authenticated
            // (e.g. Android deep link intent routed directly to callback.tsx while WebBrowser was dismissed)
            const { data: fallbackData } = await supabase.auth.getSession();
            if (fallbackData?.session?.user && !fallbackData.session.user.is_anonymous) {
              setSession(fallbackData.session);
              setUser(fallbackData.session.user);
              setAuthStatus('authenticated');
              setAuthModalVisible(false);
              return { success: true, upgraded: true };
            }

            return { success: false, error: 'Google linking was cancelled.' };
          } catch (linkErr: any) {
            const errCode = linkErr?.code || '';
            const errMsg = linkErr?.message?.toLowerCase() || '';
            if (errCode === 'manual_linking_disabled' || errMsg.includes('manual linking')) {
              return {
                success: false,
                error:
                  'Manual identity linking is disabled in your Supabase project. Please enable "Allow manual linking" in your Supabase Dashboard under Authentication -> Providers.',
              };
            }
            if (errMsg.includes('already') || errCode.includes('identity_already_exists')) {
              return {
                success: false,
                error:
                  'This Google account is already linked to another DareDrop account. Use "Sign in with Google" to access that account, or link a different Google account to preserve your current guest progress.',
              };
            }
            return { success: false, error: linkErr?.message || 'Failed to link Google account.' };
          }
        }

        // CASE B: Standard Google OAuth sign-in / registration
        // Uses signInWithOAuth directly, allowing users to sign in to an existing Google account
        const { data, error } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: redirectUrl,
            skipBrowserRedirect: true,
          },
        });

        if (error) {
          return { success: false, error: error.message || 'Google sign-in could not be initialized.' };
        }

        if (!data?.url) {
          return { success: false, error: 'Google authentication URL was not returned by Supabase.' };
        }

        // Web environment: explicitly navigate the window to Google OAuth
        if (Platform.OS === 'web') {
          if (typeof window !== 'undefined') {
            window.location.assign(data.url);
            return { success: false, redirecting: true };
          }
          return { success: false, error: 'Web browser window is not available.' };
        }

        // Native environment: open in-app auth browser
        const authRes = await WebBrowser.openAuthSessionAsync(data.url, redirectUrl);
        if (authRes.type === 'success' && authRes.url) {
          const ok = await handleOAuthCallbackUrl(authRes.url);
          if (ok) {
            const { data: sData } = await supabase.auth.getSession();
            if (sData?.session?.user) {
              setSession(sData.session);
              setUser(sData.session.user);
              setAuthStatus(sData.session.user.is_anonymous ? 'anonymous' : 'authenticated');
            } else {
              setAuthStatus('authenticated');
            }
            setAuthModalVisible(false);
            return { success: true };
          }
        }

        // Fallback: Check if the user is already authenticated
        // (e.g. Android deep link intent routed directly to callback.tsx while WebBrowser was dismissed)
        const { data: fallbackData } = await supabase.auth.getSession();
        if (fallbackData?.session?.user && !fallbackData.session.user.is_anonymous) {
          setSession(fallbackData.session);
          setUser(fallbackData.session.user);
          setAuthStatus('authenticated');
          setAuthModalVisible(false);
          return { success: true };
        }

        return { success: false, error: 'Google sign-in was cancelled.' };
      } catch (err: any) {
        return { success: false, error: err?.message || 'Google authentication failed.' };
      }
    },
    [user],
  );

  const linkWithGoogle = useCallback(async () => {
    return signInWithGoogle({ forceSignIn: false });
  }, [signInWithGoogle]);

  const resetPassword = useCallback(async (email: string): Promise<{ success: boolean; error?: string }> => {
    if (!isSupabaseConfigured || !supabase) {
      return { success: false, error: 'Supabase is not configured' };
    }

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail) return { success: false, error: 'Please enter your email address.' };

    try {
      const redirectUrl =
        Platform.OS === 'web'
          ? `${window.location.origin}/auth?reset=true`
          : Linking.createURL('auth/reset');

      const { error } = await supabase.auth.resetPasswordForEmail(trimmedEmail, {
        redirectTo: redirectUrl,
      });

      if (error) {
        return { success: false, error: error.message };
      }

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to send password reset email.' };
    }
  }, []);

  const signOut = useCallback(async () => {
    if (isSupabaseConfigured && supabase) {
      try {
        await unregisterDevicePushTokenAsync();
      } catch (tokenErr) {
        console.warn('[DareDrop Auth] Failed to unregister push token during sign-out:', tokenErr);
      }

      try {
        await supabase.auth.signOut();
      } catch (e) {
        console.warn('[DareDrop Auth] Supabase signOut error:', e);
      }
    }

    setSession(null);
    setUser(null);
    setAuthStatus('guest');
  }, []);

  const isRegistered = authStatus === 'authenticated';
  const isAnonymous = authStatus === 'anonymous';
  const isGuest = authStatus === 'guest' || authStatus === 'anonymous';
  const currentUserId = user?.id || '';
  const userEmail = user?.email || null;
  const userDisplayName =
    user?.user_metadata?.full_name ||
    user?.user_metadata?.name ||
    user?.user_metadata?.display_name ||
    (userEmail ? userEmail.split('@')[0] : null);
  const avatarUrl = user?.user_metadata?.avatar_url || null;

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        authStatus,
        isGuest,
        isAnonymous,
        isRegistered,
        currentUserId,
        userEmail,
        userDisplayName,
        avatarUrl,
        signInWithEmail,
        signUpWithEmail,
        signInWithGoogle,
        linkWithGoogle,
        resetPassword,
        signOut,
        continueAsGuest,
        authModalVisible,
        authModalReason,
        showAuthModal,
        hideAuthModal,
      }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
