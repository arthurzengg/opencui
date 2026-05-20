import type { IndexedChunk, SearchHit, SearchOptions, VectorStore } from "./types"

/**
 * In-memory vector store. Suitable for the Phase 6 MVP scaffold and tests.
 * Real persistence (SQLite / WASM vector store) lands in a follow-up — the
 * VectorStore interface stays stable so the swap is mechanical.
 *
 * Search shape:
 * - `search(embedding, opts)` — cosine similarity against stored embeddings.
 *   Returns [] when no chunk carries an embedding (the `none` provider
 *   path), which keeps the rest of the pipeline honest.
 * - `textSearch(query, opts)` — case-insensitive substring match against
 *   chunk text and symbol names. The Phase 6 scaffold relies on this until
 *   a real embedding provider drops in.
 */
export class MemoryVectorStore implements VectorStore {
  private chunks = new Map<string, IndexedChunk>()
  private opened = false

  async open(): Promise<void> {
    this.opened = true
  }

  async upsert(chunks: IndexedChunk[]): Promise<void> {
    for (const chunk of chunks) this.chunks.set(chunk.id, chunk)
  }

  async deleteByPath(root: string, path: string): Promise<void> {
    for (const [id, chunk] of this.chunks) {
      if (chunk.root === root && chunk.path === path) this.chunks.delete(id)
    }
  }

  async search(queryEmbedding: Float32Array, options: SearchOptions): Promise<SearchHit[]> {
    const hits: SearchHit[] = []
    for (const chunk of this.chunks.values()) {
      if (options.root && chunk.root !== options.root) continue
      if (!chunk.embedding) continue
      const score = cosine(queryEmbedding, chunk.embedding)
      hits.push(toHit(chunk, score, ["embedding"]))
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 10)
  }

  async textSearch(query: string, options: SearchOptions): Promise<SearchHit[]> {
    const needle = query.toLowerCase().trim()
    if (!needle) return []
    const hits: SearchHit[] = []
    for (const chunk of this.chunks.values()) {
      if (options.root && chunk.root !== options.root) continue
      const text = chunk.text.toLowerCase()
      const path = chunk.path.toLowerCase()
      const symbols = chunk.symbols.map((s) => s.toLowerCase())
      const reasons: string[] = []
      let score = 0
      if (path.includes(needle)) {
        score += 0.6
        reasons.push("path-match")
      }
      if (symbols.some((s) => s.includes(needle))) {
        score += 0.5
        reasons.push("symbol-match")
      }
      if (text.includes(needle)) {
        score += 0.4
        reasons.push("text-match")
      }
      if (score > 0) hits.push(toHit(chunk, score, reasons))
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 10)
  }

  async close(): Promise<void> {
    this.chunks.clear()
    this.opened = false
  }

  async size(): Promise<number> {
    return this.chunks.size
  }

  /** Test helper — undocumented but kept stable for the test suite. */
  isOpen(): boolean {
    return this.opened
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function toHit(chunk: IndexedChunk, score: number, reasons: string[]): SearchHit {
  return {
    chunkID: chunk.id,
    path: chunk.path,
    root: chunk.root,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    score,
    reasons,
    preview: chunk.text.slice(0, 240),
  }
}
