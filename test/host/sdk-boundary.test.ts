import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const SRC = path.resolve(__dirname, "../../src")

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : []
  })
}

// opencode 2.0 renames every route and event. Keeping the SDK inside
// src/backend is what makes supporting it one more module instead of a
// change to every caller (#689).
describe("the opencode clients stay behind src/backend", () => {
  it("neither the 1.x SDK nor the 2.0 client is imported by another host module, not even for types", () => {
    const offenders = walk(SRC)
      .filter((file) => !file.startsWith(path.join(SRC, "backend") + path.sep))
      .filter((file) => /from\s+["']@opencode(-ai)?\//.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(SRC, file))
    expect(offenders).toEqual([])
  })
})
