import { useEffect, useState } from "react"
import type { CommandInfo } from "../protocol"
import { detectCommand, filterCommands, type CommandTokenState } from "../command-tokens"

/**
 * Owns the `/`-command picker state: detection (does the caret sit inside the
 * leading `/command` name?) and arrow-key navigation index. Much simpler than
 * useMentionPicker — the command list is already in memory (pushed once by the
 * host), so there is no async search to debounce. The caller owns the textarea
 * text + caret refs; this hook decides what to show and exposes `insertCommand`
 * for the "insert and wait for args" pick path (the run-immediately path is the
 * caller's, since only it knows `onRunCommand`).
 */
export function useCommandPicker(opts: {
  text: string
  setText: (next: string) => void
  commands: CommandInfo[]
  pendingCursor: React.MutableRefObject<number | null>
}) {
  const { text, setText, commands, pendingCursor } = opts
  const [command, setCommand] = useState<CommandTokenState | undefined>(undefined)
  const [activeIndex, setActiveIndex] = useState(0)

  const filtered = command ? filterCommands(commands, command.query) : []

  // Reset the highlight to the top whenever the query changes.
  useEffect(() => {
    setActiveIndex(0)
  }, [command?.query])

  const closeCommand = () => setCommand(undefined)

  /**
   * Recompute the command-token state from the current text + caret. An empty
   * command list never opens the picker — a bare `/` should behave as plain
   * text when there is nothing to run. Returns whether the picker is open so
   * the caller can keep the `@` and `/` pickers mutually exclusive.
   */
  const detectAtCaret = (next: string, caret: number): boolean => {
    if (commands.length === 0) {
      setCommand(undefined)
      return false
    }
    const state = detectCommand(next, caret)
    setCommand(state)
    return state !== undefined
  }

  /**
   * Replace the leading `/token` with `/name ` and place the caret after the
   * trailing space. Any already-typed arguments (text after the first space)
   * are preserved — the before/after splice mirrors insertMention.
   */
  const insertCommand = (cmd: CommandInfo) => {
    const firstSpace = text.indexOf(" ")
    const rest = firstSpace === -1 ? "" : text.slice(firstSpace + 1)
    const head = "/" + cmd.name + " "
    pendingCursor.current = head.length
    setText(head + rest)
    closeCommand()
  }

  return {
    command,
    filtered,
    activeIndex,
    setActiveIndex,
    detectAtCaret,
    closeCommand,
    insertCommand,
  }
}
