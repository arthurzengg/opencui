import * as vscode from "vscode"
import * as path from "path"
import type { Attachment } from "./protocol"

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 // 10 MB per file
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024 // 25 MB across one prompt

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]
export const DOC_EXTS = ["pdf"]

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
}

export function guessMime(filename: string): string {
  const ext = path.extname(filename).slice(1).toLowerCase()
  return MIME_BY_EXT[ext] ?? "application/octet-stream"
}

export function isAcceptedExt(filename: string): boolean {
  const ext = path.extname(filename).slice(1).toLowerCase()
  return IMAGE_EXTS.includes(ext) || DOC_EXTS.includes(ext)
}

/** Encode `bytes` as a `data:<mime>;base64,...` URL using Node's Buffer. */
export function bytesToDataUrl(mime: string, bytes: Uint8Array): string {
  const b64 = Buffer.from(bytes).toString("base64")
  return `data:${mime};base64,${b64}`
}

export type ReadResult =
  | { ok: true; attachment: Attachment }
  | { ok: false; filename: string; reason: "oversize" | "read-failed" | "unsupported" }

export async function readAttachment(uri: vscode.Uri): Promise<ReadResult> {
  const filename = path.basename(uri.fsPath)
  if (!isAcceptedExt(filename)) {
    return { ok: false, filename, reason: "unsupported" }
  }
  let bytes: Uint8Array
  try {
    bytes = await vscode.workspace.fs.readFile(uri)
  } catch {
    return { ok: false, filename, reason: "read-failed" }
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return { ok: false, filename, reason: "oversize" }
  }
  const mime = guessMime(filename)
  const attachment: Attachment = {
    id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    mime,
    filename,
    dataUrl: bytesToDataUrl(mime, bytes),
    bytes: bytes.byteLength,
    sourcePath: uri.fsPath,
  }
  return { ok: true, attachment }
}

/** Open VS Code's native file dialog filtered to images/PDFs and return the chosen attachments. */
export async function pickAttachments(): Promise<{ attachments: Attachment[]; error?: string }> {
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    openLabel: "Attach",
    filters: {
      "Images & PDFs": [...IMAGE_EXTS, ...DOC_EXTS],
      Images: IMAGE_EXTS,
      PDFs: DOC_EXTS,
    },
  })
  if (!uris || uris.length === 0) return { attachments: [] }
  const results = await Promise.all(uris.map(readAttachment))
  const attachments: Attachment[] = []
  const failures: string[] = []
  let total = 0
  for (const r of results) {
    if (!r.ok) {
      failures.push(`${r.filename} (${r.reason})`)
      continue
    }
    if (total + r.attachment.bytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      failures.push(`${r.attachment.filename} (over total budget)`)
      continue
    }
    attachments.push(r.attachment)
    total += r.attachment.bytes
  }
  return failures.length > 0
    ? { attachments, error: `Skipped: ${failures.join(", ")}` }
    : { attachments }
}
