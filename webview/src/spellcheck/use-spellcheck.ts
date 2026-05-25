import { useCallback, useEffect, useMemo, useState } from "react"
import { findMisspellings, type WordRange } from "./check"
import { loadChecker, type Checker } from "./dictionary"

type Range = { start: number; end: number }

/**
 * Lazy-loaded spell-check for the prompt textarea.
 *
 * On mount we ask the dictionary loader for its (cached) nspell instance —
 * the first mount in a session pays the parse cost, subsequent mounts are
 * instant. While loading, `misspellings` is `[]` so nothing renders.
 *
 * Detection runs on a 220ms debounce so a fast typist doesn't trigger a
 * full re-tokenize on every keystroke. We also bail if the rebuilt list
 * is structurally identical to the previous one — that keeps React from
 * re-rendering the chip backdrop when the only change is, say, the
 * trailing punctuation.
 */
export function useSpellcheck(text: string, mentionRanges: ReadonlyArray<Range>): {
  misspellings: WordRange[]
  suggest: (word: string) => string[]
  ready: boolean
} {
  const [checker, setChecker] = useState<Checker | null>(null)
  const [misspellings, setMisspellings] = useState<WordRange[]>([])

  useEffect(() => {
    let alive = true
    loadChecker().then((c) => {
      if (alive) setChecker(c)
    })
    return () => {
      alive = false
    }
  }, [])

  const mentionKey = useMemo(
    () => mentionRanges.map((r) => `${r.start}-${r.end}`).join(","),
    [mentionRanges],
  )

  useEffect(() => {
    if (!checker) return
    const handle = window.setTimeout(() => {
      const next = findMisspellings(text, mentionRanges, (w) => checker.correct(w))
      setMisspellings((prev) => (rangesEqual(prev, next) ? prev : next))
    }, 220)
    return () => window.clearTimeout(handle)
    // mentionKey participates in the dependency array as a stable string proxy
    // for the array contents. Keeping `mentionRanges` itself in the deps would
    // re-trigger on every PromptBox render because that array is re-derived
    // upstream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, mentionKey, checker])

  const suggest = useCallback(
    (word: string) => {
      if (!checker) return []
      return checker.suggest(word).slice(0, 5)
    },
    [checker],
  )

  return { misspellings, suggest, ready: checker !== null }
}

function rangesEqual(a: ReadonlyArray<WordRange>, b: ReadonlyArray<WordRange>): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.start !== b[i]!.start || a[i]!.end !== b[i]!.end) return false
  }
  return true
}
