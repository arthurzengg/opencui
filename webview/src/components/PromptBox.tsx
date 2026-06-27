import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import type { Attachment, CommandInfo, ContextUsage, ConversationSummary, DirEntry, FileSearchHit } from "../protocol"
import {
  extractMentions,
  findChipAtCaret,
  findMentionRanges,
  makeAttachmentLabel,
  makeConversationLabel,
} from "../mention-tokens"
import { parseCommandInput } from "../command-tokens"
import { clipboardHasImage, readPastedImages } from "../paste-attachments"
import { usePromptText } from "../hooks/usePromptText"
import { useImageAttachments } from "../hooks/useImageAttachments"
import { useMentionPicker } from "../hooks/useMentionPicker"
import { useCommandPicker } from "../hooks/useCommandPicker"
import { useFileBrowser } from "../hooks/useFileBrowser"
import {
  conversationDisplayTitle,
  conversationMatchesQuery,
  formatConversationUpdated,
  groupConversationsByTime,
} from "../conversation-groups"
import { ImagePreviewModal } from "./ImagePreviewModal"
import { ImageThumbnail } from "./ImageThumbnail"
import { ICON_SIZE } from "../design-tokens"
import { fileTypeCodicon } from "../file-icons"

// Re-export so existing consumers (tests, integrators) keep working through PromptBox.
export {
  detectMention,
  extractMentions,
  findChipAtCaret,
  findMentionRanges,
  makeAttachmentLabel,
  makeConversationLabel,
  formatBytes,
} from "../mention-tokens"
export { detectCommand, filterCommands, parseCommandInput } from "../command-tokens"

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
  onSend: (text: string, mentions?: string[], attachments?: Attachment[], conversationMentions?: string[]) => void
  onAbort: () => void
  searchFiles?: (query: string) => Promise<FileSearchHit[]>
  listDir?: (path: string) => Promise<DirEntry[]>
  attachFile?: () => Promise<{ attachments: Attachment[]; error?: string }>
  /**
   * Pre-fill the input with text, mention paths, and attachments. Used by
   * MessageView's edit-in-place flow so the user picks up exactly where they
   * left off — same picker, same chips, same paperclip — instead of a
   * stripped-down textarea.
   */
  initial?: { text?: string; mentions?: string[]; attachments?: Attachment[]; conversationMentions?: string[] }
  /**
   * "send" (default) renders the standard Send/Stop bottom row. "edit"
   * renders Cancel + Save & regenerate, plus a warning that subsequent
   * replies will be discarded. onAbort is repurposed as the Cancel handler.
   */
  variant?: "send" | "edit"
  position?: "top" | "bottom"
  conversations?: ConversationSummary[]
  activeConversationID?: string
  onOpenConversation?: (id: string) => void
  contextUsage?: ContextUsage
  /** Workspace opencode commands for the `/` picker. Empty disables it. */
  commands?: CommandInfo[]
  /**
   * Run an opencode command. Only wired for the primary send composer — the
   * in-message edit composers leave it undefined so a `/`-leading edit stays a
   * normal prompt edit (preserving revert semantics).
   */
  onRunCommand?: (command: string, args: string) => void
  /**
   * One-shot host signal to set the composer text (e.g. `/undo` restoring the
   * undone prompt, `/redo` clearing it). The nonce makes identical text re-apply.
   * Only wired for the send composers; the parent reducer clears it after a send
   * or conversation switch so a re-mounted composer never re-applies stale text.
   */
  inject?: { text: string; nonce: number }
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

function buildInitialConversations(
  initial: Props["initial"],
  conversations: ConversationSummary[] | undefined,
): Map<string, string> {
  const map = new Map<string, string>()
  if (!initial?.conversationMentions) return map
  const existing = new Set<string>(initial.mentions ?? [])
  const labelsInText = extractConversationLabels(initial.text)
  for (const [index, id] of initial.conversationMentions.entries()) {
    const conv = conversations?.find((c) => c.id === id)
    const preservedLabel = labelsInText[index]
    const label = preservedLabel && !existing.has(preservedLabel)
      ? preservedLabel
      : conv
        ? makeConversationLabel(conversationDisplayTitle(conv), existing)
        : preservedLabel
    if (!label) continue
    existing.add(label)
    map.set(label, id)
  }
  return map
}

