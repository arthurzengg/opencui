import * as path from "path"
import type { ReviewChange } from "../protocol"
import { reviewKey as sharedReviewKey } from "../../webview/src/review-extract"

export type ReviewDiffLine = {
  text: string
  kind: "add" | "del" | "hunk" | "ctx"
}

export type ReviewDiffHunk = {
  id: string
  header: string
  lines: ReviewDiffLine[]
  anchorText: string
  oldText: string
  newText: string
  /**
   * 1-based starting line in the ORIGINAL file (`-X,Y` of the hunk header).
   * `0` for created-file hunks where the original side is empty.
   */
  oldStart: number
  oldCount: number
  /**
   * 1-based starting line in the NEW (post-change) file (`+A,B` of the
   * header). `0` for deleted-file hunks where the new side is empty.
   */
  newStart: number
  newCount: number
  /** Context lines that precede the +/-/space block, used as a secondary anchor. */
  leadingContext: string[]
  /** Context lines that follow the change, used as a secondary anchor. */
  trailingContext: string[]
  /**
   * True when we have enough information to reconstruct the original state.
   * False for malformed hunks (no @@ header parsed) — the UI hides Undo for
   * those rather than letting it silently fail.
   */
  reversible: boolean
}

const BINARY_EXTENSIONS = new Set([
  ".ai", ".avif", ".bin", ".bmp", ".class", ".db", ".dmg", ".doc", ".docx",
  ".ds_store", ".eot", ".exe", ".gif", ".heic", ".icns", ".ico", ".jar",
  ".jpeg", ".jpg", ".mov", ".mp3", ".mp4", ".otf", ".pdf", ".png", ".pyc",
  ".so", ".sqlite", ".ttf", ".webp", ".woff", ".woff2", ".zip",
])

export function isTextReviewPath(value: string) {
  const name = path.basename(value).toLowerCase()
  if (!name || name === ".ds_store" || name === "thumbs.db") return false
  const ext = path.extname(name)
  if (!ext && name.startsWith(".")) return false
  return !BINARY_EXTENSIONS.has(ext)
}

