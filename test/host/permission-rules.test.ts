import { describe, it, expect, vi } from "vitest"
import type * as vscode from "vscode"
import { matchWildcard, rulesAllow, PermissionRuleStore, PERMISSION_RULES_KEY } from "../../src/chat/permission-rules"

function memento(seed: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(seed))
  return {
    keys: () => [...store.keys()],
    get: (key: string, fallback?: unknown) => (store.has(key) ? store.get(key) : fallback),
    update: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value)
    }),
  } as unknown as vscode.Memento
}

describe("matchWildcard (port of opencode's Wildcard.match)", () => {
  it.each([
    ["git *", "git status", true],
    // A trailing " *" also matches the bare command.
    ["git *", "git", true],
    ["git *", "gitk", false],
    ["*", "anything at all", true],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    // Regex specials in the pattern are literal.
    ["a.b", "axb", false],
    ["a.b", "a.b", true],
    ["/tmp/*", "/tmp/x/y", true],
    // Backslashes normalise on both sides.
    ["C:/ws/*", "C:\\ws\\file.ts", true],
  ])("%s against %s is %s", (pattern, value, expected) => {
    expect(matchWildcard(value, pattern)).toBe(expected)
  })
})

describe("rulesAllow", () => {
  const rules = [
    { id: "1", permission: "bash", pattern: "git *", createdAt: 0 },
    { id: "2", permission: "edit", pattern: "*", createdAt: 0 },
  ]

  it("allows when every pattern is covered by a rule for that permission", () => {
    expect(rulesAllow(rules, "bash", ["git status"])).toBe(true)
    expect(rulesAllow(rules, "bash", ["git status", "git diff"])).toBe(true)
    expect(rulesAllow(rules, "edit", ["src/a.ts"])).toBe(true)
  })

  it("needs every pattern covered, not just one", () => {
    expect(rulesAllow(rules, "bash", ["git status", "rm -rf dist"])).toBe(false)
  })

  it("never allows an unknown permission or an empty pattern list", () => {
    expect(rulesAllow(rules, "webfetch", ["*"])).toBe(false)
    expect(rulesAllow(rules, "", ["*"])).toBe(false)
    expect(rulesAllow(rules, "bash", [])).toBe(false)
  })
})

describe("PermissionRuleStore", () => {
  it("loads saved rules and ignores malformed entries", () => {
    const state = memento({
      [PERMISSION_RULES_KEY]: [
        { id: "1", permission: "bash", pattern: "git *", createdAt: 5 },
        { id: "2", permission: "bash" },
        "junk",
      ],
    })
    const store = new PermissionRuleStore(state)
    expect(store.list()).toEqual([{ id: "1", permission: "bash", pattern: "git *", createdAt: 5 }])
    expect(store.allows("bash", ["git log"])).toBe(true)
  })

  it("add saves one rule per pattern, skips duplicates, persists, and notifies", async () => {
    const state = memento()
    const store = new PermissionRuleStore(state, () => 42)
    const seen: unknown[] = []
    store.onDidChange((rules) => seen.push(rules))

    const added = await store.add("bash", ["git *", "ls *"])
    expect(added.map((r) => r.pattern)).toEqual(["git *", "ls *"])
    expect(added[0]).toMatchObject({ permission: "bash", createdAt: 42 })
    expect(state.get(PERMISSION_RULES_KEY)).toHaveLength(2)
    expect(seen).toHaveLength(1)

    expect(await store.add("bash", ["git *"])).toEqual([])
    expect(store.list()).toHaveLength(2)
    // Nothing changed, so nothing was announced or written.
    expect(seen).toHaveLength(1)
    expect(state.update).toHaveBeenCalledTimes(1)
  })

  it("remove and clear drop rules and announce the new list", async () => {
    const state = memento()
    const store = new PermissionRuleStore(state)
    const seen: unknown[][] = []
    store.onDidChange((rules) => seen.push(rules))

    const [git, ls] = await store.add("bash", ["git *", "ls *"])
    expect(await store.remove(git!.id)).toBe(true)
    expect(store.list()).toEqual([ls])
    expect(state.get(PERMISSION_RULES_KEY)).toEqual([ls])
    expect(await store.remove("missing")).toBe(false)

    await store.clear()
    expect(store.list()).toEqual([])
    expect(state.get(PERMISSION_RULES_KEY)).toEqual([])
    expect(seen.map((r) => r.length)).toEqual([2, 1, 0])
  })

  it("list returns a copy", async () => {
    const store = new PermissionRuleStore(memento())
    await store.add("edit", ["*"])
    store.list().pop()
    expect(store.list()).toHaveLength(1)
  })
})
