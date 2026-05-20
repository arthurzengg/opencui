import * as vscode from "vscode"
import { primaryWorkspaceRoot, type WorkspaceRoot } from "../workspace-root"
import { log } from "../output"
import { chunkText } from "./chunker"
import { createEmbeddingProvider, type ProviderID } from "./embedding-provider"
import { scanWorkspace } from "./file-scanner"
import { MemoryVectorStore } from "./vector-store"
import { hybridSearch } from "./search"
import { INITIAL_STATUS, type IndexStatus } from "./status"
import type { EmbeddingProvider, IndexedChunk, SearchHit, VectorStore } from "./types"

export type IndexSettings = {
  enabled: boolean
  providerID: ProviderID
  maxFileBytes: number
  maxFiles: number
  includeGlobs: string[]
  excludeGlobs: string[]
}

export const DEFAULT_INDEX_SETTINGS: IndexSettings = {
  enabled: false,
  providerID: "none",
  maxFileBytes: 500_000,
  maxFiles: 50_000,
  includeGlobs: ["**/*"],
  excludeGlobs: [
    "**/{node_modules,.git,dist,build,out,coverage,.next,.turbo,.cache}/**",
  ],
}

/**
 * Read indexing settings from a VS Code configuration object. Falls back to
 * the defaults above when any key is missing — useful both at runtime and
 * in tests that don't want to stand up a full mock.
 */
export function readIndexSettings(config: {
  get<T>(key: string): T | undefined
}): IndexSettings {
  return {
    enabled: config.get<boolean>("indexing.semantic.enabled") ?? DEFAULT_INDEX_SETTINGS.enabled,
    providerID:
      (config.get<ProviderID>("indexing.semantic.provider") ?? DEFAULT_INDEX_SETTINGS.providerID),
    maxFileBytes:
      config.get<number>("indexing.maxFileBytes") ?? DEFAULT_INDEX_SETTINGS.maxFileBytes,
    maxFiles: config.get<number>("indexing.maxFiles") ?? DEFAULT_INDEX_SETTINGS.maxFiles,
    includeGlobs:
      config.get<string[]>("indexing.includeGlobs") ?? DEFAULT_INDEX_SETTINGS.includeGlobs,
    excludeGlobs:
      config.get<string[]>("indexing.excludeGlobs") ?? DEFAULT_INDEX_SETTINGS.excludeGlobs,
  }
}

/**
 * Top-level controller for the semantic index. Phase 6 ships an in-memory
 * `MemoryVectorStore` + the `none` embedding provider — the manager scans,
 * chunks, and stores text but never produces embeddings. A follow-up swaps
 * the provider for a real one without changing public API.
 *
 * Index lifecycle:
 *   `disabled` → user enables → `scanning` → `ready` (or `error`).
 * The manager intentionally does NOT auto-start: the constructor records
 * the settings and waits for an explicit `start()` call. That keeps the
 * extension activation path lean.
 */
export class IndexManager {
  private store: VectorStore
  private provider: EmbeddingProvider
  private status: IndexStatus = { ...INITIAL_STATUS }
  private listeners = new Set<(status: IndexStatus) => void>()
  private settings: IndexSettings

  constructor(settings: IndexSettings, deps?: { store?: VectorStore; provider?: EmbeddingProvider }) {
    this.settings = settings
    this.store = deps?.store ?? new MemoryVectorStore()
    this.provider = deps?.provider ?? createEmbeddingProvider(settings.providerID)
  }

  onStatusChange(listener: (status: IndexStatus) => void): vscode.Disposable {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  currentStatus(): IndexStatus {
    return this.status
  }

  /**
   * Idempotent start. When disabled or no workspace, sets the status to
   * `disabled` and returns. Otherwise scans, chunks, and stores; flips to
   * `ready` (or `error`). The `none` provider produces no embeddings —
   * `textSearch` is what actually answers queries until a real provider
   * lands.
   */
  async start(workspace?: WorkspaceRoot): Promise<void> {
    const root = workspace ?? primaryWorkspaceRoot()
    if (!this.settings.enabled) {
      this.setStatus({
        state: "disabled",
        message: "Semantic indexing is off. Enable `opencui.indexing.semantic.enabled` to scan the workspace.",
        updatedAt: Date.now(),
      })
      return
    }
    if (!root) {
      this.setStatus({ state: "disabled", message: "No workspace folder open", updatedAt: Date.now() })
      return
    }
    this.setStatus({ state: "scanning", updatedAt: Date.now() })
    try {
      await this.store.open()
      const scan = await scanWorkspace(root, {
        includeGlobs: this.settings.includeGlobs,
        excludeGlobs: this.settings.excludeGlobs,
        maxFiles: this.settings.maxFiles,
        maxFileBytes: this.settings.maxFileBytes,
      })
      log(`index: scan found ${scan.files.length} files (${scan.skipped} skipped)`)
      const chunks: IndexedChunk[] = []
      for (const file of scan.files) {
        let bytes: Uint8Array
        try {
          bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file.absolutePath))
        } catch {
          continue
        }
        const text = Buffer.from(bytes).toString("utf8")
        for (const raw of chunkText(file.relativePath, text)) {
          chunks.push({
            id: `${root.fsPath}:${raw.path}:${raw.startLine}-${raw.endLine}:${raw.hash}`,
            root: root.fsPath,
            path: raw.path,
            language: raw.language,
            startLine: raw.startLine,
            endLine: raw.endLine,
            text: raw.text,
            hash: raw.hash,
            symbols: [],
            updatedAt: Date.now(),
          })
        }
      }
      if (chunks.length > 0) await this.store.upsert(chunks)
      const stored = await this.store.size()
      this.setStatus({
        state: "ready",
        chunks: stored,
        updatedAt: Date.now(),
      })
    } catch (e) {
      log("index: scan failed", e)
      this.setStatus({
        state: "error",
        message: (e as Error).message,
        updatedAt: Date.now(),
      })
    }
  }

  async search(query: string, root?: string, limit = 8): Promise<SearchHit[]> {
    if (this.status.state !== "ready") return []
    return hybridSearch(query, this.store, this.provider, { root, limit })
  }

  async stop(): Promise<void> {
    await this.store.close().catch(() => undefined)
    this.setStatus({ state: "disabled", updatedAt: Date.now() })
  }

  private setStatus(next: IndexStatus) {
    this.status = next
    for (const l of this.listeners) {
      try { l(next) } catch (e) { log("index status listener threw", e) }
    }
  }
}
