import { describe, it, expect } from "vitest"
import { detectCommand, filterCommands, parseCommandInput } from "../../webview/src/command-tokens"

describe("detectCommand", () => {
  it("opens on a bare leading slash with an empty query", () => {
    expect(detectCommand("/", 1)).toEqual({ query: "" })
  })

  it("captures the command name typed after the slash", () => {
    expect(detectCommand("/dep", 4)).toEqual({ query: "dep" })
  })

  it("stays open while the caret is at the end of the name, before the space", () => {
    expect(detectCommand("/dep foo", 4)).toEqual({ query: "dep" })
  })

  it("closes once the caret moves past the first space (now editing args)", () => {
    expect(detectCommand("/dep foo", 8)).toBeUndefined()
    expect(detectCommand("/dep ", 5)).toBeUndefined()
  })

  it("never triggers mid-string — the slash must be the first character", () => {
    expect(detectCommand("a/b", 3)).toBeUndefined()
    expect(detectCommand("look /dep", 9)).toBeUndefined()
    expect(detectCommand("1/2", 3)).toBeUndefined()
  })
})

describe("filterCommands", () => {
  const cmds = [{ name: "deploy" }, { name: "review" }, { name: "redeploy" }, { name: "compact" }]

  it("returns the full list for an empty query", () => {
    expect(filterCommands(cmds, "")).toHaveLength(4)
  })

  it("is case-insensitive", () => {
    expect(filterCommands(cmds, "DEP").map((c) => c.name)).toEqual(["deploy", "redeploy"])
  })

  it("surfaces prefix matches before substring matches", () => {
    // "deploy" is a prefix match; "redeploy" only contains "dep".
    expect(filterCommands(cmds, "dep").map((c) => c.name)).toEqual(["deploy", "redeploy"])
  })

  it("returns [] when nothing matches", () => {
    expect(filterCommands(cmds, "zzz")).toEqual([])
  })
})

describe("parseCommandInput", () => {
  it("splits a name with no arguments", () => {
    expect(parseCommandInput("/deploy")).toEqual({ name: "deploy", args: "" })
  })

  it("splits a name and its argument remainder", () => {
    expect(parseCommandInput("/deploy prod now")).toEqual({ name: "deploy", args: "prod now" })
  })

  it("trims surrounding whitespace from the arguments", () => {
    expect(parseCommandInput("/deploy   prod  ")).toEqual({ name: "deploy", args: "prod" })
  })

  it("returns undefined for non-slash input", () => {
    expect(parseCommandInput("hello world")).toBeUndefined()
  })
})
