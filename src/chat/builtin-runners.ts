import * as vscode from "vscode"
import type { Backend } from "../server"
import type { Preferences } from "../preferences"
import type { ChatMessage, Outbound, ReviewHunkState } from "../protocol"
import type { ConversationManager } from "./conversation-manager"
import { generateMessageID } from "./builtin-commands"
import { lastUserTurnIndex, redoAction, userMessageText } from "./undo"
import { log } from "../output"

/**
 * Everything the built-in runners need from ChatView, as closures so the
 * view's fields stay private (same pattern as {@link SubagentDispatch}).
 * The runners never cache session state across awaits beyond a single
 * command's execution — each `run*` re-reads through these accessors.
 */
export type BuiltinRunnerDeps = {
  prefs: Preferences
  manager: ConversationManager
  getSessionID: () => string | undefined
  setSessionID: (id: string) => void
  hasSubscription: () => boolean
  attachSubscription: (backend: Backend, sessionID: string) => Promise<void>
  /** Post the typed-invocation bubble and key the Agents popover for the turn. */
  beginBuiltinTurn: (display: string) => Promise<void>
  /**
   * Settle a turn that failed after {@link beginBuiltinTurn}: a call that
   * never started a server turn produces no SSE events, so nothing else
   * would clear the webview's busy state or settle the popover's Main task.
   */
  failTurn: (message: string) => void
  post: (msg: Outbound) => void
  getMessages: () => ChatMessage[]
  setMessages: (messages: ChatMessage[]) => void
  /** Live array — runners push/pop in place; ChatView owns reassignment. */
  getRedoStack: () => ChatMessage[][]
  getReviewHunks: () => Record<string, ReviewHunkState>
  clearReviewHunks: () => void
  saveActive: () => void
  sendConversationState: () => void
  queueReviewDecorationsSync: () => void
  resetSessionState: () => void
  applyActiveSnapshot: () => void
  refreshContextUsage: (backend: Backend) => Promise<void>
}

/**
 * Implementations of the opencode built-in slash commands that run against
 * a backend session endpoint. `/compact` and `/init` run a server-side turn
 * (rendered via the existing SSE subscription); `/share` and `/unshare` are
 * one-shot actions surfaced through a VS Code notification; `/undo`, `/redo`
 * and `/fork` mutate local conversation state around a server revert/fork.
 *
 * ChatView handles `/mcp`, `/provider` and `/new` itself (they are not
 * session turns and must not ensure a backend), then delegates here.
 */
export class BuiltinRunners {
  constructor(private deps: BuiltinRunnerDeps) {}

  async run(command: string, backend: Backend): Promise<void> {
    switch (command) {
      case "compact":
        return this.runCompact(backend)
      case "init":
        return this.runInit(backend)
      case "share":
        return this.runShare(backend)
      case "unshare":
        return this.runUnshare(backend)
      case "undo":
        return this.runUndo(backend)
      case "redo":
        return this.runRedo(backend)
      case "fork":
        return this.runFork(backend)
    }
  }

  private async runCompact(backend: Backend) {
    const sessionID = this.deps.getSessionID()
    if (!sessionID) {
      void vscode.window.showInformationMessage("Nothing to compact yet.")
      return
    }
    if (!this.deps.hasSubscription()) await this.deps.attachSubscription(backend, sessionID)
    await this.deps.beginBuiltinTurn("/compact")
    const sel = this.deps.prefs.get()
    const body = sel.modelProviderID && sel.modelID ? { providerID: sel.modelProviderID, modelID: sel.modelID } : undefined
    try {
      const res = await backend.client.session.summarize({
        path: { id: sessionID },
        query: { directory: backend.directory },
        body,
      })
      if (res.error) {
        log("compact failed", res.error)
        this.deps.failTurn("opencode could not compact the session; see the output log for details.")
      }
    } catch (e) {
      log("compact threw", e)
      this.deps.failTurn((e as Error).message || "Could not reach the opencode server.")
    }
  }

