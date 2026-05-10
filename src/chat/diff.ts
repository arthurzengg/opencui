import * as path from "path"
import type { ReviewChange } from "../protocol"
import { normalizePath, unique } from "./paths"

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

    const { oldText, newText, anchorText } = hunkText(hunkLines)
    hunks.push({
      id: `${hunks.length}-${hunkHeader}`,
      header: hunkHeader,
      lines: diffLines(hunkLines.join("\n")),
      anchorText,
      oldText,
      newText,
      reversible: true,
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
      reversible: false,
    })
  }

  return { hunks }
}

export function hunkText(lines: string[]) {
  const oldLines: string[] = []
  const newLines: string[] = []
  const diff = diffLines(lines.join("\n"))
  for (const line of lines) {
    if (line.startsWith("\\ No newline")) continue
    if (line.startsWith("+") && !line.startsWith("+++")) {
      newLines.push(line.slice(1))
      continue
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      oldLines.push(line.slice(1))
      continue
    }
    const text = line.startsWith(" ") ? line.slice(1) : line
    oldLines.push(text)
    newLines.push(text)
  }
  return {
    oldText: oldLines.join("\n"),
    newText: newLines.join("\n"),
    anchorText: firstReviewAnchor(diff, newLines.join("\n")),
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
  return `${change.source}:${normalizePath(change.path)}:${hunkID}`
}

export function findHunkText(current: string, value: string): { start: number; end: number } | undefined {
  const candidates = unique([
    value,
    value.endsWith("\n") ? value.slice(0, -1) : `${value}\n`,
    value.replace(/\r?\n/g, "\r\n"),
  ]).filter((candidate) => candidate.length > 0)
  for (const candidate of candidates) {
    const start = current.indexOf(candidate)
    if (start >= 0) return { start, end: start + candidate.length }
  }
  if (value.length === 0) return { start: 0, end: 0 }
  return undefined
}
