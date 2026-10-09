// Payload types the host reads, named here so no module outside src/backend
// imports the SDK (pinned by test/host/sdk-boundary.test.ts). They are the
// 1.x SDK's generated types for now; a second implementation maps into them.
export type { McpLocalConfig, McpRemoteConfig, McpStatus } from "@opencode-ai/sdk"
