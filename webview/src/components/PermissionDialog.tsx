type Props = {
  id: string
  title: string
  pattern?: string | string[]
  /** What "Allow always" saves as rules (#619); shown beside the choice and in its tooltip. */
  always?: string[]
  onReply: (id: string, response: "once" | "always" | "reject") => void
}

/**
 * Styled after the request card in Claude's own VS Code panel (#750): no title
 * icon, a bold line that says what is asked, the pattern in full, and the
 * choices as stacked rows with the narrowest grant first and filled.
 */
export function PermissionDialog({ id, title, pattern, always, onReply }: Props) {
  const patternStr = Array.isArray(pattern) ? pattern.join(", ") : pattern
  const rules = always?.length ? always.join(", ") : undefined
  return (
    <div className="permission" role="group" aria-label="Permission request">
      <div className="permission-title">{title}</div>
      {patternStr && (
        <code className="permission-pattern">
          {patternStr.split(/(\s+)/).map((part, i) =>
            // Whitespace stays text so the pattern copies out unchanged.
            part.trim() ? <span key={i} className="permission-token">{part}</span> : part,
          )}
        </code>
      )}
      <div className="permission-actions">
        <button className="permission-option is-primary" onClick={() => onReply(id, "once")}>
          Allow once
        </button>
        <button
          className="permission-option"
          onClick={() => onReply(id, "always")}
          title={rules ? `Saves a rule for: ${rules}` : undefined}
        >
          <span>Allow always</span>
          {/* The tooltip already names the rule for assistive tech. */}
          {rules && <span className="permission-option-detail" aria-hidden="true">{rules}</span>}
        </button>
        <button className="permission-option" onClick={() => onReply(id, "reject")}>
          Reject
        </button>
      </div>
    </div>
  )
}
