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
   * True when the diff carried a `\ No newline at end of file` marker for the
   * ORIGINAL side. `oldText` is newline-joined and so never ends in one; a
   * unified diff only records the ABSENCE of the terminator, which makes this
   * the only way to tell "the file ended without a newline" from "the join
   * dropped it". Read when restoring a deleted file.
   */
  oldNoNewlineAtEof: boolean
  /**
   * True when we have enough information to reconstruct the original state.
   * False for malformed hunks (no @@ header parsed) — the UI hides Undo for
   * those rather than letting it silently fail.
   */
  reversible: boolean
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

    const {
      oldText,
      newText,
      anchorText,
      leadingContext,
      trailingContext,
      oldNoNewlineAtEof,
    } = hunkText(hunkLines)
    const headerInfo = parseHunkHeader(hunkHeader) ?? {
      oldStart: 0,
      oldCount: 0,
      newStart: 0,
      newCount: 0,
    }
    hunks.push({
      id: `${hunks.length}-${hunkHeader}`,
      header: hunkHeader,
      lines: diffLines(hunkLines.join("\n"), { fileHeaders: false }),
      anchorText,
      oldText,
      newText,
      oldStart: headerInfo.oldStart,
      oldCount: headerInfo.oldCount,
      newStart: headerInfo.newStart,
      newCount: headerInfo.newCount,
      leadingContext,
      trailingContext,
      oldNoNewlineAtEof,
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
      oldNoNewlineAtEof: false,
      reversible: false,
    })
  }

  return { hunks }
}

/**
 * Split a hunk BODY into its pre-change and post-change text. `lines` never
 * contains unified-diff file headers — splitReviewDiff only collects lines
 * after the `@@` header — so a leading `---` / `+++` here is content, not a
 * header, and must not be exempted from the +/- prefix strip. Guarding on it
 * pushed a deleted `-- sql comment` (diff line `--- sql comment`) into BOTH
 * oldText and newText with its prefix intact, which broke Undo (restored the
 * extra dash) and Keep (searched for a newText containing a line that was
 * actually deleted, so it reported a phantom conflict).
 */
