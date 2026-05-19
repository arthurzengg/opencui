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

export async function readMentions(mentions?: string[]): Promise<string | undefined> {
  if (!mentions || mentions.length === 0) return undefined
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return undefined
  const seen = new Set<string>()
  const blocks: string[] = []
  let totalBytes = 0
  for (const rel of mentions) {
    if (blocks.length >= MENTION_MAX_FILES) break
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    const uri = path.isAbsolute(rel) ? vscode.Uri.file(rel) : vscode.Uri.joinPath(folder.uri, rel)
    try {
      const buf = await vscode.workspace.fs.readFile(uri)
      const remaining = MENTION_MAX_BYTES - totalBytes
      if (remaining <= 0) break
      const truncated = buf.byteLength > remaining
      const slice = truncated ? buf.slice(0, remaining) : buf
      const content = Buffer.from(slice).toString("utf8")
      const lang = guessFenceLang(rel)
      const note = truncated ? ` (truncated to ${remaining} bytes)` : ""
      blocks.push(`@${rel}${note}\n\`\`\`${lang}\n${content}\n\`\`\``)
      totalBytes += slice.byteLength
    } catch (e) {
      log("readMentions: skipping", rel, e)
    }
  }
  if (blocks.length === 0) return undefined
  return ["Files attached:", ...blocks].join("\n")
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
