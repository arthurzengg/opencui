import { describe, it, expect } from "vitest"
import * as vscode from "vscode"
import { buildManifest } from "../../src/workspace-context/manifest"
import type { WorkspaceRoot } from "../../src/workspace-root"

const ROOT: WorkspaceRoot = {
  uri: { fsPath: "/repo", scheme: "file" } as unknown as vscode.Uri,
  fsPath: "/repo",
  name: "repo",
  index: 0,
  isDefault: true,
}

const WORKSPACE_INFO = {
  name: "repo",
  root: "/repo",
  isDefault: true,
  multiRoot: false,
  configMode: "isolated" as const,
}

describe("buildManifest", () => {
  it("emits an empty items array when nothing is attached", () => {
    const m = buildManifest({
      workspace: ROOT,
      workspaceInfo: WORKSPACE_INFO,
      configMode: "isolated",
      editor: {},
    })
    expect(m.items).toEqual([])
    expect(m.totals.includedItems).toBe(0)
    expect(m.workspace).toEqual(WORKSPACE_INFO)
    expect(m.opencode?.configMode).toBe("isolated")
  })

  it("adds an active-editor item when relativePath is present", () => {
    const m = buildManifest({
      workspace: ROOT,
      workspaceInfo: WORKSPACE_INFO,
      configMode: "isolated",
      editor: {
        filePath: "/repo/src/foo.ts",
        relativePath: "src/foo.ts",
        language: "ts",
      },
    })
    const editorItem = m.items.find((i) => i.source === "editor")
    expect(editorItem).toBeDefined()
    expect(editorItem?.path).toBe("src/foo.ts")
    expect(editorItem?.external).toBeFalsy()
  })

  it("marks the editor item external when it lives outside the workspace", () => {
    const m = buildManifest({
      workspace: ROOT,
      workspaceInfo: WORKSPACE_INFO,
      configMode: "isolated",
      editor: {
        filePath: "/Users/me/notes/spec.md",
        relativePath: "../../../Users/me/notes/spec.md",
        language: "md",
      },
    })
    const editorItem = m.items.find((i) => i.source === "external")
    expect(editorItem).toBeDefined()
    expect(editorItem?.external).toBe(true)
  })

  it("adds a selection item with the L<start>-<end> label", () => {
    const m = buildManifest({
      workspace: ROOT,
      workspaceInfo: WORKSPACE_INFO,
      configMode: "isolated",
      editor: {
        filePath: "/repo/src/foo.ts",
        relativePath: "src/foo.ts",
        language: "ts",
        selection: { startLine: 3, endLine: 5, text: "const x = 1" },
      },
    })
    const selectionItem = m.items.find((i) => i.kind === "selection")
    expect(selectionItem).toBeDefined()
    expect(selectionItem?.label).toBe("src/foo.ts#L3-5")
    expect(selectionItem?.bytes).toBe("const x = 1".length)
  })

  it("classifies absolute external mentions and includes byte counts", () => {
    const m = buildManifest({
      workspace: ROOT,
      workspaceInfo: WORKSPACE_INFO,
      configMode: "isolated",
      editor: {},
      mentions: ["src/inside.ts", "/elsewhere/outside.md"],
      mentionBytes: {
        "src/inside.ts": { included: 100, original: 100 },
        "/elsewhere/outside.md": { included: 50, original: 50 },
      },
    })
    const inside = m.items.find((i) => i.label === "src/inside.ts")
    const outside = m.items.find((i) => i.label === "/elsewhere/outside.md")
    expect(inside?.source).toBe("mention")
    expect(inside?.external).toBeFalsy()
    expect(outside?.source).toBe("external")
    expect(outside?.external).toBe(true)
    expect(m.totals.includedBytes).toBe(150)
  })

  it("marks mentions as truncated when included < original", () => {
    const m = buildManifest({
      workspace: ROOT,
      workspaceInfo: WORKSPACE_INFO,
      configMode: "isolated",
      editor: {},
      mentions: ["big.ts"],
      mentionBytes: { "big.ts": { included: 200, original: 1000 } },
    })
    const item = m.items.find((i) => i.path === "big.ts")
    expect(item?.status).toBe("truncated")
    expect(m.totals.truncatedItems).toBe(1)
    expect(m.totals.includedItems).toBe(1)
  })

  it("includes attachment items with bytes", () => {
    const m = buildManifest({
      workspace: ROOT,
      workspaceInfo: WORKSPACE_INFO,
      configMode: "isolated",
      editor: {},
      attachments: [
        {
          id: "att_1",
          mime: "image/png",
          filename: "screen.png",
          dataUrl: "data:image/png;base64,xxx",
          bytes: 4096,
          sourcePath: "/repo/screens/screen.png",
        },
      ],
    })
    const item = m.items.find((i) => i.source === "attachment")
    expect(item?.label).toBe("screen.png")
    expect(item?.bytes).toBe(4096)
    expect(item?.external).toBeFalsy()
  })

  it("flags external attachments when sourcePath is outside the workspace", () => {
    const m = buildManifest({
      workspace: ROOT,
      workspaceInfo: WORKSPACE_INFO,
      configMode: "isolated",
      editor: {},
      attachments: [
        {
          id: "att_2",
          mime: "application/pdf",
          filename: "spec.pdf",
          dataUrl: "data:application/pdf;base64,xxx",
          bytes: 1024,
          sourcePath: "/Users/me/spec.pdf",
        },
      ],
    })
    const item = m.items.find((i) => i.source === "attachment")
    expect(item?.external).toBe(true)
  })

  it("threads configMode through into opencode metadata", () => {
    const m = buildManifest({
      workspace: ROOT,
      workspaceInfo: WORKSPACE_INFO,
      configMode: "user",
      editor: {},
    })
    expect(m.opencode?.configMode).toBe("user")
  })

  it("populates expected tool families based on config mode", () => {
    const isolated = buildManifest({
      workspace: ROOT,
      workspaceInfo: WORKSPACE_INFO,
      configMode: "isolated",
      editor: {},
    })
    expect(isolated.opencode?.toolFamilies).toEqual(["opencode", "shell", "lsp"])

    const user = buildManifest({
      workspace: ROOT,
      workspaceInfo: WORKSPACE_INFO,
      configMode: "user",
      editor: {},
    })
    expect(user.opencode?.toolFamilies).toEqual([
      "opencode",
      "shell",
      "lsp",
      "omo",
      "semantic",
    ])
  })
})
