import type { Attachment } from "./protocol"

// Cap individual pasted images at the same 10 MB the host enforces for
// paperclip attachments (see src/attachments.ts MAX_ATTACHMENT_BYTES).
// Above that, opencode requests start failing in ways that are hard for
// the user to diagnose, so reject up front with a clear error string.
export const PASTE_MAX_BYTES = 10 * 1024 * 1024

// Mime → extension for images we accept from the clipboard. Mirrors the
// host's IMAGE_EXTS list. Used for both the fast-path check (does this
// paste contain anything we care about?) and the synthesised filename.
const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
}

/** Cheap check used by onPaste to bail out before any allocation when the
 *  clipboard has only text. Reads `kind === "file"` items and checks their
 *  type against our accepted-image MIME set. */
export function clipboardHasImage(data: DataTransfer | null | undefined): boolean {
  if (!data?.items) return false
  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i]
    if (item.kind === "file" && item.type in EXT_BY_MIME) return true
  }
  return false
}

export type PastedAttachmentsResult = {
  attachments: Attachment[]
  /** Plain text from the same paste (e.g., "log line\n[image]") — caller
   *  inserts this at the caret alongside the chip(s). Empty string when
   *  the clipboard had no text/plain entry. */
  text: string
  /** Joined "Skipped: …" string if any image failed; undefined on full success. */
  error?: string
}

/**
 * Convert a paste/drop DataTransfer into webview-side Attachments. Synthesises
 * filenames (`pasted-image.png`, `pasted-image-2.png`, …) because clipboard
 * images rarely carry meaningful names — Chromium reports every clipboard
 * image as `image.png` regardless of source. Final label deduplication against
 * already-attached chips happens in the PromptBox caller via
 * `makeAttachmentLabel`.
 */
export async function readPastedImages(data: DataTransfer): Promise<PastedAttachmentsResult> {
  const text = typeof data.getData === "function" ? data.getData("text/plain") : ""
  const files: File[] = []
  // Prefer .items (covers clipboard images that aren't files on disk); fall
  // back to .files for the drag-drop path some older code uses.
  if (data.items) {
    for (let i = 0; i < data.items.length; i++) {
      const item = data.items[i]
      if (item.kind === "file") {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
  }
  if (files.length === 0 && data.files) {
    for (let i = 0; i < data.files.length; i++) files.push(data.files[i])
  }

  const attachments: Attachment[] = []
  const errors: string[] = []
  let counter = 1
  for (const file of files) {
    if (!(file.type in EXT_BY_MIME)) continue
    if (file.size > PASTE_MAX_BYTES) {
      errors.push(`pasted image (over ${Math.round(PASTE_MAX_BYTES / (1024 * 1024))} MB)`)
      continue
    }
    try {
      const buf = await file.arrayBuffer()
      const ext = EXT_BY_MIME[file.type]
      const filename = counter === 1 ? `pasted-image.${ext}` : `pasted-image-${counter}.${ext}`
      counter++
      attachments.push({
        id: `att_paste_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        mime: file.type,
        filename,
        dataUrl: bytesToDataUrl(file.type, buf),
        bytes: file.size,
      })
    } catch {
      errors.push("pasted image (read failed)")
    }
  }

  return {
    attachments,
    text,
    error: errors.length > 0 ? `Skipped: ${errors.join(", ")}` : undefined,
  }
}

function bytesToDataUrl(mime: string, buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  // Build the binary string in 32 KB chunks — String.fromCharCode(...bytes)
  // throws "Maximum call stack size exceeded" once the spread argument count
  // crosses an engine-specific limit, which a 5 MB screenshot easily hits.
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}
