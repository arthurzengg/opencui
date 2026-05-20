/**
 * Line-based chunker used by the Phase 6 MVP scaffold. The chunker emits
 * fixed-size overlapping line windows so a follow-up retrieval pass can
 * pull contiguous context regardless of whether the file has parsed
 * symbol structure.
 *
 * Future PRs can replace this with a symbol-aware chunker (VS Code
 * `executeDocumentSymbolProvider` followed by syntax-aware line packing).
 * The output shape and `chunkText` API stay the same so the rest of the
 * pipeline doesn't change.
 */

import { createHash } from "crypto"

export type RawChunk = {
  path: string
  language?: string
  startLine: number
  endLine: number
  text: string
  hash: string
}

const DEFAULT_WINDOW = 60
const DEFAULT_STEP = 40

export function chunkText(
  path: string,
  text: string,
  options: { language?: string; window?: number; step?: number } = {},
): RawChunk[] {
  const window = options.window ?? DEFAULT_WINDOW
  const step = options.step ?? DEFAULT_STEP
  const lines = text.split(/\r?\n/)
  if (lines.length === 0) return []
  if (lines.length <= window) {
    return [makeChunk(path, options.language, 1, lines.length, lines.join("\n"))]
  }
  const chunks: RawChunk[] = []
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + window, lines.length)
    const slice = lines.slice(start, end).join("\n")
    chunks.push(makeChunk(path, options.language, start + 1, end, slice))
    if (end === lines.length) break
  }
  return chunks
}

function makeChunk(
  path: string,
  language: string | undefined,
  startLine: number,
  endLine: number,
  text: string,
): RawChunk {
  const hash = createHash("sha1").update(`${path}:${startLine}-${endLine}:${text}`).digest("hex")
  return { path, language, startLine, endLine, text, hash }
}
