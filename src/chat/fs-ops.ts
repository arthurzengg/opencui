import * as vscode from "vscode"
import * as path from "path"
import * as os from "os"
import type { ReviewChange, ReviewHunkState } from "../protocol"
import { stripWorkspaceFolderPrefix } from "./paths"
import { normalizePath } from "../../webview/src/review-extract"
import { findHunkInFile, findHunkText, type ReviewDiffHunk } from "./diff"
import { log } from "../output"

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

/**
 * Show `doc` unless its editor is already the active one — `showTextDocument`
 * pulls focus out of the chat panel and flashes the editor pane, so re-showing
 * what the user is already looking at is pure noise. Every review action routes
 * its reveal through here: "Undo all in file" calls the hunk runner once per
 * hunk per per-tool record, and without the guard each of those N calls yanked
 * focus again.
 */
export async function revealDocument(
  doc: vscode.TextDocument,
  options?: vscode.TextDocumentShowOptions,
) {
  if (vscode.window.activeTextEditor?.document.uri.toString() === doc.uri.toString()) return
  await vscode.window.showTextDocument(doc, options)
}

export async function workspaceFileUri(relPath: string, root?: string) {
  const existing = await existingWorkspaceFileUri(relPath, root)
  if (existing) return existing
  const candidates = workspaceFileUriCandidates(relPath, root)
  return candidates.find((c) => c.preferIfMissing)?.uri ?? candidates[0]?.uri ?? vscode.Uri.file(relPath)
}

export async function existingWorkspaceFileUri(relPath: string, root?: string): Promise<vscode.Uri | undefined> {
  return (await findExistingWorkspaceFile(relPath, root)).uri
}

/**
 * Find a file by trying the workspace candidates first, then by walking
 * ancestor directories of `root` if the standard candidates miss. The
 * ancestor walk handles a real case: opencode reports `relativePath`
 * anchored to a directory ABOVE the VS Code workspace (e.g. a git worktree
 * root or the user's home), so joining against the workspace alone produces
 * malformed paths and stat fails even though the file exists. The walk
 * stops at the user's home directory when `root` is under home, otherwise
 * at the filesystem root.
 *
 * `..` segments in `relPath` skip the ancestor fallback — a model emitting
 * `../../etc/passwd` should never escape via this code.
 *
 * Returns the matched URI plus the list of paths we attempted, for
 * logging on misses.
 */
export async function findExistingWorkspaceFile(
  relPath: string,
  root?: string,
  options: { home?: string; preferAbsolute?: string } = {},
): Promise<{ uri?: vscode.Uri; tried: string[] }> {
  const tried: string[] = []
  // Opencode-reported absolute path (when available, e.g. apply_patch's
  // `files[].absolutePath`) is the unambiguous resolution — try it first
  // before falling through to the workspace candidates.
  if (options.preferAbsolute && path.isAbsolute(options.preferAbsolute)) {
    const uri = vscode.Uri.file(options.preferAbsolute)
    tried.push(uri.fsPath)
    try {
      await vscode.workspace.fs.stat(uri)
      return { uri, tried }
    } catch {
      // continue
    }
  }
  for (const { uri } of workspaceFileUriCandidates(relPath, root)) {
    if (tried.includes(uri.fsPath)) continue
    tried.push(uri.fsPath)
    try {
      await vscode.workspace.fs.stat(uri)
      return { uri, tried }
    } catch {
      // continue
    }
  }
  if (!path.isAbsolute(relPath) && !hasParentSegment(relPath) && root) {
    const home = options.home ?? os.homedir()
    for (const ancestor of ancestorRoots(root, home)) {
      const uri = vscode.Uri.file(path.join(ancestor, normalizePath(relPath)))
      if (tried.includes(uri.fsPath)) continue
      tried.push(uri.fsPath)
      try {
        await vscode.workspace.fs.stat(uri)
        return { uri, tried }
      } catch {
        // continue
      }
    }
  }
  return { tried }
}

