import * as vscode from "vscode"
import * as path from "path"
import type { ReviewHunkState } from "../protocol"
import { stripWorkspaceFolderPrefix, normalizePath } from "./paths"
import { findHunkText } from "./diff"

const SHELL_LANGS = new Set([
  "bash", "sh", "shell", "shellscript", "zsh", "fish", "powershell", "ps", "ps1", "bat", "cmd",
])

/**
 * Apply a code snippet from the chat into the editor:
 *   - shell snippets go to the integrated terminal (`Apply` on a `npm start`
 *     block belongs in a terminal, not a file).
 *   - everything else replaces the active editor's selection (or whole file
 *     when the selection is empty). Cmd+Z to revert.
 */
export async function applyCode(code: string, language?: string) {
  if (language && SHELL_LANGS.has(language.toLowerCase())) {
    const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal({ name: "OpenCode Panel" })
    terminal.show(true)
    terminal.sendText(code.replace(/\n+$/, ""), true)
    return
  }
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showWarningMessage("OpenCode Panel: open a file first to apply this snippet")
    return
  }
  const doc = editor.document
  const target = editor.selection.isEmpty
    ? new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
    : editor.selection
  const edit = new vscode.WorkspaceEdit()
  edit.replace(doc.uri, target, code)
  await vscode.workspace.applyEdit(edit)
}

export async function openFile(relPath: string) {
  const doc = await openFileDocument(relPath)
  await vscode.window.showTextDocument(doc)
}

export async function openFileDocument(relPath: string) {
  const uri = await workspaceFileUri(relPath)
  return vscode.workspace.openTextDocument(uri)
}

export function visibleReviewDocument(relPath: string) {
  const uris = new Set(workspaceFileUriCandidates(relPath).map(({ uri }) => uri.toString()))
  return vscode.window.visibleTextEditors.find((editor) => uris.has(editor.document.uri.toString()))?.document
}

export async function workspaceFileUri(relPath: string) {
  const existing = await existingWorkspaceFileUri(relPath)
  if (existing) return existing
  const candidates = workspaceFileUriCandidates(relPath)
  return candidates.find((c) => c.preferIfMissing)?.uri ?? candidates[0]?.uri ?? vscode.Uri.file(relPath)
}

export async function existingWorkspaceFileUri(relPath: string): Promise<vscode.Uri | undefined> {
  for (const { uri } of workspaceFileUriCandidates(relPath)) {
    try {
      await vscode.workspace.fs.stat(uri)
      return uri
    } catch {
      // Try the next plausible base.
    }
  }
  return undefined
}

export async function reviewPathExists(relPath: string): Promise<boolean> {
  return !!(await existingWorkspaceFileUri(relPath))
}

export function workspaceFileUriCandidates(relPath: string): Array<{ uri: vscode.Uri; preferIfMissing?: boolean }> {
  if (path.isAbsolute(relPath)) return [{ uri: vscode.Uri.file(relPath) }]
  const normalized = normalizePath(relPath)
  const workspaces = vscode.workspace.workspaceFolders ?? []
  if (!workspaces.length) return [{ uri: vscode.Uri.file(relPath) }]
  const candidates: Array<{ uri: vscode.Uri; preferIfMissing?: boolean }> = []
  const seen = new Set<string>()
  const add = (uri: vscode.Uri, preferIfMissing = false) => {
    const key = uri.toString()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ uri, preferIfMissing })
  }
  for (const ws of workspaces) {
    add(joinUriPath(ws.uri, normalized))
    const stripped = stripWorkspaceFolderPrefix(ws.uri.fsPath, normalized)
    if (stripped) add(joinUriPath(ws.uri, stripped), true)
  }
  return candidates
}

function joinUriPath(base: vscode.Uri, relPath: string) {
  return vscode.Uri.joinPath(base, ...relPath.split("/").filter(Boolean))
}

/**
 * Apply or revert a single review hunk in `relPath`. For "accepted" we just
 * mark it (no file change — opencode already applied it). For "rejected" we
 * locate `newText` in the current file content and replace it with `oldText`.
 */
export async function reviewHunk(
  relPath: string,
  action: ReviewHunkState,
  oldText: string,
  newText: string,
  silent = false,
): Promise<boolean> {
  if (action === "accepted") return true
  const uri = await workspaceFileUri(relPath)
  const doc = await vscode.workspace.openTextDocument(uri)
  const current = doc.getText()
  const match = findHunkText(current, newText)
  if (!match) {
    if (!silent) {
      vscode.window.showWarningMessage(`OpenCode Panel: could not undo hunk in ${relPath}; the file changed since the diff was generated.`)
      await vscode.window.showTextDocument(doc)
    }
    return false
  }
  const edit = new vscode.WorkspaceEdit()
  edit.replace(uri, new vscode.Range(doc.positionAt(match.start), doc.positionAt(match.end)), oldText)
  const ok = await vscode.workspace.applyEdit(edit)
  if (!ok) {
    if (!silent) vscode.window.showWarningMessage(`OpenCode Panel: could not undo hunk in ${relPath}`)
    return false
  }
  await vscode.window.showTextDocument(doc)
  return true
}
