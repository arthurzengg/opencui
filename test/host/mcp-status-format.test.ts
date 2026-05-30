import { describe, it, expect } from "vitest"
import type { McpStatus } from "@opencode-ai/sdk"
import {
  actionsFor,
  parseCommand,
  statusError,
  statusIcon,
  statusLabel,
  validateServerName,
} from "../../src/mcp/status-format"

const STATUSES: McpStatus[] = [
  { status: "connected" },
  { status: "disabled" },
  { status: "failed", error: "ECONNREFUSED" },
  { status: "needs_auth" },
  { status: "needs_client_registration", error: "no clientId" },
]

describe("statusIcon", () => {
  it("returns a distinct codicon per status", () => {
    const icons = STATUSES.map(statusIcon)
    expect(new Set(icons).size).toBe(STATUSES.length)
    expect(icons.every((i) => i.startsWith("$("))).toBe(true)
  })
})

describe("statusLabel", () => {
  it("renders a human label, inlining the error for failed", () => {
    expect(statusLabel({ status: "connected" })).toBe("connected")
    expect(statusLabel({ status: "disabled" })).toBe("disabled")
    expect(statusLabel({ status: "needs_auth" })).toBe("needs auth")
    expect(statusLabel({ status: "failed", error: "boom" })).toBe("failed: boom")
    expect(statusLabel({ status: "needs_client_registration", error: "x" })).toBe("needs client registration")
  })
})

describe("statusError", () => {
  it("returns the error only for the statuses that carry one", () => {
    expect(statusError({ status: "failed", error: "boom" })).toBe("boom")
    expect(statusError({ status: "needs_client_registration", error: "x" })).toBe("x")
    expect(statusError({ status: "connected" })).toBeUndefined()
    expect(statusError({ status: "needs_auth" })).toBeUndefined()
    expect(statusError({ status: "disabled" })).toBeUndefined()
  })
})

describe("actionsFor", () => {
  it("offers status-appropriate actions", () => {
    expect(actionsFor({ status: "connected" })).toEqual(["disconnect", "signout"])
    expect(actionsFor({ status: "disabled" })).toEqual(["connect"])
    expect(actionsFor({ status: "failed", error: "x" })).toEqual(["connect", "showError"])
    expect(actionsFor({ status: "needs_auth" })).toEqual(["authenticate", "connect", "signout"])
    expect(actionsFor({ status: "needs_client_registration", error: "x" })).toEqual(["showError"])
  })

  it("only offers authenticate when a server needs auth", () => {
    for (const st of STATUSES) {
      const hasAuth = actionsFor(st).includes("authenticate")
      expect(hasAuth).toBe(st.status === "needs_auth")
    }
  })
})

describe("parseCommand", () => {
  it("splits on whitespace and drops empties", () => {
    expect(parseCommand("npx -y @scope/server")).toEqual(["npx", "-y", "@scope/server"])
    expect(parseCommand("  spaced   out  ")).toEqual(["spaced", "out"])
    expect(parseCommand("")).toEqual([])
    expect(parseCommand("   ")).toEqual([])
  })
})

describe("validateServerName", () => {
  const existing = new Set(["github"])
  it("rejects empty, spaced, and duplicate names", () => {
    expect(validateServerName("", existing)).toMatch(/required/i)
    expect(validateServerName("   ", existing)).toMatch(/required/i)
    expect(validateServerName("my server", existing)).toMatch(/spaces/i)
    expect(validateServerName("github", existing)).toMatch(/already exists/i)
  })
  it("accepts a fresh single-token name", () => {
    expect(validateServerName("linear", existing)).toBeUndefined()
    expect(validateServerName("  linear  ", existing)).toBeUndefined()
  })
})
