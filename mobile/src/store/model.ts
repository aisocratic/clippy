export type AgentKind = "Claude" | "Codex" | "OpenClaw"
export type SessionStatus = "working" | "waiting" | "done" | "error"
export type PendingKind = "permission" | "question" | "review"

export type PendingItem = {
  id: string
  sessionId: string
  kind: PendingKind
  eyebrow: string
  title: string
  detail: string
  command?: string
  options?: string[]
  createdAt: string
}

export type Session = {
  id: string
  petName: string
  project: string
  agent: AgentKind
  model: string
  status: SessionStatus
  statusLabel: string
  activity: string
  accent: string
  contextUsed: number
  tokens: string
  branch: string
  lastSeen: string
}

export type ActivityEvent = {
  id: string
  sessionId: string
  title: string
  detail: string
  time: string
  icon: "terminal" | "create" | "checkmark" | "alert" | "chatbubble"
  tone: "neutral" | "success" | "warning" | "danger"
}

export type ClippyState = {
  connected: boolean
  demoMode: boolean
  notifications: boolean
  approvals: boolean
  reviews: boolean
  sessions: Session[]
  pending: PendingItem[]
  activity: ActivityEvent[]
  toast: string | null
}

export const initialState: ClippyState = {
  connected: true,
  demoMode: true,
  notifications: true,
  approvals: true,
  reviews: true,
  sessions: [
    {
      id: "biscuit",
      petName: "Biscuit",
      project: "my-app",
      agent: "Claude",
      model: "Opus 4.1",
      status: "waiting",
      statusLabel: "Needs approval",
      activity: "Wants to clean the build folder",
      accent: "#F2C94C",
      contextUsed: 34,
      tokens: "340k used · 660k left",
      branch: "feat/onboarding",
      lastSeen: "now",
    },
    {
      id: "nori",
      petName: "Nori",
      project: "clippy",
      agent: "Codex",
      model: "GPT-5.6",
      status: "working",
      statusLabel: "Working",
      activity: "Running mobile typecheck",
      accent: "#96CDEC",
      contextUsed: 61,
      tokens: "128k used · 82k left",
      branch: "feat/mobile",
      lastSeen: "12s",
    },
    {
      id: "orbit",
      petName: "Orbit",
      project: "api",
      agent: "Claude",
      model: "Sonnet 4",
      status: "done",
      statusLabel: "Ready for review",
      activity: "Finished adding rate limits",
      accent: "#C6B6ED",
      contextUsed: 18,
      tokens: "92k used · 420k left",
      branch: "fix/rate-limit",
      lastSeen: "4m",
    },
  ],
  pending: [
    {
      id: "permission-build",
      sessionId: "biscuit",
      kind: "permission",
      eyebrow: "Permission request",
      title: "Biscuit wants to remove old build files",
      detail: "Claude needs this before rebuilding the iOS app.",
      command: "rm -rf /tmp/my-app-build",
      createdAt: "now",
    },
    {
      id: "review-api",
      sessionId: "orbit",
      kind: "review",
      eyebrow: "Finished your turn",
      title: "Orbit added API rate limiting",
      detail: "Implemented per-user limits, added retry headers, and covered the new behavior with tests.",
      createdAt: "4m",
    },
    {
      id: "question-copy",
      sessionId: "nori",
      kind: "question",
      eyebrow: "Question",
      title: "Which tone should the empty state use?",
      detail: "This affects the copy shown when no coding sessions are running.",
      options: ["Playful", "Direct", "Reassuring"],
      createdAt: "7m",
    },
  ],
  activity: [
    {
      id: "a1",
      sessionId: "biscuit",
      title: "Permission requested",
      detail: "rm -rf /tmp/my-app-build",
      time: "now",
      icon: "alert",
      tone: "warning",
    },
    {
      id: "a2",
      sessionId: "nori",
      title: "Running command",
      detail: "npm run typecheck",
      time: "12s",
      icon: "terminal",
      tone: "neutral",
    },
    {
      id: "a3",
      sessionId: "nori",
      title: "Edited file",
      detail: "app/index.tsx",
      time: "1m",
      icon: "create",
      tone: "neutral",
    },
    {
      id: "a4",
      sessionId: "orbit",
      title: "Turn finished",
      detail: "All 24 tests passed",
      time: "4m",
      icon: "checkmark",
      tone: "success",
    },
  ],
  toast: null,
}

