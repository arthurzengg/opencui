/**
 * Synthesized `/<agent>` commands: one picker entry per user-selectable
 * agent so the agent can be switched via slash command as well as via the
 * model-picker chips / footer selectors. Pure for testability.
 *
 * Precedence: an existing entry (custom or built-in) claiming the name wins
 * and no agent entry is added for it — running a real command must never
 * be hijacked by an agent switch. Otherwise the agent entry is appended
 * with `takesArguments: true` (so `/agent prompt` switches + sends, while
 * a bare `/agent` only switches) and `agentSwitch: true` so the webview
 * can intercept it locally instead of routing through `session.command`.
 */
import type { AgentCatalogEntry, CommandInfo } from "../protocol"

export function withAgentCommands(
  commands: CommandInfo[],
  agents: AgentCatalogEntry[],
): CommandInfo[] {
  if (agents.length === 0) return commands
  const claimed = new Set(commands.map((c) => c.name))
  const synthesized: CommandInfo[] = []
  for (const a of agents) {
    if (!a.name || claimed.has(a.name)) continue
    claimed.add(a.name)
    synthesized.push({
      name: a.name,
      description: a.description
        ? `Switch to ${a.name} — ${a.description}`
        : `Switch to the ${a.name} agent`,
      takesArguments: true,
      agentSwitch: true,
    })
  }
  return [...commands, ...synthesized]
}
