import React, { useCallback, useEffect, useState } from "react"
import { AppState, Pressable, ScrollView, StyleSheet, View } from "react-native"
import { SafeAreaView } from "react-native-safe-area-context"

import { Buddy } from "@/components/buddy"
import { PendingCard } from "@/components/pending-card"
import { Txt } from "@/components/ui"
import { currentPermission, requestPermission, type PermissionState } from "@/notifications"
import { useClippy } from "@/store/clippy"
import { focusOf } from "@/store/model"
import { colors, spacing } from "@/theme"

/**
 * The whole app: one agent, when one needs you.
 *
 * Everything a companion could also show — the session list, the activity
 * feed, the settings page — is the part that makes you open the app and then
 * read it. A phone app for coding agents wants the opposite: empty almost
 * always, and when it isn't, asking exactly one question and taking the
 * answer. So there is one screen, one agent on it, and no navigation at all.
 */
export default function Focus() {
  const { state, receive } = useClippy()
  const [permission, setPermission] = useState<PermissionState>("undetermined")
  const focus = focusOf(state)
  const waiting = state.pending.length

  const refreshPermission = useCallback(() => {
    void currentPermission().then(setPermission)
  }, [])

  useEffect(() => {
    refreshPermission()
    // Permission can be changed in iOS Settings while this is backgrounded,
    // and the prompt below would otherwise keep offering something already on.
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") refreshPermission()
    })
    return () => sub.remove()
  }, [refreshPermission])

  const enable = useCallback(async () => {
    setPermission(await requestPermission())
  }, [])

  if (!focus) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.quiet}>
          <Buddy accent={colors.green} size={104} mood="happy" />
          <Txt variant="title" style={styles.quietTitle}>
            Nothing needs you.
          </Txt>
          <Txt color={colors.muted} style={styles.quietBody}>
            {permission === "granted"
              ? "Your agents are working. You'll get a nudge the moment one gets stuck."
              : "Turn on notifications and you can put the phone down until one gets stuck."}
          </Txt>

          {permission !== "granted" ? (
            <Pressable
              accessibilityRole="button"
              disabled={permission === "denied"}
              onPress={enable}
              style={[styles.enable, permission === "denied" && styles.enableOff]}
            >
              <Txt variant="label" color={permission === "denied" ? colors.muted : colors.ink}>
                {permission === "denied"
                  ? "Notifications are off in iOS Settings"
                  : "Turn on notifications"}
              </Txt>
            </Pressable>
          ) : null}

          {/* No Mac to hear from in the demo, so a nudge has to be summonable. */}
          {state.demoMode ? (
            <Pressable accessibilityRole="button" onPress={receive} style={styles.demo}>
              <Txt variant="caption" color={colors.muted}>
                Demo · send me one
              </Txt>
            </Pressable>
          ) : null}
        </View>
      </SafeAreaView>
    )
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardDismissMode="on-drag"
      >
        <View style={styles.who}>
          <Buddy accent={focus.session.accent} size={92} mood="waiting" />
          <Txt variant="title" style={styles.name}>
            {focus.session.petName}
          </Txt>
          <Txt variant="caption" color={colors.muted}>
            {focus.session.project} · {focus.session.agent}
          </Txt>
        </View>

        <PendingCard item={focus.item} session={focus.session} featured />

        {waiting > 1 ? (
          <Txt variant="caption" color={colors.muted} style={styles.queue}>
            {waiting - 1} more {waiting - 1 === 1 ? "agent is" : "agents are"} waiting — this one
            first.
          </Txt>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { padding: spacing.xl, paddingBottom: spacing.xxxl, gap: spacing.lg },
  who: { alignItems: "center", gap: spacing.xs, paddingTop: spacing.lg },
  name: { marginTop: spacing.sm },
  queue: { textAlign: "center", marginTop: spacing.xs },

  quiet: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xxl,
    gap: spacing.md,
  },
  quietTitle: { marginTop: spacing.lg, textAlign: "center" },
  quietBody: { textAlign: "center", maxWidth: 300 },
  enable: {
    marginTop: spacing.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: 999,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.yellow,
  },
  enableOff: { backgroundColor: colors.paperDeep, borderColor: colors.line, opacity: 0.7 },
  demo: { marginTop: spacing.xxl, padding: spacing.sm },
})
