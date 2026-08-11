import React, { useState } from "react"
import { Pressable, StyleSheet, TextInput, View } from "react-native"

import { ActionButton, Eyebrow, PaperCard, Txt } from "@/components/ui"
import { useClippy } from "@/store/clippy"
import type { PendingItem, Session } from "@/store/model"
import { colors, radius, spacing } from "@/theme"

export function PendingCard({ item, session, featured = false }: { item: PendingItem; session: Session; featured?: boolean }) {
  const { resolve } = useClippy()
  const [selected, setSelected] = useState<string | null>(null)
  const [feedback, setFeedback] = useState("")
  const background = featured ? colors.yellowSoft : colors.card

  return (
    <PaperCard accent={background}>
      <View style={styles.meta}>
        <Eyebrow color={item.kind === "permission" ? colors.coral : colors.blueDeep}>{item.eyebrow}</Eyebrow>
        <Txt variant="caption" color={colors.muted}>{item.createdAt}</Txt>
      </View>
      <Txt variant={featured ? "title" : "heading"}>{item.title}</Txt>
      <Txt color={colors.muted}>{item.detail}</Txt>
      {item.command ? (
        <View style={styles.code}>
          <Txt style={styles.mono} selectable>{item.command}</Txt>
        </View>
      ) : null}
      {item.options ? (
        <View style={styles.options}>
          {item.options.map((option) => {
            const active = option === selected
            return (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                onPress={() => setSelected(option)}
                style={[styles.option, active && styles.optionActive]}
              >
                <View style={[styles.radio, active && styles.radioActive]} />
                <Txt variant="label">{option}</Txt>
              </Pressable>
            )
          })}
        </View>
      ) : null}
      {item.kind === "review" ? (
        <TextInput
          value={feedback}
          onChangeText={setFeedback}
          placeholder={`Send feedback to ${session.petName}…`}
          placeholderTextColor={colors.muted}
          multiline
          style={styles.input}
        />
      ) : null}
      <View style={styles.actions}>
        {item.kind === "permission" ? (
          <>
            <View style={{ flex: 1 }}><ActionButton label="Deny" variant="danger" onPress={() => resolve(item.id, "Denied")} /></View>
            <View style={{ flex: 1.35 }}><ActionButton label="Allow" variant="positive" icon="checkmark" onPress={() => resolve(item.id, "Allowed")} /></View>
          </>
        ) : item.kind === "question" ? (
          <View style={{ flex: 1 }}>
            <ActionButton
              label="Send answer"
              variant="positive"
              icon="send"
              disabled={!selected}
              onPress={() => selected && resolve(item.id, selected)}
            />
          </View>
        ) : (
          <>
            {feedback.trim() ? (
              <View style={{ flex: 1 }}><ActionButton label="Send feedback" variant="plain" onPress={() => resolve(item.id, "Feedback sent")} /></View>
            ) : null}
            <View style={{ flex: 1 }}><ActionButton label="Looks good" variant="positive" icon="checkmark" onPress={() => resolve(item.id, "Review approved")} /></View>
          </>
        )}
      </View>
    </PaperCard>
  )
}

const styles = StyleSheet.create({
  meta: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  code: { backgroundColor: colors.ink, borderRadius: radius.small, padding: spacing.md },
  mono: { color: colors.white, fontFamily: "Courier", fontSize: 13, lineHeight: 18 },
  options: { gap: spacing.sm },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.small,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.white,
  },
  optionActive: { backgroundColor: colors.blue },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: colors.ink },
  radioActive: { borderWidth: 5, backgroundColor: colors.white },
  input: {
    minHeight: 82,
    borderWidth: 1.5,
    borderColor: colors.ink,
    borderRadius: radius.small,
    padding: spacing.md,
    backgroundColor: colors.white,
    color: colors.ink,
    fontSize: 15,
    textAlignVertical: "top",
  },
  actions: { flexDirection: "row", gap: spacing.sm },
})
