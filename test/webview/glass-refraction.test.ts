import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { refractionFilter, startRefraction } from "../../webview/src/glass-refraction"

/**
 * The stops of one of the filter's displacement maps: where each sits along
 * the surface, and which backdrop position the filter samples there.
 */
function sampled(filter: string, axis: "x" | "y", length: number): Array<{ at: number; from: number }> {
  const scale = Number(filter.match(/scale="([^"]+)"/)![1])
  const maps = [...filter.matchAll(/href="data:image\/svg\+xml,([^"]+)"/g)].map((m) => decodeURIComponent(m[1]))
  const map = maps[axis === "x" ? 0 : 1]
  return [...map.matchAll(/<stop offset="([^"]+)" stop-color="rgb\((\d+),(\d+),/g)].map(([, offset, red, green]) => {
    const at = Number(offset) * length
    return { at, from: at + scale * (Number(axis === "x" ? red : green) / 255 - 0.5) }
  })
}

describe("refractionFilter (#790)", () => {
  it("is sized to the surface and bends the backdrop along the rim only", () => {
    const filter = refractionFilter("f", 300, 100, 4)
    expect(filter).toContain('<filter id="f" x="0" y="0" width="300" height="100"')
    const stops = sampled(filter, "x", 300)
    const moved = stops.filter((stop) => Math.abs(stop.from - stop.at) > 0.1)
    expect(moved.length).toBeGreaterThan(0)
    for (const stop of moved) expect(Math.min(stop.at, 300 - stop.at)).toBeLessThan(12)
    // Pulled inward: each edge shows what lies a little further in.
    expect(stops[0].from).toBeGreaterThan(0)
    expect(stops[stops.length - 1].from).toBeLessThan(300)
  })

  // A fold shows the backdrop mirrored along the rim, moving against the
  // scroll; that was the bulge of the first version. On a short surface the
  // two rims must not meet either.
  it("never folds the backdrop back on itself", () => {
    for (const [axis, width, height] of [["x", 300, 100], ["y", 300, 20]] as const) {
      const stops = sampled(refractionFilter("f", width, height, 4), axis, axis === "x" ? width : height)
      for (let i = 1; i < stops.length; i++) {
        expect(stops[i].at).toBeGreaterThanOrEqual(stops[i - 1].at)
        expect(stops[i].from).toBeGreaterThanOrEqual(stops[i - 1].from)
      }
    }
  })
})

describe("startRefraction (#790)", () => {
  type Entry = { target: Element; borderBoxSize: Array<{ inlineSize: number; blockSize: number }> }
  let resize: (entries: Entry[]) => void
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const filterOf = (el: HTMLElement) => {
    const id = el.style.getPropertyValue("--glass-refraction").match(/^url\(#(.+)\)$/)?.[1]
    return id ? document.getElementById(id) : null
  }

  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: (entries: Entry[]) => void) {
          resize = cb
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ""
  })

  it("gives a pinned question a filter of its own size when it appears, follows its size, and drops it when it leaves", async () => {
    const stop = startRefraction(document.body)
    const bubble = document.createElement("div")
    bubble.className = "msg role-user"
    bubble.style.setProperty("--glass-surface-blur", "4px")
    document.body.appendChild(bubble)
    await tick()

    resize([{ target: bubble, borderBoxSize: [{ inlineSize: 356, blockSize: 47.2 }] }])
    expect(filterOf(bubble)!.getAttribute("height")).toBe("48")

    resize([{ target: bubble, borderBoxSize: [{ inlineSize: 356, blockSize: 67 }] }])
    expect(filterOf(bubble)!.getAttribute("height")).toBe("67")
    expect(document.querySelectorAll("filter")).toHaveLength(1)

    bubble.remove()
    await tick()
    expect(document.querySelectorAll("filter")).toHaveLength(0)
    stop()
  })

  // The stylesheet names the blur only inside its two guards, so this is a
  // high-contrast theme or the reduced-transparency setting.
  it("builds no filter where the glass rules do not apply", async () => {
    const stop = startRefraction(document.body)
    const bubble = document.createElement("div")
    bubble.className = "msg role-user"
    document.body.appendChild(bubble)
    await tick()

    resize([{ target: bubble, borderBoxSize: [{ inlineSize: 356, blockSize: 48 }] }])
    expect(bubble.style.getPropertyValue("--glass-refraction")).toBe("")
    expect(document.querySelectorAll("filter")).toHaveLength(0)
    stop()
  })
})
