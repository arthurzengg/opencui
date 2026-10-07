#!/usr/bin/env node
// Regenerates media/screenshots from the built webview: headless Chrome
// renders dist/webview/index.html inside the harness page, scenarios drive it
// through real input events and scripted host messages, and ffmpeg encodes
// the screencast into GIFs. Nothing here talks to opencode or a model.
//
//   bun run compile
//   node scripts/readme-media/generate.mjs [name ...] [--keep]
//
// `--keep` leaves the frame directories in place for inspection.
import http from "node:http"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { harnessHTML } from "./harness.mjs"
import { SCENARIOS } from "./scenarios.mjs"

const ROOT = path.resolve(import.meta.dirname, "../..")
const DIST = path.join(ROOT, "dist/webview")
const OUT = path.join(ROOT, "media/screenshots")
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
const FPS = 15
const HOLD_MS = 1200
const args = process.argv.slice(2)
const keep = args.includes("--keep")
const names = args.filter((a) => !a.startsWith("--"))

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x")
    if (url.pathname === "/") {
      res.setHeader("content-type", "text/html")
      res.end(harnessHTML(path.join(DIST, "index.html"), `http://127.0.0.1:${server.address().port}/grammars/`))
      return
    }
    if (url.pathname.startsWith("/grammars/")) {
      try {
        res.setHeader("content-type", "application/json")
        res.end(readFileSync(path.join(DIST, url.pathname)))
      } catch {
        res.statusCode = 404
        res.end()
      }
      return
    }
    res.statusCode = 404
    res.end()
  })
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)))
}

async function launchChrome() {
  const profile = mkdtempSync(path.join(tmpdir(), "opencui-media-"))
  const proc = spawn(
    CHROME,
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2", "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] },
  )
  const wsURL = await new Promise((resolve, reject) => {
    let buf = ""
    proc.stderr.on("data", (d) => {
      buf += d
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
      if (m) resolve(m[1])
    })
    setTimeout(() => reject(new Error("Chrome did not expose DevTools: " + buf)), 10000)
  })
  const port = new URL(wsURL).port
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((t) => t.type === "page")
  return { proc, profile, wsURL: page.webSocketDebuggerUrl }
}

