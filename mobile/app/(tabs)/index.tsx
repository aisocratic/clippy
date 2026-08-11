import { Ionicons } from "@expo/vector-icons"
import { useRouter } from "expo-router"
import React from "react"
import { Pressable, StyleSheet, View } from "react-native"

import { Buddy } from "@/components/buddy"
import { PendingCard } from "@/components/pending-card"
import { SessionCard } from "@/components/session-card"
import { Eyebrow, Page, Pill, ScreenHeader, SectionHeading, Txt } from "@/components/ui"
import { useClippy } from "@/store/clippy"
import { sessionFor } from "@/store/model"
import { colors, radius, spacing } from "@/theme"

export default function SessionsScreen() {
  const { state } = useClippy()
  const router = useRouter()
  const featured = state.pending[0]
  const featuredSession = featured ? sessionFor(state, featured.sessionId) : undefined
  const working = state.sessions.filter((session) => session.status === "working").length

  return (
    <Page>
      <ScreenHeader
        eyebrow="Clippy mobile"
        title="Your agents, within reach."
        detail="Keep moving while your coding buddies work."
        right={
          <View style={styles.logo}>
            <Ionicons name="attach" size={29} color={colors.ink} />
          </View>
        }
      />

      <View style={styles.summary}>
        <View style={styles.summaryCopy}>
          <Eyebrow color={colors.greenDeep}>{state.connected ? "Mac connected" : "Offline"}</Eyebrow>
          <Txt variant="title">{state.pending.length ? `${state.pending.length} things need you` : "All caught up"}</Txt>
          <View style={styles.summaryPills}>
            <Pill label={`${working} working`} color={colors.blue} icon="hammer" />
            <Pill label={`${state.sessions.length} sessions`} color={colors.white} icon="layers" />
          </View>
        </View>
        <Buddy accent={colors.green} size={92} mood={state.pending.length ? "waiting" : "happy"} />
      </View>

      {featured && featuredSession ? (
        <View style={{ gap: spacing.md }}>
          <SectionHeading
            title="Needs you now"
            action={
              <Pressable onPress={() => router.push("/(tabs)/inbox")} hitSlop={10}>
                <Txt variant="label" color={colors.coral}>View inbox →</Txt>
              </Pressable>
            }
          />
          <PendingCard item={featured} session={featuredSession} featured />
        </View>
      ) : null}

      <View style={{ gap: spacing.md }}>
        <SectionHeading title="Sessions" />
        {state.sessions.map((session) => <SessionCard key={session.id} session={session} />)}
      </View>
    </Page>
  )
}

const styles = StyleSheet.create({
  logo: {
    width: 48,
    height: 48,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.yellow,
    borderWidth: 2,
    borderColor: colors.ink,
  },
  summary: {
    minHeight: 164,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.ink,
    borderRadius: radius.large,
    paddingLeft: spacing.xl,
    paddingRight: spacing.sm,
    overflow: "hidden",
  },
  summaryCopy: { flex: 1, gap: spacing.md },
  summaryPills: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
})
