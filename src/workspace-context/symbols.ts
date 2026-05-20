import * as vscode from "vscode"
import * as path from "path"
import { isInsideRoot, relativeToRoot, type WorkspaceRoot } from "../workspace-root"
import type { CollectorOutput } from "./types"
import { log } from "../output"

const MAX_FILES = 5
const MAX_SYMBOLS_PER_FILE = 50

/**
 * Run VS Code's `executeDocumentSymbolProvider` against the active editor
 * and the user's mentions to capture an outline of structure (function /
 * class / type names + line ranges). Symbol bodies are intentionally NOT
 * included — Phase 3's symbol pass is a navigation hint, not full
 * substitution for the file. Phase 6's semantic index can layer richer
 * symbol-aware retrieval on top.
 */
export async function collectSymbols(
  workspace: WorkspaceRoot,
  focusPaths: string[],
): Promise<CollectorOutput> {
  const seen = new Set<string>()
  const files = focusPaths
    .map((rel) => path.join(workspace.fsPath, rel))
    .filter((abs) => {
      if (seen.has(abs)) return false
      seen.add(abs)
      return isInsideRoot(workspace, abs)
    })
    .slice(0, MAX_FILES)

  const items: CollectorOutput["items"] = []
  const blocks: CollectorOutput["blocks"] = []
  for (const abs of files) {
    const rel = relativeToRoot(workspace, abs)
    const uri = vscode.Uri.file(abs)
    let symbols: vscode.DocumentSymbol[] | undefined
    try {
      symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri,
      )
    } catch (e) {
      log("symbols collector: provider failed for", rel, e)
      continue
    }
    if (!symbols || symbols.length === 0) continue
    const flat = flatten(symbols).slice(0, MAX_SYMBOLS_PER_FILE)
    const lines = flat.map((s) => `- ${s.kind} ${s.name} (L${s.line})`)
    const content = `${rel}\n${lines.join("\n")}`
    const bytes = Buffer.byteLength(content, "utf8")
    const id = `symbols_${rel.replace(/[^a-zA-Z0-9]/g, "_")}`
    items.push({
      id,
      source: "symbol",
      kind: "symbol",
      label: `${rel} (${flat.length} symbol${flat.length === 1 ? "" : "s"})`,
      path: rel,
      reason: "Document outline for a focused file",
      status: "included",
      bytes,
      priority: 10,
    })
    blocks.push({
      id: `symbols_block_${rel}`,
      itemID: id,
      title: `Symbols — ${rel}`,
      path: rel,
      content,
      bytes,
      priority: 10,
    })
  }
  return { items, blocks }
}

type FlatSymbol = { name: string; kind: string; line: number }

function flatten(symbols: vscode.DocumentSymbol[], depth = 0): FlatSymbol[] {
  const out: FlatSymbol[] = []
  for (const s of symbols) {
    out.push({
      name: s.name,
      kind: kindName(s.kind),
      line: s.range.start.line + 1,
    })
    if (s.children && s.children.length > 0 && depth < 2) {
      out.push(...flatten(s.children, depth + 1))
    }
  }
  return out
}

function kindName(kind: vscode.SymbolKind): string {
  const map: Record<number, string> = {
    0: "file",
    1: "module",
    2: "namespace",
    3: "package",
    4: "class",
    5: "method",
    6: "property",
    7: "field",
    8: "constructor",
    9: "enum",
    10: "interface",
    11: "function",
    12: "variable",
    13: "constant",
    14: "string",
    15: "number",
    16: "boolean",
    17: "array",
    18: "object",
    19: "key",
    20: "null",
    21: "enumMember",
    22: "struct",
    23: "event",
    24: "operator",
    25: "typeParameter",
  }
  return map[kind] ?? "symbol"
}
