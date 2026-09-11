import * as vscode from "vscode"
import type { PermissionRuleInfo } from "../protocol"

export const PERMISSION_RULES_KEY = "opencui.permissionRules"

export type PermissionRule = PermissionRuleInfo

/**
 * Port of opencode's Wildcard.match (packages/opencode/src/util/wildcard.ts)
 * so a rule saved here answers exactly the asks the server's own "always"
 * list would have. A trailing " *" also matches the bare command: that is
 * how "ls *" covers both "ls" and "ls -la".
 */
export function matchWildcard(value: string, pattern: string): boolean {
  const str = value.replace(/\\/g, "/")
  let escaped = pattern
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  const flags = process.platform === "win32" ? "si" : "s"
  return new RegExp("^" + escaped + "$", flags).test(str)
}

/** True when every requested pattern is covered by a saved rule for that permission. */
export function rulesAllow(
  rules: readonly PermissionRule[],
  permission: string,
  patterns: readonly string[],
): boolean {
  if (!permission || patterns.length === 0) return false
  return patterns.every((pattern) =>
    rules.some((rule) => matchWildcard(permission, rule.permission) && matchWildcard(pattern, rule.pattern)),
  )
}

function sanitize(raw: unknown): PermissionRule[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((r): r is PermissionRule => {
    if (!r || typeof r !== "object") return false
    const rule = r as Record<string, unknown>
    return (
      typeof rule.id === "string" &&
      typeof rule.permission === "string" &&
      typeof rule.pattern === "string" &&
      typeof rule.createdAt === "number"
    )
  })
}

/**
 * The panel's own "Allow always" list (#619). opencode's prompt path keeps
 * its always-approvals in memory, instance-wide, with no route to list or
 * remove them, so the panel answers "once" to the server and keeps the rule
 * here instead: it survives restarts and can be removed from the popover.
 */
export class PermissionRuleStore {
  private rules: PermissionRule[]
  private readonly emitter = new vscode.EventEmitter<PermissionRule[]>()
  readonly onDidChange = this.emitter.event

  constructor(
    private readonly state: vscode.Memento,
    private readonly now: () => number = Date.now,
  ) {
    this.rules = sanitize(state.get(PERMISSION_RULES_KEY))
  }

  list(): PermissionRule[] {
    return [...this.rules]
  }

  allows(permission: string, patterns: readonly string[]): boolean {
    return rulesAllow(this.rules, permission, patterns)
  }

  /** One rule per pattern; a pattern already saved for the permission is skipped. */
  async add(permission: string, patterns: readonly string[]): Promise<PermissionRule[]> {
    const added: PermissionRule[] = []
    for (const pattern of patterns) {
      if (this.rules.some((r) => r.permission === permission && r.pattern === pattern)) continue
      const rule = { id: crypto.randomUUID(), permission, pattern, createdAt: this.now() }
      this.rules.push(rule)
      added.push(rule)
    }
    if (added.length > 0) await this.persist()
    return added
  }

  async remove(id: string): Promise<boolean> {
    const next = this.rules.filter((r) => r.id !== id)
    if (next.length === this.rules.length) return false
    this.rules = next
    await this.persist()
    return true
  }

  async clear(): Promise<void> {
    if (this.rules.length === 0) return
    this.rules = []
    await this.persist()
  }

  dispose() {
    this.emitter.dispose()
  }

  private async persist() {
    this.emitter.fire(this.list())
    await this.state.update(PERMISSION_RULES_KEY, this.rules)
  }
}
