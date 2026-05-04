import type { Inbound, Outbound } from "./protocol"

declare global {
  interface Window {
    acquireVsCodeApi?: () => {
      postMessage: (msg: Inbound) => void
      getState: <T>() => T | undefined
      setState: <T>(state: T) => void
    }
  }
}

const api = window.acquireVsCodeApi?.() ?? {
  postMessage: (msg: Inbound) => console.log("[mock postMessage]", msg),
  getState: () => undefined,
  setState: () => {},
}

export const vscode = {
  post(msg: Inbound) {
    api.postMessage(msg)
  },
  onMessage(handler: (msg: Outbound) => void) {
    const listener = (e: MessageEvent) => handler(e.data as Outbound)
    window.addEventListener("message", listener)
    return () => window.removeEventListener("message", listener)
  },
}
