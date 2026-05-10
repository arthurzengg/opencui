import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: [
        "src/**/*.ts",
        "webview/src/**/*.{ts,tsx}",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.d.ts",
        "webview/src/main.tsx",
        "webview/src/vscode.ts",
        "webview/vite.config.ts",
        "src/extension.ts",
      ],
      reportsDirectory: "coverage",
    },
    projects: [
      {
        extends: true,
        test: {
          name: "host",
          environment: "node",
          include: ["test/host/**/*.test.ts"],
          setupFiles: ["test/host/setup.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "webview",
          environment: "jsdom",
          include: ["test/webview/**/*.test.{ts,tsx}"],
          setupFiles: ["test/webview/setup.ts"],
        },
      },
    ],
  },
})
