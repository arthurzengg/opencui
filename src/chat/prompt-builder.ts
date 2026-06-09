import * as vscode from "vscode"
import * as path from "path"
import type { getEditorContext } from "../context"
import type { ChatMessage } from "../protocol"
import type { WorkspaceRoot } from "../workspace-root"
import type { PromptContextBlock } from "../workspace-context/types"
import { log } from "../output"
import { stripWorkspaceFolderPrefix } from "./paths"

export const DEFAULT_MENTION_MAX_BYTES = 200_000
export const DEFAULT_CONVERSATION_MAX_BYTES = 100_000
const MENTION_MAX_FILES = 20
const CONVERSATION_MAX_MESSAGES = 29

export function buildPrompt(
  userText: string,
  ctx: ReturnType<typeof getEditorContext>,
  mentionBlock?: string,
  workspace?: WorkspaceRoot,
  autoBlocks?: PromptContextBlock[],
): string {
  const lines: string[] = []
  if (workspace) {
    lines.push("Workspace:")
    lines.push(`- Name: ${workspace.name}`)
    lines.push(`- Root: ${workspace.fsPath}`)
    lines.push("- Paths below are workspace-relative unless marked absolute.")
    lines.push("")
  }
  if (mentionBlock) {
    lines.push(mentionBlock)
    lines.push("")
  }
  if (ctx.relativePath) {
    lines.push(`Context: ${ctx.relativePath}`)
    if (ctx.selection) {
      lines.push(`Selection (lines ${ctx.selection.startLine}-${ctx.selection.endLine}):`)
      lines.push("```" + (ctx.language ?? ""))
      lines.push(ctx.selection.text)
      lines.push("```")
    }
    lines.push("")
  }
  if (autoBlocks && autoBlocks.length > 0) {
    // Lowest-priority-number first so the most useful blocks land near the
    // user request and the noisier hints (symbols, recent edits) sit higher.
    const sorted = [...autoBlocks].sort((a, b) => a.priority - b.priority)
    for (const block of sorted) {
      lines.push(`## ${block.title}`)
      if (block.path && block.language) {
        lines.push("```" + block.language)
        lines.push(block.content)
        lines.push("```")
      } else {
        lines.push(block.content)
      }
      lines.push("")
    }
  }
  lines.push(userText)
  return lines.join("\n")
}

export type MentionReadResult = {
  /** Prompt block to splice into `buildPrompt`'s `mentionBlock` slot. */
  block?: string
  /**
   * Per-mention byte accounting used by the manifest builder. Only entries
   * we actually attempted to read live here — successful reads (truncated or
   * not) and capped reads are still recorded so the manifest can render the
   * right status. Failed reads land in `failed` instead.
   */
  bytes: Record<string, { included: number; original: number }>
  /** Mentions skipped because we hit the per-prompt file/byte cap. */
  capped: string[]
  /** Mentions whose underlying file read threw (ENOENT etc.). */
  failed: string[]
}

export async function readMentions(
  mentions?: string[],
  maxBytes: number = DEFAULT_MENTION_MAX_BYTES,
): Promise<MentionReadResult> {
  if (!mentions || mentions.length === 0) {
    return { bytes: {}, capped: [], failed: [] }
  }
  const folders = vscode.workspace.workspaceFolders ?? []
  if (!folders.length) return { bytes: {}, capped: [], failed: [] }
  const seen = new Set<string>()
  const blocks: string[] = []
  const bytes: Record<string, { included: number; original: number }> = {}
  const capped: string[] = []
  const failed: string[] = []
  let totalBytes = 0
  for (const rel of mentions) {
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    if (blocks.length >= MENTION_MAX_FILES) {
      capped.push(rel)
      continue
    }
    try {
      const buf = await readFirstCandidate(rel, folders)
      const remaining = maxBytes - totalBytes
      if (remaining <= 0) {
        capped.push(rel)
        continue
      }
      const truncated = buf.byteLength > remaining
      const slice = truncated ? buf.slice(0, remaining) : buf
      const content = Buffer.from(slice).toString("utf8")
      const lang = guessFenceLang(rel)
      const note = truncated ? ` (truncated to ${remaining} bytes)` : ""
      blocks.push(`@${rel}${note}\n\`\`\`${lang}\n${content}\n\`\`\``)
      bytes[rel] = { included: slice.byteLength, original: buf.byteLength }
      totalBytes += slice.byteLength
    } catch (e) {
      log("readMentions: skipping", rel, e)
      failed.push(rel)
    }
  }
  const block = blocks.length > 0 ? ["Files attached:", ...blocks].join("\n") : undefined
  return { block, bytes, capped, failed }
}

