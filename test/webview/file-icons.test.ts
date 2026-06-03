import { describe, it, expect } from "vitest"
import { fileTypeCodicon } from "../../webview/src/file-icons"

describe("fileTypeCodicon", () => {
  it("maps source files to a generic code glyph", () => {
    for (const n of ["App.tsx", "main.ts", "esbuild.js", "index.html", "styles.css", "server.go", "lib.rs"]) {
      expect(fileTypeCodicon(n)).toBe("file-code")
    }
  })

  it("maps data, docs, and media to their own glyphs", () => {
    expect(fileTypeCodicon("package.json")).toBe("json")
    expect(fileTypeCodicon("CHANGELOG.md")).toBe("markdown")
    expect(fileTypeCodicon("notes.txt")).toBe("file-text")
    expect(fileTypeCodicon("paper.pdf")).toBe("file-pdf")
    expect(fileTypeCodicon("logo.png")).toBe("file-media")
    expect(fileTypeCodicon("icon.svg")).toBe("file-media")
  })

  it("maps config, archives, db, shell, and notebooks", () => {
    expect(fileTypeCodicon("vite.config.yaml")).toBe("gear")
    expect(fileTypeCodicon("tsconfig.toml")).toBe("gear")
    expect(fileTypeCodicon("bundle.zip")).toBe("file-zip")
    expect(fileTypeCodicon("data.sqlite")).toBe("database")
    expect(fileTypeCodicon("setup.sh")).toBe("terminal")
    expect(fileTypeCodicon("analysis.ipynb")).toBe("notebook")
  })

  it("treats lock files as locks regardless of their extension", () => {
    expect(fileTypeCodicon("bun.lock")).toBe("lock")
    expect(fileTypeCodicon("Cargo.lock")).toBe("lock")
    expect(fileTypeCodicon("package-lock.json")).toBe("lock")
    expect(fileTypeCodicon("pnpm-lock.yaml")).toBe("lock")
  })

  it("recognizes LICENSE by name and dotfile-extensions, and is case-insensitive", () => {
    expect(fileTypeCodicon("LICENSE")).toBe("law")
    expect(fileTypeCodicon("license.md")).toBe("law")
    expect(fileTypeCodicon("LICENCE")).toBe("law")
    expect(fileTypeCodicon(".env")).toBe("gear")
    expect(fileTypeCodicon("PACKAGE.JSON")).toBe("json")
  })

  it("falls back to a plain file glyph for unknown and extensionless names", () => {
    expect(fileTypeCodicon(".gitignore")).toBe("file")
    expect(fileTypeCodicon("Makefile")).toBe("file")
    expect(fileTypeCodicon("data.unknownext")).toBe("file")
  })
})
