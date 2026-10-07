// The page that hosts the built webview for recording. It stands in for the
// extension host: it answers the webview's messages with scripted data so no
// opencode server runs and no model is called. Served by generate.mjs.
import { readFileSync } from "node:fs"

// VS Code Dark Modern values for every --vscode-* token styles.css reads.
export const THEME = `
:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Menlo, Monaco, "Courier New", monospace;
  --vscode-editor-font-size: 12px;
  --vscode-foreground: #cccccc;
  --vscode-descriptionForeground: #9d9d9d;
  --vscode-errorForeground: #f88070;
  --vscode-focusBorder: #0078d4;
  --vscode-sideBar-background: #181818;
  --vscode-sideBarSectionHeader-background: #181818;
  --vscode-editorWidget-background: #202020;
  --vscode-editorWidget-border: #313131;
  --vscode-editorWidget-foreground: #cccccc;
  --vscode-editor-selectionBackground: #264f78;
  --vscode-editor-inactiveSelectionBackground: #3a3d41;
  --vscode-editor-wordHighlightStrongBackground: #004972b8;
  --vscode-editor-wordHighlightStrongBorder: transparent;
  --vscode-editorError-foreground: #f14c4c;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-input-background: #313131;
  --vscode-input-foreground: #cccccc;
  --vscode-input-border: #3c3c3c;
  --vscode-input-placeholderForeground: #989898;
  --vscode-inputValidation-errorBackground: #5a1d1d;
  --vscode-dropdown-background: #313131;
  --vscode-dropdown-border: #3c3c3c;
  --vscode-widget-border: #313131;
  --vscode-panel-border: #2b2b2b;
  --vscode-quickInput-background: #222222;
  --vscode-button-background: #0078d4;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #026ec1;
  --vscode-button-secondaryBackground: #313131;
  --vscode-button-secondaryForeground: #cccccc;
  --vscode-button-secondaryHoverBackground: #3c3c3c;
  --vscode-list-hoverBackground: #2a2d2e;
  --vscode-list-activeSelectionBackground: #04395e;
  --vscode-list-activeSelectionForeground: #ffffff;
  --vscode-list-inactiveSelectionBackground: #37373d;
  --vscode-list-inactiveSelectionForeground: #cccccc;
  --vscode-textLink-foreground: #4daafc;
  --vscode-textLink-activeForeground: #4daafc;
  --vscode-textCodeBlock-background: #2b2b2b;
  --vscode-toolbar-hoverBackground: #5a5d5e50;
  --vscode-progressBar-background: #0078d4;
  --vscode-scrollbarSlider-background: #79797966;
  --vscode-scrollbarSlider-hoverBackground: #646464b3;
  --vscode-scrollbarSlider-activeBackground: #bfbfbf66;
  --vscode-charts-blue: #3794ff;
  --vscode-charts-green: #89d185;
  --vscode-charts-red: #f14c4c;
  --vscode-charts-yellow: #cca700;
  --vscode-gitDecoration-addedResourceForeground: #81b88b;
  --vscode-gitDecoration-modifiedResourceForeground: #e2c08d;
  --vscode-gitDecoration-deletedResourceForeground: #c74e39;
  --vscode-testing-iconPassed: #73c991;
  --vscode-debugIcon-stopForeground: #f48771;
  --vscode-notificationsWarningIcon-foreground: #cca700;
}
html, body { background: var(--vscode-sideBar-background); }
/* A pointer for the recording: headless Chrome paints none. */
#cursor { position: fixed; left: -40px; top: -40px; width: 14px; height: 20px; z-index: 2147483647; pointer-events: none; }
`

const CURSOR = `<svg id="cursor" viewBox="0 0 14 20" xmlns="http://www.w3.org/2000/svg"><path d="M1 1v15l4-3.5 2.5 5.5 2.5-1-2.5-5.5H13z" fill="#fff" stroke="#000" stroke-width="1"/></svg>`

// The fake host. `scenario` is filled in by generate.mjs through
// window.__host before the webview boots; replies go back as window messages,
// the same channel the real host uses.
const HOST = `
<script>
(() => {
  const listeners = []
  const post = (data) => window.dispatchEvent(new MessageEvent("message", { data }))
  window.__host = {
    post,
    onInbound: (fn) => listeners.push(fn),
    inbound: [],
  }
  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      window.__host.inbound.push(msg)
      for (const fn of listeners) fn(msg)
    },
    getState() {},
    setState() {},
  })
})()
</script>`

export function harnessHTML(distIndex, grammarsBase) {
  const built = readFileSync(distIndex, "utf8")
  const head = `<style>${THEME}</style><script>window.__opencuiGrammarsBase=${JSON.stringify(grammarsBase)}</script>${HOST}`
  if (!built.includes("<head>")) throw new Error("built webview has no <head>")
  return built.replace("<head>", `<head>${head}`).replace("<body>", `<body>${CURSOR}`)
}
