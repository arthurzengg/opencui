import type {
  AppAgentsResponses,
  AuthSetData,
  AuthSetResponses,
  CommandListResponses,
  ConfigProvidersResponses,
  McpAddData,
  McpAddResponses,
  McpAuthAuthenticateResponses,
  McpAuthRemoveResponses,
  McpConnectResponses,
  McpDisconnectResponses,
  McpStatusResponses,
  ProviderAuthResponses,
  ProviderListResponses,
  ProviderOauthAuthorizeData,
  ProviderOauthAuthorizeResponses,
  ProviderOauthCallbackData,
  ProviderOauthCallbackResponses,
  SessionAbortResponses,
  SessionChildrenResponses,
  SessionCommandData,
  SessionCommandResponses,
  SessionCreateResponses,
  SessionDeleteResponses,
  SessionForkData,
  SessionForkResponses,
  SessionInitData,
  SessionInitResponses,
  SessionMessagesResponses,
  SessionPromptAsyncResponses,
  SessionPromptData,
  SessionPromptResponses,
  SessionRevertData,
  SessionRevertResponses,
  SessionShareResponses,
  SessionStatusResponses,
  SessionSummarizeData,
  SessionSummarizeResponses,
  SessionUnrevertResponses,
  SessionUnshareResponses,
  SessionUpdateData,
  SessionUpdateResponses,
} from "@opencode-ai/sdk"
import type {
  GlobalHealthResponses,
  OpencodeClient as OpencodeClientV2,
  PermissionReplyResponses,
  QuestionRejectResponses,
  QuestionReplyResponses,
  SessionListResponses,
} from "@opencode-ai/sdk/v2"
import type { RemoveResult } from "../provider/provider-format"

/**
 * What the host needs from an opencode server. Every module that talks to
 * opencode goes through this interface, so a server with a different API
 * (opencode 2.0 renames every route and event) is one more implementation
 * in this directory rather than a change to every caller.
 *
 * Results keep the `{ data, error }` shape the callers were written
 * against, plus the HTTP status for the few that tell a missing session
 * (404) apart from a failure. The payload types are the SDK's generated
 * ones for now; a second implementation maps into them.
 */
export type ApiResult<T, E = unknown> =
  | { data: T; error?: undefined; status: number }
  | { data?: undefined; error: E; status: number }

type DataOf<R> = R[keyof R]
type BodyOf<D> = NonNullable<D extends { body?: infer B } ? B : never>

export type PromptBody = BodyOf<SessionPromptData>
export type SessionCommandBody = BodyOf<SessionCommandData>
// The v2 client takes flat parameters rather than { path, query, body }.
type V2Params<K extends "permission" | "question" | "session", M extends keyof OpencodeClientV2[K]> =
  OpencodeClientV2[K][M] extends (parameters: infer P, ...rest: never[]) => unknown ? NonNullable<P> : never
export type PermissionReply = V2Params<"permission", "reply">["reply"]
export type QuestionAnswers = V2Params<"question", "reply">["answers"]
export type SessionListOptions = Omit<V2Params<"session", "list">, "directory">
/** Where an OAuth sign-in sends the user, and how it ends: watched by the server or by a code pasted back. */
export type OauthAuthorization = DataOf<ProviderOauthAuthorizeResponses>

export interface BackendApi {
  /** Workspace the server was started in; sent with every request. */
  readonly directory: string

