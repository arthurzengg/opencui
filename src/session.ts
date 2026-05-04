import type { Backend } from "./server"
import type { TextPartInput, FilePartInput } from "@opencode-ai/sdk"
import type { Preferences } from "./preferences"
import { log } from "./output"

export type PromptInput = {
  text: string
  files?: { path: string; content?: string }[]
}

export class SessionRunner {
  private sessionId: string | undefined

  constructor(private backend: Backend, private prefs?: Preferences) {}

  async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId
    const res = await this.backend.client.session.create({ body: {} })
    if (res.error) throw new Error(`failed to create session: ${JSON.stringify(res.error)}`)
    if (!res.data) throw new Error("session.create returned no data")
    this.sessionId = res.data.id
    log("session created", this.sessionId)
    return this.sessionId
  }

  newSession() {
    this.sessionId = undefined
  }

  /** Send a prompt and wait for the final assistant text. */
  async prompt(input: PromptInput): Promise<string> {
    const id = await this.ensureSession()
    const parts: Array<TextPartInput | FilePartInput> = [{ type: "text", text: input.text }]
    const sel = this.prefs?.get()
    const body: Parameters<typeof this.backend.client.session.prompt>[0]["body"] = { parts }
    if (sel?.agent) body!.agent = sel.agent
    if (sel?.modelProviderID && sel?.modelID) {
      body!.model = { providerID: sel.modelProviderID, modelID: sel.modelID }
    }
    const res = await this.backend.client.session.prompt({
      path: { id },
      body,
    })
    if (res.error) {
      log("prompt http error", res.error)
      throw new Error(`prompt failed: ${JSON.stringify(res.error)}`)
    }
    log("prompt response", res.data)

    const data = res.data as { info?: { error?: unknown }; parts?: Array<Record<string, unknown>> }
    if (data?.info?.error) {
      const err = data.info.error as { name?: string; data?: { message?: string } }
      const name = err.name ?? "ProviderError"
      const msg = err.data?.message ?? JSON.stringify(err)
      throw new Error(`${name}: ${msg}`)
    }

    const text = extractText(data?.parts ?? [])
    if (text) return text

    // No text was found — return a helpful debug dump so the user can see
    // exactly what the server returned (tool calls / step parts / nothing).
    const summary = summarizeParts(data?.parts ?? [])
    return `_(no text in response)_\n\n${summary}`
  }
}

function summarizeParts(parts: Array<Record<string, unknown>>): string {
  if (!parts.length) return "Server returned 0 parts."
  const lines = ["```", `received ${parts.length} part(s):`]
  for (const p of parts) {
    const type = String(p.type ?? "?")
    const extra =
      typeof p.text === "string" ? ` text="${(p.text as string).slice(0, 80)}"` :
      typeof p.tool === "string" ? ` tool=${p.tool}` :
      ""
    lines.push(`- ${type}${extra}`)
  }
  lines.push("```")
  return lines.join("\n")
}

function extractText(parts: Array<Record<string, unknown>>): string {
  const texts: string[] = []
  for (const p of parts) {
    if (p.type === "text" && typeof p.text === "string") {
      texts.push(p.text)
    } else if (p.type === "reasoning" && typeof p.text === "string") {
      texts.push(`> _reasoning_\n> ${(p.text as string).split("\n").join("\n> ")}`)
    }
  }
  return texts.join("\n\n")
}