class Page {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.frames = []
    this.recording = false
    this.cursor = { x: -40, y: -40 }
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(m.error.message)) : resolve(m.result)
        return
      }
      if (m.method === "Page.screencastFrame") {
        if (this.recording) this.frames.push({ t: m.params.metadata.timestamp * 1000, data: m.params.data })
        this.send("Page.screencastFrameAck", { sessionId: m.params.sessionId })
      }
    }
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "evaluate failed")
    return r.result.value
  }
  wait(ms) {
    return new Promise((r) => setTimeout(r, ms))
  }
  host(msg) {
    return this.evaluate(`window.__host.post(${JSON.stringify(msg)})`)
  }
  async inbound() {
    // Right after a navigation the new document may not have run the
    // harness script yet.
    return (await this.evaluate(`window.__host ? window.__host.inbound.splice(0) : []`)) ?? []
  }
  async waitInbound(type, timeout = 5000) {
    const until = Date.now() + timeout
    while (Date.now() < until) {
      for (const m of await this.inbound()) {
        this.reactions?.(m)
        if (m.type === type) return m
      }
      await this.wait(30)
    }
    throw new Error(`no ${type} from the webview`)
  }
  /** Runs `fn` for every message the webview posts, like the host would. */
  react(fn) {
    this.reactions = fn
    if (this.pump) return
    this.pump = setInterval(async () => {
      if (!this.reactions) return
      for (const m of await this.inbound().catch(() => [])) await this.reactions(m)
    }, 40)
  }
  async rect(selector, index = 0) {
    const r = await this.evaluate(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}]
      if (!el) return null
      const b = el.getBoundingClientRect()
      return { x: b.x, y: b.y, w: b.width, h: b.height }
    })()`)
    if (!r) throw new Error(`no element ${selector}[${index}]`)
    return r
  }
  async move(x, y, ms = 220) {
    const from = { ...this.cursor }
    const steps = Math.max(2, Math.round(ms / 16))
    for (let i = 1; i <= steps; i++) {
      const cx = from.x + ((x - from.x) * i) / steps
      const cy = from.y + ((y - from.y) * i) / steps
      await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy })
      await this.evaluate(`(() => { const c = document.getElementById("cursor"); c.style.left = "${cx}px"; c.style.top = "${cy}px" })()`)
      await this.wait(16)
    }
    this.cursor = { x, y }
  }
  /** Walks the pointer through waypoints, e.g. around a list whose rows react to hover. */
  async moveVia(points, ms) {
    for (const [x, y] of points) await this.move(x, y, ms)
  }
  async rectByText(selector, text) {
    const index = await this.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).findIndex((e) => e.textContent.trim().includes(${JSON.stringify(text)}))`)
    if (index < 0) {
      const seen = await this.evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map((e) => e.textContent.trim())`)
      throw new Error(`no ${selector} containing ${text}; saw ${JSON.stringify(seen)}`)
    }
    return this.rect(selector, index)
  }
  async hover(selector, index = 0, ms) {
    const r = await this.rect(selector, index)
    await this.move(r.x + r.w / 2, r.y + r.h / 2, ms)
  }
  async clickHere() {
    const { x, y } = this.cursor
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 })
    await this.wait(60)
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 })
  }
  async click(selector, index = 0) {
    await this.hover(selector, index)
    await this.clickHere()
  }
  hideCursor() {
    return this.evaluate(`document.getElementById("cursor").style.display = "none"`)
  }
  async type(text, perChar = 55) {
    for (const ch of text) {
      await this.send("Input.insertText", { text: ch })
      await this.wait(perChar)
    }
  }
  async key(key, code = key, vk) {
    const vks = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Backspace: 8, Tab: 9 }
    const windowsVirtualKeyCode = vk ?? vks[key]
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode })
    await this.wait(30)
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode })
  }
  async startRecording() {
    this.frames = []
    this.recording = true
    await this.send("Page.startScreencast", { format: "png", everyNthFrame: 1 })
  }
  async stopRecording() {
    await this.send("Page.stopScreencast")
    this.recording = false
    return this.frames
  }
  async screenshot(clip) {
    const r = await this.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
    return Buffer.from(r.data, "base64")
  }
}

function encodeGif(frames, file, holdMs) {
  if (frames.length === 0) throw new Error("no frames recorded")
  const dir = mkdtempSync(path.join(tmpdir(), "opencui-frames-"))
  const t0 = frames[0].t
  const end = frames[frames.length - 1].t + holdMs
  let n = 0
  // Chrome sends a frame only when something painted; hold the last one for
  // every tick in between so the GIF keeps real time.
  for (let t = t0, i = 0; t <= end; t += 1000 / FPS) {
    while (i + 1 < frames.length && frames[i + 1].t <= t) i++
    writeFileSync(path.join(dir, `f${String(n++).padStart(5, "0")}.png`), Buffer.from(frames[i].data, "base64"))
  }
  const filter = "split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle"
  const r = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(dir, "f%05d.png"), "-vf", filter, "-loop", "0", file], { stdio: "inherit" })
  return new Promise((resolve, reject) => {
    r.on("exit", (code) => {
      if (!keep) rmSync(dir, { recursive: true, force: true })
      code === 0 ? resolve({ ticks: n, dir }) : reject(new Error(`ffmpeg exited ${code}`))
    })
  })
}

const server = await serve()
const chrome = await launchChrome()
const ws = new WebSocket(chrome.wsURL)
await new Promise((r) => (ws.onopen = r))
const page = new Page(ws)
await page.send("Page.enable")
await page.send("Runtime.enable")
mkdirSync(OUT, { recursive: true })

try {
  for (const scenario of SCENARIOS) {
    if (names.length && !names.includes(scenario.name)) continue
    page.reactions = undefined
    await page.send("Emulation.setDeviceMetricsOverride", { width: scenario.width, height: scenario.height, deviceScaleFactor: 2, mobile: false })
    await page.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` })
    await page.waitInbound("mounted")
    page.cursor = { x: -40, y: -40 }
    const file = path.join(OUT, scenario.file)
    const started = Date.now()
    const result = await scenario.run(page)
    if (scenario.file.endsWith(".gif")) {
      const { ticks } = await encodeGif(result.frames, file, scenario.holdMs ?? HOLD_MS)
      console.log(`${scenario.file}: ${result.frames.length} frames -> ${ticks} ticks, ${(Date.now() - started) / 1000}s`)
    } else {
      writeFileSync(file, result)
      console.log(`${scenario.file}: ${result.length} bytes`)
    }
  }
} finally {
  clearInterval(page.pump)
  ws.close()
  server.close()
  const exited = new Promise((r) => chrome.proc.once("exit", r))
  chrome.proc.kill()
  await exited
  rmSync(chrome.profile, { recursive: true, force: true, maxRetries: 5 })
}
