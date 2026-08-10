import { Stack } from "expo-router"
import { StatusBar } from "expo-status-bar"
import React from "react"
import { SafeAreaProvider } from "react-native-safe-area-context"

import { Toast } from "@/components/ui"
import { ClippyProvider } from "@/store/clippy"
import { colors } from "@/theme"

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ClippyProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.paper },
            animation: "slide_from_right",
          }}
        >
          <Stack.Screen name="index" />
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="session/[id]" />
        </Stack>
        <Toast />
      </ClippyProvider>
    </SafeAreaProvider>
  )
}
