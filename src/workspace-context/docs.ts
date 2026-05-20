import * as vscode from "vscode"
import * as path from "path"
import type { WorkspaceRoot } from "../workspace-root"
import type { CollectorOutput } from "./types"
import { log } from "../output"

const KNOWN_DOCS = ["README.md", "CLAUDE.md", "AGENTS.md", "CONTRIBUTING.md"]
const DOC_SUMMARY_BYTES = 1200
const MAX_DOCS = 4

/**
 * Surface short summaries of project-root docs the agent should know about:
 * README, CLAUDE.md, AGENTS.md, CONTRIBUTING.md. For each one found we emit
 * the first `DOC_SUMMARY_BYTES` of content — enough for goals/conventions
 * but not enough to overflow the prompt with a long spec.
 *
 * Reads are workspace-root only — Phase 3's auto-context never reaches
 * outside open folders.
 */
export async function collectDocs(workspace: WorkspaceRoot): Promise<CollectorOutput> {
  const items: CollectorOutput["items"] = []
  const blocks: CollectorOutput["blocks"] = []
  let included = 0
  for (const name of KNOWN_DOCS) {
    if (included >= MAX_DOCS) break
    const uri = vscode.Uri.file(path.join(workspace.fsPath, name))
    try {
      const buf = await vscode.workspace.fs.readFile(uri)
      const truncated = buf.byteLength > DOC_SUMMARY_BYTES
      const slice = truncated ? buf.slice(0, DOC_SUMMARY_BYTES) : buf
      const content = Buffer.from(slice).toString("utf8")
      const bytes = slice.byteLength
      const id = `doc_${name}`
      items.push({
        id,
        source: "doc",
        kind: "file",
        label: name,
        path: name,
        reason: "Project documentation at the workspace root",
        status: truncated ? "truncated" : "included",
        bytes,
        priority: 9,
      })
      blocks.push({
        id: `doc_block_${name}`,
        itemID: id,
        title: name,
        path: name,
        language: "md",
        content,
        bytes,
        priority: 9,
      })
      included += 1
    } catch (e) {
      // Most projects only have README.md — fall through quietly.
      const code = (e as { code?: string }).code
      if (code !== "FileNotFound" && code !== "ENOENT" && code !== "EntryNotFound") {
        log("docs collector: skipping", name, e)
      }
    }
  }
  return { items, blocks }
}
