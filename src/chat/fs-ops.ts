import * as vscode from "vscode"
import * as path from "path"
import type { ReviewChange, ReviewHunkState } from "../protocol"
import { stripWorkspaceFolderPrefix, normalizePath } from "./paths"
import { findHunkInFile, findHunkText, type ReviewDiffHunk } from "./diff"

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

export async function openFile(relPath: string, root?: string) {
  const doc = await openFileDocument(relPath, root)
  await vscode.window.showTextDocument(doc)
}

export async function openFileDocument(relPath: string, root?: string) {
  const uri = await workspaceFileUri(relPath, root)
  return vscode.workspace.openTextDocument(uri)
}

export function visibleReviewDocument(relPath: string) {
  const uris = new Set(workspaceFileUriCandidates(relPath).map(({ uri }) => uri.toString()))
  return vscode.window.visibleTextEditors.find((editor) => uris.has(editor.document.uri.toString()))?.document
}

export async function workspaceFileUri(relPath: string, root?: string) {
  const existing = await existingWorkspaceFileUri(relPath, root)
  if (existing) return existing
  const candidates = workspaceFileUriCandidates(relPath, root)
  return candidates.find((c) => c.preferIfMissing)?.uri ?? candidates[0]?.uri ?? vscode.Uri.file(relPath)
}

export async function existingWorkspaceFileUri(relPath: string, root?: string): Promise<vscode.Uri | undefined> {
  for (const { uri } of workspaceFileUriCandidates(relPath, root)) {
    try {
      await vscode.workspace.fs.stat(uri)
      return uri
    } catch {
      // Try the next plausible base.
    }
  }
  return undefined
}

export async function reviewPathExists(relPath: string, root?: string): Promise<boolean> {
  return !!(await existingWorkspaceFileUri(relPath, root))
}

/**
 * Resolve `relPath` against either:
 *   - the explicit `root` hint (when the host has the opencode `backend.directory` —
 *     ALL changes from one session share this root, so the hint disambiguates
 *     between VS Code workspace folders that happen to contain identically-named
 *     files), or
 *   - every workspace folder, in order, as the fallback.
 *
 * Passing `root` is what keeps multi-root setups from accidentally targeting
 * the wrong copy of `src/index.ts` when both root A and root B have one.
 */
export function workspaceFileUriCandidates(
  relPath: string,
  root?: string,
): Array<{ uri: vscode.Uri; preferIfMissing?: boolean }> {
  if (path.isAbsolute(relPath)) return [{ uri: vscode.Uri.file(relPath) }]
  const normalized = normalizePath(relPath)
  const candidates: Array<{ uri: vscode.Uri; preferIfMissing?: boolean }> = []
  const seen = new Set<string>()
  const add = (uri: vscode.Uri, preferIfMissing = false) => {
    const key = uri.toString()
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ uri, preferIfMissing })
  }
  if (root) {
    // Anchor to the opencode backend's directory first — this is the
    // unambiguous answer for any change produced in that session.
    const rootUri = vscode.Uri.file(root)
    add(joinUriPath(rootUri, normalized))
    const stripped = stripWorkspaceFolderPrefix(root, normalized)
    if (stripped) add(joinUriPath(rootUri, stripped), true)
  }
  const workspaces = vscode.workspace.workspaceFolders ?? []
  if (!workspaces.length && !candidates.length) return [{ uri: vscode.Uri.file(relPath) }]
  for (const ws of workspaces) {
    add(joinUriPath(ws.uri, normalized))
    const stripped = stripWorkspaceFolderPrefix(ws.uri.fsPath, normalized)
    if (stripped) add(joinUriPath(ws.uri, stripped), true)
  }
  if (!candidates.length) return [{ uri: vscode.Uri.file(relPath) }]
  return candidates
}

function joinUriPath(base: vscode.Uri, relPath: string) {
  return vscode.Uri.joinPath(base, ...relPath.split("/").filter(Boolean))
}

export type ReviewHunkOutcome =
  | { status: "applied" }
  | { status: "no-op"; reason: string }
  | { status: "conflict"; reason: string }
  | { status: "missing"; reason: string }
  | { status: "unsupported"; reason: string }

