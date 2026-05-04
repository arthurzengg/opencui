type Props = {
  id: string
  title: string
  pattern?: string | string[]
  onReply: (id: string, response: "once" | "always" | "reject") => void
}

export function PermissionDialog({ id, title, pattern, onReply }: Props) {
  const patternStr = Array.isArray(pattern) ? pattern.join(", ") : pattern
  return (
    <div className="permission">
      <div className="permission-title">🔐 Permission requested</div>
      <div className="permission-body">
        <div>{title}</div>
        {patternStr && <code className="permission-pattern">{patternStr}</code>}
      </div>
      <div className="permission-actions">
        <button className="btn" onClick={() => onReply(id, "reject")}>
          Reject
        </button>
        <button className="btn" onClick={() => onReply(id, "once")}>
          Allow once
        </button>
        <button className="btn primary" onClick={() => onReply(id, "always")}>
          Allow always
        </button>
      </div>
    </div>
  )
}
