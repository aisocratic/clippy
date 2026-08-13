import {
  focusOf,
  initialState,
  pendingFor,
  receiveNext,
  resolvePending,
  waitingCount,
} from "./model"

describe("Clippy mobile state", () => {
  test("counts and filters pending work", () => {
    expect(waitingCount(initialState)).toBe(3)
    expect(pendingFor(initialState, "biscuit")).toHaveLength(1)
  })

  test("resolving a permission advances the session and records activity", () => {
    const next = resolvePending(initialState, "permission-build", "Allowed")
    expect(next.pending).toHaveLength(2)
    expect(next.sessions.find((session) => session.id === "biscuit")?.status).toBe("working")
    expect(next.activity[0].title).toBe("Allowed permission")
  })

  test("unknown pending ids do not mutate state", () => {
    expect(resolvePending(initialState, "missing", "Allowed")).toBe(initialState)
  })
})

describe("one at a time", () => {
  it("focuses the agent that has been waiting longest", () => {
    // The whole screen is this choice, so it has to be stable: answering one
    // must never reshuffle which of the others comes next.
    const first = focusOf(initialState)
    expect(first?.item.id).toBe("question-copy")
    expect(first?.session.petName).toBe("Nori")

    const after = resolvePending(initialState, "question-copy", "Playful")
    expect(focusOf(after)?.item.id).toBe("review-api")
  })

  it("is empty when nothing is waiting, rather than showing the last thing", () => {
    const quiet = { ...initialState, pending: [] }
    expect(focusOf(quiet)).toBeNull()
  })

  it("skips an item whose session it cannot name", () => {
    // A relayed request for a session we have never heard of would otherwise
    // render a card with no agent attached to it.
    const orphaned = {
      ...initialState,
      pending: [{ ...initialState.pending[0], id: "orphan", sessionId: "ghost" }],
    }
    expect(focusOf(orphaned)).toBeNull()
  })

  it("an arrival goes to the back of the queue and becomes the focus last", () => {
    const busy = receiveNext(initialState, 1)
    expect(busy.pending).toHaveLength(initialState.pending.length + 1)
    // Still answering the oldest, not the newest that just interrupted.
    expect(focusOf(busy)?.item.id).toBe("question-copy")

    const emptied = receiveNext({ ...initialState, pending: [] }, 2)
    expect(focusOf(emptied)?.item.id).toBe("incoming-2")
  })
})
