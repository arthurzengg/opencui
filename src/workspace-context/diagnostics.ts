import * as vscode from "vscode"
import { isInsideRoot, relativeToRoot, type WorkspaceRoot } from "../workspace-root"
import type { CollectorOutput } from "./types"

const MAX_DIAGS = 30

type Diag = {
  relativePath: string
  line: number
  severity: vscode.DiagnosticSeverity
  source?: string
  message: string
  code?: string
}

/**
 * Collect VS Code diagnostics (errors + warnings) for files inside the
 * workspace. Errors come first, then warnings; capped at `MAX_DIAGS` so a
 * project with a sea of warnings doesn't blow the prompt budget. Info /
 * hint severities are dropped — they rarely matter to an LLM and add noise.
 */
export function collectDiagnostics(workspace: WorkspaceRoot): CollectorOutput {
  const errors: Diag[] = []
  const warnings: Diag[] = []
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file") continue
    if (!isInsideRoot(workspace, uri.fsPath)) continue
    const rel = relativeToRoot(workspace, uri.fsPath)
    for (const d of diags) {
      const entry: Diag = {
        relativePath: rel,
        line: d.range.start.line + 1,
        severity: d.severity,
        source: d.source,
        message: d.message,
        code: typeof d.code === "object" ? String((d.code as { value?: unknown }).value ?? "") : String(d.code ?? ""),
      }
      if (d.severity === vscode.DiagnosticSeverity.Error) errors.push(entry)
      else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings.push(entry)
    }
  }
  const trimmed = [...errors, ...warnings].slice(0, MAX_DIAGS)
  if (trimmed.length === 0) return { items: [], blocks: [] }
  const lines = trimmed.map((d) => {
    const sev = d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning"
    const src = d.source ? `${d.source}: ` : ""
    const code = d.code ? `[${d.code}] ` : ""
    return `- ${d.relativePath}:${d.line} ${sev} ${src}${code}${d.message}`
  })
  const content = lines.join("\n")
  const bytes = Buffer.byteLength(content, "utf8")
  const id = `diagnostics_${Date.now()}`
  return {
    items: [
      {
        id,
        source: "diagnostic",
        kind: "diagnostic",
        label: `Diagnostics (${trimmed.length})`,
        reason: `${errors.length} error${errors.length === 1 ? "" : "s"}, ${warnings.length} warning${warnings.length === 1 ? "" : "s"} in the workspace`,
        status: "included",
        bytes,
        priority: 5,
      },
    ],
    blocks: [
      {
        id: `diagnostics_block`,
        itemID: id,
        title: "Diagnostics",
        content,
        bytes,
        priority: 5,
      },
    ],
  }
}
