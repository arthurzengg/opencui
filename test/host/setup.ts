import { vi } from "vitest"

// Mock the vscode module so any test importing host code that does
// `import * as vscode from "vscode"` resolves to a minimal stub. The pure
// helpers we test never call into the API surface — class field initializers
// in ChatView do, but those only run on construction (not on import).
vi.mock("vscode", () => {
  class Position {
    constructor(public line: number, public character: number) {}
  }
  class Range {
    public start: Position
    public end: Position
    constructor(
      startLineOrPos: number | Position,
      startCharOrEndPos: number | Position,
      endLine?: number,
      endChar?: number,
    ) {
      if (typeof startLineOrPos === "number" && typeof startCharOrEndPos === "number") {
        this.start = new Position(startLineOrPos, startCharOrEndPos)
        this.end = new Position(endLine ?? startLineOrPos, endChar ?? startCharOrEndPos)
      } else {
        this.start = startLineOrPos as Position
        this.end = startCharOrEndPos as Position
      }
    }
    isAfter(other: { line: number; character: number } | Range) {
      const o = "start" in other ? other.start : other
      if (this.start.line !== o.line) return this.start.line > o.line
      return this.start.character > o.character
    }
  }
  class Uri {
    private constructor(public scheme: string, public fsPath: string) {}
    static file(p: string) { return new Uri("file", p) }
    static joinPath(uri: Uri, ...parts: string[]) {
      return new Uri(uri.scheme, [uri.fsPath, ...parts].join("/"))
    }
    static parse(value: string) { return new Uri("untitled", value) }
    toString() { return `${this.scheme}://${this.fsPath}` }
  }
  class WorkspaceEdit {
    private edits: Array<{ uri: Uri; range: Range; text: string }> = []
    replace(uri: Uri, range: Range, text: string) { this.edits.push({ uri, range, text }) }
    insert(uri: Uri, position: Position, text: string) {
      this.edits.push({ uri, range: new Range(position, position), text })
    }
    size() { return this.edits.length }
  }
  class MarkdownString {
    public value = ""
    public isTrusted = false
    public supportThemeIcons = false
    appendMarkdown(s: string) { this.value += s; return this }
    appendCodeblock(c: string, _l?: string) { this.value += `\n\`\`\`\n${c}\n\`\`\``; return this }
  }
  class ThemeColor {
    constructor(public id: string) {}
  }
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = []
    event = (l: (e: T) => void) => {
      this.listeners.push(l)
      return { dispose: () => { this.listeners = this.listeners.filter((x) => x !== l) } }
    }
    fire(value: T) { for (const l of this.listeners) l(value) }
    dispose() { this.listeners = [] }
  }
  const stub = {
    Position,
    Range,
    Uri,
    WorkspaceEdit,
    MarkdownString,
    ThemeColor,
    EventEmitter,
    DecorationRangeBehavior: { ClosedClosed: 0, OpenOpen: 1, OpenClosed: 2, ClosedOpen: 3 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    TextEditorRevealType: { Default: 0, InCenterIfOutsideViewport: 2 },
    ViewColumn: { One: 1, Two: 2, Three: 3 },
    workspace: {
      workspaceFolders: [{ uri: Uri.file("/workspace") }],
      getConfiguration: vi.fn(() => ({ get: vi.fn() })),
      openTextDocument: vi.fn(),
      applyEdit: vi.fn().mockResolvedValue(true),
      asRelativePath: vi.fn((uri: Uri | string) => {
        const fsPath = typeof uri === "string" ? uri : uri.fsPath
        return fsPath.replace(/^\/workspace\//, "").replace(/^\/workspace$/, "")
      }),
      fs: {
        stat: vi.fn().mockResolvedValue({}),
        readFile: vi.fn().mockResolvedValue(new Uint8Array()),
      },
      onDidChangeTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
      onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
      onDidCreateFiles: vi.fn(() => ({ dispose: vi.fn() })),
      onDidDeleteFiles: vi.fn(() => ({ dispose: vi.fn() })),
      onDidRenameFiles: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeWorkspaceFolders: vi.fn(() => ({ dispose: vi.fn() })),
    },
    window: {
      activeTextEditor: undefined,
      activeTerminal: undefined,
      visibleTextEditors: [],
      tabGroups: { all: [] as Array<{ tabs: Array<{ input?: unknown }> }> },
      createTerminal: vi.fn(() => ({ show: vi.fn(), sendText: vi.fn(), dispose: vi.fn() })),
      createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })),
      createWebviewPanel: vi.fn(),
      createOutputChannel: vi.fn(() => ({
        append: vi.fn(),
        appendLine: vi.fn(),
        clear: vi.fn(),
        show: vi.fn(),
        hide: vi.fn(),
        dispose: vi.fn(),
        replace: vi.fn(),
        name: "test",
      })),
      registerWebviewViewProvider: vi.fn(),
      onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChangeVisibleTextEditors: vi.fn(() => ({ dispose: vi.fn() })),
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showTextDocument: vi.fn(),
    },
    commands: {
      executeCommand: vi.fn(),
      registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
    },
    languages: {
      registerCodeLensProvider: vi.fn(() => ({ dispose: vi.fn() })),
      getDiagnostics: vi.fn(() => [] as Array<[Uri, unknown[]]>),
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    SymbolKind: {
      File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5,
      Property: 6, Field: 7, Constructor: 8, Enum: 9, Interface: 10,
      Function: 11, Variable: 12, Constant: 13, String: 14, Number: 15,
      Boolean: 16, Array: 17, Object: 18, Key: 19, Null: 20, EnumMember: 21,
      Struct: 22, Event: 23, Operator: 24, TypeParameter: 25,
    },
  }
  return {
    default: stub,
    ...stub,
  }
})
