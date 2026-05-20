import { describe, it, expect } from "vitest"
import {
  classifyTool,
  expectedToolFamilies,
  toolFamilyToManifestSource,
} from "../../src/opencode/tool-discovery"

describe("classifyTool", () => {
  it("classifies stock opencode shell tools", () => {
    expect(classifyTool("bash")).toBe("shell")
    expect(classifyTool("shell")).toBe("shell")
    expect(classifyTool("exec")).toBe("shell")
    expect(classifyTool("run")).toBe("shell")
  })

  it("classifies known LSP-family tools", () => {
    expect(classifyTool("lsp_diagnostics")).toBe("lsp")
    expect(classifyTool("lsp_hover")).toBe("lsp")
    expect(classifyTool("ast_grep")).toBe("lsp")
    expect(classifyTool("lsp_anything_else")).toBe("lsp")
  })

  it("classifies known OMO tools", () => {
    expect(classifyTool("hephaestus")).toBe("omo")
    expect(classifyTool("scout")).toBe("omo")
    expect(classifyTool("crafter")).toBe("omo")
    expect(classifyTool("lens")).toBe("omo")
    expect(classifyTool("todo")).toBe("omo")
  })

  it("classifies semantic-search tools", () => {
    expect(classifyTool("codebase_search")).toBe("semantic")
    expect(classifyTool("semantic_search")).toBe("semantic")
    expect(classifyTool("vector_search")).toBe("semantic")
  })

  it("falls back to opencode for unknown tools", () => {
    expect(classifyTool("read_file")).toBe("opencode")
    expect(classifyTool("edit_file")).toBe("opencode")
    expect(classifyTool("definitely_not_known")).toBe("opencode")
  })

  it("is case-insensitive and tolerates suffixes", () => {
    expect(classifyTool("BASH")).toBe("shell")
    expect(classifyTool("Hephaestus")).toBe("omo")
    expect(classifyTool("scout:v2")).toBe("omo")
    expect(classifyTool("lsp_hover_v2")).toBe("lsp")
  })

  it("handles empty/null-ish input safely", () => {
    expect(classifyTool("")).toBe("opencode")
  })
})

describe("expectedToolFamilies", () => {
  it("isolated mode → built-in families only", () => {
    expect(expectedToolFamilies("isolated")).toEqual(["opencode", "shell", "lsp"])
  })

  it("user mode → built-in + omo + semantic", () => {
    expect(expectedToolFamilies("user")).toEqual([
      "opencode",
      "shell",
      "lsp",
      "omo",
      "semantic",
    ])
  })
})

describe("toolFamilyToManifestSource", () => {
  it("maps omo and semantic to their own sources", () => {
    expect(toolFamilyToManifestSource("omo")).toBe("omo")
    expect(toolFamilyToManifestSource("semantic")).toBe("semantic")
  })

  it("rolls shell / lsp / opencode under the opencode bucket", () => {
    expect(toolFamilyToManifestSource("opencode")).toBe("opencode")
    expect(toolFamilyToManifestSource("shell")).toBe("opencode")
    expect(toolFamilyToManifestSource("lsp")).toBe("opencode")
  })

  it("maps external to external", () => {
    expect(toolFamilyToManifestSource("external")).toBe("external")
  })
})
