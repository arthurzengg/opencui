import { createContext } from "react"
import type { AgentsTaskInfo } from "./protocol"
import type { TurnState } from "./agent-row"

const NO_TASKS: AgentsTaskInfo[] = []

/**
 * The open session's live subagent tasks. A context, not a prop: a task
 * changes while its row's message does not, and only the rows should render
 * again for it.
 */
export const AgentTasksContext = createContext<AgentsTaskInfo[]>(NO_TASKS)

/**
 * When the open turn began, by the panel's own clock, or undefined when the
 * panel did not see it begin. The live line counts from it (#798).
 */
export const TurnStartContext = createContext<number | undefined>(undefined)

/** Whether the message a trace belongs to is still being written, and whether the user stopped it. */
export const TurnContext = createContext<TurnState>({ live: false, stopped: false })
