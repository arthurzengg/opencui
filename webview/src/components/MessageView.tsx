import { useEffect, useState, type ReactNode } from "react"
import type { Block, Message } from "../hooks/useChatState"
import { Markdown } from "./Markdown"
import { ToolTimeline, toolHeadline } from "./ToolCard"
import { vscode } from "../vscode"

export function MessageView({
  message,
  processOpen,
  processOnly,
}: {
  message: Message
  processOpen: boolean
  processOnly: boolean
}) {
  return (
    <div className={`msg role-${message.role}`}>
      {message.ref?.label && <div className="msg-ref">{message.ref.label}</div>}
      {renderMessageBlocks(message, processOpen, processOnly)}
      {message.pending && message.blocks.length === 0 && <div className="thinking-dots">thinking…</div>}
      {message.error && <div className="msg-error">{message.error}</div>}
      {(message.usage?.model || message.usage?.cost || message.usage?.tokens) && (
        <div className="msg-usage">
          {message.usage.model ? <span>{message.usage.model}</span> : null}
          {message.usage.model && (message.usage.cost || message.usage.tokens) ? " · " : null}
          {message.usage.cost ? <>${message.usage.cost.toFixed(4)}</> : null}
          {message.usage.cost && message.usage.tokens ? " · " : null}
          {message.usage.tokens && (
            <span>{message.usage.tokens.input + message.usage.tokens.output} tokens</span>
          )}
        </div>
      )}
    </div>
  )
}

function renderMessageBlocks(message: Message, processOpen: boolean, processOnly: boolean) {
  if (message.role !== "assistant") return renderBlocks(message.blocks)
  if (processOnly) {
    if (!hasProcessBlocks(message.blocks)) return null
    return <ProcessPanel blocks={message.blocks} openKey={`process-only-${message.id}-${message.blocks.length}`} defaultOpen={processOpen} />
  }

  const finalTextIndex = lastTextIndex(message.blocks, message.pending)
  if (finalTextIndex < 0) {
    if (!hasProcessBlocks(message.blocks)) return renderBlocks(message.blocks)
    return <ProcessPanel blocks={message.blocks} openKey={`process-${message.id}-${message.blocks.length}`} defaultOpen={processOpen} />
  }

  const process = message.blocks.slice(0, finalTextIndex)
  const final = message.blocks.slice(finalTextIndex)
  if (!hasProcessBlocks(process)) return renderBlocks(final)
  return (
    <>
      <ProcessPanel blocks={process} openKey={`final-${message.id}-${finalTextIndex}`} defaultOpen={false} />
      {renderBlocks(final)}
    </>
  )
}

function ProcessPanel({ blocks, openKey, defaultOpen }: { blocks: Block[]; openKey: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)

  useEffect(() => {
    setOpen(defaultOpen)
  }, [defaultOpen, openKey])

  return (
    <div className="process">
      <button className="process-head" onClick={() => setOpen(!open)}>
        <span className="process-title">{processTitle(blocks)}</span>
        <span className={`process-caret ${open ? "is-open" : ""}`}>›</span>
      </button>
      {open && <div className="process-body">{renderBlocks(blocks, true)}</div>}
    </div>
  )
}

function renderBlocks(blocks: Block[], processMode = false) {
  const nodes: ReactNode[] = []
  let tools: Extract<Block, { type: "tool" }>[] = []
  const flushTools = () => {
    if (!tools.length) return
    nodes.push(<ToolTimeline key={`tools-${nodes.length}`} updates={tools.map((b) => b.update)} />)
    tools = []
  }
  blocks.forEach((b, i) => {
    if (b.type === "tool") {
      tools.push(b)
      return
    }
    flushTools()
    if (b.type === "text") nodes.push(processMode ? <ProcessText key={i} text={b.text} /> : <Markdown key={i} text={b.text} />)
    if (b.type === "reasoning") nodes.push(<ProcessText key={i} text={b.text} />)
    if (b.type === "patch") nodes.push(<PatchBlock key={i} files={b.files} />)
  })
  flushTools()
  return nodes
}

function ProcessText({ text }: { text: string }) {
  if (!text.trim()) return null
  const title = textTitle(text)
  if (!title) return <div className="process-text">{text}</div>
  const body = stripDuplicateTitle(text, title)
  return (
    <div className="process-text">
      <div className="process-text-title">{title}</div>
      {body && <div>{body}</div>}
    </div>
  )
}

function hasProcessBlocks(blocks: Block[]) {
  return blocks.some((b) => {
    if (b.type === "text" || b.type === "reasoning") return b.text.trim().length > 0
    return true
  })
}

function lastTextIndex(blocks: Block[], pending: boolean) {
  const mixedWithActivity = blocks.some((block) => block.type !== "text") || blocks.filter((block) => block.type === "text").length > 1
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (!block || block.type !== "text" || !block.text.trim()) continue
    if (looksLikeFinalAnswer(block.text)) return i
    if (looksLikeProcessText(block.text)) return -1
    if (!pending && !mixedWithActivity) return i
    return -1
  }
  return -1
}

