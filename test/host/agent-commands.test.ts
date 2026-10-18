import { describe, it, expect } from "vitest"
import { withAgentCommands } from "../../src/chat/agent-commands"

describe("withAgentCommands", () => {
  it("appends one switcher per agent with takesArguments + agentSwitch", () => {
    const merged = withAgentCommands([], [
      { name: "build", description: "Do builds" },
      { name: "plan" },
    ])
    expect(merged.map((c) => c.name)).toEqual(["build", "plan"])
    expect(merged.every((c) => c.takesArguments && c.agentSwitch)).toBe(true)
    expect(merged[0]!.description).toContain("build")
  })

  it("lets custom/built-in names shadow same-named agents", () => {
    const merged = withAgentCommands(
      [{ name: "build", description: "custom", takesArguments: false }],
      [{ name: "build" }, { name: "explore" }],
    )
    const builds = merged.filter((c) => c.name === "build")
    expect(builds).toHaveLength(1)
    expect(builds[0]).toEqual({ name: "build", description: "custom", takesArguments: false })
    expect(merged.some((c) => c.name === "explore" && c.agentSwitch)).toBe(true)
  })

  it("returns the input when there are no agents", () => {
    const input = [{ name: "compact", takesArguments: false }]
    expect(withAgentCommands(input, [])).toBe(input)
  })
})
