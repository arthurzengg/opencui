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

/**
 * A session's spend as the context tooltip shows it: to the cent, and to four
 * places below one so a first cheap reply does not read as $0.00.
 */
export function spendLabel(cost: number): string {
  return `$${cost.toFixed(cost < 0.01 ? 4 : 2)} spent`
}

/**
 * What a whole turn used. The server stores each step of a turn as a message
 * of its own, with its own usage, and the provider bills every one of them;
 * the last step alone is a small part of a turn that ran tools.
 */
export function turnUsage(steps: ReadonlyArray<UsageDelta | undefined>): UsageDelta | undefined {
  const used = steps.filter((step): step is UsageDelta => step !== undefined)
  const last = used[used.length - 1]
  if (!last || used.length === 1) return last
  const priced = used.filter((step) => typeof step.cost === "number")
  const counted = used.flatMap((step) => (step.tokens ? [step.tokens] : []))
  const sum = (pick: (tokens: NonNullable<UsageDelta["tokens"]>) => number | undefined) =>
    counted.reduce((total, tokens) => total + (pick(tokens) ?? 0), 0)
  return {
    model: last.model,
    providerID: last.providerID,
    modelID: last.modelID,
    cost: priced.length ? priced.reduce((total, step) => total + (step.cost ?? 0), 0) : undefined,
    tokens: counted.length
      ? {
          input: sum((t) => t.input),
          output: sum((t) => t.output),
          reasoning: sum((t) => t.reasoning),
          cacheRead: sum((t) => t.cacheRead),
          cacheWrite: sum((t) => t.cacheWrite),
        }
      : undefined,
  }
}

/** Whether two usages show the same figures. A turn's usage is summed anew on every render. */
export function sameUsage(a: UsageDelta | undefined, b: UsageDelta | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.model === b.model &&
    a.cost === b.cost &&
    a.tokens?.input === b.tokens?.input &&
    a.tokens?.output === b.tokens?.output &&
    a.tokens?.reasoning === b.tokens?.reasoning &&
    a.tokens?.cacheRead === b.tokens?.cacheRead &&
    a.tokens?.cacheWrite === b.tokens?.cacheWrite
  )
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