  session: {
    create(): Promise<ApiResult<DataOf<SessionCreateResponses>>>
    list(options?: SessionListOptions): Promise<ApiResult<DataOf<SessionListResponses>>>
    messages(id: string, options?: { limit?: number }): Promise<ApiResult<DataOf<SessionMessagesResponses>>>
    update(id: string, body: BodyOf<SessionUpdateData>): Promise<ApiResult<DataOf<SessionUpdateResponses>>>
    delete(id: string): Promise<ApiResult<DataOf<SessionDeleteResponses>>>
    status(): Promise<ApiResult<DataOf<SessionStatusResponses>>>
    children(id: string): Promise<ApiResult<DataOf<SessionChildrenResponses>>>
    prompt(id: string, body: PromptBody): Promise<ApiResult<DataOf<SessionPromptResponses>>>
    promptAsync(id: string, body: PromptBody): Promise<ApiResult<DataOf<SessionPromptAsyncResponses>>>
    command(id: string, body: SessionCommandBody): Promise<ApiResult<DataOf<SessionCommandResponses>>>
    abort(id: string): Promise<ApiResult<DataOf<SessionAbortResponses>>>
    revert(id: string, body: BodyOf<SessionRevertData>): Promise<ApiResult<DataOf<SessionRevertResponses>>>
    unrevert(id: string): Promise<ApiResult<DataOf<SessionUnrevertResponses>>>
    summarize(id: string, body?: BodyOf<SessionSummarizeData>): Promise<ApiResult<DataOf<SessionSummarizeResponses>>>
    share(id: string): Promise<ApiResult<DataOf<SessionShareResponses>>>
    unshare(id: string): Promise<ApiResult<DataOf<SessionUnshareResponses>>>
    init(id: string, body: BodyOf<SessionInitData>): Promise<ApiResult<DataOf<SessionInitResponses>>>
    fork(id: string, body: BodyOf<SessionForkData>): Promise<ApiResult<DataOf<SessionForkResponses>>>
  }

  permission: {
    reply(requestID: string, reply: PermissionReply): Promise<ApiResult<DataOf<PermissionReplyResponses>>>
  }

  question: {
    reply(requestID: string, answers: QuestionAnswers): Promise<ApiResult<DataOf<QuestionReplyResponses>>>
    reject(requestID: string): Promise<ApiResult<DataOf<QuestionRejectResponses>>>
  }

  config: {
    providers(): Promise<ApiResult<DataOf<ConfigProvidersResponses>>>
  }

  app: {
    agents(): Promise<ApiResult<DataOf<AppAgentsResponses>>>
  }

  command: {
    list(): Promise<ApiResult<DataOf<CommandListResponses>>>
  }

  mcp: {
    status(): Promise<ApiResult<DataOf<McpStatusResponses>>>
    add(body: BodyOf<McpAddData>): Promise<ApiResult<DataOf<McpAddResponses>>>
    connect(name: string): Promise<ApiResult<DataOf<McpConnectResponses>>>
    disconnect(name: string): Promise<ApiResult<DataOf<McpDisconnectResponses>>>
    auth: {
      authenticate(name: string): Promise<ApiResult<DataOf<McpAuthAuthenticateResponses>>>
      remove(name: string): Promise<ApiResult<DataOf<McpAuthRemoveResponses>>>
    }
  }

  provider: {
    list(): Promise<ApiResult<DataOf<ProviderListResponses>>>
    auth(): Promise<ApiResult<DataOf<ProviderAuthResponses>>>
    oauth: {
      authorize(providerID: string, body: BodyOf<ProviderOauthAuthorizeData>): Promise<ApiResult<DataOf<ProviderOauthAuthorizeResponses>>>
      callback(
        providerID: string,
        body: BodyOf<ProviderOauthCallbackData>,
        signal?: AbortSignal,
      ): Promise<ApiResult<DataOf<ProviderOauthCallbackResponses>>>
    }
  }

  auth: {
    set(providerID: string, body: BodyOf<AuthSetData>): Promise<ApiResult<DataOf<AuthSetResponses>>>
    /** "unsupported" when the server predates the route. */
    remove(providerID: string): Promise<RemoveResult>
  }

  instance: {
    /** Drops the server's per-directory caches (#571); false when the route is missing. */
    refresh(): Promise<boolean>
  }

  /**
   * The server's event stream, every session included. Resolves once the
   * connection is open; the iterable ends when the server closes it or the
   * signal aborts.
   */
  events(signal?: AbortSignal): Promise<AsyncIterable<unknown>>

  health(): Promise<ApiResult<DataOf<GlobalHealthResponses>>>
}
