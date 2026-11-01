import React from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import {
  CATEGORY_COLORS,
  CategoryKey,
  DD_COLORS,
  DD_RADII,
  DD_SPACING,
} from '@/constants/dd-theme';
import { DDIcon, type DDIconName } from './dd-icon';
import { DDText } from './dd-text';

export type DDBadgeVariant =
  | 'lime'
  | 'purple'
  | 'coral'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'neutral'
  | CategoryKey;

export type DDBadgeSize = 'sm' | 'md';

export interface DDBadgeProps {
  label: string;
  variant?: DDBadgeVariant;
  size?: DDBadgeSize;
  icon?: DDIconName;
  selected?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

const CATEGORY_DEFAULT_ICONS: Record<CategoryKey, DDIconName> = {
  Fitness: 'flame',
  Focus: 'target',
  Fun: 'sparkle',
  Learning: 'compass',
};

/**
 * Standardized Badge / Chip Component for DareDrop.
 * Used for challenge categories, verification statuses, and filter chips.
 */
export function DDBadge({
  label,
  variant = 'lime',
  size = 'md',
  icon,
  selected,
  onPress,
  style,
}: DDBadgeProps) {
  const isCategory = ['Fitness', 'Focus', 'Fun', 'Learning'].includes(variant);

  const getColor = (): string => {
    if (isCategory) return CATEGORY_COLORS[variant as CategoryKey];
    switch (variant) {
      case 'lime':
        return DD_COLORS.lime;
      case 'purple':
        return DD_COLORS.purple;
      case 'coral':
        return DD_COLORS.coral;
      case 'success':
        return DD_COLORS.success;
      case 'warning':
        return DD_COLORS.warning;
      case 'danger':
        return DD_COLORS.danger;
      case 'info':
        return DD_COLORS.info;
      default:
        return DD_COLORS.textSub;
    }
  };

  const badgeColor = getColor();
  const resolvedIcon = icon ?? (isCategory ? CATEGORY_DEFAULT_ICONS[variant as CategoryKey] : undefined);
  const isInteractive = Boolean(onPress);

  const containerStyle = [
    styles.base,
    styles[`size_${size}`],
    {
      backgroundColor: selected ? `${badgeColor}28` : `${badgeColor}16`,
      borderColor: selected ? badgeColor : `${badgeColor}40`,
    },
    style,
  ];

  const content = (
    <>
      {resolvedIcon && (
        <DDIcon
          name={resolvedIcon}
          size={size === 'sm' ? 'xs' : 'sm'}
          color={badgeColor}
          style={styles.icon}
        />
      )}
      <DDText
        variant="caption"
        customColor={badgeColor}
        style={styles.label}>
        {label}
      </DDText>
    </>
  );

  if (isInteractive) {
    return (
      <Pressable
        onPress={onPress}
        android_ripple={{ color: 'rgba(255, 255, 255, 0.08)', borderless: false }}
        style={({ pressed }) => [
          containerStyle,
          pressed && styles.pressed,
        ]}
        accessibilityRole="checkbox"
        accessibilityState={{ selected }}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
        {content}
      </Pressable>
    );
  }

  return <View style={containerStyle}>{content}</View>;
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: DD_RADII.pill,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  pressed: {
    opacity: 0.8,
  },
  icon: {
    marginRight: 4,
  },
  label: {
    fontWeight: '800',
    letterSpacing: 0.3,
  },

  size_sm: {
    paddingHorizontal: DD_SPACING.xs + 2,
    paddingVertical: 2,
  },
  size_md: {
    paddingHorizontal: DD_SPACING.sm + 2,
    paddingVertical: DD_SPACING.xs,
  },
});
