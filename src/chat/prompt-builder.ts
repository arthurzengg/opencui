import * as vscode from "vscode"
import * as path from "path"
import type { getEditorContext } from "../context"
import type { WorkspaceRoot } from "../workspace-root"
import { log } from "../output"

const MENTION_MAX_BYTES = 200_000
const MENTION_MAX_FILES = 20

export function buildPrompt(
  userText: string,
  ctx: ReturnType<typeof getEditorContext>,
  mentionBlock?: string,
  workspace?: WorkspaceRoot,
): string {
  const lines: string[] = []
  if (workspace) {
    lines.push("Workspace:")
    lines.push(`- Name: ${workspace.name}`)
    lines.push(`- Root: ${workspace.fsPath}`)
    lines.push("- Paths below are workspace-relative unless marked absolute.")
    lines.push("")
  }
  if (mentionBlock) {
    lines.push(mentionBlock)
    lines.push("")
  }
  if (ctx.relativePath) {
    lines.push(`Context: ${ctx.relativePath}`)
    if (ctx.selection) {
      lines.push(`Selection (lines ${ctx.selection.startLine}-${ctx.selection.endLine}):`)
      lines.push("```" + (ctx.language ?? ""))
      lines.push(ctx.selection.text)
      lines.push("```")
    }
    lines.push("")
  }
  lines.push(userText)
  return lines.join("\n")
}

export type MentionReadResult = {
  /** Prompt block to splice into `buildPrompt`'s `mentionBlock` slot. */
  block?: string
  /**
   * Per-mention byte accounting used by the manifest builder. Only entries
   * we actually attempted to read live here — successful reads (truncated or
   * not) and capped reads are still recorded so the manifest can render the
   * right status. Failed reads land in `failed` instead.
   */
  bytes: Record<string, { included: number; original: number }>
  /** Mentions skipped because we hit the per-prompt file/byte cap. */
  capped: string[]
  /** Mentions whose underlying file read threw (ENOENT etc.). */
  failed: string[]
}

export async function readMentions(mentions?: string[]): Promise<MentionReadResult> {
  if (!mentions || mentions.length === 0) {
    return { bytes: {}, capped: [], failed: [] }
  }
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return { bytes: {}, capped: [], failed: [] }
  const seen = new Set<string>()
  const blocks: string[] = []
  const bytes: Record<string, { included: number; original: number }> = {}
  const capped: string[] = []
  const failed: string[] = []
  let totalBytes = 0
  for (const rel of mentions) {
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    if (blocks.length >= MENTION_MAX_FILES) {
      capped.push(rel)
      continue
    }
    const uri = path.isAbsolute(rel) ? vscode.Uri.file(rel) : vscode.Uri.joinPath(folder.uri, rel)
    try {
      const buf = await vscode.workspace.fs.readFile(uri)
      const remaining = MENTION_MAX_BYTES - totalBytes
      if (remaining <= 0) {
        capped.push(rel)
        continue
      }
      const truncated = buf.byteLength > remaining
      const slice = truncated ? buf.slice(0, remaining) : buf
      const content = Buffer.from(slice).toString("utf8")
      const lang = guessFenceLang(rel)
      const note = truncated ? ` (truncated to ${remaining} bytes)` : ""
      blocks.push(`@${rel}${note}\n\`\`\`${lang}\n${content}\n\`\`\``)
      bytes[rel] = { included: slice.byteLength, original: buf.byteLength }
      totalBytes += slice.byteLength
    } catch (e) {
      log("readMentions: skipping", rel, e)
      failed.push(rel)
    }
  }
  const block = blocks.length > 0 ? ["Files attached:", ...blocks].join("\n") : undefined
  return { block, bytes, capped, failed }
}

function guessFenceLang(rel: string): string {
  const ext = path.extname(rel).slice(1).toLowerCase()
  const map: Record<string, string> = {
    ts: "ts", tsx: "tsx", js: "js", jsx: "jsx", mjs: "js", cjs: "js",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
    cs: "csharp", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp",
    sh: "sh", bash: "sh", zsh: "sh", fish: "sh",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "md", html: "html", css: "css", scss: "scss",
    sql: "sql", swift: "swift", php: "php",
  }
  return map[ext] ?? ext
}
