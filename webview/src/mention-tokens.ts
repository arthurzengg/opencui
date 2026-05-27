/**
 * Pure helpers for the @-mention / attachment-chip system. Kept separate from
 * PromptBox.tsx so the component file is just JSX + state, and so these
 * functions can be tested without rendering anything.
 */

export type MentionState = {
  /** Index of the @ that triggered the picker. */
  start: number
  /** Query typed after the @ (excluding the @ itself). */
  query: string
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Returns the active @-mention if the cursor is inside one, else undefined.
 * Triggers regardless of what precedes the @ — `look@` should open the picker
 * just like `look @`. The picker is non-modal (Escape dismisses), so over-
 * triggering on email-style fragments is harmless.
 */
export function detectMention(text: string, caret: number): MentionState | undefined {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === "@") {
      return { start: i, query: text.slice(i + 1, caret) }
    }
    if (ch && /\s/.test(ch)) return undefined
  }
  return undefined
}

/**
 * From a textarea text, return the set of `@path` tokens that match a known
 * mention path. The leading boundary is intentionally NOT required to be
 * whitespace — `look@src/foo.ts` is a valid chip, mirroring detectMention's
 * relaxed trigger. The trailing boundary still must be whitespace (or
 * end-of-string), so `@foo.ts` inside `@foo.tsx` does not match.
 */
export function extractMentions(text: string, known: Set<string>): string[] {
  const out: string[] = []
  for (const path of known) {
    const token = "@" + path
    // Loop past prefix collisions: when `path` is a prefix of another known
    // path (`src/foo.ts` vs `src/foo.tsx`), the first occurrence inside the
    // longer chip fails the trailing-boundary check — but a later occurrence
    // may still be valid.
    let from = 0
    while (true) {
      const idx = text.indexOf(token, from)
      if (idx < 0) break
      const after = text[idx + token.length] ?? ""
      if (!after || /\s/.test(after)) {
        out.push(path)
        break
      }
      from = idx + token.length
    }
  }
  return out
}

/**
 * Find a known @path token whose right edge sits at the caret. Allows the
 * caret to be one position past the end of the chip when the next char is a
 * space — this covers the cursor position right after the auto-inserted
 * trailing space.
 */
export function findChipAtCaret(
  text: string,
  caret: number,
  known: Set<string>,
): { start: number; end: number; trailingSpace: boolean } | undefined {
  const ranges = findMentionRanges(text, known)
  for (const r of ranges) {
    if (caret === r.end) return { start: r.start, end: r.end, trailingSpace: false }
    if (caret === r.end + 1 && text[r.end] === " ") {
      return { start: r.start, end: r.end, trailingSpace: true }
    }
  }
  return undefined
}

/**
 * Locate every @path token belonging to `known` within `text`. The leading
 * boundary is NOT required to be whitespace (so `look@src/foo.ts` is matched);
 * the trailing boundary still must be whitespace or end-of-string.
 */
export function findMentionRanges(text: string, known: Set<string>): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  for (const path of known) {
    const token = "@" + path
    let from = 0
    while (true) {
      const idx = text.indexOf(token, from)
      if (idx < 0) break
      const after = text[idx + token.length] ?? ""
      if (!after || /\s/.test(after)) {
        ranges.push({ start: idx, end: idx + token.length })
      }
      from = idx + token.length
    }
  }
  ranges.sort((a, b) => a.start - b.start)
  const out: Array<{ start: number; end: number }> = []
  let prevEnd = -1
  for (const r of ranges) {
    if (r.start >= prevEnd) {
      out.push(r)
      prevEnd = r.end
    }
  }
  return out
}

export function makeConversationLabel(title: string, existing: Set<string>): string {
  const cleaned = "chat:" + title.replace(/\s+/g, "_").slice(0, 60)
  if (!existing.has(cleaned)) return cleaned
  let i = 2
  while (existing.has(`${cleaned}_${i}`)) i++
  return `${cleaned}_${i}`
}

/**
 * Build a chip-safe label for an attachment filename. Spaces would break the
 * `@token` boundary detection, so we replace whitespace with `_`. If the
 * resulting label is already in `existing`, append `_2`, `_3`, … before the
 * extension to keep it unique.
 */
export function makeAttachmentLabel(filename: string, existing: Set<string>): string {
  const cleaned = filename.replace(/\s+/g, "_")
  if (!existing.has(cleaned)) return cleaned
  const dot = cleaned.lastIndexOf(".")
  const base = dot >= 0 ? cleaned.slice(0, dot) : cleaned
  const ext = dot >= 0 ? cleaned.slice(dot) : ""
  let i = 2
  while (existing.has(`${base}_${i}${ext}`)) i++
  return `${base}_${i}${ext}`
}
