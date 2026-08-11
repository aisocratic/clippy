import { initialState, pendingFor, resolvePending, waitingCount } from "./model"

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
