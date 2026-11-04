declare module 'phosphor-react-native' {
  import type { ComponentType } from 'react';
  import type { StyleProp, ViewStyle } from 'react-native';
  import type { SvgProps } from 'react-native-svg';

  export type IconWeight = 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';

  export interface IconProps extends SvgProps {
    color?: string;
    size?: string | number;
    weight?: IconWeight;
    mirrored?: boolean;
    style?: StyleProp<ViewStyle>;
  }

  export type Icon = ComponentType<IconProps>;

  export const ArrowLeft: Icon;
  export const ArrowRight: Icon;
  export const ArrowsClockwise: Icon;
  export const Bell: Icon;
  export const CalendarBlank: Icon;
  export const CaretRight: Icon;
  export const Check: Icon;
  export const CheckCircle: Icon;
  export const Clock: Icon;
  export const Compass: Icon;
  export const Copy: Icon;
  export const Flame: Icon;
  export const Globe: Icon;
  export const Handshake: Icon;
  export const House: Icon;
  export const Info: Icon;
  export const Lightning: Icon;
  export const Lock: Icon;
  export const MagnifyingGlass: Icon;
  export const PaperPlaneTilt: Icon;
  export const Person: Icon;
  export const Plus: Icon;
  export const ShareNetwork: Icon;
  export const ShieldCheck: Icon;
  export const SignOut: Icon;
  export const Sparkle: Icon;
  export const Target: Icon;
  export const Trophy: Icon;
  export const UserPlus: Icon;
  export const Users: Icon;
  export const Warning: Icon;
  export const WarningCircle: Icon;
  export const X: Icon;
  export const XCircle: Icon;

  const icons: Record<string, Icon>;
  export default icons;
}
