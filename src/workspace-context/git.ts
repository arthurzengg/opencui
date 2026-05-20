import { execFile } from "child_process"
import { promisify } from "util"
import type { WorkspaceRoot } from "../workspace-root"
import type { CollectorOutput } from "./types"
import { log } from "../output"

const execFileAsync = promisify(execFile)

const MAX_GIT_CONTEXT_BYTES = 16_000
const TIMEOUT_MS = 5_000

/**
 * Collect a compact git diff scoped to the VS Code workspace folder.
 *
 * Important: Git commands run from a subdirectory still discover the parent
 * repository. Without a pathspec, `git status` can report sibling projects as
 * `../other-project/...` when the user opened only one folder inside a larger
 * repo. The explicit `-- .` keeps automatic context bounded to the opened
 * workspace.
 */
export async function collectGitDiff(workspace: WorkspaceRoot): Promise<CollectorOutput> {
  const cwd = workspace.fsPath
  const [status, unstaged, staged] = await Promise.all([
    runGit(cwd, ["status", "--short", "--", "."]),
    runGit(cwd, ["diff", "--unified=3", "--no-color", "--", "."]),
    runGit(cwd, ["diff", "--cached", "--unified=3", "--no-color", "--", "."]),
  ])
  const parts: string[] = []
  if (status) parts.push(`### Status\n${status}`)
  if (unstaged) parts.push(`### Unstaged diff\n${unstaged}`)
  if (staged) parts.push(`### Staged diff\n${staged}`)
  if (parts.length === 0) return { items: [], blocks: [] }
  const rawContent = parts.join("\n\n")
  const content = truncate(rawContent)
  const bytes = Buffer.byteLength(content, "utf8")
  const truncated = Buffer.byteLength(rawContent, "utf8") > MAX_GIT_CONTEXT_BYTES
  const id = `git_${Date.now()}`
  return {
    items: [
      {
        id,
        source: "git",
        kind: "diff",
        label: "Git changes",
        reason: "Local git changes scoped to the opened workspace folder",
        status: truncated ? "truncated" : "included",
        bytes,
        priority: 4,
      },
    ],
    blocks: [
      {
        id: "git_block",
        itemID: id,
        title: "Git Changes",
        content,
        bytes,
        priority: 4,
      },
    ],
  }
}

function truncate(s: string): string {
  if (Buffer.byteLength(s, "utf8") <= MAX_GIT_CONTEXT_BYTES) return s
  return Buffer.from(s, "utf8").subarray(0, MAX_GIT_CONTEXT_BYTES).toString("utf8")
    + `\n... (truncated to ${MAX_GIT_CONTEXT_BYTES} bytes)`
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: TIMEOUT_MS,
      // Cap stdout aggressively — `git diff` on a giant change-set is unbounded
      // and we already truncate per-output anyway.
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LANG: "C.UTF-8" },
    })
    return stdout.trim()
  } catch (e) {
    // ENOENT = git not installed, exitCode 128 = not a git repo. Both are
    // expected; surface them only in the output log, don't fail the collector.
    const code = (e as NodeJS.ErrnoException).code
    if (code !== "ENOENT") {
      log("git collector: command failed", args.join(" "), (e as Error).message)
    }
    return ""
  }
}
