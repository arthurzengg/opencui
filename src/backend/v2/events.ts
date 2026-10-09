import type { OpenCodeEvent } from "@opencode/client/promise"

/** An event in the 1.x shape `chat/stream.ts` routes: `{ type, properties }`. */
export type HostEvent = { type: string; properties: Record<string, unknown> }

type Data<T extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { type: T }>["data"]

/**
 * Translates opencode 2.0's event vocabulary into the 1.x events the
 * stream router already understands (#684). 2.0 narrates a turn as
 * steps, text and reasoning spans keyed by ordinal, and tool calls keyed
 * by id; 1.x narrates it as message and part updates. The translator keeps
 * the little state that bridging needs: the name and input of each tool
 * call, and the assistant message each session is currently writing.
 */
export function createEventTranslator() {
  const tools = new Map<string, { name: string; messageID: string; input: Record<string, unknown>; start: number }>()
  const writing = new Map<string, string>()

  const part = (sessionID: string, messageID: string, id: string, rest: Record<string, unknown>): HostEvent => ({
    type: "message.part.updated",
    properties: { part: { id, sessionID, messageID, ...rest } },
  })
  const info = (sessionID: string, id: string, rest: Record<string, unknown>): HostEvent => ({
    type: "message.updated",
    properties: { info: { id, sessionID, role: "assistant", ...rest } },
  })
  const spanID = (messageID: string, kind: "text" | "reasoning", ordinal: number) => `${messageID}:${kind}:${ordinal}`

  function span(kind: "text" | "reasoning", event: OpenCodeEvent): HostEvent[] {
    const d = event.data as { sessionID: string; assistantMessageID: string; ordinal: number; delta?: string; text?: string }
    const id = spanID(d.assistantMessageID, kind, d.ordinal)
    if (event.type.endsWith(".delta")) {
      return [{ type: "message.part.delta", properties: { sessionID: d.sessionID, messageID: d.assistantMessageID, partID: id, field: "text", delta: d.delta ?? "" } }]
    }
    return [part(d.sessionID, d.assistantMessageID, id, { type: kind, text: d.text ?? "" })]
  }

  function toolPart(sessionID: string, id: string, state: Record<string, unknown>): HostEvent[] {
    const tool = tools.get(id)
    if (!tool) return []
    return [part(sessionID, tool.messageID, id, { type: "tool", callID: id, tool: tool.name, state })]
  }

  const outputOf = (content: Array<{ type: string; text?: string; uri?: string }> | undefined) =>
    (content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : c.uri ?? "")).join("\n")

  return function translate(event: OpenCodeEvent): HostEvent[] {
    switch (event.type) {
      case "session.step.started": {
        const d = event.data as Data<"session.step.started">
        writing.set(d.sessionID, d.assistantMessageID)
        return [info(d.sessionID, d.assistantMessageID, { time: { created: d.started }, modelID: d.model.id, providerID: d.model.providerID, mode: d.agent, parentID: "" })]
      }
      case "session.step.ended": {
        const d = event.data as Data<"session.step.ended">
        const out = [info(d.sessionID, d.assistantMessageID, { finish: d.finish, cost: d.cost, tokens: d.tokens, time: { created: event.created, completed: event.created } })]
        if (d.files?.length) out.unshift(part(d.sessionID, d.assistantMessageID, `${event.id}:patch`, { type: "patch", hash: event.id, files: d.files }))
        return out
      }
      case "session.step.failed": {
        const d = event.data as Data<"session.step.failed">
        return [info(d.sessionID, d.assistantMessageID, { finish: d.finish ?? "error", error: { name: d.error.type, data: { message: d.error.message } } })]
      }
      case "session.text.started":
      case "session.text.delta":
      case "session.text.ended":
        return span("text", event)
      case "session.reasoning.started":
      case "session.reasoning.delta":
      case "session.reasoning.ended":
        return span("reasoning", event)
      case "session.tool.input.started": {
        const d = event.data as Data<"session.tool.input.started">
        tools.set(d.id, { name: d.name, messageID: d.assistantMessageID, input: {}, start: event.created })
        return toolPart(d.sessionID, d.id, { status: "pending", input: {}, raw: "" })
      }
      case "session.tool.called": {
        const d = event.data as Data<"session.tool.called">
        const tool = tools.get(d.id)
        if (tool) tool.input = d.input
        return toolPart(d.sessionID, d.id, { status: "running", input: d.input, time: { start: tool?.start ?? event.created } })
      }
      case "session.tool.progress": {
        const d = event.data as Data<"session.tool.progress">
        const tool = tools.get(d.id)
        return toolPart(d.sessionID, d.id, { status: "running", input: tool?.input ?? {}, metadata: d.metadata, time: { start: tool?.start ?? event.created } })
      }
      case "session.tool.success": {
        const d = event.data as Data<"session.tool.success">
        const tool = tools.get(d.id)
        const out = toolPart(d.sessionID, d.id, {
          status: "completed",
          input: tool?.input ?? {},
          output: outputOf(d.content),
          title: tool?.name ?? "",
          metadata: d.metadata ?? {},
          time: { start: tool?.start ?? event.created, end: event.created },
        })
        tools.delete(d.id)
        return out
      }
      case "session.tool.failed": {
        const d = event.data as Data<"session.tool.failed">
        const tool = tools.get(d.id)
        const out = toolPart(d.sessionID, d.id, {
          status: "error",
          input: tool?.input ?? {},
          error: d.error.message,
          metadata: d.metadata,
          time: { start: tool?.start ?? event.created, end: event.created },
        })
        tools.delete(d.id)
        return out
      }
      case "session.execution.started": {
        const d = event.data as Data<"session.execution.started">
        return [{ type: "session.status", properties: { sessionID: d.sessionID, status: { type: "busy" } } }]
      }
      case "session.execution.failed": {
        const d = event.data as Data<"session.execution.failed">
        return [{ type: "session.error", properties: { sessionID: d.sessionID, error: { name: d.error.type, data: { message: d.error.message } } } }]
      }
      case "session.execution.interrupted": {
        // 1.x marks the message aborted through its error; the router and
        // the webview read that name as "Stopped" rather than a failure.
        const d = event.data as Data<"session.execution.interrupted">
        const messageID = writing.get(d.sessionID)
        if (!messageID) return []
        return [info(d.sessionID, messageID, { error: { name: "MessageAbortedError", data: { message: "Aborted" } } })]
      }
      case "session.retry.scheduled": {
        const d = event.data as Data<"session.retry.scheduled">
        return [{ type: "session.status", properties: { sessionID: d.sessionID, status: { type: "retry", attempt: d.attempt, message: d.error.message, next: d.at } } }]
      }
      case "session.idle": {
        const d = event.data as Data<"session.idle">
        writing.delete(d.sessionID)
        return [{ type: "session.idle", properties: { sessionID: d.sessionID } }]
      }
      case "session.compaction.ended": {
        // 1.x surfaces a compaction as an assistant message flagged summary,
        // which the transcript folds into a marker.
        const d = event.data as Data<"session.compaction.ended">
        const id = `${event.id}:compaction`
        return [
          info(d.sessionID, id, { summary: true, time: { created: event.created } }),
          part(d.sessionID, id, `${id}:text`, { type: "text", text: d.text }),
          info(d.sessionID, id, { summary: true, finish: "stop", cost: d.cost ?? 0, tokens: d.tokens }),
        ]
      }
      case "session.created": {
        const d = event.data as Data<"session.created">
        return [{ type: "session.created", properties: { info: { id: d.sessionID, parentID: d.parentID, title: d.title } } }]
      }
      case "session.renamed": {
        const d = event.data as Data<"session.renamed">
        return [{ type: "session.updated", properties: { info: { id: d.sessionID, title: d.title } } }]
      }
      case "server.connected":
        return [{ type: "server.connected", properties: {} }]
      default:
        return []
    }
  }
}

/** The adapter's event stream: 2.0 events in, 1.x-shaped events out. */
export async function* translateEvents(source: AsyncIterable<OpenCodeEvent>): AsyncIterable<HostEvent> {
  const translate = createEventTranslator()
  for await (const event of source) {
    for (const out of translate(event)) yield out
  }
}
