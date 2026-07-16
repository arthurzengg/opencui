/**
 * Dev watcher for `bun run watch`: runs the vite webview build and the
 * esbuild host bundle in watch mode side by side and tears both down
 * together. The script used to build the webview once and then only watch
 * the host, so webview edits silently never reached dist/ until the next
 * full compile.
 */
import { spawn, spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const webviewDir = path.join(root, "webview")

const install = spawnSync("bun", ["install", "--frozen-lockfile", "--silent"], {
  cwd: webviewDir,
  stdio: "inherit",
})
if (install.status !== 0) process.exit(install.status ?? 1)

const children = [
  spawn("bun", ["run", "watch"], { cwd: webviewDir, stdio: "inherit" }),
  spawn(process.execPath, [path.join(root, "esbuild.js"), "--watch"], { cwd: root, stdio: "inherit" }),
]

let exiting = false
function shutdown(code) {
  if (exiting) return
  exiting = true
  process.exitCode = code
  for (const child of children) child.kill("SIGTERM")
}

// Either watcher dying takes the other down with it — a half-alive watch
// (host rebuilding, webview frozen) looks exactly like the bug this script
// replaces.
for (const child of children) {
  child.on("exit", (code) => shutdown(code ?? 0))
}
process.on("SIGINT", () => shutdown(0))
process.on("SIGTERM", () => shutdown(0))
