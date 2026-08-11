import { Ionicons } from "@expo/vector-icons"
import { useRouter } from "expo-router"
import React from "react"
import { Pressable, StyleSheet, View } from "react-native"

import { Buddy } from "@/components/buddy"
import { PaperCard, Pill, Txt } from "@/components/ui"
import type { Session } from "@/store/model"
import { colors, radius, spacing } from "@/theme"

const statusColor: Record<Session["status"], string> = {
  working: colors.blue,
  waiting: colors.yellow,
  done: colors.green,
  error: colors.coral,
}

export function SessionCard({ session }: { session: Session }) {
  const router = useRouter()
  const mood = session.status === "waiting" ? "waiting" : session.status === "working" ? "busy" : "happy"

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${session.petName} in ${session.project}`}
      onPress={() => router.push(`/session/${session.id}`)}
      style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}
    >
      <PaperCard>
        <View style={styles.top}>
          <Buddy accent={session.accent} size={58} mood={mood} />
          <View style={{ flex: 1, gap: spacing.xs }}>
            <View style={styles.titleRow}>
              <Txt variant="heading" numberOfLines={1} style={{ flex: 1 }}>
                {session.petName}
              </Txt>
              <Txt variant="caption" color={colors.muted}>{session.lastSeen}</Txt>
            </View>
            <Txt color={colors.muted} numberOfLines={1}>
              {session.project} · {session.agent} · {session.model}
            </Txt>
            <Pill label={session.statusLabel} color={statusColor[session.status]} />
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.muted} />
        </View>
        <View style={styles.activity}>
          <Ionicons
            name={session.status === "working" ? "terminal-outline" : "sparkles-outline"}
            size={16}
            color={colors.ink}
          />
          <Txt variant="label" numberOfLines={2} style={{ flex: 1 }}>
            {session.activity}
          </Txt>
        </View>
        <View style={styles.contextRow}>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${session.contextUsed}%`, backgroundColor: session.accent }]} />
          </View>
          <Txt variant="caption" color={colors.muted}>{session.contextUsed}% context</Txt>
        </View>
      </PaperCard>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  top: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  activity: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.paperDeep,
    borderRadius: radius.small,
    padding: spacing.md,
  },
  contextRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  track: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.paperDeep, overflow: "hidden" },
  fill: { height: "100%", borderRadius: 4 },
})
