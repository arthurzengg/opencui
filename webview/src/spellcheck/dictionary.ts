import nspell from "nspell"
import affRaw from "./dict/en.aff?raw"
import dicRaw from "./dict/en.dic?raw"

/**
 * Minimal facade we depend on. nspell's full surface is wider; we only need
 * spell-checking and suggestion lookup, so we narrow the type here rather
 * than depend on the upstream package shipping types.
 */
export type Checker = {
  correct(word: string): boolean
  suggest(word: string): string[]
}

let cached: Checker | null = null
let loading: Promise<Checker> | null = null

/**
 * Build (or return the previously-built) nspell instance.
 *
 * The .aff / .dic files are inlined into the webview bundle as strings at
 * build time via Vite's `?raw` import. Construction parses ~50K dictionary
 * entries and the affix rules, which runs in a few hundred milliseconds on
 * first call — so we expose this as a Promise and `useSpellcheck` loads it
 * lazily once a textarea actually mounts.
 */
export function loadChecker(): Promise<Checker> {
  if (cached) return Promise.resolve(cached)
  if (loading) return loading
  loading = new Promise<Checker>((resolve) => {
    // Defer construction one tick so the first paint after mount isn't
    // blocked by the synchronous nspell setup work.
    setTimeout(() => {
      cached = nspell(affRaw, dicRaw) as unknown as Checker
      resolve(cached)
    }, 0)
  })
  return loading
}

/**
 * For tests: swap in a fake checker so the hook + components can exercise
 * the spell-check flow without parsing the real 550KB dictionary on every
 * vitest run. Calling with `null` restores the real loader.
 */
export function __setCheckerForTests(stub: Checker | null): void {
  cached = stub
  loading = null
}
