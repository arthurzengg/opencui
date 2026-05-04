import * as vscode from "vscode"

let channel: vscode.OutputChannel | undefined

export function getOutputChannel() {
  if (!channel) {
    channel = vscode.window.createOutputChannel("OpenCUI")
  }
  return channel
}

export function log(...args: unknown[]) {
  const msg = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
    .join(" ")
  getOutputChannel().appendLine(`[${new Date().toISOString()}] ${msg}`)
}
