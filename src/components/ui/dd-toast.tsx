import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DD_COLORS, DD_RADII, DD_SPACING } from '@/constants/dd-theme';
import { DDIcon, type DDIconName } from '@/components/ui/dd-icon';
import { DDText } from '@/components/ui/dd-text';

export type ToastVariant = 'success' | 'info' | 'warning' | 'error';

export interface ToastOptions {
  message: string;
  type?: ToastVariant;
  duration?: number;
  actionLabel?: string;
  onAction?: () => void;
}

export interface ToastContextValue {
  showToast: (options: ToastOptions | string, type?: ToastVariant) => void;
  hideToast: () => void;
  success: (message: string, duration?: number) => void;
  info: (message: string, duration?: number) => void;
  warning: (message: string, duration?: number) => void;
  error: (message: string, duration?: number) => void;
  toast: {
    success: (message: string, duration?: number) => void;
    info: (message: string, duration?: number) => void;
    warning: (message: string, duration?: number) => void;
    error: (message: string, duration?: number) => void;
  };
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * Strips raw technical database strings, JWT claims, and syntax errors,
 * converting them into helpful, human-friendly user guidance.
 */
export function sanitizeUserErrorMessage(
  error: any,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (!error) return fallback;
  const msg = typeof error === 'string' ? error : error?.message || '';
  if (!msg) return fallback;

  // Log raw diagnostic details in development for developers
  if (__DEV__) {
    console.warn('[DareDrop Diagnostic Error]:', error);
  }

  const lower = msg.toLowerCase();
  if (lower.includes('jwt') || lower.includes('token') || lower.includes('claim')) {
    return 'Your session has expired. Please sign in again.';
  }
  if (
    lower.includes('violates foreign key') ||
    lower.includes('violates unique') ||
    lower.includes('pgrst') ||
    lower.includes('relation') ||
    lower.includes('syntax error') ||
    lower.includes('null value in column')
  ) {
    return 'Unable to process this request. Please refresh and try again.';
  }
  if (
    lower.includes('network request failed') ||
    lower.includes('connection refused') ||
    lower.includes('timeout')
  ) {
    return 'Network connection issue. Please check your internet connection.';
  }
  if (lower.includes('auth') && lower.includes('required')) {
    return 'Please sign in or create an account to continue.';
  }
  if (lower.includes('already a participant') || lower.includes('already joined')) {
    return 'You are already participating in this dare!';
  }

  // Cap message length and avoid raw json
  if (msg.startsWith('{') || msg.length > 120) {
    return fallback;
  }
  return msg;
}

interface ActiveToastItem {
  id: string;
  message: string;
  type: ToastVariant;
  duration: number;
  actionLabel?: string;
  onAction?: () => void;
}

const VARIANT_CONFIG: Record<
  ToastVariant,
  {
    icon: DDIconName;
    iconColor: string;
    borderColor: string;
    glowColor: string;
  }
> = {
  success: {
    icon: 'check-circle',
    iconColor: DD_COLORS.lime,
    borderColor: 'rgba(191, 253, 64, 0.4)',
    glowColor: 'rgba(191, 253, 64, 0.15)',
  },
  info: {
    icon: 'info',
    iconColor: DD_COLORS.purple,
    borderColor: 'rgba(155, 89, 255, 0.4)',
    glowColor: 'rgba(155, 89, 255, 0.15)',
  },
  warning: {
    icon: 'warning',
    iconColor: DD_COLORS.warning,
    borderColor: 'rgba(255, 184, 0, 0.4)',
    glowColor: 'rgba(255, 184, 0, 0.15)',
  },
  error: {
    icon: 'warning-circle',
    iconColor: DD_COLORS.danger,
    borderColor: 'rgba(255, 59, 86, 0.4)',
    glowColor: 'rgba(255, 59, 86, 0.15)',
  },
};

/**
 * Animated Top Toast Notification Component.
 * Drops down smoothly from top, respects safe-area insets, and does not block clicks underneath.
 */
function DDToastBanner({
  item,
  onDismiss,
}: {
  item: ActiveToastItem;
  onDismiss: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [anim] = useState(() => new Animated.Value(0));

  const handleExit = useCallback(() => {
    Animated.timing(anim, {
      toValue: 0,
      duration: 220,
      useNativeDriver: true,
    }).start(() => {
      onDismiss();
    });
  }, [anim, onDismiss]);

  useEffect(() => {
    // Drop-down entrance
    Animated.spring(anim, {
      toValue: 1,
      damping: 15,
      stiffness: 160,
      mass: 0.8,
      useNativeDriver: true,
    }).start();

    // Auto dismiss timer
    const timer = setTimeout(() => {
      handleExit();
    }, item.duration);

    return () => clearTimeout(timer);
  }, [anim, handleExit, item.duration]);

  const translateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [-60, 0],
  });

