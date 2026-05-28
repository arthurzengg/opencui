import { describe, it, expect, beforeEach } from "vitest"
import * as vscode from "vscode"
import { getEditorContext, formatContextHeader } from "../../src/context"

type FakeSelection = {
  isEmpty: boolean
  start: { line: number }
  end: { line: number }
}
type FakeEditor = {
  document: {
    uri: { fsPath: string; scheme: string }
    languageId: string
    getText: (sel: FakeSelection) => string
  }
  selection: FakeSelection
}
type MutableWindow = { activeTextEditor?: FakeEditor }
const win = vscode.window as unknown as MutableWindow

const EMPTY_SELECTION: FakeSelection = {
  isEmpty: true,
  start: { line: 0 },
  end: { line: 0 },
}

function setActive(uri: { fsPath: string; scheme: string } | undefined, selection = EMPTY_SELECTION) {
  win.activeTextEditor = uri
    ? {
        document: {
          uri,
          languageId: "typescript",
          getText: () => "selected text",
        },
        selection,
      }
    : undefined
}

describe("getEditorContext", () => {
  beforeEach(() => {
    setActive(undefined)
  })

  it("returns empty context when there is no active editor", () => {
    expect(getEditorContext()).toEqual({})
  })

  it("reports file path, relative path, and language for a real file", () => {
    setActive({ fsPath: "/workspace/src/foo.ts", scheme: "file" })
    expect(getEditorContext()).toEqual({
      filePath: "/workspace/src/foo.ts",
      relativePath: "src/foo.ts",
      language: "typescript",
    })
  })

  it("captures a non-empty selection on a real file", () => {
    setActive({ fsPath: "/workspace/src/foo.ts", scheme: "file" }, {
      isEmpty: false,
      start: { line: 4 },
      end: { line: 8 },
    })
    expect(getEditorContext().selection).toEqual({
      startLine: 5,
      endLine: 9,
      text: "selected text",
    })
  })

  // #230: when the OpenCode Panel Output view is focused it is the active
  // "text editor", but its URI scheme is `output` and the path is the channel
  // title. Treating that as a file made the symbols collector read a bogus
  // path. Non-file editors must produce no editor context at all.
  it("ignores the Output panel (scheme `output`)", () => {
    setActive({
      fsPath: "/extension-output-haoyangzeng.opencui-#1-OpenCode Panel",
      scheme: "output",
    })
    expect(getEditorContext()).toEqual({})
  })

  it("ignores untitled buffers (scheme `untitled`)", () => {
    setActive({ fsPath: "/Untitled-1", scheme: "untitled" })
    expect(getEditorContext()).toEqual({})
  })

  it("renders no context header for a non-file editor", () => {
    setActive({ fsPath: "/whatever", scheme: "output" })
    expect(formatContextHeader(getEditorContext())).toBe("")
  })
})