/**
 * Resolve a mention path against every workspace folder and return the first
 * readable file. Exact paths are tried before folder-name-stripped variants:
 * in multi-root workspaces `asRelativePath` (the source of picker paths)
 * prefixes the owning folder's name, so `folderB/src/x.ts` must resolve
 * inside folder B — but a real subdirectory that happens to share the folder
 * name must still win.
 */
async function readFirstCandidate(
  rel: string,
  folders: readonly vscode.WorkspaceFolder[],
): Promise<Uint8Array> {
  const candidates: vscode.Uri[] = []
  if (path.isAbsolute(rel)) {
    candidates.push(vscode.Uri.file(rel))
  } else {
    for (const folder of folders) candidates.push(vscode.Uri.joinPath(folder.uri, rel))
    for (const folder of folders) {
      const stripped = stripWorkspaceFolderPrefix(folder.uri.fsPath, rel)
      if (stripped) candidates.push(vscode.Uri.joinPath(folder.uri, stripped))
    }
  }
  let lastError: unknown
  for (const uri of candidates) {
    try {
      return await vscode.workspace.fs.readFile(uri)
    } catch (e) {
      lastError = e
    }
  }
  throw lastError ?? new Error(`no candidate for ${rel}`)
}

export type ConversationMentionResult = {
  block?: string
  bytes: Record<string, { included: number; original: number }>
  capped: string[]
  failed: string[]
}

export function formatConversationContext(title: string, messages: ChatMessage[]): string {
  const total = messages.length
  let selected: ChatMessage[]
  let truncationNote = ""
  if (total <= CONVERSATION_MAX_MESSAGES + 1) {
    selected = messages
  } else {
    const first = messages[0]!
    const tail = messages.slice(-(CONVERSATION_MAX_MESSAGES))
    const tailStart = total - CONVERSATION_MAX_MESSAGES
    selected = tailStart > 0 ? [first, ...tail] : messages
    truncationNote = ` (first message + last ${CONVERSATION_MAX_MESSAGES} of ${total} total)`
  }
  const lines: string[] = [`Past conversation "${title}"${truncationNote}:`]
  for (const msg of selected) {
    const role = msg.role === "user" ? "User" : "Assistant"
    const parts: string[] = []
    for (const block of msg.blocks) {
      if (block.type === "text" && block.text.trim()) {
        parts.push(block.text.trim())
      } else if (block.type === "tool") {
        const name = block.update.tool
        const label = block.update.title ?? block.update.input?.path ?? ""
        parts.push(`[${name}${label ? `: ${label}` : ""}]`)
      } else if (block.type === "patch") {
        const files = block.files.join(", ")
        parts.push(`[patched ${files}]`)
      }
    }
    if (parts.length > 0) {
      lines.push(`${role}: ${parts.join("\n")}`)
    }
  }
  return lines.join("\n")
}

export function readConversationMentions(
  ids: string[] | undefined,
  getMessages: (id: string) => ChatMessage[] | undefined,
  getTitle: (id: string) => string | undefined,
  maxBytes: number = DEFAULT_CONVERSATION_MAX_BYTES,
): ConversationMentionResult {
  if (!ids || ids.length === 0) {
    return { bytes: {}, capped: [], failed: [] }
  }
  const seen = new Set<string>()
  const blocks: string[] = []
  const bytes: Record<string, { included: number; original: number }> = {}
  const capped: string[] = []
  const failed: string[] = []
  let totalBytes = 0
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    const messages = getMessages(id)
    const title = getTitle(id) ?? "Untitled conversation"
    if (!messages) {
      failed.push(id)
      continue
    }
    const formatted = formatConversationContext(title, messages)
    const formattedBytes = Buffer.byteLength(formatted, "utf8")
    const remaining = maxBytes - totalBytes
    if (remaining <= 0) {
      capped.push(id)
      continue
    }
    const truncated = formattedBytes > remaining
    const content = truncated ? formatted.slice(0, remaining) : formatted
    const includedBytes = Buffer.byteLength(content, "utf8")
    blocks.push(content)
    bytes[id] = { included: includedBytes, original: formattedBytes }
    totalBytes += includedBytes
  }
  const block = blocks.length > 0 ? blocks.join("\n\n") : undefined
  return { block, bytes, capped, failed }
}

function guessFenceLang(rel: string): string {
  const ext = path.extname(rel).slice(1).toLowerCase()
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
    cs: "csharp", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
    sh: "sh", bash: "sh", zsh: "sh", fish: "sh",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "md", html: "html", css: "css", scss: "scss",
    sql: "sql", swift: "swift", php: "php",
  }
  return map[ext] ?? ext
}
