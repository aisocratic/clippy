import { Ionicons } from "@expo/vector-icons"
import { Tabs } from "expo-router"
import React from "react"
import { StyleSheet, View } from "react-native"

import { Txt } from "@/components/ui"
import { useClippy } from "@/store/clippy"
import { colors } from "@/theme"

export default function TabsLayout() {
  const { state } = useClippy()

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: colors.paper },
        tabBarActiveTintColor: colors.ink,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: styles.tabBar,
        tabBarLabelStyle: styles.tabLabel,
        tabBarItemStyle: styles.tabItem,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Sessions",
          tabBarIcon: ({ color, focused }) => <TabIcon name="layers" color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="inbox"
        options={{
          title: "Inbox",
          tabBarBadge: state.pending.length || undefined,
          tabBarBadgeStyle: styles.badge,
          tabBarIcon: ({ color, focused }) => <TabIcon name="mail" color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: "Activity",
          tabBarIcon: ({ color, focused }) => <TabIcon name="pulse" color={color} focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, focused }) => <TabIcon name="settings" color={color} focused={focused} />,
        }}
      />
    </Tabs>
  )
}

function TabIcon({ name, color, focused }: { name: keyof typeof Ionicons.glyphMap; color: string; focused: boolean }) {
  return (
    <View style={[styles.tabIcon, focused && styles.tabIconActive]}>
      <Ionicons name={name} size={20} color={color} />
    </View>
  )
}

const styles = StyleSheet.create({
  tabBar: {
    position: "absolute",
    height: 82,
    marginHorizontal: 14,
    marginBottom: 10,
    paddingTop: 7,
    paddingBottom: 8,
    borderTopWidth: 0,
    borderWidth: 2,
    borderColor: colors.ink,
    borderRadius: 22,
    backgroundColor: colors.card,
    shadowColor: colors.ink,
    shadowOffset: { width: 3, height: 4 },
    shadowOpacity: 1,
    shadowRadius: 0,
    elevation: 8,
  },
  tabItem: { borderRadius: 14 },
  tabLabel: { fontSize: 11, fontWeight: "800", marginTop: 1 },
  tabIcon: { width: 34, height: 30, alignItems: "center", justifyContent: "center", borderRadius: 10 },
  tabIconActive: { backgroundColor: colors.yellow },
  badge: { backgroundColor: colors.coral, color: colors.white, fontWeight: "900", fontSize: 10 },
})
