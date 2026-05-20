import * as vscode from "vscode"
import { isInsideRoot, relativeToRoot, type WorkspaceRoot } from "../workspace-root"
import type { CollectorOutput } from "./types"

const MAX_MRU = 20
const MAX_INCLUDED = 10

/**
 * In-memory MRU of recently-edited workspace files. Subscribes to VS Code's
 * text/save/create/delete/rename events when constructed; clients call
 * `list(workspace)` to get the current ordered list.
 *
 * Not persisted across reloads — Phase 3's recall is a soft signal; the cost
 * of cold-start being empty is small and skipping persistence keeps this
 * collector free of state-management headaches.
 */
export class RecentEditsTracker {
  private mru: string[] = []
  private disposables: vscode.Disposable[] = []

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.touch(e.document.uri)),
      vscode.workspace.onDidSaveTextDocument((doc) => this.touch(doc.uri)),
      vscode.workspace.onDidCreateFiles((e) => e.files.forEach((u) => this.touch(u))),
      vscode.workspace.onDidRenameFiles((e) => e.files.forEach((f) => this.touch(f.newUri))),
      // Deletion: drop the path from the MRU; it can't be recalled later.
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const u of e.files) {
          if (u.scheme !== "file") continue
          this.mru = this.mru.filter((p) => p !== u.fsPath)
        }
      }),
    )
  }

  dispose() {
    for (const d of this.disposables) d.dispose()
    this.disposables = []
  }

  private touch(uri: vscode.Uri) {
    if (uri.scheme !== "file") return
    const fsPath = uri.fsPath
    this.mru = [fsPath, ...this.mru.filter((p) => p !== fsPath)]
    if (this.mru.length > MAX_MRU) this.mru.length = MAX_MRU
  }

  list(workspace: WorkspaceRoot): string[] {
    return this.mru.filter((p) => isInsideRoot(workspace, p))
  }

  async collect(workspace: WorkspaceRoot): Promise<CollectorOutput> {
    const paths = this.list(workspace).slice(0, MAX_INCLUDED)
    if (paths.length === 0) return { items: [], blocks: [] }
    const lines = paths.map((p) => `- ${relativeToRoot(workspace, p)}`)
    const content = lines.join("\n")
    const bytes = Buffer.byteLength(content, "utf8")
    const id = `recent_${Date.now()}`
    return {
      items: [
        {
          id,
          source: "recentEdit",
          kind: "summary",
          label: `Recent edits (${paths.length})`,
          reason: "Files touched recently in this VS Code session",
          status: "included",
          bytes,
          priority: 8,
        },
      ],
      blocks: [
        {
          id: "recent_block",
          itemID: id,
          title: "Recent Edits",
          content,
          bytes,
          priority: 8,
        },
      ],
    }
  }
}
