/**
 * Pure helpers for the AI-provider management picker — building the connected
 * provider rows and performing the credential removal. Kept free of `vscode`
 * so they unit-test in the node project without the API stub (mirrors
 * `src/mcp/status-format.ts`).
 */

/** One authenticated provider, as shown in the picker. */
export type ProviderRow = {
  id: string
  name: string
  /** opencode config source: "env" | "config" | "custom" | "api" | "unknown". */
  source: string
  /** env-var providers can't be removed here (mirrors opencode's `canDisconnect`). */
  removable: boolean
}

export type RemoveResult =
  | { kind: "ok" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }

export const UNSUPPORTED_HINT =
  "Removing a provider needs a newer opencode — the DELETE /auth/{id} endpoint isn't in your version yet. Update opencode, or run: opencode auth logout"

/**
 * Merge the authenticated provider ids (`provider.list().connected`) with the
 * config provider metadata (`config.providers()`) into display rows. A
 * connected id missing from config keeps its id as the name and is assumed
 * removable. env-sourced providers are marked non-removable. Sorted by name.
 */
export function removableProviders(
  connected: ReadonlyArray<string>,
  configProviders: ReadonlyArray<{ id: string; name?: string; source?: string }>,
): ProviderRow[] {
  const byId = new Map(configProviders.map((p) => [p.id, p]))
  const rows = connected.map((id): ProviderRow => {
    const cfg = byId.get(id)
    const source = cfg?.source ?? "unknown"
    return {
      id,
      name: cfg?.name?.trim() || id,
      source,
      removable: source !== "env",
    }
  })
  rows.sort((a, b) => a.name.localeCompare(b.name))
  return rows
}

/** A login method for a provider (mirrors the SDK's `ProviderAuthMethod`). */
export type AuthMethod = { type: string; label: string }

/** A provider the user can connect, with its available login methods. */
export type ConnectableProvider = {
  id: string
  name: string
  connected: boolean
  /** In declared order — the array index is the `method` the OAuth endpoints expect. */
  methods: AuthMethod[]
}

/**
 * Fallback login method for catalog providers with no declared flow.
 * opencode's `auth.set` accepts a plain API key for ANY provider id — the
 * TUI's `auth login` offers the whole catalog this way — so a missing
 * `provider.auth()` entry means "API key", not "not connectable" (#567).
 */
const API_KEY_METHOD: AuthMethod = { type: "api", label: "API key" }

/**
 * Build the "connect a provider" list by merging `provider.auth()`
 * (providerID -> declared login methods: OAuth flows, device logins, …)
 * with the full catalog behind the id->name map (from `provider.list().all`
 * / `config.providers()`). Catalog providers without declared methods get
 * the synthetic API-key method; declared methods always win, and their
 * order is preserved because the OAuth `method` field is an index into it.
 * An id with an empty declared list and no catalog presence stays dropped.
 * Already-connected providers stay (so they can re-auth) and are flagged.
 * Sorted by name.
 */
export function connectableProviders(
  methodsByProvider: Readonly<Record<string, ReadonlyArray<AuthMethod>>>,
  names: ReadonlyMap<string, string>,
  connected: ReadonlyArray<string>,
): ConnectableProvider[] {
  const connectedSet = new Set(connected)
  const ids = new Set(names.keys())
  for (const [id, methods] of Object.entries(methodsByProvider)) {
    if (methods.length > 0) ids.add(id)
  }
  return [...ids]
    .map((id): ConnectableProvider => {
      const declared = methodsByProvider[id] ?? []
      return {
        id,
        name: names.get(id)?.trim() || id,
        connected: connectedSet.has(id),
        methods: declared.length > 0
          ? declared.map((m) => ({ type: m.type, label: m.label }))
          : [{ ...API_KEY_METHOD }],
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The opencode route that removes a provider's stored credentials. */
export function authDeletePath(id: string): string {
  return `/auth/${encodeURIComponent(id)}`
}

/** The opencode route that disposes the cached per-directory instance state. */
export function instanceDisposePath(directory: string): string {
  return `/instance/dispose?directory=${encodeURIComponent(directory)}`
}

/**
 * Drop the server's cached instance state so the next `config.providers`
 * read is rebuilt from disk. opencode builds provider config lazily on
 * first access and caches it; `auth.set` / credential removal do NOT
 * invalidate that cache, so a freshly connected provider's models stay
 * invisible (and a removed one lingers) until the cache is dropped (#571).
 * The published SDK doesn't expose the route — untyped POST, same pattern
 * as `removeProviderAuth`. Returns false on any failure (network error, or
 * an older opencode without the route) so the caller can fall back to
 * offering a server restart. Verified live: the global SSE stream survives
 * a dispose, so a running chat is not disturbed.
 */
export async function refreshInstance(
  baseUrl: string,
  directory: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const url = baseUrl.replace(/\/+$/, "") + instanceDisposePath(directory)
  try {
    const res = await fetchImpl(url, { method: "POST" })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Remove a provider's stored credentials.
 *
 * No published `@opencode-ai/sdk` exposes provider-credential removal yet —
 * the top-level `client.auth.remove` still maps to the MCP route
 * (`/mcp/{name}/auth`). The provider route `DELETE /auth/{id}` (operationId
 * `auth.remove`, returns `true`) currently exists only on opencode's `dev`
 * branch, so we call it untyped via `fetch`. When a published SDK ships it,
 * replace this with `client.auth.remove({ path: { providerID } })`.
 *
 * We only ever pass ids from `provider.list().connected`, so a 404 means the
 * route is missing (older opencode) — not "no such credential". `fetchImpl` is
 * injectable so this is unit-testable without a live server.
 */
export async function removeProviderAuth(
  baseUrl: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RemoveResult> {
  const url = baseUrl.replace(/\/+$/, "") + authDeletePath(id)
  let res: Response
  try {
    res = await fetchImpl(url, { method: "DELETE" })
  } catch (e) {
    return { kind: "error", message: (e as Error).message }
  }
  if (res.ok) return { kind: "ok" }
  if (res.status === 404) return { kind: "unsupported" }
  return { kind: "error", message: `HTTP ${res.status}` }
}