  private async runInit(backend: Backend) {
    const sel = this.deps.prefs.get()
    if (!sel.modelProviderID || !sel.modelID) {
      void vscode.window.showWarningMessage("Select a model before running /init.")
      return
    }
    let sessionID = this.deps.getSessionID()
    if (!sessionID) {
      // No turn has begun yet (no bubble, no busy state), so a create failure
      // needs direct feedback rather than the failTurn unbrick path.
      const created = await backend.client.session.create({ body: {} }).catch((e: unknown) => {
        log("init: session.create threw", e)
        return undefined
      })
      if (!created || created.error || !created.data) {
        if (created) log("init: session.create failed", created.error)
        void vscode.window.showErrorMessage("Failed to create a session for /init.")
        return
      }
      sessionID = created.data.id
      this.deps.setSessionID(sessionID)
      this.deps.manager.updateActive((conversation) => ({ ...conversation, sessionID }))
      await this.deps.manager.flushPersist()
      await this.deps.attachSubscription(backend, sessionID)
    } else if (!this.deps.hasSubscription()) {
      await this.deps.attachSubscription(backend, sessionID)
    }
    await this.deps.beginBuiltinTurn("/init")
    try {
      const res = await backend.client.session.init({
        path: { id: sessionID },
        query: { directory: backend.directory },
        body: { providerID: sel.modelProviderID, modelID: sel.modelID, messageID: generateMessageID() },
      })
      if (res.error) {
        log("init failed", res.error)
        this.deps.failTurn("opencode could not initialize the project; see the output log for details.")
      }
    } catch (e) {
      log("init threw", e)
      this.deps.failTurn((e as Error).message || "Could not reach the opencode server.")
    }
  }

  private async runShare(backend: Backend) {
    const sessionID = this.deps.getSessionID()
    if (!sessionID) {
      void vscode.window.showInformationMessage("Start a conversation before sharing.")
      return
    }
    try {
      const res = await backend.client.session.share({
        path: { id: sessionID },
        query: { directory: backend.directory },
      })
      if (res.error || !res.data) {
        log("share failed", res.error)
        void vscode.window.showErrorMessage("Failed to share session.")
        return
      }
      const url = res.data.share?.url
      if (!url) {
        void vscode.window.showInformationMessage("Session shared.")
        return
      }
      const pick = await vscode.window.showInformationMessage(`Session shared: ${url}`, "Copy Link")
      if (pick === "Copy Link") await vscode.env.clipboard.writeText(url)
    } catch (e) {
      log("share threw", e)
    }
  }

  private async runUnshare(backend: Backend) {
    const sessionID = this.deps.getSessionID()
    if (!sessionID) return
    try {
      const res = await backend.client.session.unshare({
        path: { id: sessionID },
        query: { directory: backend.directory },
      })
      if (res.error) {
        log("unshare failed", res.error)
        void vscode.window.showErrorMessage("Failed to disable sharing.")
        return
      }
      void vscode.window.showInformationMessage("Session sharing disabled.")
    } catch (e) {
      log("unshare threw", e)
    }
  }

  /**
   * `/undo` — revert the last settled turn. Mirrors handleEdit's
   * revert + truncate + sendConversationState, minus the resend: the removed
   * tail is stashed for `/redo` and the undone prompt is restored to the composer.
   */
  private async runUndo(backend: Backend) {
    const sessionID = this.deps.getSessionID()
    if (!sessionID) {
      void vscode.window.showInformationMessage("Nothing to undo yet.")
      return
    }
    const messages = this.deps.getMessages()
    const idx = lastUserTurnIndex(messages)
    if (idx < 0) {
      void vscode.window.showInformationMessage("Nothing to undo.")
      return
    }
    const target = messages[idx]!
    try {
      const res = await backend.client.session.revert({
        path: { id: sessionID },
        query: { directory: backend.directory },
        body: { messageID: target.backendID! },
      })
      if (res.error) {
        log("undo: session.revert failed", res.error)
        void vscode.window.showErrorMessage("Failed to undo the last turn.")
        return
      }
    } catch (e) {
      log("undo: session.revert threw", e)
      return
    }
    this.deps.getRedoStack().push(messages.slice(idx))
    this.deps.setMessages(messages.slice(0, idx))
    this.deps.clearReviewHunks()
    this.deps.saveActive()
    this.deps.sendConversationState()
    this.deps.queueReviewDecorationsSync()
    // Restore the undone prompt so the user can edit and resend. Plain text only:
    // mentions/attachments are not re-hydrated.
    this.deps.post({ type: "setComposerText", text: userMessageText(target) })
  }

