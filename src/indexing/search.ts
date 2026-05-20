import type { EmbeddingProvider, SearchHit, SearchOptions, VectorStore } from "./types"
import { SemanticIndexingDisabledError } from "./embedding-provider"

/**
 * Hybrid search entry point. Tries embedding search when a real provider is
 * configured, falls back to text/path/symbol matching otherwise. The doc
 * outlines further boosts (open-tabs, recent-edits, git-changed); those
 * layer on top in a follow-up PR — Phase 6 ships the two base passes.
 */
export async function hybridSearch(
  query: string,
  store: VectorStore,
  provider: EmbeddingProvider,
  options: SearchOptions,
): Promise<SearchHit[]> {
  const textHits = await store.textSearch(query, options)
  if (provider.id === "none") return textHits
  try {
    const [embedding] = await provider.embed([query])
    const vectorHits = await store.search(embedding, options)
    return mergeHits(vectorHits, textHits, options.limit ?? 10)
  } catch (e) {
    if (e instanceof SemanticIndexingDisabledError) return textHits
    throw e
  }
}

function mergeHits(primary: SearchHit[], secondary: SearchHit[], limit: number): SearchHit[] {
  const byId = new Map<string, SearchHit>()
  for (const hit of primary) byId.set(hit.chunkID, hit)
  for (const hit of secondary) {
    const existing = byId.get(hit.chunkID)
    if (!existing) {
      byId.set(hit.chunkID, hit)
      continue
    }
    byId.set(hit.chunkID, {
      ...existing,
      score: existing.score + hit.score * 0.5,
      reasons: [...new Set([...existing.reasons, ...hit.reasons])],
    })
  }
  return [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit)
}
