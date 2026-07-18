import { useEffect, useRef, useState } from "react"
import type { FileSearchHit } from "../protocol"
import { detectMention, type MentionState } from "../mention-tokens"

const MAX_VISIBLE_HITS = 8
const SEARCH_DEBOUNCE_MS = 100

/**
 * Owns the `@`-mention picker state: detection (does the caret sit
 * inside a partial `@token`?), search debouncing (drop stale results
 * when the user keeps typing), and arrow-key navigation index. The
 * caller owns the textarea text + caret refs and supplies
 * `searchFiles`; this hook just decides what to show in the picker
 * and exposes `insertMention` for the keyboard / mouse pick paths to
 * call.
 *
 * The `insertMention` callback ALSO mutates the parent's
 * `knownMentions` set (so future re-renders treat the inserted path
 * as a chip) and stages a `pendingCursor` position so the textarea
 * cursor lands right after the inserted text. These are passed in as
 * refs to avoid copying-then-syncing-back state.
 */
export function useMentionPicker(opts: {
  text: string
  setText: (next: string) => void
  searchFiles?: (query: string) => Promise<FileSearchHit[]>
  knownMentions: React.MutableRefObject<Set<string>>
  pendingCursor: React.MutableRefObject<number | null>
}) {
  const { text, setText, searchFiles, knownMentions, pendingCursor } = opts
  const [mention, setMention] = useState<MentionState | undefined>(undefined)
  const [hits, setHits] = useState<FileSearchHit[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const queryRef = useRef("")

  useEffect(() => {
    if (!mention || !searchFiles) {
      setHits([])
      return
    }
    queryRef.current = mention.query
    let cancelled = false
    // Each keystroke re-runs this effect; the cleanup cancels the previous
    // timer, so only the query the user settles on costs a host round-trip.
    const timer = setTimeout(() => {
      void searchFiles(mention.query).then((results) => {
        if (cancelled) return
        // Drop stale results — the user may have kept typing while we awaited.
        if (queryRef.current !== mention.query) return
        setHits(results.slice(0, MAX_VISIBLE_HITS))
        setActiveIndex(0)
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [mention, searchFiles])

  const closeMention = () => {
    setMention(undefined)
    setHits([])
  }

  /** Recompute the mention state from the current text + caret. Caller
   *  invokes from onChange so detection stays in sync with edits. */
  const detectAtCaret = (next: string, caret: number) => {
    if (!searchFiles) return
    setMention(detectMention(next, caret))
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

  return {
    mention,
    hits,
    activeIndex,
    setActiveIndex,
    detectAtCaret,
    closeMention,
    insertMention,
  }
}
