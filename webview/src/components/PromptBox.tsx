import { useRef, useState, type ReactNode } from "react"
import type { Attachment, FileSearchHit } from "../protocol"
import {
  extractMentions,
  findChipAtCaret,
  findMentionRanges,
  makeAttachmentLabel,
} from "../mention-tokens"
import { clipboardHasImage, readPastedImages } from "../paste-attachments"
import { usePromptText } from "../hooks/usePromptText"
import { useImageAttachments } from "../hooks/useImageAttachments"
import { useMentionPicker } from "../hooks/useMentionPicker"
import { ImagePreviewModal } from "./ImagePreviewModal"
import { ImageThumbnail } from "./ImageThumbnail"

// Re-export so existing consumers (tests, integrators) keep working through PromptBox.
export {
  detectMention,
  extractMentions,
  findChipAtCaret,
  findMentionRanges,
  makeAttachmentLabel,
  formatBytes,
} from "../mention-tokens"

type Props = {
  busy: boolean
  /**
   * True between user-pressed Stop and the subsequent sessionIdle. While true
   * we render a disabled "Stopping…" button instead of Stop — clicking Stop
   * a second time would be a no-op (abort is already in flight) and the user
   * shouldn't be able to type and Send a new prompt over the still-draining
   * one.
   */
  aborting?: boolean
  contextLabel?: string
  onSend: (text: string, mentions?: string[], attachments?: Attachment[]) => void
  onAbort: () => void
  searchFiles?: (query: string) => Promise<FileSearchHit[]>
  attachFile?: () => Promise<{ attachments: Attachment[]; error?: string }>
  /**
   * Pre-fill the input with text, mention paths, and attachments. Used by
   * MessageView's edit-in-place flow so the user picks up exactly where they
   * left off — same picker, same chips, same paperclip — instead of a
   * stripped-down textarea.
   */
  initial?: { text?: string; mentions?: string[]; attachments?: Attachment[] }
  /**
   * "send" (default) renders the standard Send/Stop bottom row. "edit"
   * renders Cancel + Save & regenerate, plus a warning that subsequent
   * replies will be discarded. onAbort is repurposed as the Cancel handler.
   */
  variant?: "send" | "edit"
}

function buildInitialAttachments(initial: Props["initial"]): Map<string, Attachment> {
  const map = new Map<string, Attachment>()
  if (!initial?.attachments) return map
  const existing = new Set<string>(initial.mentions ?? [])
  for (const a of initial.attachments) {
    // Image attachments are routed to the thumbnail strip
    // (`imageAttachments` state below) — they don't live in the
    // `@chip` text-token model. Skip them here.
    if (a.mime.startsWith("image/")) continue
    const label = makeAttachmentLabel(a.filename, existing)
    existing.add(label)
    map.set(label, a)
  }
  return map
}