/**
 * Execute Keep or Undo for one hunk of one change. Replaces the old
 * `reviewHunk(path, action, oldText, newText)` API; callers now hand over the
 * full `change` + `hunk` so we can:
 *
 *   - Distinguish create / delete / move / update kinds and undo each safely
 *     (creating files come back via fs.delete; deleting come back via fs.write
 *     with the original content).
 *   - Anchor undo on the hunk's `+A,B` line numbers, preventing the
 *     "identical text blocks → wrong occurrence got modified" failure mode
 *     that the old `current.indexOf(newText)` implementation had.
 *   - Verify Keep against the expected post-change state — if the file has
 *     drifted (user edited it, another tool clobbered it) we surface a
 *     conflict instead of silently accepting and dropping the row from the
 *     review card.
 *
 * Returns a structured outcome. The caller decides whether to record the
 * hunk as `accepted` / `rejected` only when the action actually landed; on
 * conflict we leave the row pending and surface a warning so the user can
 * inspect.
 */
export async function reviewHunk(
  change: ReviewChange,
  hunk: ReviewDiffHunk,
  action: ReviewHunkState,
  options: { silent?: boolean; root?: string } = {},
): Promise<ReviewHunkOutcome> {
  const { silent = false, root } = options
  if (action === "accepted") return acceptHunk(change, hunk, root, silent)
  return undoHunk(change, hunk, root, silent)
}

async function acceptHunk(
  change: ReviewChange,
  hunk: ReviewDiffHunk,
  root: string | undefined,
  silent: boolean,
): Promise<ReviewHunkOutcome> {
  // Keep is a verification: confirm the file is in the expected post-change
  // state. We don't mutate anything — opencode already applied the change.
  if (change.kind === "created") {
    const exists = await reviewPathExists(change.path, root)
    if (!exists) {
      return reportConflict(change.path, `${change.path} was created but is no longer present.`, silent)
    }
    return { status: "applied" }
  }
  if (change.kind === "deleted") {
    const exists = await reviewPathExists(change.path, root)
    if (exists) {
      return reportConflict(change.path, `${change.path} was deleted but still exists.`, silent)
    }
    return { status: "applied" }
  }
  const existing = await existingWorkspaceFileUri(change.path, root)
  if (!existing) {
    return reportMissing(change.path, `${change.path} is no longer present.`, silent)
  }
  // For an update / move, the expected newText should be locatable at the
  // hunk's anchor line. If it isn't, the file has drifted — surface that
  // rather than silently marking the hunk accepted.
  const doc = await vscode.workspace.openTextDocument(existing)
  const located = findHunkInFile(doc.getText(), hunk)
  if (!located) {
    return reportConflict(
      change.path,
      `Cannot confirm changes in ${change.path}: the file has been modified since.`,
      silent,
    )
  }
  return { status: "applied" }
}

async function undoHunk(
  change: ReviewChange,
  hunk: ReviewDiffHunk,
  root: string | undefined,
  silent: boolean,
): Promise<ReviewHunkOutcome> {
  if (!hunk.reversible) {
    return reportUnsupported(
      change.path,
      `Cannot undo ${change.path}: the diff did not provide a parseable hunk header.`,
      silent,
    )
  }
  if (change.kind === "created") {
    return undoCreate(change, root, silent)
  }
  if (change.kind === "deleted") {
    return undoDelete(change, hunk, root, silent)
  }
  if (change.kind === "moved") {
    return undoMove(change, hunk, root, silent)
  }
  return undoUpdate(change, hunk, root, silent)
}

async function undoCreate(
  change: ReviewChange,
  root: string | undefined,
  silent: boolean,
): Promise<ReviewHunkOutcome> {
  const existing = await existingWorkspaceFileUri(change.path, root)
  if (!existing) {
    // Nothing to undo — file already gone (e.g. user manually removed it).
    return { status: "no-op", reason: `${change.path} is already absent.` }
  }
  try {
    await vscode.workspace.fs.delete(existing, { useTrash: false })
    return { status: "applied" }
  } catch (e) {
    return reportConflict(
      change.path,
      `Could not delete ${change.path}: ${(e as Error).message ?? "unknown error"}.`,
      silent,
    )
  }
}

