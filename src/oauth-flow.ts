import * as vscode from "vscode"
import type { ApiResult, OauthAuthorization } from "./backend/api"

export type OAuthOutcome<T> =
  | { kind: "ok"; data: T }
  | { kind: "cancelled" }
  /** The user closed the code prompt without answering. */
  | { kind: "dismissed" }
  | { kind: "failed"; stage: "authorize" | "callback"; message?: string }

export type OAuthSteps<T> = {
  /** How the notifications name what is being connected. */
  name: string
  authorize(): Promise<ApiResult<OauthAuthorization>>
  callback(body: { code?: string }, signal?: AbortSignal): Promise<ApiResult<T>>
}

/**
 * The browser half of an OAuth sign-in, shared by the provider and MCP
 * pickers. `authorize` says where to send the user; `callback` either waits
 * for the server to see the sign-in finish (an "auto" flow, cancellable from
 * the notification) or completes it with the code the user pastes back.
 * Callers turn the outcome into their own notifications.
 */
export async function runOAuth<T>(steps: OAuthSteps<T>): Promise<OAuthOutcome<T>> {
  const authRes = await steps.authorize()
  if (authRes.error || !authRes.data) return { kind: "failed", stage: "authorize", message: errorText(authRes.error) }
  const authz = authRes.data
  if (authz.url) await vscode.env.openExternal(vscode.Uri.parse(authz.url))

  if (authz.method === "auto") {
    // Server-orchestrated flow. For device-code providers (e.g. GitHub
    // Copilot) `instructions` carries a user code ("Enter code: XXXX-XXXX")
    // the user must type at `url`; the callback then polls server-side until
    // they finish. Surface that code (and copy it) or the user can't
    // complete the flow — then block on the callback, cancellably, so
    // abandoning it doesn't leave the notification stuck forever.
    const code = deviceCode(authz.instructions)
    if (code) {
      await vscode.env.clipboard.writeText(code)
      void vscode.window.showInformationMessage(
        `OpenCode Panel: enter code ${code} in your browser to authorize "${steps.name}" (copied to clipboard).`,
      )
    }
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: true,
        title: code
          ? `Authorizing "${steps.name}" — enter code ${code} in your browser, or cancel...`
          : `Authorizing "${steps.name}" — finish in your browser, or cancel...`,
      },
      async (_progress, token): Promise<OAuthOutcome<T>> => {
        const controller = new AbortController()
        const onCancel = new Promise<OAuthOutcome<T>>((resolve) =>
          token.onCancellationRequested(() => {
            controller.abort()
            resolve({ kind: "cancelled" })
          }),
        )
        const onCallback = steps
          .callback({}, controller.signal)
          .then((res): OAuthOutcome<T> => outcomeOf(res))
          .catch((e): OAuthOutcome<T> => (controller.signal.aborted ? { kind: "cancelled" } : { kind: "failed", stage: "callback", message: (e as Error).message }))
        return Promise.race([onCallback, onCancel])
      },
    )
  }

  // method === "code": the user authorizes in the browser and pastes a code back.
  const code = await vscode.window.showInputBox({
    title: `Connect ${steps.name}`,
    prompt: authz.instructions || "Paste the authorization code from your browser",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "An authorization code is required"),
  })
  if (!code) return { kind: "dismissed" }
  return outcomeOf(await steps.callback({ code: code.trim() }))
}

function outcomeOf<T>(res: ApiResult<T>): OAuthOutcome<T> {
  return res.error || res.data === undefined ? { kind: "failed", stage: "callback", message: errorText(res.error) } : { kind: "ok", data: res.data }
}

/**
 * Extract the device/user code from an OAuth "auto" provider's `instructions`.
 * opencode formats it as "Enter code: XXXX-XXXX" — take the part after the
 * first colon. Returns "" when there is nothing actionable to show.
 */
function deviceCode(instructions: string | undefined): string {
  const text = instructions?.trim()
  if (!text) return ""
  const colon = text.indexOf(":")
  return colon >= 0 ? text.slice(colon + 1).trim() : text
}

/** Best-effort message from an SDK error union (BadRequestError, string, ...). */
export function errorText(err: unknown): string | undefined {
  if (!err) return undefined
  if (typeof err === "string") return err
  if (typeof err === "object") {
    const data = (err as { data?: { message?: string } }).data
    if (data?.message) return data.message
    const message = (err as { message?: string }).message
    if (message) return message
  }
  return undefined
}

/** ": <msg>" when a reason is present, else "" — for appending to a notification. */
export function suffix(message: string | undefined): string {
  return message ? `: ${message}` : ""
}