function extractConversationLabels(text: string | undefined): string[] {
  if (!text) return []
  return Array.from(text.matchAll(/@chat:\S+/g), (match) => match[0].slice(1))
}

export function PromptBox({ busy, aborting = false, onSend, onAbort, searchFiles, listDir, attachFile, initial, variant = "send", position = "bottom", conversations, activeConversationID, onOpenConversation, contextUsage, commands = [], onRunCommand, inject }: Props) {
  const { text, setText, ref, backdropRef, pendingCursor } = usePromptText(initial?.text ?? "")
  // The Send button renders a disabled "Stopping…" while aborting, but Enter
  // routes through submit() — both must honor the same block, or a prompt
  // races the in-flight abort and gets its early events dropped.
  const sendBlocked = busy || aborting
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
  const knownConversations = useRef<Map<string, string>>(undefined as never)
  if (!knownMentions.current) {
    knownMentions.current = new Set<string>(initial?.mentions ?? [])
    knownAttachments.current = buildInitialAttachments(initial)
    knownConversations.current = buildInitialConversations(initial, conversations)
    for (const label of knownConversations.current.keys()) knownMentions.current.add(label)
  }
  const { mention, hits, activeIndex, setActiveIndex, detectAtCaret, closeMention, insertMention } =
    useMentionPicker({ text, setText, searchFiles, knownMentions, pendingCursor })
  const {
    command,
    filtered: commandHits,
    activeIndex: commandIndex,
    setActiveIndex: setCommandIndex,
    detectAtCaret: detectCommandAtCaret,
    closeCommand,
    insertCommand,
  } = useCommandPicker({ text, setText, commands, pendingCursor })

  // Apply host-driven composer text on each nonce bump (e.g. /undo restoring the
  // undone prompt). pendingCursor places the caret at the end after setText.
  useEffect(() => {
    if (!inject) return
    setText(inject.text)
    pendingCursor.current = inject.text.length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inject?.nonce])

  type MentionCategory = "files" | "chats"
  const [mentionCategory, setMentionCategory] = useState<MentionCategory | null>(null)
  const [menuIndex, setMenuIndex] = useState(0)

  useEffect(() => {
    if (!mention) {
      setMentionCategory(null)
      setMenuIndex(0)
    }
  }, [mention])

  const showCategoryMenu = !!mention && mentionCategory === null && !mention.query
  // Browse the project tree when the Files category is open and nothing's been
  // typed yet; typing a query switches to the flat fuzzy search below. Requires
  // the host's listDir — without it we fall back to the flat search so the
  // picker still works (and existing flat-search tests stay valid).
  const showBrowse = !!mention && mentionCategory === "files" && !mention.query && !!listDir
  const showFileHits = !showBrowse && !!mention && hits.length > 0 && (mentionCategory === "files" || (mentionCategory === null && !!mention.query))
  const showChatList = !!mention && mentionCategory === "chats"

  const {
    dir: browseDir,
    entries: browseEntries,
    index: browseIndex,
    setIndex: setBrowseIndex,
    canGoUp,
    drillInto,
    goUp,
  } = useFileBrowser({ listDir, active: showBrowse })

  const pastConversations = (conversations ?? []).filter((c) => c.id !== activeConversationID)
  const filteredConversations = showChatList
    ? pastConversations.filter((c) => conversationMatchesQuery(c, mention.query))
    : []
  const chatGroups = showChatList ? groupConversationsByTime(filteredConversations, Date.now()) : []
  // Keyboard nav runs over the flattened (grouped) order so the active index
  // lines up with the conversations rendered under the section headers.
  const flatConversations = chatGroups.flatMap((g) => g.conversations)

  useEffect(() => {
    if (showChatList) setMenuIndex(0)
  }, [showChatList, mention?.query])

  useEffect(() => {
    if (!showChatList) return
    setMenuIndex((i) => flatConversations.length === 0 ? 0 : Math.min(i, flatConversations.length - 1))
  }, [showChatList, flatConversations.length])

  /** Combined set of @-token labels recognized as chips (mentions + attachments + conversations). */
  const allKnownLabels = (): Set<string> => {
    const all = new Set<string>(knownMentions.current)
    for (const k of knownAttachments.current.keys()) all.add(k)
    for (const k of knownConversations.current.keys()) all.add(k)
    return all
  }

  const insertConversationMention = (conv: ConversationSummary) => {
    if (!mention) return
    const existing = new Set([
      ...knownMentions.current,
      ...knownAttachments.current.keys(),
      ...knownConversations.current.keys(),
    ])
    const label = makeConversationLabel(conv.title, existing)
    knownConversations.current.set(label, conv.id)
    knownMentions.current.add(label)
    const before = text.slice(0, mention.start)
    const after = text.slice(mention.start + 1 + mention.query.length)
    const insert = "@" + label
    const needsSpace = !after.startsWith(" ")
    const next = before + insert + (needsSpace ? " " : "") + after
    pendingCursor.current = before.length + insert.length + 1
    setText(next)
    closeMention()
  }

  const updateText = (next: string, caret: number) => {
    setText(next)
    setSelectedChipStart(undefined)
    // The `/` and `@` pickers are mutually exclusive: a leading slash command
    // wins, and we close the mention picker so they never render together.
    if (detectCommandAtCaret(next, caret)) {
      closeMention()
      return
    }
    detectAtCaret(next, caret)
  }

  /** Clear the composer to its empty state after a send or command run. */
  const clearComposer = () => {
    setText("")
    knownMentions.current.clear()
    knownAttachments.current.clear()
    knownConversations.current.clear()
    clearImageAttachments()
    setSelectedChipStart(undefined)
    setAttachError(undefined)
    closeMention()
    closeCommand()
  }

  const runCommandAndClear = (command: string, args: string) => {
    // Respect busy/aborting on the picker-run path too (submit guards both).
    if (sendBlocked || !onRunCommand) return
    onRunCommand(command, args)
    clearComposer()
  }

  /**
   * Pick path for the `/` dropdown. A command whose template takes `$ARGUMENTS`
   * inserts `/name ` and waits for the user to type args; an argument-less
   * command runs the moment it is chosen.
   */
  const chooseCommand = (cmd: CommandInfo) => {
    if (cmd.takesArguments) insertCommand(cmd)
    else runCommandAndClear(cmd.name, "")
  }

  const submit = () => {
    const trimmed = text.trim()
    // Route a typed `/name args` to the command path when the name matches a
    // known command. Unknown slashes (and prose like `/etc/hosts`) fall through
    // to a normal prompt send. Edit composers never route (no onRunCommand).
    if (variant === "send" && !sendBlocked && onRunCommand) {
      const parsed = parseCommandInput(trimmed)
      if (parsed && commands.some((c) => c.name === parsed.name)) {
        runCommandAndClear(parsed.name, parsed.args)
        return
      }
    }
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
    if ((!trimmed && activeAttachments.length === 0) || sendBlocked) return
    const allMentions = extractMentions(text, knownMentions.current)
    const fileMentions = allMentions.filter((m) => !knownConversations.current.has(m))
    const convIDs = allMentions
      .map((m) => knownConversations.current.get(m))
      .filter((id): id is string => !!id)
    onSend(
      trimmed,
      fileMentions.length ? fileMentions : undefined,
      activeAttachments.length ? activeAttachments : undefined,
      convIDs.length ? convIDs : undefined,
    )
    clearComposer()
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
    if (command) {
      // When nothing matches we only handle Escape — Enter must fall through to
      // submit so `/unknown` sends as a normal prompt.
      if (commandHits.length === 0) {
        if (e.key === "Escape") {
          e.preventDefault()
          closeCommand()
          return
        }
      } else {
        if (e.key === "ArrowDown") {
          e.preventDefault()
          setCommandIndex((i) => (i + 1) % commandHits.length)
          return
        }
        if (e.key === "ArrowUp") {
          e.preventDefault()
          setCommandIndex((i) => (i - 1 + commandHits.length) % commandHits.length)
          return
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault()
          const cmd = commandHits[commandIndex]
          if (cmd) chooseCommand(cmd)
          return
        }
        if (e.key === "Escape") {
          e.preventDefault()
          closeCommand()
          return
        }
      }
    }
    if (showCategoryMenu) {
      const categories: MentionCategory[] = ["files", "chats"]
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setMenuIndex((i) => (i + 1) % categories.length)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setMenuIndex((i) => (i - 1 + categories.length) % categories.length)
        return
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        setMentionCategory(categories[menuIndex]!)
        setMenuIndex(0)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        closeMention()
        return
      }
    }
    if (showChatList) {
      if (e.key === "Escape") {
        e.preventDefault()
        closeMention()
        return
      }
      if (flatConversations.length === 0) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Tab") {
          e.preventDefault()
          return
        }
      }
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setMenuIndex((i) => (i + 1) % flatConversations.length)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setMenuIndex((i) => (i - 1 + flatConversations.length) % flatConversations.length)
        return
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const conv = flatConversations[menuIndex]
        if (conv) insertConversationMention(conv)
        return
      }
    }
    if (showFileHits && hits.length > 0) {
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
    if (showBrowse) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        if (browseEntries.length > 0) setBrowseIndex((i) => (i + 1) % browseEntries.length)
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        if (browseEntries.length > 0) setBrowseIndex((i) => (i - 1 + browseEntries.length) % browseEntries.length)
        return
      }
      if (e.key === "ArrowRight") {
        const entry = browseEntries[browseIndex]
        if (entry?.kind === "folder") {
          e.preventDefault()
          drillInto(entry)
          return
        }
      }
      if (e.key === "ArrowLeft" && canGoUp) {
        e.preventDefault()
        goUp()
        return
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const entry = browseEntries[browseIndex]
        if (entry?.kind === "folder") drillInto(entry)
        else if (entry) insertMention(entry)
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

  const classes = [
    "promptbox",
    variant === "edit" ? "promptbox--edit" : "promptbox--send",
    position === "top" ? "promptbox--top" : variant === "send" ? "promptbox--bottom" : "",
  ].filter(Boolean).join(" ")

  return (
    <div className={classes}>
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
        <div className="promptbox-textarea-wrap">
        <div ref={backdropRef} className="promptbox-backdrop" aria-hidden="true">
          {renderHighlightedText(text, allKnownLabels(), selectedChipStart)}
        </div>
        <textarea
          ref={ref}
          value={text}
          rows={variant === "edit" ? 1 : position === "top" ? 3 : 2}
          placeholder="/ for commands, @ for files, Enter to send"
          onChange={(e) => updateText(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onSelect={onSelect}
          onScroll={(e) => {
            if (backdropRef.current) backdropRef.current.scrollTop = e.currentTarget.scrollTop
          }}
          onBlur={() => {
            // Defer so onMouseDown on a hit can fire first.
            setTimeout(() => {
              closeMention()
              closeCommand()
            }, 120)
          }}
        />
        {showCategoryMenu && (
          <ul className="mention-popover" role="listbox" aria-label="Categories">
            <li
              role="option"
              aria-selected={menuIndex === 0}
              className={"mention-hit mention-category" + (menuIndex === 0 ? " active" : "")}
              onMouseDown={(e) => { e.preventDefault(); setMentionCategory("files"); setMenuIndex(0) }}
              onMouseEnter={() => setMenuIndex(0)}
            >
              <FolderIcon />
              <span className="mention-category-label">Files</span>
              <ChevronIcon />
            </li>
            <li
              role="option"
              aria-selected={menuIndex === 1}
              className={"mention-hit mention-category" + (menuIndex === 1 ? " active" : "")}
              onMouseDown={(e) => { e.preventDefault(); setMentionCategory("chats"); setMenuIndex(0) }}
              onMouseEnter={() => setMenuIndex(1)}
            >
              <ChatIcon />
              <span className="mention-category-label">Past Chats</span>
              {pastConversations.length > 0 && (
                <span className="mention-category-meta">{pastConversations.length}</span>
              )}
              <ChevronIcon />
            </li>
          </ul>
        )}
        {showBrowse && (
          <div className="mention-popover mention-browser">
            <div className="mention-breadcrumb">
              <button
                type="button"
                className="mention-breadcrumb-up"
                aria-label="Go up a folder"
                disabled={!canGoUp}
                onMouseDown={(e) => { e.preventDefault(); if (canGoUp) goUp() }}
              >
                <span className="mention-breadcrumb-chevron" aria-hidden="true"><ChevronIcon /></span>
                <span className="mention-breadcrumb-path">{browseDir === "" ? "Project root" : browseDir}</span>
              </button>
            </div>
            <ul role="listbox" aria-label="Project files">
              {browseEntries.length > 0 ? browseEntries.map((entry, i) => (
                <li
                  key={entry.path}
                  role="option"
                  aria-selected={i === browseIndex}
                  className={"mention-hit" + (i === browseIndex ? " active" : "") + (entry.kind === "folder" ? " mention-folder" : "")}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    if (entry.kind === "folder") drillInto(entry)
                    else insertMention(entry)
                  }}
                  onMouseEnter={() => setBrowseIndex(i)}
                >
                  {entry.kind === "folder"
                    ? <FolderIcon />
                    : <span className={`codicon codicon-${fileTypeCodicon(entry.name)}`} aria-hidden="true" />}
                  <span className="mention-name">{entry.name}</span>
                  {entry.kind === "folder" && <ChevronIcon />}
                </li>
              )) : (
                <li className="mention-hit mention-empty">Empty folder</li>
              )}
            </ul>
          </div>
        )}
        {showFileHits && (
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
                <span className={`codicon codicon-${fileTypeCodicon(hit.name)}`} aria-hidden="true" />
                <span className="mention-name">{hit.name}</span>
                <span className="mention-path">{hit.path}</span>
              </li>
            ))}
          </ul>
        )}
        {showChatList && (
          <ul className="mention-popover" role="listbox" aria-label="Past Chats">
            {flatConversations.length > 0 ? chatGroups.map((group) => [
              <li key={`section:${group.label}`} className="mention-section" role="presentation">
                {group.label}
              </li>,
              ...group.conversations.map((conv) => {
                const i = flatConversations.indexOf(conv)
                return (
                  <li
                    key={conv.id}
                    role="option"
                    aria-selected={i === menuIndex}
                    className={"mention-hit mention-chat" + (i === menuIndex ? " active" : "")}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      insertConversationMention(conv)
                    }}
                    onMouseEnter={() => setMenuIndex(i)}
                  >
                    <ChatIcon />
                    <span className="mention-name">{conversationDisplayTitle(conv)}</span>
                    <span className="mention-path">{formatConversationUpdated(conv.updatedAt)}</span>
                  </li>
                )
              }),
            ]) : (
              <li className="mention-hit mention-empty">
                {pastConversations.length === 0 ? "No past chats" : `No chats match "${mention.query}"`}
              </li>
            )}
          </ul>
        )}
        {command && (
          <ul className="mention-popover command-popover" role="listbox" aria-label="Commands">
            {commandHits.length > 0 ? commandHits.map((cmd, i) => (
              <li
                key={cmd.name}
                role="option"
                aria-selected={i === commandIndex}
                className={"mention-hit" + (i === commandIndex ? " active" : "")}
                onMouseDown={(e) => {
                  e.preventDefault()
                  chooseCommand(cmd)
                }}
                onMouseEnter={() => setCommandIndex(i)}
              >
                <span className="mention-name">/{cmd.name}</span>
                <span className="mention-path">{cmd.description ?? (cmd.agent ? `agent: ${cmd.agent}` : "")}</span>
              </li>
            )) : (
              <li className="mention-hit mention-empty">No commands match "/{command.query}"</li>
            )}
          </ul>
        )}
        </div>
        <div className="promptbox-row">
          {variant === "send" && position === "bottom" && (
            <ContextUsageIndicator usage={contextUsage} />
          )}
          <div className="spacer" />
          {attachFile && (
            <button
              type="button"
              className="icon-btn attach-btn"
              aria-label="Attach image, PDF, or code/text file"
              title="Attach image, PDF, or code/text file"
              disabled={attaching || busy}
              onClick={handleAttachClick}
            >
              <svg width={ICON_SIZE.lg} height={ICON_SIZE.lg} viewBox="5.5 1.5 8 14" aria-hidden="true" style={{ display: "block" }}>
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
    </div>
  )
}

