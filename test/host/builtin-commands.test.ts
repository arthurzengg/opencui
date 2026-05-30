import { describe, it, expect } from "vitest"
import {
  BUILTIN_COMMANDS,
  BUILTIN_COMMAND_NAMES,
  withBuiltinCommands,
  generateMessageID,
} from "../../src/chat/builtin-commands"

describe("withBuiltinCommands", () => {
  it("appends every built-in to an empty custom list", () => {
    const merged = withBuiltinCommands([])
    expect(merged.map((c) => c.name)).toEqual(BUILTIN_COMMANDS.map((c) => c.name))
    expect(merged.every((c) => c.takesArguments === false)).toBe(true)
  })

  it("keeps custom commands first, built-ins after", () => {
    const merged = withBuiltinCommands([{ name: "deploy", takesArguments: true }])
    expect(merged[0]!.name).toBe("deploy")
    expect(merged).toHaveLength(1 + BUILTIN_COMMANDS.length)
  })

  it("lets a custom command shadow a built-in of the same name", () => {
    const custom = [{ name: "compact", description: "my own", takesArguments: true }]
    const merged = withBuiltinCommands(custom)
    const compacts = merged.filter((c) => c.name === "compact")
    expect(compacts).toHaveLength(1)
    // The surviving entry is the custom one (takesArguments / description preserved).
    expect(compacts[0]).toEqual({ name: "compact", description: "my own", takesArguments: true })
    expect(merged).toHaveLength(custom.length + BUILTIN_COMMANDS.length - 1)
  })

  it("exposes the built-in names as a set for routing", () => {
    expect(BUILTIN_COMMAND_NAMES.has("compact")).toBe(true)
    expect(BUILTIN_COMMAND_NAMES.has("share")).toBe(true)
    expect(BUILTIN_COMMAND_NAMES.has("nope")).toBe(false)
  })
})

describe("generateMessageID", () => {
  it("produces a prefixed, fixed-length, Crockford-base32 id", () => {
    const id = generateMessageID()
    expect(id).toMatch(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  it("is unique across calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateMessageID()))
    expect(ids.size).toBe(100)
  })
})
