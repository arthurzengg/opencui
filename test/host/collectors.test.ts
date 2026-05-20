import { describe, it, expect, beforeEach, vi } from "vitest"
import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import { collectOpenTabs } from "../../src/workspace-context/open-tabs"
import { collectDiagnostics } from "../../src/workspace-context/diagnostics"
import { collectGitDiff } from "../../src/workspace-context/git"
import { RecentEditsTracker } from "../../src/workspace-context/recent-edits"
import { collectDocs } from "../../src/workspace-context/docs"
import { collectSymbols } from "../../src/workspace-context/symbols"
import type { WorkspaceRoot } from "../../src/workspace-root"

const WORKSPACE: WorkspaceRoot = {
  uri: { fsPath: "/workspace", scheme: "file" } as unknown as vscode.Uri,
  fsPath: "/workspace",
  name: "workspace",
  index: 0,
  isDefault: true,
}

type MutableWindow = {
  activeTextEditor?: { document: { uri: { fsPath: string; scheme: string } } }
  tabGroups: { all: Array<{ tabs: Array<{ input?: unknown }> }> }
}
const win = vscode.window as unknown as MutableWindow
const execFileAsync = promisify(execFile)

function setTabs(paths: string[]) {
  win.tabGroups = {
    all: [
      {
        tabs: paths.map((p) => ({
          input: { uri: { fsPath: p, scheme: "file" } as unknown as vscode.Uri },
        })),
      },
    ],
  }
}

function setActive(p: string | undefined) {
  win.activeTextEditor = p
    ? { document: { uri: { fsPath: p, scheme: "file" } } }
    : undefined
}

describe("collectOpenTabs", () => {
  beforeEach(() => {
    win.tabGroups = { all: [] }
    setActive(undefined)
  })

  it("returns empty output when no tabs are open", async () => {
    const out = await collectOpenTabs(WORKSPACE)
    expect(out.items).toEqual([])
    expect(out.blocks).toEqual([])
  })

  it("lists workspace tabs and marks the active one", async () => {
    setTabs(["/workspace/a.ts", "/workspace/b.ts"])
    setActive("/workspace/b.ts")
    const out = await collectOpenTabs(WORKSPACE)
    expect(out.items).toHaveLength(1)
    expect(out.blocks[0].content).toContain("- b.ts  (active)")
    expect(out.blocks[0].content).toContain("- a.ts")
  })

  it("filters out external tabs", async () => {
    setTabs(["/workspace/a.ts", "/elsewhere/b.ts"])
    const out = await collectOpenTabs(WORKSPACE)
    expect(out.blocks[0].content).toContain("a.ts")
    expect(out.blocks[0].content).not.toContain("b.ts")
  })
})

describe("collectDiagnostics", () => {
  beforeEach(() => {
    vi.mocked(vscode.languages.getDiagnostics).mockReset()
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])
  })

  it("returns empty output when there are no diagnostics", () => {
    const out = collectDiagnostics(WORKSPACE)
    expect(out.items).toEqual([])
  })

  it("orders errors before warnings", () => {
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([
      [
        { fsPath: "/workspace/a.ts", scheme: "file" } as unknown as vscode.Uri,
        [
          {
            range: { start: { line: 4 } } as unknown as vscode.Range,
            severity: vscode.DiagnosticSeverity.Warning,
            message: "warn here",
            source: "eslint",
          } as unknown as vscode.Diagnostic,
          {
            range: { start: { line: 1 } } as unknown as vscode.Range,
            severity: vscode.DiagnosticSeverity.Error,
            message: "type error",
            source: "ts",
            code: "TS2345",
          } as unknown as vscode.Diagnostic,
        ],
      ],
    ])
    const out = collectDiagnostics(WORKSPACE)
    expect(out.blocks).toHaveLength(1)
    const lines = out.blocks[0].content.split("\n")
    expect(lines[0]).toContain("error")
    expect(lines[0]).toContain("TS2345")
    expect(lines[1]).toContain("warning")
  })

  it("drops diagnostics from outside the workspace", () => {
    vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([
      [
        { fsPath: "/elsewhere/file.ts", scheme: "file" } as unknown as vscode.Uri,
        [
          {
            range: { start: { line: 1 } } as unknown as vscode.Range,
            severity: vscode.DiagnosticSeverity.Error,
            message: "no",
          } as unknown as vscode.Diagnostic,
        ],
      ],
    ])
    const out = collectDiagnostics(WORKSPACE)
    expect(out.items).toEqual([])
  })
})

