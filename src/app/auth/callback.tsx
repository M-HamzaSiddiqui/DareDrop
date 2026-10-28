import { router, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { DD } from '@/constants/dd-theme';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';

export default function AuthCallbackScreen() {
  const params = useLocalSearchParams<{ code?: string }>();

  useEffect(() => {
    async function processCallback() {
      if (params.code && isSupabaseConfigured && supabase) {
        try {
          await supabase.auth.exchangeCodeForSession(params.code);
        } catch (err) {
          console.warn('[DareDrop Auth Callback] Failed to exchange code for session:', err);
        }
      }
      router.replace('/');
    }

    processCallback();
  }, [params.code]);

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
    gap: DD.s4,
  },
  text: {
    fontSize: 15,
    fontWeight: '600',
    color: DD.textSub,
  },
});
