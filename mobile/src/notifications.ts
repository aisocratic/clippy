import * as Device from "expo-device"
import * as Notifications from "expo-notifications"
import { Platform } from "react-native"

import type { PendingItem, Session } from "@/store/model"

/**
 * Telling you an agent is waiting, when the app isn't open.
 *
 * These are *local* notifications: the app schedules them itself, on this
 * device, the moment something starts waiting on you. That is the honest fit
 * for what Clippy Mobile is today — the state it shows comes from a fixture in
 * this bundle, so there is no server to push from and nothing to push about.
 *
 * When a real relay to the Mac exists, this is where it plugs in: the Mac gets
 * the push token from `registerForPush`, and the notification arrives from the
 * outside rather than being scheduled from the inside. The presentation, the
 * permission flow and the categories below do not change.
 */

/** Foreground behaviour: an agent waiting on you is worth interrupting for. */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
})

export type PermissionState = "granted" | "denied" | "undetermined"

/** What iOS currently thinks, without asking the user anything. */
export async function currentPermission(): Promise<PermissionState> {
  const { status } = await Notifications.getPermissionsAsync()
  return status as PermissionState
}

/**
 * Ask for permission, once.
 *
 * iOS only ever shows the system prompt the first time; after that a refusal
 * can only be undone in Settings, so a caller that gets `denied` should say so
 * rather than asking again and appearing to do nothing.
 */
export async function requestPermission(): Promise<PermissionState> {
  const existing = await currentPermission()
  if (existing === "granted") return existing

  const { status } = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  })

  if (Platform.OS === "android") {
    // Android needs somewhere to put them; iOS has no equivalent step.
    await Notifications.setNotificationChannelAsync("attention", {
      name: "Needs you",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 180, 90, 180],
    })
  }
  return status as PermissionState
}

const BODY: Record<PendingItem["kind"], string> = {
  permission: "wants permission",
  question: "has a question",
  review: "finished a turn",
}

/**
 * Tell the user that one agent is waiting.
 *
 * Deliberately one notification per waiting item and no digest: the app itself
 * shows one agent at a time, and a notification that says "3 things need you"
 * would be a promise the screen does not keep.
 */
export async function notifyWaiting(item: PendingItem, session: Session): Promise<string | null> {
  if ((await currentPermission()) !== "granted") return null
  return Notifications.scheduleNotificationAsync({
    content: {
      title: `${session.petName} ${BODY[item.kind]}`,
      body: item.title,
      subtitle: session.project,
      sound: true,
      badge: 1,
      // Carried through to the tap handler, so opening the notification can
      // put the right agent on screen rather than just launching the app.
      data: { pendingId: item.id, sessionId: session.id },
    },
    trigger: null, // now
  })
}

/** The badge should agree with the screen: how many are actually waiting. */
export async function setBadge(count: number): Promise<void> {
  await Notifications.setBadgeCountAsync(Math.max(0, count))
}

/** Nothing is waiting any more — clear anything still sitting in Notification Centre. */
export async function clearDelivered(): Promise<void> {
  await Notifications.dismissAllNotificationsAsync()
  await setBadge(0)
}

/**
 * The push token for this device, for when a Mac can reach out to it.
 *
 * Returns null on a simulator (Apple issues no push tokens there) and in Expo
 * Go on SDK 53+, which dropped remote push — both are expected, and neither
 * stops the local notifications above from working.
 */
export async function registerForPush(): Promise<string | null> {
  if (!Device.isDevice) return null
  if ((await requestPermission()) !== "granted") return null
  try {
    const token = await Notifications.getExpoPushTokenAsync()
    return token.data
  } catch {
    return null // no project id, no entitlement, or Expo Go: not an error here
  }
}
