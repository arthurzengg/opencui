import type { PromptContextManifestItemSource } from "../protocol"

/**
 * Best-effort classification of an opencode tool name into a source family
 * used by the context manifest. We can't introspect every plugin's tool list
 * — opencode's plugin API doesn't expose typed metadata yet — so this works
 * off a curated list of well-known patterns and falls back to `opencode` for
 * anything we don't recognize.
 *
 * Phase 5 of the workspace-context plan
 * (docs/workspace-context-and-indexing.md). The classifier is intentionally
 * conservative: surfacing the wrong family on the manifest is worse than
 * surfacing "OpenCode" as a generic catchall.
 */
export type ToolFamily =
  | "opencode"
  | "shell"
  | "lsp"
  | "omo"
  | "semantic"
  | "external"

/** Known OMO plugins (oh-my-openagent / oh-my-opencode). Pattern-matched on
 *  the leading segment of the tool name so plugin-versioned suffixes work. */
const OMO_TOOLS = new Set([
  "todo",
  "todo_continuation",
  "background_task",
  "task_toast",
  "scout",
  "crafter",
  "lens",
  "hephaestus",
  "explore",
  "librarian",
  "explorer",
])

/** Known semantic-search / vector-store plugin tools. */
const SEMANTIC_TOOLS = new Set([
  "codebase_search",
  "semantic_search",
  "embed_search",
  "vector_search",
])

/** Stock opencode shell/exec tools. */
const SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "exec",
  "run",
  "terminal",
])

/** Stock opencode LSP / language tools. */
const LSP_TOOLS = new Set([
  "lsp_diagnostics",
  "lsp_hover",
  "lsp_definition",
  "lsp_references",
  "lsp_symbol",
  "ast_grep",
])

export function classifyTool(toolName: string): ToolFamily {
  if (!toolName) return "opencode"
  const lower = toolName.toLowerCase()
  // First segment — strip a `:variant` or `_v2` suffix opencode plugins
  // sometimes include.
  const head = lower.split(/[:_-]/, 1)[0]
  if (SEMANTIC_TOOLS.has(lower) || SEMANTIC_TOOLS.has(head)) return "semantic"
  if (SHELL_TOOLS.has(lower) || SHELL_TOOLS.has(head)) return "shell"
  if (LSP_TOOLS.has(lower) || LSP_TOOLS.has(head) || lower.startsWith("lsp_")) return "lsp"
  if (OMO_TOOLS.has(lower) || OMO_TOOLS.has(head)) return "omo"
  return "opencode"
}

/** Map a tool family to the manifest source enum. */
export function toolFamilyToManifestSource(family: ToolFamily): PromptContextManifestItemSource {
  switch (family) {
    case "omo":
      return "omo"
    case "semantic":
      return "semantic"
    case "external":
      return "external"
    // shell / lsp / opencode all roll up to the `opencode` bucket in the
    // manifest — they're already grouped under the OpenCode-managed tools
    // section from the user's perspective.
    default:
      return "opencode"
  }
}

/**
 * Discover the tool families the host expects to be available given the
 * active config mode. In `isolated` mode opencode only sees its built-ins
 * (shell + LSP + the opencode catchall). In `user` mode any installed
 * plugin's tools are *potentially* available — we can't enumerate them
 * pre-flight, so we surface a generic "plugins active" hint and let
 * downstream tool-classification fill in the specifics as calls happen.
 */
export function expectedToolFamilies(
  configMode: "isolated" | "user",
): ToolFamily[] {
  if (configMode === "isolated") return ["opencode", "shell", "lsp"]
  return ["opencode", "shell", "lsp", "omo", "semantic"]
}
