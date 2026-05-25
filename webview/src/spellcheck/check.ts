/**
 * Pure word-tokenization for spell-check. Splits a text into word ranges, skipping
 * tokens we never want to flag:
 *   - text inside @mention chips (handed in via `mentionRanges`)
 *   - URLs (any token containing `://` or starting with `www.`)
 *   - tokens that look like identifiers or paths (contain `_`, `.`, `/`, `\`, digits)
 *   - tokens shorter than 3 characters (mostly noise in spell-check)
 *
 * Word boundaries: a "word" is a run of letters plus an internal apostrophe
 * (`don't`, `it's`). We don't include digits in a word, so `e2e` becomes a
 * skipped identifier-like token and `chat` inside `chatRoom2` would too.
 *
 * The dictionary check is injected so this module stays pure and testable
 * without bundling the 550KB Hunspell dictionary into the test runner.
 */

export type WordRange = {
  start: number
  end: number
  word: string
}

const WORD_PATTERN = /[A-Za-z]+(?:['’][A-Za-z]+)*/g
const URL_LIKE = /:\/\/|^www\./

export function tokenizeWords(text: string, mentionRanges: ReadonlyArray<{ start: number; end: number }>): WordRange[] {
  const out: WordRange[] = []
  WORD_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = WORD_PATTERN.exec(text)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (inAnyRange(start, end, mentionRanges)) continue
    const token = expandToTokenBoundary(text, start, end)
    if (isIdentifierLike(token)) continue
    if (match[0].length < 3) continue
    out.push({ start, end, word: match[0] })
  }
  return out
}

/**
 * Look outward from a word match for the surrounding non-whitespace token, so
 * matches like the leading "chat" in "chatRoom2" can see the digit and skip.
 * "Token" here = run of non-whitespace characters.
 */
function expandToTokenBoundary(text: string, start: number, end: number): string {
  let s = start
  while (s > 0 && !/\s/.test(text[s - 1] ?? "")) s--
  let e = end
  while (e < text.length && !/\s/.test(text[e] ?? "")) e++
  return text.slice(s, e)
}

function isIdentifierLike(token: string): boolean {
  if (URL_LIKE.test(token)) return true
  // Paths, namespaces, file-ish tokens, numbers.
  if (/[_./\\@:0-9]/.test(token)) return true
  // camelCase / mixedCase identifiers (`renderHighlightedText`, `iOS`). A capital
  // following a lowercase letter is the distinguishing signal — sentence-initial
  // capitals like "Hello" don't match because there's nothing lowercase before
  // the H, and acronyms like "NASA" don't match because there's no lowercase at
  // all in the run.
  if (/[a-z][A-Z]/.test(token)) return true
  return false
}

function inAnyRange(start: number, end: number, ranges: ReadonlyArray<{ start: number; end: number }>): boolean {
  for (const r of ranges) {
    if (start < r.end && end > r.start) return true
  }
  return false
}

/**
 * Run the injected `correct` predicate over each tokenized word and return only
 * the ones it flagged as misspelled. Kept separate from `tokenizeWords` so the
 * tokenizer can be unit-tested without ever loading the dictionary.
 */
export function findMisspellings(
  text: string,
  mentionRanges: ReadonlyArray<{ start: number; end: number }>,
  correct: (word: string) => boolean,
): WordRange[] {
  const words = tokenizeWords(text, mentionRanges)
  const out: WordRange[] = []
  for (const w of words) {
    if (!correct(w.word)) out.push(w)
  }
  return out
}

/**
 * Locate the misspelling that contains the given caret position, if any.
 * Used by the right-click handler to map a click coordinate (via the
 * textarea's selectionStart) back to "which underlined word did the user
 * click on?". An exact-match on the boundary counts as inside the word —
 * a click at the very end of "helo" should still show suggestions.
 */
export function findMisspellingAt(pos: number, ranges: ReadonlyArray<WordRange>): WordRange | null {
  for (const r of ranges) {
    if (pos >= r.start && pos <= r.end) return r
  }
  return null
}
