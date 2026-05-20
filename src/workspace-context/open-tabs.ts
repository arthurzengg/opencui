import * as vscode from "vscode"
import { isInsideRoot, relativeToRoot, type WorkspaceRoot } from "../workspace-root"
import type { CollectorOutput } from "./types"

const MAX_TABS = 20

/**
 * Collect workspace-relative paths of files currently open as tabs. Returns
 * metadata only — file contents are NOT included (the picker, the agent's
 * tools, and other collectors are responsible for content if needed). This
 * gives the model a "here are the files the user is looking at" hint without
 * blowing the prompt budget.
 *
 * Active editor first, then tab-group order. Files outside the workspace are
 * dropped — Phase 3's automatic context is workspace-bound by design.
 */
export async function collectOpenTabs(workspace: WorkspaceRoot): Promise<CollectorOutput> {
  const out: Array<{ relativePath: string; active: boolean }> = []
  const seen = new Set<string>()
  const active = vscode.window.activeTextEditor?.document.uri
  const push = (uri: vscode.Uri, isActive: boolean) => {
    if (uri.scheme !== "file") return
    if (!isInsideRoot(workspace, uri.fsPath)) return
    const rel = relativeToRoot(workspace, uri.fsPath)
    if (!rel || seen.has(rel)) return
    seen.add(rel)
    out.push({ relativePath: rel, active: isActive })
  }
  if (active) push(active, true)
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input
      if (input && typeof input === "object" && "uri" in input) {
        push((input as { uri: vscode.Uri }).uri, false)
      }
    }
  }
  const trimmed = out.slice(0, MAX_TABS)
  if (trimmed.length === 0) return { items: [], blocks: [] }
  const lines = trimmed.map((t) => `- ${t.relativePath}${t.active ? "  (active)" : ""}`)
  const content = lines.join("\n")
  const bytes = Buffer.byteLength(content, "utf8")
  return {
    items: [
      {
        id: `open-tabs_${Date.now()}`,
        source: "openTab",
        kind: "summary",
        label: `Open tabs (${trimmed.length})`,
        reason: "Files currently open in the editor — hints at user focus",
        status: "included",
        bytes,
        priority: 7,
      },
    ],
    blocks: [
      {
        id: `open-tabs_block`,
        itemID: `open-tabs_${Date.now()}`,
        title: "Open Tabs",
        content,
        bytes,
        priority: 7,
      },
    ],
  }
}
