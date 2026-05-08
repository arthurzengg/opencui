import { useEffect, useRef, useState } from "react"

type Props = {
  busy: boolean
  contextLabel?: string
  onSend: (text: string) => void
  onAbort: () => void
}

export function PromptBox({ busy, contextLabel, onSend, onAbort }: Props) {
  const [text, setText] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!ref.current) return
    ref.current.style.height = "auto"
    ref.current.style.height = Math.min(ref.current.scrollHeight, 200) + "px"
  }, [text])

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    onSend(trimmed)
    setText("")
  }

  return (
    <div className="promptbox">
      {contextLabel && <div className="context-chip">{contextLabel}</div>}
      <textarea
        ref={ref}
        value={text}
        rows={2}
        placeholder="Ask OpenCUI…  (Enter to send, Shift+Enter for newline)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />
      <div className="promptbox-row">
        <div className="spacer" />
        {busy ? (
          <button className="btn danger" onClick={onAbort}>
            Stop
          </button>
        ) : (
          <button className="btn primary" onClick={submit} disabled={!text.trim()}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}
