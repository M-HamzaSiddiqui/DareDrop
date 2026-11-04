import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';

import { DD_COLORS, DD_RADII } from '@/constants/dd-theme';
import { DDIcon, type DDIconName } from './dd-icon';
import { DDText } from './dd-text';

export type DDAvatarSize = 'sm' | 'md' | 'lg' | 'xl';

export interface DDAvatarProps {
  uri?: string | null;
  name?: string;
  fallbackIcon?: DDIconName;
  size?: DDAvatarSize;
  borderColor?: string;
  statusDot?: 'online' | 'active' | 'warning';
  style?: StyleProp<ViewStyle>;
}

const SIZE_MAP: Record<DDAvatarSize, { dimension: number; radius: number; fontSize: 'caption' | 'title' | 'h2' | 'display'; iconSize: 'xs' | 'sm' | 'md' | 'lg' }> = {
  sm: { dimension: 32, radius: 16, fontSize: 'caption', iconSize: 'xs' },
  md: { dimension: 44, radius: 22, fontSize: 'title', iconSize: 'sm' },
  lg: { dimension: 64, radius: 32, fontSize: 'h2', iconSize: 'md' },
  xl: { dimension: 80, radius: 40, fontSize: 'display', iconSize: 'lg' },
};

/**
 * Standardized Avatar Component for DareDrop.
 * Supports image loading, initial fallbacks, vector fallback icons, and status indicators.
 */
export function DDAvatar({
  uri,
  name,
  fallbackIcon = 'user',
  size = 'md',
  borderColor = DD_COLORS.borderProminent,
  statusDot,
  style,
}: DDAvatarProps) {
  const config = SIZE_MAP[size];

  const getInitials = (n?: string) => {
    if (!n) return '';
    const parts = n.trim().split(' ');
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return n.slice(0, 2).toUpperCase();
  };

  const initials = getInitials(name);

  return (
    <View style={[styles.wrapper, { width: config.dimension, height: config.dimension }, style]}>
      <View
        style={[
          styles.container,
          {
            width: config.dimension,
            height: config.dimension,
            borderRadius: config.radius,
            borderColor,
          },
        ]}>
        {uri ? (
          <Image
            source={{ uri }}
            style={{ width: '100%', height: '100%' }}
            contentFit="cover"
            transition={200}
          />
        ) : initials ? (
          <DDText variant={config.fontSize} color="lime" bold>
            {initials}
          </DDText>
        ) : (
          <DDIcon name={fallbackIcon} size={config.iconSize} color={DD_COLORS.textSub} />
        )}
      </View>

      {statusDot && (
        <View
          style={[
            styles.statusDot,
            statusDot === 'online' && styles.dotOnline,
            statusDot === 'active' && styles.dotActive,
            statusDot === 'warning' && styles.dotWarning,
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'relative',
  },
  container: {
    backgroundColor: DD_COLORS.bgElement,
    borderWidth: 1.5,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 12,
    height: 12,
    borderRadius: DD_RADII.full,
    borderWidth: 2,
    borderColor: DD_COLORS.bg,
  },
  dotOnline: {
    backgroundColor: DD_COLORS.success,
  },
  dotActive: {
    backgroundColor: DD_COLORS.lime,
  },
  dotWarning: {
    backgroundColor: DD_COLORS.warning,
  },
});