export function hunkText(lines: string[]) {
  const oldLines: string[] = []
  const newLines: string[] = []
  const leadingContext: string[] = []
  const trailingContext: string[] = []
  let sawChange = false
  let oldNoNewlineAtEof = false
  // Whether the line the NEXT `\ No newline at end of file` marker would apply
  // to belongs to the original side: the marker annotates the line right above
  // it, so it means "the old file had no terminator" after a `-` or context
  // line, and only "the new file has none" after a `+`.
  let previousLineIsOld = false
  const diff = diffLines(lines.join("\n"), { fileHeaders: false })
  for (const line of lines) {
    if (line.startsWith("\\ No newline")) {
      if (previousLineIsOld) oldNoNewlineAtEof = true
      continue
    }
    if (line.startsWith("+")) {
      sawChange = true
      newLines.push(line.slice(1))
      previousLineIsOld = false
      continue
    }
    previousLineIsOld = true
    if (line.startsWith("-")) {
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
    oldNoNewlineAtEof,
  }
}

/**
 * Classify each line of `patch`.
 *
 * `fileHeaders` (default true) treats `---` / `+++` as unified-diff file
 * headers rather than content. Pass `false` for a HUNK BODY: file headers only
 * ever precede the first `@@`, so inside a body those prefixes are real content
 * (`-` prefixing `-- sql comment`, `+` prefixing `++x`) and skipping them
 * silently reclassifies a deletion as context.
 */
export function diffLines(patch: string, options: { fileHeaders?: boolean } = {}) {
  const fileHeaders = options.fileHeaders ?? true
  return patch.split("\n").map((text) => ({
    text,
    kind: text.startsWith("+") && !(fileHeaders && text.startsWith("+++"))
      ? "add"
      : text.startsWith("-") && !(fileHeaders && text.startsWith("---"))
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

export type HunkLocation = {
  start: number
  end: number
  /**
   * Leading whitespace the diff lost and the file still has, set when the hunk
   * only matched after dedenting both sides. opencode's edit tool strips the
   * indentation every content line of a diff shares (its `trimDiff`), so a
   * hunk inside an indented block arrives without it, and `oldText` needs it
   * back before it is written (`restoreIndent`).
   */
  indent?: string
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
 *   2. The same anchor compared with the indentation each side shares removed,
 *      for a diff that lost its indentation (#713).
 *   3. Unique substring match. If `newText` appears exactly once in the file
 *      we trust that location. Multiple occurrences = ambiguous → conflict.
 *   4. Unique dedented run of lines, under the same rule as 3.
 *
 * Returns `undefined` when no safe location can be determined.
 */
export function findHunkInFile(
  current: string,
  hunk: Pick<ReviewDiffHunk, "newText" | "newStart" | "newCount" | "leadingContext" | "trailingContext">,
): HunkLocation | undefined {
  // Pure-deletion hunks (`+N,0`): per unified-diff convention the anchor is
  // AFTER line N, so the restore point is the start of line N+1 — offset of
  // line index N, not N-1. (N=0, deletion at the very top, yields offset 0.)
  // Without this, the generic newStart-1 anchoring below matched the empty
  // candidate one line too early.
  if (hunk.newText === "" && hunk.newCount === 0) {
    const offset = lineToByteOffset(current, hunk.newStart)
    return { start: offset, end: offset }
  }

  // Primary: line-anchored exact match. We try a few variants because opencode
  // and the editor may disagree on trailing-newline normalization.
  const matchDedented = dedentedMatcher(hunk.newText)
  let lines: FileLine[] | undefined
  if (hunk.newStart > 0) {
    const startOffset = lineToByteOffset(current, hunk.newStart - 1)
    for (const candidate of newlineCandidates(hunk.newText)) {
      if (current.slice(startOffset, startOffset + candidate.length) === candidate) {
        return { start: startOffset, end: startOffset + candidate.length }
      }
    }
    if (matchDedented) {
      lines = fileLines(current)
      const located = matchDedented(lines, hunk.newStart - 1)
      if (located) return located
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
  if (!matchDedented) return undefined
  if (!lines) lines = fileLines(current)
  let found: HunkLocation | undefined
  for (let index = 0; index < lines.length; index++) {
    const located = matchDedented(lines, index)
    if (!located) continue
    if (found) return undefined
    found = located
  }
  return found
}

/**
 * Put back on each line of `text` the whitespace the diff lost. An empty line
 * stays empty: trimDiff cut blank lines too, so a line that is empty now may
 * have been empty or shorter than the cut, and only the empty reading adds no
 * trailing whitespace.
 */
export function restoreIndent(text: string, indent: string | undefined): string {
  if (!indent) return text
  return text.split("\n").map((line) => (line === "" ? line : indent + line)).join("\n")
}

type FileLine = { text: string; start: number; end: number }

/** Lines of `text` with their offsets; `end` excludes the terminator and a CR before it. */
function fileLines(text: string): FileLine[] {
  const lines: FileLine[] = []
  let offset = 0
  for (;;) {
    const newline = text.indexOf("\n", offset)
    const stop = newline < 0 ? text.length : newline
    const end = stop > offset && text[stop - 1] === "\r" ? stop - 1 : stop
    lines.push({ text: text.slice(offset, end), start: offset, end })
    if (newline < 0) return lines
    offset = newline + 1
  }
}

function leadingWhitespace(line: string): string {
  return line.slice(0, line.length - line.trimStart().length)
}

/** Strip the indentation the non-blank lines share, as opencode's trimDiff does. */
function dedent(lines: string[]): string[] {
  let shared = Infinity
  for (const line of lines) {
    if (line.trim() === "") continue
    shared = Math.min(shared, leadingWhitespace(line).length)
  }
  if (!Number.isFinite(shared) || shared === 0) return lines
  return lines.map((line) => line.slice(shared))
}

/**
 * Matcher for `newText` against the run of file lines starting at `index`,
 * both sides dedented. Undefined when `newText` has no non-blank line: a blank
 * run cannot tell which indentation it lost.
 */
function dedentedMatcher(newText: string) {
  const wanted = newText.split("\n").map((line) => line.replace(/\r$/, ""))
  const first = wanted.findIndex((line) => line.trim() !== "")
  if (first < 0) return undefined
  const dedented = dedent(wanted)
  const wantedIndent = leadingWhitespace(wanted[first]!).length
  return (lines: FileLine[], index: number): HunkLocation | undefined => {
    if (index < 0 || index + wanted.length > lines.length) return undefined
    const window = lines.slice(index, index + wanted.length).map((line) => line.text)
    const windowDedented = dedent(window)
    for (let i = 0; i < wanted.length; i++) {
      if (windowDedented[i] !== dedented[i]) return undefined
    }
    const lost = leadingWhitespace(window[first]!).length - wantedIndent
    if (lost < 0) return undefined
    return {
      start: lines[index]!.start,
      end: lines[index + wanted.length - 1]!.end,
      indent: window[first]!.slice(0, lost),
    }
  }
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
