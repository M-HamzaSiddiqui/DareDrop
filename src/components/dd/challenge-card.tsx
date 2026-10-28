import React from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';

import { CATEGORY_COLORS, CATEGORY_EMOJIS, CategoryKey, DD } from '@/constants/dd-theme';
import { Challenge, formatParticipants, timeRemaining } from '@/data/challenges';

interface ChallengeCardProps {
  challenge: Challenge;
  onPress: () => void;
}

export function ChallengeCard({ challenge, onPress }: ChallengeCardProps) {
  const catColor = CATEGORY_COLORS[challenge.category as CategoryKey];
  const emoji = CATEGORY_EMOJIS[challenge.category as CategoryKey];
  const timeLeft = timeRemaining(challenge.endsAt);

  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: 'rgba(255,255,255,0.06)' }}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      accessibilityRole="button"
      accessibilityLabel={`Challenge: ${challenge.title}`}>
      {/* Top accent bar */}
      <View style={[styles.accentBar, { backgroundColor: catColor }]} />

      <View style={styles.cardBody}>
        {/* Header row */}
        <View style={styles.headerRow}>
          <View style={[styles.categoryChip, { backgroundColor: catColor + '22' }]}>
            <Text style={[styles.categoryChipText, { color: catColor }]}>
              {emoji} {challenge.category}
            </Text>
          </View>
          {challenge.joined && (
            <View style={styles.joinedBadge}>
              <Text style={styles.joinedBadgeText}>✓ Joined</Text>
            </View>
          )}
        </View>

        {/* Title */}
        <Text style={styles.title} numberOfLines={2}>
          {challenge.title}
        </Text>

        {/* Description */}
        <Text style={styles.description} numberOfLines={2}>
          {challenge.description}
        </Text>

        {/* Footer */}
        <View style={styles.footer}>
          <View style={styles.stat}>
            <Text style={styles.statIcon}>👥</Text>
            <Text style={styles.statText}>{formatParticipants(challenge.participants)}</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statIcon}>⏱</Text>
            <Text style={styles.statText}>{timeLeft}</Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statIcon}>📅</Text>
            <Text style={styles.statText}>{challenge.durationDays}d</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

interface CategoryFilterProps {
  selected: CategoryKey | 'All';
  onSelect: (cat: CategoryKey | 'All') => void;
}

const CATEGORIES: (CategoryKey | 'All')[] = ['All', 'Fitness', 'Focus', 'Fun', 'Learning'];

export function CategoryFilter({ selected, onSelect }: CategoryFilterProps) {
  return (
    <View style={filterStyles.row}>
      {CATEGORIES.map((cat) => {
        const isActive = selected === cat;
        const color = cat === 'All' ? DD.lime : CATEGORY_COLORS[cat as CategoryKey];
        return (
          <Pressable
            key={cat}
            onPress={() => onSelect(cat)}
            style={({ pressed }) => [
              filterStyles.chip,
              isActive && { backgroundColor: color + '22', borderColor: color },
              pressed && filterStyles.chipPressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel={`Filter by ${cat}`}
            accessibilityState={{ selected: isActive }}>
            <Text style={[filterStyles.chipText, isActive && { color }]}>
              {cat === 'All' ? '✦ All' : `${CATEGORY_EMOJIS[cat as CategoryKey]} ${cat}`}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    borderWidth: 1,
    borderColor: DD.border,
    overflow: 'hidden',
    marginBottom: DD.s4,
  } as ViewStyle,
  cardPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.985 }],
  },
  accentBar: {
    height: 3,
    width: '100%',
  },
  cardBody: {
    padding: DD.s5,
    gap: DD.s3,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s2,
  },
  categoryChip: {
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s1,
    borderRadius: DD.radiusPill,
  },
  categoryChipText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  joinedBadge: {
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s1,
    borderRadius: DD.radiusPill,
    backgroundColor: DD.success + '22',
  },
  joinedBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: DD.success,
  },
  title: {
    fontSize: 17,
    fontWeight: '800',
    color: DD.text,
    letterSpacing: -0.3,
    lineHeight: 22,
  },
  description: {
    fontSize: 13,
    color: DD.textSub,
    lineHeight: 19,
  },
  footer: {
    flexDirection: 'row',
    gap: DD.s5,
    marginTop: DD.s1,
  },
  stat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s1,
  },
  statIcon: {
    fontSize: 12,
  },
  statText: {
    fontSize: 12,
    color: DD.textSub,
    fontWeight: '600',
  },
});

const filterStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: DD.s2,
    paddingVertical: DD.s3,
  },
  chip: {
    paddingHorizontal: DD.s4,
    paddingVertical: DD.s2,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
    borderColor: DD.border,
    backgroundColor: DD.bgElement,
  },
  chipPressed: {
    opacity: 0.75,
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    color: DD.textSub,
  },
});
