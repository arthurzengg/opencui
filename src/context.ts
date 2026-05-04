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
