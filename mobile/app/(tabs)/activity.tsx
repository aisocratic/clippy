import { Ionicons } from "@expo/vector-icons"
import React from "react"
import { StyleSheet, View } from "react-native"

import { Page, Pill, ScreenHeader, Txt } from "@/components/ui"
import { useClippy } from "@/store/clippy"
import { sessionFor, type ActivityEvent } from "@/store/model"
import { colors, spacing } from "@/theme"

const toneColor: Record<ActivityEvent["tone"], string> = {
  neutral: colors.blue,
  success: colors.green,
  warning: colors.yellow,
  danger: colors.coral,
}

export default function ActivityScreen() {
  const { state } = useClippy()

  return (
    <Page>
      <ScreenHeader
        eyebrow="Live from your Mac"
        title="Activity"
        detail="A quiet record of what every agent is doing."
      />
      <View>
        {state.activity.map((event, index) => {
          const session = sessionFor(state, event.sessionId)
          return (
            <View key={event.id} style={styles.event}>
              <View style={styles.rail}>
                <View style={[styles.icon, { backgroundColor: toneColor[event.tone] }]}>
                  <Ionicons name={event.icon} size={17} color={colors.ink} />
                </View>
                {index < state.activity.length - 1 ? <View style={styles.line} /> : null}
              </View>
              <View style={styles.copy}>
                <View style={styles.titleRow}>
                  <Txt variant="heading" style={{ flex: 1 }}>{event.title}</Txt>
                  <Txt variant="caption" color={colors.muted}>{event.time}</Txt>
                </View>
                <Txt color={colors.muted}>{event.detail}</Txt>
                {session ? <Pill label={`${session.petName} · ${session.project}`} color={session.accent} /> : null}
              </View>
            </View>
          )
        })}
      </View>
    </Page>
  )
}

const styles = StyleSheet.create({
  event: { flexDirection: "row", gap: spacing.md, minHeight: 112 },
  rail: { width: 42, alignItems: "center" },
  icon: {
    width: 38,
    height: 38,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: colors.ink,
  },
  line: { flex: 1, width: 2, backgroundColor: colors.ink, marginVertical: 3, opacity: 0.25 },
  copy: { flex: 1, gap: spacing.sm, paddingBottom: spacing.xl },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
})
