import { useEffect, useRef, useState } from "react"
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
 * allows `custom !== false`).
 *
 * In single-select the free-text answer is an option of its own: `customChosen`
 * records that the "Other…" radio is the checked one, so the two can never be
 * answered at once. Sending both at once is ambiguous — the 2.0 adapter reads
 * only the first entry of a field's answer (`formAnswer`), so an option label
 * silently swallowed the typed answer.
 */
type AnswerState = { selected: Set<string>; custom: string; customChosen: boolean }

/** A single-select question with a free-text answer offers "Other…" as a radio. */
function offersOtherRadio(question: QuestionInfo): boolean {
  return question.custom !== false && !(question.multiple ?? false) && question.options.length > 0
}

const emptyAnswer = (): AnswerState => ({ selected: new Set<string>(), custom: "", customChosen: false })

export function QuestionDialog({ id, questions, onReply, onReject }: Props) {
  // One AnswerState per question, indexed by position.
  const [answers, setAnswers] = useState<AnswerState[]>(() => questions.map(emptyAnswer))

  // If the parent swaps in a different question request (rare), reset.
  useEffect(() => {
    setAnswers(questions.map(emptyAnswer))
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
      // Picking a real option takes the free-text answer out of the answer,
      // so Send never ships both. The typed text is kept and comes back if
      // the user picks "Other…" again.
      return { ...prev, selected: next, customChosen: false }
    })
  }

  /** The "Other…" radio: the free-text field is the answer to this question. */
  const chooseCustom = (idx: number) => {
    updateAnswer(idx, (prev) => ({ ...prev, selected: new Set<string>(), customChosen: true }))
  }

  const setCustom = (idx: number, value: string) => {
    updateAnswer(idx, (prev) => ({ ...prev, custom: value }))
  }

  // Every question needs at least one selected option OR a non-empty custom
  // answer (when custom is enabled) before Send is allowed.
  const canSubmit = questions.every((q, i) => {
    const a = answers[i]!
    if (a.selected.size > 0) return true
    if (q.custom === false) return false
    // With an "Other…" radio the typed text only counts as an answer once that
    // radio is the checked one.
    if (offersOtherRadio(q) && !a.customChosen) return false
    return a.custom.trim().length > 0
  })

  const submit = () => {
    if (!canSubmit) return
    const payload: string[][] = answers.map((a, i) => {
      const q = questions[i]!
      const c = a.custom.trim()
      // Single-select with an "Other…" radio: the checked control is the whole
      // answer. Shipping both would be ambiguous — the 2.0 adapter reads only
      // the first entry of a field, so an option label would swallow the typed
      // answer. Multi-select and option-less questions keep appending it.
      if (offersOtherRadio(q)) {
        if (a.customChosen) return c ? [c] : []
        return Array.from(a.selected)
      }
      const out = Array.from(a.selected)
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
            onChooseCustom={() => chooseCustom(i)}
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
  onChooseCustom,
  onCustomChange,
}: {
  question: QuestionInfo
  answer: AnswerState
  onToggle: (label: string) => void
  onChooseCustom: () => void
  onCustomChange: (value: string) => void
}) {
  const allowCustom = question.custom !== false
  const multiple = question.multiple ?? false
  const withOtherRadio = offersOtherRadio(question)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Picking "Other…" is the user saying "I'm typing the answer", so put the
  // caret in the field instead of making them click into it. The focus has to
  // wait for the commit: the field is disabled until "Other…" is checked, and
  // focusing a disabled textarea is a no-op.
  useEffect(() => {
    if (answer.customChosen) textareaRef.current?.focus()
  }, [answer.customChosen])

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
          {withOtherRadio && (
            <li>
              <button
                type="button"
                className={`question-option ${answer.customChosen ? "is-checked" : ""}`}
                role="radio"
                aria-checked={answer.customChosen}
                onClick={onChooseCustom}
              >
                <span className="question-option-marker circle" aria-hidden="true">
                  {answer.customChosen && "●"}
                </span>
                <span className="question-option-text">
                  <span className="question-option-label">Other…</span>
                  <span className="question-option-desc">Type your own answer</span>
                </span>
              </button>
            </li>
          )}
        </ul>
      )}
      {allowCustom && (
        <textarea
          ref={textareaRef}
          className="question-custom"
          // A real option is checked: the typed text is not the answer, so the
          // field is out until "Other…" is picked again — without losing it.
          disabled={withOtherRadio && !answer.customChosen}
          placeholder={
            !question.options.length
              ? "Type your answer…"
              : answer.customChosen
                ? "Type your own answer…"
                : "Pick an option or “Other…”"
          }
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
