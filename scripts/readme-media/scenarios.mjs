// Scripted data and the steps each README image shows. Every scenario
// receives the Page from generate.mjs after the webview has mounted.

const NOW = Date.UTC(2026, 9, 7, 15, 30)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export const SELECTION = { agent: "build", model: "anthropic/claude-opus-5-5", modelVariant: "high" }

export const CATALOG = {
  models: [
    { providerID: "anthropic", providerName: "Anthropic", modelID: "claude-opus-5-5", variants: ["low", "medium", "high", "max"], lastVariant: "high" },
    { providerID: "anthropic", providerName: "Anthropic", modelID: "claude-sonnet-5", variants: ["low", "medium", "high"] },
    { providerID: "anthropic", providerName: "Anthropic", modelID: "claude-haiku-4-5", variants: [] },
    { providerID: "openai", providerName: "OpenAI", modelID: "gpt-6", variants: ["low", "medium", "high", "xhigh"] },
    { providerID: "openai", providerName: "OpenAI", modelID: "gpt-6-mini", variants: ["low", "medium", "high"] },
    { providerID: "google", providerName: "Google", modelID: "gemini-3-pro", variants: ["low", "high"] },
    { providerID: "google", providerName: "Google", modelID: "gemini-3-flash", variants: [] },
  ],
  recents: ["anthropic/claude-opus-5-5", "openai/gpt-6"],
  agents: [
    { name: "build", description: "Default agent with full tool access" },
    { name: "plan", description: "Read-only planning" },
    { name: "explore", description: "Fast codebase search" },
  ],
}

export const COMMANDS = [
  { name: "compact", description: "Summarize the session to free context", takesArguments: false },
  { name: "init", description: "Create or update AGENTS.md for this project", takesArguments: false },
  { name: "share", description: "Create a shareable link for this session", takesArguments: false },
  { name: "undo", description: "Revert the last turn and its file changes", takesArguments: false },
  { name: "redo", description: "Restore the turn that /undo reverted", takesArguments: false },
  { name: "fork", description: "Branch a new session from this point", takesArguments: false },
  { name: "review", description: "Review the working tree changes", takesArguments: true, agent: "plan" },
  { name: "test", description: "Run the test suite and fix failures", takesArguments: true },
]

export const CONVERSATIONS = [
  { id: "c1", title: "Smooth scroll while streaming", updatedAt: NOW - 12 * MIN },
  { id: "c2", title: "Add selection to chat", updatedAt: NOW - 3 * HOUR },
  { id: "c3", title: "Popover entrance animation", updatedAt: NOW - DAY - 2 * HOUR },
  { id: "c4", title: "One history list", updatedAt: NOW - 3 * DAY },
  { id: "c5", title: "Release 1.15.8", updatedAt: NOW - 9 * DAY },
]
export const EXTERNAL = [{ id: "ses_7f3a", title: "Refactor view.ts into modules", updatedAt: NOW - 2 * DAY }]

export const USAGE = { tokens: 83_400, percent: 42, limit: 200_000, model: "anthropic/claude-opus-5-5", cost: 0.47 }

/** What the host sends once the webview reports mounted. */
export async function seed(page, { selection = SELECTION, conversations = CONVERSATIONS, usage = USAGE, index = false } = {}) {
  await page.host({ type: "ready", connected: true, selection })
  await page.host({ type: "modelCatalog", catalog: CATALOG })
  await page.host({ type: "commands", commands: COMMANDS })
  await page.host({ type: "conversations", conversations, activeID: conversations[0]?.id, external: EXTERNAL })
  await page.host({ type: "contextUsage", usage })
  if (index) await page.host({ type: "indexStatus", status: { state: "ready", chunks: 1832, updatedAt: NOW } })
  await page.wait(300)
}

