import type { EmbeddingProvider } from "./types"

/**
 * Phase 6 ships with the `none` provider only — it errors loudly if anyone
 * tries to embed. The provider factory exposes the slot a follow-up PR
 * (OpenAI / local model / opencode-plugin) plugs into without changing
 * call sites.
 */
export type ProviderID = "none" | "openai" | "local" | "opencode-plugin"

export class SemanticIndexingDisabledError extends Error {
  constructor() {
    super(
      "Semantic indexing is disabled. Set `opencui.indexing.semantic.provider` to a real provider before enabling the index.",
    )
    this.name = "SemanticIndexingDisabledError"
  }
}

export class NoneProvider implements EmbeddingProvider {
  id = "none"
  dimensions = 0
  embed(_texts: string[]): Promise<Float32Array[]> {
    return Promise.reject(new SemanticIndexingDisabledError())
  }
}

export function createEmbeddingProvider(id: ProviderID): EmbeddingProvider {
  switch (id) {
    case "openai":
    case "local":
    case "opencode-plugin":
      // Follow-up: real implementations land here. Until they do, fall
      // through to the no-op provider so the rest of the pipeline doesn't
      // crash when the setting is flipped.
      return new NoneProvider()
    case "none":
    default:
      return new NoneProvider()
  }
}
