/**
 * Pure helpers for splitting an assistant message into process vs answer and
 * for scrubbing internal scaffolding (system reminders, command tags) out of
 * streamed text. Kept separate from MessageView.tsx so the component file is
 * just JSX + render helpers, and so these functions can be tested without
 * rendering anything.
 */

import type { ChatBlock as Block } from "./protocol"
import { toolHeadline } from "./components/ToolCard"

export function hasProcessBlocks(blocks: Block[]) {
  return blocks.some((b) => {
    if (b.type === "text" || b.type === "reasoning") {
      // Treat blocks that are *only* internal scaffolding (e.g. a single
      // `<system-reminder>` callout with no other prose) as empty for the
      // purpose of deciding whether to wrap them in a ProcessPanel. Without
      // this guard, a message that is just a reminder ends up wrapped in
      // a panel whose title is the literal `<system-reminder>` first line
      // and whose body collapses to nothing in processMode rendering.
      if (b.type === "reasoning") return stripInternalMarkers(b.text).trim().length > 0
      // For text blocks we strip the noise markers but keep reminder text —
      // those still render as inline callouts inside the panel.
      return splitWithReminders(b.text).length > 0
    }
    if (b.type === "attachment") return false
    if (b.type === "tool") {
      // Tool blocks for synthetic system-reminders aren't real activity;
      // skip them too so an all-reminder message doesn't get wrapped.
      return !isSystemReminderTool(b.update.tool)
    }
    return true
  })
}

/**
 * The answer is the trailing run of text blocks after the last "activity"
 * block — a tool call, a patch, or a reasoning block. Everything up to and
 * including that activity is process (work + thinking); only the trailing text
 * is the final answer. Deterministic — relies on opencode's block emission
 * order rather than guessing from prose, so a short closing line is never
 * buried in the collapsed work panel.
 *
 * Returns the index where the answer region begins; equals `blocks.length`
 * when the message ends on activity (no answer region).
 */
export function answerStartIndex(blocks: Block[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block && (block.type === "tool" || block.type === "patch" || block.type === "reasoning")) {
      return i + 1
    }
  }
  return 0
}

export function processTitle(blocks: Block[]) {
  const fromText = blocks.flatMap((block) => {
    if (block.type !== "text" && block.type !== "reasoning") return []
    // Strip `<system-reminder>` / command-name / HTML-comment scaffolding
    // BEFORE picking a title — otherwise the first line of a reminder-only
    // block leaks through as the literal `<system-reminder>` title.
    const cleaned = stripInternalMarkers(block.text)
    if (!cleaned.trim()) return []
    return [textTitle(cleaned) ?? inferredTextTitle(cleaned)]
  }).find(Boolean)
  if (fromText) return fromText

  // Real tool calls become a tool-headline title; pure system-reminder tool
  // blocks don't count as work and shouldn't drive the headline.
  const tools = blocks.flatMap((block) =>
    block.type === "tool" && !isSystemReminderTool(block.update.tool) ? [block.update] : [],
  )
  if (tools.length) return toolHeadline(tools)
  return "Working"
}

export function processSummary(blocks: Block[]) {
  const tools = blocks.flatMap((block) => block.type === "tool" ? [block.update] : [])
  if (!tools.length) return undefined

  const reads = new Set<string>()
  const edits = new Set<string>()
  const creates = new Set<string>()
  let searches = 0
  let runs = 0
  let fetches = 0
  let other = 0

  for (const update of tools) {
    if (update.tool === "read") {
      const path = pickToolPath(update)
      if (path) reads.add(path)
      else other++
      continue
    }
    if (update.tool === "edit") {
      const path = pickToolPath(update)
      if (path) (update.input?.oldString === "" ? creates : edits).add(path)
      else other++
      continue
    }
    if (update.tool === "write") {
      const path = pickToolPath(update)
      const exists = update.metadata?.exists !== false
      if (path) (exists ? edits : creates).add(path)
      else other++
      continue
    }
    if (update.tool === "apply_patch") {
      const files = Array.isArray(update.metadata?.files) ? update.metadata.files : []
      for (const file of files) {
        if (typeof file !== "object" || file === null) continue
        const record = file as Record<string, unknown>
        if (typeof record.relativePath !== "string") continue
        if (record.type === "add") creates.add(record.relativePath)
        else if (record.type === "delete") edits.add(record.relativePath)
        else edits.add(record.relativePath)
      }
      continue
    }
    if (update.tool === "grep" || update.tool === "glob") { searches++; continue }
    if (update.tool === "bash") { runs++; continue }
    if (update.tool === "webfetch") { fetches++; continue }
    other++
  }

  const parts: string[] = []
  if (reads.size) parts.push(`Read ${reads.size}`)
  if (creates.size) parts.push(`Created ${creates.size}`)
  if (edits.size) parts.push(`Edited ${edits.size}`)
  if (searches) parts.push(`${searches} ${searches === 1 ? "search" : "searches"}`)
  if (runs) parts.push(`${runs} ${runs === 1 ? "command" : "commands"}`)
  if (fetches) parts.push(`${fetches} ${fetches === 1 ? "fetch" : "fetches"}`)
  if (!parts.length && other) parts.push(`${other} ${other === 1 ? "tool" : "tools"}`)
  return parts.length ? parts.join(" · ") : undefined
}

export function pickToolPath(update: { input?: Record<string, unknown>; title?: string; tool: string }): string | undefined {
  if (typeof update.input?.filePath === "string") return update.input.filePath
  if (typeof update.input?.path === "string") return update.input.path
  if (update.title) return update.title
  return undefined
}