/** One finished turn, so the composer sits in its bottom dock. */
async function priorTurn(page) {
  await page.host({ type: "userMessage", id: "u0", text: "Where is the SSE subscription set up?" })
  await page.host({ type: "assistantStart", id: "a0" })
  await page.host({ type: "textDelta", id: "a0", delta: "In `src/chat/stream.ts`: `subscribe()` opens `/global/event` and normalizes each event before the reducer sees it." })
  await page.host({ type: "assistantDone", id: "a0", usage: { cost: 0.03, tokens: { input: 4200, output: 160, reasoning: 0 } } })
  await page.host({ type: "sessionIdle" })
  await page.wait(400)
}

async function waitFor(page, expression, timeout = 15000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await page.evaluate(expression)) return
    await page.wait(50)
  }
  throw new Error(`timed out waiting for ${expression}`)
}

/** Streams markdown in uneven word bursts, the way a model delivers it. */
async function streamText(page, id, text) {
  let seed = 11
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
  const words = text.split(/(?<= )/)
  let i = 0
  while (i < words.length) {
    const n = 1 + Math.floor(rand() * 4)
    await page.host({ type: "textDelta", id, delta: words.slice(i, i + n).join("") })
    i += n
    await page.wait(30 + Math.floor(rand() * 80))
  }
}

const ANSWER = `Stop is a two-sided state machine.

1. The host sets \`aborting\` and posts \`aborted\` **before** awaiting \`session.abort\`.
2. The reducer marks only the last pending reply as stopped and drops later deltas.
3. Terminal tool closures still pass through, so a running tool never renders forever.

\`\`\`ts
case "textDelta":
  if (state.aborting) return state
\`\`\`

\`onSessionIdle\` clears both flags.`

