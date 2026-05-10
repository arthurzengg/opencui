import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: {
    // Force a single React copy across the host install and the webview's
    // own install. Without this, components from `webview/src/...` resolve
    // React via `webview/node_modules/react` while @testing-library/react
    // resolves it via the root `node_modules/react` — two physically distinct
    // module instances that can't share React's internal hook dispatcher,
    // which produces "Cannot read properties of null (reading 'useState')".
    alias: {
      react: path.resolve(__dirname, "node_modules/react"),
      "react-dom": path.resolve(__dirname, "node_modules/react-dom"),
      "react/jsx-runtime": path.resolve(__dirname, "node_modules/react/jsx-runtime.js"),
      "react/jsx-dev-runtime": path.resolve(__dirname, "node_modules/react/jsx-dev-runtime.js"),
    },
  },
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
