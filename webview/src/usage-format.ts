import type { UsageDelta } from "./protocol"

const groups = new Intl.NumberFormat("en-US")

/** Input plus output, the same total the usage line has always shown. */
export function tokenTotal(usage: UsageDelta): number {
  return usage.tokens ? usage.tokens.input + usage.tokens.output : 0
}

/**
 * What the chip shows at rest: the cost, or the token total when the model
 * reports none, or the model name when it reports neither. One figure only;
 * everything else waits for the overlay.
 */
export function usageSummary(usage: UsageDelta | undefined): string | undefined {
  if (!usage) return undefined
  if (usage.cost) return `$${usage.cost.toFixed(4)}`
  const total = tokenTotal(usage)
  if (total) return `${groups.format(total)} tokens`
  return usage.model || undefined
}

export type UsageRow = { label: string; value: string }

export type UsageBreakdown = {
  model?: string
  /** The cost and the input-plus-output total, each only when reported. */
  totals: UsageRow[]
  /**
   * The per-kind split. Kinds that are zero or absent are left out so a
   * provider that reports no cache figures does not show a row of zeros.
   */
  kinds: UsageRow[]
}

/** The overlay's rows: the model, the totals, then the per-kind split (#742). */
export function usageBreakdown(usage: UsageDelta): UsageBreakdown {
  const totals: UsageRow[] = []
  if (usage.cost) totals.push({ label: "Cost", value: `$${usage.cost.toFixed(4)}` })
  const total = tokenTotal(usage)
  if (total) totals.push({ label: "Tokens", value: groups.format(total) })
  const t = usage.tokens
  const counted: Array<[number | undefined, string]> = t
    ? [
        [t.input, "Input"],
        [t.output, "Output"],
        [t.reasoning, "Reasoning"],
        [t.cacheRead, "Cache read"],
        [t.cacheWrite, "Cache write"],
      ]
    : []
  const kinds = counted.filter(([n]) => n != null && n > 0).map(([n, label]) => ({ label, value: groups.format(n as number) }))
  return { model: usage.model || undefined, totals, kinds }
}

/** The same rows as flat text, for the chip's accessible label. */
export function usageDetail(usage: UsageDelta): string {
  const { model, totals, kinds } = usageBreakdown(usage)
  const rows = [...totals, ...kinds].map((row) => `${row.label} ${row.value}`)
  return [model, ...rows].filter(Boolean).join(", ")
}
