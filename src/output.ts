import * as vscode from "vscode"

let channel: vscode.OutputChannel | undefined

export function getOutputChannel() {
  if (!channel) {
    channel = vscode.window.createOutputChannel("OpenCode Panel")
  }
  return channel
}

export function log(...args: unknown[]) {
  const msg = args
    .map((a) => {
      if (typeof a === "string") return a
      // JSON.stringify(new Error()) is "{}"; keep the message and frames.
      if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`
      return JSON.stringify(a, null, 2)
    })
    .join(" ")
  getOutputChannel().appendLine(`[${new Date().toISOString()}] ${msg}`)
}