export function PromptBox({ busy, aborting = false, contextLabel, onSend, onAbort, searchFiles, attachFile, initial, variant = "send" }: Props) {
  const { text, setText, ref, backdropRef, pendingCursor } = usePromptText(initial?.text ?? "")
  const [selectedChipStart, setSelectedChipStart] = useState<number | undefined>(undefined)
  const [attachError, setAttachError] = useState<string | undefined>(undefined)
  const [attaching, setAttaching] = useState(false)
  const {
    imageAttachments,
    addImages,
    removeImageAttachment,
    clearImageAttachments,
    previewImage,
    setPreviewImage,
  } = useImageAttachments(initial)
  // Use lazy init via "first render only" pattern so initial values aren't
  // re-applied every render. After mount these mutate freely.
  const knownMentions = useRef<Set<string>>(undefined as never)
  const knownAttachments = useRef<Map<string, Attachment>>(undefined as never)
  if (!knownMentions.current) {
    knownMentions.current = new Set<string>(initial?.mentions ?? [])
    knownAttachments.current = buildInitialAttachments(initial)
  }
  const { mention, hits, activeIndex, setActiveIndex, detectAtCaret, closeMention, insertMention } =
    useMentionPicker({ text, setText, searchFiles, knownMentions, pendingCursor })

  /** Combined set of @-token labels recognized as chips (mentions + attachments). */
  const allKnownLabels = (): Set<string> => {
    const all = new Set<string>(knownMentions.current)
    for (const k of knownAttachments.current.keys()) all.add(k)
    return all
  }

  const updateText = (next: string, caret: number) => {
    setText(next)
    setSelectedChipStart(undefined)
    detectAtCaret(next, caret)
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
    // Append pasted-image thumbnails after any chip-resolved attachments
    // so display order in the bubble matches input order: chip-cited
    // files first, pasted images second.
    for (const a of imageAttachments) activeAttachments.push(a)
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
    clearImageAttachments()
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
        // Image-mime attachments go to the thumbnail strip regardless of
        // source — paperclip-uploaded images get the same affordance as
        // pasted ones for visual consistency. Non-image attachments
        // (PDFs / .txt / code files) keep the existing `@chip` text-
        // token flow because their filenames carry user-meaningful
        // signal and the chip is the discoverable mention surface.
        const images = result.attachments.filter((a) => a.mime.startsWith("image/"))
        const nonImages = result.attachments.filter((a) => !a.mime.startsWith("image/"))
        addImages(images)
        if (nonImages.length > 0) {
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
          for (const att of nonImages) {
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
      }
      if (result.error) setAttachError(result.error)
    } finally {
      setAttaching(false)
    }
  }

  /**
   * Clipboard paste: if it contains any image, intercept and push each one
   * onto the thumbnail strip above the textarea (no `@filename` text
   * token — pasted images have synthesised names that mean nothing, so
   * the screenshot itself is the affordance). Any pasted text accompanying
   * the image still goes into the textarea at the caret position.
   * Pure-text paste falls through to the browser's default handling.
   */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!clipboardHasImage(e.clipboardData)) return
    e.preventDefault()
    void handlePastedImages(e.clipboardData)
  }

  const handlePastedImages = async (data: DataTransfer) => {
    setAttachError(undefined)
    const result = await readPastedImages(data)
    if (result.attachments.length === 0 && !result.text) {
      if (result.error) setAttachError(result.error)
      return
    }
    addImages(result.attachments)
    // Mixed text+image pastes still insert the text portion at the caret
    // (the image goes to the thumbnail strip independently).
    if (result.text) {
      const ta = ref.current
      const caret = ta?.selectionStart ?? text.length
      const before = text.slice(0, caret)
      const after = text.slice(caret)
      const next = before + result.text + after
      pendingCursor.current = before.length + result.text.length
      setText(next)
    }
    if (result.error) setAttachError(result.error)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // If an IME composition is in progress (e.g. typing Chinese pinyin),
    // Enter belongs to the IME — it commits the candidate, NOT submits the
    // message. Same for Tab (some IMEs use it to cycle candidates) and the
    // picker's nav keys. Bail out so the textarea keeps the keystroke for
    // the IME. keyCode 229 is the legacy fallback for older Chromium builds
    // that don't surface isComposing reliably.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
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
    // In edit variant, Escape cancels (matches the original edit-textarea UX).
    if (variant === "edit" && e.key === "Escape") {
      e.preventDefault()
      onAbort()
      return
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

  // Send is enabled if there's text OR a chip-cited attachment in the text
  // OR a thumbnail in the pasted strip.
  const hasActiveAttachment = (() => {
    if (imageAttachments.length > 0) return true
    if (knownAttachments.current.size === 0) return false
    return findMentionRanges(text, new Set(knownAttachments.current.keys())).length > 0
  })()

  return (
    <div className={"promptbox" + (variant === "edit" ? " promptbox--edit" : "")}>
      {contextLabel && <div className="context-chip">{contextLabel}</div>}
      {attachError && <div className="attachment-error">{attachError}</div>}
      {imageAttachments.length > 0 && (
        <ul className="promptbox-thumbs" aria-label="Image attachments">
          {imageAttachments.map((a) => (
            <ImageThumbnail
              key={a.id}
              attachment={a}
              onPreview={setPreviewImage}
              onRemove={removeImageAttachment}
            />
          ))}
        </ul>
      )}
      <ImagePreviewModal
        src={previewImage ? { dataUrl: previewImage.dataUrl, filename: previewImage.filename } : null}
        onClose={() => setPreviewImage(null)}
      />
      <div className="promptbox-input">
        <div ref={backdropRef} className="promptbox-backdrop" aria-hidden="true">
          {renderHighlightedText(text, allKnownLabels(), selectedChipStart)}
        </div>
        <textarea
          ref={ref}
          value={text}
          rows={2}
          placeholder="Ask OpenCode Panel…  (Enter to send, Shift+Enter for newline, @ to attach a file)"
          onChange={(e) => updateText(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
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
            aria-label="Attach image, PDF, or code/text file"
            title="Attach image, PDF, or code/text file"
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
        {variant === "edit" ? (
          <button
            className="btn primary icon"
            onClick={submit}
            disabled={busy || (!text.trim() && !hasActiveAttachment)}
            aria-label="Save & regenerate"
            title="Save & regenerate"
          >
            <SendIcon />
          </button>
        ) : aborting ? (
          <button
            className="btn danger icon"
            disabled
            aria-busy="true"
            aria-label="Stopping…"
            title="Stopping…"
          >
            <StopIcon />
          </button>
        ) : busy ? (
          <button
            className="btn danger icon"
            onClick={onAbort}
            aria-label="Stop"
            title="Stop"
          >
            <StopIcon />
          </button>
        ) : (
          <button
            className="btn primary icon"
            onClick={submit}
            disabled={!text.trim() && !hasActiveAttachment}
            aria-label="Send"
            title="Send"
          >
            <SendIcon />
          </button>
        )}
      </div>
    </div>
  )
}

function SendIcon() {
  // Same `display: block` reasoning as StopIcon — removes the SVG's
  // default inline baseline drift so the arrow sits on the button's
  // exact centre line. 10×10 in an 18-px button → 4-px margin per side.
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ display: "block" }}>
      <path
        d="M8 13.5 V2.5 M3.5 7 L8 2.5 L12.5 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function StopIcon() {
  // 8×8 in an 18-px button → 5-px margin on each side. Even numbers avoid
  // the sub-pixel rounding that made the square look slightly off-centre
  // at 7×7.
  return (
    <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true" style={{ display: "block" }}>
      <rect x="0" y="0" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
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
