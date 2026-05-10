import * as vscode from "vscode"
import * as path from "path"
import type { FileSearchHit } from "./protocol"

const MAX_FILES = 5000
const MAX_HITS = 30

let cache: FileSearchHit[] | undefined
let cacheLoadedAt = 0
const CACHE_TTL_MS = 30_000

async function loadFiles(): Promise<FileSearchHit[]> {
  const now = Date.now()
  if (cache && now - cacheLoadedAt < CACHE_TTL_MS) return cache
  const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,dist,build,out,coverage,.next,.turbo,.cache}/**", MAX_FILES)
  cache = uris.map((uri) => ({
    path: vscode.workspace.asRelativePath(uri),
    name: path.basename(uri.fsPath),
  }))
  cacheLoadedAt = now
  return cache
}

export function invalidateFileCache() {
  cache = undefined
  cacheLoadedAt = 0
}

export async function searchWorkspaceFiles(query: string): Promise<FileSearchHit[]> {
  const all = await loadFiles()
  return rankHits(all, query).slice(0, MAX_HITS)
}

/**
 * Rank `entries` against `query`. Empty query returns the entries in their
 * original order (capped). Non-empty query orders by:
 *   1. Exact basename match
 *   2. Basename prefix match
 *   3. Basename substring match
 *   4. Path substring match
 * Within each tier, shorter paths win (likely the more "central" file).
 */
export function rankHits(entries: FileSearchHit[], query: string): FileSearchHit[] {
  const q = query.toLowerCase().trim()
  if (!q) return entries.slice(0, MAX_HITS)
  const scored: Array<{ hit: FileSearchHit; score: number; len: number }> = []
  for (const hit of entries) {
    const name = hit.name.toLowerCase()
    const fullPath = hit.path.toLowerCase()
    let score: number
    if (name === q) score = 0
    else if (name.startsWith(q)) score = 1
    else if (name.includes(q)) score = 2
    else if (fullPath.includes(q)) score = 3
    else continue
    scored.push({ hit, score, len: hit.path.length })
  }
  scored.sort((a, b) => a.score - b.score || a.len - b.len)
  return scored.map((s) => s.hit)
}
