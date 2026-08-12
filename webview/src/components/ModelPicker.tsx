import { Fragment, useEffect, useMemo, useRef, useState } from "react"
import type { ModelCatalogEntry, ModelCatalogInfo, Selection } from "../protocol"

/**
 * In-panel model + effort picker (issue #512). Replaces the old handoff to
 * the native QuickPick, which opened at the top-center of the window (far
 * from the sidebar click) after a blocking provider fetch. This popover
 * renders from the host-pushed catalog, so opening it never waits on HTTP.
 *
 * Selecting a model sends its `lastVariant` along (per-model effort memory,
 * maintained host-side), so switching away and back restores the effort the
 * user last ran that model with.
 */

export type PickerItem =
  | { kind: "model"; entry: ModelCatalogEntry; section: string }
  /** Reset to the opencode default model. */
  | { kind: "default"; section: string }

export function modelKey(entry: ModelCatalogEntry): string {
  return `${entry.providerID}/${entry.modelID}`
}

/**
 * Flat, ordered row list for rendering AND keyboard navigation — one array
 * so the active index can never point at a row the list isn't showing.
 * Unfiltered: Recent (host-pushed order) → per-provider groups → the
 * default-reset row. Filtered: a flat match list; every whitespace-separated
 * token must appear in `providerID/modelID providerName`, so "openai mini"
 * or "5.2" both narrow the way you'd expect.
 */
export function buildPickerItems(
  catalog: ModelCatalogInfo | undefined,
  query: string,
): PickerItem[] {
  if (!catalog) return []
  const q = query.trim().toLowerCase()
  if (q) {
    const tokens = q.split(/\s+/)
    return catalog.models
      .filter((m) => {
        const hay = `${modelKey(m)} ${m.providerName ?? ""}`.toLowerCase()
        return tokens.every((t) => hay.includes(t))
      })
      .map((entry): PickerItem => ({ kind: "model", entry, section: "" }))
  }
  const byKey = new Map(catalog.models.map((m) => [modelKey(m), m]))
  const items: PickerItem[] = []
  for (const key of catalog.recents) {
    const entry = byKey.get(key)
    if (entry) items.push({ kind: "model", entry, section: "Recent" })
  }
  for (const entry of catalog.models) {
    items.push({ kind: "model", entry, section: entry.providerName ?? entry.providerID })
  }
  if (catalog.models.length > 0) items.push({ kind: "default", section: "Default" })
  return items
}

type Props = {
  catalog?: ModelCatalogInfo
  selection: Selection
  /** Display label for the agent footer row. */
  agentLabel: string
  onSetModel: (providerID?: string, modelID?: string, variant?: string) => void
  onSelectAgent: () => void
  /** Posted on mount so a freshly opened picker re-syncs the catalog. */
  onRefresh: () => void
  onClose: () => void
}

