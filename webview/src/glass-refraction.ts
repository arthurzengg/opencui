// Edge refraction for the glass surfaces (#790). CSS can blur and tint a
// backdrop but cannot bend it, so a surface that bends gets an SVG filter
// built for its exact box and reads it through `--glass-refraction`;
// styles.css falls back to plain frosted glass while the variable is unset.

/**
 * What bends its backdrop: the pinned question alone. A popover or a card in
 * the bottom dock sits on a blur that hides a bend this small, so a filter
 * there would cost a pass and show nothing.
 */
const SURFACE = ".msg.role-user"

/**
 * How far in from the edge the bend reaches, and the slope of the pull at the
 * edge. The slope has to stay under 1: the backdrop is then only stretched
 * toward the edge. Past 1 it folds back on itself, and the rim shows a
 * mirror image that moves against the scroll and makes the surface bulge.
 */
const RIM = 12
const RIM_PULL = 0.8
/** Offsets across the rim at which the displacement is sampled; it falls off as a square. */
const RAMP = [0, 0.15, 0.3, 0.5, 0.7, 0.85, 1]

/**
 * A displacement map for one axis: neutral (128) across the middle and
 * ramping toward both edges, so the backdrop is pulled inward along the rim
 * and left alone elsewhere. Red drives x and green drives y; blue stays
 * neutral for the pass that ignores the other axis.
 */
function displacementMap(width: number, height: number, rim: number, axis: "x" | "y"): string {
  const length = axis === "x" ? width : height
  const color = (v: number) => (axis === "x" ? `rgb(${v},0,128)` : `rgb(0,${v},128)`)
  const stop = (offset: number, v: number) => `<stop offset="${offset}" stop-color="${color(v)}"/>`
  const pull = (t: number) => Math.round(127 * (1 - t) * (1 - t))
  const near = RAMP.map((t) => stop((t * rim) / length, 128 + pull(t)))
  const far = [...RAMP].reverse().map((t) => stop(1 - (t * rim) / length, 128 - pull(t)))
  const direction = axis === "x" ? 'x2="1" y2="0"' : 'x2="0" y2="1"'
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<linearGradient id="g" x1="0" y1="0" ${direction}>${near.join("")}${far.join("")}</linearGradient>` +
    `<rect width="100%" height="100%" fill="url(#g)"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/** The filter for a surface of this size: blur, bend along the rim, then a little saturation. */
export function refractionFilter(id: string, width: number, height: number, blur: number): string {
  // A short surface gets a thinner rim, or the two edges' bends would meet.
  const rim = Math.min(RIM, height / 2.6)
  const scale = rim * RIM_PULL
  const box = `x="0" y="0" width="${width}" height="${height}"`
  const image = (axis: "x" | "y", result: string) =>
    `<feImage href="${displacementMap(width, height, rim, axis)}" ${box} preserveAspectRatio="none" result="${result}"/>`
  return (
    `<filter id="${id}" ${box} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB">` +
    image("x", "mx") +
    image("y", "my") +
    `<feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" result="b"/>` +
    `<feDisplacementMap in="b" in2="mx" scale="${scale}" xChannelSelector="R" yChannelSelector="B" result="dx"/>` +
    `<feDisplacementMap in="dx" in2="my" scale="${scale}" xChannelSelector="B" yChannelSelector="G" result="d"/>` +
    `<feColorMatrix in="d" type="saturate" values="1.9"/>` +
    `</filter>`
  )
}

/**
 * Keeps every bending surface under `root` supplied with a filter of its own
 * size, from the moment it appears until it leaves. Returns the stop
 * function.
 */
export function startRefraction(root: HTMLElement): () => void {
  if (typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return () => {}
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  defs.setAttribute("width", "0")
  defs.setAttribute("height", "0")
  defs.setAttribute("aria-hidden", "true")
  defs.style.position = "absolute"
  document.body.appendChild(defs)

  /** Each surface's current filter id; empty while it has none. */
  const filters = new Map<Element, string>()
  let next = 0

  const drop = (el: Element) => {
    const id = filters.get(el)
    if (!id) return
    defs.querySelector(`#${id}`)?.remove()
    ;(el as HTMLElement).style.removeProperty("--glass-refraction")
    filters.set(el, "")
  }

  const sizes = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const el = entry.target as HTMLElement
      if (!filters.has(el)) continue
      drop(el)
      const box = entry.borderBoxSize?.[0]
      // Rounded up: a filter region short of the box leaves a sliver with no backdrop.
      const width = Math.ceil(box ? box.inlineSize : entry.contentRect.width)
      const height = Math.ceil(box ? box.blockSize : entry.contentRect.height)
      // The stylesheet names the blur only where the glass rules apply, so a
      // high-contrast theme or the reduced-transparency setting gets no filter.
      const blur = parseFloat(getComputedStyle(el).getPropertyValue("--glass-surface-blur"))
      if (width === 0 || height === 0 || !(blur > 0)) continue
      // A new id each time, so the surface's style changes with its filter.
      const id = `opencui-refraction-${next++}`
      filters.set(el, id)
      defs.insertAdjacentHTML("beforeend", refractionFilter(id, width, height, blur))
      el.style.setProperty("--glass-refraction", `url(#${id})`)
    }
  })

  const adopt = (el: Element) => {
    if (filters.has(el)) return
    filters.set(el, "")
    sizes.observe(el, { box: "border-box" })
  }
  const scan = (node: Node) => {
    if (!(node instanceof Element)) return
    if (node.matches(SURFACE)) adopt(node)
    node.querySelectorAll(SURFACE).forEach(adopt)
  }
  const sweep = () => {
    for (const el of [...filters.keys()]) {
      if (el.isConnected) continue
      sizes.unobserve(el)
      drop(el)
      filters.delete(el)
    }
  }

  const changes = new MutationObserver((records) => {
    let removed = false
    for (const record of records) {
      record.addedNodes.forEach(scan)
      if (record.removedNodes.length > 0) removed = true
    }
    if (removed) sweep()
  })
  changes.observe(root, { childList: true, subtree: true })
  scan(root)

  return () => {
    changes.disconnect()
    sizes.disconnect()
    for (const el of filters.keys()) (el as HTMLElement).style.removeProperty("--glass-refraction")
    filters.clear()
    defs.remove()
  }
}
