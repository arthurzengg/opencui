import * as vscode from "vscode"
import { log } from "../output"

/**
 * Decode a `data:<mime>;base64,...` URL into raw bytes. Returns undefined for
 * non-base64 or malformed data URLs so callers can fall back to persisting the
 * string as-is rather than corrupting the payload.
 */
export function dataUrlToBytes(dataUrl: string): Uint8Array | undefined {
  const comma = dataUrl.indexOf(",")
  if (comma === -1 || !dataUrl.slice(0, comma).includes(";base64")) return undefined
  try {
    return new Uint8Array(Buffer.from(dataUrl.slice(comma + 1), "base64"))
  } catch {
    return undefined
  }
}

/**
 * Disk home for attachment payloads (`<storage>/attachments/<storageID>`).
 * Conversation state keeps only the storageID; the bytes live here exactly
 * once, so the 300 ms persist loop never re-serializes megabytes of base64
 * into workspaceState.
 *
 * All methods are best-effort: a missing storage root (no workspace) or a
 * failed write returns undefined and the caller keeps the legacy inline
 * dataUrl behavior instead of losing the attachment.
 */
export class AttachmentStore {
  private readonly dir?: vscode.Uri
  private ensuredDir = false

  constructor(base: vscode.Uri | undefined) {
    this.dir = base ? vscode.Uri.joinPath(base, "attachments") : undefined
  }

  /**
   * Resolve a storageID to its file Uri. IDs are validated against the
   * generated shape so a corrupted/hostile persisted value can never path-
   * traverse out of the attachments directory.
   */
  uriFor(storageID: string): vscode.Uri | undefined {
    if (!this.dir || !/^[A-Za-z0-9_-]+$/.test(storageID)) return undefined
    return vscode.Uri.joinPath(this.dir, storageID)
  }

  async save(bytes: Uint8Array): Promise<string | undefined> {
    if (!this.dir) return undefined
    const storageID = `att_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const uri = this.uriFor(storageID)
    if (!uri) return undefined
    try {
      if (!this.ensuredDir) {
        await vscode.workspace.fs.createDirectory(this.dir)
        this.ensuredDir = true
      }
      await vscode.workspace.fs.writeFile(uri, bytes)
      return storageID
    } catch (e) {
      log("attachment store: write failed", e)
      return undefined
    }
  }

  async read(storageID: string): Promise<Uint8Array | undefined> {
    const uri = this.uriFor(storageID)
    if (!uri) return undefined
    try {
      return await vscode.workspace.fs.readFile(uri)
    } catch {
      return undefined
    }
  }

  async delete(storageID: string): Promise<void> {
    const uri = this.uriFor(storageID)
    if (!uri) return
    try {
      await vscode.workspace.fs.delete(uri)
    } catch {
      // Already gone (or storage unavailable) — GC is best-effort.
    }
  }
}
