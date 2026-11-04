import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  CATEGORY_COLORS,
  CategoryKey,
  DD_COLORS,
  DD_RADII,
  DD_SPACING,
} from '@/constants/dd-theme';
import { ProofConfig, ProofMethod } from '@/data/challenges';
import { DDBadge } from '@/components/ui/dd-badge';
import { DDButton } from '@/components/ui/dd-button';
import { DDCard } from '@/components/ui/dd-card';
import { DDIcon, type DDIconName } from '@/components/ui/dd-icon';
import { DDText } from '@/components/ui/dd-text';
import { useToast, sanitizeUserErrorMessage } from '@/components/ui/dd-toast';
import { useAuth } from '@/lib/auth-context';
import { useChallenges } from '@/store/challenges-store';

const CATEGORIES: CategoryKey[] = ['Fitness', 'Focus', 'Fun', 'Learning'];
const PRESET_DURATIONS = [7, 14, 21, 30];

const CATEGORY_ICONS: Record<CategoryKey, DDIconName> = {
  Fitness: 'flame',
  Focus: 'target',
  Fun: 'sparkle',
  Learning: 'compass',
};

const PROOF_METHODS: {
  id: ProofMethod;
  title: string;
  badge: string;
  description: string;
  icon: DDIconName;
}[] = [
  {
    id: 'physical_action',
    title: 'Gesture + Code',
    badge: 'Anti-Cheat',
    description: 'Evidence showing a 4-character code and a random physical gesture',
    icon: 'shield-check',
  },
  {
    id: 'photo_code',
    title: 'Photo + Code',
    badge: 'Visual',
    description: 'Photo showing a unique 4-character code on paper or screen',
    icon: 'sparkle',
  },
  {
    id: 'numeric_entry',
    title: 'Number',
    badge: 'Metric',
    description: 'Log an amount or count (e.g. km, reps, pages, minutes)',
    icon: 'target',
  },
  {
    id: 'text_log',
    title: 'Written Log',
    badge: 'Reflection',
    description: 'Write a short reflection or summary (5 to 500 characters)',
    icon: 'compass',
  },
  {
    id: 'peer_confirmation',
    title: 'Peer Confirmation',
    badge: 'Quick',
    description: 'Referee or peer directly vouches that you completed the dare',
    icon: 'users',
  },
];

function getDefaultProofMethod(cat: CategoryKey): ProofMethod {
  switch (cat) {
    case 'Fitness':
      return 'physical_action';
    case 'Focus':
    case 'Learning':
      return 'text_log';
    case 'Fun':
      return 'photo_code';
    default:
      return 'physical_action';
  }
}

interface FormState {
  title: string;
  description: string;
  category: CategoryKey | '';
  challengeType: 'daily' | 'one_time';
  durationDays: number;
  useCustomDeadline: boolean;
  customDays: string;
  proofMethod: ProofMethod;
  proofUnit: string;
  proofMinValue: string;
  proofMaxValue: string;
}

interface FormErrors {
  title?: string;
  description?: string;
  category?: string;
  customDays?: string;
  proofUnit?: string;
  proofRange?: string;
}

/**
 * DareDrop Redesigned Create Dare Screen.
 *
 * Implements:
 * - Clean header with branding and backend connectivity badge
 * - Character-counted Title and Description inputs with accessible contrast
 * - Visual Dare Type selector cards (Daily Dare vs One-Time Dare) with lime accenting
 * - Category grid with Phosphor vector icons and signature category tints
 * - Preset vs Custom duration selector with computed target end date preview
 * - Live Dare Summary Preview card showing real-time configuration
 * - High-impact Launch CTA with duplicate-submit protection and loading states
 * - Frictionless Success state with direct challenge navigation and deep-link generation
 */
