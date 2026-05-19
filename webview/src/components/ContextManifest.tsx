import { useState } from "react"
import type {
  PromptContextManifest,
  PromptContextManifestItem,
  PromptContextManifestItemSource,
} from "../protocol"

type Props = { context: PromptContextManifest }

const SOURCE_LABELS: Record<PromptContextManifestItemSource, string> = {
  editor: "Active editor",
  mention: "Mentions",
  attachment: "Attachments",
  openTab: "Open tabs",
  git: "Git",
  diagnostic: "Diagnostics",
  recentEdit: "Recent edits",
  doc: "Docs",
  symbol: "Symbols",
  semantic: "Semantic",
  opencode: "OpenCode",
  omo: "OMO",
  external: "External",
}

const SOURCE_ORDER: PromptContextManifestItemSource[] = [
  "mention",
  "editor",
  "attachment",
  "git",
  "diagnostic",
  "openTab",
  "recentEdit",
  "doc",
  "symbol",
  "semantic",
  "opencode",
  "omo",
  "external",
]

/**
 * Compact pill ("Context: N items · NN KB · workspace") that expands into a
 * grouped list of manifest items. Hidden when there's no signal at all
 * (no workspace, no items). Phases 3+ append more sources; this component
 * doesn't need changes per phase because it dispatches on `item.source`.
 */
export function ContextManifest({ context }: Props) {
  const [open, setOpen] = useState(false)
  const items = context.items ?? []
  const showPill = Boolean(context.workspace) || items.length > 0
  if (!showPill) return null

  const { included, skipped, truncated, bytes } = summarize(context)
  const workspaceLabel = context.workspace?.name

  return (
    <div className={`context-pill ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="context-pill-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Show context details"
      >
        <span className="context-pill-label">Context</span>
        <span className="context-pill-stats">
          {included} {included === 1 ? "item" : "items"}
          {truncated > 0 ? ` · ${truncated} truncated` : ""}
          {skipped > 0 ? ` · ${skipped} skipped` : ""}
          {bytes > 0 ? ` · ${formatBytes(bytes)}` : ""}
          {workspaceLabel ? ` · ${workspaceLabel}` : ""}
        </span>
        <span className={`context-pill-caret ${open ? "is-open" : ""}`}>›</span>
      </button>
      {open && (
        <div className="context-pill-body">
          {context.workspace && (
            <div className="context-section">
              <div className="context-section-head">Workspace</div>
              <div className="context-section-row">
                <span className="context-row-label">{context.workspace.name}</span>
                <span className="context-row-meta">{context.workspace.root}</span>
              </div>
              {context.opencode && (
                <div className="context-section-row">
                  <span className="context-row-label">Config mode</span>
                  <span className="context-row-meta">{context.opencode.configMode}</span>
                </div>
              )}
            </div>
          )}
          {renderGroups(items)}
        </div>
      )}
    </div>
  )
}

function renderGroups(items: PromptContextManifestItem[]) {
  const grouped = new Map<PromptContextManifestItemSource, PromptContextManifestItem[]>()
  for (const item of items) {
    const list = grouped.get(item.source) ?? []
    list.push(item)
    grouped.set(item.source, list)
  }
  const order = SOURCE_ORDER.filter((s) => grouped.has(s))
  return order.map((source) => (
    <div key={source} className="context-section">
      <div className="context-section-head">{SOURCE_LABELS[source]}</div>
      {grouped.get(source)!.map((item) => (
        <div key={item.id} className={`context-section-row status-${item.status}`}>
          <span className="context-row-label">{item.label}</span>
          <span className="context-row-meta">
            {statusBadge(item.status)}
            {item.external ? <span className="context-badge external">external</span> : null}
            {item.bytes ? <span className="context-row-bytes">{formatBytes(item.bytes)}</span> : null}
          </span>
        </div>
      ))}
    </div>
  ))
}

function statusBadge(status: PromptContextManifestItem["status"]) {
  if (status === "included") return null
  return <span className={`context-badge ${status}`}>{status}</span>
}

function summarize(context: PromptContextManifest) {
  let included = 0
  let skipped = 0
  let truncated = 0
  for (const item of context.items ?? []) {
    if (item.status === "included") included += 1
    else if (item.status === "truncated") {
      included += 1
      truncated += 1
    } else if (item.status === "skipped") skipped += 1
  }
  return { included, skipped, truncated, bytes: context.totals?.includedBytes ?? 0 }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
