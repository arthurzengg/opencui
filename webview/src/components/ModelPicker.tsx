import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
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

export type PickerSection = {
  title: string
  /** Provider identity; set only on provider groups. Recent/Default never fold. */
  providerID?: string
  collapsed: boolean
  rows: PickerItem[]
}

/**
 * Ordered section list for rendering. Unfiltered: Recent (host-pushed
 * order) → per-provider groups → the default-reset row. Filtered: the
 * matches keep their provider grouping, folded by whatever set the caller
 * passes — the picker passes its transient search folds there, NOT the
 * persisted browse-view folds, so every search session starts with all
 * matching groups revealed and mid-search folding stays local to the
 * session (#565). Every whitespace-separated token must appear in
 * `providerID/modelID providerName`, so "openai mini" or "5.2" both
 * narrow the way you'd expect. A folded provider keeps its section (the
 * header stays clickable) but contributes nothing to the flat item list.
 */
export function buildPickerSections(
  catalog: ModelCatalogInfo | undefined,
  query: string,
  collapsedProviders: ReadonlySet<string>,
): PickerSection[] {
  if (!catalog) return []
  const q = query.trim().toLowerCase()
  if (q) {
    const tokens = q.split(/\s+/)
    const sections: PickerSection[] = []
    for (const entry of catalog.models) {
      const hay = `${modelKey(entry)} ${entry.providerName ?? ""}`.toLowerCase()
      if (!tokens.every((t) => hay.includes(t))) continue
      const tail = sections[sections.length - 1]
      if (!tail || tail.providerID !== entry.providerID) {
        sections.push({
          title: entry.providerName ?? entry.providerID,
          providerID: entry.providerID,
          collapsed: collapsedProviders.has(entry.providerID),
          rows: [],
        })
      }
      sections[sections.length - 1]!.rows.push({
        kind: "model",
        entry,
        section: entry.providerName ?? entry.providerID,
      })
    }
    return sections
  }
  const byKey = new Map(catalog.models.map((m) => [modelKey(m), m]))
  const sections: PickerSection[] = []
  const recent: PickerItem[] = []
  for (const key of catalog.recents) {
    const entry = byKey.get(key)
    if (entry) recent.push({ kind: "model", entry, section: "Recent" })
  }
  if (recent.length) sections.push({ title: "Recent", collapsed: false, rows: recent })
  for (const entry of catalog.models) {
    const tail = sections[sections.length - 1]
    if (!tail || tail.providerID !== entry.providerID) {
      sections.push({
        title: entry.providerName ?? entry.providerID,
        providerID: entry.providerID,
        collapsed: collapsedProviders.has(entry.providerID),
        rows: [],
      })
    }
    sections[sections.length - 1]!.rows.push({
      kind: "model",
      entry,
      section: entry.providerName ?? entry.providerID,
    })
  }
  if (catalog.models.length > 0) {
    sections.push({ title: "Default", collapsed: false, rows: [{ kind: "default", section: "Default" }] })
  }
  return sections
}

/**
 * Flat row list for keyboard navigation — folded groups contribute no rows,
 * so the active index can never point at a row the list isn't showing.
 */
export function buildPickerItems(
  catalog: ModelCatalogInfo | undefined,
  query: string,
  collapsedProviders: ReadonlySet<string>,
): PickerItem[] {
  return buildPickerSections(catalog, query, collapsedProviders).flatMap((s) =>
    s.collapsed ? [] : s.rows,
  )
}

type ChipOption = { key: string; label: string; title?: string }

/**
 * Segmented chip control with the sliding thumb (#516), shared by the
 * Effort and Agent rows. Segment widths vary with their labels, so the
 * thumb is measured off the active chip instead of derived from an index.
 * Layout effect so the thumb lands before paint — opening the picker must
 * not animate; only an in-picker change does.
 */
