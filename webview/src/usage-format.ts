import type { UsageDelta } from "./protocol"

const groups = new Intl.NumberFormat("en-US")

/** Input plus output, the same total the usage line has always shown. */
export function tokenTotal(usage: UsageDelta): number {
  return usage.tokens ? usage.tokens.input + usage.tokens.output : 0
}

/**
 * What the chip shows at rest: the cost, or the token total when the model
 * reports none, or the model name when it reports neither. One figure only;
 * everything else waits for the tooltip.
 */
export function usageSummary(usage: UsageDelta | undefined): string | undefined {
  if (!usage) return undefined
  if (usage.cost) return `$${usage.cost.toFixed(4)}`
  const total = tokenTotal(usage)
  if (total) return `${groups.format(total)} tokens`
  return usage.model || undefined
}

/**
 * Tooltip text: the model, then cost and total, then the per-kind split.
 * Kinds that are zero or absent are left out so a provider that reports no
 * cache figures does not show a row of zeros.
 */
export function usageDetail(usage: UsageDelta): string {
  const lines: string[] = []
  if (usage.model) lines.push(usage.model)
  const head: string[] = []
  if (usage.cost) head.push(`$${usage.cost.toFixed(4)}`)
  const total = tokenTotal(usage)
  if (total) head.push(`${groups.format(total)} tokens`)
  if (head.length) lines.push(head.join(" · "))
  const t = usage.tokens
  if (t) {
    const kinds: Array<[number | undefined, string]> = [
      [t.input, "in"],
      [t.output, "out"],
      [t.reasoning, "reasoning"],
      [t.cacheRead, "cache read"],
      [t.cacheWrite, "cache write"],
    ]
    const parts = kinds.filter(([n]) => n != null && n > 0).map(([n, label]) => `${groups.format(n as number)} ${label}`)
    if (parts.length) lines.push(parts.join(" · "))
  }
  return lines.join("\n")
}
