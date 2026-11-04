import React from 'react';
import { Pressable, ScrollView, StyleSheet, View, type ViewStyle } from 'react-native';

import {
  CATEGORY_COLORS,
  CategoryKey,
  DD_COLORS,
  DD_RADII,
  DD_SPACING,
} from '@/constants/dd-theme';
import { Challenge, formatParticipants, timeRemaining } from '@/data/challenges';
import { DDIcon, type DDIconName } from '@/components/ui/dd-icon';
import { DDText } from '@/components/ui/dd-text';

const CATEGORY_ICONS: Record<CategoryKey, DDIconName> = {
  Fitness: 'flame',
  Focus: 'target',
  Fun: 'sparkle',
  Learning: 'compass',
};

export interface ChallengeCardProps {
  challenge: Challenge;
  onPress: () => void;
  onJoin?: () => void;
  isJoining?: boolean;
  style?: ViewStyle;
}

/**
 * Polished DareDrop Challenge Card.
 * Adheres to dark-first visual system with Phosphor vector icons,
 * high-contrast accessible typography, and smooth Android ripple.
 */
export function ChallengeCard({
  challenge,
  onPress,
  onJoin,
  isJoining,
  style,
}: ChallengeCardProps) {
  const catColor = CATEGORY_COLORS[challenge.category as CategoryKey] || DD_COLORS.lime;
  const catIcon = CATEGORY_ICONS[challenge.category as CategoryKey] || 'sparkle';
  const timeLeft = timeRemaining(challenge.endsAt);
  const isDaily = challenge.challengeType === 'daily';

  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: 'rgba(255, 255, 255, 0.06)' }}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed, style]}
      accessibilityRole="button"
      accessibilityLabel={`Challenge: ${challenge.title}`}>
      {/* Top Accent Strip */}
      <View style={[styles.accentBar, { backgroundColor: catColor }]} />

      <View style={styles.cardBody}>
        {/* Header Badges */}
        <View style={styles.headerRow}>
          <View style={[styles.categoryChip, { backgroundColor: catColor + '1E' }]}>
            <DDIcon name={catIcon} size={13} color={catColor} weight="fill" />
            <DDText variant="caption" style={[styles.categoryChipText, { color: catColor }]}>
              {challenge.category}
            </DDText>
          </View>

          <View style={styles.typeBadge}>
            <DDIcon
              name={isDaily ? 'flame' : 'target'}
              size={12}
              color={isDaily ? DD_COLORS.lime : DD_COLORS.purple}
              weight="bold"
            />
            <DDText
              variant="caption"
              color={isDaily ? 'lime' : 'purple'}
              style={styles.typeBadgeText}>
              {isDaily ? 'Daily Dare' : 'One-Time'}
            </DDText>
          </View>

          {challenge.joined && (
            <View style={styles.joinedBadge}>
              <DDIcon name="check-circle" size={12} color={DD_COLORS.success} weight="fill" />
              <DDText variant="caption" style={styles.joinedBadgeText}>
                Joined
              </DDText>
            </View>
          )}
        </View>

        {/* Title */}
        <DDText variant="h3" color="primary" numberOfLines={2} style={styles.title}>
          {challenge.title}
        </DDText>

        {/* Creator subline */}
        {challenge.creator ? (
          <View style={styles.creatorRow}>
            <DDIcon name="user" size={12} color={DD_COLORS.textMuted} weight="bold" />
            <DDText variant="caption" color="muted" style={styles.creatorText}>
              By {challenge.creator}
            </DDText>
          </View>
        ) : null}

        {/* Description */}
        <DDText variant="bodySm" color="secondary" numberOfLines={2} style={styles.description}>
          {challenge.description}
        </DDText>

        {/* Footer Metrics */}
        <View style={styles.footer}>
          <View style={styles.stat}>
            <DDIcon name="users" size={14} color={DD_COLORS.textMuted} weight="bold" />
            <DDText variant="caption" color="secondary" style={styles.statText}>
              {formatParticipants(challenge.participants)}
            </DDText>
          </View>

          <View style={styles.stat}>
            <DDIcon name="clock" size={14} color={DD_COLORS.textMuted} weight="bold" />
            <DDText variant="caption" color="secondary" style={styles.statText}>
              {timeLeft}
            </DDText>
          </View>

          <View style={styles.stat}>
            <DDIcon name="calendar" size={14} color={DD_COLORS.textMuted} weight="bold" />
            <DDText variant="caption" color="secondary" style={styles.statText}>
              {challenge.durationDays}d
            </DDText>
          </View>

          {onJoin ? (
            <Pressable
              onPress={(e) => {
                e.stopPropagation?.();
                onJoin();
              }}
              disabled={isJoining}
              android_ripple={{ color: 'rgba(0, 0, 0, 0.2)' }}
              style={[
                styles.joinButton,
                challenge.joined && styles.joinedButton,
                isJoining && styles.joinButtonBusy,
              ]}
              accessibilityRole="button"
              accessibilityLabel={challenge.joined ? 'Leave or view challenge' : 'Join challenge'}>
              {isJoining ? (
                <DDText variant="caption" style={styles.joinButtonText} bold>
                  ...
                </DDText>
              ) : challenge.joined ? (
                <>
                  <DDIcon name="check" size={12} color={DD_COLORS.success} weight="bold" />
                  <DDText variant="caption" color="success" bold>
                    Joined
                  </DDText>
                </>
              ) : (
                <>
                  <DDIcon name="plus" size={12} color={DD_COLORS.bg} weight="bold" />
                  <DDText variant="caption" style={styles.joinButtonText} bold>
                    Join
                  </DDText>
                </>
              )}
            </Pressable>
          ) : (
            <View style={styles.arrowAction}>
              <DDIcon name="arrow-right" size={14} color={DD_COLORS.lime} weight="bold" />
            </View>
          )}
        </View>
      </View>
    </Pressable>
  );
}

