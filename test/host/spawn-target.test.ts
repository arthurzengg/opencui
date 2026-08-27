import { describe, expect, it } from "vitest"
import { resolveSpawnTarget } from "../../src/server"

const NPM_DIR = "C:\\Users\\X\\AppData\\Roaming\\npm"
const SYS_DIR = "C:\\Windows\\System32"
const PATH = `${NPM_DIR};${SYS_DIR}`

function existsIn(files: string[]) {
  return (candidate: string) => files.includes(candidate)
}

describe("resolveSpawnTarget", () => {
  it("passes through untouched off Windows", () => {
    expect(resolveSpawnTarget("opencode", "darwin", {}, () => true)).toEqual({
      command: "opencode",
      shell: false,
    })
  })

  it("routes an explicit .cmd path through the shell, quoted against spaces", () => {
    expect(resolveSpawnTarget("C:\\name with spaces\\opencode.CMD", "win32", {}, () => false)).toEqual({
      command: '"C:\\name with spaces\\opencode.CMD"',
      shell: true,
    })
  })

  it("spawns an explicit .exe path directly", () => {
    expect(resolveSpawnTarget("C:\\tools\\opencode.exe", "win32", {}, () => false)).toEqual({
      command: "C:\\tools\\opencode.exe",
      shell: false,
    })
  })

  it("resolves a bare name to an .exe on PATH and spawns it directly", () => {
    const target = resolveSpawnTarget(
      "opencode",
      "win32",
      { PATH },
      existsIn([`${SYS_DIR}\\opencode.exe`]),
    )
    expect(target).toEqual({ command: `${SYS_DIR}\\opencode.exe`, shell: false })
  })

  it("falls back to the npm .cmd shim through cmd.exe when no .exe exists", () => {
    // The #548 layout: npm installs only an extensionless sh script (never
    // probed — Windows cannot execute it) and the .cmd shim.
    const target = resolveSpawnTarget(
      "opencode",
      "win32",
      { PATH },
      existsIn([`${NPM_DIR}\\opencode.cmd`]),
    )
    expect(target).toEqual({ command: `"${NPM_DIR}\\opencode.cmd"`, shell: true })
  })

  it("within one directory a real .exe beats the shim", () => {
    const target = resolveSpawnTarget(
      "opencode",
      "win32",
      { PATH: NPM_DIR },
      existsIn([`${NPM_DIR}\\opencode.cmd`, `${NPM_DIR}\\opencode.exe`]),
    )
    expect(target).toEqual({ command: `${NPM_DIR}\\opencode.exe`, shell: false })
  })

  it("the first PATH entry with a match wins, matching what the shell would run", () => {
    const target = resolveSpawnTarget(
      "opencode",
      "win32",
      { PATH },
      existsIn([`${NPM_DIR}\\opencode.cmd`, `${SYS_DIR}\\opencode.exe`]),
    )
    expect(target).toEqual({ command: `"${NPM_DIR}\\opencode.cmd"`, shell: true })
  })

  it("leaves a bare name alone when PATH has no match, keeping spawn's ENOENT", () => {
    expect(resolveSpawnTarget("opencode", "win32", { PATH }, () => false)).toEqual({
      command: "opencode",
      shell: false,
    })
  })
})
