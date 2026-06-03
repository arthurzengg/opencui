import { useEffect, useState } from "react"
import type { QuestionInfo } from "../protocol"

type Props = {
  id: string
  questions: QuestionInfo[]
  onReply: (id: string, answers: string[][]) => void
  onReject: (id: string) => void
}

/**
 * Per-question answer state. `selected` is the labels chosen from the option
 * list; `custom` is the optional free-text answer (used when the question
 * allows `custom !== false`). When the user submits we serialize each per-
 * question state into a `string[]` (selected labels, plus the custom string
 * appended if non-empty).
 */
type AnswerState = { selected: Set<string>; custom: string }

export function QuestionDialog({ id, questions, onReply, onReject }: Props) {
  // One AnswerState per question, indexed by position.
  const [answers, setAnswers] = useState<AnswerState[]>(() =>
    questions.map(() => ({ selected: new Set<string>(), custom: "" })),
  )

  // If the parent swaps in a different question request (rare), reset.
  useEffect(() => {
    setAnswers(questions.map(() => ({ selected: new Set<string>(), custom: "" })))
  }, [id, questions])

  const updateAnswer = (idx: number, patch: (prev: AnswerState) => AnswerState) => {
    setAnswers((prev) => prev.map((a, i) => (i === idx ? patch(a) : a)))
  }

  const toggleOption = (idx: number, label: string, multiple: boolean) => {
    updateAnswer(idx, (prev) => {
      const next = new Set(prev.selected)
      if (multiple) {
        if (next.has(label)) next.delete(label)
        else next.add(label)
      } else {
        next.clear()
        next.add(label)
      }
      return { ...prev, selected: next }
    })
  }

  const setCustom = (idx: number, value: string) => {
    updateAnswer(idx, (prev) => ({ ...prev, custom: value }))
  }

  // Every question needs at least one selected option OR a non-empty custom
  // answer (when custom is enabled) before Send is allowed.
  const canSubmit = questions.every((q, i) => {
    const a = answers[i]!
    if (a.selected.size > 0) return true
    if (q.custom !== false && a.custom.trim().length > 0) return true
    return false
  })

  const submit = () => {
    if (!canSubmit) return
    const payload: string[][] = answers.map((a) => {
      const out = Array.from(a.selected)
      const c = a.custom.trim()
      if (c) out.push(c)
      return out
    })
    onReply(id, payload)
  }

  return (
    <div className="question">
      <div className="question-title">❓ Question{questions.length > 1 ? "s" : ""} from the assistant</div>
      <div className="question-body">
        {questions.map((q, i) => (
          <QuestionItem
            key={i}
            question={q}
            answer={answers[i]!}
            onToggle={(label) => toggleOption(i, label, q.multiple ?? false)}
            onCustomChange={(value) => setCustom(i, value)}
          />
        ))}
      </div>
      <div className="question-actions">
        <button className="btn" onClick={() => onReject(id)}>
          Skip
        </button>
        <button className="btn primary" onClick={submit} disabled={!canSubmit}>
          Send
        </button>
      </div>
    </div>
  )
}

function QuestionItem({
  question,
  answer,
  onToggle,
  onCustomChange,
}: {
  question: QuestionInfo
  answer: AnswerState
  onToggle: (label: string) => void
  onCustomChange: (value: string) => void
}) {
  const allowCustom = question.custom !== false
  const multiple = question.multiple ?? false
  return (
    <div className="question-item">
      {question.header && <div className="question-header">{question.header}</div>}
      <div className="question-text">{question.question}</div>
      {question.options.length > 0 && (
        <ul className="question-options" role={multiple ? "group" : "radiogroup"}>
          {question.options.map((opt) => {
            const checked = answer.selected.has(opt.label)
            return (
              <li key={opt.label}>
                <button
                  type="button"
                  className={`question-option ${checked ? "is-checked" : ""}`}
                  role={multiple ? "checkbox" : "radio"}
                  aria-checked={checked}
                  onClick={() => onToggle(opt.label)}
                >
                  <span className={`question-option-marker ${multiple ? "square" : "circle"}`} aria-hidden="true">
                    {checked && (multiple ? <span className="codicon codicon-check" /> : "●")}
                  </span>
                  <span className="question-option-text">
                    <span className="question-option-label">{opt.label}</span>
                    {opt.description && <span className="question-option-desc">{opt.description}</span>}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {allowCustom && (
        <textarea
          className="question-custom"
          placeholder={question.options.length > 0 ? "Or type a custom answer…" : "Type your answer…"}
          rows={2}
          value={answer.custom}
          onChange={(e) => onCustomChange(e.target.value)}
          // IME-aware Enter handler: in chat composers Enter sends; here we
          // keep Enter as newline so users can write multi-line answers.
          // Submission is via the Send button only.
        />
      )}
    </div>
  )
}
