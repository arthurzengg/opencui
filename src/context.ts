import * as vscode from "vscode"

export type EditorContext = {
  filePath?: string
  relativePath?: string
  selection?: { startLine: number; endLine: number; text: string }
  language?: string
}

export function getEditorContext(): EditorContext {
  const editor = vscode.window.activeTextEditor
  if (!editor) return {}
  const doc = editor.document
  // Only real files carry a usable filesystem path. Non-file editors (Output
  // panels, untitled buffers, diff/virtual docs) expose a URI whose "path" is
  // actually a title like "extension-output-…OpenCode Panel". Surfacing that
  // as the active editor made the symbols collector join it onto the workspace
  // root and ask the language server to read a file that can't exist — noisy
  // (but harmless) under WSL remote, where Uri.file() became a vscode-remote://
  // URI (#230).
  if (doc.uri.scheme !== "file") return {}
  const sel = editor.selection
  const ctx: EditorContext = {
    filePath: doc.uri.fsPath,
    relativePath: vscode.workspace.asRelativePath(doc.uri),
    language: doc.languageId,
  }
  if (!sel.isEmpty) {
    ctx.selection = {
      startLine: sel.start.line + 1,
      endLine: sel.end.line + 1,
      text: doc.getText(sel),
    }
  }
  return ctx
}

export function formatContextHeader(ctx: EditorContext): string {
  if (!ctx.relativePath) return ""
  if (ctx.selection) {
    const { startLine, endLine } = ctx.selection
    return startLine === endLine
      ? `@${ctx.relativePath}#L${startLine}`
      : `@${ctx.relativePath}#L${startLine}-${endLine}`
  }
  return `@${ctx.relativePath}`
}