export default function CreateScreen() {
  const insets = useSafeAreaInsets();
  const { createChallenge, refreshChallenges, isBackendConnected } = useChallenges();
  const { isGuest, showAuthModal } = useAuth();
  const toast = useToast();

  const [form, setForm] = useState<FormState>({
    title: '',
    description: '',
    category: '',
    challengeType: 'daily',
    durationDays: 14,
    useCustomDeadline: false,
    customDays: '45',
    proofMethod: 'physical_action',
    proofUnit: '',
    proofMinValue: '',
    proofMaxValue: '',
  });
  const [hasManuallySelectedMethod, setHasManuallySelectedMethod] = useState(false);
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

    if (form.proofMethod === 'numeric_entry') {
      if (form.proofUnit.trim().length > 12) {
        e.proofUnit = 'Unit must be 12 characters or less';
      }
      const minVal = parseFloat(form.proofMinValue);
      const maxVal = parseFloat(form.proofMaxValue);
      if (!isNaN(minVal) && minVal < 0) {
        e.proofRange = 'Minimum value must be at least 0';
      } else if (!isNaN(maxVal) && maxVal < 0) {
        e.proofRange = 'Maximum value must be at least 0';
      } else if (!isNaN(minVal) && minVal > 1000000) {
        e.proofRange = 'Minimum value cannot exceed 1,000,000';
      } else if (!isNaN(maxVal) && maxVal > 1000000) {
        e.proofRange = 'Maximum value cannot exceed 1,000,000';
      } else if (!isNaN(minVal) && !isNaN(maxVal) && minVal > maxVal) {
        e.proofRange = 'Minimum value cannot be greater than maximum value';
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
      showAuthModal({
        title: 'Sign In to Create Dare',
        description: 'Account required to create a Dare. Sign in or register to publish challenges!',
        onSuccess: handleSubmit,
      });
      return;
    }

    setIsSubmitting(true);

    try {
      const endsAt = new Date();
      endsAt.setDate(endsAt.getDate() + effectiveDurationDays);

      const proofConfig: ProofConfig = {};
      if (form.proofMethod === 'numeric_entry') {
        if (form.proofUnit.trim()) {
          proofConfig.unit = form.proofUnit.trim();
        }
        if (form.proofMinValue.trim()) {
          const minNum = parseFloat(form.proofMinValue.trim());
          if (!isNaN(minNum)) proofConfig.min_value = minNum;
        }
        if (form.proofMaxValue.trim()) {
          const maxNum = parseFloat(form.proofMaxValue.trim());
          if (!isNaN(maxNum)) proofConfig.max_value = maxNum;
        }
      }

      const newChallenge = await createChallenge({
        title: form.title.trim(),
        description: form.description.trim(),
        category: form.category as CategoryKey,
        durationDays: effectiveDurationDays,
        endsAt,
        creator: 'You',
        challengeType: form.challengeType,
        proofMethod: form.proofMethod,
        proofConfig,
      });

      await refreshChallenges().catch(() => {});

      setCreatedId(newChallenge.id);
      setSubmitted(true);
      toast.success('Dare published successfully!');
    } catch (err: any) {
      const msg = sanitizeUserErrorMessage(err?.message, 'Failed to create challenge. Please try again.');
      setSubmitError(msg);
      toast.error(msg);
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleReset() {
    setForm({
      title: '',
      description: '',
      category: '',
      challengeType: 'daily',
      durationDays: 14,
      useCustomDeadline: false,
      customDays: '45',
      proofMethod: 'physical_action',
      proofUnit: '',
      proofMinValue: '',
      proofMaxValue: '',
    });
    setHasManuallySelectedMethod(false);
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
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <StatusBar style="light" />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + DD_SPACING.lg, paddingBottom: insets.bottom + 110 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        {/* A. Header Section */}
        <View style={styles.headerRow}>
          <View style={styles.headerTexts}>
            <View style={styles.brandRow}>
              <View style={styles.flameIconWrapper}>
                <DDIcon name="plus" size={14} color={DD_COLORS.lime} weight="bold" />
              </View>
              <DDText variant="caption" color="lime" bold style={styles.tagline}>
                NEW CHALLENGE
              </DDText>
            </View>
            <DDText variant="display" color="primary" style={styles.headline}>
              Create a Dare
            </DDText>
            <DDText variant="bodySm" color="secondary" style={styles.subline}>
              Dare yourself and invite others to be better.
            </DDText>
          </View>

          <View
            style={[
              styles.backendBadge,
              isBackendConnected ? styles.backendBadgeOnline : styles.backendBadgeLocal,
            ]}>
            <View
              style={[
                styles.backendDot,
                { backgroundColor: isBackendConnected ? DD_COLORS.success : DD_COLORS.warning },
              ]}
            />
            <DDText
              variant="caption"
              bold
              style={{
                color: isBackendConnected ? DD_COLORS.success : DD_COLORS.warning,
                fontSize: 10,
              }}>
              {isBackendConnected ? 'Cloud Synced' : 'Local Mode'}
            </DDText>
          </View>
        </View>

        {/* Global error banner */}
        {submitError ? (
          <View style={styles.errorBanner}>
            <DDIcon name="warning" size={18} color={DD_COLORS.danger} weight="bold" />
            <DDText variant="bodySm" color="danger" style={styles.errorBannerText}>
              {submitError}
            </DDText>
          </View>
        ) : null}

        {/* B. Title Field */}
        <FormField label="Dare Title" error={errors.title} required>
          <View style={[styles.inputCard, errors.title && styles.inputCardError]}>
            <TextInput
              style={styles.textInput}
              placeholder="e.g. 30-Day Morning Pushups"
              placeholderTextColor={DD_COLORS.textMuted}
              value={form.title}
              onChangeText={(v) => {
                setForm((f) => ({ ...f, title: v }));
                if (errors.title) setErrors((e) => ({ ...e, title: undefined }));
              }}
              maxLength={80}
              returnKeyType="next"
              accessibilityLabel="Dare title input"
              editable={!isSubmitting}
            />
            <DDText variant="caption" color="muted" style={styles.charCount}>
              {form.title.length}/80
            </DDText>
          </View>
        </FormField>

        {/* C. Description Field */}
        <FormField label="Description & Instructions" error={errors.description} required>
          <View style={[styles.inputCard, errors.description && styles.inputCardError]}>
            <TextInput
              style={[styles.textInput, styles.textAreaInput]}
              placeholder="Explain what participants will do daily and how they will prove completion…"
              placeholderTextColor={DD_COLORS.textMuted}
              value={form.description}
              onChangeText={(v) => {
                setForm((f) => ({ ...f, description: v }));
                if (errors.description) setErrors((e) => ({ ...e, description: undefined }));
              }}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              accessibilityLabel="Dare description input"
              editable={!isSubmitting}
            />
            <DDText variant="caption" color="muted" style={styles.charCount}>
              {form.description.length} chars (min 20)
            </DDText>
          </View>
        </FormField>

        {/* D. Dare Type Selector */}
        <FormField label="Dare Type" required>
          <View style={styles.typeSelectorRow}>
            {/* Daily Dare Card */}
            <Pressable
              onPress={() => {
                if (isSubmitting) return;
                setForm((f) => ({ ...f, challengeType: 'daily' }));
              }}
              android_ripple={{ color: 'rgba(191, 253, 64, 0.1)', borderless: false }}
              style={({ pressed }) => [
                styles.typeCard,
                form.challengeType === 'daily' && styles.typeCardActive,
                pressed && styles.cardPressed,
              ]}
              accessibilityRole="radio"
              accessibilityLabel="Daily Dare"
              accessibilityState={{ checked: form.challengeType === 'daily' }}>
              <View style={styles.typeHeaderRow}>
                <View
                  style={[
                    styles.typeIconCircle,
                    form.challengeType === 'daily' && styles.typeIconCircleActive,
                  ]}>
                  <DDIcon
                    name="flame"
                    size={20}
                    color={form.challengeType === 'daily' ? DD_COLORS.lime : DD_COLORS.textMuted}
                    weight="fill"
                  />
                </View>
                <View style={styles.typeTitleCol}>
                  <DDText
                    variant="label"
                    bold
                    color={form.challengeType === 'daily' ? 'lime' : 'primary'}
                    style={styles.typeTitle}>
                    Daily Dare
                  </DDText>
                  <DDBadge label="Streaks" variant="lime" size="sm" />
                </View>
              </View>
              <DDText variant="bodySm" color="secondary" style={styles.typeDescription}>
                Recurring daily progress with streak badges. Submit proof every calendar day.
              </DDText>
            </Pressable>

            {/* One-Time Dare Card */}
            <Pressable
              onPress={() => {
                if (isSubmitting) return;
                setForm((f) => ({ ...f, challengeType: 'one_time' }));
              }}
              android_ripple={{ color: 'rgba(155, 89, 255, 0.1)', borderless: false }}
              style={({ pressed }) => [
                styles.typeCard,
                form.challengeType === 'one_time' && styles.typeCardActiveViolet,
                pressed && styles.cardPressed,
              ]}
              accessibilityRole="radio"
              accessibilityLabel="One-Time Dare"
              accessibilityState={{ checked: form.challengeType === 'one_time' }}>
              <View style={styles.typeHeaderRow}>
                <View
                  style={[
                    styles.typeIconCircle,
                    form.challengeType === 'one_time' && styles.typeIconCircleActiveViolet,
                  ]}>
                  <DDIcon
                    name="target"
                    size={20}
                    color={form.challengeType === 'one_time' ? DD_COLORS.purple : DD_COLORS.textMuted}
                    weight="bold"
                  />
                </View>
                <View style={styles.typeTitleCol}>
                  <DDText
                    variant="label"
                    bold
                    color={form.challengeType === 'one_time' ? 'purple' : 'primary'}
                    style={styles.typeTitle}>
                    One-Time Dare
                  </DDText>
                  <DDBadge label="Milestone" variant="purple" size="sm" />
                </View>
              </View>
              <DDText variant="bodySm" color="secondary" style={styles.typeDescription}>
                One milestone goal verified once. Complete before the target countdown expires.
              </DDText>
            </Pressable>
          </View>
        </FormField>

        {/* E. Category Selector */}
        <FormField label="Category" error={errors.category} required>
          <View style={styles.categoryGrid}>
            {CATEGORIES.map((cat) => {
              const isSelected = form.category === cat;
              const color = CATEGORY_COLORS[cat];
              const iconName = CATEGORY_ICONS[cat];

              return (
                <Pressable
                  key={cat}
                  onPress={() => {
                    if (isSubmitting) return;
                    setForm((f) => ({
                      ...f,
                      category: cat,
                      proofMethod: hasManuallySelectedMethod ? f.proofMethod : getDefaultProofMethod(cat),
                    }));
                    if (errors.category) setErrors((e) => ({ ...e, category: undefined }));
                  }}
                  android_ripple={{ color: 'rgba(255, 255, 255, 0.08)', borderless: false }}
                  style={({ pressed }) => [
                    styles.categoryCard,
                    isSelected && {
                      borderColor: color,
                      backgroundColor: color + '15',
                    },
                    pressed && styles.cardPressed,
                  ]}
                  accessibilityRole="radio"
                  accessibilityLabel={`Category ${cat}`}
                  accessibilityState={{ checked: isSelected }}>
                  <View
                    style={[
                      styles.categoryIconCircle,
                      { backgroundColor: isSelected ? color + '25' : DD_COLORS.bgHighlight },
                    ]}>
                    <DDIcon
                      name={iconName}
                      size={20}
                      color={isSelected ? color : DD_COLORS.textMuted}
                      weight={isSelected ? 'fill' : 'bold'}
                    />
                  </View>
                  <DDText
                    variant="label"
                    bold
                    style={[styles.categoryLabel, { color: isSelected ? color : DD_COLORS.textSub }]}>
                    {cat}
                  </DDText>
                </Pressable>
              );
            })}
          </View>
        </FormField>

        {/* F. Proof Method Selector */}
        <FormField
          label="How will completion be proven?"
          error={errors.proofUnit || errors.proofRange}
          required>
          <View style={styles.proofMethodList}>
            {PROOF_METHODS.map((pm) => {
              const isSelected = form.proofMethod === pm.id;
              return (
                <Pressable
                  key={pm.id}
                  onPress={() => {
                    if (isSubmitting) return;
                    setHasManuallySelectedMethod(true);
                    setForm((f) => ({ ...f, proofMethod: pm.id }));
                  }}
                  android_ripple={{ color: 'rgba(191, 253, 64, 0.08)', borderless: false }}
                  style={({ pressed }) => [
                    styles.proofMethodCard,
                    isSelected && styles.proofMethodCardActive,
                    pressed && styles.cardPressed,
                  ]}
                  accessibilityRole="radio"
                  accessibilityLabel={pm.title}
                  accessibilityState={{ checked: isSelected }}>
                  <View style={styles.proofMethodHeader}>
                    <View
                      style={[
                        styles.proofMethodIconCircle,
                        isSelected && styles.proofMethodIconCircleActive,
                      ]}>
                      <DDIcon
                        name={pm.icon}
                        size={18}
                        color={isSelected ? DD_COLORS.lime : DD_COLORS.textMuted}
                        weight={isSelected ? 'fill' : 'bold'}
                      />
                    </View>
                    <View style={styles.proofMethodTitleGroup}>
                      <View style={styles.proofMethodTitleRow}>
                        <DDText
                          variant="label"
                          bold
                          color={isSelected ? 'lime' : 'primary'}
                          style={styles.proofMethodTitle}>
                          {pm.title}
                        </DDText>
                        <DDBadge
                          label={pm.badge}
                          variant={isSelected ? 'lime' : 'neutral'}
                          size="sm"
                        />
                      </View>
                      <DDText variant="caption" color="secondary" style={styles.proofMethodDesc}>
                        {pm.description}
                      </DDText>
                    </View>
                  </View>
                </Pressable>
              );
            })}
          </View>

          {/* Optional Numeric Configuration */}
          {form.proofMethod === 'numeric_entry' && (
            <View style={styles.numericConfigBox}>
              <DDText variant="caption" color="muted" bold style={styles.numericConfigHeader}>
                NUMERIC PARAMETERS (OPTIONAL)
              </DDText>
              <View style={styles.numericInputsRow}>
                <View style={styles.numericFieldCol}>
                  <DDText variant="caption" color="secondary" style={styles.numericFieldLabel}>
                    Unit (e.g. km, reps)
                  </DDText>
                  <TextInput
                    style={[styles.numericInput, errors.proofUnit && styles.inputErrorBorder]}
                    placeholder="km"
                    placeholderTextColor={DD_COLORS.textMuted}
                    value={form.proofUnit}
                    onChangeText={(v) => {
                      setForm((f) => ({ ...f, proofUnit: v.slice(0, 12) }));
                      if (errors.proofUnit) setErrors((e) => ({ ...e, proofUnit: undefined }));
                    }}
                    maxLength={12}
                    editable={!isSubmitting}
                  />
                </View>

                <View style={styles.numericFieldCol}>
                  <DDText variant="caption" color="secondary" style={styles.numericFieldLabel}>
                    Min Value
                  </DDText>
                  <TextInput
                    style={[styles.numericInput, errors.proofRange && styles.inputErrorBorder]}
                    placeholder="1"
                    placeholderTextColor={DD_COLORS.textMuted}
                    keyboardType="numeric"
                    value={form.proofMinValue}
                    onChangeText={(v) => {
                      setForm((f) => ({ ...f, proofMinValue: v.replace(/[^0-9.]/g, '') }));
                      if (errors.proofRange) setErrors((e) => ({ ...e, proofRange: undefined }));
                    }}
                    editable={!isSubmitting}
                  />
                </View>

                <View style={styles.numericFieldCol}>
                  <DDText variant="caption" color="secondary" style={styles.numericFieldLabel}>
                    Max Value
                  </DDText>
                  <TextInput
                    style={[styles.numericInput, errors.proofRange && styles.inputErrorBorder]}
                    placeholder="42"
                    placeholderTextColor={DD_COLORS.textMuted}
                    keyboardType="numeric"
                    value={form.proofMaxValue}
                    onChangeText={(v) => {
                      setForm((f) => ({ ...f, proofMaxValue: v.replace(/[^0-9.]/g, '') }));
                      if (errors.proofRange) setErrors((e) => ({ ...e, proofRange: undefined }));
                    }}
                    editable={!isSubmitting}
                  />
                </View>
              </View>

              {errors.proofUnit ? (
                <DDText variant="caption" color="danger" style={styles.fieldErrorText}>
                  {errors.proofUnit}
                </DDText>
              ) : null}
              {errors.proofRange ? (
                <DDText variant="caption" color="danger" style={styles.fieldErrorText}>
                  {errors.proofRange}
                </DDText>
              ) : null}
            </View>
          )}
        </FormField>

        {/* G. Duration and Deadline */}
        <FormField label="Duration & Deadline">
          <View style={styles.deadlineToggleRow}>
            <Pressable
              onPress={() => setForm((f) => ({ ...f, useCustomDeadline: false }))}
              style={[
                styles.deadlineTab,
                !form.useCustomDeadline && styles.deadlineTabActive,
              ]}>
              <DDText
                variant="caption"
                bold
                color={!form.useCustomDeadline ? 'lime' : 'secondary'}>
                Preset Durations
              </DDText>
            </Pressable>

            <Pressable
              onPress={() => setForm((f) => ({ ...f, useCustomDeadline: true }))}
              style={[
                styles.deadlineTab,
                form.useCustomDeadline && styles.deadlineTabActive,
              ]}>
              <DDText
                variant="caption"
                bold
                color={form.useCustomDeadline ? 'lime' : 'secondary'}>
                Custom Days
              </DDText>
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
                    android_ripple={{ color: 'rgba(191, 253, 64, 0.1)', borderless: false }}
                    style={({ pressed }) => [
                      styles.durationChip,
                      isSelected && styles.durationChipActive,
                      pressed && styles.cardPressed,
                    ]}
                    accessibilityRole="radio"
                    accessibilityLabel={`${d} days`}
                    accessibilityState={{ checked: isSelected }}>
                    <DDText
                      variant="h2"
                      color={isSelected ? 'lime' : 'primary'}
                      style={styles.durationNumber}>
                      {d}
                    </DDText>
                    <DDText variant="caption" color={isSelected ? 'lime' : 'muted'}>
                      days
                    </DDText>
                  </Pressable>
                );
              })}
            </View>
          ) : (
            <View style={styles.customDurationCard}>
              <TextInput
                style={[styles.customInput, errors.customDays && styles.inputErrorBorder]}
                placeholder="45"
                placeholderTextColor={DD_COLORS.textMuted}
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
              <DDText variant="body" color="secondary" style={styles.customDaysUnit}>
                days total
              </DDText>
            </View>
          )}

          {errors.customDays ? (
            <DDText variant="caption" color="danger" style={styles.fieldErrorText}>
              {errors.customDays}
            </DDText>
          ) : null}

          {/* Computed Target End Date Preview */}
          <View style={styles.deadlinePreviewCard}>
            <DDIcon name="calendar" size={16} color={DD_COLORS.lime} weight="bold" />
            <View style={styles.deadlinePreviewMeta}>
              <DDText variant="caption" color="muted">
                Calculated Target Deadline
              </DDText>
              <DDText variant="label" color="primary" bold>
                {previewDeadlineText}
              </DDText>
            </View>
          </View>
        </FormField>

        {/* G. Compact Live Preview Card */}
        {form.title.trim().length > 0 && (
          <View style={styles.previewSection}>
            <DDText variant="caption" color="muted" bold style={styles.previewSectionTitle}>
              CHALLENGE PREVIEW
            </DDText>
            <DDCard variant="card" padding="md" style={styles.livePreviewCard}>
              <View style={styles.previewBadgeRow}>
                {form.category ? (
                  <DDBadge
                    label={form.category}
                    variant={form.category}
                    size="sm"
                    icon={CATEGORY_ICONS[form.category]}
                  />
                ) : (
                  <DDBadge label="No Category" variant="neutral" size="sm" />
                )}

                <DDBadge
                  label={form.challengeType === 'daily' ? 'Daily Dare' : 'One-Time'}
                  variant={form.challengeType === 'daily' ? 'lime' : 'purple'}
                  size="sm"
                  icon={form.challengeType === 'daily' ? 'flame' : 'target'}
                />

                <DDBadge
                  label={PROOF_METHODS.find((p) => p.id === form.proofMethod)?.title || 'Gesture'}
                  variant="neutral"
                  size="sm"
                  icon={PROOF_METHODS.find((p) => p.id === form.proofMethod)?.icon}
                />
              </View>

              <DDText variant="h3" color="primary" numberOfLines={2} style={styles.previewTitle}>
                {form.title}
              </DDText>

              <DDText variant="bodySm" color="secondary" numberOfLines={2}>
                {form.description || 'Description will appear here…'}
              </DDText>

              <View style={styles.previewFooter}>
                <View style={styles.previewMetric}>
                  <DDIcon name="users" size={13} color={DD_COLORS.textMuted} weight="bold" />
                  <DDText variant="caption" color="muted">
                    1 Challenger (You)
                  </DDText>
                </View>
                <View style={styles.previewMetric}>
                  <DDIcon name="calendar" size={13} color={DD_COLORS.textMuted} weight="bold" />
                  <DDText variant="caption" color="muted">
                    {effectiveDurationDays} days duration
                  </DDText>
                </View>
              </View>
            </DDCard>
          </View>
        )}

        {/* H. Launch Publish Action Button */}
        <DDButton
          title={isSubmitting ? 'Creating Challenge…' : 'Launch Challenge'}
          variant="primary"
          iconLeft={isSubmitting ? undefined : 'plus'}
          loading={isSubmitting}
          disabled={isSubmitting}
          onPress={handleSubmit}
          fullWidth
          style={styles.launchButton}
        />
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
    <View style={styles.formFieldContainer}>
      <View style={styles.formFieldLabelRow}>
        <DDText variant="label" color="primary" bold>
          {label}
        </DDText>
        {required && (
          <DDText variant="caption" color="lime" bold>
            *
          </DDText>
        )}
      </View>
      {children}
      {error ? (
        <DDText variant="caption" color="danger" style={styles.fieldErrorText}>
          {error}
        </DDText>
      ) : null}
    </View>
  );
}

