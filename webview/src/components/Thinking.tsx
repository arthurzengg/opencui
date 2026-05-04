import { useState } from "react"

export function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const preview = text.slice(0, 80).replace(/\n/g, " ")
  return (
    <div className="thinking">
      <button className="thinking-toggle" onClick={() => setOpen(!open)}>
        <span className="thinking-caret">{open ? "▾" : "▸"}</span>
        <span className="thinking-label">Thinking</span>
        {!open && preview && <span className="thinking-preview"> — {preview}{text.length > 80 ? "…" : ""}</span>}
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
}