function ContextUsageIndicator({ usage }: { usage?: ContextUsage }) {
  const percent = usage?.percent ?? (usage?.limit ? Math.round((usage.tokens / usage.limit) * 100) : undefined)
  const value = clampPercent(percent ?? 0)
  const tooltip = usage
    ? [
        `${formatTokenCount(usage.tokens)}${usage.limit ? ` / ${formatTokenCount(usage.limit)}` : ""}`,
        percent !== undefined ? `${value}%` : undefined,
      ].filter(Boolean).join(" · ")
    : "Context usage unavailable"
  const title = usage
    ? [
        `Context: ${tooltip}`,
        usage.model,
        typeof usage.cost === "number" && usage.cost > 0 ? `$${usage.cost.toFixed(4)} spent` : undefined,
      ].filter(Boolean).join(" · ")
    : "Context usage appears after the first response"
  const className = [
    "context-usage",
    usage ? "is-ready" : "is-empty",
    value >= 95 ? "danger" : value >= 85 ? "warn" : "",
  ].filter(Boolean).join(" ")
  const style = { "--context-usage-deg": `${value * 3.6}deg` } as CSSProperties

  return (
    <span
      className={className}
      role="status"
      aria-label={usage ? `Context ${value}% used` : "Context usage unavailable"}
      title={title}
      data-tooltip={tooltip}
      style={style}
    >
      <span className="context-usage-ring" aria-hidden="true" />
    </span>
  )
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return "0"
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${millions >= 10 ? Math.round(millions) : Number(millions.toFixed(1))}M`
  }
  if (value >= 1_000) {
    const thousands = value / 1_000
    return `${thousands >= 10 ? Math.round(thousands) : Number(thousands.toFixed(1))}K`
  }
  return Math.max(0, Math.round(value)).toLocaleString()
}

function SendIcon() {
  // Same `display: block` reasoning as StopIcon — removes the SVG's
  // default inline baseline drift so the arrow sits on the button's
  // exact centre line. `ICON_SIZE.sm` in an 18-px button → 4-px margin per side.
  return (
    <svg width={ICON_SIZE.sm} height={ICON_SIZE.sm} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ display: "block" }}>
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
  // `ICON_SIZE.xs` in an 18-px button → 5-px margin on each side. Even
  // numbers avoid the sub-pixel rounding that made the square look slightly
  // off-centre at 7×7. The inner `<rect>` is the icon SHAPE (10×10 viewBox
  // coordinate), not the icon size — leave it untouched.
  return (
    <svg width={ICON_SIZE.xs} height={ICON_SIZE.xs} viewBox="0 0 10 10" aria-hidden="true" style={{ display: "block" }}>
      <rect x="0" y="0" width="10" height="10" rx="1.5" fill="currentColor" />
    </svg>
  )
}

function FolderIcon() {
  return <span className="codicon codicon-folder" aria-hidden="true" />
}

function ChatIcon() {
  return <span className="codicon codicon-comment-discussion" aria-hidden="true" />
}

function ChevronIcon() {
  return <span className="codicon codicon-chevron-right mention-category-chevron" aria-hidden="true" />
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
