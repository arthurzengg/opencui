import { useLayoutEffect, useRef, useState } from "react"

// Hard upper bound on the auto-grow textarea height. Past this, the
// textarea's own scrollbar takes over so the prompt box doesn't keep eating
// chat real estate when the user pastes or types a long message. MUST stay
// in sync with the CSS variable --message-max-height in styles.css — the
// same cap is shared with .promptbox textarea (the bottom prompt + the
// in-place edit textarea) and .msg.role-user .user-text (rendered user
// message), so all three views collapse to the same visual ceiling.
export const TEXTAREA_MAX_HEIGHT = 160

/**
 * Owns the prompt textarea's text state, refs, auto-resize, and the
 * post-mutation caret-restore mechanism used by chip insertion. Three
 * concerns rolled together because they're cross-coupled via the same
 * `ref` + `pendingCursor` ref handles — splitting them further would
 * just pass refs around between hooks.
 *
 * Caret restore pattern: any handler that wants to set the textarea's
 * caret position AFTER a `setText` call should set
 * `pendingCursor.current = <pos>`. A `useLayoutEffect` keyed on `text`
 * focuses the textarea, applies the position, and clears the ref. This
 * keeps caret manipulation deterministic across the React commit phase.
 */
export function usePromptText(initialText: string = "") {
  const [text, setText] = useState(initialText)
  const ref = useRef<HTMLTextAreaElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const pendingCursor = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (!ref.current) return
    ref.current.style.height = "auto"
    ref.current.style.height = Math.min(ref.current.scrollHeight, TEXTAREA_MAX_HEIGHT) + "px"
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

  return { text, setText, ref, backdropRef, pendingCursor }
}
