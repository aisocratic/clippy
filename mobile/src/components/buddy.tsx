import { Ionicons } from "@expo/vector-icons"
import React from "react"
import { StyleSheet, View } from "react-native"

import { Txt } from "@/components/ui"
import { colors } from "@/theme"

export function Buddy({
  accent,
  size = 72,
  mood = "happy",
}: {
  accent: string
  size?: number
  mood?: "happy" | "busy" | "waiting"
}) {
  const faceSize = Math.round(size * 0.42)
  return (
    <View style={[styles.stage, { width: size, height: size * 1.12 }]}>
      <View style={[styles.glow, { width: size, height: size, borderRadius: size / 2, backgroundColor: accent }]} />
      <Ionicons
        name="attach"
        size={size * 0.9}
        color={colors.ink}
        style={{ transform: [{ rotate: "-13deg" }] }}
      />
      <View
        style={[
          styles.face,
          {
            width: faceSize,
            height: faceSize,
            borderRadius: faceSize / 2,
            top: size * 0.27,
            left: size * 0.29,
            backgroundColor: accent,
          },
        ]}
      >
        <View style={styles.eyes}>
          <View style={styles.eye} />
          <View style={styles.eye} />
        </View>
        <Txt style={{ fontSize: size * 0.16, lineHeight: size * 0.18, fontWeight: "900" }}>
          {mood === "waiting" ? "o" : mood === "busy" ? "·" : "⌣"}
        </Txt>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  stage: { alignItems: "center", justifyContent: "center" },
  glow: { position: "absolute", opacity: 0.9, borderWidth: 1.5, borderColor: colors.ink },
  face: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: colors.ink,
  },
  eyes: { flexDirection: "row", gap: 7, marginTop: 3 },
  eye: { width: 3, height: 5, borderRadius: 2, backgroundColor: colors.ink },
})
