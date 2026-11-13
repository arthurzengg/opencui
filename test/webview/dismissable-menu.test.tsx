import { afterEach, describe, it, expect } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useDismissableMenu } from "../../webview/src/hooks/useDismissableMenu"

afterEach(cleanup)

function Menu() {
  const { open, toggle, ref } = useDismissableMenu()
  return (
    <div ref={ref}>
      <button onClick={toggle}>Menu</button>
      {open && (
        <div role="dialog">
          {/* A native listener, so the node is gone while the click is still
              on its way to the window, the way a history row's actions are
              when React commits during the dispatch in the panel. */}
          <button ref={(el) => el?.addEventListener("click", () => el.remove())}>Swap</button>
        </div>
      )}
    </div>
  )
}

describe("useDismissableMenu", () => {
  it("stays open when a click inside removes the node it landed on", () => {
    render(<Menu />)
    fireEvent.click(screen.getByRole("button", { name: "Menu" }))
    fireEvent.click(screen.getByRole("button", { name: "Swap" }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })
})
