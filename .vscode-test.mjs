import { defineConfig } from "@vscode/test-cli"

export default defineConfig({
  files: "dist/test/integration/**/*.test.js",
  workspaceFolder: "test/integration/fixtures",
  mocha: {
    ui: "tdd",
    timeout: 60_000,
  },
  // Disable other extensions in the test host so they don't interfere with
  // OpenCUI's behavior. Equivalent to --disable-extensions for the dev host.
  launchArgs: ["--disable-extensions"],
})