async function undoDelete(
  change: ReviewChange,
  hunk: ReviewDiffHunk,
  root: string | undefined,
  silent: boolean,
): Promise<ReviewHunkOutcome> {
  if (!hunk.oldText && !hunk.newText) {
    return reportUnsupported(
      change.path,
      `Cannot restore ${change.path}: original content is not available in the diff.`,
      silent,
    )
  }
  // If the file is back already, leave it alone — surface conflict instead of
  // clobbering whatever's there now.
  const existing = await existingWorkspaceFileUri(change.path, root)
  if (existing) {
    return reportConflict(
      change.path,
      `Cannot restore ${change.path}: a file at that path already exists.`,
      silent,
    )
  }
  const uri = await workspaceFileUri(change.path, root)
  try {
    const data = new TextEncoder().encode(hunk.oldText)
    await vscode.workspace.fs.writeFile(uri, data)
    return { status: "applied" }
  } catch (e) {
    return reportConflict(
      change.path,
      `Could not restore ${change.path}: ${(e as Error).message ?? "unknown error"}.`,
      silent,
    )
  }
}

async function undoMove(
  change: ReviewChange,
  hunk: ReviewDiffHunk,
  root: string | undefined,
  silent: boolean,
): Promise<ReviewHunkOutcome> {
  if (!change.oldPath) {
    return reportUnsupported(
      change.path,
      `Cannot undo move of ${change.path}: original path not recorded.`,
      silent,
    )
  }
  const fromUri = await existingWorkspaceFileUri(change.path, root)
  if (!fromUri) {
    return reportMissing(change.path, `${change.path} is no longer present; cannot move back.`, silent)
  }
  const toExisting = await existingWorkspaceFileUri(change.oldPath, root)
  if (toExisting) {
    return reportConflict(
      change.oldPath,
      `Cannot restore move target: ${change.oldPath} already exists.`,
      silent,
    )
  }
  const toUri = await workspaceFileUri(change.oldPath, root)
  try {
    await vscode.workspace.fs.rename(fromUri, toUri, { overwrite: false })
    // If the move was accompanied by edits, restore the old content too.
    if (hunk.oldText) {
      const data = new TextEncoder().encode(hunk.oldText)
      await vscode.workspace.fs.writeFile(toUri, data)
    }
    return { status: "applied" }
  } catch (e) {
    return reportConflict(
      change.path,
      `Could not undo move of ${change.path}: ${(e as Error).message ?? "unknown error"}.`,
      silent,
    )
  }
}

async function undoUpdate(
  change: ReviewChange,
  hunk: ReviewDiffHunk,
  root: string | undefined,
  silent: boolean,
): Promise<ReviewHunkOutcome> {
  const existing = await existingWorkspaceFileUri(change.path, root)
  if (!existing) {
    return reportMissing(change.path, `${change.path} is no longer present.`, silent)
  }
  const doc = await vscode.workspace.openTextDocument(existing)
  const current = doc.getText()
  const located = findHunkInFile(current, hunk)
  if (!located) {
    return reportConflict(
      change.path,
      `Could not undo a hunk in ${change.path}: the file has changed since the edit was produced.`,
      silent,
    )
  }
  const edit = new vscode.WorkspaceEdit()
  edit.replace(
    existing,
    new vscode.Range(doc.positionAt(located.start), doc.positionAt(located.end)),
    hunk.oldText,
  )
  const ok = await vscode.workspace.applyEdit(edit)
  if (!ok) {
    return reportConflict(change.path, `Could not undo hunk in ${change.path}.`, silent)
  }
  // Reveal the file so the user sees the revert immediately; previous behavior.
  await vscode.window.showTextDocument(doc)
  return { status: "applied" }
}

function reportConflict(p: string, reason: string, silent: boolean): ReviewHunkOutcome {
  if (!silent) vscode.window.showWarningMessage(`OpenCode Panel: ${reason}`)
  return { status: "conflict", reason }
}

function reportMissing(p: string, reason: string, silent: boolean): ReviewHunkOutcome {
  if (!silent) vscode.window.showWarningMessage(`OpenCode Panel: ${reason}`)
  return { status: "missing", reason }
}

function reportUnsupported(p: string, reason: string, silent: boolean): ReviewHunkOutcome {
  if (!silent) vscode.window.showWarningMessage(`OpenCode Panel: ${reason}`)
  return { status: "unsupported", reason }
}

// Re-export `findHunkText` for any callers that still want the legacy
// 2-argument signature (notably tests).
export { findHunkText }
