import * as vscode from "vscode"
import * as path from "path"
import type { getEditorContext } from "../context"
import type { ChatMessage, ConversationMention } from "../protocol"
import type { WorkspaceRoot } from "../workspace-root"
import type { PromptContextBlock } from "../workspace-context/types"
import { log } from "../output"
import { stripWorkspaceFolderPrefix } from "./paths"

export const DEFAULT_MENTION_MAX_BYTES = 200_000
export const DEFAULT_CONVERSATION_MAX_BYTES = 100_000
const MENTION_MAX_FILES = 20
/**
 * One message may consume at most this fraction of a conversation mention's
 * byte budget, so a single pasted log cannot evict every other turn.
 */
const CONVERSATION_MESSAGE_MAX_FRACTION = 0.25
const MESSAGE_TRUNCATED_MARKER = "\n[message truncated]"

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

/**
 * Conversation IDs to actually attach to a prompt, from the chips as written:
 * each PAST conversation once. A self-mention (the active conversation) adds
 * nothing the session doesn't already have, and duplicate chips for the same
 * chat must not attach its transcript twice. The persisted message keeps
 * every pair — filtering is a prompt-time concern only, so the edit flow
 * always sees exactly what the user wrote.
 */
export function attachableConversationIDs(
  mentions: ConversationMention[] | undefined,
  activeConversationID: string,
): string[] {
  const ids = (mentions ?? []).map((m) => m.id)
  return ids.filter((id, index) => !!id && id !== activeConversationID && ids.indexOf(id) === index)
}

export type ConversationMentionResult = {
  block?: string
  bytes: Record<string, { included: number; original: number; truncated: boolean }>
  capped: string[]
  failed: string[]
}

export type ConversationContextResult = {
  text: string
  /** Byte size of the full, untruncated transcript block. */
  originalBytes: number
  /**
   * True when any message was omitted or cut. The manifest must use this
   * rather than comparing byte counts: the omission marker and header note
   * can outweigh a tiny omitted message, making `included > original`.
   */
  truncated: boolean
}

function formatConversationMessage(msg: ChatMessage): string | undefined {
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
  if (parts.length === 0) return undefined
  return `${role}: ${parts.join("\n")}`
}

/**
 * Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a character
 * (a Buffer cut mid-character decodes to trailing U+FFFD, which we strip).
 * Prefers ending at the last newline, then the last space, when one exists in
 * the second half of the cut, so truncation lands on a natural boundary.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  const hard = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8").replace(/�+$/, "")
  const newline = hard.lastIndexOf("\n")
  if (newline > hard.length / 2) return hard.slice(0, newline)
  const space = hard.lastIndexOf(" ")
  if (space > hard.length / 2) return hard.slice(0, space)
  return hard
}

function capMessage(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text
  const markerBytes = Buffer.byteLength(MESSAGE_TRUNCATED_MARKER, "utf8")
  if (maxBytes <= markerBytes) return truncateUtf8(text, maxBytes)
  return truncateUtf8(text, maxBytes - markerBytes) + MESSAGE_TRUNCATED_MARKER
}

/** A fence longer than any backtick run in `content`, so transcript code blocks cannot close it. */
function fenceFor(content: string): string {
  let longest = 0
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return "`".repeat(Math.max(3, longest + 1))
}

/**
 * Format a past conversation for the prompt within a hard byte budget.
 * Selection and truncation are one mechanism: the first message is always
 * kept (it anchors the conversation's intent), then whole messages are added
 * walking backward from the end until the budget is spent, with an omission
 * marker at the gap. Messages are never split mid-character or mid-turn, so
 * the budget holds by construction regardless of content encoding. The
 * transcript is fenced so its `User:` / `Assistant:` lines read as quoted
 * reference material, not live turns.
 *
 * Returns undefined when not even the header plus the (capped) first message
 * fits — the caller records the mention as capped.
 */
export function formatConversationContext(
  title: string,
  messages: ChatMessage[],
  maxBytes: number,
): ConversationContextResult | undefined {
  if (maxBytes <= 0) return undefined
  const header = (note: string) => `Past conversation "${title}"${note}:`
  const formatted: string[] = []
  for (const msg of messages) {
    const text = formatConversationMessage(msg)
    if (text !== undefined) formatted.push(text)
  }
  if (formatted.length === 0) {
    const text = header("")
    const bytes = Buffer.byteLength(text, "utf8")
    return bytes <= maxBytes ? { text, originalBytes: bytes, truncated: false } : undefined
  }

  // Fence sized against the full transcript: capping only removes content
  // (the appended markers contain no backticks), so a fence that clears the
  // full text clears every capped variant too.
  const fence = fenceFor(formatted.join("\n"))
  const originalBytes = Buffer.byteLength([header(""), fence, ...formatted, fence].join("\n"), "utf8")

  const perMessageMax = Math.max(1, Math.floor(maxBytes * CONVERSATION_MESSAGE_MAX_FRACTION))
  const capped = formatted.map((m) => capMessage(m, perMessageMax))
  const sizes = capped.map((m) => Buffer.byteLength(m, "utf8"))
  const n = capped.length
  // Neutral wording: the gap usually holds earlier turns, but when only the
  // anchor fits the omitted messages are the later ones.
  const omittedMarker = (k: number) => `[... ${k} messages omitted]`

  // Reserve worst-case fixed overhead (header with note, both fence lines,
  // omission marker, join newlines) up front. Actual overhead is never
  // larger, so packing whole messages against the remainder cannot overshoot
  // the budget — at worst it leaves a few dozen bytes unused.
  const fixed =
    Buffer.byteLength(header(` (first message + last ${n} of ${n} total)`), "utf8") +
    fence.length * 2 +
    Buffer.byteLength(omittedMarker(n), "utf8") +
    4
  const msgBudget = maxBytes - fixed
  if (msgBudget < sizes[0]! + 1) return undefined

  let used = sizes[0]! + 1
  let tailStart = n
  for (let i = n - 1; i >= 1; i--) {
    const cost = sizes[i]! + 1
    if (used + cost > msgBudget) break
    used += cost
    tailStart = i
  }
  const tail = capped.slice(Math.max(tailStart, 1))
  const omitted = Math.max(tailStart, 1) - 1

  const segments = [capped[0]!]
  if (omitted > 0) segments.push(omittedMarker(omitted))
  segments.push(...tail)
  const note =
    omitted === 0
      ? ""
      : tail.length > 0
        ? ` (first message + last ${tail.length} of ${n} total)`
        : ` (first message of ${n} total)`
  const text = [header(note), fence, ...segments, fence].join("\n")
  const anyMessageCapped = capped.some((m, i) => m !== formatted[i])
  return { text, originalBytes, truncated: omitted > 0 || anyMessageCapped }
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
  const bytes: Record<string, { included: number; original: number; truncated: boolean }> = {}
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
    const result = formatConversationContext(title, messages, maxBytes - totalBytes)
    if (!result) {
      capped.push(id)
      continue
    }
    const included = Buffer.byteLength(result.text, "utf8")
    blocks.push(result.text)
    bytes[id] = { included, original: result.originalBytes, truncated: result.truncated }
    totalBytes += included
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
