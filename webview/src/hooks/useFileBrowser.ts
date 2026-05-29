import { useEffect, useRef, useState } from "react"
import type { DirEntry } from "../protocol"

/** Parent of a workspace-relative folder path. "" (root) has no parent. */
export function parentDir(dir: string): string {
  const i = dir.lastIndexOf("/")
  return i === -1 ? "" : dir.slice(0, i)
}

/**
 * Owns the drill-down state for the @-picker's folder browser: the current
 * folder, its immediate children (fetched via `listDir`), and the active row.
 * Folders are navigation-only — `drillInto` follows a folder, files are left
 * to the caller's `insertMention`. When the browser deactivates (the user
 * typed a query, switched category, or closed the picker) it resets to the
 * workspace root so reopening always starts fresh.
 */
export function useFileBrowser(opts: {
  listDir?: (path: string) => Promise<DirEntry[]>
  active: boolean
}) {
  const { listDir, active } = opts
  const [dir, setDir] = useState("")
  const [entries, setEntries] = useState<DirEntry[]>([])
  const [index, setIndex] = useState(0)
  const dirRef = useRef(dir)
  dirRef.current = dir

  useEffect(() => {
    if (!active) {
      setDir("")
      setEntries([])
      setIndex(0)
    }
  }, [active])

  useEffect(() => {
    if (!active || !listDir) return
    let cancelled = false
    void listDir(dir).then((result) => {
      // Drop stale results — the user may have drilled again while we awaited.
      if (cancelled || dirRef.current !== dir) return
      setEntries(result)
      setIndex(0)
    })
    return () => {
      cancelled = true
    }
  }, [active, dir, listDir])

  return {
    dir,
    entries,
    index,
    setIndex,
    canGoUp: dir !== "",
    drillInto: (entry: DirEntry) => {
      if (entry.kind === "folder") setDir(entry.path)
    },
    goUp: () => setDir((d) => parentDir(d)),
  }
}
