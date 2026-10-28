import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CategoryFilter, ChallengeCard } from '@/components/dd/challenge-card';
import { CategoryKey, DD } from '@/constants/dd-theme';
import { useChallenges } from '@/store/challenges-store';

export default function DiscoverScreen() {
  const { challenges } = useChallenges();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<CategoryKey | 'All'>('All');

  const filtered = useMemo(() => {
    return challenges.filter((c) => {
      const matchesCat = selectedCategory === 'All' || c.category === selectedCategory;
      const matchesQuery =
        query.trim() === '' ||
        c.title.toLowerCase().includes(query.toLowerCase()) ||
        c.description.toLowerCase().includes(query.toLowerCase());
      return matchesCat && matchesQuery;
    });
  }, [challenges, selectedCategory, query]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + DD.s5, paddingBottom: insets.bottom + 100 },
        ]}
        showsVerticalScrollIndicator={false}>
        {/* Header */}
        <Text style={styles.headline}>Discover</Text>
        <Text style={styles.subline}>Find your next challenge</Text>

        {/* Search bar */}
        <View style={styles.searchContainer}>
          <Text style={styles.searchIcon}>🔍</Text>
          <TextInput
            style={styles.searchInput}
            placeholder="Search challenges…"
            placeholderTextColor={DD.textMuted}
            value={query}
            onChangeText={setQuery}
            returnKeyType="search"
            accessibilityLabel="Search challenges"
          />
        </View>

        {/* Category filter */}
        <CategoryFilter selected={selectedCategory} onSelect={setSelectedCategory} />

        {/* Results count */}
        <Text style={styles.resultsCount}>
          {filtered.length} challenge{filtered.length !== 1 ? 's' : ''}
        </Text>

        {/* Cards */}
        {filtered.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>🔍</Text>
            <Text style={styles.emptyTitle}>Nothing found</Text>
            <Text style={styles.emptyText}>Try adjusting your search or category filter.</Text>
          </View>
        ) : (
          filtered.map((challenge) => (
            <ChallengeCard
              key={challenge.id}
              challenge={challenge}
              onPress={() =>
                router.push({
                  pathname: '/challenge/[id]',
                  params: { id: challenge.id },
                })
              }
            />
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: DD.bg,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: DD.s5,
  },
  headline: {
    fontSize: 32,
    fontWeight: '900',
    color: DD.text,
    letterSpacing: -1,
    marginBottom: DD.s1,
  },
  subline: {
    fontSize: 15,
    color: DD.textSub,
    marginBottom: DD.s5,
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusCard,
    borderWidth: 1,
    borderColor: DD.border,
    paddingHorizontal: DD.s4,
    paddingVertical: DD.s3,
    gap: DD.s3,
    marginBottom: DD.s1,
  },
  searchIcon: {
    fontSize: 16,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    color: DD.text,
    padding: 0,
  },
  resultsCount: {
    fontSize: 12,
    color: DD.textMuted,
    marginBottom: DD.s3,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: DD.s10,
    gap: DD.s3,
  },
  emptyIcon: {
    fontSize: 48,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: DD.text,
  },
  emptyText: {
    fontSize: 14,
    color: DD.textSub,
    textAlign: 'center',
  },
});
