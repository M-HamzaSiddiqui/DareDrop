import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CATEGORY_COLORS, CATEGORY_EMOJIS, CategoryKey, DD } from '@/constants/dd-theme';
import { calculateProgress, Challenge, formatParticipants, timeRemaining } from '@/data/challenges';
import { copyInviteLink, shareChallenge } from '@/lib/sharing';
import { useAuth } from '@/lib/auth-context';
import { useChallenges } from '@/store/challenges-store';

export default function InviteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { challenges, fetchChallengeById, joinChallenge, isUserJoined } = useChallenges();
  const { isGuest, showAuthModal } = useAuth();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isJoining, setIsJoining] = useState(false);
  const [justJoined, setJustJoined] = useState(false);
  const [copiedToast, setCopiedToast] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function load() {
      if (!id) {
        setError('No challenge ID provided in invite link.');
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const found = await fetchChallengeById(id);
        if (!isMounted) return;

        if (found) {
          setChallenge(found);
        } else {
          setError('Challenge not found. This dare may have ended or the invite link is invalid.');
        }
      } catch (err: any) {
        if (isMounted) {
          setError(err?.message || 'Failed to connect. Check your network or credentials.');
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    load();
    return () => {
      isMounted = false;
    };
  }, [id, fetchChallengeById]);

  async function handleAccept() {
    if (!challenge || isJoining) return;
    if (isGuest) {
      showAuthModal({
        title: 'Sign In to Accept Dare',
        description: 'Create an account or sign in to join this dare and track your completions.',
        onSuccess: () => {
          handleAccept();
        },
      });
      return;
    }
    setIsJoining(true);
    try {
      const res = await joinChallenge(challenge.id);
      if (res.success) {
        setJustJoined(true);
        const inStore = challenges.find((c) => c.id === challenge.id);
        setChallenge((prev) =>
          prev
            ? {
                ...prev,
                joined: true,
                participants: inStore ? inStore.participants : prev.participants + 1,
              }
            : null,
        );
      } else {
        setError(res.error || 'Failed to join challenge. Please try again.');
      }
    } catch (err: any) {
      setError(err?.message || 'Error accepting challenge.');
    } finally {
      setIsJoining(false);
    }
  }

  async function handleCopy() {
    if (!challenge) return;
    const res = await copyInviteLink(challenge);
    if (res.success) {
      setCopiedToast('✓ Invite link copied!');
      setTimeout(() => setCopiedToast(null), 2500);
    }
  }

  async function handleShare() {
    if (!challenge) return;
    await shareChallenge(challenge);
  }

  // Loading State
  if (loading) {
    return (
      <View style={[styles.root, styles.center]}>
        <StatusBar style="light" />
        <ActivityIndicator size="large" color={DD.lime} />
        <Text style={styles.loadingTitle}>Resolving Invite…</Text>
        <Text style={styles.loadingSubtitle}>Fetching challenge details from DareDrop</Text>
      </View>
    );
  }

  // Error / Invalid ID State
  if (error || !challenge) {
    return (
      <View style={[styles.root, styles.center, { paddingHorizontal: DD.s5 }]}>
        <StatusBar style="light" />
        <Text style={styles.errorIcon}>⚠️</Text>
        <Text style={styles.errorTitle}>Invite Expired or Invalid</Text>
        <Text style={styles.errorSubtitle}>
          {error || 'We could not find the challenge linked to this invite URL.'}
        </Text>
        <Pressable
          onPress={() => router.push('/')}
          style={({ pressed }) => [styles.exploreBtn, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
          accessibilityLabel="Browse active challenges">
          <Text style={styles.exploreBtnText}>Browse Active Dares →</Text>
        </Pressable>
      </View>
    );
  }

  const catColor = CATEGORY_COLORS[challenge.category as CategoryKey] || DD.lime;
  const emoji = CATEGORY_EMOJIS[challenge.category as CategoryKey] || '⚡';
  const timeLeft = timeRemaining(challenge.endsAt);
  const alreadyJoined = isUserJoined(challenge.id) || challenge.joined || justJoined;

  const { daysElapsed, progressPct } = calculateProgress(
    challenge.createdAt,
    challenge.durationDays,
  );

  return (
    <View style={styles.root}>
      <StatusBar style="light" />

      {/* Floating toast */}
      {copiedToast ? (
        <View style={[styles.toast, { top: insets.top + DD.s6 }]}>
          <Text style={styles.toastText}>{copiedToast}</Text>
        </View>
      ) : null}

      {/* Header bar */}
      <View style={[styles.navBar, { paddingTop: insets.top + DD.s2 }]}>
        <Pressable
          onPress={() => router.push('/')}
          style={({ pressed }) => [styles.navBtn, pressed && { opacity: 0.75 }]}
          accessibilityRole="button"
          accessibilityLabel="Home">
          <Text style={styles.navBtnText}>🏠 DareDrop</Text>
        </Pressable>

        <View style={styles.navRight}>
          <Pressable
            onPress={handleShare}
            style={({ pressed }) => [styles.navBtn, pressed && { opacity: 0.75 }]}
            accessibilityRole="button"
            accessibilityLabel="Share invite">
            <Text style={styles.navBtnText}>📤 Share</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 140 },
        ]}
        showsVerticalScrollIndicator={false}>
        {/* Invite Banner */}
        <View style={styles.inviteBanner}>
          <Text style={styles.bannerBadge}>INVITATION</Text>
          <Text style={styles.bannerHeadline}>{"You've been dared! ⚔️"}</Text>
          <Text style={styles.bannerSubtitle}>
            <Text style={styles.bannerCreator}>{challenge.creator}</Text> challenged you to take on this dare.
          </Text>
        </View>

        {/* Challenge Hero Card */}
        <View style={[styles.card, { borderColor: catColor + '44' }]}>
          <View style={[styles.categoryPill, { backgroundColor: catColor + '22' }]}>
            <Text style={[styles.categoryText, { color: catColor }]}>
              {emoji} {challenge.category}
            </Text>
          </View>

          <Text style={styles.challengeTitle}>{challenge.title}</Text>
          <Text style={styles.challengeDesc}>{challenge.description}</Text>

          {/* Quick Metrics */}
          <View style={styles.metricRow}>
            <View style={styles.metricItem}>
              <Text style={styles.metricIcon}>👥</Text>
              <Text style={styles.metricValue}>
                {formatParticipants(challenge.participants)}
              </Text>
              <Text style={styles.metricLabel}>Challengers</Text>
            </View>
            <View style={styles.metricDivider} />
            <View style={styles.metricItem}>
              <Text style={styles.metricIcon}>📅</Text>
              <Text style={[styles.metricValue, { color: DD.lime }]}>
                {challenge.durationDays}d
              </Text>
              <Text style={styles.metricLabel}>Duration</Text>
            </View>
            <View style={styles.metricDivider} />
            <View style={styles.metricItem}>
              <Text style={styles.metricIcon}>⏱</Text>
              <Text style={[styles.metricValue, { color: DD.catFun }]}>{timeLeft}</Text>
              <Text style={styles.metricLabel}>Time Left</Text>
            </View>
          </View>

          {/* Timeline progress */}
          <View style={styles.progressContainer}>
            <View style={styles.progressHeader}>
              <Text style={styles.progressLabel}>Challenge Timeline</Text>
              <Text style={[styles.progressPct, { color: catColor }]}>{progressPct}%</Text>
            </View>
            <View style={styles.progressBar}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${progressPct}%` as any, backgroundColor: catColor },
                ]}
              />
            </View>
            <Text style={styles.progressSubtext}>
              Day {daysElapsed + 1} of {challenge.durationDays}
            </Text>
          </View>
        </View>

        {/* Challenge Commitment Rules */}
        <View style={styles.rulesCard}>
          <Text style={styles.rulesTitle}>The DareDrop Pact</Text>
          {[
            'Accept the dare and lock in for the full duration',
            'Check in and share honest daily progress',
            'Cheer on and hold your squad accountable',
          ].map((rule, idx) => (
            <View key={idx} style={styles.ruleRow}>
              <View style={[styles.ruleBullet, { backgroundColor: catColor }]}>
                <Text style={styles.ruleBulletText}>{idx + 1}</Text>
              </View>
              <Text style={styles.ruleContent}>{rule}</Text>
            </View>
          ))}
        </View>

        {/* Share Section */}
        <View style={styles.shareSection}>
          <Pressable
            onPress={handleCopy}
            style={({ pressed }) => [styles.copyBtn, pressed && { opacity: 0.8 }]}
            accessibilityRole="button"
            accessibilityLabel="Copy invite link">
            <Text style={styles.copyBtnText}>🔗 Copy Invite Link to Challenge Friends</Text>
          </Pressable>
        </View>
      </ScrollView>

      {/* Floating Bottom CTA */}
      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + DD.s4 }]}>
        {alreadyJoined ? (
          <Pressable
            onPress={() => router.push(`/challenge/${challenge.id}`)}
            style={({ pressed }) => [
              styles.ctaButton,
              styles.ctaJoined,
              pressed && { opacity: 0.9, transform: [{ scale: 0.98 }] },
            ]}
            accessibilityRole="button"
            accessibilityLabel="View challenge details">
            <Text style={styles.ctaJoinedText}>{"✓ You're in this dare! View Challenge →"}</Text>
          </Pressable>
        ) : (
          <Pressable
            onPress={handleAccept}
            disabled={isJoining}
            style={({ pressed }) => [
              styles.ctaButton,
              { backgroundColor: catColor },
              pressed && !isJoining && { opacity: 0.88, transform: [{ scale: 0.98 }] },
              isJoining && { opacity: 0.7 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Accept dare and join">
            {isJoining ? (
              <ActivityIndicator color={DD.bg} size="small" />
            ) : (
              <Text style={styles.ctaButtonText}>⚔️ Accept Dare & Join</Text>
            )}
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: DD.bg,
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: DD.s5,
  },
  loadingTitle: {
    color: DD.text,
    fontSize: 18,
    fontWeight: '800',
    marginTop: DD.s4,
  },
  loadingSubtitle: {
    color: DD.textSub,
    fontSize: 13,
    marginTop: DD.s1,
  },
  errorIcon: {
    fontSize: 52,
    marginBottom: DD.s3,
  },
  errorTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: DD.text,
    textAlign: 'center',
  },
  errorSubtitle: {
    fontSize: 14,
    color: DD.textSub,
    textAlign: 'center',
    marginTop: DD.s2,
    lineHeight: 20,
    maxWidth: 300,
  },
  exploreBtn: {
    marginTop: DD.s6,
    backgroundColor: DD.lime,
    paddingVertical: DD.s3,
    paddingHorizontal: DD.s6,
    borderRadius: DD.radiusPill,
  },
  exploreBtnText: {
    color: DD.bg,
    fontWeight: '900',
    fontSize: 15,
  },
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 999,
    backgroundColor: DD.bgCard,
    borderWidth: 1.5,
    borderColor: DD.lime,
    paddingVertical: DD.s2,
    paddingHorizontal: DD.s4,
    borderRadius: DD.radiusPill,
    shadowColor: DD.lime,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  toastText: {
    color: DD.lime,
    fontSize: 13,
    fontWeight: '800',
  },
  navBar: {
    paddingHorizontal: DD.s5,
    paddingBottom: DD.s3,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: DD.bg,
    borderBottomWidth: 1,
    borderBottomColor: DD.border,
    zIndex: 10,
  },
  navBtn: {
    backgroundColor: DD.bgCard,
    paddingVertical: DD.s2,
    paddingHorizontal: DD.s3,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
    borderColor: DD.border,
  },
  navBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: DD.text,
  },
  navRight: {
    flexDirection: 'row',
    gap: DD.s2,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingTop: DD.s5,
    paddingHorizontal: DD.s5,
  },
  inviteBanner: {
    marginBottom: DD.s5,
  },
  bannerBadge: {
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 2,
    color: DD.lime,
    marginBottom: DD.s1,
  },
  bannerHeadline: {
    fontSize: 32,
    fontWeight: '900',
    color: DD.text,
    letterSpacing: -1,
    lineHeight: 38,
  },
  bannerSubtitle: {
    fontSize: 15,
    color: DD.textSub,
    marginTop: DD.s1,
    lineHeight: 22,
  },
  bannerCreator: {
    color: DD.text,
    fontWeight: '800',
  },
  card: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusLg,
    borderWidth: 1.5,
    padding: DD.s5,
    marginBottom: DD.s5,
  },
  categoryPill: {
    alignSelf: 'flex-start',
    paddingVertical: DD.s1,
    paddingHorizontal: DD.s3,
    borderRadius: DD.radiusPill,
    marginBottom: DD.s3,
  },
  categoryText: {
    fontSize: 12,
    fontWeight: '800',
  },
  challengeTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: DD.text,
    lineHeight: 28,
    marginBottom: DD.s2,
  },
  challengeDesc: {
    fontSize: 14,
    color: DD.textSub,
    lineHeight: 22,
    marginBottom: DD.s5,
  },
  metricRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    backgroundColor: DD.bgElement,
    borderRadius: DD.radiusMd,
    paddingVertical: DD.s3,
    paddingHorizontal: DD.s2,
    marginBottom: DD.s4,
  },
  metricItem: {
    alignItems: 'center',
    flex: 1,
  },
  metricDivider: {
    width: 1,
    height: 28,
    backgroundColor: DD.border,
  },
  metricIcon: {
    fontSize: 18,
    marginBottom: 2,
  },
  metricValue: {
    fontSize: 16,
    fontWeight: '900',
    color: DD.text,
  },
  metricLabel: {
    fontSize: 10,
    fontWeight: '600',
    color: DD.textMuted,
    marginTop: 2,
  },
  progressContainer: {
    gap: DD.s2,
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  progressLabel: {
    fontSize: 12,
    color: DD.textMuted,
    fontWeight: '600',
  },
  progressPct: {
    fontSize: 13,
    fontWeight: '800',
  },
  progressBar: {
    height: 8,
    backgroundColor: DD.bg,
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 4,
  },
  progressSubtext: {
    fontSize: 11,
    color: DD.textMuted,
  },
  rulesCard: {
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusLg,
    borderWidth: 1,
    borderColor: DD.border,
    padding: DD.s4,
    marginBottom: DD.s5,
    gap: DD.s3,
  },
  rulesTitle: {
    fontSize: 15,
    fontWeight: '800',
    color: DD.text,
    marginBottom: DD.s1,
  },
  ruleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s3,
  },
  ruleBullet: {
    width: 22,
    height: 22,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
  },
  ruleBulletText: {
    color: DD.bg,
    fontSize: 11,
    fontWeight: '900',
  },
  ruleContent: {
    flex: 1,
    fontSize: 13,
    color: DD.textSub,
    lineHeight: 18,
  },
  shareSection: {
    alignItems: 'center',
  },
  copyBtn: {
    backgroundColor: DD.bgCard,
    borderWidth: 1,
    borderColor: DD.border,
    paddingVertical: DD.s3,
    paddingHorizontal: DD.s4,
    borderRadius: DD.radiusPill,
  },
  copyBtnText: {
    color: DD.lime,
    fontSize: 12,
    fontWeight: '700',
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: DD.bg + 'F2',
    paddingHorizontal: DD.s5,
    paddingTop: DD.s3,
    borderTopWidth: 1,
    borderTopColor: DD.border,
  },
  ctaButton: {
    borderRadius: DD.radiusPill,
    paddingVertical: DD.s4,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: DD.lime,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  ctaButtonText: {
    fontSize: 16,
    fontWeight: '900',
    color: DD.bg,
    letterSpacing: 0.3,
  },
  ctaJoined: {
    backgroundColor: DD.lime + '22',
    borderWidth: 1.5,
    borderColor: DD.lime,
    shadowOpacity: 0,
  },
  ctaJoinedText: {
    fontSize: 15,
    fontWeight: '900',
    color: DD.lime,
  },
});