export const SCENARIOS = [
  {
    name: "panel-overview",
    file: "panel-overview.gif",
    width: 340,
    height: 380,
    async run(page) {
      await seed(page)
      await priorTurn(page)
      page.react(async (m) => {
        if (m.type !== "send") return
        await page.host({ type: "userMessage", id: "u1", text: m.text })
        await page.wait(350)
        await page.host({ type: "assistantStart", id: "a1" })
        for (const d of ["Reading the abort path in view.ts and the reducer. ", "The host flags aborting before awaiting session.abort, ", "so late deltas are dropped on both sides."]) {
          await page.host({ type: "reasoningDelta", id: "a1", delta: d })
          await page.wait(140)
        }
        const read = { callID: "t1", tool: "read", title: "src/chat/view.ts", input: { filePath: "src/chat/view.ts" } }
        await page.host({ type: "tool", id: "a1", update: { ...read, status: "running" } })
        await page.wait(520)
        await page.host({ type: "tool", id: "a1", update: { ...read, status: "completed", output: "..." } })
        const grep = { callID: "t2", tool: "grep", title: "aborting", input: { pattern: "aborting", path: "webview/src" } }
        await page.host({ type: "tool", id: "a1", update: { ...grep, status: "running" } })
        await page.wait(420)
        await page.host({ type: "tool", id: "a1", update: { ...grep, status: "completed", output: "3 matches" } })
        await page.wait(200)
        await streamText(page, "a1", ANSWER)
        await page.host({ type: "assistantDone", id: "a1", usage: { cost: 0.11, tokens: { input: 9100, output: 240, reasoning: 85 } } })
        await page.host({ type: "sessionIdle" })
        await page.host({ type: "contextUsage", usage: { ...USAGE, tokens: 92_700, percent: 46, cost: 0.58 } })
      })
      await page.startRecording()
      await page.wait(300)
      await page.click("textarea")
      await page.type("Explain the abort flow", 45)
      await page.wait(250)
      await page.key("Enter")
      await waitFor(page, `document.querySelectorAll(".msg-usage").length >= 2`)
      await page.wait(900)
      return { frames: await page.stopRecording() }
    },
  },
  {
    name: "model-picker",
    file: "model-picker.gif",
    width: 340,
    height: 460,
    async run(page) {
      await seed(page)
      await priorTurn(page)
      let selection = { ...SELECTION }
      page.react(async (m) => {
        if (m.type === "setModel") selection = { ...selection, model: `${m.providerID}/${m.modelID}`, modelVariant: m.variant }
        else if (m.type === "setAgent") selection = { ...selection, agent: m.name }
        else return
        await page.wait(90)
        await page.host({ type: "selection", selection })
      })
      await page.startRecording()
      await page.wait(300)
      await page.click(".selector-trigger")
      await page.wait(800)
      await page.hover(".model-picker-row", 1)
      await page.wait(350)
      await page.hover(".model-picker-row", 3)
      await page.wait(350)
      const sonnet = await page.rectByText(".model-picker-row", "sonnet-5")
      await page.move(sonnet.x + sonnet.w / 2, sonnet.y + sonnet.h / 2)
      await page.clickHere()
      await page.wait(700)
      // Rows follow the pointer, so leave the popover before dropping to the
      // chips rather than sweeping a highlight down the list.
      const chip = async (text) => {
        const r = await page.rectByText(".model-picker-chip", text)
        await page.moveVia([[3, page.cursor.y], [3, r.y + r.h / 2], [r.x + r.w / 2, r.y + r.h / 2]], 140)
        await page.clickHere()
      }
      await chip("high")
      await page.wait(700)
      await chip("plan")
      await page.wait(900)
      return { frames: await page.stopRecording() }
    },
  },
  {
    name: "slash-commands",
    file: "slash-commands.gif",
    width: 340,
    height: 340,
    async run(page) {
      await seed(page)
      await priorTurn(page)
      await page.startRecording()
      await page.wait(300)
      await page.click("textarea")
      await page.wait(200)
      await page.type("/", 60)
      await page.wait(750)
      await page.type("re", 170)
      await page.wait(600)
      await page.key("ArrowDown")
      await page.wait(450)
      await page.key("Enter")
      await page.wait(500)
      await page.type("the dock changes", 40)
      await page.wait(600)
      return { frames: await page.stopRecording() }
    },
  },
  {
    name: "chat-history",
    file: "chat-history.gif",
    width: 340,
    height: 420,
    async run(page) {
      let conversations = [...CONVERSATIONS]
      await seed(page, { conversations })
      await priorTurn(page)
      const push = () => page.host({ type: "conversations", conversations, activeID: "c1", external: EXTERNAL })
      page.react(async (m) => {
        if (m.type === "renameConversation") conversations = conversations.map((c) => (c.id === m.id ? { ...c, title: m.title } : c))
        else if (m.type === "deleteConversation") conversations = conversations.filter((c) => c.id !== m.id)
        else return
        await page.wait(140)
        await push()
      })
      await page.startRecording()
      await page.wait(300)
      await page.click(".history-trigger")
      await page.wait(700)
      await page.hover(".history-item", 1)
      await page.wait(450)
      await page.click(".history-item:nth-child(2) .history-action:not(.danger)")
      await page.wait(300)
      await page.evaluate(`document.querySelector(".history-rename-input")?.select()`)
      await page.type("Selection to chat (PR #655)", 38)
      await page.wait(300)
      await page.key("Enter")
      await page.wait(700)
      await page.hover(".history-item", 4)
      await page.wait(400)
      await page.click(".history-item:nth-child(5) .history-action.danger")
      await page.wait(550)
      await page.click(".history-item:nth-child(5) .history-action.danger")
      await page.wait(500)
      const list = await page.rect(".history-popover")
      await page.move(list.x + list.w / 2, list.y + list.h + 40)
      await page.wait(700)
      return { frames: await page.stopRecording() }
    },
  },
  {
    name: "context-usage",
    file: "context-usage.png",
    width: 340,
    height: 380,
    async run(page) {
      await seed(page)
      await priorTurn(page)
      await page.hover(".context-usage")
      await page.wait(400)
      await page.hideCursor()
      const dock = await page.rect(".bottom-dock")
      const ring = await page.rect(".context-usage")
      const top = Math.max(0, ring.y - 64)
      return page.screenshot({ x: 0, y: top, width: 340, height: dock.y + dock.h - top })
    },
  },
]
