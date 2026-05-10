import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import type { Attachment, FileSearchHit } from "../protocol"

type Props = {
  busy: boolean
  contextLabel?: string
  onSend: (text: string, mentions?: string[], attachments?: Attachment[]) => void
  onAbort: () => void
  searchFiles?: (query: string) => Promise<FileSearchHit[]>
  attachFile?: () => Promise<{ attachments: Attachment[]; error?: string }>
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

type MentionState = {
  /** Index of the @ that triggered the picker. */
  start: number
  /** Query typed after the @ (excluding the @ itself). */
  query: string
}

const MAX_VISIBLE_HITS = 8

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
    // Whitespace cancels the mention scan; @path tokens are word-like.
    if (ch && /\s/.test(ch)) return undefined
  }
  return undefined
}

/**
 * From a textarea text, return the set of `@path` tokens that match a known
 * mention path. The leading boundary is intentionally NOT required to be
 * whitespace — `look@src/foo.ts` is a valid chip, mirroring `detectMention`'s
 * relaxed trigger. The trailing boundary still must be whitespace (or
 * end-of-string), so `@foo.ts` inside `@foo.tsx` does not match.
 */
export function extractMentions(text: string, known: Set<string>): string[] {
  const out: string[] = []
  for (const path of known) {
    const token = "@" + path
    const idx = text.indexOf(token)
    if (idx < 0) continue
    const after = text[idx + token.length] ?? ""
    if (after && !/\s/.test(after)) continue
    out.push(path)
  }
  return out
}

