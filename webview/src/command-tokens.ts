/**
 * Pure helpers for the `/`-command picker. Kept separate from PromptBox.tsx so
 * the component file is just JSX + state, and so these functions can be tested
 * without rendering anything. Mirrors mention-tokens.ts.
 */

export type CommandTokenState = {
  /** Query typed after the leading `/` (excludes the slash itself). */
  query: string
}

/**
 * Returns the active command token if the caret sits inside the leading
 * `/command` name, else undefined. Unlike the `@`-mention picker (which
 * triggers anywhere), a slash command must be the very FIRST character —
 * `/` is far too common in normal prose (paths, dates, fractions) to trigger
 * mid-string. The picker closes once a space is typed (the user has moved on
 * to arguments).
 */
export function detectCommand(text: string, caret: number): CommandTokenState | undefined {
  if (!text.startsWith("/")) return undefined
  const firstSpace = text.indexOf(" ")
  // Caret must sit within the first token (the command name); once it moves
  // past the first space the user is editing arguments, not the command.
  if (firstSpace !== -1 && caret > firstSpace) return undefined
  const end = firstSpace === -1 ? text.length : firstSpace
  return { query: text.slice(1, end) }
}

/**
 * Filter commands by a (case-insensitive) query, surfacing prefix matches
 * before substring matches. An empty query returns the full list.
 */
export function filterCommands<T extends { name: string }>(commands: T[], query: string): T[] {
  const q = query.toLowerCase()
  if (!q) return commands
  const starts: T[] = []
  const contains: T[] = []
  for (const c of commands) {
    const name = c.name.toLowerCase()
    if (name.startsWith(q)) starts.push(c)
    else if (name.includes(q)) contains.push(c)
  }
  return [...starts, ...contains]
}

/**
 * Split a leading-`/` input into its command name and the (trimmed) argument
 * remainder. Returns undefined when the text is not a slash invocation. Used by
 * submit routing to decide whether a typed `/name args` is a known command.
 */
export function parseCommandInput(text: string): { name: string; args: string } | undefined {
  if (!text.startsWith("/")) return undefined
  const firstSpace = text.indexOf(" ")
  if (firstSpace === -1) return { name: text.slice(1), args: "" }
  return { name: text.slice(1, firstSpace), args: text.slice(firstSpace + 1).trim() }
}
