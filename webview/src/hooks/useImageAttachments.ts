import { useState } from "react"
import type { Attachment } from "../protocol"
import type { Thumbnailable } from "../components/ImageThumbnail"

/**
 * Owns the image-thumbnail strip state plus the lightbox preview state.
 * Image attachments (paste, paperclip-image, or `initial.attachments`
 * on edit-mode mount) live here instead of in the chip-text-token
 * `knownAttachments` map so the same Attachment is never rendered twice
 * and so the strip can be modified without poking the textarea text.
 *
 * `initial` is consumed once at mount via a `useState` lazy initializer
 * (filter only image-mime entries from the seed); after that the strip
 * mutates freely through `addImages` / `removeImageAttachment` /
 * `clearImageAttachments`. Non-image attachments in `initial` are NOT
 * routed here — they go through the caller's `knownAttachments` map and
 * stay as `@chip` text tokens.
 */
export function useImageAttachments(initial?: { attachments?: Attachment[] }) {
  const [imageAttachments, setImageAttachments] = useState<Attachment[]>(() =>
    (initial?.attachments ?? []).filter((a) => a.mime.startsWith("image/")),
  )
  // Lightbox state. Local to the hook (which is local to a PromptBox
  // instance); the bottom prompt and any in-place edit bubble each
  // maintain their own preview, which is fine because only one is
  // interactive at a time in practice.
  const [previewImage, setPreviewImage] = useState<Thumbnailable | null>(null)

  const addImages = (next: Attachment[]) => {
    if (next.length === 0) return
    setImageAttachments((prev) => [...prev, ...next])
  }

  const removeImageAttachment = (id: string) => {
    setImageAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  const clearImageAttachments = () => {
    setImageAttachments([])
  }

  return {
    imageAttachments,
    addImages,
    removeImageAttachment,
    clearImageAttachments,
    previewImage,
    setPreviewImage,
  }
}
