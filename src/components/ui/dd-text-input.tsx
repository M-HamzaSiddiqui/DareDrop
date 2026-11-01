import React, { useState } from 'react';
import {
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { DD, DD_COLORS, DD_RADII, DD_SPACING } from '@/constants/dd-theme';
import { DDIcon, type DDIconName } from './dd-icon';
import { DDText } from './dd-text';

export interface DDTextInputProps extends TextInputProps {
  label?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  iconLeft?: DDIconName;
  iconRight?: DDIconName;
  onRightIconPress?: () => void;
  showCharCount?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  inputStyle?: StyleProp<TextStyle>;
}

/**
 * Standardized High-Contrast Text Input for DareDrop.
 * Features focus ring highlights, integrated error handling, and 48dp minimum touch target.
 */
export function DDTextInput({
  label,
  error,
  hint,
  required,
  iconLeft,
  iconRight,
  onRightIconPress,
  showCharCount,
  maxLength,
  value,
  containerStyle,
  inputStyle,
  onFocus,
  onBlur,
  editable = true,
  accessibilityLabel,
  ...rest
}: DDTextInputProps) {
  const [isFocused, setIsFocused] = useState(false);

  const hasError = Boolean(error);
  const currentLength = typeof value === 'string' ? value.length : 0;

  return (
    <View style={[styles.container, containerStyle]}>
      {/* Label and Character Count Row */}
      {(label || showCharCount) && (
        <View style={styles.headerRow}>
          {label ? (
            <View style={styles.labelRow}>
              <DDText variant="label" color={hasError ? 'danger' : 'secondary'}>
                {label}
              </DDText>
              {required && <DDText variant="label" color="coral">*</DDText>}
            </View>
          ) : <View />}

          {showCharCount && maxLength ? (
            <DDText variant="caption" color="muted">
              {currentLength}/{maxLength}
            </DDText>
          ) : null}
        </View>
      )}

      {/* Input Field Surface */}
      <View
        style={[
          styles.inputSurface,
          isFocused && styles.inputFocused,
          hasError && styles.inputError,
          !editable && styles.inputDisabled,
        ]}>
        {iconLeft && (
          <DDIcon
            name={iconLeft}
            size="sm"
            color={hasError ? DD_COLORS.danger : isFocused ? DD_COLORS.lime : DD_COLORS.textMuted}
            style={styles.iconLeft}
          />
        )}

        <TextInput
          style={[styles.input, inputStyle]}
          placeholderTextColor={DD_COLORS.textMuted}
          value={value}
          maxLength={maxLength}
          editable={editable}
          onFocus={(e) => {
            setIsFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setIsFocused(false);
            onBlur?.(e);
          }}
          accessibilityLabel={accessibilityLabel ?? label}
          {...rest}
        />

        {iconRight && (
          <DDIcon
            name={iconRight}
            size="sm"
            color={hasError ? DD_COLORS.danger : isFocused ? DD_COLORS.lime : DD_COLORS.textMuted}
            style={styles.iconRight}
          />
        )}
      </View>

      {/* Error or Hint Message */}
      {hasError ? (
        <View style={styles.messageRow}>
          <DDIcon name="warning-circle" size="xs" color={DD_COLORS.danger} />
          <DDText variant="caption" color="danger" style={styles.messageText}>
            {error}
          </DDText>
        </View>
      ) : hint ? (
        <DDText variant="caption" color="muted" style={styles.hintText}>
          {hint}
        </DDText>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    marginBottom: DD_SPACING.md,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: DD_SPACING.xs,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  inputSurface: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: DD_COLORS.bgCard,
    borderWidth: 1.5,
    borderColor: DD_COLORS.borderSubtle,
    borderRadius: DD_RADII.lg,
    paddingHorizontal: DD_SPACING.md,
    minHeight: DD.touchTarget.min, // 48dp minimum touch target
  },
  inputFocused: {
    borderColor: DD_COLORS.lime,
    backgroundColor: DD_COLORS.bgElement,
  },
  inputError: {
    borderColor: DD_COLORS.danger,
  },
  inputDisabled: {
    opacity: 0.5,
  },
  input: {
    flex: 1,
    color: DD_COLORS.text,
    fontSize: 15,
    paddingVertical: DD_SPACING.sm,
    fontFamily: DD.fontDisplay,
  },
  iconLeft: {
    marginRight: DD_SPACING.sm,
  },
  iconRight: {
    marginLeft: DD_SPACING.sm,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: DD_SPACING.xs,
    gap: DD_SPACING.xs,
  },
  messageText: {
    flex: 1,
  },
  hintText: {
    marginTop: DD_SPACING.xs,
  },
});