export interface CategoryFilterProps {
  selected: CategoryKey | 'All';
  onSelect: (cat: CategoryKey | 'All') => void;
  horizontal?: boolean;
}

const CATEGORIES: (CategoryKey | 'All')[] = ['All', 'Fitness', 'Focus', 'Fun', 'Learning'];

/**
 * Category Filter Strip with Phosphor vector icons and signature tints.
 */
export function CategoryFilter({ selected, onSelect, horizontal }: CategoryFilterProps) {
  const chips = CATEGORIES.map((cat) => {
    const isActive = selected === cat;
    const color = cat === 'All' ? DD_COLORS.lime : CATEGORY_COLORS[cat as CategoryKey];
    const iconName: DDIconName =
      cat === 'All' ? 'sparkle' : CATEGORY_ICONS[cat as CategoryKey] || 'sparkle';

    return (
      <Pressable
        key={cat}
        onPress={() => onSelect(cat)}
        android_ripple={{ color: 'rgba(255, 255, 255, 0.08)', borderless: false }}
        style={({ pressed }) => [
          filterStyles.chip,
          isActive && { backgroundColor: color + '22', borderColor: color },
          pressed && filterStyles.chipPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={`Filter by ${cat}`}
        accessibilityState={{ selected: isActive }}>
        <DDIcon
          name={iconName}
          size={13}
          color={isActive ? color : DD_COLORS.textMuted}
          weight={isActive ? 'fill' : 'bold'}
        />
        <DDText
          variant="caption"
          style={[
            filterStyles.chipText,
            { color: isActive ? color : DD_COLORS.textSub },
            isActive && filterStyles.chipTextActive,
          ]}>
          {cat}
        </DDText>
      </Pressable>
    );
  });

  if (horizontal) {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={filterStyles.horizontalContent}
        style={filterStyles.horizontalScroll}>
        {chips}
      </ScrollView>
    );
  }

  return <View style={filterStyles.row}>{chips}</View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.card,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    overflow: 'hidden',
    marginBottom: DD_SPACING.md,
  },
  cardPressed: {
    opacity: 0.88,
    transform: [{ scale: 0.985 }],
  },
  accentBar: {
    height: 3,
    width: '100%',
  },
  cardBody: {
    padding: DD_SPACING.lg,
    gap: DD_SPACING.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: DD_SPACING.sm,
  },
  categoryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    borderRadius: DD_RADII.pill,
  },
  categoryChipText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  typeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    borderRadius: DD_RADII.pill,
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
  },
  typeBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  joinedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 3,
    borderRadius: DD_RADII.pill,
    backgroundColor: 'rgba(0, 230, 118, 0.12)',
    marginLeft: 'auto',
  },
  joinedBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: DD_COLORS.success,
  },
  title: {
    marginTop: 2,
  },
  description: {
    marginTop: 2,
    lineHeight: 18,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.lg,
    marginTop: DD_SPACING.xs,
    paddingTop: DD_SPACING.xs,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.04)',
  },
  stat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  statText: {
    fontWeight: '600',
  },
  arrowAction: {
    marginLeft: 'auto',
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(191, 253, 64, 0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  creatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: -2,
  },
  creatorText: {
    fontSize: 11,
    color: DD_COLORS.textMuted,
  },
  joinButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginLeft: 'auto',
    backgroundColor: DD_COLORS.lime,
    paddingHorizontal: DD_SPACING.md,
    paddingVertical: 6,
    borderRadius: DD_RADII.pill,
    minHeight: 32,
  },
  joinedButton: {
    backgroundColor: 'rgba(0, 230, 118, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0, 230, 118, 0.3)',
  },
  joinButtonBusy: {
    opacity: 0.6,
  },
  joinButtonText: {
    color: DD_COLORS.bg,
    fontWeight: '800',
    fontSize: 12,
  },
});

const filterStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: DD_SPACING.sm,
    paddingVertical: DD_SPACING.xs,
  },
  horizontalScroll: {
    marginHorizontal: -DD_SPACING.lg,
  },
  horizontalContent: {
    paddingHorizontal: DD_SPACING.lg,
    flexDirection: 'row',
    gap: DD_SPACING.sm,
    paddingVertical: DD_SPACING.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: DD_SPACING.md,
    paddingVertical: DD_SPACING.sm,
    borderRadius: DD_RADII.pill,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    backgroundColor: DD_COLORS.bgElement,
    minHeight: 38,
  },
  chipPressed: {
    opacity: 0.8,
  },
  chipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  chipTextActive: {
    fontWeight: '800',
  },
});
