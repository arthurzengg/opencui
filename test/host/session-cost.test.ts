import { describe, expect, it } from "vitest"
import { readContextUsage } from "../../src/chat/context-usage"
import { NEWEST_PAGE } from "../../src/chat/session-cost"
import type { Backend } from "../../src/server"

type Step = { id: string; cost: number }
type FakeSession = { parent?: string; updated: number; steps: Step[] }

/**
 * A backend holding sessions by id, answering the two routes the cost reads
 * the way a 1.x server does: `messages` returns the newest `limit` or the
 * whole log, `children` the direct children with their `time.updated`.
 */
function fakeBackend(sessions: Record<string, FakeSession>) {
  const calls: string[] = []
  const message = (step: Step) => ({
    info: { id: step.id, role: "assistant", providerID: "anthropic", modelID: "claude-sonnet-5-5", cost: step.cost, tokens: { input: 2, output: 100, reasoning: 0, cache: { read: 1000, write: 10 } } },
    parts: [],
  })
  const api = {
    session: {
      messages: async (id: string, options?: { limit?: number }) => {
        calls.push(options?.limit ? `page ${id}` : `log ${id}`)
        const all = sessions[id]!.steps.map(message)
        return { data: options?.limit ? all.slice(-options.limit) : all, status: 200 }
      },
      children: async (id: string) => {
        calls.push(`children ${id}`)
        const data = Object.entries(sessions)
          .filter(([, s]) => s.parent === id)
          .map(([childID, s]) => ({ id: childID, parentID: id, time: { created: 1, updated: s.updated } }))
        return { data, status: 200 }
      },
    },
    config: { providers: async () => ({ data: { providers: [] }, status: 200 }) },
  }
  return { backend: { url: "http://fake", api } as unknown as Backend, calls }
}

const steps = (prefix: string, costs: number[]): Step[] => costs.map((cost, i) => ({ id: `${prefix}${i}`, cost }))

describe("the session's cost (#792)", () => {
  // Recorded proportions: the subagents of the checked session cost over three
  // times what the session's own messages did, and the total showed none of it.
  it("counts the sessions of its subagents and of theirs", async () => {
    const { backend } = fakeBackend({
      root1: { updated: 5, steps: steps("r1m", [0.38, 0.02, 0.05]) },
      oracle1: { parent: "root1", updated: 3, steps: steps("o1m", [0.51, 0.27, 0.08]) },
      oracle2: { parent: "root1", updated: 4, steps: steps("o2m", [0.48, 0.63]) },
      helper1: { parent: "oracle2", updated: 4, steps: steps("h1m", [0.1]) },
    })
    expect((await readContextUsage(backend, "root1"))?.cost).toBeCloseTo(0.45 + 0.86 + 1.11 + 0.1, 6)
  })

  it("reads a subagent's session again only once it has run", async () => {
    const sessions: Record<string, FakeSession> = {
      root2: { updated: 5, steps: steps("r2m", [0.2]) },
      oracle3: { parent: "root2", updated: 3, steps: steps("o3m", [0.5]) },
    }
    const { backend, calls } = fakeBackend(sessions)
    await readContextUsage(backend, "root2")
    calls.length = 0
    await readContextUsage(backend, "root2")
    expect(calls).not.toContain("log oracle3")

    sessions.oracle3 = { parent: "root2", updated: 9, steps: steps("o3m", [0.5, 0.25]) }
    expect((await readContextUsage(backend, "root2"))?.cost).toBeCloseTo(0.95, 6)
  })

  // The refresh runs after every step. It read the newest 100 messages and
  // summed those, so a long session lost its older steps.
  it("counts the messages older than the newest page, and reads them once", async () => {
    const sessions: Record<string, FakeSession> = {
      root3: { updated: 5, steps: steps("r3m", Array.from({ length: NEWEST_PAGE + 50 }, () => 0.01)) },
    }
    const { backend, calls } = fakeBackend(sessions)
    expect((await readContextUsage(backend, "root3"))?.cost).toBeCloseTo(1.5, 6)

    sessions.root3!.steps.push({ id: "r3new", cost: 0.04 })
    calls.length = 0
    expect((await readContextUsage(backend, "root3"))?.cost).toBeCloseTo(1.54, 6)
    expect(calls.filter((call) => call.endsWith("root3"))).toEqual(["page root3", "children root3"])
  })

  it("reads the messages in between when more than a page arrived since the last refresh", async () => {
    const sessions: Record<string, FakeSession> = { root4: { updated: 5, steps: steps("r4m", [0.3, 0.2]) } }
    const { backend } = fakeBackend(sessions)
    await readContextUsage(backend, "root4")
    sessions.root4!.steps.push(...steps("r4late", Array.from({ length: NEWEST_PAGE + 20 }, () => 0.01)))
    expect((await readContextUsage(backend, "root4"))?.cost).toBeCloseTo(0.5 + 1.2, 6)
  })
})
