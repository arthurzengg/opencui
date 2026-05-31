import { describe, it, expect, vi } from "vitest"
import { removableProviders, removeProviderAuth, authDeletePath } from "../../src/provider/provider-format"

describe("removableProviders", () => {
  it("merges connected ids with config name/source and sorts by name", () => {
    const rows = removableProviders(
      ["openai", "anthropic"],
      [
        { id: "anthropic", name: "Anthropic", source: "config" },
        { id: "openai", name: "OpenAI", source: "api" },
      ],
    )
    expect(rows.map((r) => r.id)).toEqual(["anthropic", "openai"]) // sorted by name
    expect(rows[0]).toEqual({ id: "anthropic", name: "Anthropic", source: "config", removable: true })
    expect(rows.every((r) => r.removable)).toBe(true)
  })

  it("marks env-sourced providers non-removable", () => {
    const rows = removableProviders(["openai"], [{ id: "openai", name: "OpenAI", source: "env" }])
    expect(rows[0]!.removable).toBe(false)
  })

  it("falls back to the id as name and removable=true when config is missing", () => {
    const rows = removableProviders(["mystery"], [])
    expect(rows[0]).toEqual({ id: "mystery", name: "mystery", source: "unknown", removable: true })
  })

  it("returns [] for no connected providers", () => {
    expect(removableProviders([], [{ id: "openai", name: "OpenAI", source: "env" }])).toEqual([])
  })
})

describe("authDeletePath", () => {
  it("builds the route and url-encodes the id", () => {
    expect(authDeletePath("openai")).toBe("/auth/openai")
    expect(authDeletePath("https://x/.well-known/opencode")).toBe(
      "/auth/https%3A%2F%2Fx%2F.well-known%2Fopencode",
    )
  })
})

describe("removeProviderAuth", () => {
  const resp = (status: number) => ({ ok: status >= 200 && status < 300, status })

  it("DELETEs the encoded url and returns ok on 2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(200))
    const res = await removeProviderAuth("http://127.0.0.1:9/", "openai", fetchImpl as never)
    expect(res).toEqual({ kind: "ok" })
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:9/auth/openai", { method: "DELETE" })
  })

  it("maps 404 to unsupported (route missing on older opencode)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(404))
    expect(await removeProviderAuth("http://h", "openai", fetchImpl as never)).toEqual({ kind: "unsupported" })
  })

  it("maps other non-2xx to error with the status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(500))
    expect(await removeProviderAuth("http://h", "x", fetchImpl as never)).toEqual({
      kind: "error",
      message: "HTTP 500",
    })
  })

  it("maps a thrown fetch to error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    expect(await removeProviderAuth("http://h", "x", fetchImpl as never)).toEqual({
      kind: "error",
      message: "ECONNREFUSED",
    })
  })

  it("strips trailing slashes from baseUrl", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(200))
    await removeProviderAuth("http://h///", "x", fetchImpl as never)
    expect(fetchImpl).toHaveBeenCalledWith("http://h/auth/x", { method: "DELETE" })
  })
})
