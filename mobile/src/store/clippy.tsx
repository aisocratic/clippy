import React, { createContext, useContext, useMemo, useReducer } from "react"

import {
  initialState,
  resolvePending,
  type ClippyState,
} from "@/store/model"

type ToggleKey = "connected" | "demoMode" | "notifications" | "approvals" | "reviews"

type Action =
  | { type: "resolve"; id: string; resolution: string }
  | { type: "prompt"; sessionId: string; text: string }
  | { type: "toggle"; key: ToggleKey }
  | { type: "toast"; value: string | null }
  | { type: "clearAll" }

function reducer(state: ClippyState, action: Action): ClippyState {
  switch (action.type) {
    case "resolve":
      return resolvePending(state, action.id, action.resolution)
    case "prompt": {
      const text = action.text.trim()
      if (!text) return state
      const session = state.sessions.find((candidate) => candidate.id === action.sessionId)
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
    case "clearAll":
      return { ...state, pending: [], toast: "Inbox cleared" }
  }
}

type StoreValue = {
  state: ClippyState
  resolve: (id: string, resolution: string) => void
  sendPrompt: (sessionId: string, text: string) => void
  toggle: (key: ToggleKey) => void
  clearToast: () => void
  clearAll: () => void
}

const StoreContext = createContext<StoreValue | null>(null)

export function ClippyProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const value = useMemo<StoreValue>(
    () => ({
      state,
      resolve: (id, resolution) => dispatch({ type: "resolve", id, resolution }),
      sendPrompt: (sessionId, text) => dispatch({ type: "prompt", sessionId, text }),
      toggle: (key) => dispatch({ type: "toggle", key }),
      clearToast: () => dispatch({ type: "toast", value: null }),
      clearAll: () => dispatch({ type: "clearAll" }),
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
