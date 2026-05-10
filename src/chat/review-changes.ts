import * as path from "path"
import type { ChatMessage, ReviewChange, ToolUpdate as WireToolUpdate } from "../protocol"
import { isRecord, samePath } from "./paths"
import { countDiff } from "./diff"

export function reviewChanges(messages: ChatMessage[]) {
  const changes = messages.flatMap((message) =>
    message.blocks.flatMap((block, blockIndex) => {
      const source = `${message.id}:${blockIndex}`
      if (block.type === "patch" && block.diff) return diffChanges(block.diff, source)
      if (block.type !== "tool" || block.update.status !== "completed") return []
      return toolChanges(block.update, block.update.callID || source)
    }),
  )
  return changes.reduce<ReviewChange[]>((acc, change) => {
    const existing = acc.findIndex((item) => (
      samePath(item.path, change.path) && (item.source === change.source || item.patch === change.patch)
    ))
    if (existing < 0) return [...acc, change]
    const copy = acc.slice()
    copy[existing] = change
    return copy
  }, [])
}

export function toolChanges(update: WireToolUpdate, source: string): ReviewChange[] {
  if (update.tool === "apply_patch") return patchChanges(update.metadata?.files, source)
  const filediff = isRecord(update.metadata?.filediff) ? update.metadata.filediff : undefined
  let patch =
    typeof filediff?.patch === "string"
      ? filediff.patch
      : typeof update.metadata?.diff === "string"
        ? update.metadata.diff
        : undefined
  const isCreate =
    (update.tool === "write" && update.metadata?.exists === false) ||
    (update.tool === "edit" && update.input?.oldString === "")
  if (!patch && isCreate) patch = synthesizeCreatePatch(update)
  if (!patch) return []
  return [{
    source,
    path: displayPath(update, filediff),
    kind: isCreate ? "created" : "updated",
    additions: typeof filediff?.additions === "number" ? filediff.additions : countDiff(patch, "+"),
    deletions: typeof filediff?.deletions === "number" ? filediff.deletions : countDiff(patch, "-"),
    patch,
  } satisfies ReviewChange]
}

export function synthesizeCreatePatch(update: WireToolUpdate): string | undefined {
  const content =
    update.tool === "write" && typeof update.input?.content === "string"
      ? update.input.content
      : update.tool === "edit" && typeof update.input?.newString === "string"
        ? update.input.newString
        : undefined
  if (typeof content !== "string" || content === "") return undefined
  const lines = content.split("\n")
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop()
  if (!lines.length) return undefined
  const body = lines.map((line) => `+${line}`).join("\n")
  return `@@ -0,0 +1,${lines.length} @@\n${body}`
}

export function patchChanges(files: unknown, source: string): ReviewChange[] {
  if (!Array.isArray(files)) return []
  return files.flatMap((file) => {
    if (!isRecord(file) || typeof file.relativePath !== "string" || typeof file.patch !== "string") return []
    return [{
      source: `${source}:${file.relativePath}`,
      path: file.relativePath,
      kind: patchKind(file.type),
      additions: typeof file.additions === "number" ? file.additions : countDiff(file.patch, "+"),
      deletions: typeof file.deletions === "number" ? file.deletions : countDiff(file.patch, "-"),
      patch: file.patch,
    } satisfies ReviewChange]
  })
}

export function diffChanges(diff: string, source: string): ReviewChange[] {
  const starts = diff.split("\n").reduce<number[]>((acc, line, index) => (
    line.startsWith("diff --git ") ? [...acc, index] : acc
  ), [])
  if (!starts.length) return createPatchChange(diff, source)
  const lines = diff.split("\n")
  return starts.map((start, index) => {
    const chunk = lines.slice(start, starts[index + 1] ?? lines.length).join("\n")
    const header = lines[start] ?? ""
    const match = header.match(/^diff --git a\/(.+) b\/(.+)$/)
    const pathValue = match?.[2] ?? match?.[1] ?? patchPath(chunk)
    return {
      source: `${source}:${index}`,
      path: pathValue,
      kind: chunk.includes("\nnew file mode ")
        ? "created"
        : chunk.includes("\ndeleted file mode ")
          ? "deleted"
          : "updated",
      additions: countDiff(chunk, "+"),
      deletions: countDiff(chunk, "-"),
      patch: chunk,
    } satisfies ReviewChange
  })
}

export function createPatchChange(patch: string, source: string): ReviewChange[] {
  return [{
    source,
    path: patchPath(patch),
    kind: patch.includes("\n--- /dev/null")
      ? "created"
      : patch.includes("\n+++ /dev/null")
        ? "deleted"
        : "updated",
    additions: countDiff(patch, "+"),
    deletions: countDiff(patch, "-"),
    patch,
  } satisfies ReviewChange]
}

export function patchPath(patch: string) {
  const plus = patch.match(/(?:^|\n)\+\+\+\s+(?:b\/)?(.+)/)?.[1]
  if (plus && plus !== "/dev/null") return plus
  const minus = patch.match(/(?:^|\n)---\s+(?:a\/)?(.+)/)?.[1]
  if (minus && minus !== "/dev/null") return minus
  const index = patch.match(/^Index:\s+(.+)$/m)?.[1]
  return index ?? "file"
}

export function displayPath(
  update: { title?: string; input?: Record<string, unknown>; metadata?: Record<string, unknown> },
  filediff?: Record<string, unknown>,
) {
  // The absolute filepath opencode resolved is unambiguous; prefer it. The
  // model's raw input.filePath can be relative to opencode's internal
  // directory (e.g., the git worktree root) which differs from our VSCode
  // workspace folder, and persisted conversations may already have the wrong
  // relative there.
  const fromMetadata = typeof update.metadata?.filepath === "string" ? update.metadata.filepath : undefined
  if (fromMetadata && path.isAbsolute(fromMetadata)) return fromMetadata
  const fromFilediff = typeof filediff?.file === "string" ? filediff.file : undefined
  if (fromFilediff && path.isAbsolute(fromFilediff)) return fromFilediff
  if (typeof update.input?.filePath === "string" && update.input.filePath) return update.input.filePath
  if (typeof update.title === "string" && update.title.trim()) return update.title
  return fromFilediff ?? "file"
}

export function patchKind(value: unknown): ReviewChange["kind"] {
  if (value === "add") return "created"
  if (value === "delete") return "deleted"
  if (value === "move") return "moved"
  return "updated"
}
