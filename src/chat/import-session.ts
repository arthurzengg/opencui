import type { ChatBlock, ChatMessage, ExternalSessionSummary } from "../protocol"
import { relativeToCwd } from "./paths"
import { toWire } from "./wire-format"
import type { ToolUpdate } from "./stream"

/** The slice of the SDK's Session shape this module consumes. */
export type SessionInfo = {
  id: string
  parentID?: string
  title?: string
  time?: { created?: number; updated?: number }
}

/** The slice of a `session.messages()` item this module consumes. */
export type ServerMessageItem = {
  info?: {
    id?: string
    role?: string
    summary?: boolean | { title?: string }
    error?: { name?: string; data?: { message?: string } }
  }
  parts?: ServerPart[]
}

type ServerPart = {
  type?: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  callID?: string
  tool?: string
  state?: {
    status?: string
    title?: string
    input?: Record<string, unknown>
    metadata?: Record<string, unknown>
    output?: string
    error?: string
  }
  files?: unknown[]
  mime?: string
  filename?: string
  url?: string
}

export const MAX_EXTERNAL_SESSIONS = 50

/**
 * Sessions worth offering in the history popover: top-level (subagent child
 * sessions carry a `parentID`) and not already bound to a saved conversation.
 * Newest first, capped so a long-lived project doesn't flood the popover.
 * The fetch already asks the server for `roots` and `limit` (#617); the filter
 * and cap here are the fallback for servers that ignore those parameters.
 */
export function externalSessionSummaries(
  sessions: SessionInfo[],
  boundSessionIDs: ReadonlySet<string>,
): ExternalSessionSummary[] {
  return sessions
    .filter((s) => s.id && !s.parentID && !boundSessionIDs.has(s.id))
    .map((s) => ({
      id: s.id,
      title: s.title?.trim() || "Untitled session",
      updatedAt: s.time?.updated ?? s.time?.created ?? 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_EXTERNAL_SESSIONS)
}

/**
 * Rebuild a webview transcript from a server session's message list. The live
 * flow never does this (it accumulates ChatMessages from SSE deltas and
 * persists them), so importing a TUI/web session is the one place server
 * parts are converted wholesale. `id` and `backendID` are both the server
 * message id — backendID is what the edit/rewind flow keys `session.revert`
 * on, mirroring how `/fork` re-stamps copied messages.
 */
export function importedMessages(items: ServerMessageItem[], cwd: string): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const item of items) {
    const info = item.info
    if (!info?.id) continue
    if (info.role === "user") {
      const text = textOf(item.parts)
      const attachments = attachmentBlocks(item.parts)
      if (!text && !attachments.length) continue
      messages.push({
        id: info.id,
        role: "user",
        backendID: info.id,
        blocks: [...attachments, { type: "text", text }],
      })
      continue
    }
    if (info.role !== "assistant") continue
    const blocks = assistantBlocks(item.parts ?? [], cwd)
    const aborted = info.error?.name === "MessageAbortedError"
    const error = info.error && !aborted
      ? info.error.data?.message ?? info.error.name ?? "unknown error"
      : undefined
    if (!blocks.length && !error) continue
    messages.push({
      id: info.id,
      role: "assistant",
      backendID: info.id,
      blocks,
      ...(info.summary ? { summary: true } : {}),
      ...(aborted ? { stopped: true } : {}),
      ...(error ? { error } : {}),
    })
  }
  return messages
}

function textOf(parts: ServerPart[] | undefined): string {
  return (parts ?? [])
    .filter((p) => p.type === "text" && !p.synthetic && !p.ignored && typeof p.text === "string")
    .map((p) => p.text!)
    .join("\n\n")
    .trim()
}

/**
 * Both lines hand an attachment back as a data URL: a 1.x server reads a
 * file:// part into one at prompt time (a text file becomes synthetic text
 * instead) and the 2.x adapter builds one from the bytes the server stored
 * (#736). The block keeps the URL for the thumbnail and the edit flow; the
 * attachment store takes the bytes over on the next mount, as for a legacy
 * message.
 */
function attachmentBlocks(parts: ServerPart[] | undefined): ChatBlock[] {
  const blocks: ChatBlock[] = []
  for (const part of parts ?? []) {
    if (part.type !== "file" || typeof part.mime !== "string" || typeof part.url !== "string") continue
    const dataUrl = part.url.startsWith("data:") ? part.url : undefined
    const payload = dataUrl?.slice(dataUrl.indexOf(",") + 1)
    blocks.push({
      type: "attachment",
      mime: part.mime,
      filename: part.filename ?? "attachment",
      dataUrl,
      bytes: payload ? Buffer.from(payload, "base64").byteLength : 0,
    })
  }
  return blocks
}

function assistantBlocks(parts: ServerPart[], cwd: string): ChatBlock[] {
  const blocks: ChatBlock[] = []
  for (const part of parts) {
    switch (part.type) {
      case "text": {
        if (part.synthetic || part.ignored || !part.text) break
        blocks.push({ type: "text", text: part.text })
        break
      }
      case "reasoning": {
        if (part.text) blocks.push({ type: "reasoning", text: part.text })
        break
      }
      case "tool": {
        const state = part.state
        // Only settled states import. A session abandoned mid-turn can carry
        // pending/running parts, and nothing will ever close them here — a
        // perpetually-"running" block is exactly what the abort flow's
        // terminal-closure rule exists to prevent.
        if (!part.callID || !part.tool || !state) break
        if (state.status !== "completed" && state.status !== "error") break
        const update: ToolUpdate = {
          callID: part.callID,
          tool: part.tool,
          status: state.status,
          title: state.title,
          input: state.input,
          metadata: state.metadata,
          output: state.output,
          error: state.error,
        }
        blocks.push({ type: "tool", update: toWire(update, cwd) })
        break
      }
      case "patch": {
        const files = (part.files ?? []).filter((f): f is string => typeof f === "string")
        if (files.length) blocks.push({ type: "patch", files: files.map((f) => relativeToCwd(cwd, f)) })
        break
      }
      default:
        break
    }
  }
  return blocks
}