function SuccessState({
  onView,
  onNew,
}: {
  challengeId: string;
  onView: () => void;
  onNew: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.successRoot, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.successContent}>
        <View style={styles.successIconCircle}>
          <DDIcon name="trophy" size={48} color={DD_COLORS.lime} weight="fill" />
        </View>
        <DDText variant="display" color="primary" align="center" style={styles.successTitle}>
          Challenge Created!
        </DDText>
        <DDText variant="body" color="secondary" align="center" style={styles.successSubtitle}>
          Your dare is live and ready for challengers to join.
        </DDText>

        <DDCard variant="card" padding="md" style={styles.successCheckCard}>
          {[
            'Challenge published to DareDrop',
            'You are registered as Challenger #1',
            'Shareable invite deep link generated',
          ].map((item, idx) => (
            <View key={idx} style={styles.checkItem}>
              <View style={styles.checkCircle}>
                <DDIcon name="check" size={12} color={DD_COLORS.lime} weight="bold" />
              </View>
              <DDText variant="bodySm" color="primary" style={styles.checkText}>
                {item}
              </DDText>
            </View>
          ))}
        </DDCard>

        <DDButton
          title="View Challenge & Invite →"
          variant="primary"
          iconRight="arrow-right"
          onPress={onView}
          fullWidth
          style={styles.successPrimaryBtn}
        />

        <DDButton
          title="Create Another Challenge"
          variant="secondary"
          onPress={onNew}
          fullWidth
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: DD_COLORS.bg,
  },
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: DD_SPACING.lg,
  },

  /* Header */
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: DD_SPACING.xl,
  },
  headerTexts: {
    flex: 1,
    paddingRight: DD_SPACING.sm,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: DD_SPACING.xs,
  },
  flameIconWrapper: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(191, 253, 64, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagline: {
    fontSize: 11,
    letterSpacing: 2,
  },
  headline: {
    letterSpacing: -1,
    lineHeight: 38,
  },
  subline: {
    marginTop: 2,
  },
  backendBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: 4,
    borderRadius: DD_RADII.pill,
    borderWidth: 1,
    marginTop: 4,
  },
  backendBadgeOnline: {
    backgroundColor: 'rgba(0, 230, 118, 0.1)',
    borderColor: 'rgba(0, 230, 118, 0.3)',
  },
  backendBadgeLocal: {
    backgroundColor: 'rgba(255, 184, 0, 0.1)',
    borderColor: 'rgba(255, 184, 0, 0.3)',
  },
  backendDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },

  /* Error Banner */
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    backgroundColor: 'rgba(255, 59, 86, 0.1)',
    borderRadius: DD_RADII.md,
    borderWidth: 1,
    borderColor: 'rgba(255, 59, 86, 0.3)',
    padding: DD_SPACING.md,
    marginBottom: DD_SPACING.lg,
  },
  errorBannerText: {
    flex: 1,
  },

  /* Form Field Container */
  formFieldContainer: {
    marginBottom: DD_SPACING.xl,
  },
  formFieldLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: DD_SPACING.sm,
  },
  fieldErrorText: {
    marginTop: 4,
  },

  /* Input Cards */
  inputCard: {
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.card,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    padding: DD_SPACING.md,
  },
  inputCardError: {
    borderColor: DD_COLORS.danger,
  },
  textInput: {
    color: DD_COLORS.text,
    fontSize: 15,
    padding: 0,
    minHeight: 28,
  },
  textAreaInput: {
    minHeight: 84,
  },
  charCount: {
    textAlign: 'right',
    marginTop: DD_SPACING.xs,
  },

  /* Type Selector */
  typeSelectorRow: {
    gap: DD_SPACING.sm,
  },
  typeCard: {
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.card,
    borderWidth: 1.5,
    borderColor: DD_COLORS.borderSubtle,
    padding: DD_SPACING.lg,
    gap: DD_SPACING.sm,
  },
  typeCardActive: {
    borderColor: DD_COLORS.lime,
    backgroundColor: 'rgba(191, 253, 64, 0.05)',
  },
  typeCardActiveViolet: {
    borderColor: DD_COLORS.purple,
    backgroundColor: 'rgba(155, 89, 255, 0.05)',
  },
  cardPressed: {
    opacity: 0.88,
    transform: [{ scale: 0.99 }],
  },
  typeHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
  },
  typeIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: DD_COLORS.bgElement,
    alignItems: 'center',
    justifyContent: 'center',
  },
  typeIconCircleActive: {
    backgroundColor: 'rgba(191, 253, 64, 0.15)',
  },
  typeIconCircleActiveViolet: {
    backgroundColor: 'rgba(155, 89, 255, 0.15)',
  },
  typeTitleCol: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  typeTitle: {
    fontSize: 16,
  },
  typeDescription: {
    lineHeight: 18,
  },

  /* Category Grid */
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: DD_SPACING.sm,
  },
  categoryCard: {
    width: '48%',
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.card,
    borderWidth: 1.5,
    borderColor: DD_COLORS.borderSubtle,
    padding: DD_SPACING.md,
    alignItems: 'center',
    gap: DD_SPACING.sm,
    minHeight: 90,
    justifyContent: 'center',
  },
  categoryIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  categoryLabel: {
    fontSize: 13,
  },

  /* Proof Method Selector */
  proofMethodList: {
    gap: DD_SPACING.sm,
  },
  proofMethodCard: {
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.card,
    borderWidth: 1.5,
    borderColor: DD_COLORS.borderSubtle,
    padding: DD_SPACING.md,
  },
  proofMethodCardActive: {
    borderColor: DD_COLORS.lime,
    backgroundColor: 'rgba(191, 253, 64, 0.05)',
  },
  proofMethodHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: DD_SPACING.sm,
  },
  proofMethodIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: DD_COLORS.bgElement,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  proofMethodIconCircleActive: {
    backgroundColor: 'rgba(191, 253, 64, 0.15)',
  },
  proofMethodTitleGroup: {
    flex: 1,
    gap: 3,
  },
  proofMethodTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  proofMethodTitle: {
    fontSize: 15,
  },
  proofMethodDesc: {
    lineHeight: 16,
  },
  numericConfigBox: {
    marginTop: DD_SPACING.sm,
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.card,
    borderWidth: 1,
    borderColor: 'rgba(191, 253, 64, 0.2)',
    padding: DD_SPACING.md,
    gap: DD_SPACING.sm,
  },
  numericConfigHeader: {
    letterSpacing: 1,
  },
  numericInputsRow: {
    flexDirection: 'row',
    gap: DD_SPACING.sm,
  },
  numericFieldCol: {
    flex: 1,
    gap: 4,
  },
  numericFieldLabel: {
    fontSize: 11,
  },
  numericInput: {
    backgroundColor: DD_COLORS.bgElement,
    borderRadius: DD_RADII.md,
    borderWidth: 1,
    borderColor: DD_COLORS.borderSubtle,
    paddingHorizontal: DD_SPACING.sm,
    paddingVertical: DD_SPACING.xs,
    color: DD_COLORS.text,
    fontSize: 14,
    minHeight: 38,
  },

  /* Duration / Deadline */
  deadlineToggleRow: {
    flexDirection: 'row',
    backgroundColor: DD_COLORS.bgElement,
    borderRadius: DD_RADII.pill,
    padding: 3,
    marginBottom: DD_SPACING.md,
  },
  deadlineTab: {
    flex: 1,
    paddingVertical: DD_SPACING.sm,
    alignItems: 'center',
    borderRadius: DD_RADII.pill,
  },
  deadlineTabActive: {
    backgroundColor: DD_COLORS.bgCard,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  durationRow: {
    flexDirection: 'row',
    gap: DD_SPACING.sm,
    marginBottom: DD_SPACING.md,
  },
  durationChip: {
    flex: 1,
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.lg,
    borderWidth: 1.5,
    borderColor: DD_COLORS.borderSubtle,
    paddingVertical: DD_SPACING.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 64,
  },
  durationChipActive: {
    borderColor: DD_COLORS.lime,
    backgroundColor: 'rgba(191, 253, 64, 0.06)',
  },
  durationNumber: {
    lineHeight: 28,
  },
  customDurationCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: DD_COLORS.bgCard,
    borderRadius: DD_RADII.card,
    borderWidth: 1.5,
    borderColor: DD_COLORS.borderSubtle,
    paddingHorizontal: DD_SPACING.lg,
    paddingVertical: DD_SPACING.md,
    marginBottom: DD_SPACING.md,
    gap: DD_SPACING.sm,
  },
  customInput: {
    color: DD_COLORS.text,
    fontSize: 22,
    fontWeight: '900',
    minWidth: 60,
    padding: 0,
  },
  inputErrorBorder: {
    color: DD_COLORS.danger,
  },
  customDaysUnit: {
    fontSize: 15,
  },
  deadlinePreviewCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    backgroundColor: 'rgba(191, 253, 64, 0.06)',
    borderRadius: DD_RADII.md,
    borderWidth: 1,
    borderColor: 'rgba(191, 253, 64, 0.2)',
    padding: DD_SPACING.md,
  },
  deadlinePreviewMeta: {
    flex: 1,
    gap: 2,
  },

  /* Live Preview */
  previewSection: {
    marginBottom: DD_SPACING.xl,
  },
  previewSectionTitle: {
    letterSpacing: 1.5,
    marginBottom: DD_SPACING.xs,
  },
  livePreviewCard: {
    gap: DD_SPACING.xs,
    borderColor: DD_COLORS.borderProminent,
  },
  previewBadgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
    marginBottom: DD_SPACING.xs,
  },
  previewTitle: {
    lineHeight: 22,
  },
  previewFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.lg,
    marginTop: DD_SPACING.sm,
    paddingTop: DD_SPACING.xs,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.04)',
  },
  previewMetric: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },

  /* Launch CTA */
  launchButton: {
    marginTop: DD_SPACING.sm,
    marginBottom: DD_SPACING.xl,
  },

  /* Success Screen */
  successRoot: {
    flex: 1,
    backgroundColor: DD_COLORS.bg,
    justifyContent: 'center',
    paddingHorizontal: DD_SPACING.xl,
  },
  successContent: {
    alignItems: 'center',
    gap: DD_SPACING.md,
  },
  successIconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(191, 253, 64, 0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: DD_SPACING.xs,
  },
  successTitle: {
    lineHeight: 38,
  },
  successSubtitle: {
    maxWidth: 280,
    lineHeight: 20,
    marginBottom: DD_SPACING.sm,
  },
  successCheckCard: {
    width: '100%',
    gap: DD_SPACING.md,
    marginBottom: DD_SPACING.md,
  },
  checkItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: DD_SPACING.sm,
  },
  checkCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(191, 253, 64, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkText: {
    flex: 1,
  },
  successPrimaryBtn: {
    marginBottom: DD_SPACING.xs,
  },
});
