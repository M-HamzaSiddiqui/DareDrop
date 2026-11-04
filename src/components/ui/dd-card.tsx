import React from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { DD, DD_COLORS, DD_RADII, DD_SPACING } from '@/constants/dd-theme';

export type DDCardVariant = 'card' | 'element' | 'elevated' | 'highlight';
export type DDCardPadding = 'none' | 'sm' | 'md' | 'lg';

export interface DDCardProps extends Omit<PressableProps, 'style'> {
  variant?: DDCardVariant;
  padding?: DDCardPadding;
  accentColor?: string;
  accentPosition?: 'top' | 'left';
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}

/**
 * Standardized Container Card Component for DareDrop.
 * Provides uniform surface elevations, radii, borders, and tactile press states.
 */
export function DDCard({
  variant = 'card',
  padding = 'md',
  accentColor,
  accentPosition = 'top',
  onPress,
  style,
  children,
  ...rest
}: DDCardProps) {
  const isPressable = Boolean(onPress);

  const containerStyle = [
    styles.base,
    styles[variant],
    styles[`pad_${padding}`],
    style,
  ];

  const renderContent = () => (
    <>
      {accentColor && (
        <View
          style={[
            accentPosition === 'top' ? styles.accentBarTop : styles.accentBarLeft,
            { backgroundColor: accentColor },
          ]}
        />
      )}
      {children}
    </>
  );

  if (isPressable) {
    return (
      <Pressable
        onPress={onPress}
        android_ripple={{ color: 'rgba(255, 255, 255, 0.05)', borderless: false }}
        style={({ pressed }) => [
          containerStyle,
          pressed && styles.pressed,
        ]}
        accessibilityRole="button"
        {...rest}>
        {renderContent()}
      </Pressable>
    );
  }

  return (
    <View style={containerStyle}>
      {renderContent()}
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: DD_RADII.card,
    overflow: 'hidden',
    position: 'relative',
  },
  pressed: {
    opacity: 0.88,
    transform: [{ scale: 0.985 }],
  },

  // Surface variants
  card: {
    backgroundColor: DD_COLORS.bgCard,
    ...DD.elevation.card,
  },
  element: {
    backgroundColor: DD_COLORS.bgElement,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
  },
  elevated: {
    backgroundColor: DD_COLORS.bgElevated,
    ...DD.elevation.elevated,
  },
  highlight: {
    backgroundColor: DD_COLORS.bgCard,
    borderWidth: 1.5,
    borderColor: DD_COLORS.lime,
    ...DD.elevation.card,
  },

  // Padding variants
  pad_none: {
    padding: 0,
  },
  pad_sm: {
    padding: DD_SPACING.sm,
  },
  pad_md: {
    padding: DD_SPACING.lg,
  },
  pad_lg: {
    padding: DD_SPACING.xl,
  },

  // Accent decorations
  accentBarTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 3,
  },
  accentBarLeft: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: 4,
  },
});
