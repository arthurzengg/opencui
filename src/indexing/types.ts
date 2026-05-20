/**
 * Phase 6 (#117) scaffold types for the optional semantic index. The
 * interfaces below are designed so a future PR can drop in a real embedding
 * provider (OpenAI / local model / opencode-plugin) and a SQLite-backed
 * vector store without changing call sites.
 *
 * Phase 6 ships with the `none` provider + the in-memory vector store. The
 * index is opt-in (`opencui.indexing.semantic.enabled: false` by default)
 * and the manager refuses to scan when the provider is `none`.
 */

export type IndexedChunk = {
  id: string
  /** Workspace root the chunk lives under — required for multi-root tagging. */
  root: string
  /** Workspace-relative path. */
  path: string
  language?: string
  startLine: number
  endLine: number
  text: string
  /** Content hash used to skip re-indexing unchanged chunks. */
  hash: string
  /** Symbol names overlapping this chunk's line range, when known. */
  symbols: string[]
  embedding?: Float32Array
  updatedAt: number
}

export type SearchOptions = {
  limit?: number
  /** Optional restriction to a single workspace root. */
  root?: string
  /** Lexical hints used by the hybrid ranker. */
  textHint?: string
}

export type SearchHit = {
  chunkID: string
  path: string
  root: string
  startLine: number
  endLine: number
  score: number
  reasons: string[]
  preview: string
}

export interface VectorStore {
  open(): Promise<void>
  upsert(chunks: IndexedChunk[]): Promise<void>
  deleteByPath(root: string, path: string): Promise<void>
  /** Embedding-similarity search. Returns hits ordered by descending score. */
  search(queryEmbedding: Float32Array, options: SearchOptions): Promise<SearchHit[]>
  /** Lexical fallback when no embedding provider is configured. */
  textSearch(query: string, options: SearchOptions): Promise<SearchHit[]>
  close(): Promise<void>
  /** Diagnostic accessor used by the status surface. */
  size(): Promise<number>
}

export interface EmbeddingProvider {
  /** Stable id ("none" / "openai" / "local" / …). */
  id: string
  /** Output dimensionality; 0 for providers that can't embed (`none`). */
  dimensions: number
  embed(texts: string[]): Promise<Float32Array[]>
}
