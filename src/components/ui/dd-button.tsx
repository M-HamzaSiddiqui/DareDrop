import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from 'react-native';

import { DD, DD_COLORS, DD_RADII, DD_SPACING } from '@/constants/dd-theme';
import { DDIcon, type DDIconName, type DDIconSize } from './dd-icon';
import { DDText } from './dd-text';

export type DDButtonVariant = 'primary' | 'secondary' | 'violet' | 'outline' | 'ghost' | 'destructive';
export type DDButtonSize = 'sm' | 'md' | 'lg';

export interface DDButtonProps extends Omit<PressableProps, 'style'> {
  title: string;
  variant?: DDButtonVariant;
  size?: DDButtonSize;
  iconLeft?: DDIconName;
  iconRight?: DDIconName;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}

/**
 * Standardized High-Performance DareDrop Button.
 * Includes Android native ripple, 48dp minimum touch target,
 * accessible states, and tactile press scaling.
 */
export function DDButton({
  title,
  variant = 'primary',
  size = 'md',
  iconLeft,
  iconRight,
  loading = false,
  disabled = false,
  fullWidth = false,
  style,
  textStyle,
  accessibilityLabel,
  ...rest
}: DDButtonProps) {
  const isInteractive = !disabled && !loading;

  const rippleColor =
    variant === 'primary'
      ? 'rgba(10, 10, 16, 0.16)'
      : variant === 'destructive'
        ? 'rgba(255, 59, 86, 0.2)'
        : 'rgba(191, 253, 64, 0.15)';

  const getIconProps = () => {
    const iconSize: DDIconSize = size === 'sm' ? 'xs' : size === 'lg' ? 'md' : 'sm';
    const iconColor =
      variant === 'primary'
        ? DD_COLORS.textInverse
        : variant === 'destructive'
          ? DD_COLORS.danger
          : variant === 'outline'
            ? DD_COLORS.lime
            : DD_COLORS.text;
    return { size: iconSize, color: iconColor };
  };

  const getTextColor = (): 'inverse' | 'primary' | 'lime' | 'danger' => {
    if (variant === 'primary') return 'inverse';
    if (variant === 'destructive') return 'danger';
    if (variant === 'outline') return 'lime';
    return 'primary';
  };

  const getTextVariant = () => {
    return size === 'sm' ? 'buttonSm' : 'button';
  };

  return (
    <Pressable
      android_ripple={isInteractive ? { color: rippleColor, borderless: false } : undefined}
      disabled={!isInteractive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !isInteractive, busy: loading }}
      hitSlop={size === 'sm' ? { top: 6, bottom: 6, left: 6, right: 6 } : undefined}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        styles[`size_${size}`],
        fullWidth && styles.fullWidth,
        disabled && styles.disabled,
        pressed && isInteractive && styles.pressed,
        style,
      ]}
      {...rest}>
      {loading ? (
        <ActivityIndicator
          size="small"
          color={variant === 'primary' ? DD_COLORS.textInverse : DD_COLORS.lime}
        />
      ) : (
        <View style={styles.contentRow}>
          {iconLeft && (
            <DDIcon
              name={iconLeft}
              {...getIconProps()}
              style={styles.iconLeft}
            />
          )}
          <DDText
            variant={getTextVariant()}
            color={getTextColor()}
            style={[styles.titleText, textStyle]}>
            {title}
          </DDText>
          {iconRight && (
            <DDIcon
              name={iconRight}
              {...getIconProps()}
              style={styles.iconRight}
            />
          )}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: DD_RADII.pill,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    overflow: 'hidden',
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleText: {
    textAlign: 'center',
  },
  iconLeft: {
    marginRight: DD_SPACING.sm,
  },
  iconRight: {
    marginLeft: DD_SPACING.sm,
  },
  fullWidth: {
    width: '100%',
  },
  pressed: {
    opacity: 0.88,
    transform: [{ scale: 0.985 }],
  },
  disabled: {
    opacity: 0.45,
  },

  // Sizing variants (guarantees minimum 48dp on medium and large)
  size_sm: {
    height: 36,
    paddingHorizontal: DD_SPACING.md,
  },
  size_md: {
    height: 48,
    paddingHorizontal: DD_SPACING.lg,
  },
  size_lg: {
    height: 56,
    paddingHorizontal: DD_SPACING.xl,
  },

  // Styling variants
  primary: {
    backgroundColor: DD_COLORS.lime,
    ...DD.elevation.card,
    borderWidth: 0,
  },
  secondary: {
    backgroundColor: DD_COLORS.bgElement,
    borderWidth: 1,
    borderColor: DD_COLORS.border,
  },
  violet: {
    backgroundColor: DD_COLORS.purple,
    ...DD.elevation.card,
    borderWidth: 0,
  },
  outline: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: DD_COLORS.lime,
  },
  ghost: {
    backgroundColor: 'transparent',
    borderWidth: 0,
  },
  destructive: {
    backgroundColor: DD_COLORS.dangerDim,
    borderWidth: 1,
    borderColor: 'rgba(255, 59, 86, 0.4)',
  },
});
