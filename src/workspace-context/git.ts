import { execFile } from "child_process"
import { promisify } from "util"
import type { WorkspaceRoot } from "../workspace-root"
import type { CollectorOutput } from "./types"
import { log } from "../output"

const execFileAsync = promisify(execFile)

const MAX_DIFF_BYTES = 60_000
const TIMEOUT_MS = 5_000

/**
 * Collect a compact git diff against the workspace root: `git status --short`
 * + `git diff --unified=3` for unstaged + `git diff --cached --unified=3` for
 * staged. Each diff is truncated to `MAX_DIFF_BYTES` so a sweeping refactor
 * doesn't drown the prompt. Returns empty output when the workspace isn't a
 * git repo (the usual `fatal: not a git repository` exit code).
 */
export async function collectGitDiff(workspace: WorkspaceRoot): Promise<CollectorOutput> {
  const cwd = workspace.fsPath
  const [status, unstaged, staged] = await Promise.all([
    runGit(cwd, ["status", "--short"]),
    runGit(cwd, ["diff", "--unified=3", "--no-color"]),
    runGit(cwd, ["diff", "--cached", "--unified=3", "--no-color"]),
  ])
  const parts: string[] = []
  if (status) parts.push(`### Status\n${status}`)
  if (unstaged) parts.push(`### Unstaged diff\n${truncate(unstaged)}`)
  if (staged) parts.push(`### Staged diff\n${truncate(staged)}`)
  if (parts.length === 0) return { items: [], blocks: [] }
  const content = parts.join("\n\n")
  const bytes = Buffer.byteLength(content, "utf8")
  const truncated = unstaged.length > MAX_DIFF_BYTES || staged.length > MAX_DIFF_BYTES
  const id = `git_${Date.now()}`
  return {
    items: [
      {
        id,
        source: "git",
        kind: "diff",
        label: "Git changes",
        reason: "Local git diff against the workspace root",
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
  if (s.length <= MAX_DIFF_BYTES) return s
  return s.slice(0, MAX_DIFF_BYTES) + `\n… (truncated to ${MAX_DIFF_BYTES} bytes)`
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
