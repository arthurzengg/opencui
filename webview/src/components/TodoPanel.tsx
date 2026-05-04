import { useState } from "react"
import type { Todo } from "../protocol"

export function TodoPanel({ todos }: { todos: Todo[] }) {
  const [collapsed, setCollapsed] = useState(true)
  if (!todos.length) return null
  const remaining = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled").length
  const completed = todos.length - remaining
  const active = todos.find((t) => t.status === "in_progress") ?? todos.find((t) => t.status === "pending")

  return (
    <div className={`todo-panel ${collapsed ? "is-collapsed" : ""} ${active ? "has-active" : ""}`}>
      <button className="todo-header" onClick={() => setCollapsed(!collapsed)}>
        <span className={`todo-caret ${collapsed ? "" : "is-open"}`}>›</span>
        <span>Todos</span>
        <span className="todo-progress">{completed}/{todos.length}</span>
      </button>
      <div className="todo-body">
        {active && <div className="todo-current">{active.content}</div>}
        <ul className="todo-list">
          {todos.map((t, i) => (
            <li key={i} className={`todo-item status-${t.status}`}>
              <span className="todo-status" aria-label={statusLabel(t.status)} />
              <span className="todo-content">{t.content}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function statusLabel(status: Todo["status"]): string {
  if (status === "completed") return "completed"
  if (status === "in_progress") return "in progress"
  if (status === "cancelled") return "cancelled"
  return "pending"
}
