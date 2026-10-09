import type { FormField, FormInfo, OpenCodeEvent } from "@opencode/client/promise"

/** An event in the 1.x shape `chat/stream.ts` routes: `{ type, properties }`. */
export type HostEvent = { type: string; properties: Record<string, unknown> }

/** What the adapter needs to answer a form later: which session, and each field's key and kind, in the order the webview saw them. */
export type FormRecord = { sessionID: string; fields: FormField[] }

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
  // Replies go to session-scoped routes, but the host answers by request id
  // alone, so the ask is remembered until its reply or cancel.
  const permissions = new Map<string, string>()
  const forms = new Map<string, FormRecord>()
  // Sessions with an execution in flight, from the stream itself: 2.0 has no
  // status route, and a fresh session has no idle mark, so the listing
  // alone cannot say which sessions are working.
  const executing = new Set<string>()

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

  function translate(event: OpenCodeEvent): HostEvent[] {
    switch (event.type) {
      case "permission.asked": {
        const d = event.data as Data<"permission.asked">
        permissions.set(d.id, d.sessionID)
        return [{
          type: "permission.asked",
          properties: {
            id: d.id,
            sessionID: d.sessionID,
            permission: d.action,
            patterns: d.resources,
            always: d.save ?? [],
            title: d.message ?? `Permission needed: ${d.action}`,
            metadata: d.metadata ?? {},
            messageID: d.source?.messageID,
            callID: d.source?.id,
            time: { created: event.created },
          },
        }]
      }
      case "permission.replied": {
        const d = event.data as Data<"permission.replied">
        permissions.delete(d.requestID)
        return [{ type: "permission.replied", properties: { sessionID: d.sessionID, requestID: d.requestID, reply: d.reply } }]
      }
      case "form.created": {
        const form = (event.data as Data<"form.created">).form as FormInfo
        forms.set(form.id, { sessionID: form.sessionID, fields: form.fields })
        return [{ type: "question.asked", properties: { id: form.id, sessionID: form.sessionID, questions: form.fields.map((field) => questionOf(form, field)) } }]
      }
      case "form.replied": {
        const d = event.data as Data<"form.replied">
        forms.delete(d.id)
        return [{ type: "question.replied", properties: { sessionID: d.sessionID, requestID: d.id } }]
      }
      case "form.cancelled": {
        const d = event.data as Data<"form.cancelled">
        forms.delete(d.id)
        return [{ type: "question.rejected", properties: { sessionID: d.sessionID, requestID: d.id } }]
      }
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
        executing.add(d.sessionID)
        return [{ type: "session.status", properties: { sessionID: d.sessionID, status: { type: "busy" } } }]
      }
      case "session.execution.succeeded": {
        executing.delete((event.data as Data<"session.execution.succeeded">).sessionID)
        return []
      }
      case "session.execution.failed": {
        const d = event.data as Data<"session.execution.failed">
        executing.delete(d.sessionID)
        return [{ type: "session.error", properties: { sessionID: d.sessionID, error: { name: d.error.type, data: { message: d.error.message } } } }]
      }
      case "session.execution.interrupted": {
        // 1.x marks the message aborted through its error; the router and
        // the webview read that name as "Stopped" rather than a failure.
        const d = event.data as Data<"session.execution.interrupted">
        executing.delete(d.sessionID)
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
        executing.delete(d.sessionID)
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

  return {
    translate,
    /** Session a pending permission request belongs to, if this translator saw the ask. */
    sessionForPermission: (requestID: string) => permissions.get(requestID),
    /** The form behind a pending question, if this translator saw it. */
    form: (formID: string) => forms.get(formID),
    /** Sessions this connection has seen start an execution that has not ended. */
    executing: () => [...executing],
  }
}

export type EventTranslator = ReturnType<typeof createEventTranslator>

/**
 * A 2.0 form field as the 1.x question dialog shows it. A boolean becomes a
 * yes/no choice, a number or text field a free answer, options keep their
 * labels and descriptions; the answer travels back through formAnswer.
 */
function questionOf(form: FormInfo, field: FormField): Record<string, unknown> {
  const base = { question: field.description ?? field.title ?? field.key, header: field.title ?? form.title }
  if (field.type === "boolean") return { ...base, options: [{ label: "Yes", description: "" }, { label: "No", description: "" }], custom: false }
  if (field.type === "multiselect" || (field.type === "string" && field.options?.length)) {
    const options = (field.type === "multiselect" ? field.options : field.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" }))
    return { ...base, options, multiple: field.type === "multiselect", custom: field.custom ?? false }
  }
  return { ...base, options: [], custom: true }
}

/** The 1.x reply, one list of chosen labels or typed text per field, as the 2.0 form answer keyed by field. */
export function formAnswer(record: FormRecord, answers: string[][]): Record<string, string | number | boolean | string[]> {
  const answer: Record<string, string | number | boolean | string[]> = {}
  record.fields.forEach((field, index) => {
    const given = answers[index] ?? []
    if (field.type === "boolean") answer[field.key] = given[0] === "Yes"
    else if (field.type === "number" || field.type === "integer") answer[field.key] = Number(given[0] ?? "")
    else if (field.type === "multiselect") answer[field.key] = given.map((label) => field.options.find((o) => o.label === label)?.value ?? label)
    else if (field.type === "string") {
      const label = given[0] ?? ""
      answer[field.key] = field.options?.find((o) => o.label === label)?.value ?? label
    } else answer[field.key] = given[0] ?? ""
  })
  return answer
}

/** The adapter's event stream: 2.0 events in, 1.x-shaped events out. */
export async function* translateEvents(translator: EventTranslator, source: AsyncIterable<OpenCodeEvent>): AsyncIterable<HostEvent> {
  for await (const event of source) {
    for (const out of translator.translate(event)) yield out
  }
}
