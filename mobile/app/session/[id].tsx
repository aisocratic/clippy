import { Ionicons } from "@expo/vector-icons"
import { useLocalSearchParams, useRouter } from "expo-router"
import React, { useState } from "react"
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"

import { Buddy } from "@/components/buddy"
import { PendingCard } from "@/components/pending-card"
import { ActionButton, PaperCard, Pill, Txt } from "@/components/ui"
import { useClippy } from "@/store/clippy"
import { pendingFor, sessionFor } from "@/store/model"
import { colors, radius, spacing } from "@/theme"

export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { state, sendPrompt } = useClippy()
  const [prompt, setPrompt] = useState("")
  const session = sessionFor(state, id)

  if (!session) {
    return (
      <View style={[styles.missing, { paddingTop: insets.top }]}>
        <Txt variant="title">Session not found</Txt>
        <ActionButton label="Go back" onPress={() => router.back()} />
      </View>
    )
  }

  const pending = pendingFor(state, session.id)
  const activity = state.activity.filter((event) => event.sessionId === session.id).slice(0, 4)

  const submit = () => {
    sendPrompt(session.id, prompt)
    setPrompt("")
  }

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + spacing.sm, paddingHorizontal: spacing.xl, paddingBottom: 150, gap: spacing.xl }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.nav}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={() => router.back()} style={styles.iconButton}>
            <Ionicons name="arrow-back" size={22} color={colors.ink} />
          </Pressable>
          <Txt variant="label">Session details</Txt>
          <Pressable accessibilityRole="button" accessibilityLabel="More options" style={styles.iconButton}>
            <Ionicons name="ellipsis-horizontal" size={22} color={colors.ink} />
          </Pressable>
        </View>

        <View style={styles.hero}>
          <Buddy accent={session.accent} size={118} mood={session.status === "working" ? "busy" : session.status === "waiting" ? "waiting" : "happy"} />
          <Txt variant="hero" style={{ textAlign: "center" }}>{session.petName}</Txt>
          <Txt color={colors.muted}>{session.project} · {session.agent} · {session.model}</Txt>
          <Pill label={session.statusLabel} color={session.accent} />
        </View>

        <PaperCard>
          <View style={styles.liveTitle}>
            <View style={[styles.liveDot, { backgroundColor: session.status === "working" ? colors.green : session.accent }]} />
            <Txt variant="caption" color={colors.muted}>Live activity</Txt>
          </View>
          <Txt variant="heading">{session.activity}</Txt>
          <View style={styles.detailRow}>
            <Ionicons name="git-branch-outline" size={16} color={colors.muted} />
            <Txt variant="caption" color={colors.muted}>{session.branch}</Txt>
          </View>
        </PaperCard>

        {pending.map((item) => <PendingCard key={item.id} item={item} session={session} featured />)}

        <View style={{ gap: spacing.md }}>
          <Txt variant="heading">Context</Txt>
          <PaperCard>
            <View style={styles.contextHeader}>
              <Txt variant="title">{session.contextUsed}%</Txt>
              <Txt variant="caption" color={colors.muted}>{session.tokens}</Txt>
            </View>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${session.contextUsed}%`, backgroundColor: session.accent }]} />
            </View>
          </PaperCard>
        </View>

        <View style={{ gap: spacing.md }}>
          <Txt variant="heading">Recent activity</Txt>
          <PaperCard>
            {activity.length ? activity.map((event, index) => (
              <View key={event.id} style={[styles.eventRow, index < activity.length - 1 && styles.eventBorder]}>
                <Ionicons name={event.icon} size={18} color={colors.ink} />
                <View style={{ flex: 1 }}>
                  <Txt variant="label">{event.title}</Txt>
                  <Txt variant="caption" color={colors.muted} numberOfLines={1}>{event.detail}</Txt>
                </View>
                <Txt variant="caption" color={colors.muted}>{event.time}</Txt>
              </View>
            )) : <Txt color={colors.muted}>No recent activity.</Txt>}
          </PaperCard>
        </View>
      </ScrollView>

      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, spacing.md) }]}>
        <TextInput
          value={prompt}
          onChangeText={setPrompt}
          onSubmitEditing={submit}
          placeholder={`Message ${session.petName}…`}
          placeholderTextColor={colors.muted}
          style={styles.input}
          returnKeyType="send"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send prompt"
          disabled={!prompt.trim()}
          onPress={submit}
          style={[styles.send, !prompt.trim() && { opacity: 0.35 }]}
        >
          <Ionicons name="arrow-up" color={colors.white} size={21} />
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  missing: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.lg, backgroundColor: colors.paper },
  nav: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  iconButton: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: colors.card, borderWidth: 1.5, borderColor: colors.ink },
  hero: { alignItems: "center", gap: spacing.sm },
  liveTitle: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  liveDot: { width: 9, height: 9, borderRadius: 5, borderWidth: 1, borderColor: colors.ink },
  detailRow: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  contextHeader: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  track: { height: 13, backgroundColor: colors.paperDeep, borderRadius: 7, overflow: "hidden", borderWidth: 1, borderColor: colors.ink },
  fill: { height: "100%" },
  eventRow: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm },
  eventBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#B6B0A7" },
  composer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingTop: spacing.md,
    paddingHorizontal: spacing.xl,
    backgroundColor: colors.card,
    borderTopWidth: 1.5,
    borderTopColor: colors.ink,
  },
  input: { flex: 1, minHeight: 48, borderWidth: 1.5, borderColor: colors.ink, borderRadius: radius.small, paddingHorizontal: spacing.md, color: colors.ink, backgroundColor: colors.white, fontSize: 15 },
  send: { width: 48, height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: colors.ink },
})