export function countDiff(patch: string, prefix: "+" | "-") {
  return patch
    .split("\n")
    .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`))
    .length
}

const HUNK_HEADER_RE = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/

export function parseHunkHeader(header: string): {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
} | undefined {
  const match = HUNK_HEADER_RE.exec(header)
  if (!match) return undefined
  const oldStart = Number(match[1])
  const oldCount = match[2] !== undefined ? Number(match[2]) : 1
  const newStart = Number(match[3])
  const newCount = match[4] !== undefined ? Number(match[4]) : 1
  if (Number.isNaN(oldStart) || Number.isNaN(oldCount) || Number.isNaN(newStart) || Number.isNaN(newCount)) {
    return undefined
  }
  return { oldStart, oldCount, newStart, newCount }
}

export function splitReviewDiff(patch: string): { hunks: ReviewDiffHunk[] } {
  const lines = patch.split("\n")
  const hunks: ReviewDiffHunk[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (!line.startsWith("@@")) {
      index += 1
      continue
    }

    const hunkHeader = line
    const hunkLines: string[] = []
    index += 1
    while (index < lines.length && !(lines[index] ?? "").startsWith("@@")) {
      hunkLines.push(lines[index] ?? "")
      index += 1
    }

    const { oldText, newText, anchorText, leadingContext, trailingContext } = hunkText(hunkLines)
    const headerInfo = parseHunkHeader(hunkHeader) ?? {
      oldStart: 0,
      oldCount: 0,
      newStart: 0,
      newCount: 0,
    }
    hunks.push({
      id: `${hunks.length}-${hunkHeader}`,
      header: hunkHeader,
      lines: diffLines(hunkLines.join("\n")),
      anchorText,
      oldText,
      newText,
      oldStart: headerInfo.oldStart,
      oldCount: headerInfo.oldCount,
      newStart: headerInfo.newStart,
      newCount: headerInfo.newCount,
      leadingContext,
      trailingContext,
      reversible: HUNK_HEADER_RE.test(hunkHeader),
    })
  }

  if (!hunks.length && patch.trim()) {
    hunks.push({
      id: "0-file",
      header: "@@ file change @@",
      lines: diffLines(patch),
      anchorText: firstReviewAnchor(diffLines(patch), patch),
      oldText: "",
      newText: "",
      oldStart: 0,
      oldCount: 0,
      newStart: 0,
      newCount: 0,
      leadingContext: [],
      trailingContext: [],
      reversible: false,
    })
  }

  return { hunks }
}

export function hunkText(lines: string[]) {
  const oldLines: string[] = []
  const newLines: string[] = []
  const leadingContext: string[] = []
  const trailingContext: string[] = []
  let sawChange = false
  const diff = diffLines(lines.join("\n"))
  for (const line of lines) {
    if (line.startsWith("\\ No newline")) continue
    if (line.startsWith("+") && !line.startsWith("+++")) {
      sawChange = true
      newLines.push(line.slice(1))
      continue
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      sawChange = true
      oldLines.push(line.slice(1))
      continue
    }
    const text = line.startsWith(" ") ? line.slice(1) : line
    oldLines.push(text)
    newLines.push(text)
    if (!sawChange) leadingContext.push(text)
    else trailingContext.push(text)
  }
  return {
    oldText: oldLines.join("\n"),
    newText: newLines.join("\n"),
    anchorText: firstReviewAnchor(diff, newLines.join("\n")),
    leadingContext,
    trailingContext,
  }
}

export function diffLines(patch: string) {
  return patch.split("\n").map((text) => ({
    text,
    kind: text.startsWith("+") && !text.startsWith("+++")
      ? "add"
      : text.startsWith("-") && !text.startsWith("---")
        ? "del"
        : text.startsWith("@@")
          ? "hunk"
          : "ctx",
  } satisfies ReviewDiffLine))
}

export function firstReviewAnchor(lines: ReviewDiffLine[], fallback: string) {
  const added = firstChangedBlock(lines, "add")
  if (added) return added
  const context = firstChangedBlock(lines, "ctx")
  return context || fallback
}

export function firstChangedBlock(lines: ReviewDiffLine[], kind: ReviewDiffLine["kind"]) {
  const start = lines.findIndex((line) => line.kind === kind && reviewLineText(line).trim())
  if (start < 0) return ""
  const block: string[] = []
  for (const line of lines.slice(start)) {
    if (line.kind !== kind) break
    block.push(reviewLineText(line))
  }
  return block.join("\n")
}

export function reviewLineText(line: ReviewDiffLine) {
  if ((line.kind === "add" || line.kind === "del" || line.kind === "ctx") && /^[+\- ]/.test(line.text)) {
    return line.text.slice(1)
  }
  return line.text
}

export function reviewKey(change: ReviewChange, hunkID: string) {
  // Delegate to the shared helper so host + webview agree byte-for-byte.
  return sharedReviewKey(change, hunkID)
}

/**
 * Locate where a hunk's `newText` lives in the current file content, returning
 * `{ start, end }` byte offsets into `current` so the caller can replace it
 * with `oldText`.
 *
 * Strategy, in order of preference:
 *   1. Line-number anchor from the hunk header (`+A,B`). Defends against the
 *      repeated-identical-text-block case — every hunk has a distinct line
 *      number, even if the surrounding text is identical.
 *   2. Unique substring match. If `newText` appears exactly once in the file
 *      we trust that location. Multiple occurrences = ambiguous → conflict.
 *
 * Returns `undefined` when no safe location can be determined.
 */
export function findHunkInFile(
  current: string,
  hunk: Pick<ReviewDiffHunk, "newText" | "newStart" | "newCount" | "leadingContext" | "trailingContext">,
): { start: number; end: number } | undefined {
  // Primary: line-anchored exact match. We try a few variants because opencode
  // and the editor may disagree on trailing-newline normalization.
  if (hunk.newStart > 0) {
    const startOffset = lineToByteOffset(current, hunk.newStart - 1)
    for (const candidate of newlineCandidates(hunk.newText)) {
      if (current.slice(startOffset, startOffset + candidate.length) === candidate) {
        return { start: startOffset, end: startOffset + candidate.length }
      }
    }
  }

  // Empty value preserves the legacy `findHunkText` semantics.
  if (hunk.newText === "") {
    return { start: 0, end: 0 }
  }

  // Secondary: unique substring match. Multiple occurrences = ambiguous.
  for (const candidate of newlineCandidates(hunk.newText)) {
    if (candidate.length === 0) continue
    const first = current.indexOf(candidate)
    if (first < 0) continue
    const second = current.indexOf(candidate, first + 1)
    if (second >= 0) {
      // Ambiguous — only safe to act when newStart anchor already nailed it,
      // which it didn't (we'd have returned above). Give up rather than
      // mutating the wrong occurrence.
      return undefined
    }
    return { start: first, end: first + candidate.length }
  }
  return undefined
}

function newlineCandidates(value: string): string[] {
  return uniqueStrings([
    value,
    value.endsWith("\n") ? value.slice(0, -1) : `${value}\n`,
    value.replace(/\r?\n/g, "\r\n"),
  ])
}

function uniqueStrings(items: string[]): string[] {
  return [...new Set(items)]
}

function lineToByteOffset(text: string, lineIndex: number): number {
  if (lineIndex <= 0) return 0
  let count = 0
  let offset = 0
  while (count < lineIndex) {
    const idx = text.indexOf("\n", offset)
    if (idx < 0) return text.length
    offset = idx + 1
    count++
  }
  return offset
}

/**
 * Legacy entry point — preserves the (current, value) signature used by older
 * callers and tests. Now adds an ambiguity guard: the old `indexOf`-based
 * implementation silently picked the first match even when multiple identical
 * blocks existed, which was the root cause of "Undo mangled the wrong copy."
 */
export function findHunkText(current: string, value: string): { start: number; end: number } | undefined {
  return findHunkInFile(current, {
    newText: value,
    newStart: 0,
    newCount: value === "" ? 0 : value.split("\n").length,
    leadingContext: [],
    trailingContext: [],
  })
}
