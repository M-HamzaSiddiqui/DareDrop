import React, { useEffect } from 'react';
import { StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { DD_COLORS, DD_RADII, DD_SPACING } from '@/constants/dd-theme';

export interface DDSkeletonProps {
  width?: DimensionValue;
  height?: DimensionValue;
  radius?: keyof typeof DD_RADII | number;
  style?: StyleProp<ViewStyle>;
}

/**
 * Standardized Skeleton Loading Placeholder for DareDrop.
 * Replaces jarring full-screen spinners with smooth pulsating content wireframes.
 */
export function DDSkeleton({
  width = '100%',
  height = 18,
  radius = 'md',
  style,
}: DDSkeletonProps) {
  const opacity = useSharedValue(0.35);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.85, { duration: 800 }),
        withTiming(0.35, { duration: 800 }),
      ),
      -1,
      true,
    );
  }, [opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  const resolvedRadius = typeof radius === 'number' ? radius : DD_RADII[radius] ?? DD_RADII.md;

  return (
    <Animated.View
      style={[
        styles.base,
        { width, height, borderRadius: resolvedRadius },
        animatedStyle,
        style,
      ]}
    />
  );
}

/**
 * Compound Skeleton for Challenge Cards
 */
DDSkeleton.Card = function DDSkeletonCard({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.cardContainer, style]}>
      <View style={styles.cardHeader}>
        <DDSkeleton width={90} height={22} radius="pill" />
        <DDSkeleton width={70} height={18} radius="pill" />
      </View>
      <DDSkeleton width="85%" height={20} radius="sm" style={styles.spacingY} />
      <DDSkeleton width="100%" height={14} radius="xs" style={styles.spacingY} />
      <DDSkeleton width="60%" height={14} radius="xs" style={styles.spacingY} />
      <View style={styles.cardFooter}>
        <DDSkeleton width={60} height={14} radius="xs" />
        <DDSkeleton width={60} height={14} radius="xs" />
        <DDSkeleton width={60} height={14} radius="xs" />
      </View>
    </View>
  );
};

/**
 * Compound Skeleton for Text Lines
 */
DDSkeleton.Text = function DDSkeletonText({
  lines = 2,
  style,
}: {
  lines?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={style}>
      {Array.from({ length: lines }).map((_, i) => (
        <DDSkeleton
          key={i}
          width={i === lines - 1 && lines > 1 ? '65%' : '100%'}
          height={14}
          radius="xs"
          style={i > 0 ? styles.spacingY : undefined}
        />
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  base: {
    backgroundColor: DD_COLORS.bgHighlight,
  },
  cardContainer: {
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.card,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    padding: DD_SPACING.lg,
    marginBottom: DD_SPACING.md,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: DD_SPACING.sm,
  },
  cardFooter: {
    flexDirection: 'row',
    gap: DD_SPACING.lg,
    marginTop: DD_SPACING.md,
  },
  spacingY: {
    marginTop: DD_SPACING.xs,
  },
});