export function ModelPicker({
  catalog,
  selection,
  agentLabel,
  onSetModel,
  onSelectAgent,
  onRefresh,
  onClose,
}: Props) {
  const [query, setQuery] = useState("")
  const items = useMemo(() => buildPickerItems(catalog, query), [catalog, query])
  const currentKey = selection.model
  const current = useMemo(
    () => (currentKey ? catalog?.models.find((m) => modelKey(m) === currentKey) : undefined),
    [catalog, currentKey],
  )
  const [activeIndex, setActiveIndex] = useState(0)

  // Stale-while-revalidate: render the pushed catalog immediately, ask the
  // host for a fresh one in the background (config may have changed).
  useEffect(() => {
    onRefresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Start on the current model so Enter with no arrows is a no-op re-pick,
  // and the first ArrowDown moves to a neighbor instead of the list top.
  useEffect(() => {
    if (query) {
      setActiveIndex(0)
      return
    }
    const idx = items.findIndex(
      (item) => item.kind === "model" && modelKey(item.entry) === currentKey,
    )
    setActiveIndex(idx >= 0 ? idx : 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, catalog])

  // Same two hover/keyboard guards as the PromptBox pickers: arrow keys
  // suppress hover until the pointer actually moves (scrollIntoView slides
  // rows under a resting cursor, and Blink re-fires mouseenter there), and
  // hover never triggers scrollIntoView (rows would shift under the cursor).
  const listRef = useRef<HTMLDivElement | null>(null)
  const keyboardNavRef = useRef(false)
  const hoverEnabledRef = useRef(true)
  const lastPointerRef = useRef<{ x: number; y: number } | undefined>(undefined)
  const onListMouseMove = (e: React.MouseEvent) => {
    // Blink repeats the last real coordinates on its post-scroll synthetic
    // mousemove — only changed coordinates prove the user moved.
    const last = lastPointerRef.current
    if (last && last.x === e.clientX && last.y === e.clientY) return
    lastPointerRef.current = { x: e.clientX, y: e.clientY }
    hoverEnabledRef.current = true
  }
  const hoverMove = (apply: () => void) => {
    if (!hoverEnabledRef.current) return
    keyboardNavRef.current = false
    apply()
  }
  useEffect(() => {
    const byKeyboard = keyboardNavRef.current
    keyboardNavRef.current = false
    if (!byKeyboard) return
    const active = listRef.current?.querySelector('[aria-selected="true"]')
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" })
    }
  }, [activeIndex])

  const selectItem = (item: PickerItem) => {
    if (item.kind === "default") onSetModel(undefined, undefined, undefined)
    else onSetModel(item.entry.providerID, item.entry.modelID, item.entry.lastVariant)
    onClose()
  }

  const pickVariant = (variant?: string) => {
    if (!current) return
    onSetModel(current.providerID, current.modelID, variant)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // IME composition owns Enter (commit candidate) and the arrows
    // (navigate candidates) — never treat them as picker input.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      if (items.length === 0) return
      keyboardNavRef.current = true
      hoverEnabledRef.current = false
      const delta = e.key === "ArrowDown" ? 1 : -1
      setActiveIndex((i) => (i + delta + items.length) % items.length)
      return
    }
    if (e.key === "Enter") {
      e.preventDefault()
      const item = items[activeIndex]
      if (item) selectItem(item)
    }
  }

  return (
    <div className="model-picker">
      <input
        className="model-picker-search"
        type="text"
        placeholder="Search models…"
        aria-label="Search models"
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {current && current.variants.length > 0 && (
        <div className="model-picker-effort">
          <span className="model-picker-effort-label">Effort</span>
          <div className="model-picker-chips">
            <button
              type="button"
              className={`model-picker-chip ${selection.modelVariant ? "" : "is-active"}`}
              title="Use the model's default effort"
              onClick={() => pickVariant(undefined)}
            >
              default
            </button>
            {current.variants.map((v) => (
              <button
                key={v}
                type="button"
                className={`model-picker-chip ${selection.modelVariant === v ? "is-active" : ""}`}
                onClick={() => pickVariant(v)}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      )}
      <div
        className="model-picker-list"
        ref={listRef}
        role="listbox"
        aria-label="Models"
        onMouseMove={onListMouseMove}
      >
        {!catalog && <div className="model-picker-empty">Waiting for the model list…</div>}
        {catalog && items.length === 0 && (
          <div className="model-picker-empty">
            {query ? `No models match “${query.trim()}”` : "No models reported by opencode"}
          </div>
        )}
        {items.map((item, i) => {
          const showHeader =
            item.section !== "" && (i === 0 || items[i - 1]!.section !== item.section)
          if (item.kind === "default") {
            return (
              <Fragment key={`${item.section}:__default`}>
                {showHeader && <div className="model-picker-section">{item.section}</div>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  className={`model-picker-row ${i === activeIndex ? "active" : ""}`}
                  onMouseEnter={() => hoverMove(() => setActiveIndex(i))}
                  onClick={() => selectItem(item)}
                  title="Use opencode's configured default model"
                >
                  <span className="model-picker-name">opencode default</span>
                  {!currentKey && <span className="codicon codicon-check" aria-hidden="true" />}
                </button>
              </Fragment>
            )
          }
          const entry = item.entry
          const key = modelKey(entry)
          const isCurrent = key === currentKey
          const tooltip = entry.lastVariant ? `${key} · ${entry.lastVariant}` : key
          return (
            <Fragment key={`${item.section}:${key}`}>
              {showHeader && <div className="model-picker-section">{item.section}</div>}
              <button
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                className={`model-picker-row ${i === activeIndex ? "active" : ""}`}
                onMouseEnter={() => hoverMove(() => setActiveIndex(i))}
                onClick={() => selectItem(item)}
                title={tooltip}
              >
                {/* Raw model id, not the prettified label: the picker is where
                    date-suffix and point-release differences matter. */}
                <span className="model-picker-name">{entry.modelID}</span>
                {entry.lastVariant && (
                  <span className="model-picker-last-variant">{entry.lastVariant}</span>
                )}
                <span className="model-picker-provider">
                  {entry.providerName ?? entry.providerID}
                </span>
                {isCurrent && <span className="codicon codicon-check" aria-hidden="true" />}
              </button>
            </Fragment>
          )
        })}
      </div>
      <button
        type="button"
        className="selector-row model-picker-agent"
        onClick={() => {
          onSelectAgent()
          onClose()
        }}
      >
        <span className="selector-row-label">Agent</span>
        <span className="selector-row-value" title={agentLabel}>
          {agentLabel}
        </span>
        <span className="selector-row-arrow">›</span>
      </button>
    </div>
  )
}
