import React from 'react';
import { StyleSheet, Text, type TextProps } from 'react-native';

import { DD, DD_COLORS, DD_TYPOGRAPHY } from '@/constants/dd-theme';

export type DDTextVariant = keyof typeof DD_TYPOGRAPHY;

export type DDTextColor =
  | 'primary'
  | 'secondary'
  | 'muted'
  | 'lime'
  | 'purple'
  | 'coral'
  | 'success'
  | 'warning'
  | 'danger'
  | 'inverse';

const COLOR_MAP: Record<DDTextColor, string> = {
  primary: DD_COLORS.text,
  secondary: DD_COLORS.textSub,
  muted: DD_COLORS.textMuted,
  lime: DD_COLORS.lime,
  purple: DD_COLORS.purple,
  coral: DD_COLORS.coral,
  success: DD_COLORS.success,
  warning: DD_COLORS.warning,
  danger: DD_COLORS.danger,
  inverse: DD_COLORS.textInverse,
};

export interface DDTextProps extends TextProps {
  variant?: DDTextVariant;
  color?: DDTextColor;
  customColor?: string;
  align?: 'auto' | 'left' | 'right' | 'center' | 'justify';
  bold?: boolean;
}

/**
 * Standardized Typography Component for DareDrop.
 * Enforces cohesive type scale, accessible contrast, and predictable line heights.
 */
export function DDText({
  variant = 'body',
  color = 'primary',
  customColor,
  align,
  bold,
  style,
  children,
  ...rest
}: DDTextProps) {
  const baseStyle = DD_TYPOGRAPHY[variant] ?? DD_TYPOGRAPHY.body;
  const resolvedColor = customColor ?? COLOR_MAP[color] ?? DD_COLORS.text;

  return (
    <Text
      style={[
        styles.base,
        baseStyle,
        { color: resolvedColor },
        align ? { textAlign: align } : null,
        bold ? styles.extraBold : null,
        style,
      ]}
      {...rest}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  base: {
    fontFamily: DD.fontDisplay,
    includeFontPadding: false,
  },
  extraBold: {
    fontWeight: '900',
  },
});