function ChipGroup({
  groupLabel,
  options,
  activeKey,
  defaultTitle,
  onPick,
}: {
  groupLabel: string
  options: ChipOption[]
  /** undefined = the leading "default" chip. */
  activeKey?: string
  defaultTitle: string
  onPick: (key?: string) => void
}) {
  const chipsRef = useRef<HTMLDivElement | null>(null)
  const [thumb, setThumb] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const optionsSig = options.map((o) => o.label).join("\n")
  useLayoutEffect(() => {
    const active = chipsRef.current?.querySelector<HTMLElement>(".model-picker-chip.is-active")
    if (!active) {
      setThumb(null)
      return
    }
    setThumb({
      x: active.offsetLeft,
      y: active.offsetTop,
      w: active.offsetWidth,
      h: active.offsetHeight,
    })
  }, [activeKey, optionsSig])
  return (
    <div className="model-picker-chips" ref={chipsRef} role="group" aria-label={groupLabel}>
      {thumb && (
        <span
          className="model-picker-chip-thumb"
          style={{
            transform: `translate(${thumb.x}px, ${thumb.y}px)`,
            width: thumb.w,
            height: thumb.h,
          }}
          aria-hidden="true"
        />
      )}
      <button
        type="button"
        className={`model-picker-chip ${activeKey ? "" : "is-active"}`}
        title={defaultTitle}
        onClick={() => onPick(undefined)}
      >
        default
      </button>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          className={`model-picker-chip ${activeKey === o.key ? "is-active" : ""}`}
          title={o.title}
          onClick={() => onPick(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

type Props = {
  catalog?: ModelCatalogInfo
  selection: Selection
  onSetModel: (providerID?: string, modelID?: string, variant?: string) => void
  onSetAgent: (name?: string) => void
  onSetProviderCollapsed: (providerID: string, collapsed: boolean) => void
  /** Posted on mount so a freshly opened picker re-syncs the catalog. */
  onRefresh: () => void
  onClose: () => void
}

export function ModelPicker({
  catalog,
  selection,
  onSetModel,
  onSetAgent,
  onSetProviderCollapsed,
  onRefresh,
  onClose,
}: Props) {
  const [query, setQuery] = useState("")
  // Fold state: the host-pushed catalog seeds it; after the first toggle the
  // local set wins (the host persists without echoing, so a later catalog
  // push carries the same folds and can never fight this).
  const seededFolds = useMemo(() => new Set(catalog?.collapsedProviders ?? []), [catalog])
  const [localFolds, setLocalFolds] = useState<ReadonlySet<string> | null>(null)
  const folds = localFolds ?? seededFolds
  const inSearch = query.trim().length > 0
  // Transient folds for the search view (#565): a search always starts with
  // every matching group revealed — the user typed a name to SEE it, so the
  // browse view's persisted folds must not hide it. Folding mid-search only
  // touches this set; it survives query refinement within the session and is
  // discarded when the query clears.
  const [searchFolds, setSearchFolds] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    // Functional update returning the same ref when already empty, so
    // leaving search doesn't trigger a redundant render.
    if (!inSearch) setSearchFolds((prev) => (prev.size ? new Set() : prev))
  }, [inSearch])
  const sections = useMemo(
    () => buildPickerSections(catalog, query, inSearch ? searchFolds : folds),
    [catalog, query, inSearch, searchFolds, folds],
  )
  const items = useMemo(() => sections.flatMap((s) => (s.collapsed ? [] : s.rows)), [sections])
  const indexOfItem = useMemo(() => new Map(items.map((item, i) => [item, i])), [items])
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

  // Folding the tail group can strand the active index past the new end.
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, items.length - 1)))
  }, [items.length])

  // Effort and agent are iterative tweaks — try one, glance at the result,
  // adjust — so unlike a model pick (the terminal action) a chip click leaves
  // the popover open. The active chip moves optimistically; the host's
  // selection echo then confirms it, and wins if it ever disagrees.
  const [pendingVariant, setPendingVariant] = useState<{ variant?: string } | null>(null)
  useEffect(() => {
    setPendingVariant(null)
  }, [selection.modelVariant, selection.model])
  const activeVariant = pendingVariant ? pendingVariant.variant : selection.modelVariant

  const [pendingAgent, setPendingAgent] = useState<{ name?: string } | null>(null)
  useEffect(() => {
    setPendingAgent(null)
  }, [selection.agent])
  const activeAgent = pendingAgent ? pendingAgent.name : selection.agent
  const agents = catalog?.agents ?? []

  const searchRef = useRef<HTMLInputElement | null>(null)
  const pickVariant = (variant?: string) => {
    if (!current) return
    setPendingVariant({ variant })
    onSetModel(current.providerID, current.modelID, variant)
    // The click parked focus on the chip; hand it back so arrows and typing
    // keep working without another click.
    searchRef.current?.focus()
  }
  const pickAgent = (name?: string) => {
    setPendingAgent({ name })
    onSetAgent(name)
    searchRef.current?.focus()
  }
  const toggleProvider = (providerID: string) => {
    if (inSearch) {
      // Transient act on a transient view: never written through to the
      // persisted browse-view folds (#565).
      setSearchFolds((prev) => {
        const next = new Set(prev)
        if (next.has(providerID)) next.delete(providerID)
        else next.add(providerID)
        return next
      })
      searchRef.current?.focus()
      return
    }
    const next = new Set(folds)
    const fold = !next.has(providerID)
    if (fold) next.add(providerID)
    else next.delete(providerID)
    setLocalFolds(next)
    onSetProviderCollapsed(providerID, fold)
    searchRef.current?.focus()
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
      <div className="model-picker-search-wrap">
        <span className="codicon codicon-search" aria-hidden="true" />
        <input
          ref={searchRef}
          className="model-picker-search"
          type="text"
          placeholder="Search models…"
          aria-label="Search models"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div
        className="model-picker-list"
        ref={listRef}
        role="listbox"
        aria-label="Models"
        onMouseMove={onListMouseMove}
      >
        {!catalog && <div className="model-picker-empty">Waiting for the model list…</div>}
        {/* Keyed off sections, not items: matches hidden behind a collapsed
            header are still matches, not an empty result. */}
        {catalog && sections.length === 0 && (
          <div className="model-picker-empty">
            {query ? `No models match “${query.trim()}”` : "No models reported by opencode"}
          </div>
        )}
        {sections.map((section) => (
          <Fragment key={section.providerID ? `provider:${section.providerID}` : `section:${section.title}`}>
            {section.providerID ? (
              <button
                type="button"
                className="model-picker-section model-picker-section-toggle"
                aria-expanded={!section.collapsed}
                onClick={() => toggleProvider(section.providerID!)}
              >
                <span
                  className={`codicon codicon-chevron-${section.collapsed ? "right" : "down"}`}
                  aria-hidden="true"
                />
                {section.title}
              </button>
            ) : (
              <div className="model-picker-section">{section.title}</div>
            )}
            {!section.collapsed &&
              section.rows.map((item) => {
                const i = indexOfItem.get(item)!
                if (item.kind === "default") {
                  return (
                    <button
                      key={`${item.section}:__default`}
                      type="button"
                      role="option"
                      aria-selected={i === activeIndex}
                      className={`model-picker-row ${i === activeIndex ? "active" : ""} ${currentKey ? "" : "is-current"}`}
                      onMouseEnter={() => hoverMove(() => setActiveIndex(i))}
                      onClick={() => selectItem(item)}
                      title="Use opencode's configured default model"
                    >
                      <span className="model-picker-name">opencode default</span>
                      {!currentKey && <span className="codicon codicon-check" aria-hidden="true" />}
                    </button>
                  )
                }
                const entry = item.entry
                const key = modelKey(entry)
                const isCurrent = key === currentKey
                const tooltip = entry.lastVariant ? `${key} · ${entry.lastVariant}` : key
                // Inside a provider group the header already names the provider;
                // repeating it per row is noise. Only Recent mixes providers,
                // so only there the label disambiguates.
                const showProvider = item.section === "Recent"
                return (
                  <button
                    key={`${item.section}:${key}`}
                    type="button"
                    role="option"
                    aria-selected={i === activeIndex}
                    className={`model-picker-row ${i === activeIndex ? "active" : ""} ${isCurrent ? "is-current" : ""}`}
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
                    {showProvider && (
                      <span className="model-picker-provider">
                        {entry.providerName ?? entry.providerID}
                      </span>
                    )}
                    {isCurrent && <span className="codicon codicon-check" aria-hidden="true" />}
                  </button>
                )
              })}
          </Fragment>
        ))}
      </div>
      {current && current.variants.length > 0 && (
        <div className="model-picker-effort">
          <span className="model-picker-chip-label">Effort</span>
          <ChipGroup
            groupLabel="Effort"
            options={current.variants.map((v) => ({ key: v, label: v }))}
            activeKey={activeVariant}
            defaultTitle="Use the model's default effort"
            onPick={pickVariant}
          />
        </div>
      )}
      {agents.length > 0 && (
        <div className="model-picker-agents">
          <span className="model-picker-chip-label">Agent</span>
          <ChipGroup
            groupLabel="Agent"
            options={agents.map((a) => ({ key: a.name, label: a.name, title: a.description }))}
            activeKey={activeAgent}
            defaultTitle="Use the opencode default agent"
            onPick={pickAgent}
          />
        </div>
      )}
    </div>
  )
}
