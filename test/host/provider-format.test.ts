import { describe, it, expect, vi } from "vitest"
import {
  removableProviders,
  removeProviderAuth,
  authDeletePath,
  connectableProviders,
  refreshInstance,
} from "../../src/provider/provider-format"

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

describe("connectableProviders", () => {
  const names = new Map([
    ["openai", "OpenAI"],
    ["anthropic", "Anthropic"],
  ])

  it("lists providers with methods, sorted by name, flagging connected ones", () => {
    const out = connectableProviders(
      {
        openai: [{ type: "api", label: "API Key" }],
        anthropic: [
          { type: "oauth", label: "Claude Pro/Max" },
          { type: "api", label: "API Key" },
        ],
      },
      names,
      ["anthropic"],
    )
    expect(out.map((p) => p.id)).toEqual(["anthropic", "openai"]) // sorted by name
    expect(out[0]).toEqual({
      id: "anthropic",
      name: "Anthropic",
      connected: true,
      methods: [
        { type: "oauth", label: "Claude Pro/Max" },
        { type: "api", label: "API Key" },
      ],
    })
    expect(out[1]!.connected).toBe(false)
  })

  it("drops providers with no methods and falls back to the id when unnamed", () => {
    const out = connectableProviders({ foo: [], bar: [{ type: "api", label: "API Key" }] }, new Map(), [])
    expect(out.map((p) => p.id)).toEqual(["bar"])
    expect(out[0]!.name).toBe("bar")
  })

  it("catalog providers without a declared login flow get the API-key method (#567)", () => {
    // The #567 shape: deepseek is in the /provider catalog but has no
    // /provider/auth entry — it must still be connectable via auth.set.
    const out = connectableProviders(
      { openai: [{ type: "oauth", label: "Login with OpenAI" }] },
      new Map([
        ["deepseek", "DeepSeek"],
        ["openai", "OpenAI"],
      ]),
      [],
    )
    expect(out.map((p) => p.id)).toEqual(["deepseek", "openai"])
    expect(out[0]!.methods).toEqual([{ type: "api", label: "API key" }])
    // Declared methods always win over the synthetic fallback.
    expect(out[1]!.methods).toEqual([{ type: "oauth", label: "Login with OpenAI" }])
  })

  it("a declared-but-empty method list falls back to API key when the catalog knows the id", () => {
    const out = connectableProviders({ deepseek: [] }, new Map([["deepseek", "DeepSeek"]]), [])
    expect(out).toHaveLength(1)
    expect(out[0]!.methods).toEqual([{ type: "api", label: "API key" }])
  })

  it("flags connected catalog-only providers so they read as reconnect", () => {
    const out = connectableProviders({}, new Map([["deepseek", "DeepSeek"]]), ["deepseek"])
    expect(out[0]!.connected).toBe(true)
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

describe("refreshInstance", () => {
  const resp = (status: number) => ({ ok: status >= 200 && status < 300, status })

  it("POSTs the dispose route with the encoded directory and returns true on 2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(200))
    expect(await refreshInstance("http://127.0.0.1:9/", "/my ws", fetchImpl as never)).toBe(true)
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:9/instance/dispose?directory=%2Fmy%20ws", {
      method: "POST",
    })
  })

  it("returns false on non-2xx (route missing on older opencode)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(resp(404))
    expect(await refreshInstance("http://h", "/ws", fetchImpl as never)).toBe(false)
  })

  it("returns false when the fetch throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"))
    expect(await refreshInstance("http://h", "/ws", fetchImpl as never)).toBe(false)
  })
})