function hasParentSegment(relPath: string): boolean {
  return normalizePath(relPath).split("/").some((seg) => seg === "..")
}

function ancestorRoots(root: string, home: string): string[] {
  const resolved = path.resolve(root)
  const result: string[] = []
  let current = path.dirname(resolved)
  while (current && current !== path.dirname(current)) {
    result.push(current)
    if (current === home) break
    current = path.dirname(current)
  }
  return result
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
    const { uri, tried } = await findExistingWorkspaceFile(change.path, root, { preferAbsolute: change.absolutePath })
    if (!uri) {
      return reportConflict(change.path, `${change.path} was created but is no longer present.`, silent, tried)
    }
    return { status: "applied" }
  }
  if (change.kind === "deleted") {
    const { uri, tried } = await findExistingWorkspaceFile(change.path, root, { preferAbsolute: change.absolutePath })
    if (uri) {
      return reportConflict(change.path, `${change.path} was deleted but still exists.`, silent, tried)
    }
    return { status: "applied" }
  }
  const { uri: existing, tried } = await findExistingWorkspaceFile(change.path, root, { preferAbsolute: change.absolutePath })
  if (!existing) {
    return reportMissing(change.path, `${change.path} is no longer present.`, silent, tried)
  }
  // For an update / move, the expected newText should be locatable at the
  // hunk's anchor line. If it isn't, the file has drifted — surface that
  // rather than silently marking the hunk accepted.
  const doc = await vscode.workspace.openTextDocument(existing)
  const text = doc.getText()
  // Pure-deletion hunks need a different check: `findHunkInFile` returns a
  // zero-width match at the anchor for `newText === ""`, which would let
  // Keep silently succeed even when the deletion was reverted. Verify by
  // asserting the removed block is no longer anywhere in the file.
  if (hunk.newText === "" && hunk.oldText !== "") {
    if (text.includes(hunk.oldText)) {
      return reportConflict(
        change.path,
        `Cannot confirm deletion in ${change.path}: the removed lines are still present.`,
        silent,
      )
    }
    return { status: "applied" }
  }
  const located = findHunkInFile(text, hunk)
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
  const { uri: existing } = await findExistingWorkspaceFile(change.path, root, { preferAbsolute: change.absolutePath })
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
      `Cannot restore ${change.path}: original content is not available in the diff.`,
      silent,
    )
  }
  // If the file is back already, leave it alone — surface conflict instead of
  // clobbering whatever's there now.
  const { uri: existing } = await findExistingWorkspaceFile(change.path, root, { preferAbsolute: change.absolutePath })
  if (existing) {
    return reportConflict(
      change.path,
      `Cannot restore ${change.path}: a file at that path already exists.`,
      silent,
    )
  }
  const uri = await workspaceFileUri(change.path, root)
  try {
    const data = new TextEncoder().encode(restoredFileContent(hunk))
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

/**
 * Whole-file content to write when restoring a deleted file. `hunk.oldText` is
 * newline-JOINED, so the terminator the original file ended with is not in it —
 * and a unified diff only ever records the ABSENCE of one, as a `\ No newline
 * at end of file` marker. Writing `oldText` raw therefore stripped the final
 * newline off every restored file, which git then reported as a real change to
 * a file we claimed to have put back untouched.
 */
function restoredFileContent(hunk: ReviewDiffHunk): string {
  if (!hunk.oldText || hunk.oldNoNewlineAtEof) return hunk.oldText
  return `${hunk.oldText}\n`
}

async function undoMove(
  change: ReviewChange,
  hunk: ReviewDiffHunk,
  root: string | undefined,
  silent: boolean,
): Promise<ReviewHunkOutcome> {
  if (!change.oldPath) {
    return reportUnsupported(
      `Cannot undo move of ${change.path}: original path not recorded.`,
      silent,
    )
  }
  const { uri: fromUri } = await findExistingWorkspaceFile(change.path, root, { preferAbsolute: change.absolutePath })
  const restored = await existingWorkspaceFileUri(change.oldPath, root)
  if (fromUri) {
    if (restored) {
      return reportConflict(
        change.oldPath,
        `Cannot restore move target: ${change.oldPath} already exists.`,
        silent,
      )
    }
    const toUri = await workspaceFileUri(change.oldPath, root)
    try {
      await vscode.workspace.fs.rename(fromUri, toUri, { overwrite: false })
    } catch (e) {
      return reportConflict(
        change.path,
        `Could not undo move of ${change.path}: ${(e as Error).message ?? "unknown error"}.`,
        silent,
      )
    }
  } else if (!restored) {
    return reportMissing(change.path, `${change.path} is no longer present; cannot move back.`, silent)
  }
  // else: an earlier hunk of this move already renamed the file back — only
  // this hunk's content revert remains.

  if (!hunk.oldText && !hunk.newText) {
    return { status: "applied" }
  }
  // Revert the edits carried by the move with the same ranged replace as a
  // plain update. Writing `hunk.oldText` as the whole file (the previous
  // behavior) truncated everything outside the hunk — oldText is one hunk's
  // fragment, not the original file.
  return undoUpdate({ ...change, path: change.oldPath, absolutePath: undefined }, hunk, root, silent)
}

async function undoUpdate(
  change: ReviewChange,
  hunk: ReviewDiffHunk,
  root: string | undefined,
  silent: boolean,
): Promise<ReviewHunkOutcome> {
  const { uri: existing, tried } = await findExistingWorkspaceFile(change.path, root, { preferAbsolute: change.absolutePath })
  if (!existing) {
    return reportMissing(change.path, `${change.path} is no longer present.`, silent, tried)
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
  // A zero-width match means we're re-inserting a deleted block at a line
  // boundary. `hunk.oldText` is newline-JOINED (no trailing separator), so
  // add the one the join dropped: trailing mid-file, leading when appending
  // to a file that doesn't end in a newline.
  let restored = hunk.oldText
  if (located.start === located.end) {
    if (located.start < current.length) restored = `${restored}\n`
    else if (current.length > 0 && !current.endsWith("\n")) restored = `\n${restored}`
  }
  const edit = new vscode.WorkspaceEdit()
  edit.replace(
    existing,
    new vscode.Range(doc.positionAt(located.start), doc.positionAt(located.end)),
    restored,
  )
  const ok = await vscode.workspace.applyEdit(edit)
  if (!ok) {
    return reportConflict(change.path, `Could not undo hunk in ${change.path}.`, silent)
  }
  // Reveal the file so the user sees the revert immediately; previous behavior.
  await revealDocument(doc)
  return { status: "applied" }
}

function reportConflict(p: string, reason: string, silent: boolean, tried?: string[]): ReviewHunkOutcome {
  if (!silent) vscode.window.showWarningMessage(`OpenCode Panel: ${reason}`)
  if (tried && tried.length > 0) {
    log(`reviewHunk conflict on ${p}: ${reason} (tried: ${tried.join(", ")})`)
  }
  return { status: "conflict", reason }
}

function reportMissing(p: string, reason: string, silent: boolean, tried?: string[]): ReviewHunkOutcome {
  if (!silent) vscode.window.showWarningMessage(`OpenCode Panel: ${reason}`)
  if (tried && tried.length > 0) {
    log(`reviewHunk missing on ${p}: ${reason} (tried: ${tried.join(", ")})`)
  }
  return { status: "missing", reason }
}

function reportUnsupported(reason: string, silent: boolean): ReviewHunkOutcome {
  if (!silent) vscode.window.showWarningMessage(`OpenCode Panel: ${reason}`)
  return { status: "unsupported", reason }
}

// Re-export `findHunkText` for any callers that still want the legacy
// 2-argument signature (notably tests).
export { findHunkText }
