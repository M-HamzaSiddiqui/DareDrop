import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, Keyframe } from 'react-native-reanimated';
import * as SplashScreen from 'expo-splash-screen';
import { scheduleOnRN } from 'react-native-worklets';

import { DD_COLORS } from '@/constants/dd-theme';
import { DDIcon } from '@/components/ui/dd-icon';
import { DDText } from '@/components/ui/dd-text';

const SPLASH_DURATION = 550;

/**
 * Branded DareDrop Splash Overlay.
 * Replaces generic Expo-blue branding with a deep near-black background,
 * energetic Neon Lime and Electric Violet accents, and smooth fade-out.
 */
export function AnimatedSplashOverlay() {
  const [animate, setAnimate] = useState(false);
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  const fadeOutKeyframe = new Keyframe({
    0: {
      opacity: 1,
      transform: [{ scale: 1 }],
    },
    40: {
      opacity: 1,
      transform: [{ scale: 1.02 }],
    },
    100: {
      opacity: 0,
      transform: [{ scale: 1.08 }],
      easing: Easing.out(Easing.cubic),
    },
  });

  const renderBrandContent = () => (
    <View style={styles.brandContainer}>
      <View style={styles.logoBadge}>
        <View style={styles.glowLayer} />
        <DDIcon name="flame" size={54} color={DD_COLORS.lime} weight="fill" />
      </View>
      <DDText variant="h1" color="lime" style={styles.brandTitle}>
        DARE DROP
      </DDText>
      <DDText variant="caption" color="secondary" style={styles.brandTagline}>
        MAKE TODAY LEGENDARY
      </DDText>
    </View>
  );

  return animate ? (
    <Animated.View
      entering={fadeOutKeyframe.duration(SPLASH_DURATION).withCallback((finished) => {
        'worklet';
        if (finished) {
          scheduleOnRN(setVisible, false);
        }
      })}
      style={styles.splashOverlay}>
      {renderBrandContent()}
    </Animated.View>
  ) : (
    <View
      onLayout={() => {
        SplashScreen.hideAsync().finally(() => {
          setAnimate(true);
        });
      }}
      style={styles.splashOverlay}>
      {renderBrandContent()}
    </View>
  );
}

/**
 * Legacy AnimatedIcon export kept for backwards compatibility.
 */
export function AnimatedIcon() {
  return (
    <View style={styles.legacyIconWrapper}>
      <DDIcon name="flame" size={64} color={DD_COLORS.lime} weight="fill" />
    </View>
  );
}

const styles = StyleSheet.create({
  splashOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: DD_COLORS.bg,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  brandContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoBadge: {
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: DD_COLORS.bgCard,
    borderWidth: 2,
    borderColor: 'rgba(191, 253, 64, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    position: 'relative',
    shadowColor: DD_COLORS.lime,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 8,
  },
  glowLayer: {
    position: 'absolute',
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: 'rgba(191, 253, 64, 0.1)',
  },
  brandTitle: {
    letterSpacing: 6,
    marginBottom: 6,
    textAlign: 'center',
  },
  brandTagline: {
    letterSpacing: 2.5,
    fontWeight: '800',
    textAlign: 'center',
  },
  legacyIconWrapper: {
    width: 96,
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