describe("collectGitDiff", () => {
  it("returns empty output for a non-git directory", async () => {
    const out = await collectGitDiff({ ...WORKSPACE, fsPath: "/tmp/definitely-not-a-repo-xyzzy" })
    expect(out.items).toEqual([])
    expect(out.blocks).toEqual([])
  })

  it("scopes parent-repo git output to the opened workspace folder", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencui-git-scope-"))
    const workspace = path.join(root, "test")
    const sibling = path.join(root, "ExamHelper")
    await fs.mkdir(workspace)
    await fs.mkdir(sibling)
    await fs.writeFile(path.join(workspace, "app.ts"), "export const value = 1\n")
    await fs.writeFile(path.join(sibling, "app.py"), "print('old')\n")

    await execFileAsync("git", ["init"], { cwd: root })
    await execFileAsync("git", ["add", "."], { cwd: root })
    await execFileAsync(
      "git",
      ["-c", "user.name=OpenCode Panel", "-c", "user.email=test@example.com", "commit", "-m", "initial"],
      { cwd: root },
    )

    await fs.writeFile(path.join(workspace, "app.ts"), "export const value = 2\n")
    await fs.writeFile(path.join(sibling, "app.py"), "print('new')\n")

    const out = await collectGitDiff({
      ...WORKSPACE,
      fsPath: workspace,
      uri: vscode.Uri.file(workspace),
      name: "test",
    })

    expect(out.blocks).toHaveLength(1)
    expect(out.blocks[0].content).toContain("app.ts")
    expect(out.blocks[0].content).toContain("value = 2")
    expect(out.blocks[0].content).not.toContain("ExamHelper")
    expect(out.blocks[0].content).not.toContain("app.py")
    expect(out.blocks[0].content).not.toContain("../")
  })
})

describe("RecentEditsTracker", () => {
  it("starts empty and trims items outside the workspace", async () => {
    const t = new RecentEditsTracker()
    expect(t.list(WORKSPACE)).toEqual([])
    const out = await t.collect(WORKSPACE)
    expect(out.items).toEqual([])
    t.dispose()
  })
})

describe("collectDocs", () => {
  beforeEach(() => {
    vi.mocked(vscode.workspace.fs.readFile).mockReset()
  })

  it("emits items for each known doc that exists", async () => {
    const readme = new TextEncoder().encode("# Project\n\nDescribes the project.")
    const claude = new TextEncoder().encode("# Claude rules")
    vi.mocked(vscode.workspace.fs.readFile)
      .mockResolvedValueOnce(readme) // README.md
      .mockResolvedValueOnce(claude) // CLAUDE.md
      .mockRejectedValueOnce({ code: "ENOENT" }) // AGENTS.md
      .mockRejectedValueOnce({ code: "ENOENT" }) // CONTRIBUTING.md
    const out = await collectDocs(WORKSPACE)
    const labels = out.items.map((i) => i.label)
    expect(labels).toEqual(["README.md", "CLAUDE.md"])
  })

  it("returns empty output when no docs exist", async () => {
    vi.mocked(vscode.workspace.fs.readFile).mockRejectedValue({ code: "ENOENT" })
    const out = await collectDocs(WORKSPACE)
    expect(out.items).toEqual([])
  })
})

describe("collectSymbols", () => {
  beforeEach(() => {
    vi.mocked(vscode.commands.executeCommand).mockReset()
  })

  it("emits one item per focus file when symbols are present", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValueOnce([
      {
        name: "Foo",
        kind: vscode.SymbolKind.Class,
        range: { start: { line: 2 } } as unknown as vscode.Range,
        children: [
          {
            name: "bar",
            kind: vscode.SymbolKind.Method,
            range: { start: { line: 5 } } as unknown as vscode.Range,
            children: [],
          },
        ],
      },
    ] as unknown as vscode.DocumentSymbol[])
    const out = await collectSymbols(WORKSPACE, ["src/foo.ts"])
    expect(out.items).toHaveLength(1)
    expect(out.blocks[0].content).toContain("class Foo")
    expect(out.blocks[0].content).toContain("method bar")
  })

  it("returns empty when the symbol provider yields nothing", async () => {
    vi.mocked(vscode.commands.executeCommand).mockResolvedValueOnce(undefined)
    const out = await collectSymbols(WORKSPACE, ["src/foo.ts"])
    expect(out.items).toEqual([])
  })
})
