/**
 * opencode's built-in commands (`/compact`, `/share`, …) are NOT returned by
 * `command.list` — that endpoint only lists user-defined custom commands (the
 * `.opencode/command/*.md` templates). The built-ins live in opencode's TUI
 * layer and map to dedicated session endpoints. We surface a useful subset in
 * the same `/` picker by merging these synthetic entries into the pushed
 * command list and routing them host-side to their endpoints instead of
 * `session.command`.
 */
import { randomBytes } from "node:crypto"
import type { CommandInfo } from "../protocol"

/**
 * Built-ins shown in the `/` picker. All are argument-less, so the picker's
 * smart-select runs them immediately. A custom command of the same name takes
 * precedence (see withBuiltinCommands) and is dispatched through the normal
 * `session.command` path instead.
 */
export const BUILTIN_COMMANDS: ReadonlyArray<CommandInfo> = [
  { name: "compact", description: "Summarize and compact the session", takesArguments: false },
  { name: "init", description: "Analyze the codebase and write AGENTS.md", takesArguments: false },
  { name: "share", description: "Create a shareable link for this session", takesArguments: false },
  { name: "unshare", description: "Disable sharing for this session", takesArguments: false },
]

export const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set(BUILTIN_COMMANDS.map((c) => c.name))

/**
 * Append the built-ins to the workspace's custom commands, skipping any whose
 * name a custom command already claims (custom wins). Pure for testability.
 */
export function withBuiltinCommands(custom: CommandInfo[]): CommandInfo[] {
  const claimed = new Set(custom.map((c) => c.name))
  return [...custom, ...BUILTIN_COMMANDS.filter((b) => !claimed.has(b.name))]
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/**
 * Generate a ULID-style, time-sortable message id for `session.init`, which
 * requires a client-supplied `messageID`. opencode's own ids are ULID-like;
 * a timestamp-prefixed Crockford-base32 string gives uniqueness and the
 * lexicographic ordering opencode relies on.
 */
export function generateMessageID(): string {
  let now = Date.now()
  let time = ""
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[now % 32] + time
    now = Math.floor(now / 32)
  }
  const rand = randomBytes(16)
  let tail = ""
  for (let i = 0; i < 16; i++) tail += CROCKFORD[rand[i]! % 32]
  return "msg_" + time + tail
}