  /** `/redo` — re-apply the most recently undone turn from the in-memory buffer. */
  private async runRedo(backend: Backend) {
    const sessionID = this.deps.getSessionID()
    if (!sessionID) return
    const redoStack = this.deps.getRedoStack()
    const tail = redoStack.pop()
    if (!tail || tail.length === 0) {
      void vscode.window.showInformationMessage("Nothing to redo.")
      return
    }
    // Move the server revert pointer forward to the next still-reverted tail, or
    // clear it entirely when this restores the latest turn.
    const action = redoAction(redoStack[redoStack.length - 1])
    try {
      const res =
        action.kind === "revert"
          ? await backend.client.session.revert({
              path: { id: sessionID },
              query: { directory: backend.directory },
              body: { messageID: action.messageID },
            })
          : await backend.client.session.unrevert({
              path: { id: sessionID },
              query: { directory: backend.directory },
            })
      if (res.error) {
        log("redo failed", res.error)
        void vscode.window.showErrorMessage("Failed to redo.")
        redoStack.push(tail)
        return
      }
    } catch (e) {
      log("redo threw", e)
      redoStack.push(tail)
      return
    }
    this.deps.setMessages([...this.deps.getMessages(), ...tail])
    this.deps.saveActive()
    this.deps.sendConversationState()
    this.deps.queueReviewDecorationsSync()
    this.deps.post({ type: "setComposerText", text: "" })
  }

  /**
   * `/fork` — duplicate the current session into a new conversation. The fork
   * copies the current session, so its history equals our in-memory messages; we
   * adopt the forked session id onto a fresh conversation and copy the messages
   * over (re-stamping their backendIDs from the forked session so revert/edit
   * keep working). No server->ChatMessage converter exists, hence the copy.
   */
  private async runFork(backend: Backend) {
    const sessionID = this.deps.getSessionID()
    if (!sessionID) {
      void vscode.window.showInformationMessage("Nothing to fork yet.")
      return
    }
    try {
      const res = await backend.client.session.fork({
        path: { id: sessionID },
        query: { directory: backend.directory },
        body: {},
      })
      if (res.error || !res.data) {
        log("fork failed", res.error)
        void vscode.window.showErrorMessage("Failed to fork the conversation.")
        return
      }
      const forked = res.data
      const copied = this.deps.getMessages().map((m) => ({ ...m, pending: false }))
      await restampForkedIDs(backend, forked.id, copied)
      const copiedHunks = { ...this.deps.getReviewHunks() }

      this.deps.resetSessionState()
      const conversation = this.deps.manager.add(forked.title || "Forked chat")
      this.deps.manager.setActiveID(conversation.id)
      this.deps.manager.updateActive((c) => ({ ...c, sessionID: forked.id, messages: copied, reviewHunks: copiedHunks }))
      this.deps.applyActiveSnapshot()
      await this.deps.manager.flushPersist()
      this.deps.sendConversationState()
      this.deps.post({ type: "contextUsage", usage: undefined })
      await this.deps.attachSubscription(backend, forked.id)
      void this.deps.refreshContextUsage(backend)
    } catch (e) {
      log("fork threw", e)
      void vscode.window.showErrorMessage("Failed to fork the conversation.")
    }
  }
}

/**
 * Align copied messages' backendIDs with the forked session's real message ids
 * by position. Fork duplicates the whole session, so order + count match (every
 * settled bubble has a server message, and `/fork` only runs when idle); if the
 * counts diverge we keep the copied ids and log — edit/undo on a pre-fork message
 * may then need a fresh turn first.
 */
async function restampForkedIDs(backend: Backend, sessionID: string, messages: ChatMessage[]) {
  try {
    const res = await backend.client.session.messages({
      path: { id: sessionID },
      query: { directory: backend.directory },
    })
    const server = (res.data ?? []) as Array<{ info?: { id?: string } }>
    if (res.error || server.length !== messages.length) {
      log("fork: skipping backendID re-stamp", { error: res.error, server: server.length, local: messages.length })
      return
    }
    messages.forEach((m, i) => {
      const id = server[i]?.info?.id
      if (id) m.backendID = id
    })
  } catch (e) {
    log("fork: restamp threw", e)
  }
}