/**
 * Find a known @path token whose right edge sits at the caret. Allows the
 * caret to be one position past the end of the chip when the next char is a
 * space — this covers the cursor position right after the auto-inserted
 * trailing space, which is where the user lands after picking from the menu.
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
 * the trailing boundary still must be whitespace or end-of-string, so
 * `@foo.ts` inside `@foo.tsx` doesn't match.
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
  // Drop overlapping ranges (shouldn't happen, but guard anyway)
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

export function PromptBox({ busy, contextLabel, onSend, onAbort, searchFiles, attachFile }: Props) {
  const [text, setText] = useState("")
  const [hits, setHits] = useState<FileSearchHit[]>([])
  const [mention, setMention] = useState<MentionState | undefined>(undefined)
  const [activeIndex, setActiveIndex] = useState(0)
  const [selectedChipStart, setSelectedChipStart] = useState<number | undefined>(undefined)
  const [attachError, setAttachError] = useState<string | undefined>(undefined)
  const [attaching, setAttaching] = useState(false)
  const knownMentions = useRef(new Set<string>())
  const knownAttachments = useRef(new Map<string, Attachment>())
  const ref = useRef<HTMLTextAreaElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const queryRef = useRef("")
  const pendingCursor = useRef<number | null>(null)

  /** Combined set of @-token labels recognized as chips (mentions + attachments). */
  const allKnownLabels = (): Set<string> => {
    const all = new Set<string>(knownMentions.current)
    for (const k of knownAttachments.current.keys()) all.add(k)
    return all
  }

  useEffect(() => {
    if (!ref.current) return
    ref.current.style.height = "auto"
    ref.current.style.height = Math.min(ref.current.scrollHeight, 200) + "px"
    if (backdropRef.current) {
      backdropRef.current.style.height = ref.current.style.height
    }
  }, [text])

  useLayoutEffect(() => {
    if (pendingCursor.current !== null && ref.current) {
      ref.current.focus()
      ref.current.setSelectionRange(pendingCursor.current, pendingCursor.current)
      pendingCursor.current = null
    }
  }, [text])

  useEffect(() => {
    if (!mention || !searchFiles) {
      setHits([])
      return
    }
    queryRef.current = mention.query
    let cancelled = false
    void searchFiles(mention.query).then((results) => {
      if (cancelled) return
      // Drop stale results — the user may have kept typing while we awaited.
      if (queryRef.current !== mention.query) return
      setHits(results.slice(0, MAX_VISIBLE_HITS))
      setActiveIndex(0)
    })
    return () => {
      cancelled = true
    }
  }, [mention, searchFiles])

  const closeMention = () => {
    setMention(undefined)
    setHits([])
  }

  const updateText = (next: string, caret: number) => {
    setText(next)
    setSelectedChipStart(undefined)
    if (!searchFiles) return
    const detected = detectMention(next, caret)
    setMention(detected)
  }

  const insertMention = (hit: FileSearchHit) => {
    if (!mention) return
    const before = text.slice(0, mention.start)
    const after = text.slice(mention.start + 1 + mention.query.length)
    const insert = "@" + hit.path
    const needsSpace = !after.startsWith(" ")
    const next = before + insert + (needsSpace ? " " : "") + after
    knownMentions.current.add(hit.path)
    pendingCursor.current = before.length + insert.length + 1
    setText(next)
    closeMention()
  }

  const submit = () => {
    const trimmed = text.trim()
    const activeAttachments: Attachment[] = []
    if (knownAttachments.current.size > 0) {
      const labelsInText = extractMentions(text, new Set(knownAttachments.current.keys()))
      for (const label of labelsInText) {
        const att = knownAttachments.current.get(label)
        if (att) activeAttachments.push(att)
      }
    }
    if ((!trimmed && activeAttachments.length === 0) || busy) return
    const mentions = extractMentions(text, knownMentions.current)
    onSend(
      trimmed,
      mentions.length ? mentions : undefined,
      activeAttachments.length ? activeAttachments : undefined,
    )
    setText("")
    knownMentions.current.clear()
    knownAttachments.current.clear()
    setSelectedChipStart(undefined)
    setAttachError(undefined)
    closeMention()
  }

  const handleAttachClick = async () => {
    if (!attachFile || attaching) return
    setAttaching(true)
    setAttachError(undefined)
    try {
      const result = await attachFile()
      if (result.attachments.length > 0) {
        const ta = ref.current
        const caret = ta?.selectionStart ?? text.length
        const before = text.slice(0, caret)
        const after = text.slice(caret)
        // Build "@label1 @label2 " insertion, registering each label.
        let insertion = ""
        const existing = new Set([
          ...knownMentions.current,
          ...knownAttachments.current.keys(),
        ])
        for (const att of result.attachments) {
          const label = makeAttachmentLabel(att.filename, existing)
          existing.add(label)
          knownAttachments.current.set(label, att)
          insertion += "@" + label + " "
        }
        // If the char before the caret is non-whitespace, we need a leading
        // space so the @ token has a whitespace boundary on its left.
        const lastBeforeChar = before.slice(-1)
        const needsLeadingSpace = lastBeforeChar !== "" && !/\s/.test(lastBeforeChar)
        const lead = needsLeadingSpace ? " " : ""
        // Trim our trailing space if there's already whitespace after the caret.
        const trimTrailing = after.startsWith(" ")
        const finalInsertion = lead + (trimTrailing ? insertion.trimEnd() : insertion)
        const next = before + finalInsertion + after
        pendingCursor.current = before.length + finalInsertion.length
        setText(next)
      }
      if (result.error) setAttachError(result.error)
    } finally {
      setAttaching(false)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && hits.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setActiveIndex((i) => (i + 1) % hits.length)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setActiveIndex((i) => (i - 1 + hits.length) % hits.length)
        return
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const choice = hits[activeIndex]
        if (choice) insertMention(choice)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        closeMention()
        return
      }
    }
    if (e.key === "Backspace" && !e.shiftKey && !e.metaKey && !e.altKey) {
      const ta = e.currentTarget
      // Only intercept when there's no real text selection
      if (ta.selectionStart === ta.selectionEnd) {
        const caret = ta.selectionStart ?? 0
        const chip = findChipAtCaret(text, caret, allKnownLabels())
        if (chip) {
          e.preventDefault()
          if (selectedChipStart === chip.start) {
            // Second press → delete the chip (and the trailing space the picker added).
            const deleteEnd = chip.end + (chip.trailingSpace ? 1 : 0)
            const next = text.slice(0, chip.start) + text.slice(deleteEnd)
            pendingCursor.current = chip.start
            setSelectedChipStart(undefined)
            setText(next)
          } else {
            // First press → highlight and wait.
            setSelectedChipStart(chip.start)
          }
          return
        }
      }
    }
    if (e.key !== "Backspace" && selectedChipStart !== undefined) {
      setSelectedChipStart(undefined)
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  const onSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    if (selectedChipStart === undefined) return
    const ta = e.currentTarget
    const caret = ta.selectionStart ?? 0
    const chip = findChipAtCaret(text, caret, allKnownLabels())
    if (!chip || chip.start !== selectedChipStart) {
      setSelectedChipStart(undefined)
    }
  }

  // Send is enabled if there's text OR an attachment chip currently in the text.
  const hasActiveAttachment = (() => {
    if (knownAttachments.current.size === 0) return false
    return findMentionRanges(text, new Set(knownAttachments.current.keys())).length > 0
  })()

  return (
    <div className="promptbox">
      {contextLabel && <div className="context-chip">{contextLabel}</div>}
      {attachError && <div className="attachment-error">{attachError}</div>}
      <div className="promptbox-input">
        <div ref={backdropRef} className="promptbox-backdrop" aria-hidden="true">
          {renderHighlightedText(text, allKnownLabels(), selectedChipStart)}
        </div>
        <textarea
          ref={ref}
          value={text}
          rows={2}
          placeholder="Ask OpenCUI…  (Enter to send, Shift+Enter for newline, @ to attach a file)"
          onChange={(e) => updateText(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
          onSelect={onSelect}
          onScroll={(e) => {
            if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop
          }}
          onBlur={() => {
            // Defer so onMouseDown on a hit can fire first.
            setTimeout(closeMention, 120)
          }}
        />
        {mention && hits.length > 0 && (
          <ul className="mention-popover" role="listbox" aria-label="Files">
            {hits.map((hit, i) => (
              <li
                key={hit.path}
                role="option"
                aria-selected={i === activeIndex}
                className={"mention-hit" + (i === activeIndex ? " active" : "")}
                onMouseDown={(e) => {
                  e.preventDefault()
                  insertMention(hit)
                }}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <span className="mention-name">{hit.name}</span>
                <span className="mention-path">{hit.path}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="promptbox-row">
        {attachFile && (
          <button
            type="button"
            className="icon-btn attach-btn"
            aria-label="Attach image or PDF"
            title="Attach image or PDF"
            disabled={attaching || busy}
            onClick={handleAttachClick}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M10.5 2.5a3 3 0 0 1 3 3v6.5a3.5 3.5 0 0 1-7 0V5a2 2 0 1 1 4 0v6.5a1.5 1.5 0 0 1-3 0V5.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
        <div className="spacer" />
        {busy ? (
          <button className="btn danger" onClick={onAbort}>
            Stop
          </button>
        ) : (
          <button
            className="btn primary"
            onClick={submit}
            disabled={!text.trim() && !hasActiveAttachment}
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Render `text` for the backdrop layer: known @path tokens are wrapped in a
 * `.mention-chip` span so they get a colored background through the
 * transparent textarea above. The rendered text width must remain
 * character-for-character identical to the textarea, so the chip is purely
 * a colored background — no padding/border that would shift glyph positions.
 */
export function renderHighlightedText(
  text: string,
  known: Set<string>,
  selectedChipStart?: number,
): ReactNode[] {
  const ranges = findMentionRanges(text, known)
  if (ranges.length === 0) {
    return [text + "\n"]
  }
  const out: ReactNode[] = []
  let cursor = 0
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i]!
    if (r.start > cursor) out.push(text.slice(cursor, r.start))
    const selected = selectedChipStart === r.start
    out.push(
      <span
        key={r.start}
        className={"mention-chip" + (selected ? " mention-chip-selected" : "")}
      >
        {text.slice(r.start, r.end)}
      </span>,
    )
    cursor = r.end
  }
  if (cursor < text.length) out.push(text.slice(cursor))
  out.push("\n")
  return out
}
