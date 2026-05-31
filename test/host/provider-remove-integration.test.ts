import { describe, it, expect, afterEach } from "vitest"
import { startMockOpencode, type MockOpencodeServer } from "./mock-opencode-server"
import { removeProviderAuth } from "../../src/provider/provider-format"

// Exercises the one untyped path — a real HTTP DELETE /auth/{id} — against the
// mock opencode server, since removeProviderAuth bypasses the typed SDK (no
// published SDK exposes provider-credential removal yet).

describe("removeProviderAuth against a live server", () => {
  let server: MockOpencodeServer | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it("DELETEs the credential and records the provider id", async () => {
    server = await startMockOpencode()
    const res = await removeProviderAuth(server.url, "anthropic")
    expect(res).toEqual({ kind: "ok" })
    expect(server.providerAuthRemoveCalls).toContain("anthropic")
  })

  it("round-trips a url-encoded custom provider id", async () => {
    server = await startMockOpencode()
    const id = "https://x/.well-known/opencode"
    const res = await removeProviderAuth(server.url, id)
    expect(res).toEqual({ kind: "ok" })
    expect(server.providerAuthRemoveCalls).toContain(id)
  })

  it("maps a missing route to unsupported (older opencode)", async () => {
    server = await startMockOpencode()
    server.setAuthRemoveSupported(false)
    const res = await removeProviderAuth(server.url, "anthropic")
    expect(res).toEqual({ kind: "unsupported" })
  })
})
