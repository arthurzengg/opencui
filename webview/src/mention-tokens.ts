/**
 * Pure helpers for the inline-token system (@-mention / attachment chips and
 * web links). Kept separate from PromptBox.tsx so the component file is just
 * JSX + state, and so these functions can be tested without rendering
 * anything. PromptBox (composer backdrop) and MessageView (rendered bubble)
 * both consume findTokenRanges so the two surfaces highlight identically.
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

export type LinkRange = { start: number; end: number; url: string }

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" }

/**
 * Locate http(s) URLs in prose. The regex takes everything up to whitespace,
 * then trailing punctuation that reads as sentence structure is trimmed off —
 * `see https://example.com.` must not link the final dot. Closing brackets are
 * only trimmed when unbalanced within the match, so a Wikipedia-style
 * `/wiki/Foo_(bar)` keeps its paren while `(see https://example.com)` drops
 * it. http(s)-only by construction: no scheme like `javascript:` can ever
 * reach an href through this.
 */
export function findLinkRanges(text: string): LinkRange[] {
  const out: LinkRange[] = []
  const re = /https?:\/\/\S+/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    let url = m[0]
    while (url.length > 0) {
      const last = url[url.length - 1]!
      if (/[.,;:!?'"`<>]/.test(last)) {
        url = url.slice(0, -1)
        continue
      }
      const opener = CLOSERS[last]
      if (opener) {
        let balance = 0
        for (const ch of url) {
          if (ch === opener) balance++
          else if (ch === last) balance--
        }
        if (balance < 0) {
          url = url.slice(0, -1)
          continue
        }
      }
      break
    }
    if (url.replace(/^https?:\/\//i, "").length === 0) continue
    out.push({ start: m.index, end: m.index + url.length, url })
  }
  return out
}

export type TokenRange =
  | { start: number; end: number; kind: "mention" }
  | { start: number; end: number; kind: "link"; url: string }

/**
 * Merge mention and link ranges into one non-overlapping, sorted token list.
 * On overlap the earlier start wins: a URL containing `/@known/path` stays one
 * link (the mention inside it is incidental), while a chat chip whose label is
 * itself a URL (`@chat:https://…`) stays a chip (the user inserted it from
 * the picker; the URL inside is incidental).
 */
export function findTokenRanges(text: string, known: Set<string>): TokenRange[] {
  const merged: TokenRange[] = [
    ...findLinkRanges(text).map((r) => ({ ...r, kind: "link" as const })),
    ...findMentionRanges(text, known).map((r) => ({ ...r, kind: "mention" as const })),
  ].sort((a, b) => a.start - b.start)
  const out: TokenRange[] = []
  let prevEnd = -1
  for (const r of merged) {
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
