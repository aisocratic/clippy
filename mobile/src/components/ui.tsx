import { Ionicons } from "@expo/vector-icons"
import * as Haptics from "expo-haptics"
import React, { useEffect } from "react"
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  type TextProps,
  View,
  type ViewProps,
} from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { colors, radius, spacing, type as typeScale } from "@/theme"
import { useClippy } from "@/store/clippy"

type TextVariant = keyof typeof typeScale

export function Txt({
  variant = "body",
  color = colors.ink,
  style,
  ...props
}: TextProps & { variant?: TextVariant; color?: string }) {
  return <Text {...props} style={[typeScale[variant], { color }, style]} />
}

export function Page({ children }: { children: React.ReactNode }) {
  const insets = useSafeAreaInsets()
  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={{
        paddingTop: Math.max(insets.top, spacing.xl),
        paddingBottom: 120,
        paddingHorizontal: spacing.xl,
        gap: spacing.xl,
      }}
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  )
}

export function ScreenHeader({
  eyebrow,
  title,
  detail,
  right,
}: {
  eyebrow?: string
  title: string
  detail?: string
  right?: React.ReactNode
}) {
  return (
    <View style={styles.header}>
      <View style={{ flex: 1, gap: spacing.xs }}>
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <Txt variant="hero">{title}</Txt>
        {detail ? <Txt color={colors.muted}>{detail}</Txt> : null}
      </View>
      {right}
    </View>
  )
}

export function Eyebrow({ children, color = colors.coral }: { children: React.ReactNode; color?: string }) {
  return (
    <Txt
      variant="caption"
      color={color}
      style={{ textTransform: "uppercase", letterSpacing: 1.4 }}
    >
      {children}
    </Txt>
  )
}

export function PaperCard({
  children,
  style,
  accent = colors.card,
}: ViewProps & { accent?: string }) {
  return (
    <View style={[styles.cardShadow, style]}>
      <View style={[styles.card, { backgroundColor: accent }]}>{children}</View>
    </View>
  )
}

export function Pill({
  label,
  color = colors.paperDeep,
  textColor = colors.ink,
  icon,
}: {
  label: string
  color?: string
  textColor?: string
  icon?: keyof typeof Ionicons.glyphMap
}) {
  return (
    <View style={[styles.pill, { backgroundColor: color }]}>
      {icon ? <Ionicons name={icon} color={textColor} size={12} /> : null}
      <Txt variant="caption" color={textColor} numberOfLines={1}>
        {label}
      </Txt>
    </View>
  )
}

export function ActionButton({
  label,
  onPress,
  variant = "plain",
  icon,
  compact = false,
  disabled = false,
}: {
  label: string
  onPress?: () => void
  variant?: "positive" | "danger" | "plain" | "dark"
  icon?: keyof typeof Ionicons.glyphMap
  compact?: boolean
  disabled?: boolean
}) {
  const background =
    variant === "positive"
      ? colors.green
      : variant === "danger"
        ? colors.coralSoft
        : variant === "dark"
          ? colors.ink
          : colors.white
  const foreground = variant === "danger" ? "#A63828" : variant === "dark" ? colors.white : colors.ink

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {})
        onPress?.()
      }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          paddingVertical: compact ? spacing.sm : spacing.md,
          opacity: disabled ? 0.45 : pressed ? 0.74 : 1,
          transform: [{ translateX: pressed ? 1 : 0 }, { translateY: pressed ? 1 : 0 }],
        },
      ]}
    >
      {icon ? <Ionicons name={icon} size={16} color={foreground} /> : null}
      <Txt variant="label" color={foreground} numberOfLines={1}>
        {label}
      </Txt>
    </Pressable>
  )
}

export function SectionHeading({
  title,
  action,
}: {
  title: string
  action?: React.ReactNode
}) {
  return (
    <View style={styles.sectionHeading}>
      <Txt variant="heading">{title}</Txt>
      {action}
    </View>
  )
}

export function EmptyState({
  icon,
  title,
  detail,
}: {
  icon: keyof typeof Ionicons.glyphMap
  title: string
  detail: string
}) {
  return (
    <PaperCard style={{ marginTop: spacing.xxl }}>
      <View style={styles.empty}>
        <View style={styles.emptyIcon}>
          <Ionicons name={icon} size={28} color={colors.ink} />
        </View>
        <Txt variant="heading">{title}</Txt>
        <Txt color={colors.muted} style={{ textAlign: "center" }}>
          {detail}
        </Txt>
      </View>
    </PaperCard>
  )
}

export function Toast() {
  const { state, clearToast } = useClippy()

  useEffect(() => {
    if (!state.toast) return
    const timer = setTimeout(clearToast, 2200)
    return () => clearTimeout(timer)
  }, [state.toast, clearToast])

  if (!state.toast) return null
  return (
    <View pointerEvents="none" style={styles.toast}>
      <Ionicons name="checkmark-circle" color={colors.green} size={18} />
      <Txt variant="label" color={colors.white}>
        {state.toast}
      </Txt>
    </View>
  )
}

export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  header: { flexDirection: "row", alignItems: "flex-start", gap: spacing.lg },
  cardShadow: {
    borderRadius: radius.card,
    backgroundColor: colors.ink,
    paddingBottom: 5,
    paddingRight: 4,
  },
  card: {
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: radius.card,
    padding: spacing.lg,
    gap: spacing.md,
    transform: [{ translateX: -2 }, { translateY: -2 }],
  },
  pill: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: 26,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.ink,
  },
  button: {
    minHeight: 42,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.small,
    borderWidth: 1.5,
    borderColor: colors.ink,
  },
  sectionHeading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: spacing.sm,
  },
  empty: { alignItems: "center", gap: spacing.sm, paddingVertical: spacing.xl },
  emptyIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.green,
    borderWidth: 1.5,
    borderColor: colors.ink,
    marginBottom: spacing.sm,
  },
  toast: {
    position: "absolute",
    alignSelf: "center",
    bottom: 100,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.ink,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
})
