import React from 'react';
import { StyleProp, View, ViewStyle } from 'react-native';
import {
  ArrowLeft,
  ArrowRight,
  ArrowsClockwise,
  Bell,
  CalendarBlank,
  CaretRight,
  Check,
  CheckCircle,
  Clock,
  Compass,
  Copy,
  Flame,
  Globe,
  Handshake,
  House,
  Info,
  Lightning,
  Lock,
  MagnifyingGlass,
  PaperPlaneTilt,
  Person,
  Plus,
  ShareNetwork,
  ShieldCheck,
  SignOut,
  Sparkle,
  Target,
  Trophy,
  UserPlus,
  Users,
  Warning,
  WarningCircle,
  X,
  XCircle,
  IconProps,
  IconWeight,
} from 'phosphor-react-native';

import { DD, DD_ICON_SIZES } from '@/constants/dd-theme';

export type DDIconSize = keyof typeof DD_ICON_SIZES | number;

export type DDIconName =
  | 'home'
  | 'discover'
  | 'compass'
  | 'plus'
  | 'user'
  | 'person'
  | 'users'
  | 'bell'
  | 'flame'
  | 'streak'
  | 'lightning'
  | 'trophy'
  | 'target'
  | 'clock'
  | 'calendar'
  | 'shield-check'
  | 'verify'
  | 'share'
  | 'copy'
  | 'check'
  | 'check-circle'
  | 'x'
  | 'x-circle'
  | 'warning'
  | 'warning-circle'
  | 'info'
  | 'sparkle'
  | 'handshake'
  | 'friends'
  | 'user-plus'
  | 'refresh'
  | 'arrow-left'
  | 'arrow-right'
  | 'caret-right'
  | 'lock'
  | 'globe'
  | 'sign-out'
  | 'send'
  | 'plane'
  | 'search';

const ICON_MAP: Record<DDIconName, React.ComponentType<IconProps>> = {
  home: House,
  discover: Compass,
  compass: Compass,
  plus: Plus,
  user: Person,
  person: Person,
  users: Users,
  bell: Bell,
  flame: Flame,
  streak: Flame,
  lightning: Lightning,
  trophy: Trophy,
  target: Target,
  clock: Clock,
  calendar: CalendarBlank,
  'shield-check': ShieldCheck,
  verify: ShieldCheck,
  share: ShareNetwork,
  copy: Copy,
  send: PaperPlaneTilt,
  plane: PaperPlaneTilt,
  check: Check,
  'check-circle': CheckCircle,
  x: X,
  'x-circle': XCircle,
  warning: Warning,
  'warning-circle': WarningCircle,
  info: Info,
  sparkle: Sparkle,
  handshake: Handshake,
  friends: Handshake,
  'user-plus': UserPlus,
  refresh: ArrowsClockwise,
  'arrow-left': ArrowLeft,
  'arrow-right': ArrowRight,
  'caret-right': CaretRight,
  lock: Lock,
  globe: Globe,
  'sign-out': SignOut,
  search: MagnifyingGlass,
};

export interface DDIconProps {
  name: DDIconName;
  size?: DDIconSize;
  color?: string;
  weight?: IconWeight;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

/**
 * Standardized DareDrop Icon Component.
 * Powered by Phosphor Icons with consistent sizing, weighting, and contrast.
 */
export function DDIcon({
  name,
  size = 'md',
  color = DD.colors.text,
  weight = 'bold',
  style,
  accessibilityLabel,
}: DDIconProps) {
  const pixelSize = typeof size === 'number' ? size : DD_ICON_SIZES[size] ?? DD_ICON_SIZES.md;
  const IconComponent = ICON_MAP[name] ?? Sparkle;

  return (
    <View
      style={style}
      accessible={Boolean(accessibilityLabel)}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="image">
      <IconComponent size={pixelSize} color={color} weight={weight} />
    </View>
  );
}
