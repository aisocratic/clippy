import React from "react"
import { Pressable, View } from "react-native"

import { PendingCard } from "@/components/pending-card"
import { EmptyState, Page, ScreenHeader, Txt } from "@/components/ui"
import { useClippy } from "@/store/clippy"
import { sessionFor } from "@/store/model"
import { colors, spacing } from "@/theme"

export default function InboxScreen() {
  const { state, clearAll } = useClippy()

  return (
    <Page>
      <ScreenHeader
        eyebrow="Waiting on you"
        title="Inbox"
        detail={state.pending.length ? "Answer here and your agent carries on immediately." : "Your agents have everything they need."}
        right={state.pending.length ? (
          <Pressable onPress={clearAll} hitSlop={12}>
            <Txt variant="label" color={colors.coral}>Clear</Txt>
          </Pressable>
        ) : null}
      />
      {state.pending.length ? (
        <View style={{ gap: spacing.lg }}>
          {state.pending.map((item) => {
            const session = sessionFor(state, item.sessionId)
            return session ? <PendingCard key={item.id} item={item} session={session} /> : null
          })}
        </View>
      ) : (
        <EmptyState icon="checkmark" title="Nothing waiting" detail="Clippy will nudge you when an agent needs a decision." />
      )}
    </Page>
  )
}
