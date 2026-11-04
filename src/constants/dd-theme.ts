import { Platform, TextStyle, ViewStyle } from 'react-native';

/**
 * DareDrop Design Tokens — Android-First, Dark-First Architecture.
 *
 * Designed for high visual impact, accessible contrast (WCAG 2.1 AA/AAA),
 * consistent 4px rhythm, and tactile Android feedback.
 */

export const DD_COLORS = {
  // Background surfaces (deep OLED-friendly progression)
  bg: '#0A0A10',
  bgCard: '#12121C',
  bgElement: '#181826',
  bgElevated: '#222234',
  bgHighlight: '#2C2C42',

  // Brand Accents
  lime: '#BFFD40',
  limeDim: '#8ABF28',
  limeGlow: 'rgba(191, 253, 64, 0.15)',
  purple: '#9B59FF',
  purpleDim: '#6B3DB8',
  purpleGlow: 'rgba(155, 89, 255, 0.15)',
  coral: '#FF6B35',
  coralGlow: 'rgba(255, 107, 53, 0.15)',

  // Typography Colors (Strict WCAG 2.1 Contrast on dark surfaces)
  text: '#FFFFFF', // High emphasis (100% white)
  textSub: '#A0A0C0', // Medium emphasis (7.1:1 on bgCard — WCAG AAA)
  textMuted: '#707094', // Low emphasis/captions (4.6:1 on bgCard — WCAG AA)
  textInverse: '#0A0A10', // Dark text on Lime/bright badges

  // Category Signatures
  catFitness: '#FF6B35',
  catFocus: '#9B59FF',
  catFun: '#FF3CAC',
  catLearning: '#00D4FF',

  // Semantic Status Colors
  success: '#00E676',
  successDim: 'rgba(0, 230, 118, 0.15)',
  warning: '#FFB800',
  warningDim: 'rgba(255, 184, 0, 0.15)',
  danger: '#FF3B56',
  dangerDim: 'rgba(255, 59, 86, 0.15)',
  info: '#00D4FF',
  infoDim: 'rgba(0, 212, 255, 0.15)',

  // Borders & Dividers
  borderSubtle: '#1E1E2E',
  border: '#2E2E44',
  borderProminent: '#3E3E58',
  borderActive: '#BFFD40',
} as const;

export const DD_SPACING = {
  0: 0,
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 20,
  s6: 24,
  s7: 32,
  s8: 40,
  s9: 48,
  s10: 64,

  // Semantic spacing names
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 32,
  '4xl': 40,
  '5xl': 48,
  '6xl': 64,
} as const;

export const DD_RADII = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  card: 20,
  pill: 100,
  full: 9999,
  chip: 10,
} as const;

export const DD_TOUCH_TARGET = {
  min: 48, // 48dp minimum per Android Material accessibility guidelines
  default: 48,
} as const;

export const DD_ICON_SIZES = {
  xs: 14,
  sm: 18,
  md: 22,
  lg: 26,
  xl: 32,
} as const;

export const DD_ELEVATION: Record<'subtle' | 'card' | 'elevated' | 'modal' | 'fab', ViewStyle> = {
  subtle: {
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    ...Platform.select({
      android: { elevation: 1 },
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.18,
        shadowRadius: 2,
      },
    }),
  },
  card: {
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    ...Platform.select({
      android: { elevation: 2 },
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 6,
      },
    }),
  },
  elevated: {
    borderWidth: 1,
    borderColor: DD_COLORS.border,
    ...Platform.select({
      android: { elevation: 4 },
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.35,
        shadowRadius: 10,
      },
    }),
  },
  modal: {
    borderWidth: 1,
    borderColor: DD_COLORS.borderProminent,
    ...Platform.select({
      android: { elevation: 12 },
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.45,
        shadowRadius: 20,
      },
    }),
  },
  fab: {
    ...Platform.select({
      android: { elevation: 8 },
      ios: {
        shadowColor: DD_COLORS.lime,
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.35,
        shadowRadius: 12,
      },
    }),
  },
};

export const DD_TYPOGRAPHY: Record<
  | 'display'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'title'
  | 'bodyLg'
  | 'body'
  | 'bodySm'
  | 'caption'
  | 'label'
  | 'button'
  | 'buttonSm',
  TextStyle
> = {
  display: {
    fontSize: 36,
    lineHeight: 44,
    fontWeight: '900',
    letterSpacing: -1.2,
  },
  h1: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '900',
    letterSpacing: -0.8,
  },
  h2: {
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  h3: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  title: {
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '700',
    letterSpacing: -0.1,
  },
  bodyLg: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '500',
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '400',
  },
  bodySm: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '500',
  },
  caption: {
    fontSize: 11,
    lineHeight: 15,
    fontWeight: '600',
  },
  label: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  button: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: '800',
    letterSpacing: 0.2,
  },
  buttonSm: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
};

export const DD_ANIMATION = {
  quick: 150,
  normal: 250,
  gentle: 350,
  springConfig: {
    damping: 15,
    stiffness: 150,
    mass: 1,
  },
} as const;

/**
 * Consolidated design object maintaining 100% backward compatibility
 * with all existing screens and components.
 */
export const DD = {
  // Backwards-compatible colors
  ...DD_COLORS,

  // Backwards-compatible spacing scale
  ...DD_SPACING,

  // Backwards-compatible radii
  radiusSm: DD_RADII.sm,
  radiusMd: DD_RADII.md,
  radiusLg: DD_RADII.lg,
  radiusCard: DD_RADII.card,
  radiusPill: DD_RADII.pill,
  radiusChip: DD_RADII.chip,

  // Typography tokens
  fontDisplay: 'System',
  fontMono: 'monospace',

  // Nested token trees
  colors: DD_COLORS,
  spacing: DD_SPACING,
  radii: DD_RADII,
  typography: DD_TYPOGRAPHY,
  elevation: DD_ELEVATION,
  touchTarget: DD_TOUCH_TARGET,
  icons: DD_ICON_SIZES,
  animation: DD_ANIMATION,
} as const;

export type CategoryKey = 'Fitness' | 'Focus' | 'Fun' | 'Learning';

export const CATEGORY_COLORS: Record<CategoryKey, string> = {
  Fitness: DD.catFitness,
  Focus: DD.catFocus,
  Fun: DD.catFun,
  Learning: DD.catLearning,
};

export const CATEGORY_EMOJIS: Record<CategoryKey, string> = {
  Fitness: '💪',
  Focus: '🎯',
  Fun: '🎉',
  Learning: '📚',
};
