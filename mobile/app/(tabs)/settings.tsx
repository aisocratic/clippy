import { Ionicons } from "@expo/vector-icons"
import React from "react"
import { StyleSheet, Switch, View } from "react-native"

import { ActionButton, Page, PaperCard, Pill, ScreenHeader, Txt } from "@/components/ui"
import { useClippy } from "@/store/clippy"
import { colors, spacing } from "@/theme"

export default function SettingsScreen() {
  const { state, toggle } = useClippy()

  return (
    <Page>
      <ScreenHeader eyebrow="Make it yours" title="Settings" detail="Control what reaches your phone and how Clippy responds." />

      <PaperCard accent={colors.ink}>
        <View style={styles.connectionTop}>
          <View style={styles.macIcon}><Ionicons name="laptop-outline" size={24} color={colors.ink} /></View>
          <View style={{ flex: 1, gap: 3 }}>
            <Txt variant="heading" color={colors.white}>Federico’s MacBook</Txt>
            <Txt variant="caption" color="#B9C3C4">Local companion · just now</Txt>
          </View>
          <Pill label={state.connected ? "Connected" : "Offline"} color={state.connected ? colors.green : colors.coral} />
        </View>
        <ActionButton
          label={state.connected ? "Disconnect" : "Reconnect"}
          variant="plain"
          icon={state.connected ? "unlink-outline" : "link-outline"}
          onPress={() => toggle("connected")}
        />
      </PaperCard>

      <SettingsGroup title="Alerts">
        <SettingRow icon="notifications-outline" title="Push notifications" detail="Alerts when an agent needs you" value={state.notifications} onChange={() => toggle("notifications")} />
        <SettingRow icon="shield-checkmark-outline" title="Permission requests" detail="Allow or deny commands from your phone" value={state.approvals} onChange={() => toggle("approvals")} />
        <SettingRow icon="checkmark-done-outline" title="Finished turns" detail="Review work and send feedback" value={state.reviews} onChange={() => toggle("reviews")} last />
      </SettingsGroup>

      <SettingsGroup title="Developer">
        <SettingRow icon="flask-outline" title="Demo workspace" detail="Keep sample sessions and decisions visible" value={state.demoMode} onChange={() => toggle("demoMode")} last />
      </SettingsGroup>

      <View style={styles.about}>
        <View style={styles.mark}><Ionicons name="attach" size={25} color={colors.ink} /></View>
        <View style={{ flex: 1 }}>
          <Txt variant="label">Clippy mobile</Txt>
          <Txt variant="caption" color={colors.muted}>Version 0.1.0 · by AI Socratic</Txt>
        </View>
      </View>
    </Page>
  )
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: spacing.sm }}>
      <Txt variant="caption" color={colors.muted} style={styles.groupTitle}>{title}</Txt>
      <PaperCard>{children}</PaperCard>
    </View>
  )
}

function SettingRow({ icon, title, detail, value, onChange, last = false }: {
  icon: keyof typeof Ionicons.glyphMap
  title: string
  detail: string
  value: boolean
  onChange: () => void
  last?: boolean
}) {
  return (
    <View style={[styles.settingRow, !last && styles.settingBorder]}>
      <View style={styles.rowIcon}><Ionicons name={icon} size={20} color={colors.ink} /></View>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt variant="label">{title}</Txt>
        <Txt variant="caption" color={colors.muted}>{detail}</Txt>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: colors.paperDeep, true: colors.green }}
        thumbColor={colors.white}
        ios_backgroundColor={colors.paperDeep}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  connectionTop: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  macIcon: { width: 46, height: 46, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: colors.yellow },
  groupTitle: { textTransform: "uppercase", letterSpacing: 1.2, marginLeft: spacing.xs },
  settingRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: 64, paddingVertical: spacing.sm },
  settingBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#B6B0A7" },
  rowIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.paperDeep },
  about: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.sm },
  mark: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: colors.yellow, borderWidth: 1.5, borderColor: colors.ink },
})
