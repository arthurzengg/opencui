// The page that hosts the built webview for recording. It stands in for the
// extension host: it answers the webview's messages with scripted data so no
// opencode server runs and no model is called. Served by generate.mjs.
import { readFileSync } from "node:fs"

// Dark 2026 values, the default dark theme since VS Code 1.143, for every
// --vscode-* token the webview reads: the theme file's own colours with its
// include chain resolved, and the registry default where the theme sets none.
// `contrastBorder` is absent on purpose; only a high-contrast theme defines it.
export const THEME = `
:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: Menlo, Monaco, "Courier New", monospace;
  --vscode-editor-font-size: 12px;
  --vscode-button-background: #297aa0;
  --vscode-button-border: #297aa0;
  --vscode-button-foreground: #ffffff;
  --vscode-button-hoverBackground: #2b7da3;
  --vscode-button-secondaryBackground: #00000000;
  --vscode-button-secondaryBorder: #333536;
  --vscode-button-secondaryForeground: #cccccc;
  --vscode-button-secondaryHoverBackground: #ffffff10;
  --vscode-charts-blue: #57a3f8;
  --vscode-charts-green: #86cf86;
  --vscode-charts-red: #ef8773;
  --vscode-charts-yellow: #e0b97f;
  --vscode-debugIcon-stopForeground: #f48771;
  --vscode-descriptionForeground: #8c8c8c;
  --vscode-dropdown-background: #191a1b;
  --vscode-dropdown-border: #333536;
  --vscode-editor-background: #121314;
  --vscode-editor-inactiveSelectionBackground: #27678260;
  --vscode-editor-selectionBackground: #276782dd;
  --vscode-editorError-foreground: #f14c4c;
  --vscode-editorWarning-foreground: #cca700;
  --vscode-editorWidget-background: #202122;
  --vscode-editorWidget-border: #2a2b2c;
  --vscode-editorWidget-foreground: #bfbfbf;
  --vscode-errorForeground: #f48771;
  --vscode-focusBorder: #3994bcb3;
  --vscode-foreground: #bfbfbf;
  --vscode-gitDecoration-addedResourceForeground: #73c991;
  --vscode-gitDecoration-deletedResourceForeground: #f48771;
  --vscode-gitDecoration-modifiedResourceForeground: #e5ba7d;
  --vscode-input-background: #191a1b;
  --vscode-input-border: #333536;
  --vscode-input-foreground: #bfbfbf;
  --vscode-input-placeholderForeground: #555555;
  --vscode-inputValidation-errorBackground: #3a1d1d;
  --vscode-list-activeSelectionBackground: #ffffff22;
  --vscode-list-activeSelectionForeground: #ededed;
  --vscode-list-hoverBackground: #ffffff14;
  --vscode-list-inactiveSelectionBackground: #2c2d2e;
  --vscode-list-inactiveSelectionForeground: #ededed;
  --vscode-notificationsWarningIcon-foreground: #cca700;
  --vscode-panel-border: #2a2b2c;
  --vscode-quickInput-background: #202122;
  --vscode-scrollbarSlider-activeBackground: #a8a9aa9c;
  --vscode-scrollbarSlider-background: #a8a9aa85;
  --vscode-scrollbarSlider-hoverBackground: #a8a9aa90;
  --vscode-sideBar-background: #191a1b;
  --vscode-sideBarSectionHeader-background: #191a1b;
  --vscode-testing-iconPassed: #73c991;
  --vscode-textCodeBlock-background: #242526;
  --vscode-textLink-activeForeground: #53a5ca;
  --vscode-textLink-foreground: #48a0c7;
  --vscode-toolbar-hoverBackground: #5a5d5e50;
  --vscode-widget-border: #2a2b2c;
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
