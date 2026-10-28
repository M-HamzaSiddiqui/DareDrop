import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CATEGORY_COLORS, CATEGORY_EMOJIS, CategoryKey, DD } from '@/constants/dd-theme';
import { useAuth } from '@/lib/auth-context';
import { useChallenges } from '@/store/challenges-store';

const CATEGORIES: CategoryKey[] = ['Fitness', 'Focus', 'Fun', 'Learning'];
const PRESET_DURATIONS = [7, 14, 21, 30];

interface FormState {
  title: string;
  description: string;
  category: CategoryKey | '';
  durationDays: number;
  useCustomDeadline: boolean;
  customDays: string;
}

interface FormErrors {
  title?: string;
  description?: string;
  category?: string;
  customDays?: string;
}

export default function CreateScreen() {
  const insets = useSafeAreaInsets();
  const { createChallenge, refreshChallenges, isBackendConnected } = useChallenges();
  const { isGuest, showAuthModal } = useAuth();

  const [form, setForm] = useState<FormState>({
    title: '',
    description: '',
    category: '',
    durationDays: 14,
    useCustomDeadline: false,
    customDays: '45',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const effectiveDurationDays = useMemo(() => {
    if (form.useCustomDeadline) {
      const parsed = parseInt(form.customDays, 10);
      return isNaN(parsed) || parsed < 1 ? 14 : parsed;
    }
    return form.durationDays;
  }, [form.useCustomDeadline, form.customDays, form.durationDays]);

  const previewDeadlineText = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + effectiveDurationDays);
    return `${d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })} (${effectiveDurationDays} days from now)`;
  }, [effectiveDurationDays]);

  function validate(): FormErrors {
    const e: FormErrors = {};
    if (!form.title.trim()) {
      e.title = 'Title is required';
    } else if (form.title.trim().length < 5) {
      e.title = 'Title must be at least 5 characters';
    } else if (form.title.trim().length > 80) {
      e.title = 'Title must be under 80 characters';
    }

    if (!form.description.trim()) {
      e.description = 'Description is required';
    } else if (form.description.trim().length < 20) {
      e.description = 'Description must be at least 20 characters';
    }

    if (!form.category) {
      e.category = 'Please select a category';
    }

    if (form.useCustomDeadline) {
      const parsed = parseInt(form.customDays, 10);
      if (isNaN(parsed) || parsed < 1) {
        e.customDays = 'Duration must be at least 1 day';
      } else if (parsed > 365) {
        e.customDays = 'Duration cannot exceed 365 days';
      }
    }

    return e;
  }

  async function handleSubmit() {
    setSubmitError(null);
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) return;

    if (isGuest) {
      showAuthModal('Account required to create a Dare. Sign in or register to publish challenges!');
      return;
    }

    setIsSubmitting(true);

    try {
      const endsAt = new Date();
      endsAt.setDate(endsAt.getDate() + effectiveDurationDays);

      const newChallenge = await createChallenge({
        title: form.title.trim(),
        description: form.description.trim(),
        category: form.category as CategoryKey,
        durationDays: effectiveDurationDays,
        endsAt,
        creator: 'You',
      });

      await refreshChallenges().catch(() => {});

      setCreatedId(newChallenge.id);
      setSubmitted(true);
    } catch (err: any) {
      setSubmitError(err?.message || 'Failed to create challenge. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleReset() {
    setForm({
      title: '',
      description: '',
      category: '',
      durationDays: 14,
      useCustomDeadline: false,
      customDays: '45',
    });
    setErrors({});
    setSubmitError(null);
    setSubmitted(false);
    setCreatedId(null);
  }

  if (submitted && createdId) {
    return (
      <SuccessState
        challengeId={createdId}
        onView={() => router.push(`/challenge/${createdId}`)}
        onNew={handleReset}
      />
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <StatusBar style="light" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + DD.s5, paddingBottom: insets.bottom + 120 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        {/* Header */}
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.headline}>Create a{'\n'}Challenge</Text>
            <Text style={styles.subline}>Dare yourself and others to be better.</Text>
          </View>
          <View
            style={[
              styles.backendBadge,
              isBackendConnected ? styles.backendBadgeOnline : styles.backendBadgeLocal,
            ]}>
            <Text
              style={[
                styles.backendBadgeText,
                isBackendConnected ? styles.backendBadgeTextOnline : styles.backendBadgeTextLocal,
              ]}>
              {isBackendConnected ? '● Cloud Synced' : '○ Local Mode'}
            </Text>
          </View>
        </View>

        {/* Global error banner */}
        {submitError ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerIcon}>⚠️</Text>
            <Text style={styles.errorBannerText}>{submitError}</Text>
          </View>
        ) : null}

        {/* Title field */}
        <FormField label="Challenge Title" error={errors.title} required>
          <TextInput
            style={[styles.input, errors.title && styles.inputError]}
            placeholder="e.g. 30-Day Morning Run"
            placeholderTextColor={DD.textMuted}
            value={form.title}
            onChangeText={(v) => {
              setForm((f) => ({ ...f, title: v }));
              if (errors.title) setErrors((e) => ({ ...e, title: undefined }));
            }}
            maxLength={80}
            returnKeyType="next"
            accessibilityLabel="Challenge title"
            editable={!isSubmitting}
          />
          <Text style={styles.charCount}>{form.title.length}/80</Text>
        </FormField>

        {/* Description field */}
        <FormField label="Description" error={errors.description} required>
          <TextInput
            style={[styles.input, styles.textArea, errors.description && styles.inputError]}
            placeholder="Describe what participants will do, how to track progress, and why it matters…"
            placeholderTextColor={DD.textMuted}
            value={form.description}
            onChangeText={(v) => {
              setForm((f) => ({ ...f, description: v }));
              if (errors.description) setErrors((e) => ({ ...e, description: undefined }));
            }}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            accessibilityLabel="Challenge description"
            editable={!isSubmitting}
          />
        </FormField>

        {/* Category selector */}
        <FormField label="Category" error={errors.category} required>
          <View style={styles.categoryGrid}>
            {CATEGORIES.map((cat) => {
              const isSelected = form.category === cat;
              const color = CATEGORY_COLORS[cat];
              return (
                <Pressable
                  key={cat}
                  onPress={() => {
                    if (isSubmitting) return;
                    setForm((f) => ({ ...f, category: cat }));
                    if (errors.category) setErrors((e) => ({ ...e, category: undefined }));
                  }}
                  style={({ pressed }) => [
                    styles.categoryOption,
                    isSelected && {
                      borderColor: color,
                      backgroundColor: color + '18',
                    },
                    pressed && { opacity: 0.8 },
                  ]}
                  accessibilityRole="radio"
                  accessibilityLabel={`Category ${cat}`}
                  accessibilityState={{ checked: isSelected }}>
                  <Text style={styles.categoryEmoji}>{CATEGORY_EMOJIS[cat]}</Text>
                  <Text style={[styles.categoryLabel, isSelected && { color }]}>{cat}</Text>
                </Pressable>
              );
            })}
          </View>
        </FormField>

        {/* Duration / Deadline selector */}
        <FormField label="Duration & Deadline">
          <View style={styles.deadlineToggleRow}>
            <Pressable
              onPress={() => setForm((f) => ({ ...f, useCustomDeadline: false }))}
              style={[
                styles.deadlineTab,
                !form.useCustomDeadline && styles.deadlineTabActive,
              ]}>
              <Text
                style={[
                  styles.deadlineTabText,
                  !form.useCustomDeadline && styles.deadlineTabTextActive,
                ]}>
                Preset Durations
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setForm((f) => ({ ...f, useCustomDeadline: true }))}
              style={[
                styles.deadlineTab,
                form.useCustomDeadline && styles.deadlineTabActive,
              ]}>
              <Text
                style={[
                  styles.deadlineTabText,
                  form.useCustomDeadline && styles.deadlineTabTextActive,
                ]}>
                Custom Days
              </Text>
            </Pressable>
          </View>

          {!form.useCustomDeadline ? (
            <View style={styles.durationRow}>
              {PRESET_DURATIONS.map((d) => {
                const isSelected = form.durationDays === d;
                return (
                  <Pressable
                    key={d}
                    onPress={() => {
                      if (isSubmitting) return;
                      setForm((f) => ({ ...f, durationDays: d }));
                    }}
                    style={({ pressed }) => [
                      styles.durationChip,
                      isSelected && styles.durationChipActive,
                      pressed && { opacity: 0.8 },
                    ]}
                    accessibilityRole="radio"
                    accessibilityLabel={`${d} days`}
                    accessibilityState={{ checked: isSelected }}>
                    <Text style={[styles.durationNumber, isSelected && styles.durationNumberActive]}>
                      {d}
                    </Text>
                    <Text style={[styles.durationUnit, isSelected && { color: DD.lime }]}>days</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <View style={styles.customDurationContainer}>
              <TextInput
                style={[styles.input, styles.customInput, errors.customDays && styles.inputError]}
                placeholder="e.g. 45"
                placeholderTextColor={DD.textMuted}
                keyboardType="number-pad"
                value={form.customDays}
                onChangeText={(v) => {
                  setForm((f) => ({ ...f, customDays: v.replace(/[^0-9]/g, '') }));
                  if (errors.customDays) setErrors((e) => ({ ...e, customDays: undefined }));
                }}
                maxLength={3}
                accessibilityLabel="Custom challenge days"
                editable={!isSubmitting}
              />
              <Text style={styles.customDaysLabel}>Days total</Text>
            </View>
          )}

          {errors.customDays ? <Text style={fieldStyles.error}>{errors.customDays}</Text> : null}

          {/* Computed deadline display */}
          <View style={styles.deadlinePreviewBox}>
            <Text style={styles.deadlinePreviewLabel}>Target End Date:</Text>
            <Text style={styles.deadlinePreviewValue}>{previewDeadlineText}</Text>
          </View>
        </FormField>

        {/* Submit button */}
        <Pressable
          onPress={handleSubmit}
          disabled={isSubmitting}
          style={({ pressed }) => [
            styles.submitButton,
            isSubmitting && styles.submitButtonDisabled,
            pressed && !isSubmitting && styles.submitButtonPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel="Create challenge">
          {isSubmitting ? (
            <View style={styles.submittingContent}>
              <ActivityIndicator color={DD.bg} size="small" />
              <Text style={styles.submitButtonText}>Creating Challenge…</Text>
            </View>
          ) : (
            <Text style={styles.submitButtonText}>🚀 Launch Challenge</Text>
          )}
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function FormField({
  label,
  error,
  required,
  children,
}: {
  label: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <View style={fieldStyles.container}>
      <View style={fieldStyles.labelRow}>
        <Text style={fieldStyles.label}>{label}</Text>
        {required && <Text style={fieldStyles.required}>*</Text>}
      </View>
      {children}
      {error ? <Text style={fieldStyles.error}>{error}</Text> : null}
    </View>
  );
}

function SuccessState({
  challengeId,
  onView,
  onNew,
}: {
  challengeId: string;
  onView: () => void;
  onNew: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[successStyles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={successStyles.content}>
        <Text style={successStyles.icon}>🎉</Text>
        <Text style={successStyles.title}>Challenge Created!</Text>
        <Text style={successStyles.subtitle}>
          Your challenge is live and ready for challengers to join.
        </Text>

        <View style={successStyles.checkList}>
          {[
            'Challenge published to DareDrop',
            'You are registered as Challenger #1',
            'Shareable invite link generated',
          ].map((item) => (
            <View key={item} style={successStyles.checkItem}>
              <Text style={successStyles.checkMark}>✓</Text>
              <Text style={successStyles.checkText}>{item}</Text>
            </View>
          ))}
        </View>

        <Pressable
          onPress={onView}
          style={({ pressed }) => [successStyles.primaryBtn, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
          accessibilityLabel="View challenge and invite friends">
          <Text style={successStyles.primaryBtnText}>View Challenge & Invite →</Text>
        </Pressable>

        <Pressable
          onPress={onNew}
          style={({ pressed }) => [successStyles.secondaryBtn, pressed && { opacity: 0.75 }]}
          accessibilityRole="button"
          accessibilityLabel="Create another challenge">
          <Text style={successStyles.secondaryBtnText}>Create Another</Text>
        </Pressable>
      </View>
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
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: DD.s5,
  },
  headline: {
    fontSize: 32,
    fontWeight: '900',
    color: DD.text,
    letterSpacing: -1,
    lineHeight: 38,
  },
  subline: {
    fontSize: 14,
    color: DD.textSub,
    marginTop: DD.s1,
  },
  backendBadge: {
    paddingVertical: DD.s1,
    paddingHorizontal: DD.s2,
    borderRadius: DD.radiusPill,
    borderWidth: 1,
  },
  backendBadgeOnline: {
    backgroundColor: DD.lime + '18',
    borderColor: DD.lime + '44',
  },
  backendBadgeLocal: {
    backgroundColor: DD.bgElement,
    borderColor: DD.border,
  },
  backendBadgeText: {
    fontSize: 11,
    fontWeight: '700',
  },
  backendBadgeTextOnline: {
    color: DD.lime,
  },
  backendBadgeTextLocal: {
    color: DD.textMuted,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: DD.catFun + '22',
    borderWidth: 1,
    borderColor: DD.catFun,
    padding: DD.s3,
    borderRadius: DD.radiusMd,
    marginBottom: DD.s4,
    gap: DD.s2,
  },
  errorBannerIcon: {
    fontSize: 18,
  },
  errorBannerText: {
    flex: 1,
    color: DD.catFun,
    fontSize: 13,
    fontWeight: '600',
  },
  input: {
    backgroundColor: DD.bgCard,
    borderWidth: 1.5,
    borderColor: DD.border,
    borderRadius: DD.radiusLg,
    paddingHorizontal: DD.s4,
    paddingVertical: DD.s3,
    fontSize: 15,
    color: DD.text,
  },
  inputError: {
    borderColor: DD.catFun,
  },
  textArea: {
    height: 110,
    paddingTop: DD.s3,
  },
  charCount: {
    fontSize: 11,
    color: DD.textMuted,
    textAlign: 'right',
    marginTop: DD.s1,
  },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: DD.s2,
  },
  categoryOption: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: DD.bgCard,
    borderWidth: 1.5,
    borderColor: DD.border,
    borderRadius: DD.radiusLg,
    paddingVertical: DD.s3,
    paddingHorizontal: DD.s3,
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s2,
  },
  categoryEmoji: {
    fontSize: 20,
  },
  categoryLabel: {
    fontSize: 14,
    fontWeight: '700',
    color: DD.textSub,
  },
  deadlineToggleRow: {
    flexDirection: 'row',
    backgroundColor: DD.bgCard,
    borderRadius: DD.radiusPill,
    padding: 3,
    marginBottom: DD.s3,
    borderWidth: 1,
    borderColor: DD.border,
  },
  deadlineTab: {
    flex: 1,
    paddingVertical: DD.s2,
    alignItems: 'center',
    borderRadius: DD.radiusPill,
  },
  deadlineTabActive: {
    backgroundColor: DD.bgElement,
  },
  deadlineTabText: {
    fontSize: 12,
    fontWeight: '700',
    color: DD.textMuted,
  },
  deadlineTabTextActive: {
    color: DD.lime,
  },
  durationRow: {
    flexDirection: 'row',
    gap: DD.s2,
  },
  durationChip: {
    flex: 1,
    backgroundColor: DD.bgCard,
    borderWidth: 1.5,
    borderColor: DD.border,
    borderRadius: DD.radiusLg,
    paddingVertical: DD.s3,
    alignItems: 'center',
  },
  durationChipActive: {
    borderColor: DD.lime,
    backgroundColor: DD.lime + '14',
  },
  durationNumber: {
    fontSize: 20,
    fontWeight: '900',
    color: DD.textSub,
  },
  durationNumberActive: {
    color: DD.lime,
  },
  durationUnit: {
    fontSize: 11,
    color: DD.textMuted,
    fontWeight: '600',
  },
  customDurationContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s3,
  },
  customInput: {
    width: 100,
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '800',
  },
  customDaysLabel: {
    fontSize: 14,
    color: DD.textSub,
    fontWeight: '600',
  },
  deadlinePreviewBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: DD.bgCard,
    paddingHorizontal: DD.s3,
    paddingVertical: DD.s2,
    borderRadius: DD.radiusMd,
    marginTop: DD.s2,
  },
  deadlinePreviewLabel: {
    fontSize: 12,
    color: DD.textMuted,
    fontWeight: '600',
  },
  deadlinePreviewValue: {
    fontSize: 12,
    color: DD.lime,
    fontWeight: '700',
  },
  submitButton: {
    backgroundColor: DD.lime,
    borderRadius: DD.radiusPill,
    paddingVertical: DD.s4,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: DD.s4,
    shadowColor: DD.lime,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  submitButtonDisabled: {
    opacity: 0.65,
  },
  submitButtonPressed: {
    opacity: 0.9,
    transform: [{ scale: 0.98 }],
  },
  submittingContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s2,
  },
  submitButtonText: {
    fontSize: 16,
    fontWeight: '900',
    color: DD.bg,
    letterSpacing: 0.3,
  },
});

const fieldStyles = StyleSheet.create({
  container: {
    marginBottom: DD.s5,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: DD.s2,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: DD.textSub,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  required: {
    color: DD.lime,
    fontSize: 14,
    fontWeight: '900',
  },
  error: {
    fontSize: 12,
    color: DD.catFun,
    marginTop: DD.s1,
    fontWeight: '600',
  },
});

const successStyles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: DD.bg,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: DD.s5,
  },
  content: {
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
  },
  icon: {
    fontSize: 64,
    marginBottom: DD.s4,
  },
  title: {
    fontSize: 28,
    fontWeight: '900',
    color: DD.text,
    letterSpacing: -0.5,
    textAlign: 'center',
    marginBottom: DD.s2,
  },
  subtitle: {
    fontSize: 15,
    color: DD.textSub,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: DD.s6,
  },
  checkList: {
    width: '100%',
    backgroundColor: DD.bgCard,
    borderWidth: 1,
    borderColor: DD.border,
    borderRadius: DD.radiusLg,
    padding: DD.s4,
    gap: DD.s3,
    marginBottom: DD.s6,
  },
  checkItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD.s3,
  },
  checkMark: {
    color: DD.lime,
    fontSize: 16,
    fontWeight: '900',
  },
  checkText: {
    fontSize: 14,
    color: DD.text,
    fontWeight: '600',
  },
  primaryBtn: {
    width: '100%',
    backgroundColor: DD.lime,
    borderRadius: DD.radiusPill,
    paddingVertical: DD.s4,
    alignItems: 'center',
    marginBottom: DD.s3,
  },
  primaryBtnText: {
    fontSize: 16,
    fontWeight: '900',
    color: DD.bg,
  },
  secondaryBtn: {
    width: '100%',
    borderWidth: 1.5,
    borderColor: DD.border,
    borderRadius: DD.radiusPill,
    paddingVertical: DD.s3,
    alignItems: 'center',
  },
  secondaryBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: DD.textSub,
  },
});
