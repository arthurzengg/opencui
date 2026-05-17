import { useEffect } from "react"

type Props = {
  src: { dataUrl: string; filename: string } | null
  onClose: () => void
}

/**
 * Lightweight image lightbox. Renders a fullscreen dim overlay with the
 * image centered; clicking the backdrop or pressing Esc closes it. The
 * image itself is `stopPropagation`'d so clicking the picture doesn't
 * dismiss. Used by both the prompt-box thumbnail strip and the
 * sent-bubble attachment tile.
 */
export function ImagePreviewModal({ src, onClose }: Props) {
  useEffect(() => {
    if (!src) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [src, onClose])

  if (!src) return null
  return (
    <div
      className="image-preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${src.filename}`}
      onClick={onClose}
    >
      <button
        type="button"
        className="image-preview-close"
        aria-label="Close preview"
        title="Close (Esc)"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      </button>
      <img
        className="image-preview-img"
        src={src.dataUrl}
        alt={src.filename}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}