export function waitingCount(state: ClippyState): number {
  return state.pending.length
}

export function sessionFor(state: ClippyState, id: string): Session | undefined {
  return state.sessions.find((session) => session.id === id)
}

export function pendingFor(state: ClippyState, sessionId: string): PendingItem[] {
  return state.pending.filter((item) => item.sessionId === sessionId)
}

export function resolvePending(
  state: ClippyState,
  id: string,
  resolution: string,
): ClippyState {
  const item = state.pending.find((candidate) => candidate.id === id)
  if (!item) return state

  const session = sessionFor(state, item.sessionId)
  const title = item.kind === "permission" ? `${resolution} permission` : resolution

  return {
    ...state,
    pending: state.pending.filter((candidate) => candidate.id !== id),
    sessions: state.sessions.map((candidate) =>
      candidate.id === item.sessionId
        ? {
            ...candidate,
            status: resolution === "Denied" ? "error" : "working",
            statusLabel: resolution === "Denied" ? "Permission denied" : "Working",
            activity: resolution === "Denied" ? "Waiting for a new direction" : "Continuing your request",
          }
        : candidate,
    ),
    activity: [
      {
        id: `resolved-${item.id}`,
        sessionId: item.sessionId,
        title,
        detail: item.title,
        time: "now",
        icon: resolution === "Denied" ? "alert" : "checkmark",
        tone: resolution === "Denied" ? "danger" : "success",
      },
      ...state.activity,
    ],
    toast: session ? `${session.petName}: ${title.toLowerCase()}` : title,
  }
}

/**
 * The one agent the app is currently about.
 *
 * The screen shows a single waiting agent at a time, so "which one" has to be
 * a decision made in exactly one place. Oldest first: the thing that has been
 * blocked longest is the thing most worth unblocking, and answering in a
 * stable order means an agent can never be starved by newer arrivals.
 */
export function focusOf(state: ClippyState): { item: PendingItem; session: Session } | null {
  const item = state.pending[state.pending.length - 1] ?? null
  if (!item) return null
  const session = sessionFor(state, item.sessionId)
  return session ? { item, session } : null
}

/** Requests the demo can produce, so "an agent needs you" is reachable on a device. */
const INCOMING: Array<Omit<PendingItem, "id" | "createdAt">> = [
  {
    sessionId: "nori",
    kind: "permission",
    eyebrow: "Permission request",
    title: "Nori wants to install a dependency",
    detail: "Adding zod to validate the relay payloads.",
    command: "npm install zod",
  },
  {
    sessionId: "orbit",
    kind: "question",
    eyebrow: "Question",
    title: "Should retries back off exponentially?",
    detail: "The relay currently retries three times, evenly spaced.",
    options: ["Exponential", "Keep it even", "Don't retry"],
  },
  {
    sessionId: "biscuit",
    kind: "review",
    eyebrow: "Finished your turn",
    title: "Biscuit rebuilt the iOS app",
    detail: "Cleaned the build folder, rebuilt, and the app launches on the simulator.",
  },
]

/** Push the next demo request onto the queue, as though a Mac had just relayed it. */
export function receiveNext(state: ClippyState, at: number): ClippyState {
  const template = INCOMING[state.pending.length % INCOMING.length]
  const item: PendingItem = { ...template, id: `incoming-${at}`, createdAt: "now" }
  // Newest first, which is the order the rest of this list is already in — and
  // what keeps focusOf() taking the oldest rather than whatever just arrived.
  return { ...state, pending: [item, ...state.pending] }
}