  const opacity = anim.interpolate({
    inputRange: [0, 0.4, 1],
    outputRange: [0, 0.8, 1],
  });

  const config = VARIANT_CONFIG[item.type] || VARIANT_CONFIG.info;
  const topInset = Math.max(insets.top + (Platform.OS === 'android' ? 10 : 8), 16);

  return (
    <View style={[styles.outerContainer, { top: topInset }]} pointerEvents="box-none">
      <Animated.View
        style={[
          styles.toastCard,
          {
            borderColor: config.borderColor,
            transform: [{ translateY }],
            opacity,
          },
        ]}>
        <Pressable
          onPress={handleExit}
          style={styles.innerPressable}
          accessibilityRole="alert"
          accessibilityLabel={`${item.type} notification: ${item.message}`}>
          <View style={styles.iconWrapper}>
            <DDIcon name={config.icon} size={18} color={config.iconColor} weight="fill" />
          </View>

          <DDText variant="bodySm" color="primary" numberOfLines={3} style={styles.messageText}>
            {item.message}
          </DDText>

          {item.actionLabel && item.onAction && (
            <Pressable
              onPress={() => {
                item.onAction?.();
                handleExit();
              }}
              style={styles.actionBtn}>
              <DDText variant="caption" color="lime" bold>
                {item.actionLabel}
              </DDText>
            </Pressable>
          )}

          <Pressable onPress={handleExit} hitSlop={10} style={styles.dismissBtn}>
            <DDIcon name="x" size={14} color={DD_COLORS.textMuted} weight="bold" />
          </Pressable>
        </Pressable>
      </Animated.View>
    </View>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [activeToast, setActiveToast] = useState<ActiveToastItem | null>(null);
  const lastToastRef = useRef<{ message: string; timestamp: number } | null>(null);

  const hideToast = useCallback(() => {
    setActiveToast(null);
  }, []);

  const showToast = useCallback(
    (options: ToastOptions | string, explicitType?: ToastVariant) => {
      const message = typeof options === 'string' ? options.trim() : options.message.trim();
      if (!message) return;

      const type: ToastVariant =
        explicitType || (typeof options === 'object' && options.type) || 'info';
      const duration =
        (typeof options === 'object' && options.duration) || (type === 'error' ? 4000 : 3000);
      const actionLabel = typeof options === 'object' ? options.actionLabel : undefined;
      const onAction = typeof options === 'object' ? options.onAction : undefined;

      // Prevent duplicate rapid spam (within 2200ms)
      const now = Date.now();
      if (
        lastToastRef.current &&
        lastToastRef.current.message === message &&
        now - lastToastRef.current.timestamp < 2200
      ) {
        return;
      }
      lastToastRef.current = { message, timestamp: now };

      setActiveToast({
        id: 'toast_' + Math.random().toString(36).substring(2, 9),
        message,
        type,
        duration,
        actionLabel,
        onAction,
      });
    },
    [],
  );

  const toast = useMemo(
    () => ({
      success: (msg: string, duration?: number) =>
        showToast({ message: msg, type: 'success', duration }),
      info: (msg: string, duration?: number) =>
        showToast({ message: msg, type: 'info', duration }),
      warning: (msg: string, duration?: number) =>
        showToast({ message: msg, type: 'warning', duration }),
      error: (msg: string, duration?: number) =>
        showToast({ message: msg, type: 'error', duration }),
    }),
    [showToast],
  );

  return (
    <ToastContext.Provider
      value={{
        showToast,
        hideToast,
        success: toast.success,
        info: toast.info,
        warning: toast.warning,
        error: toast.error,
        toast,
      }}>
      {children}
      {activeToast && <DDToastBanner key={activeToast.id} item={activeToast} onDismiss={hideToast} />}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

const styles = StyleSheet.create({
  outerContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    zIndex: 99999,
    alignItems: 'center',
    paddingHorizontal: DD_SPACING.lg,
  },
  toastCard: {
    width: '100%',
    maxWidth: 440,
    backgroundColor: 'rgba(18, 18, 28, 0.96)',
    borderRadius: DD_RADII.pill,
    borderWidth: 1.5,
    ...Platform.select({
      android: {
        elevation: 10,
      },
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.45,
        shadowRadius: 14,
      },
      default: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.45,
        shadowRadius: 14,
      },
    }),
  },
  innerPressable: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: DD_SPACING.md + 2,
    gap: 10,
  },
  iconWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  messageText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '600',
  },
  actionBtn: {
    backgroundColor: 'rgba(191, 253, 64, 0.15)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: DD_RADII.pill,
  },
  dismissBtn: {
    padding: 2,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.7,
  },
});
