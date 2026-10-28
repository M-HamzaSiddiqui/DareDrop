/**
 * DareDrop design tokens — dark-first, lime + purple accent palette.
 */

export const DD = {
  // Backgrounds
  bg: '#0A0A0F',
  bgCard: '#12121A',
  bgElement: '#1A1A26',
  bgElevated: '#1F1F30',

  // Text
  text: '#F0F0FF',
  textSub: '#8888A8',
  textMuted: '#4A4A6A',

  // Accents
  lime: '#BFFD40',
  limeDim: '#8ABF28',
  purple: '#9B59FF',
  purpleDim: '#6B3DB8',

  // Category colours
  catFitness: '#FF6B35',
  catFocus: '#9B59FF',
  catFun: '#FF3CAC',
  catLearning: '#00D4FF',

  // Utility
  border: '#222230',
  success: '#4AE68A',
  danger: '#FF4466',

  // Typography
  fontDisplay: 'System',
  fontMono: 'monospace',

  // Radii
  radiusSm: 8,
  radiusMd: 12,
  radiusLg: 16,
  radiusCard: 20,
  radiusPill: 100,
  radiusChip: 10,

  // Spacing scale (multiples of 4)
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
