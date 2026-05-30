/**
 * Pure helpers for the MCP management picker — status presentation, the
 * per-status action set, and Add-flow input parsing/validation. Kept free of
 * `vscode` so they unit-test in the node project without the API stub
 * (mirrors `src/chat/paths.ts`).
 */
import type { McpStatus } from "@opencode-ai/sdk"

/**
 * Actions a server can offer, gated by its current status (see `actionsFor`).
 * `manage.ts` maps each to a QuickPick label and an SDK call.
 */
export type McpAction = "connect" | "disconnect" | "authenticate" | "signout" | "showError"

/** Codicon for the server row, chosen to read like a traffic light at a glance. */
export function statusIcon(status: McpStatus): string {
  switch (status.status) {
    case "connected":
      return "$(pass-filled)"
    case "disabled":
      return "$(circle-slash)"
    case "failed":
      return "$(error)"
    case "needs_auth":
      return "$(key)"
    case "needs_client_registration":
      return "$(warning)"
  }
}

/** One-line human status for the row description. */
export function statusLabel(status: McpStatus): string {
  switch (status.status) {
    case "connected":
      return "connected"
    case "disabled":
      return "disabled"
    case "failed":
      return `failed: ${status.error}`
    case "needs_auth":
      return "needs auth"
    case "needs_client_registration":
      return "needs client registration"
  }
}

/** The error string for the statuses that carry one, else undefined. */
export function statusError(status: McpStatus): string | undefined {
  if (status.status === "failed" || status.status === "needs_client_registration") return status.error
  return undefined
}

/**
 * Which actions to offer for a server in this state.
 *   - connected → disconnect; remove OAuth creds (no-op/404 for non-OAuth servers).
 *   - disabled  → connect (force it on at runtime).
 *   - failed    → connect (retry); show the error.
 *   - needs_auth → authenticate; connect; remove creds (to re-auth).
 *   - needs_client_registration → only show the error (needs a clientId in config; not fixable here).
 */
export function actionsFor(status: McpStatus): McpAction[] {
  switch (status.status) {
    case "connected":
      return ["disconnect", "signout"]
    case "disabled":
      return ["connect"]
    case "failed":
      return ["connect", "showError"]
    case "needs_auth":
      return ["authenticate", "connect", "signout"]
    case "needs_client_registration":
      return ["showError"]
  }
}

/**
 * Split a typed command string into an argv array for `McpLocalConfig.command`.
 * Plain whitespace split — quoted args with embedded spaces are not supported;
 * complex commands belong in the opencode config file.
 */
export function parseCommand(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean)
}

/** Validate a new server name against the existing set. Returns the error or undefined. */
export function validateServerName(name: string, existing: Set<string>): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return "Name is required"
  if (/\s/.test(trimmed)) return "Name cannot contain spaces"
  if (existing.has(trimmed)) return `A server named "${trimmed}" already exists`
  return undefined
}
