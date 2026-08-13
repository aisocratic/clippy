import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from "react"

import { clearDelivered, notifyWaiting, setBadge } from "@/notifications"
import {
  initialState,
  receiveNext,
  resolvePending,
  sessionFor,
  type ClippyState,
} from "@/store/model"

type ToggleKey = "connected" | "demoMode" | "notifications" | "approvals" | "reviews"

type Action =
  | { type: "resolve"; id: string; resolution: string }
  | { type: "prompt"; sessionId: string; text: string }
  | { type: "toggle"; key: ToggleKey }
  | { type: "toast"; value: string | null }
  | { type: "incoming"; at: number }
  | { type: "clearAll" }

function reducer(state: ClippyState, action: Action): ClippyState {
  switch (action.type) {
    case "resolve":
      return resolvePending(state, action.id, action.resolution)
    case "prompt": {
      const text = action.text.trim()
      if (!text) return state
      const session = sessionFor(state, action.sessionId)
      return {
        ...state,
        sessions: state.sessions.map((candidate) =>
          candidate.id === action.sessionId
            ? { ...candidate, status: "working", statusLabel: "Working", activity: text }
            : candidate,
        ),
        activity: [
          {
            id: `prompt-${Date.now()}`,
            sessionId: action.sessionId,
            title: "Prompt sent",
            detail: text,
            time: "now",
            icon: "chatbubble",
            tone: "neutral",
          },
          ...state.activity,
        ],
        toast: session ? `Sent to ${session.petName}` : "Prompt sent",
      }
    }
    case "toggle":
      return { ...state, [action.key]: !state[action.key] }
    case "toast":
      return { ...state, toast: action.value }
    case "incoming":
      return receiveNext(state, action.at)
    case "clearAll":
      return { ...state, pending: [], toast: "All caught up" }
  }
}

type StoreValue = {
  state: ClippyState
  resolve: (id: string, resolution: string) => void
  sendPrompt: (sessionId: string, text: string) => void
  toggle: (key: ToggleKey) => void
  clearToast: () => void
  clearAll: () => void
  receive: () => void
}

const StoreContext = createContext<StoreValue | null>(null)

export function ClippyProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)

  /**
   * Notify on arrival, not on every render.
   *
   * The ids already announced live in a ref rather than in state: this has to
   * survive a re-render without causing one, and something announced once must
   * never be announced again — including after the queue shifts underneath it
   * when an earlier item is resolved.
   */
  const announced = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!state.notifications) return
    for (const item of state.pending) {
      if (announced.current.has(item.id)) continue
      announced.current.add(item.id)
      // What the app opens with is history, not news. Announcing the fixtures
      // would mean a notification storm every launch.
      if (!item.id.startsWith("incoming-")) continue
      const session = sessionFor(state, item.sessionId)
      if (session) void notifyWaiting(item, session)
    }
  }, [state, state.pending, state.notifications])

  // The badge says exactly what the screen would: how many are still waiting.
  useEffect(() => {
    if (state.pending.length === 0) void clearDelivered()
    else void setBadge(state.pending.length)
  }, [state.pending.length])

  const value = useMemo<StoreValue>(
    () => ({
      state,
      resolve: (id, resolution) => dispatch({ type: "resolve", id, resolution }),
      sendPrompt: (sessionId, text) => dispatch({ type: "prompt", sessionId, text }),
      toggle: (key) => dispatch({ type: "toggle", key }),
      clearToast: () => dispatch({ type: "toast", value: null }),
      clearAll: () => dispatch({ type: "clearAll" }),
      receive: () => dispatch({ type: "incoming", at: Date.now() }),
    }),
    [state],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useClippy(): StoreValue {
  const value = useContext(StoreContext)
  if (!value) throw new Error("useClippy must be used inside ClippyProvider")
  return value
}
