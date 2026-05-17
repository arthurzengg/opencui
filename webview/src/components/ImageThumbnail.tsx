import type { Attachment } from "../protocol"
import { formatBytes } from "../mention-tokens"
import { ICON_SIZE } from "../design-tokens"

/** The minimum shape ImageThumbnail needs. `id` is only required when
 *  `onRemove` is wired up (paperclip/paste flow); read-only sent bubbles
 *  rebuild attachment blocks from message history without an id field. */
export type Thumbnailable = Pick<Attachment, "mime" | "filename" | "dataUrl" | "bytes"> & {
  id?: string
}

type Props = {
  attachment: Thumbnailable
  /** Open the lightbox preview when the tile body is clicked. */
  onPreview: (attachment: Thumbnailable) => void
  /** Optional X-corner remove button. Provided in editable contexts
   *  (prompt strip, edit-in-place bubble); omitted in read-only sent
   *  bubbles. */
  onRemove?: (id: string) => void
}

/**
 * Shared 28 × 28 image tile used by both the prompt-box thumbnail strip
 * and the sent-bubble attachment list. Checkerboard background keeps
 * transparent PNGs visible; the open-button + remove-button are
 * siblings (never nested) so clicking the X never opens the preview
 * and `stopPropagation` on the open button prevents bubbling into a
 * parent click handler (matters for the sent-bubble case where the
 * surrounding `.msg.role-user` listens for click-to-edit).
 */
export function ImageThumbnail({ attachment, onPreview, onRemove }: Props) {
  return (
    <li className="image-thumb" title={`${attachment.filename} · ${formatBytes(attachment.bytes)}`}>
      <button
        type="button"
        className="image-thumb-open"
        aria-label={`Preview ${attachment.filename}`}
        onClick={(e) => {
          e.stopPropagation()
          onPreview(attachment)
        }}
      >
        <img src={attachment.dataUrl} alt="" />
      </button>
      {onRemove && attachment.id && (
        <button
          type="button"
          className="image-thumb-remove"
          aria-label={`Remove ${attachment.filename}`}
          title="Remove"
          onClick={(e) => {
            e.stopPropagation()
            onRemove(attachment.id!)
          }}
        >
          <svg width={ICON_SIZE.xs} height={ICON_SIZE.xs} viewBox="0 0 8 8" aria-hidden="true">
            <path d="M1 1l6 6M7 1l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </li>
  )
}
