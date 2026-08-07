import type { LanguageRegistration } from "shiki/core"

/**
 * Fetches grammars emitted by the build into dist/webview/grammars/: one JSON
 * per unique registration plus manifest.json mapping each `@shikijs/langs`
 * entry to the registration names it needs (entries share dependencies —
 * ruby alone pulls ~30 — so fetching per-registration avoids shipping and
 * re-downloading duplicates). The host injects the base URI (`asWebviewUri`
 * of the directory) as an inline script in buildHtml — a webview's HTML is
 * set as a string, so relative URLs have nothing to resolve against.
 *
 * Every cache evicts on failure so one bad fetch degrades that block to
 * plaintext instead of poisoning all later highlights.
 */
declare global {
  interface Window {
    __opencuiGrammarsBase?: string
  }
}

async function fetchJson<T>(name: string): Promise<T> {
  const base = window.__opencuiGrammarsBase
  if (!base) throw new Error("grammars base URI not injected")
  const res = await fetch(`${base}/${name}.json`)
  if (!res.ok) throw new Error(`grammar ${name}: HTTP ${res.status}`)
  return (await res.json()) as T
}

type Manifest = Record<string, string[]>

let manifestPromise: Promise<Manifest> | undefined
function getManifest(): Promise<Manifest> {
  if (!manifestPromise) {
    manifestPromise = fetchJson<Manifest>("manifest")
    manifestPromise.catch(() => (manifestPromise = undefined))
  }
  return manifestPromise
}

const registrationLoads = new Map<string, Promise<LanguageRegistration>>()
function loadRegistration(name: string): Promise<LanguageRegistration> {
  let load = registrationLoads.get(name)
  if (!load) {
    load = fetchJson<LanguageRegistration>(name)
    registrationLoads.set(name, load)
    load.catch(() => registrationLoads.delete(name))
  }
  return load
}

export async function loadGrammar(file: string): Promise<LanguageRegistration[]> {
  const manifest = await getManifest()
  const names = manifest[file]
  if (!names) throw new Error(`grammar ${file}: not in manifest`)
  return Promise.all(names.map(loadRegistration))
}
