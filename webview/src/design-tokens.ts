/**
 * Design tokens for things React owns (SVG attributes, inline numeric props).
 * Style tokens (colors, spacing, radii, shadows) live in `styles.css` as CSS
 * variables on `:root`. The two layers exist so the design system has ONE
 * source of truth per value type — pixels for icons here, everything else
 * in CSS — and a typo like `width={11}` becomes a compile error.
 */

/**
 * Icon-pixel sizes for inline SVG icons. Maps to the four visual scales the
 * UI actually uses, no more. If you need a new size, prefer extending this
 * scale (e.g. `xl: 18`) rather than inlining a literal.
 */
export const ICON_SIZE = {
  /** Tiny X buttons (thumbnail remove, stop-square inside send button). */
  xs: 8,
  /** Send arrow inside the bottom prompt's primary button. */
  sm: 10,
  /** Edit-mode hint on user bubbles, similar small affordances. */
  md: 12,
  /** Paperclip, modal-level close, statusbar buttons. */
  lg: 14,
} as const

/**
 * Z-index tiers. Use these over magic numbers so the stacking order is
 * documented in one place. Higher number = paints on top of lower.
 */
export const Z = {
  /** Default in-flow content (code blocks, inline highlights). */
  base: 1,
  /** Sticky user-message bubble that pins to the top of the messages scroll. */
  bubbleSticky: 2,
  /** Floating UI within the chat: mention popover (open), prompt action row,
   *  review panel, the editing bubble while expanded. */
  overlay: 4,
  /** Top-of-screen dropdowns: model/agent selector, history list,
   *  thinking-dots indicator. */
  popover: 20,
  /** Full-screen modal layer: image preview lightbox. */
  modal: 1000,
} as const