function looksLikeFinalAnswer(text: string) {
  const value = text.trim()
  if (/^[-*]\s+\[[ x]\]/m.test(value)) return true
  if (/^(short summary|summary|model|i['’]m|factoryflow)/i.test(value)) return true
  return value.length > 240 && !/\b(i('|’)m|i am)\s+(checking|reading|looking|inspecting|exploring|going to|falling back)\b/i.test(value)
}

function looksLikeProcessText(text: string) {
  return /\b(i('|’)m|i am)\s+(checking|reading|looking|inspecting|exploring|going to|falling back|considering)\b/i.test(text)
    || /^(found|next|now|the quick|i detect|i’ve confirmed|i’ve got|i need to|let’s|this will help)\b/i.test(text.trim())
}

function processTitle(blocks: Block[]) {
  const fromText = blocks.flatMap((block) =>
    block.type === "text" || block.type === "reasoning" ? [textTitle(block.text) ?? inferredTextTitle(block.text)] : [],
  ).find(Boolean)
  if (fromText) return fromText

  const tools = blocks.flatMap((block) => block.type === "tool" ? [block.update] : [])
  if (tools.length) return toolHeadline(tools)
  return "Working"
}

function textTitle(text: string) {
  const [first = ""] = text.trim().split(/\n+/)
  const title = cleanProcessText(first).replace(/[:.]+$/, "")
  if (!title || title.length > 80) return undefined
  if (/^(i('|’)m|i am|i need|i think|it seems|this|the user|found|next|now)\b/i.test(title)) return undefined
  if (title.split(/\s+/).length > 8) return undefined
  return title
}

function stripDuplicateTitle(text: string, title: string) {
  const lines = text.trim().split(/\n+/)
  if (cleanProcessText(lines[0] ?? "").replace(/[:.]+$/, "") === title) {
    return lines.slice(1).join("\n").trim()
  }
  return text.trim()
}

function cleanProcessText(text: string) {
  return text
    .trim()
    .replace(/^\*\*(.+)\*\*$/, "$1")
    .replace(/^__(.+)__$/, "$1")
    .replace(/^#+\s*/, "")
}

function inferredTextTitle(text: string) {
  const value = text.trim()
  if (/^i detect\b/i.test(value)) return "Understanding request"
  if (/^found\b/i.test(value)) return "Inspecting project"
  if (/^next\b/i.test(value)) return "Planning next step"
  if (/^i[’']ve confirmed\b/i.test(value)) return "Reviewing structure"
  if (/^i[’']ve got\b/i.test(value)) return "Reviewing findings"
  if (/\bchecking\b/i.test(value)) return "Checking project"
  if (/\breading\b/i.test(value)) return "Reading files"
  if (/\binspecting\b/i.test(value)) return "Inspecting code"
  if (/\bexploring\b/i.test(value)) return "Exploring project"
  if (/\bconsidering\b/i.test(value)) return "Considering next step"
  return undefined
}

function PatchBlock({ files }: { files: string[] }) {
  const [open, setOpen] = useState(files.length <= 4)
  const items = files.map((file) => patchFile(file))

  return (
    <div className="patch">
      <button className="patch-head" onClick={() => setOpen(!open)}>
        <span className="patch-title">Changed {files.length} file{files.length === 1 ? "" : "s"}</span>
        <span className="patch-summary">{patchSummary(items)}</span>
        <span className={`patch-caret ${open ? "is-open" : ""}`}>›</span>
      </button>
      {open && (
        <ul className="patch-list">
          {items.map((item, i) => (
            <li key={i} className="patch-row">
              <span className={`patch-badge kind-${item.kind}`}>{item.label}</span>
              <div className="patch-file-wrap">
                <button
                  className="btn link patch-file"
                  onClick={() => vscode.post({ type: "openFile", path: item.path })}
                  title={item.path}
                >
                  {basename(item.path)}
                </button>
                <div className="patch-path">{dirname(item.path)}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function patchFile(file: string) {
  const match = file.match(/^([AMD])\s+(.+)$/)
  const code = match?.[1]
  return {
    path: match?.[2] ?? file,
    kind: code === "A" ? "created" : code === "D" ? "deleted" : "updated",
    label: code ?? "M",
  }
}

function patchSummary(items: Array<{ kind: string }>) {
  const created = items.filter((item) => item.kind === "created").length
  const deleted = items.filter((item) => item.kind === "deleted").length
  const updated = items.length - created - deleted
  return [created ? `${created} created` : undefined, updated ? `${updated} updated` : undefined, deleted ? `${deleted} deleted` : undefined]
    .filter(Boolean)
    .join(" · ")
}

function basename(value: string) {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

function dirname(value: string) {
  const parts = value.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 1) return ""
  return parts.slice(0, -1).join("/")
}