export function textTitle(text: string) {
  const [first = ""] = text.trim().split(/\n+/)
  const title = cleanProcessText(first).replace(/[:.]+$/, "")
  if (!title || title.length > 80) return undefined
  // Reject literal HTML-like tags (e.g. `<system-reminder>`, `<command-name>`)
  // — these leak in when the model emits raw scaffolding as the first line
  // and would otherwise become the panel's title verbatim.
  if (/^<\/?\w[\w-]*\s*(\s[^>]*)?\/?>$/.test(title)) return undefined
  if (/^(i('|’)m|i am|i need|i think|it seems|this|the user|found|next|now)\b/i.test(title)) return undefined
  if (title.split(/\s+/).length > 8) return undefined
  return title
}

export function stripDuplicateTitle(text: string, title: string) {
  const lines = text.trim().split(/\n+/)
  if (cleanProcessText(lines[0] ?? "").replace(/[:.]+$/, "") === title) {
    return lines.slice(1).join("\n").trim()
  }
  return text.trim()
}

export function cleanProcessText(text: string) {
  return text
    .trim()
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^__(.+)__$/, "$1")
    .replace(/^#+\s*/, "")
}

/**
 * Strip internal scaffolding markers that the model or harness inserts into
 * its reasoning/text stream (system reminders, internal comments). These are
 * not user-facing content and shouldn't render in the chat conversation.
 */
export function stripInternalMarkers(text: string): string {
  return text
    // <system-reminder ...>...</system-reminder> — also accepts attributes.
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, "")
    // Stray opening/closing tags left over from partial streams.
    .replace(/<\/?system-reminder\b[^>]*>/gi, "")
    // HTML-style internal comments (e.g. <!-- OMO_INTERNAL_INITIATOR -->).
    .replace(/<!--[\s\S]*?-->/g, "")
    // <command-name>, <command-message>, <command-args>, <local-command-stdout>
    // and similar harness scaffolding tags.
    .replace(/<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|user-prompt-submit-hook)>[\s\S]*?<\/\1>/gi, "")
    // Collapse the blank lines left behind by removed blocks.
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "")
}

export type RenderSegment = { type: "text"; content: string } | { type: "reminder"; content: string }

/**
 * Like `stripInternalMarkers` but preserves `<system-reminder>` blocks as
 * separate segments so the UI can render them as collapsible callouts
 * (instead of hiding them entirely). Other internal markers (`<!-- ... -->`,
 * command-name etc.) are still stripped — they're noise, not content.
 */
export function splitWithReminders(text: string): RenderSegment[] {
  // Strip noise markers but DO NOT touch <system-reminder> tags yet — we need
  // the closing tags intact to find paired matches.
  const cleanedNoise = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|user-prompt-submit-hook)>[\s\S]*?<\/\1>/gi, "")

  const segments: RenderSegment[] = []
  const regex = /<system-reminder\b[^>]*>([\s\S]*?)<\/system-reminder>/gi
  let cursor = 0
  let match: RegExpExecArray | null
  const pushText = (raw: string) => {
    // Drop any stray unpaired reminder tags from the surrounding text.
    const cleaned = raw
      .replace(/<\/?system-reminder\b[^>]*>/gi, "")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\n+|\n+$/g, "")
    if (cleaned.trim()) segments.push({ type: "text", content: cleaned })
  }
  while ((match = regex.exec(cleanedNoise)) !== null) {
    pushText(cleanedNoise.slice(cursor, match.index))
    const reminder = match[1].trim()
    if (reminder) segments.push({ type: "reminder", content: reminder })
    cursor = match.index + match[0].length
  }
  pushText(cleanedNoise.slice(cursor))
  return segments
}

/**
 * Some deep agents (e.g. Hephaestus) emit reminders as a synthetic tool
 * call whose name is some variant of "system-reminder" instead of the
 * inline `<system-reminder>` text tag. Normalize so we catch
 * `system-reminder`, `<system-reminder>`, `system_reminder`,
 * `systemreminder`, regardless of case.
 */
export function isSystemReminderTool(toolName: string | undefined): boolean {
  if (!toolName) return false
  const normalized = toolName.toLowerCase().replace(/[<>_-]/g, "")
  return normalized === "systemreminder"
}

/**
 * Pull the human-readable reminder text out of a `system-reminder` tool
 * call. Tries the common shapes — `output`, then known string keys on
 * `input`, then `title`. Falls back to JSON-stringifying the input
 * object so we never lose information silently.
 */
export function systemReminderContentFromTool(update: {
  output?: string
  input?: Record<string, unknown>
  title?: string
}): string {
  if (typeof update.output === "string" && update.output.trim()) return update.output.trim()
  if (update.input) {
    for (const key of ["text", "content", "message", "reminder", "body", "value"]) {
      const v = update.input[key]
      if (typeof v === "string" && v.trim()) return v.trim()
    }
    const json = JSON.stringify(update.input)
    if (json && json !== "{}") return json
  }
  if (update.title && update.title.trim()) return update.title.trim()
  return ""
}

export function inferredTextTitle(text: string) {
  const value = text.trim()
  if (/^i detect\b/i.test(value)) return "Understanding request"
  if (/^found\b/i.test(value)) return "Inspecting project"
  if (/^next\b/i.test(value)) return "Planning next step"
  if (/^i[’']ve confirmed\b/i.test(value)) return "Reviewing structure"
  if (/^i[’']ve got\b/i.test(value)) return "Reviewing findings"
  if (/\bchecking\b/i.test(value)) return "Checking project"
  if (/\breading\b/i.test(value)) return "Reading files"
  if (/\binspecting\b/i.test(value)) return "Inspecting code"
  if (/\bexploring\b/i.test(value)) return "Exploring project"
  if (/\bconsidering\b/i.test(value)) return "Considering next step"
  return undefined
}
