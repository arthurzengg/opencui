import * as path from "path"
import type {
  Attachment,
  PromptContextManifest,
  PromptContextManifestItem,
  WorkspaceInfo,
} from "../protocol"
import type { OpencodeConfigMode } from "../server"
import type { EditorContext } from "../context"
import { isInsideRoot, type WorkspaceRoot } from "../workspace-root"

export type ManifestInputs = {
  workspace?: WorkspaceRoot
  workspaceInfo?: WorkspaceInfo
  configMode: OpencodeConfigMode
  editor: EditorContext
  mentions?: string[]
  attachments?: Attachment[]
  /**
   * Bytes already read for each mention path, keyed by the same string we use
   * as the mention. Lets the manifest report truncation when the prompt
   * builder hit the per-prompt cap. Phase 4 will populate this consistently
   * with the budget manager — for now the host plugs in mention sizes it
   * already computed in `readMentions`.
   */
  mentionBytes?: Record<string, { included: number; original: number }>
}

/**
 * Build the manifest the host attaches to a `userMessage`. Pure for testing —
 * the builder doesn't read the filesystem itself; the host fills the byte
 * counts before calling.
 */
export function buildManifest(inputs: ManifestInputs): PromptContextManifest {
  const items: PromptContextManifestItem[] = []

  // Active editor — workspace-relative when inside a root, marked external
  // otherwise. Selections are surfaced as a distinct item so the user can
  // see we sent the snippet.
  if (inputs.editor.relativePath || inputs.editor.filePath) {
    const editorItem = makeEditorItem(inputs.workspace, inputs.editor)
    if (editorItem) items.push(editorItem)
  }
  if (inputs.editor.selection) {
    items.push({
      id: itemID("selection"),
      source: "editor",
      kind: "selection",
      label: editorSelectionLabel(inputs.editor),
      path: inputs.editor.relativePath,
      reason: "Active selection in the focused editor",
      status: "included",
      bytes: byteLengthOf(inputs.editor.selection.text),
      priority: 2,
    })
  }

  // Manual mentions — Phase 1's @file flow. Workspace-relative when possible;
  // absolute paths are kept as-is and tagged `external` when outside every
  // open root.
  for (const rel of inputs.mentions ?? []) {
    const item = makeMentionItem(rel, inputs.workspace, inputs.mentionBytes?.[rel])
    items.push(item)
  }

  // Attachments — paperclip flow. The dataURL itself isn't part of the prompt
  // budget (it goes as a separate `parts[]` entry to opencode), but we still
  // surface bytes so the user sees the size and we mark a `sourcePath` as
  // external when it lives outside the workspace.
  for (const attachment of inputs.attachments ?? []) {
    items.push(makeAttachmentItem(attachment, inputs.workspace))
  }

  const totals = computeTotals(items)
  return {
    version: 1,
    workspace: inputs.workspaceInfo,
    opencode: {
      directory: inputs.workspace?.fsPath,
      configMode: inputs.configMode,
    },
    totals,
    items,
  }
}

function makeEditorItem(
  workspace: WorkspaceRoot | undefined,
  editor: EditorContext,
): PromptContextManifestItem | undefined {
  const filePath = editor.filePath
  if (!filePath) {
    // `relativePath` without `filePath` only happens for synthetic editor
    // contexts (e.g. untitled docs). We still want to record the label.
    if (!editor.relativePath) return undefined
    return {
      id: itemID("editor"),
      source: "editor",
      kind: "file",
      label: editor.relativePath,
      path: editor.relativePath,
      reason: "Currently focused editor",
      status: "included",
      priority: 6,
    }
  }
  const external = !workspace || !isInsideRoot(workspace, filePath)
  return {
    id: itemID("editor"),
    source: external ? "external" : "editor",
    kind: "file",
    label: editor.relativePath ?? path.basename(filePath),
    path: external ? filePath : editor.relativePath,
    root: workspace?.fsPath,
    reason: external
      ? "Active editor is outside the workspace; surfaced as external context"
      : "Currently focused editor",
    status: "included",
    external,
    priority: 6,
  }
}

function makeMentionItem(
  rel: string,
  workspace: WorkspaceRoot | undefined,
  bytes: { included: number; original: number } | undefined,
): PromptContextManifestItem {
  const absolute = path.isAbsolute(rel)
  const external = absolute && (!workspace || !isInsideRoot(workspace, rel))
  const status: PromptContextManifestItem["status"] =
    bytes && bytes.included < bytes.original ? "truncated" : "included"
  return {
    id: itemID("mention"),
    source: external ? "external" : "mention",
    kind: "file",
    label: rel,
    path: rel,
    root: external ? undefined : workspace?.fsPath,
    reason: external
      ? "Manually mentioned file outside the workspace"
      : "Manually mentioned file (@-picker)",
    status,
    bytes: bytes?.included,
    external,
    priority: 1,
  }
}

function makeAttachmentItem(
  attachment: Attachment,
  workspace: WorkspaceRoot | undefined,
): PromptContextManifestItem {
  const external =
    attachment.sourcePath != null &&
    (!workspace || !isInsideRoot(workspace, attachment.sourcePath))
  return {
    id: itemID("attachment"),
    source: "attachment",
    kind: "file",
    label: attachment.filename,
    path: attachment.sourcePath ?? attachment.filename,
    root: external ? undefined : workspace?.fsPath,
    reason: external
      ? "Attachment from outside the workspace"
      : "Attachment via the paperclip flow",
    status: "included",
    bytes: attachment.bytes,
    external,
    priority: 3,
  }
}

function computeTotals(items: PromptContextManifestItem[]) {
  let includedItems = 0
  let skippedItems = 0
  let truncatedItems = 0
  let includedBytes = 0
  for (const item of items) {
    if (item.status === "included") includedItems += 1
    else if (item.status === "truncated") {
      includedItems += 1
      truncatedItems += 1
    } else if (item.status === "skipped") skippedItems += 1
    if (item.bytes && (item.status === "included" || item.status === "truncated")) {
      includedBytes += item.bytes
    }
  }
  return { includedItems, skippedItems, truncatedItems, includedBytes, budgetBytes: 0 }
}

function editorSelectionLabel(editor: EditorContext): string {
  const sel = editor.selection
  if (!sel) return editor.relativePath ?? "selection"
  const base = editor.relativePath ?? "selection"
  return sel.startLine === sel.endLine
    ? `${base}#L${sel.startLine}`
    : `${base}#L${sel.startLine}-${sel.endLine}`
}

function byteLengthOf(text: string): number {
  if (typeof Buffer !== "undefined") return Buffer.byteLength(text, "utf8")
  return new TextEncoder().encode(text).byteLength
}

let counter = 0
function itemID(prefix: string): string {
  counter += 1
  return `${prefix}_${counter}`
}
