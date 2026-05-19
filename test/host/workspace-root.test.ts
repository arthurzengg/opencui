import { describe, it, expect, beforeEach, vi } from "vitest"
import * as vscode from "vscode"
import {
  getWorkspaceRoots,
  isInsideRoot,
  isInsideWorkspace,
  primaryWorkspaceRoot,
  relativeToRoot,
  workspaceRootForPath,
  workspaceRootForUri,
  type WorkspaceRoot,
} from "../../src/workspace-root"

type MutableWorkspace = {
  workspaceFolders?: Array<{ uri: { fsPath: string; scheme: string }; name?: string }>
}
type MutableWindow = { activeTextEditor?: { document: { uri: { fsPath: string; scheme: string } } } }

const ws = vscode.workspace as unknown as MutableWorkspace
const win = vscode.window as unknown as MutableWindow

function setFolders(folders: Array<{ fsPath: string; name?: string }>) {
  ws.workspaceFolders = folders.map((f) => ({
    uri: { fsPath: f.fsPath, scheme: "file" } as unknown as vscode.Uri,
    name: f.name ?? f.fsPath.split("/").filter(Boolean).pop() ?? "root",
  }))
}

function setActiveEditor(fsPath: string | undefined) {
  if (!fsPath) {
    win.activeTextEditor = undefined
    return
  }
  win.activeTextEditor = {
    document: { uri: { fsPath, scheme: "file" } as unknown as vscode.Uri },
  }
}

describe("workspace-root", () => {
  beforeEach(() => {
    setFolders([{ fsPath: "/workspace" }])
    setActiveEditor(undefined)
  })

  describe("getWorkspaceRoots", () => {
    it("returns an empty array when no folders are open", () => {
      ws.workspaceFolders = undefined
      expect(getWorkspaceRoots()).toEqual([])
    })

    it("marks index 0 as the default root", () => {
      setFolders([{ fsPath: "/a", name: "a" }, { fsPath: "/b", name: "b" }])
      const roots = getWorkspaceRoots()
      expect(roots).toHaveLength(2)
      expect(roots[0]).toMatchObject({ name: "a", index: 0, isDefault: true })
      expect(roots[1]).toMatchObject({ name: "b", index: 1, isDefault: false })
    })
  })

  describe("isInsideRoot", () => {
    const root: WorkspaceRoot = {
      uri: { fsPath: "/workspace", scheme: "file" } as unknown as vscode.Uri,
      fsPath: "/workspace",
      name: "workspace",
      index: 0,
      isDefault: true,
    }

    it("accepts the root itself", () => {
      expect(isInsideRoot(root, "/workspace")).toBe(true)
    })

    it("accepts a file directly inside the root", () => {
      expect(isInsideRoot(root, "/workspace/src/foo.ts")).toBe(true)
    })

    it("rejects a sibling folder", () => {
      expect(isInsideRoot(root, "/elsewhere/foo.ts")).toBe(false)
    })

    it("rejects the parent directory", () => {
      expect(isInsideRoot(root, "/")).toBe(false)
    })

    it("rejects an empty path defensively", () => {
      expect(isInsideRoot(root, "")).toBe(false)
    })

    it("rejects a sibling that shares a prefix", () => {
      // "/workspace2/x.ts" must not be treated as inside "/workspace".
      expect(isInsideRoot(root, "/workspace2/x.ts")).toBe(false)
    })
  })

  describe("workspaceRootForPath", () => {
    it("returns the containing root when one matches", () => {
      setFolders([{ fsPath: "/a" }, { fsPath: "/b" }])
      expect(workspaceRootForPath("/b/src/file.ts")?.fsPath).toBe("/b")
    })

    it("prefers the longest matching root for nested folders", () => {
      // Both /repo and /repo/packages/foo are open; a file inside the inner
      // folder should resolve to the inner one.
      setFolders([{ fsPath: "/repo" }, { fsPath: "/repo/packages/foo" }])
      expect(workspaceRootForPath("/repo/packages/foo/src/x.ts")?.fsPath).toBe("/repo/packages/foo")
      // …while a file outside the inner folder resolves to the outer one.
      expect(workspaceRootForPath("/repo/other.ts")?.fsPath).toBe("/repo")
    })

    it("returns undefined when no folder matches", () => {
      setFolders([{ fsPath: "/a" }])
      expect(workspaceRootForPath("/elsewhere/x.ts")).toBeUndefined()
    })

    it("returns undefined for an empty or undefined path", () => {
      expect(workspaceRootForPath(undefined)).toBeUndefined()
      expect(workspaceRootForPath("")).toBeUndefined()
    })
  })

  describe("workspaceRootForUri", () => {
    it("rejects non-file schemes", () => {
      const untitled = { fsPath: "/workspace/x.ts", scheme: "untitled" } as unknown as vscode.Uri
      expect(workspaceRootForUri(untitled)).toBeUndefined()
    })

    it("resolves a file-scheme URI inside a workspace folder", () => {
      const uri = { fsPath: "/workspace/foo.ts", scheme: "file" } as unknown as vscode.Uri
      expect(workspaceRootForUri(uri)?.fsPath).toBe("/workspace")
    })
  })

  describe("isInsideWorkspace", () => {
    it("returns true for a workspace file", () => {
      expect(isInsideWorkspace("/workspace/foo.ts")).toBe(true)
    })

    it("returns false for an external file", () => {
      expect(isInsideWorkspace("/Users/me/notes/spec.md")).toBe(false)
    })
  })

  describe("relativeToRoot", () => {
    const root: WorkspaceRoot = {
      uri: { fsPath: "/workspace", scheme: "file" } as unknown as vscode.Uri,
      fsPath: "/workspace",
      name: "workspace",
      index: 0,
      isDefault: true,
    }

    it("produces a forward-slashed relative path", () => {
      expect(relativeToRoot(root, "/workspace/src/foo.ts")).toBe("src/foo.ts")
    })

    it("returns an empty string for the root itself", () => {
      expect(relativeToRoot(root, "/workspace")).toBe("")
    })
  })

  describe("primaryWorkspaceRoot", () => {
    it("returns undefined when there is no folder open", () => {
      ws.workspaceFolders = undefined
      expect(primaryWorkspaceRoot()).toBeUndefined()
    })

    it("falls back to the first folder when no editor is active", () => {
      setFolders([{ fsPath: "/a", name: "a" }, { fsPath: "/b", name: "b" }])
      expect(primaryWorkspaceRoot()?.fsPath).toBe("/a")
    })

    it("prefers the folder containing the active editor", () => {
      setFolders([{ fsPath: "/a", name: "a" }, { fsPath: "/b", name: "b" }])
      setActiveEditor("/b/src/file.ts")
      expect(primaryWorkspaceRoot()?.fsPath).toBe("/b")
    })

    it("falls back to the first folder when the active editor is external", () => {
      setFolders([{ fsPath: "/a", name: "a" }, { fsPath: "/b", name: "b" }])
      setActiveEditor("/elsewhere/x.ts")
      expect(primaryWorkspaceRoot()?.fsPath).toBe("/a")
    })
  })
})
