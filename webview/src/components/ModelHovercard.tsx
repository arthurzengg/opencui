import type { ModelCatalogEntry } from "../protocol"

/**
 * Small metadata table for a model, shown while hovering the model pill in the
 * status bar or a row in the model picker. Reads entirely from the host-pushed
 * catalog entry: the model's configured display name, its provider/model id,
 * the reasoning (effort) levels it exposes, and the token limits opencode
 * reports.
 *
 * `className` lets the caller place it (the pill drops it below the bar as a
 * floating card; the picker docks it in a static details block under the
 * list) while keeping one table.
 */
export function ModelHovercard({
  entry,
  fallbackName,
  className,
}: {
  entry: ModelCatalogEntry
  fallbackName: string
  className?: string
}) {
  const reasoning = entry.variants.length > 0
    ? entry.variants.join(", ")
    : entry.reasoning
      ? "default"
      : "—"
  return (
    <div className={`selector-hovercard ${className ?? ""}`.trim()} role="tooltip">
      <table className="selector-hovercard-table">
        <tbody>
          <tr>
            <th scope="row">Model</th>
            <td>{entry.name && entry.name !== entry.modelID ? entry.name : fallbackName}</td>
          </tr>
          <tr>
            <th scope="row">Model ID</th>
            <td>{`${entry.providerID}/${entry.modelID}`}</td>
          </tr>
          <tr>
            <th scope="row">Reasoning</th>
            <td>{reasoning}</td>
          </tr>
          <tr>
            <th scope="row">Context</th>
            <td>{formatTokens(entry.limit?.context)}</td>
          </tr>
          <tr>
            <th scope="row">Max output</th>
            <td>{formatTokens(entry.limit?.output)}</td>
          </tr>
          <tr>
            <th scope="row">Max input</th>
            <td>{formatTokens(entry.limit?.input)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function formatTokens(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value.toLocaleString("en-US")
    : "—"
}
