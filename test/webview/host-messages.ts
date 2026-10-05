import { act } from "@testing-library/react"
import type { Outbound } from "../../webview/src/protocol"

/** Host messages reach the reducer in one batch per animation frame. */
export async function post(...messages: Outbound[]) {
  await act(async () => {
    for (const data of messages) window.dispatchEvent(new MessageEvent("message", { data }))
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
}
